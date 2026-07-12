// ─── Hero headline rotator ────────────────────────────────────────────────────
// "Trade and Earn" holds 3s, "Play and Win" holds 5s (the gold one lingers).
// CSS cross-fades the swap; both lines share one grid cell so nothing shifts.
(function rotateHero() {
  const a = document.getElementById("rot-a");
  const b = document.getElementById("rot-b");
  if (!a || !b) return;
  let showA = true;
  const tick = () => {
    showA = !showA;
    a.classList.toggle("rot-on", showA);
    b.classList.toggle("rot-on", !showA);
    setTimeout(tick, showA ? 3000 : 5000);
  };
  setTimeout(tick, 3000); // first phrase holds its 3s, then the cycle runs
})();

// landing.js — chain reads for landing page stats + live scroll display

const TIMBPRIZE_ABI   = [
  "function getRoundState() external view returns (uint256 round, uint256 segment, uint256 segmentStart, uint256 counter, bytes6 currentWindow, uint256 pot, uint256 unclaimedPool, bool inSettlement)",
  "function gameStarted() external view returns (bool)"
];
const TIMBS_ABI       = ["function totalSupply() external view returns (uint256)"];
const STAKING_ABI     = ["function totalStaked() external view returns (uint256)"];
const FARM_ABI        = ["function totalStaked() external view returns (uint256)"];
const LOCKVAULT_ABI   = ["function totalLocks() external view returns (uint256)"];
const ESCROW_ABI      = ["function balance() external view returns (uint256)"];
const VAULT_ABI       = ["function reserve() external view returns (uint256)"];
const FACTORY_ABI     = ["function getPairAddress(address,address) external view returns (address)"];
const PAIR_ABI        = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)"
];

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

// ─── Read-only provider (no wallet needed for stats) ─────────────────────────

const readProvider = new ethers.providers.JsonRpcProvider(RPC_URL);

function readContract(name, abi) {
  return new ethers.Contract(ADDRESSES[name], abi, readProvider);
}

// ─── Scroll display ──────────────────────────────────────────────────────────

function renderWindow(windowBytes6) {
  try {
    const hex = windowBytes6.replace("0x", "");
    for (let i = 0; i < 6; i++) {
      const code = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      const el = document.getElementById("c" + i);
      if (el) {
        el.textContent = code > 0 ? String.fromCharCode(code) : "·";
        el.classList.toggle("dim", code === 0);
      }
    }
  } catch (e) {
    console.warn("renderWindow:", e.message);
  }
}

let maskTimer = null;
let maskIndex = 0;
function startMask() {
  if (maskTimer) return;
  // Seed every cell once so nothing reads as an empty slot while masked.
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById("c" + i);
    if (!el) continue;
    el.textContent = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    el.classList.remove("dim");
    el.classList.add("masked");
  }
  // Drift one cell at a time on a calmer cadence so the decoy string
  // re-scrambles gently rather than flickering all six positions at once.
  maskTimer = setInterval(() => {
    const el = document.getElementById("c" + maskIndex);
    if (el) {
      el.textContent = ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
      el.classList.add("masked");
    }
    maskIndex = (maskIndex + 1) % 6;
  }, 220);
}
function stopMask() {
  if (maskTimer) { clearInterval(maskTimer); maskTimer = null; }
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById("c" + i);
    if (el) { el.classList.remove("masked"); el.style.opacity = ""; }
  }
}

let lastCounter = null;
let lastSegment = null;

// ─── "Up for Grabs" total: prize pot + vault backing, in ETH ⇄ USD ───────────
// The headline figure is pot (live prize) + the yield vault's reserve (the ETH
// backing future pot growth). It rotates between the ETH total and its USD
// worth, priced off the on-chain USDC/WETH pool (no external API).

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
let _usdPerEth = null;

async function refreshEthPrice() {
  try {
    const factory = readContract("TimbSwapFactory", FACTORY_ABI);
    const pairAddr = await factory.getPairAddress(ADDRESSES.USDC, ADDRESSES.WETH);
    if (!pairAddr || pairAddr === ZERO_ADDR) return;
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, readProvider);
    const [r, t0] = await Promise.all([pair.getReserves(), pair.token0()]);
    const usdcIs0 = t0.toLowerCase() === ADDRESSES.USDC.toLowerCase();
    const usdc = parseFloat(ethers.utils.formatUnits(usdcIs0 ? r.reserve0 : r.reserve1, 6));
    const weth = parseFloat(ethers.utils.formatUnits(usdcIs0 ? r.reserve1 : r.reserve0, 18));
    if (usdc > 0 && weth > 0) _usdPerEth = usdc / weth;
  } catch (e) {
    console.warn("refreshEthPrice:", e.message);
  }
}

function fmtUsd(v) {
  const dp = v >= 100 ? 0 : v >= 1 ? 2 : 4;
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

let _potEth  = "loading…";   // e.g. "1.2345 ETH"
let _potUsd  = null;          // e.g. "$3,210" or null when unpriceable
let _showUsd = false;
let _potRotTimer = null;

// Render the current value on both targets. withFade is for the ETH⇄USD swap;
// a plain refresh of the number (same phase) updates in place, no blink.
function renderPot(withFade) {
  const useUsd = _showUsd && _potUsd !== null;
  const txt = useUsd ? _potUsd : _potEth;
  [document.getElementById("scroll-pot-val"), document.getElementById("stat-pot")].forEach(el => {
    if (!el) return;
    el.classList.add("pot-val");
    const apply = () => {
      el.textContent = txt;
      el.classList.toggle("val-usd", useUsd);
      el.classList.remove("fading");
    };
    if (withFade) { el.classList.add("fading"); setTimeout(apply, 350); }
    else          { apply(); }
  });
}

function setPotTotal(totalWei) {
  _potEth = fmtETH(totalWei);   // fmtETH already appends " ETH"
  _potUsd = _usdPerEth !== null
    ? fmtUsd(parseFloat(ethers.utils.formatEther(totalWei)) * _usdPerEth)
    : null;
  if (_potUsd === null) _showUsd = false;   // never strand on a blank USD phase
  renderPot(false);                          // reflect the fresh number at once
  if (!_potRotTimer) {
    _potRotTimer = setInterval(() => {
      if (_potUsd === null) return;          // unpriceable → hold on ETH, no blink
      _showUsd = !_showUsd;
      renderPot(true);
    }, 4000);
  }
}

async function updateScroll() {
  try {
    const prize = readContract("TimbPrize", TIMBPRIZE_ABI);
    const started = await prize.gameStarted();
    if (!started) return;

    const state = await prize.getRoundState();
    const { round, counter, currentWindow, pot } = state;

    // Flash chars on counter change
    if (!userAddress) {
      startMask();
    } else {
      stopMask();
      if (lastCounter !== null && counter.toString() !== lastCounter) {
        document.querySelectorAll(".scroll-char").forEach(el => {
          el.style.borderColor = "var(--green)";
          setTimeout(() => el.style.borderColor = "", 400);
        });
      }
      lastCounter = counter.toString();
      renderWindow(currentWindow);
    }

    const roundEl = document.getElementById("scroll-round");
    if (roundEl) roundEl.textContent = `Round ${round}`;

    // "Up for Grabs" = live pot + the vault's ETH reserve backing it. Vault read
    // is best-effort — an unfunded/unreachable vault just leaves the pot alone.
    let total = pot;
    try {
      const reserve = await readContract("TimbYieldVault", VAULT_ABI).reserve();
      total = pot.add(reserve);
    } catch (e) { /* backing unavailable → show pot only */ }

    setPotTotal(total);

  } catch (e) {
    console.warn("updateScroll:", e.message);
  }
}

// ─── Stats bar ───────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const [supply, staked, lpStaked, locks] = await Promise.all([
      readContract("TIMBSToken", TIMBS_ABI).totalSupply(),
      readContract("TimbStaking", STAKING_ABI).totalStaked(),
      readContract("TimbFarm", FARM_ABI).totalStaked(),
      readContract("TimbLockVault", LOCKVAULT_ABI).totalLocks(),
    ]);

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    set("stat-supply", fmtTIMBS(supply, 0));
    set("stat-staked", fmtTIMBS(staked, 2));
    set("stat-lp",     fmt(lpStaked, 18, 4) + " LP");
    set("stat-locks",  locks.toString());
  } catch (e) {
    console.warn("loadStats:", e.message);
  }
}

// ─── Wallet connect ──────────────────────────────────────────────────────────

async function handleConnect() {
  DebugHub.logCheckpoint("Wallet Connect Requested", "pass");
  const ok = await connectWallet();
  if (!ok) {
    DebugHub.logCheckpoint("Wallet Connect Failed", "fail");
    return;
  }

  DebugHub.startSession(userAddress);
  DebugHub.logSecurity("Chain Check", "pass");
  DebugHub.logCheckpoint("Wallet Connected", "pass");

  document.getElementById("connect-btn").classList.add("hidden");
  document.getElementById("wallet-info").classList.remove("hidden");
  document.getElementById("network-badge").classList.remove("hidden");
  document.getElementById("wallet-addr").textContent = fmtAddr(userAddress);
  stopMask();
  updateScroll();

  listenForAccountChanges((newAddr) => {
    if (!newAddr) {
      handleDisconnect();
    } else {
      document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
      DebugHub.endSession();
      DebugHub.startSession(newAddr);
    }
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  provider    = null;
  signer      = null;
  userAddress = null;
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  startMask();
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  // Auto-reconnect if wallet was connected before navigation
    DebugHub.logCheckpoint("Landing:Page Loaded", "pass");
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _addrEl = document.getElementById("wallet-addr");
    if (_addrEl) _addrEl.textContent = fmtAddr(_reconnected);
    DebugHub.startSession(_reconnected);
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _el = document.getElementById("wallet-addr");
      if (_el) _el.textContent = fmtAddr(newAddr);
    });
  } else {
    startMask();
  }

  // Load static stats once
  await loadStats();

  // Price ETH once up front (for the USD rotation), then refresh occasionally.
  await refreshEthPrice();
  setInterval(refreshEthPrice, 60000);  // reserves drift slowly — 60s is plenty

  // Start scroll polling immediately — no wallet needed
  await updateScroll();
  setInterval(updateScroll, 3000);  // poll every 3s
})();
