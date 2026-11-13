// TimbSwap first-party API Worker — Cloudflare Worker on route `timbswap.xyz/api/*`.
//
// Why this exists: the app's on-chain reads were third-party to timbswap.xyz
// (Alchemy). Brave Shields / adblockers throttle or block third-party requests,
// which made reads dash intermittently in Brave. Served from the SITE'S OWN ORIGIN
// under /api/*, they are first-party — Brave never touches them. Same-origin also
// means the browser skips CORS entirely.
//
// Client IP: Supabase does not pass X-Real-IP through to the function, so every
// route also sends the caller's IP as X-TS-Client-IP, which the functions read first.
//
// Routes (POST):
//   /api/rpc              → Alchemy JSON-RPC (single + batch). Env: ALCHEMY_RPC_URL
//   /api/waitlist         → Supabase `waitlist` edge fn. Var: WAITLIST_UPSTREAM;
//                           optional secret: WAITLIST_PROXY_SECRET. Adds the
//                           caller's real IP + country as X-Real-IP / X-Client-Country.
//   /api/quests           → Supabase `quests` edge fn (read-only leaderboard).
//                           Var: QUESTS_UPSTREAM.
//   /api/faucet-claim     → Supabase `faucet-claim` edge fn. Var: FAUCET_UPSTREAM;
//                           optional secret: FAUCET_PROXY_SECRET. Adds the caller's
//                           real IP as X-Real-IP (for Turnstile remoteip).
//   /api/presence         → Supabase `presence` edge fn (live 👁️ watcher count on
//                           /compete). Var: PRESENCE_UPSTREAM; optional secret:
//                           PRESENCE_PROXY_SECRET. Adds the caller's real IP as
//                           X-Real-IP (hashed upstream, to cap tabs per IP).
//   /api/referrals        → Supabase `referrals` edge fn (season cards + referral
//                           confirm). Var: REFERRALS_UPSTREAM; optional secret:
//                           REFERRALS_PROXY_SECRET. Adds X-TS-Client-IP.
//   /api/gas-board        → Supabase `gas-board` edge fn (testnet gas request board on
//                           /start). Var: GAS_BOARD_UPSTREAM; optional secret:
//                           GAS_BOARD_PROXY_SECRET. Adds the caller's real IP as
//                           X-Real-IP (Turnstile remoteip + per-network rate limit).
// Anything else falls through to the origin (GitHub Pages).
//
// The /api/debughub_events telemetry sink was REMOVED for the capped beta: the
// client SDK is localStorage-only (config.js), so nothing calls it, and leaving an
// unauthenticated service-role write sink reachable was pointless surface. Its
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY secrets are now unused — delete them in
// the Cloudflare dashboard. See config.js and SECURITY.md before re-adding a sink.
//
// Secrets / vars (wrangler secret put / [vars] in wrangler.toml):
//   ALCHEMY_RPC_URL             keyed Alchemy Arbitrum-One URL (public anyway)
//   WAITLIST_UPSTREAM           (var) Supabase waitlist function URL
//   WAITLIST_PROXY_SECRET       (secret, optional) shared with the waitlist fn
//   QUESTS_UPSTREAM             (var) Supabase quests function URL
//   FAUCET_UPSTREAM             (var) Supabase faucet-claim function URL
//   FAUCET_PROXY_SECRET         (secret, optional) shared with the faucet-claim fn
//   PRESENCE_UPSTREAM           (var) Supabase presence function URL
//   PRESENCE_PROXY_SECRET       (secret, optional) shared with the presence fn
//   GAS_BOARD_UPSTREAM          (var) Supabase gas-board function URL
//   GAS_BOARD_PROXY_SECRET      (secret, optional) shared with the gas-board fn
//   REFERRALS_UPSTREAM          (var) Supabase referrals function URL
//   REFERRALS_PROXY_SECRET      (secret, optional) shared with the referrals fn
//
// Route + deploy: see workers/README.md.

const ALLOWED_ORIGINS = new Set([
  "https://timbswap.xyz",
  "https://www.timbswap.xyz",
  "https://0xtimberzx.github.io",
]);
const MAX_BODY_BYTES = 128 * 1024; // RPC batches + signup rows are small; generous cap

// /api/rpc serves the app's chain READS only. Wallets broadcast through their own
// provider (injected wallets, and the email wallet's Privy RPC), never this proxy,
// so anything outside this list is refused instead of spending the Alchemy quota.
const RPC_METHODS = new Set([
  "eth_chainId", "net_version", "eth_blockNumber",
  "eth_call", "eth_estimateGas", "eth_getLogs",
  "eth_getBalance", "eth_getCode", "eth_getStorageAt", "eth_getTransactionCount",
  "eth_getBlockByNumber", "eth_getBlockByHash",
  "eth_getTransactionByHash", "eth_getTransactionReceipt",
  "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
]);

// Returns an error Response if the body is not JSON-RPC made of allowed calls.
function checkRpc(request, text, origin) {
  const ct = (request.headers.get("Content-Type") || "").toLowerCase();
  if (!ct.startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json" }, 415, origin);
  }
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: "invalid JSON" }, 400, origin); }
  const calls = Array.isArray(body) ? body : [body];
  // No batch-count cap: config.js uses JsonRpcBatchProvider, which folds every
  // read in a tick into one POST (page loads exceed 50). MAX_BODY_BYTES bounds it.
  if (calls.length === 0) return json({ error: "empty batch" }, 400, origin);
  for (const c of calls) {
    if (!c || typeof c.method !== "string" || !RPC_METHODS.has(c.method)) {
      return json({ error: "method not allowed" }, 403, origin);
    }
  }
  return null;
}

function cors(origin) {
  // Same-origin calls send no Origin and need no CORS; echo an allowed Origin for
  // any cross-origin caller (e.g. the GitHub Pages mirror) and default otherwise.
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://timbswap.xyz";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

async function readBody(request, origin) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > MAX_BODY_BYTES) return { err: json({ error: "Payload too large" }, 413, origin) };
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    return { err: json({ error: "Payload too large" }, 413, origin) };
  }
  return { text };
}

// Proxy secrets travel as a header, which carries printable ASCII only. Clean
// them the way the functions do (trim, strip wrapping quotes, straight or curly).
// A secret with other characters (an emoji, a curly quote mid-string) makes
// fetch throw; report it instead so it can be re-saved.
function proxySecret(name, value) {
  const s = String(value ?? "").trim().replace(/^["'\u2018\u2019\u201c\u201d]+|["'\u2018\u2019\u201c\u201d]+$/g, "").trim();
  if (!s) return { ok: true, value: "" };
  if (/^[\x21-\x7e]+$/.test(s)) return { ok: true, value: s };
  console.error(`${name} holds characters a header can't carry; re-save it`);
  return { ok: false, value: "" };
}

// Relay a POST body to a Supabase edge function, echoing its JSON response.
// Optional extraHeaders are merged into the upstream request.
async function relay(upstream, text, origin, extraHeaders) {
  try {
    const up = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json", ...(extraHeaders || {}) },
      body: text,
    });
    return new Response(await up.text(), {
      status: up.status,
      headers: { ...cors(origin), "Content-Type": "application/json" },
    });
  } catch {
    return json({ error: "upstream unreachable" }, 502, origin);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = request.headers.get("Origin") || "";

    // ── /api/waitlist → relay to the Supabase `waitlist` edge function, same-origin
    // so Brave treats the signup POST as first-party. We add the caller's real IP
    // and country (Cloudflare knows them; the upstream function does not) and an
    // optional shared secret so the public function only trusts proxied calls. ──
    if (path === "/api/waitlist") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      if (request.method !== "POST")    return json({ error: "POST only" }, 405, origin);
      if (!env.WAITLIST_UPSTREAM)       return json({ error: "waitlist unavailable" }, 503, origin);

      const { text, err } = await readBody(request, origin);
      if (err) return err;

      const headers = {
        "X-Real-IP": request.headers.get("CF-Connecting-IP") || "",
        "X-TS-Client-IP": request.headers.get("CF-Connecting-IP") || "",
        "X-Client-Country": (request.cf && request.cf.country) || "",
      };
      const ps = proxySecret("WAITLIST_PROXY_SECRET", env.WAITLIST_PROXY_SECRET);
      if (!ps.ok) return json({ error: "service misconfigured" }, 500, origin);
      if (ps.value) headers["X-Proxy-Secret"] = ps.value;
      return relay(env.WAITLIST_UPSTREAM, text, origin, headers);
    }

    // ── /api/quests → relay to the Supabase `quests` edge function (read-only
    // leaderboard). Same-origin so Brave doesn't drop it; no secret needed. ──
    if (path === "/api/quests") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      if (request.method !== "POST")    return json({ error: "POST only" }, 405, origin);
      if (!env.QUESTS_UPSTREAM)         return json({ error: "quests unavailable" }, 503, origin);

      const { text, err } = await readBody(request, origin);
      if (err) return err;
      return relay(env.QUESTS_UPSTREAM, text || "{}", origin);
    }

    // ── /api/faucet-claim → relay to the Supabase `faucet-claim` edge function,
    // same-origin so Brave treats the claim POST as first-party. We add the
    // caller's real IP (Turnstile's siteverify wants remoteip) and an optional
    // shared secret so the public function only trusts proxied calls. ──
    if (path === "/api/faucet-claim") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      if (request.method !== "POST")    return json({ error: "POST only" }, 405, origin);
      if (!env.FAUCET_UPSTREAM)         return json({ error: "faucet unavailable" }, 503, origin);

      const { text, err } = await readBody(request, origin);
      if (err) return err;

      const ip = request.headers.get("CF-Connecting-IP") || "";
      const headers = { "X-Real-IP": ip, "X-TS-Client-IP": ip };
      const ps = proxySecret("FAUCET_PROXY_SECRET", env.FAUCET_PROXY_SECRET);
      if (!ps.ok) return json({ error: "service misconfigured" }, 500, origin);
      if (ps.value) headers["X-Proxy-Secret"] = ps.value;
      return relay(env.FAUCET_UPSTREAM, text, origin, headers);
    }

    // ── /api/presence → relay to the Supabase `presence` edge function (the live
    // 👁️ watcher count). Same-origin so Brave lets the heartbeat through; we add
    // the caller's real IP so the function can cap tabs per IP. Without the var
    // the route answers 503 and the page simply hides the badge. ──
    if (path === "/api/presence") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      if (request.method !== "POST")    return json({ error: "POST only" }, 405, origin);
      if (!env.PRESENCE_UPSTREAM)       return json({ error: "presence unavailable" }, 503, origin);

      const { text, err } = await readBody(request, origin);
      if (err) return err;

      const ip = request.headers.get("CF-Connecting-IP") || "";
      const headers = { "X-Real-IP": ip, "X-TS-Client-IP": ip };
      const ps = proxySecret("PRESENCE_PROXY_SECRET", env.PRESENCE_PROXY_SECRET);
      if (!ps.ok) return json({ error: "service misconfigured" }, 500, origin);
      if (ps.value) headers["X-Proxy-Secret"] = ps.value;
      return relay(env.PRESENCE_UPSTREAM, text, origin, headers);
    }

    // ── /api/gas-board → relay to the Supabase `gas-board` edge function (the
    // testnet gas request board). Same pattern as the faucet: real IP for
    // Turnstile and the per-network limit, optional shared secret. ──
    if (path === "/api/gas-board") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      if (request.method !== "POST")    return json({ error: "POST only" }, 405, origin);
      if (!env.GAS_BOARD_UPSTREAM)      return json({ error: "gas board unavailable" }, 503, origin);

      const { text, err } = await readBody(request, origin);
      if (err) return err;

      const ip = request.headers.get("CF-Connecting-IP") || "";
      const headers = { "X-Real-IP": ip, "X-TS-Client-IP": ip };
      const ps = proxySecret("GAS_BOARD_PROXY_SECRET", env.GAS_BOARD_PROXY_SECRET);
      if (!ps.ok) return json({ error: "service misconfigured" }, 500, origin);
      if (ps.value) headers["X-Proxy-Secret"] = ps.value;
      return relay(env.GAS_BOARD_UPSTREAM, text, origin, headers);
    }

    // ── /api/referrals → relay to the Supabase `referrals` edge function (season
    // cards, referral confirm). Real IP for the 3-per-network cap, optional secret. ──
    if (path === "/api/referrals") {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
      if (request.method !== "POST")    return json({ error: "POST only" }, 405, origin);
      if (!env.REFERRALS_UPSTREAM)      return json({ error: "referrals unavailable" }, 503, origin);

      const { text, err } = await readBody(request, origin);
      if (err) return err;

      const ip = request.headers.get("CF-Connecting-IP") || "";
      const headers = { "X-Real-IP": ip, "X-TS-Client-IP": ip };
      const ps = proxySecret("REFERRALS_PROXY_SECRET", env.REFERRALS_PROXY_SECRET);
      if (!ps.ok) return json({ error: "service misconfigured" }, 500, origin);
      if (ps.value) headers["X-Proxy-Secret"] = ps.value;
      return relay(env.REFERRALS_UPSTREAM, text, origin, headers);
    }

    // Only /api/rpc remains; everything else (incl. the removed /api/debughub_events)
    // falls through to the static site (origin), which 404s the dead telemetry path.
    if (path !== "/api/rpc") {
      return fetch(request);
    }

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST")    return json({ error: "POST only" }, 405, origin);

    const { text, err } = await readBody(request, origin);
    if (err) return err;
    const bad = checkRpc(request, text, origin);
    if (bad) return bad;

    // ── /api/rpc → Alchemy (relay the JSON-RPC body verbatim; single + batch) ──
    try {
      const up = await fetch(env.ALCHEMY_RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      });
      return new Response(await up.text(), {
        status: up.status,
        headers: { ...cors(origin), "Content-Type": "application/json" },
      });
    } catch {
      return json({ error: "upstream unreachable" }, 502, origin);
    }
  },
};
