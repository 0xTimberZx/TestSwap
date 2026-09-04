// faucet.js — the /faucet/ page.
//
// SCAFFOLD STAGE: this ships the page, nav tab, external testnet-faucet links,
// and the TimbSwap gas keep-alive card. On-site claiming (calling the
// faucet-claim edge function + the running worker) is wired in a follow-up, so
// the claim button stays disabled with a "coming shortly" label for now.

// Chains where public base-ETH faucets are relevant. On mainnet this list won't
// include the active CHAIN_ID, so the external-faucet section stays hidden and
// only the TimbSwap faucet shows — exactly the testnet/mainnet split we want.
const TESTNET_CHAINS = [421614]; // Arbitrum Sepolia

function showExternalIfTestnet() {
  const el = document.getElementById("external-faucets");
  if (el && TESTNET_CHAINS.includes(CHAIN_ID)) el.hidden = false;
}

// Swap the card between its connected / disconnected states.
function reflectConnectedUI(connected) {
  const connectBtn = document.getElementById("faucet-connect");
  const claimBtn   = document.getElementById("faucet-claim");
  const hint       = document.getElementById("faucet-hint");
  if (connectBtn) connectBtn.hidden = connected;
  if (claimBtn)   claimBtn.hidden   = !connected;
  if (hint)       hint.hidden       = !connected;
}

// Placeholder until on-site claiming is wired to the faucet edge function. The
// button is disabled, so this only exists so the onclick binding resolves.
function handleClaim() { /* wired in a follow-up */ }

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

  listenForAccountChanges((newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  disconnectWallet();
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  reflectConnectedUI(false);
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
    listenForAccountChanges((newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const el = document.getElementById("wallet-addr");
      if (el) el.textContent = fmtAddr(newAddr);
    });
  }
})();
