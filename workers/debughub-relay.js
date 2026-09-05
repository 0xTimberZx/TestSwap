// Deploy as a Cloudflare Worker on https://timbswap.xyz/api/debughub_events.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are Worker secrets, never client code.

const ALLOWED_ORIGINS = new Set([
  "https://timbswap.xyz",
  "https://0xtimberzx.github.io",
]);
const MAX_BODY_BYTES = 32 * 1024;

function cors(origin) {
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "https://timbswap.xyz";
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

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return json({ error: "POST only" }, 405, origin);
    if (origin && !ALLOWED_ORIGINS.has(origin)) return json({ error: "Origin not allowed" }, 403, origin);

    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413, origin);

    let payload;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413, origin);
      payload = JSON.parse(text);
    } catch {
      return json({ error: "Invalid JSON" }, 400, origin);
    }
    if (payload.app !== "TimbSwap" || typeof payload.type !== "string") {
      return json({ error: "Invalid telemetry event" }, 400, origin);
    }

    const upstream = await fetch(`${env.SUPABASE_URL}/rest/v1/debughub_events`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    });
    return new Response(null, { status: upstream.status, headers: cors(origin) });
  },
};
