// TimbSwap referrals — Supabase edge function (Deno).
//
// One code per wallet per season, issued while the wallet is on the season
// board. A new player who arrives with ?r=CODE confirms it with a signature
// after their first ticket; the referral counts once they've played 5 rounds and
// is credited while the referrer is on the board with an Active ticket (held
// otherwise, expired at season end). Tallies are horizontal: D 1, C 3, B 9,
// A 36, S 180 qualified wallets. All storage and the bind/qualify rules live in
// SQL (migrations/20261116000000_referrals.sql); the qualify step runs in the
// points scorer (scripts/points-scorer.js → referrals_apply).
//
// Reached through the same-origin Worker route POST /api/referrals
// (workers/timbswap-api.js), which adds the caller's IP as X-TS-Client-IP and
// the optional shared secret (X-Proxy-Secret).
//
// Body: { action: "card",   address }                         season card for a wallet on the board
//       { action: "status", address }                         may this wallet confirm a referral now?
//       { action: "bind",   address, code, issued, signature } confirm (signed message, see rules.ts)
//
// Secrets (Supabase → Edge Functions; project-wide):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (auto-injected)
//   GAME_REGISTRY_ADDR       GameRegistry (shared with faucet-claim): ticket checks
//   FAUCET_RPC_URL           optional keyed RPC (shared); public nodes are the fallback
//   FAUCET_CHAIN_ID          optional; default 421614 (shared)
//   REFERRAL_CODE_SECRET     optional; HMAC key for codes (defaults to the service key;
//                            codes are stored on first issue, so they never change)
//   REFERRAL_IP_SALT         optional; salts the stored network hash
//   REFERRALS_PROXY_SECRET   optional; if set, only calls carrying X-Proxy-Secret are accepted
//
// Deploy: supabase functions deploy referrals --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ethers } from "https://esm.sh/ethers@6.13.4";
import { ADDR_RE, BIND_TEXT, CODE_RE, TIER_MAX, bindMessage, codeFor, issuedOk, nextTier, tierOf } from "./rules.ts";

const SB_URL       = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CODE_SECRET  = (Deno.env.get("REFERRAL_CODE_SECRET") ?? "").trim() || SB_SERVICE;
const IP_SALT      = (Deno.env.get("REFERRAL_IP_SALT") ?? "").trim() || "timbswap-referrals";
// proxy-gate:start — identical in every function (supabase/tests/proxy_gate.test.mjs checks)
// Secrets pasted from a phone can carry spaces, a newline or wrapping quotes
// (straight or curly). Both sides are cleaned the same way before comparing, and
// the Worker cleans before sending. A secret that is set but holds characters a
// header can't carry fails closed: every call is refused until it is re-saved.
function cleanSecretValue(v: string | null | undefined): string {
  return String(v ?? "").trim().replace(/^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g, "").trim();
}
function proxyGate(name: string): (got: string | null) => "ok" | "forbidden" | "misconfigured" {
  const raw = (Deno.env.get(name) ?? "").trim();
  const want = cleanSecretValue(raw);
  if (!raw) return () => "ok";                                         // not set: gate off
  if (!want || !/^[\x21-\x7e]+$/.test(want)) return () => "misconfigured";
  return (got) => (cleanSecretValue(got) === want ? "ok" : "forbidden");
}
// proxy-gate:end
const PROXY_GATE   = proxyGate("REFERRALS_PROXY_SECRET");
const REGISTRY     = (Deno.env.get("GAME_REGISTRY_ADDR") ?? "").trim();
const CHAIN_ID     = Number(Deno.env.get("FAUCET_CHAIN_ID") ?? "421614");
const SITE         = "https://timbswap.xyz";

const RPCS = [
  (Deno.env.get("FAUCET_RPC_URL") ?? "").trim(),
  ...(CHAIN_ID === 42161
    ? ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"]
    : ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com"]),
].filter((u, i, a) => u && a.indexOf(u) === i);

const REGISTRY_ABI = [
  "function activeTicketOf(address wallet) view returns (uint256)",
  "function effectiveStatus(uint256 ticketId) view returns (uint8)",
];
const PENDING = 0n, ACTIVE = 1n;

const ALLOWED_ORIGINS = new Set(["https://timbswap.xyz", "https://www.timbswap.xyz", "https://0xtimberzx.github.io"]);
function cors(origin: string) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : SITE,
    "Access-Control-Allow-Headers": "content-type, x-proxy-secret, x-real-ip, x-ts-client-ip",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The wallet's live ticket status on chain: 0n Pending, 1n Active, …; null when
// the wallet holds no ticket. Throws only when every RPC failed.
async function ticketStatus(address: string): Promise<bigint | null> {
  if (!REGISTRY) throw new Error("GAME_REGISTRY_ADDR not set");
  const net = ethers.Network.from(CHAIN_ID);
  let lastErr: unknown = null;
  for (const url of RPCS) {
    const provider = new ethers.JsonRpcProvider(url, net, { staticNetwork: net });
    try {
      const reg = new ethers.Contract(REGISTRY, REGISTRY_ABI, provider);
      const id: bigint = await reg.activeTicketOf(address);
      if (id === 0n) return null;
      return BigInt(await reg.effectiveStatus(id));
    } catch (e) { lastErr = e; } finally { try { provider.destroy(); } catch (_e) { /* ignore */ } }
  }
  throw lastErr ?? new Error("no RPC");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405, origin);
  const gate = PROXY_GATE(req.headers.get("X-Proxy-Secret"));
  if (gate === "misconfigured") return json({ ok: false, error: "unavailable" }, 503, origin);
  if (gate === "forbidden") return json({ ok: false, error: "forbidden" }, 401, origin);

  let body: any;
  try { body = await req.json(); } catch { return json({ ok: false, error: "bad request" }, 400, origin); }
  const action = String(body?.action ?? "");
  const raw = String(body?.address ?? "").trim();
  if (!ADDR_RE.test(raw)) return json({ ok: false, error: "Enter a valid wallet address." }, 422, origin);
  const address = raw.toLowerCase();

  const sb = createClient(SB_URL, SB_SERVICE);
  const { data: seasons } = await sb.from("seasons").select("id,slug,name")
    .eq("status", "active").order("id", { ascending: false }).limit(1);
  const season = seasons?.[0];
  if (!season) return json({ ok: true, season: null }, 200, origin);
  const seasonOut = { slug: season.slug, name: season.name };

  if (action === "card") {
    const { data: me } = await sb.from("points_wallets")
      .select("display_tp,rounds_played,best_streak,sybil_flag")
      .eq("season_id", season.id).eq("address", address).maybeSingle();
    if (!me || me.sybil_flag !== null || !(Number(me.display_tp) > 0)) {
      return json({ ok: true, season: seasonOut, eligible: false }, 200, origin);
    }
    const ip = req.headers.get("X-TS-Client-IP") || req.headers.get("X-Real-IP") || "";
    const ipHash = ip ? await sha256Hex(IP_SALT + "|" + ip) : "";
    let code = "";
    for (const len of [7, 8]) {
      const { data, error } = await sb.rpc("referral_issue_code", {
        p_season: season.id, p_address: address, p_code: await codeFor(CODE_SECRET, season.id, address, len), p_ip_hash: ipHash,
      });
      if (!error) { code = String(data); break; }
      if (error.code !== "23505") break;   // anything but a code collision: give up
    }
    if (!code) return json({ ok: false, error: "Couldn't load your card just now — please try again." }, 500, origin);

    const [{ data: rank }, { data: rows }] = await Promise.all([
      sb.rpc("points_wallet_rank", { p_season: season.id, p_address: address }),
      sb.from("referrals").select("status").eq("season_id", season.id).eq("referrer", address),
    ]);
    const count = (s: string) => (rows ?? []).filter((r: any) => r.status === s).length;
    const qualified = Math.min(count("qualified"), TIER_MAX);
    let paused: boolean | null = null;
    try { paused = (await ticketStatus(address)) !== ACTIVE; } catch { paused = null; }
    return json({
      ok: true, season: seasonOut, eligible: true, code, link: `${SITE}/?r=${code}`,
      rank: Number(rank) || null, display_tp: Number(me.display_tp), rounds_played: me.rounds_played, best_streak: me.best_streak,
      referrals: { qualified, pending: count("pending"), held: count("held"), capped: count("capped") },
      tier: tierOf(qualified), next: nextTier(qualified), paused,
    }, 200, origin);
  }

  if (action === "status") {
    const { data: bound } = await sb.from("referrals").select("status")
      .eq("season_id", season.id).eq("referee", address).maybeSingle();
    if (bound) return json({ ok: true, season: seasonOut, bound: true, bindable: false, reason: "already_bound" }, 200, origin);
    let st: bigint | null;
    try { st = await ticketStatus(address); } catch { return json({ ok: true, season: seasonOut, bound: false, bindable: false, reason: "chain_unavailable" }, 200, origin); }
    const live = st === PENDING || st === ACTIVE;
    return json({ ok: true, season: seasonOut, bound: false, bindable: live, reason: live ? null : "no_ticket" }, 200, origin);
  }

  if (action === "bind") {
    const code = String(body?.code ?? "").trim().toUpperCase();
    const issued = String(body?.issued ?? "");
    const signature = String(body?.signature ?? "");
    if (!CODE_RE.test(code)) return json({ ok: false, error: BIND_TEXT.unknown_code }, 422, origin);
    if (!issuedOk(issued, Date.now())) return json({ ok: false, error: "That signature has expired. Please confirm again." }, 422, origin);
    let signer = "";
    try { signer = ethers.verifyMessage(bindMessage(code, address, season.slug, issued), signature).toLowerCase(); } catch { /* bad signature */ }
    if (signer !== address) return json({ ok: false, error: "The signature doesn't match this wallet." }, 401, origin);
    let st: bigint | null;
    try { st = await ticketStatus(address); } catch { return json({ ok: false, error: "Couldn't reach the chain just now — please try again." }, 502, origin); }
    if (st !== PENDING && st !== ACTIVE) return json({ ok: false, error: "Make your first ticket, then confirm the referral." }, 409, origin);
    const ip = req.headers.get("X-TS-Client-IP") || req.headers.get("X-Real-IP") || "";
    // No network means the call didn't come through the site's Worker, and the
    // 3-per-network cap can't apply: refuse rather than bind uncapped.
    if (!ip) return json({ ok: false, error: "Open timbswap.xyz to confirm your referral." }, 403, origin);
    const ipHash = await sha256Hex(IP_SALT + "|" + ip);
    const { data, error } = await sb.rpc("referral_bind", { p_season: season.id, p_code: code, p_referee: address, p_ip_hash: ipHash });
    if (error) return json({ ok: false, error: "Couldn't save that just now — please try again." }, 500, origin);
    const result = String(data);
    return json({ ok: result === "bound" || result === "capped", result, message: BIND_TEXT[result] ?? result }, 200, origin);
  }

  return json({ ok: false, error: "unknown action" }, 400, origin);
});
