// TimbSwap gas faucet — claim gatekeeper (Supabase Edge Function, Deno).
//
// Paste-an-address flow: the frontend POSTs { address }. This function does NOT
// send ETH. It (1) validates the address, (2) reads the chain to confirm the
// address holds a LIVE active ticket, (3) atomically reserves the 24h slot in
// Postgres, and (4) enqueues the claim. A single worker (scripts/faucet-worker.js)
// drains the queue and sends — keeping all hot-wallet sends on one nonce stream.
//
// Why the split: concurrent claims from different wallets would collide on the
// hot-wallet nonce if the edge function sent inline. Gatekeep here, send there.
//
// Secrets (Supabase → Project Settings → Edge Functions):
//   RPC_URL                 canonical Arb One RPC (read-only reads)
//   GAME_REGISTRY_ADDR      GameRegistry (mainnet)
//   SUPABASE_URL            (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY  (auto-injected) — bypasses RLS
//
// Deploy: supabase functions deploy faucet-claim --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.4";

const RPC_URL      = Deno.env.get("RPC_URL")!;
const REGISTRY     = Deno.env.get("GAME_REGISTRY_ADDR")!;
const SB_URL       = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Active is enum index 1 (Pending=0, Active=1, Conceded=2, Ineligible=3, …).
const STATUS_ACTIVE = 1n;

const REGISTRY_ABI = [
  "function activeTicketOf(address) view returns (uint256)",
  "function effectiveStatus(uint256) view returns (uint8)",
];

const cors = {
  "Access-Control-Allow-Origin": "*",              // tighten to your domain in prod
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  // ── 1. validate the address ────────────────────────────────────────────────
  let address: string;
  try {
    const body = await req.json();
    address = ethers.getAddress(String(body.address).trim());   // checksums or throws
  } catch {
    return json({ error: "Paste a valid wallet address." }, 400);
  }

  // ── 2. on-chain eligibility: must hold a LIVE active ticket ─────────────────
  //     Read the chain, never a mirror — the ticket is the Sybil gate.
  let ticketId: bigint;
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const registry = new ethers.Contract(REGISTRY, REGISTRY_ABI, provider);
    ticketId = await registry.activeTicketOf(address);
    if (ticketId === 0n) {
      return json({ error: "No active ticket for this address. Enter a round first." }, 403);
    }
    const status: bigint = await registry.effectiveStatus(ticketId);
    if (status !== STATUS_ACTIVE) {
      return json({ error: "Your ticket isn't active — nothing to top up." }, 403);
    }
  } catch (e) {
    return json({ error: "Couldn't reach the chain — try again in a moment." }, 502);
  }

  // ── 3. atomic 24h reserve (Postgres advisory-locked) ───────────────────────
  const sb = createClient(SB_URL, SB_SERVICE);
  const { data: claimId, error: rpcErr } = await sb.rpc("reserve_faucet_claim", {
    p_address:  address.toLowerCase(),
    p_ticket_id: ticketId.toString(),
  });

  if (rpcErr) return json({ error: "Faucet is busy — try again shortly." }, 503);

  if (claimId === null) {
    // On cooldown — compute remaining for a friendly message.
    const { data: last } = await sb
      .from("faucet_claims")
      .select("reserved_at")
      .eq("address", address.toLowerCase())
      .neq("status", "failed")
      .order("reserved_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    let hours = 24;
    if (last?.reserved_at) {
      const next = new Date(last.reserved_at).getTime() + 24 * 3600 * 1000;
      hours = Math.max(0, Math.ceil((next - Date.now()) / 3600_000));
    }
    return json({ error: `Already claimed. Come back in about ${hours}h.` }, 429);
  }

  // ── 4. queued — the worker sends the drip + pot contribution ───────────────
  return json({
    status: "queued",
    claimId,
    message: "You're in. Gas is on the way — usually within a few seconds.",
  }, 202);
});
