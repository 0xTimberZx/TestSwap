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
  if (_idleExpired()) { _endSession(); return null; }
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
  mountChipActions(document.getElementById("acct"), address);
}

/** Manual disconnect from a tables page (mirrors config.js's Disconnect). */
export async function endSession() {
  if (!haveConfig()) return;
  const wasEmail = _getSessionKind() === "email";
  disconnectWallet();
  // config.js fires the Privy logout without awaiting it; wait for it here so
  // a reload right after can't cut it short.
  if (wasEmail && window.TimbEmailWallet) { try { await window.TimbEmailWallet.logout(); } catch (_e) {} }
}

// ── Wallet chip actions ───────────────────────────────────────────────────────
// The tables pages have no wallet dropdown. Tapping the connected chip (#acct)
// reveals two icon buttons beside it for 10 seconds: copy the address, and
// disconnect the session (reloads to the gated view). Tapping again restarts
// the 10 s; tapping the chip while they are shown hides them.
const CHIP_HIDE_MS = 10000;
const CHIP_CSS = `
.wchip-actions{display:inline-flex;gap:8px;margin-left:10px;vertical-align:middle;align-items:center}
.wchip-actions.hidden{display:none !important}
.wchip-btn{width:34px;height:34px;border-radius:50%;border:1px solid var(--gold-dim,#a98a34);background:rgba(0,0,0,.28);
  color:var(--gold,#d7b34c);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;
  font:600 11px/1 Georgia,serif;transition:background .15s,color .15s}
.wchip-btn:hover{background:rgba(215,179,76,.16)}
.wchip-btn svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.wchip-btn.done{color:#3ecf8e;border-color:#3ecf8e}
.wchip-btn.danger:hover{color:#ff6b6b;border-color:#ff6b6b}
`;
const ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const ICON_OFF  = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v9"/><path d="M6.3 6.3a8 8 0 1 0 11.4 0"/></svg>';

let _chipTimer = null;
function mountChipActions(chip, address) {
  if (!chip || !address) return;
  if (!document.getElementById("wchip-style")) {
    const st = document.createElement("style"); st.id = "wchip-style"; st.textContent = CHIP_CSS; document.head.appendChild(st);
  }
  let box = document.getElementById("wchip-actions");
  if (!box) {
    box = document.createElement("span");
    box.id = "wchip-actions"; box.className = "wchip-actions hidden"; box.setAttribute("role", "group"); box.setAttribute("aria-label", "Wallet actions");
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "wchip-btn"; copy.title = "Copy address"; copy.setAttribute("aria-label", "Copy address"); copy.innerHTML = ICON_COPY;
    copy.addEventListener("click", async (e) => {
      e.stopPropagation();
      const ok = await copyText(box.dataset.address);
      copy.classList.add("done"); copy.textContent = ok ? "OK" : "✕"; copy.title = ok ? "Copied" : "Copy failed";
      setTimeout(() => { copy.classList.remove("done"); copy.innerHTML = ICON_COPY; copy.title = "Copy address"; }, 1200);
      armHide();
    });
    const off = document.createElement("button");
    off.type = "button"; off.className = "wchip-btn danger"; off.title = "Disconnect"; off.setAttribute("aria-label", "Disconnect"); off.innerHTML = ICON_OFF;
    off.addEventListener("click", async (e) => {
      e.stopPropagation();
      off.disabled = true;
      await endSession();
      window.location.reload();
    });
    box.append(copy, off);
    chip.insertAdjacentElement("afterend", box);
    chip.style.cursor = "pointer";
    chip.setAttribute("title", "Tap for copy / disconnect");
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      if (box.classList.contains("hidden")) { box.classList.remove("hidden"); armHide(); }
      else { box.classList.add("hidden"); clearTimeout(_chipTimer); }
    });
  }
  box.dataset.address = address;
  function armHide() { clearTimeout(_chipTimer); _chipTimer = setTimeout(() => box.classList.add("hidden"), CHIP_HIDE_MS); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (_e) {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand("copy"); ta.remove(); return ok;
  } catch (_e) { return false; }
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
