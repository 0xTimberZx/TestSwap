// faucet.js — the /faucet/ page.
//
// On-site claiming: the connected wallet's address is POSTed to the faucet-claim
// edge function (the gatekeeper). It verifies a LIVE active ticket on-chain,
// reserves the 24h slot in Postgres, and enqueues the claim; the faucet-worker
// then sends the gas drip + pot contribution. The page never touches the hot
// wallet — it only asks, and reflects the gatekeeper's voice-tuned reply.

// The faucet-claim gatekeeper. Same Supabase project as DebugHub telemetry.
// verify_jwt is off on this function, so no apikey/Authorization header is
// needed — the on-chain active-ticket check + 24h cooldown are the gate.
const FAUCET_CLAIM_URL = "https://ipyfodnidwsdvwqrcjrl.functions.supabase.co/faucet-claim";

// Chains where public base-ETH faucets are relevant. On mainnet this list won't
// include the active CHAIN_ID, so the external-faucet section stays hidden and
// only the TimbSwap faucet shows — exactly the testnet/mainnet split we want.
const TESTNET_CHAINS = [421614]; // Arbitrum Sepolia

function showExternalIfTestnet() {
  const el = document.getElementById("external-faucets");
  if (el && TESTNET_CHAINS.includes(CHAIN_ID)) el.hidden = false;
}

// Status line under the action row — success, cooldown, eligibility, transient.
function setClaimStatus(msg, kind) {
  const el = document.getElementById("faucet-status");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "faucet-status" + (kind ? " faucet-status-" + kind : "");
  el.hidden = !msg;
}

// Reset the claim button to its idle, ready-to-claim state.
function resetClaimBtn() {
  const btn = document.getElementById("faucet-claim");
  if (btn) { btn.disabled = false; btn.textContent = "Claim gas top-up"; }
}

// Swap the card between its connected / disconnected states.
function reflectConnectedUI(connected) {
  const connectBtn = document.getElementById("faucet-connect");
  const claimBtn   = document.getElementById("faucet-claim");
  const hint       = document.getElementById("faucet-hint");
  if (connectBtn) connectBtn.hidden = connected;
  if (claimBtn)   claimBtn.hidden   = !connected;
  if (hint)       hint.hidden       = !connected;
  if (connected) resetClaimBtn();
  else setClaimStatus("", null);
}

let _claimInFlight = false;

// Ask the gatekeeper to top up the connected wallet. One request at a time.
async function handleClaim() {
  if (_claimInFlight) return;
  if (!userAddress) { setClaimStatus("Connect your wallet first.", "err"); return; }

  const btn = document.getElementById("faucet-claim");
  _claimInFlight = true;
  if (btn) { btn.disabled = true; btn.textContent = "Requesting…"; }
  setClaimStatus("Checking your ticket…", "pending");
  DebugHub.logCheckpoint("Faucet:Claim Requested", "pass");

  try {
    const r = await fetch(FAUCET_CLAIM_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: userAddress }),
    });
    let body = {};
    try { body = await r.json(); } catch { /* keep {} */ }

    if (r.ok) {
      // 202 queued — the worker sends within seconds. One per 24h, so leave the
      // button disabled; a page refresh re-arms it for the next window.
      setClaimStatus(body.message || "You're in. Gas is on the way — usually within a few seconds.", "ok");
      if (btn) { btn.disabled = true; btn.textContent = "Claim sent ✓"; }
      DebugHub.logCheckpoint("Faucet:Claim Queued", "pass");
    } else {
      const msg = body.error || "Couldn't claim right now — try again in a moment.";
      setClaimStatus(msg, "err");
      DebugHub.logCheckpoint("Faucet:Claim Rejected", "fail");
      if (r.status === 429) {
        // On cooldown — keep it disabled; nothing to retry until the window rolls.
        if (btn) { btn.disabled = true; btn.textContent = "On cooldown"; }
      } else if (r.status === 502 || r.status === 503) {
        // Transient (chain unreachable / busy) — let them retry now.
        if (btn) { btn.disabled = false; btn.textContent = "Try again"; }
      } else {
        // Eligibility (403) or bad input (400) — re-enable so a fix can retry.
        resetClaimBtn();
      }
    }
  } catch (e) {
    setClaimStatus("Network hiccup — check your connection and try again.", "err");
    DebugHub.logError("Faucet:Claim", e);
    if (btn) { btn.disabled = false; btn.textContent = "Try again"; }
  } finally {
    _claimInFlight = false;
  }
}

// ─── Wallet connect (nav + card) ───────────────────────────────────────────────

async function handleConnect() {
  DebugHub.logCheckpoint("Wallet Connect Requested", "pass");
  const ok = await connectWallet();
  if (!ok) { DebugHub.logCheckpoint("Wallet Connect Failed", "fail"); return; }

  DebugHub.startSession(userAddress);
  DebugHub.logSecurity("Chain Check", "pass");
  DebugHub.logCheckpoint("Wallet Connected", "pass");

  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);
  reflectConnectedUI(true);

  listenForAccountChanges(onWalletChanged);
}

function handleDisconnect() {
  DebugHub.endSession();
  disconnectWallet();
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  reflectConnectedUI(false);
}

// A different wallet became active in the same browser session (Switch Account /
// wallet UI). Update the chrome AND reset the claim card so the newly-selected
// wallet can claim on its own merits. Owning several wallets in one browser must
// never lock any of them out — each is gated only by ITS OWN active ticket and
// 24h cooldown, one submission at a time.
function onWalletChanged(newAddr) {
  if (!newAddr) { handleDisconnect(); return; }
  const el = document.getElementById("wallet-addr");
  if (el) el.textContent = fmtAddr(newAddr);
  resetClaimBtn();
  setClaimStatus("", null);
  DebugHub.startSession(newAddr);
}

// ─── Init ───────────────────────────────────────────────────────────────────────

(async () => {
  DebugHub.logCheckpoint("Faucet:Page Loaded", "pass");
  showExternalIfTestnet();

  const reconnected = await autoReconnect();
  if (reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const addrEl = document.getElementById("wallet-addr");
    if (addrEl) addrEl.textContent = fmtAddr(reconnected);
    reflectConnectedUI(true);
    DebugHub.startSession(reconnected);
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    listenForAccountChanges(onWalletChanged);
  }
})();
