// faucet-worker.js
// TimbSwap gas faucet — the single sender.
//
// The edge function (supabase/functions/faucet-claim) gatekeeps: it verifies a
// LIVE active ticket, enforces the 24h cooldown, and enqueues a 'reserved' row.
// THIS worker is the only thing that touches the hot wallet, so every send sits
// on one sequential nonce stream — no races even under concurrent claims.
//
// Per claim it sends TWO transactions:
//   1. DRIP_ETH  → the claimant's wallet   (their gas)
//   2. POT_ETH   → TimbPrize.addToPot()     (grows the live round pot)
//
// It LINGERS like the settler: polls the queue every POLL_SECONDS for up to
// FAUCET_LINGER_MINUTES, so a paste-and-claim lands within seconds, then exits
// and lets the workflow self-chain the next run.
//
// Env:
//   ARB_RPC / ARB_SEPOLIA_RPC   RPC (mainnet Arb One at launch)
//   FAUCET_PRIVATE_KEY          hot wallet, funded from treasury
//   SUPABASE_URL                https://<project>.supabase.co
//   SUPABASE_SERVICE_KEY        service_role key (bypasses RLS)
//   TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID   ops alerts (optional)
//   DRIP_ETH   default 0.000005     POT_ETH default 0.000005
//   MIN_BALANCE_ETH  default 0.01   refuse+alert below this
//   FAUCET_LINGER_MINUTES default 55   POLL_SECONDS default 10

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

const RPC_URL      = process.env.ARB_RPC || process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY  = process.env.FAUCET_PRIVATE_KEY;
const SB_URL       = process.env.SUPABASE_URL;
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY;
const TG_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const DRIP_WEI = ethers.parseEther(process.env.DRIP_ETH || "0.000005");
const POT_WEI  = ethers.parseEther(process.env.POT_ETH  || "0.000005");
const MIN_BAL  = ethers.parseEther(process.env.MIN_BALANCE_ETH || "0.01");

const LINGER_MS   = Number(process.env.FAUCET_LINGER_MINUTES || 55) * 60_000;
const POLL_MS     = Number(process.env.POLL_SECONDS || 10) * 1000;
const BATCH       = 25;
const STATUS_ACTIVE = 1n;
// Daily circuit-breaker (M7): cap total claims dispatched per rolling 24h so an
// unauthenticated griefer pasting enumerable active-ticket addresses can't drain
// the budget or force unbounded pot contributions. 0 = uncapped (set on mainnet).
const DAILY_CAP   = Number(process.env.FAUCET_DAILY_CAP || 0);

// Addresses come straight from config.js — same single source of truth the
// settler and frontend use, so a redeploy only edits config.js.
function addrFromConfig(key) {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const m = src.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) throw new Error(`Address "${key}" not found in config.js — refusing to start faucet`);
  return ethers.getAddress(m[1]);
}
const TIMBPRIZE_ADDR = addrFromConfig("TimbPrize");
const REGISTRY_ADDR  = addrFromConfig("GameRegistry");

const REGISTRY_ABI = [
  "function activeTicketOf(address) view returns (uint256)",
  "function effectiveStatus(uint256) view returns (uint8)",
];
const PRIZE_ABI = ["function addToPot() payable"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Telegram ──────────────────────────────────────────────────────────────
async function notify(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID) { console.log("[notify]", msg); return; }
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text: `🚰 *TimbSwap Faucet*\n${msg}`, parse_mode: "Markdown" }),
    });
  } catch (e) { console.error("[notify] failed:", e.message); }
}

// ─── Supabase REST (PostgREST) with the service key ──────────────────────────
const sbHeaders = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json" };

async function fetchReserved() {
  const url = `${SB_URL}/rest/v1/faucet_claims?status=eq.reserved&order=reserved_at.asc&limit=${BATCH}`;
  const res = await fetch(url, { headers: sbHeaders });
  if (!res.ok) throw new Error(`queue read ${res.status}: ${await res.text()}`);
  return res.json();
}

async function updateClaim(id, patch) {
  const url = `${SB_URL}/rest/v1/faucet_claims?id=eq.${id}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { ...sbHeaders, Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) console.error(`[claim ${id}] update ${res.status}: ${await res.text()}`);
}

// Count claims dispatched in the last rolling 24h (M7 daily circuit-breaker).
// Uses a HEAD + count=exact so no rows are transferred.
async function sentLast24h() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const url = `${SB_URL}/rest/v1/faucet_claims?status=eq.sent&sent_at=gte.${since}&select=id`;
  const res = await fetch(url, { method: "HEAD", headers: { ...sbHeaders, Prefer: "count=exact", Range: "0-0" } });
  const cr = res.headers.get("content-range") || "*/0";   // e.g. "0-0/1234" or "*/0"
  return Number(cr.split("/")[1] || 0);
}

async function expireStale() {
  try {
    await fetch(`${SB_URL}/rest/v1/rpc/expire_stale_reservations`, { method: "POST", headers: sbHeaders });
  } catch (e) { console.warn("[faucet] expire sweep failed:", e.message); }
}

// ─── Send one claim: drip + pot, sequential nonces ───────────────────────────
async function dispatch(provider, wallet, prize, registry, claim) {
  const to = ethers.getAddress(claim.address);

  // Defense-in-depth: the ticket could have gone inactive between reserve and
  // now. Re-check on-chain; if it's no longer active, fail the claim (frees the
  // slot) rather than paying a wallet that dropped out.
  const tid = await registry.activeTicketOf(to);
  if (tid === 0n || (await registry.effectiveStatus(tid)) !== STATUS_ACTIVE) {
    await updateClaim(claim.id, { status: "failed", error: "ticket no longer active at send time" });
    return;
  }

  const feeData = await provider.getFeeData();
  const maxFeePerGas         = feeData.maxFeePerGas         * 130n / 100n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * 130n / 100n;
  let nonce = await provider.getTransactionCount(wallet.address, "pending");

  try {
    const dripTx = await wallet.sendTransaction({
      to, value: DRIP_WEI, nonce: nonce++, maxFeePerGas, maxPriorityFeePerGas,
    });
    const potTx = await prize.addToPot({
      value: POT_WEI, nonce: nonce++, maxFeePerGas, maxPriorityFeePerGas,
    });
    await Promise.all([dripTx.wait(), potTx.wait()]);

    await updateClaim(claim.id, {
      status: "sent", wallet_tx: dripTx.hash, pot_tx: potTx.hash, sent_at: new Date().toISOString(),
    });
    console.log(`[claim ${claim.id}] ${to} +${ethers.formatEther(DRIP_WEI)} ETH, pot +${ethers.formatEther(POT_WEI)} (drip ${dripTx.hash})`);
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    await updateClaim(claim.id, { status: "failed", error: msg.slice(0, 300) });
    await notify(`❌ Claim ${claim.id} (${to}) failed\n${msg}`);
  }
}

// ─── Main linger loop ────────────────────────────────────────────────────────
async function main() {
  if (!RPC_URL)     throw new Error("Missing RPC (ARB_RPC / ARB_SEPOLIA_RPC)");
  if (!PRIVATE_KEY) throw new Error("Missing FAUCET_PRIVATE_KEY");
  if (!SB_URL || !SB_KEY) throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const prize    = new ethers.Contract(TIMBPRIZE_ADDR, PRIZE_ABI, wallet);
  const registry = new ethers.Contract(REGISTRY_ADDR, REGISTRY_ABI, provider);

  await expireStale();

  const startedAt = Date.now();
  let lowWarned = false;
  let capWarned = false;

  while (Date.now() - startedAt < LINGER_MS) {
    // Balance guard — refuse to send (and alert once) if the hot wallet is low.
    const bal = await provider.getBalance(wallet.address);
    if (bal < MIN_BAL) {
      if (!lowWarned) {
        await notify(`⚠️ Hot wallet low: ${ethers.formatEther(bal)} ETH (< ${ethers.formatEther(MIN_BAL)}). Top it up from treasury — claims are paused.`);
        lowWarned = true;
      }
      await sleep(POLL_MS);
      continue;
    }
    lowWarned = false;

    // Daily circuit-breaker (M7): once the rolling-24h dispatch count hits the
    // cap, pause — this bounds a griefer's ability to drain the budget / force
    // pot contributions by pasting enumerable active-ticket addresses.
    if (DAILY_CAP > 0) {
      let sent;
      try { sent = await sentLast24h(); }
      catch (e) { console.error("[faucet] daily-cap read failed:", e.message); await sleep(POLL_MS); continue; }
      if (sent >= DAILY_CAP) {
        if (!capWarned) {
          await notify(`⚠️ Faucet daily cap reached (${sent}/${DAILY_CAP} in 24h) — pausing until it rolls off.`);
          capWarned = true;
        }
        await sleep(POLL_MS);
        continue;
      }
      capWarned = false;
    }

    let claims;
    try { claims = await fetchReserved(); }
    catch (e) { console.error("[faucet] queue read failed:", e.message); await sleep(POLL_MS); continue; }

    if (claims.length === 0) { await sleep(POLL_MS); continue; }

    // Sequential — one claim at a time keeps the nonce stream clean.
    for (const claim of claims) {
      if (await provider.getBalance(wallet.address) < MIN_BAL) break;
      await dispatch(provider, wallet, prize, registry, claim);
    }
  }
  console.log("[faucet] linger budget reached — exiting; workflow re-chains.");
}

main().catch(async (err) => {
  console.error("[faucet] fatal:", err.message);
  await notify(`💥 Faucet worker fatal\n${err.message}`);
  process.exit(1);
});
