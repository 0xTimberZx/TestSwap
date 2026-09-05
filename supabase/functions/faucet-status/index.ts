// TimbSwap gas faucet — claim status reader (Supabase Edge Function, Deno).
//
// The page POSTs { claimId } (returned by faucet-claim's 202) and this returns
// that claim's status + tx hashes, so the page can show "Completed + view tx".
// faucet_claims has RLS ON with no anon policy, so the publishable key that ships
// in the page can't read it — this service-role function exposes only the safe,
// non-sensitive status fields for a single claim id. It never sends anything.
//
// Env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (both auto-injected).
// Deploy: supabase functions deploy faucet-status --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SB_URL     = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Same comma-separated allowlist as faucet-claim (per-website, not per-wallet).
const ALLOWED_ORIGINS = (Deno.env.get("FAUCET_ALLOWED_ORIGIN") || "*")
  .split(",").map((s) => s.trim()).filter(Boolean);

function corsFor(req: Request): Record<string, string> {
  let allow = "*";
  if (!(ALLOWED_ORIGINS.length === 1 && ALLOWED_ORIGINS[0] === "*")) {
    const reqOrigin = req.headers.get("origin") || "";
    allow = ALLOWED_ORIGINS.includes(reqOrigin) ? reqOrigin : ALLOWED_ORIGINS[0];
  }
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type, authorization, apikey",
  };
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "content-type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return json({ error: "POST only" }, 405);

  let claimId: number;
  try {
    const body = await req.json();
    claimId = Number(body.claimId);
    if (!Number.isInteger(claimId) || claimId <= 0) throw new Error("bad id");
  } catch {
    return json({ error: "Invalid claimId." }, 400);
  }

  const sb = createClient(SB_URL, SB_SERVICE);
  const { data, error } = await sb
    .from("faucet_claims")
    .select("status, wallet_tx, pot_tx")
    .eq("id", claimId)
    .maybeSingle();

  if (error) return json({ error: "Lookup failed — try again." }, 503);
  if (!data)  return json({ error: "Claim not found." }, 404);

  return json({
    status:   data.status,
    walletTx: data.wallet_tx,
    potTx:    data.pot_tx,
  }, 200);
});
