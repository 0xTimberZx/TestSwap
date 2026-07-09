// lock.js — TimbLockVault lock creation, my locks, public registry

const LOCKVAULT_ABI = [
  "function lock(address token, uint256 amount, uint256 durationSeconds) external returns (uint256 lockId)",
  "function withdraw(uint256 lockId) external",
  "function getLock(uint256 lockId) external view returns (tuple(uint256 lockId, address locker, address token, uint256 amount, uint256 lockedAt, uint256 unlockAt, uint8 status, bool isTimbs))",
  "function getLockerHistory(address locker) external view returns (uint256[])",
  "function getActiveLock(address locker, address token) external view returns (tuple(uint256 lockId, address locker, address token, uint256 amount, uint256 lockedAt, uint256 unlockAt, uint8 status, bool isTimbs))",
  "function getWhitelistedTokens() external view returns (address[])",
  "function timeUntilUnlock(uint256 lockId) external view returns (uint256)",
  "function totalLocks() external view returns (uint256)",
  "function tokenWhitelist(address token) external view returns (bool)"
];
const ERC20_ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function totalSupply() external view returns (uint256)"
];

// Lock status enum: 0=Active, 1=Unlocked, 2=Withdrawn
const LOCK_STATUS = ["Active", "Unlocked", "Withdrawn"];

// Read-only queries always go to the canonical Arbitrum Sepolia RPC —
// never the wallet's in-app provider. Mobile wallets sometimes serve
// eth_call/eth_getBalance from a different network than they display,
// which reads as zero balances (or stale state) for perfectly funded
// accounts. The wallet provider is only used for signing transactions.
let _publicProv = null;
function readProv() {
  return _publicProv || (_publicProv = new ethers.providers.JsonRpcProvider(RPC_URL));
}

// ─── State ────────────────────────────────────────────────────────────────────

let whitelistedTokens = []; // { address, symbol, decimals, logoChar }
let selectedToken     = null;

// ─── Token Whitelist ──────────────────────────────────────────────────────────

async function loadWhitelistedTokens() {
  try {
    const vault = new ethers.Contract(ADDRESSES.TimbLockVault, LOCKVAULT_ABI, readProv());
    const addresses = await vault.getWhitelistedTokens();
    whitelistedTokens = [];

    const select = document.getElementById("lock-token-select");
    select.innerHTML = '<option value="">Select token…</option>';

    for (const addr of addresses) {
      try {
        const erc = new ethers.Contract(addr, ERC20_ABI, readProv());
        const [symbol, decimals] = await Promise.all([
          erc.symbol().catch(() => "???"),
          erc.decimals().catch(() => 18)
        ]);
        const isTimbs = addr.toLowerCase() === ADDRESSES.TIMBSToken.toLowerCase();
        const logoChar = isTimbs ? "T" : symbol.charAt(0);

        const token = { address: addr, symbol, decimals, logoChar, isTimbs };
        whitelistedTokens.push(token);

        const opt = document.createElement("option");
        opt.value = addr;
        opt.textContent = symbol + (isTimbs ? " ★" : "");
        select.appendChild(opt);
      } catch {}
    }
  } catch (e) {
    console.warn("loadWhitelistedTokens:", e.message);
  }
}

async function onTokenSelectChange() {
  const addr = document.getElementById("lock-token-select").value;
  selectedToken = whitelistedTokens.find(t => t.address === addr) || null;
  await refreshLockBalance();
  updateLockButton();
}

async function refreshLockBalance() {
  const el = document.getElementById("lock-balance");
  if (!selectedToken || !userAddress) { el.textContent = "Balance: —"; return; }
  try {
    const erc = new ethers.Contract(selectedToken.address, ERC20_ABI, provider);
    const bal = await erc.balanceOf(userAddress);
    el.textContent = `Balance: ${fmt(bal, selectedToken.decimals, 4)} ${selectedToken.symbol}`;
  } catch { el.textContent = "Balance: —"; }
}

async function setLockMax() {
  if (!selectedToken || !userAddress) return;
  try {
    const erc = new ethers.Contract(selectedToken.address, ERC20_ABI, provider);
    const bal = await erc.balanceOf(userAddress);
    document.getElementById("lock-amount").value = ethers.utils.formatUnits(bal, selectedToken.decimals);
  } catch {}
}

function onDurationChange() {
  const val = document.getElementById("duration-slider").value;
  document.getElementById("duration-display").textContent = val + " hours";
}

function updateLockButton() {
  const btn = document.getElementById("lock-btn");
  if (!userAddress) { btn.textContent = "Connect wallet to lock"; btn.disabled = true; return; }
  if (!selectedToken) { btn.textContent = "Select a token"; btn.disabled = true; return; }
  const amt = parseFloat(document.getElementById("lock-amount").value);
  if (!amt || amt <= 0) { btn.textContent = "Enter amount"; btn.disabled = true; return; }
  btn.textContent = `Lock ${selectedToken.symbol}`;
  btn.disabled = false;
}

// ─── Create Lock ──────────────────────────────────────────────────────────────

async function handleCreateLock() {
  if (!userAddress || !selectedToken) return;
  const amountStr = document.getElementById("lock-amount").value;
  const durationHours = parseInt(document.getElementById("duration-slider").value);
  if (!amountStr || parseFloat(amountStr) <= 0) return;

  const btn = document.getElementById("lock-btn");
  const amountWei = ethers.utils.parseUnits(amountStr, selectedToken.decimals);
  const durationSecs = durationHours * 3600;

  try {
    // Pre-flight: the vault allows only ONE active lock per wallet per token
    // (activeLockId[wallet][token]). A second lock reverts with
    // ActiveLockExists(id), which the wallet surfaces as an opaque
    // UNPREDICTABLE_GAS_LIMIT. Catch it here and tell the user plainly.
    const vaultRead = new ethers.Contract(ADDRESSES.TimbLockVault, LOCKVAULT_ABI, readProv());
    const existing = await vaultRead.getActiveLock(userAddress, selectedToken.address);
    if (!existing.lockId.isZero() && Number(existing.status) === 0 /* Active */) {
      btn.textContent = `Active ${selectedToken.symbol} lock #${existing.lockId.toString()} — withdraw first`;
      setTimeout(() => { btn.textContent = `Lock ${selectedToken.symbol}`; btn.disabled = false; }, 3400);
      return;
    }

    // Approve if needed. Read the allowance from the public RPC (not the
    // wallet's in-app provider, which can return "header not found" mid-sync).
    const ercRead = new ethers.Contract(selectedToken.address, ERC20_ABI, readProv());
    const erc = new ethers.Contract(selectedToken.address, ERC20_ABI, signer);
    const allowance = await ercRead.allowance(userAddress, ADDRESSES.TimbLockVault);
    if (allowance.lt(amountWei)) {
      btn.disabled = true;
      btn.textContent = "Approving…";
      DebugHub.logCheckpoint("Lock:Approve Requested", "pass");
      const gas = await getGasParams();
      const nonce = await getPendingNonce();
      const approveTx = await erc.approve(ADDRESSES.TimbLockVault, ethers.constants.MaxUint256, { ...gas, nonce });
      DebugHub.logCheckpoint("Lock:Approve Submitted", "pass");
      await confirmTx(approveTx);
      DebugHub.logCheckpoint("Lock:Approve Confirmed", "pass");
    }

    btn.textContent = "Locking…";
    DebugHub.logCheckpoint("Lock:Lock Requested", "pass");
    const vault = new ethers.Contract(ADDRESSES.TimbLockVault, LOCKVAULT_ABI, signer);
    const gas = await getGasParams();
    const nonce = await getPendingNonce();
    const tx = await vault.lock(selectedToken.address, amountWei, durationSecs, { ...gas, nonce });
    DebugHub.logCheckpoint("Lock:Lock Submitted", "pass");
    await confirmTx(tx);
    DebugHub.logCheckpoint("Lock:Lock Confirmed", "pass");

    document.getElementById("lock-amount").value = "";
    btn.textContent = "Locked ✓";
    await Promise.all([loadMyLocks(), loadRegistry()]);
    setTimeout(() => { btn.textContent = `Lock ${selectedToken.symbol}`; btn.disabled = false; }, 2000);

  } catch (err) {
    console.error("Lock failed:", err.message);
    DebugHub.logError("handleCreateLock", err);
    DebugHub.logCheckpoint("Lock:Lock Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = `Lock ${selectedToken.symbol}`; btn.disabled = false; }, 2000);
  }
}

// ─── Withdraw Lock ────────────────────────────────────────────────────────────

async function handleWithdraw(lockId) {
  try {
    DebugHub.logCheckpoint("Lock:Withdraw Requested", "pass");
    const vault = new ethers.Contract(ADDRESSES.TimbLockVault, LOCKVAULT_ABI, signer);
    const gas = await getGasParams();
    const nonce = await getPendingNonce();
    const tx = await vault.withdraw(lockId, { ...gas, nonce });
    DebugHub.logCheckpoint("Lock:Withdraw Submitted", "pass");
    await confirmTx(tx);
    DebugHub.logCheckpoint("Lock:Withdraw Confirmed", "pass");
    await Promise.all([loadMyLocks(), loadRegistry()]);
  } catch (err) {
    console.error("Withdraw failed:", err.message);
    DebugHub.logError("handleWithdraw", err);
    DebugHub.logCheckpoint("Lock:Withdraw Failed", "fail");
    alert("Withdraw failed: " + (err?.reason || err.message));
  }
}

// ─── Render Helpers ───────────────────────────────────────────────────────────

function timeRemaining(unlockAt) {
  const now  = Math.floor(Date.now() / 1000);
  const diff = Number(unlockAt) - now;
  if (diff <= 0) return null; // unlocked
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function tokenSymbolForAddr(addr) {
  const t = whitelistedTokens.find(t => t.address.toLowerCase() === addr.toLowerCase());
  return t ? t.symbol : addr.slice(0, 8) + "…";
}

// Deterministic short public id for a lock — the raw sequential lockId means
// nothing to onlookers, so the public registry shows a stable per-lock code.
function lockPublicId(lock) {
  const seed = (lock.locker.slice(2) + Number(lock.lockId).toString(16)).toLowerCase();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return "LK-" + h.toString(36).toUpperCase().padStart(6, "0").slice(0, 6);
}

// Heavier address mask for the public registry (0x1234…cdef → 0x12…ef).
function fmtAddrMasked(addr) {
  if (!addr) return "";
  return addr.slice(0, 4) + "…" + addr.slice(-2);
}

function renderLockRow(lock, showLocker = false) {
  const sym     = tokenSymbolForAddr(lock.token);
  const logo    = lock.isTimbs ? "T" : sym.charAt(0);
  const rem     = timeRemaining(lock.unlockAt);
  const statusN = LOCK_STATUS[lock.status] || "Unknown";
  const unlocked = rem === null && lock.status === 0; // status 0 = Active but time passed
  const actualStatus = unlocked ? "Unlocked" : statusN;
  const statusClass = "lock-status-" + actualStatus.toLowerCase();
  const canWithdraw = (unlocked || lock.status === 1) && lock.status !== 2;

  // Public registry: opaque id + heavily masked locker. Owner's "My Locks":
  // keep the real lock number since it's their own and useful for support.
  const idLabel    = showLocker ? lockPublicId(lock) : "Lock #" + lock.lockId;
  const lockerHtml = showLocker
    ? `<div class="registry-row-locker">${fmtAddrMasked(lock.locker)}</div>`
    : "";

  // Public rows are tappable → open the detail overlay.
  const rowAttrs = showLocker
    ? ` class="lock-row lock-row-clickable" onclick="openLockDetail(${lock.lockId})"`
    : ` class="lock-row"`;

  return `
    <div${rowAttrs}>
      <div class="lock-row-icon">${logo}</div>
      <div class="lock-row-main">
        <div class="lock-row-amount">
          ${fmt(lock.amount, 18, 4)} ${sym}
          ${lock.isTimbs ? '<span class="timbs-badge">TIMBS</span>' : ""}
        </div>
        <div class="lock-row-meta">
          ${idLabel} · ${rem ? "Unlocks in " + rem : "Ready to withdraw"}
          ${lockerHtml}
        </div>
      </div>
      <span class="lock-row-status ${statusClass}">${actualStatus}</span>
      ${canWithdraw ? `<button class="btn-withdraw-mini" onclick="event.stopPropagation(); handleWithdraw(${lock.lockId})">Withdraw</button>` : ""}
    </div>
  `;
}

// ─── Public lock detail overlay ────────────────────────────────────────────────

function _fmtDateUTC(unixSeconds) {
  const d = new Date(Number(unixSeconds) * 1000);
  if (isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

async function openLockDetail(lockId) {
  const modal = document.getElementById("lock-detail-modal");
  const body  = document.getElementById("lock-detail-body");
  if (!modal || !body) return;
  body.innerHTML = '<div class="empty-state">Loading…</div>';
  modal.classList.remove("hidden");

  try {
    const vault = new ethers.Contract(ADDRESSES.TimbLockVault, LOCKVAULT_ABI, readProv());
    const lock  = await vault.getLock(lockId);
    const erc   = new ethers.Contract(lock.token, ERC20_ABI, readProv());
    const [sym, dec, supply] = await Promise.all([
      erc.symbol().catch(() => "???"),
      erc.decimals().catch(() => 18),
      erc.totalSupply().catch(() => null),
    ]);

    const rem      = timeRemaining(lock.unlockAt);
    const statusN  = LOCK_STATUS[lock.status] || "Unknown";
    const unlocked = rem === null && lock.status === 0;
    const status   = unlocked ? "Unlocked" : statusN;
    const explorer = "https://sepolia.arbiscan.io/token/" + lock.token;

    body.innerHTML = `
      <div class="ld-amount">
        ${fmt(lock.amount, dec, 4)} ${sym}
        ${lock.isTimbs ? '<span class="timbs-badge">TIMBS</span>' : ""}
      </div>
      <div class="ld-row"><span class="ld-key">Lock ID</span><span class="ld-val">${lockPublicId(lock)}</span></div>
      <div class="ld-row"><span class="ld-key">Status</span><span class="ld-val">${status}</span></div>
      <div class="ld-row"><span class="ld-key">Created</span><span class="ld-val">${_fmtDateUTC(lock.lockedAt)}</span></div>
      <div class="ld-row"><span class="ld-key">Unlocks</span><span class="ld-val">${rem ? "in " + rem : "now — withdrawable"}</span></div>
      <div class="ld-row"><span class="ld-key">Token</span><span class="ld-val"><a class="ld-link" href="${explorer}" target="_blank" rel="noopener">${fmtAddrMasked(lock.token)} ↗</a></span></div>
      <div class="ld-row"><span class="ld-key">Total supply</span><span class="ld-val">${supply ? fmt(supply, dec, 0) + " " + sym : "—"}</span></div>
      <div class="ld-row"><span class="ld-key">Locker</span><span class="ld-val">${fmtAddrMasked(lock.locker)}</span></div>
    `;
  } catch (e) {
    console.warn("openLockDetail:", e.message);
    body.innerHTML = '<div class="empty-state">Could not load lock detail</div>';
  }
}

function closeLockDetail(e) {
  if (e && e.target.id !== "lock-detail-modal") return; // only close on backdrop click
  document.getElementById("lock-detail-modal")?.classList.add("hidden");
}
function closeLockDetailDirect() {
  document.getElementById("lock-detail-modal")?.classList.add("hidden");
}

// ─── My Locks ─────────────────────────────────────────────────────────────────

async function loadMyLocks() {
  const list = document.getElementById("my-locks-list");
  if (!userAddress) {
    list.innerHTML = '<div class="empty-state">Connect wallet to view your locks</div>';
    return;
  }

  try {
    const vault = new ethers.Contract(ADDRESSES.TimbLockVault, LOCKVAULT_ABI, readProv());
    const ids   = await vault.getLockerHistory(userAddress);

    if (ids.length === 0) { list.innerHTML = '<div class="empty-state">No locks yet</div>'; return; }

    list.innerHTML = "";
    const recent = [...ids].reverse().slice(0, 8);
    for (const id of recent) {
      try {
        const lock = await vault.getLock(id);
        list.innerHTML += renderLockRow(lock, false);
      } catch {}
    }
  } catch (e) {
    console.warn("loadMyLocks:", e.message);
    list.innerHTML = '<div class="empty-state">Could not load locks</div>';
  }
}

// ─── Public Registry ──────────────────────────────────────────────────────────

async function loadRegistry() {
  const section = document.getElementById("registry-section");
  const list    = document.getElementById("registry-list");
  const countEl = document.getElementById("registry-count");

  // Game/registry visibility is wallet-gated — hide the whole card when the
  // wallet isn't connected so the site shows no game data to onlookers.
  if (!userAddress) { if (section) section.classList.add("hidden"); return; }
  if (section) section.classList.remove("hidden");

  try {
    const vault = new ethers.Contract(ADDRESSES.TimbLockVault, LOCKVAULT_ABI, readProv());
    const total = await vault.totalLocks();
    countEl.textContent = total.toString() + " total locks";

    if (total.eq(0)) { list.innerHTML = '<div class="empty-state">No locks yet</div>'; return; }

    list.innerHTML = "";
    // Show last 10 locks
    const start = Math.max(1, total.toNumber() - 9);
    for (let id = total.toNumber(); id >= start; id--) {
      try {
        const lock = await vault.getLock(id);
        if (lock.locker === ethers.constants.AddressZero) continue;
        list.innerHTML += renderLockRow(lock, true);
      } catch {}
    }
  } catch (e) {
    console.warn("loadRegistry:", e.message);
    list.innerHTML = '<div class="empty-state">Could not load registry</div>';
  }
}

// ─── Wallet Connect ───────────────────────────────────────────────────────────

async function handleConnect() {
  DebugHub.logCheckpoint("Wallet Connect Requested", "pass");
  const ok = await connectWallet();
  if (!ok) { DebugHub.logCheckpoint("Wallet Connect Failed", "fail"); return; }

  DebugHub.startSession();
  DebugHub.logSecurity("Chain Check", "pass");
  DebugHub.logCheckpoint("Wallet Connected", "pass");

  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);

  updateLockButton();
  await Promise.all([refreshLockBalance(), loadMyLocks(), loadRegistry()]);

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
    updateLockButton();
    await Promise.all([refreshLockBalance(), loadMyLocks(), loadRegistry()]);
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  provider = null; signer = null; userAddress = null;
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  updateLockButton();
  refreshLockBalance(); // back to "Balance: —"
  loadMyLocks();
  loadRegistry(); // now hides the public registry card
}

// ─── Input Listeners ──────────────────────────────────────────────────────────

document.getElementById("lock-amount")?.addEventListener("input", updateLockButton);

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  // Auto-reconnect if wallet was connected before navigation
    DebugHub.logCheckpoint("Lock:Page Loaded", "pass");
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _addrEl = document.getElementById("wallet-addr");
    if (_addrEl) _addrEl.textContent = fmtAddr(_reconnected);
    DebugHub.startSession();
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _el = document.getElementById("wallet-addr");
      if (_el) _el.textContent = fmtAddr(newAddr);
      updateLockButton();
      await Promise.all([refreshLockBalance(), loadMyLocks(), loadRegistry()]);
    });
  }

  await loadWhitelistedTokens();
  await loadRegistry();

  // The token list and user data weren't ready during the reconnect above, so
  // refresh the lock button, balance, and "My Locks" now that they've loaded —
  // otherwise the button reads "Connect wallet to lock" and My Locks stays empty
  // even though the wallet is connected.
  if (_reconnected) {
    updateLockButton();
    await Promise.all([refreshLockBalance(), loadMyLocks()]);
  }
})();
