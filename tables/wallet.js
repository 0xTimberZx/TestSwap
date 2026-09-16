// tables/wallet.js — wallet acquisition for the SwapTables pages (ethers v6,
// module scripts). The rest of the site runs ethers v5 through config.js; these
// pages keep their own v6 contracts but borrow config.js's CONNECT machinery:
// the method chooser, "Continue with email" (Privy embedded wallet + confirm
// sheet), the per-tab session, and the 360-minute idle timeout.
//
// config.js must be loaded as a classic script before this module (each page
// does that with the same document.write line the other pages use). Its
// top-level functions and `let`s (userAddress, _pickConnectMethod, …) are
// global-lexical, so a module can call and assign them by name.
//
// Contract: acquireWallet() returns { eip, method } where `eip` is an EIP-1193
// provider (window.ethereum, or the guarded Privy provider) that
// `new ethers.BrowserProvider(eip)` wraps unchanged.

function haveConfig() { return typeof _pickConnectMethod === "function"; }

/** Interactive connect (user tapped the button). null = cancelled / nothing to connect with. */
export async function acquireWallet({ silent = false } = {}) {
  if (!haveConfig()) {
    // config.js missing: behave exactly like the old page.
    return window.ethereum ? { eip: window.ethereum, method: "injected" } : null;
  }
  if (silent) return restoreWallet();

  const method = await _pickConnectMethod();
  if (!method) return null;
  if (method === "email") {
    if (!(await _loadEmailLogin())) throw new Error("Email sign-in is not available right now.");
    const w = await window.TimbEmailWallet.login();
    if (!w) return null;
    return { eip: w.provider, method };
  }
  if (!window.ethereum) return null;
  return { eip: window.ethereum, method };
}

/** Silent restore on page load from the saved per-tab session. No popups, no sheet. */
async function restoreWallet() {
  const saved = _getSavedAddress();
  if (!saved) return null;
  if (_idleExpired()) { _endSession(true); return null; }
  if (_idleFor() === 0) _touchActivity();
  if (_getSessionKind() === "email") {
    if (!window.PRIVY_APP_ID || !(await _loadEmailLogin())) { _clearSession(); return null; }
    const p = await window.TimbEmailWallet.restore();
    if (!p) { _clearSession(); return null; }
    return { eip: p, method: "email" };
  }
  if (!window.ethereum) return null;
  try {
    const accts = await window.ethereum.request({ method: "eth_accounts" });
    if (!accts || !accts.length || String(accts[0]).toLowerCase() !== saved.toLowerCase()) return null;
  } catch (_e) { return null; }
  return { eip: window.ethereum, method: "injected" };
}

/** After a successful connect: persist the session and start the idle clock. */
export function recordSession(address, method) {
  if (!haveConfig()) return;
  _saveSession(address, method);
  userAddress = address; // config.js's idle check + wallet-chip copy read this
}

/** Manual disconnect from a tables page (mirrors config.js's Disconnect). */
export function endSession() {
  if (haveConfig()) disconnectWallet();
}

/**
 * Teach the email-wallet confirm sheet about this page's contracts, so a
 * SwapTables call reads "Join table · SwapTables board" instead of
 * "Contract call 0x… · 0xB2D1…". `contracts` are ethers v6 Contract objects;
 * `names` maps address → label.
 */
export async function registerCalls(contracts, names) {
  if (!haveConfig() || !window.PRIVY_APP_ID) return;
  if (!(await _loadEmailLogin())) return;
  const calls = [];
  for (const c of contracts || []) {
    try {
      c.interface.forEachFunction((f) => {
        if (f.stateMutability === "view" || f.stateMutability === "pure") return;
        calls.push({ selector: f.selector, label: prettify(f.name) });
      });
    } catch (_e) {}
  }
  try { window.TimbEmailWallet.registerCalls(calls); } catch (_e) {}
  try { window.TimbEmailWallet.registerContracts(names || {}); } catch (_e) {}
}

function prettify(name) {
  const words = String(name).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
