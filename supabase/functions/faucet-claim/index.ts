// TimbSwap gas faucet — claim gatekeeper (Supabase Edge Function, Deno).
//
// The frontend POSTs { address } (the connected wallet). This function does NOT
// send ETH. It (1) validates the address, (2) reads the chain to confirm the
// address holds a LIVE active ticket, (3) atomically reserves the 24h slot in
// Postgres, and (4) enqueues the claim. A single worker (scripts/faucet-worker.js)
// drains the queue and sends — keeping all hot-wallet sends on one nonce stream.
//
// Why the split: concurrent claims from different wallets would collide on the
// hot-wallet nonce if the edge function sent inline. Gatekeep here, send there.
//
// Env (Supabase → Project Settings → Edge Functions):
//   RPC_URL                 chain RPC for read-only eligibility reads
//   GAME_REGISTRY_ADDR      GameRegistry address
//   YIELD_VAULT_ADDR        TimbYieldVault (soft reserve-weight check)
//   SUPABASE_URL            (auto-injected)
//   SUPABASE_SERVICE_ROLE_KEY  (auto-injected) — bypasses RLS
//
// RPC_URL, GAME_REGISTRY_ADDR and YIELD_VAULT_ADDR are NOT secret — all ship
// publicly in config.js. They default to the current Arbitrum Sepolia (gen-3)
// values below, so no dashboard step is needed on testnet; set the env vars to
// OVERRIDE for mainnet (keep them in lockstep with config.js — the SOT).
//
// Deploy: supabase functions deploy faucet-claim --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.4";

// Defaults mirror config.js (Arbitrum Sepolia, gen-3). Override via env for mainnet.
const DEFAULT_RPC_URL     = "https://arb-sepolia.g.alchemy.com/v2/PDKCOXR05xcN4AkdaVqNp";
const DEFAULT_REGISTRY    = "0x11C240577Cc522BE3e0f4b1ac61f916e35cfDD65";
const DEFAULT_YIELD_VAULT = "0x43D833e828e2AF951527C2b573Eb70c358FfEB0B";

const RPC_URL      = Deno.env.get("RPC_URL")            || DEFAULT_RPC_URL;
const REGISTRY     = Deno.env.get("GAME_REGISTRY_ADDR") || DEFAULT_REGISTRY;
const YIELD_VAULT  = Deno.env.get("YIELD_VAULT_ADDR")   || DEFAULT_YIELD_VAULT;
const SB_URL       = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Active is enum index 1 (Pending=0, Active=1, Conceded=2, Ineligible=3, …).
const STATUS_ACTIVE = 1n;

const REGISTRY_ABI = [
  "function activeTicketOf(address) view returns (uint256)",
  "function effectiveStatus(uint256) view returns (uint8)",
];
// Soft-check: the yield vault's per-ticket weight — the wallet's stake in the
// reserve that funds yield. weightOf is keyed by ticketId.
const YIELD_ABI = ["function weightOf(uint256) view returns (uint256)"];

// M7: scope CORS to the site origin (set FAUCET_ALLOWED_ORIGIN, e.g.
// https://timbswap.xyz). Defaults to "*" so a fresh deploy still works, but
// production should pin it. NOTE: CORS is browser-enforced only — it does not
// stop a scripted (curl) caller; the daily circuit-breaker in faucet-worker.js
// bounds that abuse, and a signature-gated claim would close it entirely.
const ALLOWED_ORIGIN = Deno.env.get("FAUCET_ALLOWED_ORIGIN") || "*";
const cors = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Vary": "Origin",
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
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  try {
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

  // ── 2b. SOFT check (double measure): does the ticket hold weight in the yield
  //     vault's reserve? Recorded for observability only — NEVER blocks. Any
  //     failure here leaves it null and the claim proceeds on the ticket gate.
  let reserveWeight: string | null = null;
  try {
    const yv = new ethers.Contract(YIELD_VAULT, YIELD_ABI, provider);
    reserveWeight = (await yv.weightOf(ticketId)).toString();
  } catch (_) { /* soft — ignore */ }

  // ── 3. atomic 24h reserve (Postgres advisory-locked) ───────────────────────
  const sb = createClient(SB_URL, SB_SERVICE);
  const { data: claimId, error: rpcErr } = await sb.rpc("reserve_faucet_claim", {
    p_address:  address.toLowerCase(),
    p_ticket_id: ticketId.toString(),
    p_reserve_weight: reserveWeight,
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
