// TimbSwap gas request board — Supabase edge function (Deno), testnet only.
//
// Public faucets now want a mainnet balance before they pay out, which blocks
// the newcomers the testnet is for. This board lets a newcomer post their
// address; anyone can send them test ETH on Arbitrum Sepolia and paste the
// transaction hash, which is verified ON CHAIN here before the request is marked
// filled (0.001 ETH, a third of the 0.003 ask, counts as resolved).
//
// Guards (rules in check.ts, tested by check.test.ts):
//   - Turnstile; one open request per address; refused if the wallet already has gas
//   - one post per address per 24 h, counted from its last post or resolution
//   - an address can be helped at most 3 times, ever
//   - 3 posts per network (salted IP hash) per 24 h
//   - the public board holds at most 30 open requests and shows the oldest 5
//   - after 6 hours a request leaves the public board for the team queue, which
//     the fallback keeper (scripts/gas-board-fallback.js) reads with its own
//     secret; unresolved requests expire after 24 hours
// Nothing here awards points: sending test ETH is a thank-you, not a score.
//
// Reached through the same-origin Worker route POST /api/gas-board
// (workers/timbswap-api.js), which adds the caller's IP (X-Real-IP) and the
// optional shared secret (X-Proxy-Secret). The keeper calls it directly with
// the same secret.
//
// Body: { action: "list" }
//       { action: "request", address, cfTurnstileToken }
//       { action: "fill", id, txHash }
//       { action: "queue" }   keeper only: needs X-Keeper-Secret
//
// Secrets (Supabase → Edge Functions):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (auto-injected)
//   GAS_BOARD_RPC_URL     Arbitrum Sepolia RPC; falls back to FAUCET_RPC_URL, then public nodes
//   GAS_BOARD_PROXY_SECRET optional; if set, only calls carrying X-Proxy-Secret are accepted
//   GAS_BOARD_IP_SALT     salts the stored IP hash (the raw IP is never stored)
//   TURNSTILE_SECRET      shared with faucet-claim / waitlist; unset skips the check
//   GAS_BOARD_KEEPER_SECRET required for action "queue" (the fallback keeper sends it
//                         as X-Keeper-Secret); unset disables the queue
//   GAS_TEAM_RESOLVERS    comma-separated team wallet addresses (fills from them are
//                         marked filled_by_team, and the sybil review treats them as neutral)
//
// Deploy: supabase functions deploy gas-board --no-verify-jwt
// Table: supabase/migrations/20261114000000_gas_board.sql

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ADDR_RE, EXPIRE_HOURS, HASH_RE, HAS_GAS_WEI, MAX_PER_IP_DAY, PUBLIC_HOURS, SHOW_MAX,
  checkFill, checkRequest,
} from "./check.ts";

const SB_URL       = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const PROXY_SECRET = (Deno.env.get("GAS_BOARD_PROXY_SECRET") ?? "").trim();
const IP_SALT      = Deno.env.get("GAS_BOARD_IP_SALT") ?? "timbswap-gas-board";
const KEEPER_SECRET = (Deno.env.get("GAS_BOARD_KEEPER_SECRET") ?? "").trim();
const TS_SECRET    = (Deno.env.get("TURNSTILE_SECRET") ?? "").trim();
const TEAM = new Set((Deno.env.get("GAS_TEAM_RESOLVERS") ?? "")
  .split(",").map((a) => a.trim().toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)));

const RPCS = [
  Deno.env.get("GAS_BOARD_RPC_URL") ?? "",
  Deno.env.get("FAUCET_RPC_URL") ?? "",
  "https://sepolia-rollup.arbitrum.io/rpc",
  "https://arbitrum-sepolia-rpc.publicnode.com",
].filter(Boolean);

const ALLOWED_ORIGINS = new Set(["https://timbswap.xyz", "https://www.timbswap.xyz", "https://0xtimberzx.github.io"]);
function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://timbswap.xyz",
    "Access-Control-Allow-Headers": "content-type, x-proxy-secret, x-real-ip, x-ts-client-ip, x-keeper-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json" } });
}

async function rpc(method: string, params: unknown[]): Promise<any> {
  let lastErr = "no RPC configured";
  for (const url of RPCS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const out = await r.json();
      if (out.error) { lastErr = out.error.message ?? "rpc error"; continue; }
      return out.result;
    } catch (e) { lastErr = String(e); }
  }
  throw new Error(lastErr);
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  if (!TS_SECRET) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams({ secret: TS_SECRET, response: token });
    if (ip) form.set("remoteip", ip);
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString(),
    });
    return (await r.json())?.success === true;
  } catch { return false; }
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405, origin);
  if (PROXY_SECRET && (req.headers.get("X-Proxy-Secret") ?? "").trim() !== PROXY_SECRET) return json({ ok: false, error: "forbidden" }, 401, origin);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad request" }, 400, origin); }
  const action = String(body?.action ?? "list");
  const sb = createClient(SB_URL, SB_SERVICE);

  // Expire stale requests lazily, on every call.
  const cutoff = new Date(Date.now() - EXPIRE_HOURS * 3600_000).toISOString();
  await sb.from("gas_requests").update({ status: "expired" }).eq("status", "open").lt("created_at", cutoff);

  const publicSince = new Date(Date.now() - PUBLIC_HOURS * 3600_000).toISOString();

  if (action === "list") {
    // Public board: open and younger than 6 h, oldest first, only the first SHOW_MAX shown.
    const { data: open, count: openCount } = await sb.from("gas_requests")
      .select("id,address,created_at", { count: "exact" }).eq("status", "open").gt("created_at", publicSince)
      .order("created_at", { ascending: true }).limit(SHOW_MAX);
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data: filled } = await sb.from("gas_requests")
      .select("filled_by_team").eq("status", "filled").gte("filled_at", weekAgo);
    const total = filled?.length ?? 0;
    const community = (filled ?? []).filter((r: any) => !r.filled_by_team).length;
    return json({ ok: true, open: open ?? [], openCount: openCount ?? 0, filledThisWeek: total, filledByCommunity: community, amountEth: "0.003" }, 200, origin);
  }

  if (action === "queue") {
    // Team queue for the fallback keeper: open requests past the public window.
    if (!KEEPER_SECRET || (req.headers.get("X-Keeper-Secret") ?? "").trim() !== KEEPER_SECRET) return json({ ok: false, error: "forbidden" }, 401, origin);
    const { data: queue } = await sb.from("gas_requests")
      .select("id,address,created_at").eq("status", "open").lte("created_at", publicSince)
      .order("created_at", { ascending: true }).limit(50);
    const dayAgo = new Date(Date.now() - 86400_000).toISOString();
    const { count: teamFilled24h } = await sb.from("gas_requests").select("id", { count: "exact", head: true })
      .eq("status", "filled").eq("filled_by_team", true).gte("filled_at", dayAgo);
    return json({ ok: true, open: queue ?? [], teamFilled24h: teamFilled24h ?? 0 }, 200, origin);
  }

  if (action === "request") {
    const raw = String(body?.address ?? "").trim();
    if (!ADDR_RE.test(raw)) return json({ ok: false, error: "Enter a valid wallet address (0x… 42 characters)." }, 422, origin);
    const address = raw.toLowerCase();
    const ip = req.headers.get("X-TS-Client-IP") || req.headers.get("X-Real-IP") || "";
    if (!(await verifyTurnstile(String(body?.cfTurnstileToken ?? ""), ip))) {
      return json({ ok: false, error: "Human check failed — please retry the challenge." }, 403, origin);
    }
    const { data: history } = await sb.from("gas_requests").select("id,status,created_at,filled_at").eq("address", address);
    const existing = (history ?? []).find((r: any) => r.status === "open");
    if (existing) return json({ ok: true, status: "already_open", id: existing.id }, 200, origin);
    const { count: openCount } = await sb.from("gas_requests").select("id", { count: "exact", head: true })
      .eq("status", "open").gt("created_at", publicSince);
    const refused = checkRequest(history ?? [], Date.now(), openCount ?? 0);
    if (refused) return json({ ok: false, error: refused }, 429, origin);
    try {
      const bal = BigInt(await rpc("eth_getBalance", [address, "latest"]));
      if (bal >= HAS_GAS_WEI) return json({ ok: false, error: "This wallet already has enough test ETH to play." }, 409, origin);
    } catch { /* RPC down: let the request through; the fill is still verified */ }
    const ipHash = ip ? await sha256Hex(IP_SALT + "|" + ip) : "";
    if (ipHash) {
      const dayAgo = new Date(Date.now() - 86400_000).toISOString();
      const { count } = await sb.from("gas_requests").select("id", { count: "exact", head: true })
        .eq("ip_hash", ipHash).gte("created_at", dayAgo);
      if ((count ?? 0) >= MAX_PER_IP_DAY) return json({ ok: false, error: "Too many requests from your network today — try again tomorrow." }, 429, origin);
    }
    const { data, error } = await sb.from("gas_requests").insert({ address, ip_hash: ipHash }).select("id").single();
    if (error) return json({ ok: false, error: "Couldn't save that just now — please try again." }, 500, origin);
    return json({ ok: true, status: "new", id: data.id }, 200, origin);
  }

  if (action === "fill") {
    const id = Number(body?.id);
    const txHash = String(body?.txHash ?? "").trim().toLowerCase();
    if (!Number.isInteger(id) || id <= 0) return json({ ok: false, error: "Unknown request." }, 422, origin);
    if (!HASH_RE.test(txHash)) return json({ ok: false, error: "Paste the full transaction hash (0x… 66 characters)." }, 422, origin);
    const { data: r } = await sb.from("gas_requests").select("id,address,created_at,status").eq("id", id).maybeSingle();
    if (!r) return json({ ok: false, error: "Unknown request." }, 404, origin);
    const { data: used } = await sb.from("gas_requests").select("id").eq("filled_tx", txHash).maybeSingle();
    if (used) return json({ ok: false, error: "That transaction already filled a request." }, 409, origin);
    let tx: any, receipt: any, block: any, chainId: string;
    try {
      [chainId, tx, receipt] = await Promise.all([
        rpc("eth_chainId", []), rpc("eth_getTransactionByHash", [txHash]), rpc("eth_getTransactionReceipt", [txHash]),
      ]);
      if (!tx) return json({ ok: false, error: "That transaction wasn't found on Arbitrum Sepolia." }, 404, origin);
      block = tx.blockNumber ? await rpc("eth_getBlockByNumber", [tx.blockNumber, false]) : null;
    } catch { return json({ ok: false, error: "Couldn't reach the chain just now — please try again." }, 502, origin); }
    const reason = checkFill(r, tx, receipt ? receipt.status : null, block ? Number(BigInt(block.timestamp)) : null, chainId);
    if (reason) return json({ ok: false, error: reason }, 422, origin);
    const from = String(tx.from).toLowerCase();
    const { error } = await sb.from("gas_requests").update({
      status: "filled", filled_tx: txHash, filled_by: from, filled_by_team: TEAM.has(from), filled_at: new Date().toISOString(),
    }).eq("id", id).eq("status", "open");
    if (error) return json({ ok: false, error: "Couldn't save that just now — please try again." }, 500, origin);
    return json({ ok: true, status: "filled" }, 200, origin);
  }

  return json({ ok: false, error: "unknown action" }, 400, origin);
});
