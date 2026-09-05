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
const FAUCET_CLAIM_URL  = "https://ipyfodnidwsdvwqrcjrl.functions.supabase.co/faucet-claim";
// Poll a queued claim's status so the page can show "Completed + tx link" once
// the worker sends (faucet_claims has RLS on, so the page can't read it direct).
const FAUCET_STATUS_URL = "https://ipyfodnidwsdvwqrcjrl.functions.supabase.co/faucet-status";
// Arbitrum Sepolia explorer (matches config.js blockExplorerUrls).
const FAUCET_EXPLORER   = "https://sepolia.arbiscan.io";

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
  stopPolling();
  const btn = document.getElementById("faucet-claim");
  if (btn) { btn.disabled = false; btn.textContent = "Claim gas top-up"; }
}

// ─── Claim-status polling (Found your ticket → timer → Completed + tx link) ──────
let _pollTimer = null;   // next status fetch
let _tickTimer = null;   // 1s elapsed-timer repaint

function stopPolling() {
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

// A tx hash we wrote ourselves, but validate before building a link anyway.
function isTxHash(h) { return typeof h === "string" && /^0x[0-9a-fA-F]{64}$/.test(h); }

// After a claim is queued, poll faucet-status until the worker marks it sent
// (show Completed + explorer link) or failed, with a live elapsed timer.
function pollClaim(claimId) {
  stopPolling();
  const startedAt   = Date.now();
  const DEADLINE_MS = 90_000;
  const el          = document.getElementById("faucet-status");
  const btn         = document.getElementById("faucet-claim");
  const base        = "Found your ticket! Sending your top-up";

  const elapsed = () => Math.max(1, Math.round((Date.now() - startedAt) / 1000));
  setClaimStatus(base + "… 0s", "pending");
  _tickTimer = setInterval(() => {
    setClaimStatus(base + "… " + Math.floor((Date.now() - startedAt) / 1000) + "s", "pending");
  }, 1000);

  async function check() {
    try {
      const r = await fetch(FAUCET_STATUS_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ claimId }),
      });
      const b = await r.json().catch(() => ({}));

      if (r.ok && b.status === "sent" && isTxHash(b.walletTx)) {
        stopPolling();
        const secs = elapsed();
        if (el) {
          el.className = "faucet-status faucet-status-ok";
          el.hidden = false;
          el.textContent = "Completed in " + secs + "s — ";
          const a = document.createElement("a");
          a.href = FAUCET_EXPLORER + "/tx/" + b.walletTx;
          a.target = "_blank"; a.rel = "noopener";
          a.textContent = "view transaction ↗︎";
          el.appendChild(a);
        }
        if (btn) { btn.disabled = true; btn.textContent = "Completed ✓"; }
        DebugHub.logCheckpoint("Faucet:Claim Sent", "pass");
        return;
      }
      if (r.ok && b.status === "failed") {
        stopPolling();
        setClaimStatus("That top-up didn't go through — you can try again.", "err");
        resetClaimBtn();
        DebugHub.logCheckpoint("Faucet:Claim Send Failed", "fail");
        return;
      }
    } catch (_) { /* keep polling through transient errors */ }

    if (Date.now() - startedAt > DEADLINE_MS) {
      stopPolling();
      setClaimStatus("Still sending — the worker is catching up. Your gas will land shortly; refresh to check.", "pending");
      if (btn) btn.textContent = "Sending…";   // stays disabled — avoids a double-claim
      return;
    }
    _pollTimer = setTimeout(check, 3000);
  }
  check();
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
  else { stopPolling(); setClaimStatus("", null); }
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
      // 202 queued — the worker sends within seconds. Poll for the result and
      // show a live timer, then Completed + a link to the tx on the explorer.
      // One per 24h, so the button stays disabled through send + completion.
      if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
      DebugHub.logCheckpoint("Faucet:Claim Queued", "pass");
      if (body && body.claimId != null) {
        pollClaim(body.claimId);
      } else {
        // No claimId to poll (shouldn't happen) — fall back to a static message.
        setClaimStatus("Found your ticket! Gas is on the way — usually within a few seconds.", "ok");
      }
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
