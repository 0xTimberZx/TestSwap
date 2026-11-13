// TimbSwap live watcher count (Supabase Edge Function, Deno).
//
// /compete posts { sid, page, leave? } to the same-origin Worker route
// POST /api/presence (workers/timbswap-api.js), which relays here with the
// caller's IP as X-Real-IP. Every 15 s a visible tab heartbeats; a tab counts
// as watching while its last heartbeat is under WINDOW_S (30 s) old. `leave`
// deletes the tab's row at once (tab closed or hidden). Returns { watching }.
//
// Abuse cap: one IP can hold at most MAX_PER_IP live tabs, so a script can't
// inflate the number from one machine. Only a salted hash of the IP is kept,
// and rows are pruned after 2 minutes.
//
// Secrets: SUPABASE_URL (auto-injected); SB_SECRET_KEY, falling back to the
// auto-injected SUPABASE_SERVICE_ROLE_KEY; PRESENCE_SALT (optional; any
// random string — without it the hash still works, just unsalted per deploy).
// Optional PRESENCE_PROXY_SECRET: when set, only calls carrying the matching
// X-Proxy-Secret (i.e. through the Worker) are accepted.
// Deploy: supabase functions deploy presence --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL     = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = (Deno.env.get("SB_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"))!;
const SALT       = Deno.env.get("PRESENCE_SALT") || "timbswap-presence";
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
const PROXY_GATE = proxyGate("PRESENCE_PROXY_SECRET");

const WINDOW_S   = 30;
const PRUNE_S    = 120;
const MAX_PER_IP = 5;
const PAGES      = new Set(["compete"]);
const UUID_RE    = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_ORIGINS = new Set([
  "https://timbswap.xyz",
  "https://www.timbswap.xyz",
  "https://0xtimberzx.github.io",
]);
function cors(origin: string) {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://timbswap.xyz";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}
function json(body: unknown, status: number, origin: string) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors(origin), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin") || "";
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405, origin);
  const gate = PROXY_GATE(req.headers.get("X-Proxy-Secret"));
  if (gate === "misconfigured") return json({ error: "unavailable" }, 503, origin);
  if (gate === "forbidden") return json({ error: "forbidden" }, 403, origin);

  let body: any = {};
  try { body = await req.json(); } catch { /* fall through to validation */ }
  const sid  = String(body?.sid ?? "");
  const page = String(body?.page ?? "compete");
  if (!UUID_RE.test(sid) || !PAGES.has(page)) return json({ error: "bad request" }, 400, origin);

  const sb  = createClient(SB_URL, SB_SERVICE);
  const now = Date.now();
  const live = new Date(now - WINDOW_S * 1000).toISOString();

  if (body?.leave === true) {
    await sb.from("presence").delete().eq("sid", sid);
  } else {
    const ip = req.headers.get("X-TS-Client-IP") || req.headers.get("X-Real-IP") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
    const ipHash = await sha256(`${SALT}:${ip}`);
    // Cap live tabs per IP; an existing tab of this IP may always refresh.
    const { count: ipLive } = await sb.from("presence").select("sid", { count: "exact", head: true })
      .eq("ip_hash", ipHash).gte("last_seen", live).neq("sid", sid);
    if ((ipLive ?? 0) < MAX_PER_IP) {
      await sb.from("presence").upsert({ sid, page, ip_hash: ipHash, last_seen: new Date(now).toISOString() });
    }
    // Cheap housekeeping on ~1 in 10 heartbeats.
    if (Math.random() < 0.1) {
      await sb.from("presence").delete().lt("last_seen", new Date(now - PRUNE_S * 1000).toISOString());
    }
  }

  const { count, error } = await sb.from("presence").select("sid", { count: "exact", head: true })
    .eq("page", page).gte("last_seen", live);
  if (error) return json({ error: "unavailable" }, 503, origin);
  return json({ watching: count ?? 0, window_s: WINDOW_S }, 200, origin);
});
