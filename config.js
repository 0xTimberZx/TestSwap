// frontend/config.js
// Single source of truth for all contract addresses, chain config,
// and shared ethers setup. Every page imports from here.

// ─── Chain ───────────────────────────────────────────────────────────────────

const CHAIN_ID   = 421614;
const CHAIN_NAME = "Arbitrum Sepolia";
const RPC_URL    = "https://sepolia-rollup.arbitrum.io/rpc";

const CHAIN_CONFIG = {
  chainId:   "0x" + CHAIN_ID.toString(16),
  chainName: CHAIN_NAME,
  nativeCurrency: { name: "Ethereum", symbol: "ETH", decimals: 18 },
  rpcUrls:        [RPC_URL],
  blockExplorerUrls: ["https://sepolia.arbiscan.io"]
};

// ─── Contract Addresses ───────────────────────────────────────────────────────

const ADDRESSES = {
  PrizeEscrow:          "0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D",
  TIMBSToken:           "0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa",
  TimbSwapFactory:      "0xCCd6d3f0A86042d2B7056eDd381d367126628AF5",
  TimbSwapRouter:       "0xF554063223ECE3acC4f9664227Ba1E7a88c54e09",
  EligibleTokenRegistry:"0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04",
  GameRegistry:         "0xee2c3b12e8dED226a6AE8e950e5B6C67eF4CB774",
  TimbPrize:            "0xc3fB39E0da3312c7f95bD7aD511ac76C4B86eE40",
  TimbStaking:          "0xe776c7b700B190ED8248741F9b518B08d8733C8F",
  TimbFarm:             "0xE319E2206F71A5cD8dd2c411C6F29712935f9011",
  TimbLockVault:        "0x0157086E7670D1eFb15DC6b5158eE78279927a41",
  TimbYieldVault:       "0x619374B3BfB8E0B23406033e56cF2fCcb36FE57F",
  TimbTreasury:         "0x486Fa4D8351EF81136E83340eA1e3aa2272c9955",
  TimbGovernance:       "0x8a324EfDc457BfB9Cf3D077E4CBC5A16a1c6a061",
  TimbsEthPair:         "0x5a911CBfD2808Ad5214E842a0E8ae34d8199BB95",
  WETH:                 "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
  USDC:                 "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", // Circle canonical (6 decimals)
  LINK:                 "0xb1D4538B4571d411F07960EF2838Ce337FE1E80E", // Chainlink canonical (18 decimals)
  DAPP:                 "0x3d0cB8929c22F93A9dd33921E6f43C1621FCfC04",
};

// ─── Token Default List ───────────────────────────────────────────────────────

const DEFAULT_TOKENS = [
  {
    symbol:  "TIMBS",
    name:    "TimbSwap Token",
    address: ADDRESSES.TIMBSToken,
    decimals: 18,
    logoChar: "T"
  },
  {
    symbol:  "WETH",
    name:    "Wrapped Ether",
    address: ADDRESSES.WETH,
    decimals: 18,
    logoChar: "Ξ"
  },
  {
    symbol:  "USDC",
    name:    "USD Coin",
    address: ADDRESSES.USDC,
    decimals: 6,
    logoChar: "$"
  },
  {
    symbol:  "LINK",
    name:    "Chainlink",
    address: ADDRESSES.LINK,
    decimals: 18,
    logoChar: "L"
  }
];

// ─── Ethers Setup ─────────────────────────────────────────────────────────────

// Loaded from CDN in each HTML page:
// <script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js"></script>

let provider = null;
let signer   = null;
let userAddress = null;

// ─── Injected Provider Selection (Brave-safe) ─────────────────────────────────
// When multiple wallet extensions inject, window.ethereum.providers is an
// array and window.ethereum itself is whichever extension won the injection
// race — requests could go to one wallet while events come from another.
// Prefer Brave Wallet, then MetaMask, then the first injected provider, so
// every request/listener in this file consistently targets the same wallet.
function injectedProvider() {
  const eth = window.ethereum;
  if (!eth) return null;
  if (eth.providers && eth.providers.length) {
    return eth.providers.find((p) => p.isBraveWallet)
        || eth.providers.find((p) => p.isMetaMask)
        || eth.providers[0];
  }
  return eth;
}

// ─── Session Persistence ──────────────────────────────────────────────────────
// Keeps wallet connected across page navigations without re-prompting.
// sessionStorage clears when the browser tab is closed — no stale state.

const SESSION_KEY = "timbswap_wallet";

function _saveSession(address) {
  try { sessionStorage.setItem(SESSION_KEY, address); } catch {}
}

function _clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
}

function _getSavedAddress() {
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}

async function _initProvider() {
  provider    = new ethers.providers.Web3Provider(injectedProvider());
  signer      = provider.getSigner();
  userAddress = await signer.getAddress();
}

async function _ensureChain() {
  const network = await provider.getNetwork();
  if (network.chainId === CHAIN_ID) return;
  try {
    await injectedProvider().request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: CHAIN_CONFIG.chainId }]
    });
  } catch (switchErr) {
    if (switchErr.code === 4902) {
      await injectedProvider().request({
        method: "wallet_addEthereumChain",
        params: [CHAIN_CONFIG]
      });
    } else {
      throw switchErr;
    }
  }
  await _initProvider();
  // Some mobile in-app wallets resolve wallet_switchEthereumChain without
  // actually switching. Verify, and fail the connect loudly instead of
  // letting the session run against the wrong network.
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) {
    DebugHub.logSecurity?.("Chain Check", "fail");
    throw new Error(`Wallet stayed on chain ${net.chainId} — switch to ${CHAIN_NAME} (${CHAIN_ID}) and reconnect.`);
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    alert("No wallet detected. Please use MetaMask or Brave Wallet.");
    return false;
  }
  try {
    // Request account authorization FIRST. _initProvider() calls signer.getAddress(),
    // which throws "unknown account #0" in ethers v5 before any account is authorized —
    // silently failing the whole connect even though the wallet popup succeeded.
    await injectedProvider().request({ method: "eth_requestAccounts" });
    await _initProvider();
    await _ensureChain();
    _saveSession(userAddress);
    return true;
  } catch (err) {
    console.error("connectWallet failed:", err);
    return false;
  }
}

/**
 * Call on every page load to silently reconnect if the user was already
 * connected. Returns the connected address or null.
 * Usage in each page's init:
 *   const addr = await autoReconnect();
 *   if (addr) { showWalletUI(addr); loadUserData(); }
 */
async function autoReconnect() {
  if (!window.ethereum) return null;
  const saved = _getSavedAddress();
  if (!saved) return null;

  try {
    // Check wallet still has the account active (no popup)
    const accounts = await injectedProvider().request({ method: "eth_accounts" });
    if (!accounts || accounts.length === 0) { _clearSession(); return null; }
    if (accounts[0].toLowerCase() !== saved.toLowerCase()) {
      _clearSession(); return null;
    }
    await _initProvider();
    await _ensureChain();
    return userAddress;
  } catch {
    _clearSession();
    return null;
  }
}

function getContract(name, signerOrProvider) {
  const address = ADDRESSES[name];
  if (!address) throw new Error(`Unknown contract: ${name}`);
  // ABI loaded separately per page to avoid loading all ABIs everywhere
  throw new Error(`getContract: load ABI for ${name} before calling`);
}

// ─── Gas Helpers (ecosystem pattern) ─────────────────────────────────────────

async function getGasParams() {
  const feeData = await provider.getFeeData();
  return {
    maxFeePerGas:         feeData.maxFeePerGas.mul(130).div(100),
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas.mul(130).div(100),
  };
}

async function getPendingNonce() {
  return provider.getTransactionCount(userAddress, "pending");
}

// ─── Formatting Helpers ───────────────────────────────────────────────────────

function fmt(wei, decimals = 18, dp = 4) {
  if (!wei) return "0";
  return parseFloat(ethers.utils.formatUnits(wei, decimals)).toFixed(dp);
}

function fmtAddr(address) {
  if (!address) return "";
  return address.slice(0, 6) + "…" + address.slice(-4);
}

function fmtETH(wei, dp = 4) {
  return fmt(wei, 18, dp) + " ETH";
}

function fmtTIMBS(wei, dp = 2) {
  return fmt(wei, 18, dp) + " TIMBS";
}

// bytes6 → readable string (e.g. 0x414243 → "ABC")
function fmtBytes6(bytes6) {
  if (!bytes6 || bytes6 === "0x000000000000") return "——";
  try {
    return ethers.utils.toUtf8String(bytes6).replace(/\0/g, "");
  } catch {
    // fallback: manual hex decode
    const hex = bytes6.replace("0x", "");
    let result = "";
    for (let i = 0; i < hex.length; i += 2) {
      const code = parseInt(hex.slice(i, i + 2), 16);
      if (code > 0) result += String.fromCharCode(code);
    }
    return result;
  }
}

// ─── Account Switch / Disconnect Listeners ────────────────────────────────────

// Any accountsChanged event — whether the wallet was disconnected or the
// user picked a different account — ends the session instead of silently
// carrying on under the new address. Acting on a wallet swap without an
// explicit reconnect risks running the old page state (approvals, pending
// tx context) against the wrong account, so we always require a fresh
// Connect Wallet click afterward.
let _walletListenersBound = false;

function listenForAccountChanges(onChangeCallback) {
  const eth = injectedProvider();
  // Bind once — a second call (re-connect, re-init) would stack a duplicate
  // accountsChanged handler and fire session teardown twice per event.
  if (!eth || _walletListenersBound) return;
  _walletListenersBound = true;
  eth.on("accountsChanged", async () => {
    provider    = null;
    signer      = null;
    userAddress = null;
    _clearSession();
    if (onChangeCallback) onChangeCallback(null);
  });
  eth.on("chainChanged", () => window.location.reload());
}

// Prompts the wallet's own account picker. MetaMask pops one straight
// from wallet_requestPermissions, but Brave Wallet resolves that call
// silently when the site already holds the eth_accounts permission — no
// popup, so "Switch Account" looked dead in Brave. Revoking the permission
// first (wallet_revokePermissions, EIP-2255) forces the wallet to show its
// connect/account picker on the next request. The revoke also fires
// accountsChanged, so the listener above ends the session immediately —
// by design, attempting a switch always ends the session and requires a
// fresh Connect Wallet, even if the picker is then cancelled.
async function handleSwitchAccount() {
  const eth = injectedProvider();
  if (!eth) return;
  try {
    try {
      await eth.request({
        method: "wallet_revokePermissions",
        params: [{ eth_accounts: {} }]
      });
    } catch (revokeErr) {
      // Wallet predates wallet_revokePermissions — requestPermissions
      // below still pops a picker on MetaMask-style wallets.
      console.warn("wallet_revokePermissions unavailable:", revokeErr?.message);
    }
    await eth.request({
      method: "wallet_requestPermissions",
      params: [{ eth_accounts: {} }]
    });
  } catch (err) {
    console.error("Switch account request failed:", err);
    alert("Switch accounts from your wallet extension, then reconnect.");
  }
}

// ─── Theme (dark default, light optional) ─────────────────────────────────────
// The palette lives in CSS variables; data-theme="light" on <html> swaps it.
// An inline snippet in each page's <head> applies the saved theme before
// first paint (no dark flash); this section owns the toggle + button label.

const THEME_KEY = "timbswap_theme";

function _currentTheme() {
  try { return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; }
  catch { return "dark"; }
}

function _applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = document.getElementById("theme-toggle");
  if (btn) btn.textContent = theme === "light" ? "Dark Mode" : "Light Mode";
}

function toggleTheme() {
  const next = _currentTheme() === "light" ? "dark" : "light";
  try { localStorage.setItem(THEME_KEY, next); } catch {}
  _applyTheme(next);
}

// Sync the attribute + button label on load (config.js runs after the DOM).
_applyTheme(_currentTheme());

// ─── DebugHub Stub ────────────────────────────────────────────────────────────
// Loaded by SDK script tag in each page. Fallback stub defined here
// so DebugHub never breaks TimbSwap if the SDK fails to load.

window.DEBUGHUB_CONFIG = { appName: "TimbSwap" };

if (!window.DebugHub) {
  window.DebugHub = {
    startSession:  () => {},
    endSession:    () => {},
    logCheckpoint: () => {},
    logError:      () => {},
    logPerf:       () => {},
    logSecurity:   () => {}
  };
}

// ─── Ecosystem log export (ungated) ────────────────────────────────────────────
// Grab every DebugHub event this browser holds for the 0xTimberZx ecosystem and
// download it as one sorted file — no wallet, no debugger dashboard. Every app
// lives on the same origin (0xtimberzx.github.io), so they share one
// localStorage; this reads whatever the SDK persisted there (plus any in-memory
// buffer the live SDK exposes), independent of the exact storage key.

function _dhLooksLikeEvent(o) {
  return o && typeof o === "object" && !Array.isArray(o) &&
    "timestamp" in o && ("type" in o || "app" in o || "sessionId" in o);
}

function _dhCollectEvents() {
  const out = [];
  const push = (arr) => { if (Array.isArray(arr)) for (const e of arr) if (_dhLooksLikeEvent(e)) out.push(e); };
  try {
    const dh = window.DebugHub || {};
    ["getEvents", "getLogs", "export", "dump"].forEach(k => {
      if (typeof dh[k] === "function") { try { push(dh[k]()); } catch {} }
    });
    ["events", "_events", "buffer", "_buffer", "log", "_log"].forEach(k => push(dh[k]));
  } catch {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      let val;
      try { val = JSON.parse(localStorage.getItem(localStorage.key(i))); } catch { continue; }
      if (Array.isArray(val)) push(val);
      else if (val && typeof val === "object") Object.values(val).forEach(v => push(v));
    }
  } catch {}
  const seen = new Set(), uniq = [];
  for (const e of out) {
    const sig = [e.timestamp, e.type, e.sessionId, e.name, e.label, e.function, e.message].join("|");
    if (seen.has(sig)) continue;
    seen.add(sig); uniq.push(e);
  }
  uniq.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
  return uniq;
}

function exportEcosystemDebugLogs() {
  const events = _dhCollectEvents();
  if (!events.length) {
    alert("No DebugHub logs found in this browser for the ecosystem. Use the apps first so the SDK records events, then export.");
    return;
  }
  const byApp = {};
  for (const e of events) (byApp[e.app || "unknown"] ||= []).push(e);
  const payload = {
    exportedAt: new Date().toISOString(),
    origin: location.origin,
    totalEvents: events.length,
    appCounts: Object.fromEntries(Object.entries(byApp).map(([a, ev]) => [a, ev.length])),
    byApp,
    all: events
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = `debughub-ecosystem-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
