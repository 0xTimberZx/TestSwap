// swap.js — TimbSwap swap page logic

const ROUTER_ABI   = [
  "function getReserves(address tokenA, address tokenB) external view returns (uint256 reserveA, uint256 reserveB)",
  "function getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256)",
  "function getAmountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) external pure returns (uint256)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address tokenIn, address tokenOut, address to, uint256 deadline, bool influencePrize) external returns (uint256 amountOut)",
  "function swapExactETHForTokens(uint256 amountIn, uint256 amountOutMin, address tokenOut, address to, uint256 deadline, bool influencePrize) external payable returns (uint256 amountOut)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address tokenIn, address to, uint256 deadline, bool influencePrize) external returns (uint256 amountOut)",
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256, uint256, uint256)",
  "function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) external returns (uint256, uint256)"
];
const WETH_ABI = [
  "function deposit() external payable",
  "function withdraw(uint256 amount) external"
];
const FACTORY_ABI = [
  "function getPairAddress(address tokenA, address tokenB) external view returns (address)",
  "function createPair(address tokenA, address tokenB) external returns (address pair)"
];
const ERC20_ABI     = [
  "function balanceOf(address account) external view returns (uint256)",
  "function totalSupply() external view returns (uint256)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function decimals() external view returns (uint8)",
  "function symbol() external view returns (string)",
  "function name() external view returns (string)"
];
const ELIGIBLE_ABI  = ["function isEligible(address token) external view returns (bool)"];

// ─── State ────────────────────────────────────────────────────────────────────

let tokenIn   = null;
let tokenOut  = null;
let pickerTarget = null;
let slippagePct  = 1;
let isEligiblePair = false;
let lastEditedSide = "in"; // "in" | "out" — tracks which field user typed in
let mode          = "swap"; // "swap" | "liquidity"
let removePct     = 0;      // selected % for remove-liquidity
let lpPairAddress = null;   // cached LP pair address for the current pair
let lpBalanceWei  = null;   // cached LP balance for the connected wallet

// Trim a formatUnits string for display: keep the whole part, cap the fraction
// at 8 places, drop trailing zeros. Avoids the ~20-decimal quote readouts.
function trimAmount(weiStr) {
  if (weiStr == null || weiStr === "") return "";
  const [intPart, frac = ""] = String(weiStr).split(".");
  if (!frac) return intPart;
  const trimmed = (intPart + "." + frac.slice(0, 8)).replace(/\.?0+$/, "");
  return trimmed === "" ? "0" : trimmed;
}

// ─── Native ETH support ───────────────────────────────────────────────────────
// ETH is a swap-page-local pseudo-token (not in DEFAULT_TOKENS, so other pages
// never see it). ETH↔WETH is a 1:1 wrap/unwrap on the WETH contract — no pool,
// no fee, no slippage. ETH↔token routes through the WETH pool via the router's
// swapExactETHForTokens / swapExactTokensForETH.

const NATIVE_ETH = {
  symbol: "ETH", name: "Ether (native)", address: "native",
  decimals: 18, logoChar: "Ξ", isNative: true
};

// Known extra tokens on Arbitrum Sepolia beyond the shared DEFAULT_TOKENS.
// LINK address is Chainlink's documented Arbitrum Sepolia token — the picker
// shows live on-chain symbol/balance, so a wrong address is immediately visible.
const EXTRA_TOKENS = [
  { symbol: "LINK", name: "Chainlink", address: "0xb1D4538B4571d411F07960EF2838Ce337FE1E80E", decimals: 18, logoChar: "L" }
];

// Custom tokens the user imported by pasting an address (persisted per-browser).
const CUSTOM_TOKENS_KEY = "timbswap_custom_tokens";
function loadCustomTokens() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_TOKENS_KEY)) || []; } catch { return []; }
}
function saveCustomTokens() {
  try { localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(customTokens)); } catch {}
}
let customTokens = loadCustomTokens();

function allTokens() { return [NATIVE_ETH, ...DEFAULT_TOKENS, ...EXTRA_TOKENS, ...customTokens]; }

function isNative(t)  { return !!(t && t.isNative); }
// Address used for pool math/eligibility — native ETH trades as WETH.
function effAddr(t)   { return isNative(t) ? ADDRESSES.WETH : t.address; }
// ETH↔WETH in either direction is a wrap/unwrap, not a pool trade.
function isWrapPair() {
  if (!tokenIn || !tokenOut) return false;
  return (isNative(tokenIn)  && tokenOut.address === ADDRESSES.WETH) ||
         (isNative(tokenOut) && tokenIn.address  === ADDRESSES.WETH);
}

async function tokenBalance(t) {
  if (isNative(t)) return provider.getBalance(userAddress);
  return new ethers.Contract(t.address, ERC20_ABI, provider).balanceOf(userAddress);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

function renderTokenList() {
  const list = document.getElementById("token-list");
  list.innerHTML = "";
  allTokens().forEach(t => {
    const row = document.createElement("div");
    row.className = "token-row";
    row.onclick = () => selectToken(t);
    const removeHtml = t.isCustom
      ? `<button class="token-remove" title="Remove from list" onclick="event.stopPropagation(); removeCustomToken('${t.address}')">✕</button>`
      : "";
    row.innerHTML = `
      <div class="token-logo">${t.logoChar}</div>
      <div class="token-info">
        <div class="token-symbol">${t.symbol}</div>
        <div class="token-name">${t.name}</div>
      </div>
      <div class="token-bal-right" data-addr="${t.address}">—</div>
      ${removeHtml}
    `;
    list.appendChild(row);
  });
  // Empty state so the list never looks broken when a filter matches nothing.
  const empty = document.createElement("div");
  empty.id = "token-list-empty";
  empty.className = "token-list-empty hidden";
  empty.textContent = "No matches — paste a token address (0x…) to import it.";
  list.appendChild(empty);
}

async function filterTokens() {
  const q  = document.getElementById("token-search").value.trim();
  const ql = q.toLowerCase();
  let visible = 0;
  document.querySelectorAll(".token-row:not(#token-import-row)").forEach(row => {
    const show = row.textContent.toLowerCase().includes(ql);
    row.style.display = show ? "flex" : "none";
    if (show) visible++;
  });

  removeImportRow();
  const empty  = document.getElementById("token-list-empty");
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(q);
  const known  = allTokens().some(t => t.address.toLowerCase() === ql);
  if (isAddr && !known) {
    if (empty) empty.classList.add("hidden");
    await offerImport(q);
  } else if (empty) {
    empty.classList.toggle("hidden", visible > 0);
  }
}

// ─── Custom token import ──────────────────────────────────────────────────────
// Pasting an unknown ERC-20 address into the search box looks it up on-chain
// and offers a tap-to-import row; imported tokens persist in localStorage.

let _importSeq = 0;

async function offerImport(addr) {
  const list = document.getElementById("token-list");
  if (!list) return;
  const seq = ++_importSeq;
  const row = document.createElement("div");
  row.className = "token-row token-import-row";
  row.id = "token-import-row";
  row.innerHTML = `
    <div class="token-logo">?</div>
    <div class="token-info">
      <div class="token-symbol">Looking up…</div>
      <div class="token-name">${addr.slice(0, 10)}…${addr.slice(-4)}</div>
    </div>`;
  list.appendChild(row);

  try {
    const c = new ethers.Contract(addr, ERC20_ABI, readProviderForEligibility());
    const [sym, dec, name] = await Promise.all([
      c.symbol(),
      c.decimals(),
      c.name().catch(() => "Custom token"),
    ]);
    if (seq !== _importSeq) return; // superseded by a newer lookup
    const t = {
      symbol: sym, name, address: addr, decimals: Number(dec),
      logoChar: (sym[0] || "?").toUpperCase(), isCustom: true
    };
    row.onclick = () => importCustomToken(t);
    row.querySelector(".token-symbol").textContent = sym;
    row.querySelector(".token-name").textContent   = name + " · tap to import";
  } catch {
    if (seq !== _importSeq) return;
    row.querySelector(".token-symbol").textContent = "Not an ERC-20";
    row.querySelector(".token-name").textContent   = "No token found at this address";
  }
}

function removeImportRow() {
  document.getElementById("token-import-row")?.remove();
}

function importCustomToken(t) {
  customTokens.push(t);
  saveCustomTokens();
  selectToken(t); // selects for the active side and closes the picker
}

function removeCustomToken(addr) {
  customTokens = customTokens.filter(t => t.address.toLowerCase() !== addr.toLowerCase());
  saveCustomTokens();
  renderTokenList();
  refreshPickerBalances();
}

function openTokenPicker(target) {
  pickerTarget = target;
  document.getElementById("token-picker-modal").classList.remove("hidden");
  document.getElementById("token-search").value = "";
  renderTokenList();
  refreshPickerBalances();
}

function closeTokenPicker(e) {
  if (e.target.id === "token-picker-modal") closeTokenPickerDirect();
}
function closeTokenPickerDirect() {
  document.getElementById("token-picker-modal").classList.add("hidden");
}

async function refreshPickerBalances() {
  if (!userAddress) return;
  for (const t of allTokens()) {
    try {
      const bal = await tokenBalance(t);
      const el = document.querySelector(`.token-bal-right[data-addr="${t.address}"]`);
      if (el) el.textContent = fmt(bal, t.decimals, 4);
    } catch {}
  }
}

async function selectToken(token) {
  if (pickerTarget === "in") {
    tokenIn = token;
    document.getElementById("token-in-symbol").textContent = token.symbol;
  } else {
    tokenOut = token;
    document.getElementById("token-out-symbol").textContent = token.symbol;
  }
  closeTokenPickerDirect();
  syncLiquidityLabels();
  if (mode === "liquidity") {
    await refreshLiquidity();
  } else {
    await checkEligibility();
    await refreshBalances();
    await recalcQuote();
  }
}

function flipTokens() {
  [tokenIn, tokenOut] = [tokenOut, tokenIn];
  document.getElementById("token-in-symbol").textContent  = tokenIn  ? tokenIn.symbol  : "Select";
  document.getElementById("token-out-symbol").textContent = tokenOut ? tokenOut.symbol : "Select";
  const inputIn  = document.getElementById("amount-in");
  const inputOut = document.getElementById("amount-out");
  [inputIn.value, inputOut.value] = [inputOut.value, inputIn.value];
  checkEligibility();
  refreshBalances();
  recalcQuote();
}

// ─── Eligibility check — shows/hides influence row + prize panel ────────────

async function checkEligibility() {
  const row   = document.getElementById("influence-row");
  const panel = document.getElementById("prize-panel");

  if (!tokenIn || !tokenOut) {
    row.classList.add("hidden");
    panel.style.display = "none";
    isEligiblePair = false;
    if (window.renderPrizeIndicators) window.renderPrizeIndicators(false);
    return;
  }

  try {
    // Wrap/unwrap never touches a pool or the router, so no influence/nudge.
    if (isWrapPair()) {
      isEligiblePair = false;
      row.classList.add("hidden");
      panel.style.display = "none";
      if (window.renderPrizeIndicators) window.renderPrizeIndicators(false);
      return;
    }
    const registry = new ethers.Contract(ADDRESSES.EligibleTokenRegistry, ELIGIBLE_ABI, readProviderForEligibility());
    const eligible = await registry.isEligible(effAddr(tokenIn));
    isEligiblePair = eligible;
    // Game UI (influence toggle + live prize indicators) is wallet-gated —
    // don't reveal any game state until the user is connected.
    const showGame = eligible && !!userAddress;
    row.classList.toggle("hidden", !showGame);
    panel.style.display = showGame ? "block" : "none";
    if (window.renderPrizeIndicators) window.renderPrizeIndicators(showGame);
  } catch (e) {
    console.warn("checkEligibility:", e.message);
    row.classList.add("hidden");
    panel.style.display = "none";
  }
}

function readProviderForEligibility() {
  return provider || new ethers.providers.JsonRpcProvider(RPC_URL);
}

// ─── Balances ─────────────────────────────────────────────────────────────────

async function refreshBalances() {
  const balIn  = document.getElementById("bal-in");
  const balOut = document.getElementById("bal-out");

  if (!userAddress) {
    balIn.textContent  = "Balance: —";
    balOut.textContent = "Balance: —";
    return;
  }

  try {
    if (tokenIn) {
      const bal = await tokenBalance(tokenIn);
      balIn.textContent = `Balance: ${fmt(bal, tokenIn.decimals, 4)}`;
    }
    if (tokenOut) {
      const bal = await tokenBalance(tokenOut);
      balOut.textContent = `Balance: ${fmt(bal, tokenOut.decimals, 4)}`;
    }
  } catch (e) {
    console.warn("refreshBalances:", e.message);
  }
}

// ─── Quote ────────────────────────────────────────────────────────────────────

async function onAmountInChange() {
  lastEditedSide = "in";
  await recalcQuote();
}
async function onAmountOutChange() {
  lastEditedSide = "out";
  await recalcQuote();
}

async function recalcQuote() {
  const infoBox = document.getElementById("swap-info");
  const swapBtn = document.getElementById("swap-btn");

  if (!tokenIn || !tokenOut) {
    infoBox.classList.add("hidden");
    return;
  }

  const inputIn  = document.getElementById("amount-in");
  const inputOut = document.getElementById("amount-out");
  const readProv = readProviderForEligibility();
  const router   = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, readProv);

  // ETH ↔ WETH is a 1:1 wrap/unwrap — mirror the amount, no pool quote.
  if (isWrapPair()) {
    const src = lastEditedSide === "in" ? inputIn : inputOut;
    const dst = lastEditedSide === "in" ? inputOut : inputIn;
    dst.value = src.value;
    infoBox.classList.add("hidden");
    if (!src.value || parseFloat(src.value) <= 0) { updateSwapButton("Enter an amount"); return; }
    if (!userAddress) { updateSwapButton("Connect wallet to swap"); return; }
    updateSwapButton(isNative(tokenIn) ? "Wrap ETH → WETH" : "Unwrap WETH → ETH");
    return;
  }

  try {
    const [reserveIn, reserveOut] = await router.getReserves(effAddr(tokenIn), effAddr(tokenOut));

    if (reserveIn.eq(0) || reserveOut.eq(0)) {
      infoBox.classList.add("hidden");
      updateSwapButton("No liquidity for this pair");
      return;
    }

    if (lastEditedSide === "in") {
      const amtIn = inputIn.value;
      if (!amtIn || parseFloat(amtIn) <= 0) {
        inputOut.value = "";
        infoBox.classList.add("hidden");
        updateSwapButton("Enter an amount");
        return;
      }
      const amountInWei = ethers.utils.parseUnits(amtIn, tokenIn.decimals);
      const amountOutWei = await router.getAmountOut(amountInWei, reserveIn, reserveOut);
      inputOut.value = trimAmount(ethers.utils.formatUnits(amountOutWei, tokenOut.decimals));
      renderSwapInfo(amountInWei, amountOutWei, reserveIn, reserveOut);
    } else {
      const amtOut = inputOut.value;
      if (!amtOut || parseFloat(amtOut) <= 0) {
        inputIn.value = "";
        infoBox.classList.add("hidden");
        updateSwapButton("Enter an amount");
        return;
      }
      const amountOutWei = ethers.utils.parseUnits(amtOut, tokenOut.decimals);
      const amountInWei  = await router.getAmountIn(amountOutWei, reserveIn, reserveOut);
      inputIn.value = trimAmount(ethers.utils.formatUnits(amountInWei, tokenIn.decimals));
      renderSwapInfo(amountInWei, amountOutWei, reserveIn, reserveOut);
    }

    updateSwapButton(userAddress ? "Swap" : "Connect wallet to swap");

  } catch (e) {
    console.warn("recalcQuote:", e.message);
    infoBox.classList.add("hidden");
    updateSwapButton("Enter an amount");
  }
}

function renderSwapInfo(amountInWei, amountOutWei, reserveIn, reserveOut) {
  const infoBox = document.getElementById("swap-info");
  infoBox.classList.remove("hidden");

  const rate = parseFloat(ethers.utils.formatUnits(amountOutWei, tokenOut.decimals)) /
               parseFloat(ethers.utils.formatUnits(amountInWei, tokenIn.decimals));
  document.getElementById("info-rate").textContent =
    `1 ${tokenIn.symbol} = ${rate.toFixed(6)} ${tokenOut.symbol}`;

  // Price impact estimate: compare execution price to current spot price
  const spotPrice = parseFloat(ethers.utils.formatUnits(reserveOut, tokenOut.decimals)) /
                     parseFloat(ethers.utils.formatUnits(reserveIn, tokenIn.decimals));
  const impact = Math.abs((rate - spotPrice) / spotPrice) * 100;
  const impactEl = document.getElementById("info-impact");
  impactEl.textContent = impact.toFixed(2) + "%";
  impactEl.className = "info-val" + (impact > 5 ? " danger" : impact > 2 ? " warn" : "");

  const feeAmt = amountInWei.mul(5).div(10000);
  document.getElementById("info-fee").textContent =
    fmt(feeAmt, tokenIn.decimals, 6) + " " + tokenIn.symbol;

  const minReceived = amountOutWei.mul(Math.floor((100 - slippagePct) * 100)).div(10000);
  document.getElementById("info-min").textContent =
    fmt(minReceived, tokenOut.decimals, 6) + " " + tokenOut.symbol;
}

function updateSwapButton(text) {
  const btn = document.getElementById("swap-btn");
  btn.textContent = text;
  btn.disabled = !userAddress || !tokenIn || !tokenOut ||
                 text === "Enter an amount" || text === "No liquidity for this pair";
}

// ─── Settings ─────────────────────────────────────────────────────────────────

function toggleSettings() {
  document.getElementById("settings-panel").classList.toggle("hidden");
}

function setSlippage(pct) {
  slippagePct = pct;
  document.querySelectorAll(".slip-btn").forEach(b => b.classList.remove("slip-active"));
  event.target.classList.add("slip-active");
  document.getElementById("slip-custom").value = "";
  recalcQuote();
}

document.getElementById("slip-custom")?.addEventListener("input", (e) => {
  const val = parseFloat(e.target.value);
  if (val > 0 && val <= 50) {
    slippagePct = val;
    document.querySelectorAll(".slip-btn").forEach(b => b.classList.remove("slip-active"));
    recalcQuote();
  }
});

// ─── Swap Execution ───────────────────────────────────────────────────────────

async function handleSwap() {
  if (!userAddress || !tokenIn || !tokenOut) return;

  const amtIn = document.getElementById("amount-in").value;
  if (!amtIn || parseFloat(amtIn) <= 0) return;

  const btn = document.getElementById("swap-btn");
  const originalText = btn.textContent;

  try {
    const amountInWei = ethers.utils.parseUnits(amtIn, tokenIn.decimals);

    // Native ETH never needs an ERC20 approval; wrap pairs skip it too since
    // WETH.deposit/withdraw act on the caller's own balance.
    if (!isNative(tokenIn) && !isWrapPair()) {
      const tokenContract = new ethers.Contract(tokenIn.address, ERC20_ABI, signer);
      const allowance = await tokenContract.allowance(userAddress, ADDRESSES.TimbSwapRouter);
      if (allowance.lt(amountInWei)) {
        btn.disabled = true;
        btn.textContent = "Approving…";
        DebugHub.logCheckpoint("Approve Requested", "pass");

        const gas = await getGasParams();
        const nonce = await getPendingNonce();
        const approveTx = await tokenContract.approve(ADDRESSES.TimbSwapRouter, ethers.constants.MaxUint256, { ...gas, nonce });

        DebugHub.logCheckpoint("Approve Submitted", "pass");
        await approveTx.wait();
        DebugHub.logCheckpoint("Approve Confirmed", "pass");
      }
    }

    // Execute swap
    btn.textContent = "Swapping…";
    DebugHub.logCheckpoint("Swap Requested", "pass");

    const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, signer);
    const amountOutWei = ethers.utils.parseUnits(document.getElementById("amount-out").value, tokenOut.decimals);
    const minOut = amountOutWei.mul(Math.floor((100 - slippagePct) * 100)).div(10000);
    const deadline = Math.floor(Date.now() / 1000) + 1200; // 20 min
    const influencePrize = isEligiblePair && document.getElementById("influence-toggle").checked;

    const gas = await getGasParams();
    const nonce = await getPendingNonce();

    let tx;
    if (isWrapPair()) {
      // 1:1 wrap/unwrap directly on the WETH contract — no pool, no fee.
      const wethC = new ethers.Contract(ADDRESSES.WETH, WETH_ABI, signer);
      btn.textContent = isNative(tokenIn) ? "Wrapping…" : "Unwrapping…";
      tx = isNative(tokenIn)
        ? await wethC.deposit({ ...gas, nonce, value: amountInWei })
        : await wethC.withdraw(amountInWei, { ...gas, nonce });
    } else if (isNative(tokenIn)) {
      // ETH → token: msg.value must cover amountIn plus the 0.05% protocol fee.
      const fee = amountInWei.mul(5).div(10000);
      tx = await router.swapExactETHForTokens(
        amountInWei, minOut, tokenOut.address, userAddress, deadline, influencePrize,
        { ...gas, nonce, value: amountInWei.add(fee) }
      );
    } else if (isNative(tokenOut)) {
      // token → ETH: router swaps to WETH, unwraps, and sends native ETH.
      tx = await router.swapExactTokensForETH(
        amountInWei, minOut, tokenIn.address, userAddress, deadline, influencePrize,
        { ...gas, nonce }
      );
    } else {
      tx = await router.swapExactTokensForTokens(
        amountInWei, minOut, tokenIn.address, tokenOut.address, userAddress, deadline, influencePrize,
        { ...gas, nonce }
      );
    }

    DebugHub.logCheckpoint("Swap Submitted", "pass");
    await tx.wait();
    DebugHub.logCheckpoint("Swap Confirmed", "pass");

    document.getElementById("amount-in").value = "";
    document.getElementById("amount-out").value = "";
    await refreshBalances();
    btn.textContent = "Swap confirmed ✓";
    btn.style.background = "#14f195";
    // Show view tx link
    const txLink = document.getElementById("swap-tx-link");
    if (txLink) {
      txLink.href = `https://sepolia.arbiscan.io/tx/${tx.hash}`;
      txLink.classList.remove("hidden");
    }
    setTimeout(() => {
      updateSwapButton("Swap");
      btn.style.background = "";
      if (txLink) txLink.classList.add("hidden");
    }, 8000);

  } catch (err) {
    const msg = err?.reason || err?.message || String(err);
    console.error("Swap failed:", msg);
    DebugHub.logError("handleSwap", err);
    DebugHub.logCheckpoint("Swap Failed", "fail");
    btn.textContent = "Swap failed — try again";
    btn.style.background = "rgba(239,68,68,0.15)";
    btn.style.color = "#ef4444";
    btn.style.borderColor = "#ef4444";
    setTimeout(() => {
      updateSwapButton(originalText);
      btn.style.background = "";
      btn.style.color = "";
      btn.style.borderColor = "";
    }, 3000);
  } finally {
    btn.disabled = false;
  }
}

// ─── Liquidity (add / remove) ─────────────────────────────────────────────────

function setMode(m) {
  mode = m;
  document.getElementById("tab-swap").classList.toggle("active", m === "swap");
  document.getElementById("tab-liq").classList.toggle("active", m === "liquidity");
  document.getElementById("swap-mode").classList.toggle("hidden", m !== "swap");
  document.getElementById("liquidity-mode").classList.toggle("hidden", m !== "liquidity");
  const title = document.getElementById("swap-title");
  if (title) title.textContent = m === "liquidity" ? "Liquidity" : "Swap";
  if (m === "liquidity") {
    // The influence / prize panel is swap-only.
    const prize = document.getElementById("prize-panel");
    if (prize) prize.style.display = "none";
    refreshLiquidity();
  } else {
    checkEligibility();
  }
}

function syncLiquidityLabels() {
  const a = document.getElementById("lq-symbol-a");
  const b = document.getElementById("lq-symbol-b");
  if (a) a.textContent = tokenIn  ? tokenIn.symbol  : "Select";
  if (b) b.textContent = tokenOut ? tokenOut.symbol : "Select";
}

async function refreshLiquidity() {
  syncLiquidityLabels();
  const balA = document.getElementById("lq-bal-a");
  const balB = document.getElementById("lq-bal-b");
  const ratioEl = document.getElementById("lq-ratio");
  const lpEl = document.getElementById("lq-lp-bal");
  const lpRemoveEl = document.getElementById("lq-remove-bal");
  const wdEl = document.getElementById("lq-withdrawable");
  const read = readProviderForEligibility();

  // Balances
  if (userAddress && tokenIn) {
    try { balA.textContent = `Balance: ${fmt(await tokenBalance(tokenIn), tokenIn.decimals, 4)}`; }
    catch { balA.textContent = "Balance: —"; }
  } else balA.textContent = "Balance: —";
  if (userAddress && tokenOut) {
    try { balB.textContent = `Balance: ${fmt(await tokenBalance(tokenOut), tokenOut.decimals, 4)}`; }
    catch { balB.textContent = "Balance: —"; }
  } else balB.textContent = "Balance: —";

  // Liquidity pools hold WETH, not native ETH — pick WETH for LP positions.
  if (isNative(tokenIn) || isNative(tokenOut)) {
    ratioEl.textContent = "Use WETH (wrap ETH on the Swap tab)";
    lpBalanceWei = null; lpEl.textContent = "—"; lpRemoveEl.textContent = "LP: —";
    if (wdEl) wdEl.textContent = "—";
    updateLqButtons();
    return;
  }

  if (tokenIn && tokenOut) {
    // Pool ratio — keep the reserves around for the withdrawable preview below.
    let rA = null, rB = null;
    try {
      const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, read);
      [rA, rB] = await router.getReserves(tokenIn.address, tokenOut.address);
      if (rA.gt(0) && rB.gt(0)) {
        const ratio = parseFloat(ethers.utils.formatUnits(rB, tokenOut.decimals)) /
                      parseFloat(ethers.utils.formatUnits(rA, tokenIn.decimals));
        ratioEl.textContent = `1 ${tokenIn.symbol} = ${ratio.toFixed(6)} ${tokenOut.symbol}`;
      } else {
        ratioEl.textContent = "New pool — you set the price";
      }
    } catch { ratioEl.textContent = "—"; }

    // LP pair + balance + withdrawable preview. A position is withdrawable
    // whenever the wallet holds LP tokens for this pair — show exactly what
    // removeLiquidity(100%) would return right now: lpBal × reserve ÷ supply,
    // the pair contract's own redemption math.
    try {
      const factory = new ethers.Contract(ADDRESSES.TimbSwapFactory, FACTORY_ABI, read);
      lpPairAddress = await factory.getPairAddress(tokenIn.address, tokenOut.address);
      const pairExists = lpPairAddress && lpPairAddress !== ethers.constants.AddressZero;
      if (pairExists && userAddress) {
        const lp = new ethers.Contract(lpPairAddress, ERC20_ABI, read);
        lpBalanceWei = await lp.balanceOf(userAddress);
        const s = fmt(lpBalanceWei, 18, 6);
        lpEl.textContent = s;
        lpRemoveEl.textContent = "LP: " + s;
        if (wdEl) {
          if (lpBalanceWei.isZero()) {
            wdEl.textContent = "No position";
          } else if (rA && rB && rA.gt(0) && rB.gt(0)) {
            const supply = await lp.totalSupply();
            const outA = lpBalanceWei.mul(rA).div(supply);
            const outB = lpBalanceWei.mul(rB).div(supply);
            wdEl.textContent =
              `✓ ≈ ${fmt(outA, tokenIn.decimals, 4)} ${tokenIn.symbol} + ` +
              `${fmt(outB, tokenOut.decimals, 4)} ${tokenOut.symbol}`;
          } else {
            wdEl.textContent = "✓ Yes";
          }
        }
      } else {
        lpBalanceWei = null; lpEl.textContent = "—"; lpRemoveEl.textContent = "LP: —";
        if (wdEl) wdEl.textContent = !pairExists ? "No pool yet" : "Connect wallet";
      }
    } catch {
      lpBalanceWei = null; lpEl.textContent = "—"; lpRemoveEl.textContent = "LP: —";
      if (wdEl) wdEl.textContent = "—";
    }
  }
  updateLqButtons();
}

// Mirror the counterpart amount from the pool ratio (no-op for a brand-new pool).
async function _mirrorLq(fromId, toId, fromTok, toTok, invert) {
  const v = document.getElementById(fromId).value;
  if (!fromTok || !toTok || !v || parseFloat(v) <= 0) { updateLqButtons(); return; }
  try {
    const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, readProviderForEligibility());
    const [rA, rB] = await router.getReserves(tokenIn.address, tokenOut.address);
    const [rFrom, rTo] = invert ? [rB, rA] : [rA, rB];
    if (rFrom.gt(0) && rTo.gt(0)) {
      const amt = ethers.utils.parseUnits(v, fromTok.decimals).mul(rTo).div(rFrom);
      document.getElementById(toId).value = trimAmount(ethers.utils.formatUnits(amt, toTok.decimals));
    }
  } catch {}
  updateLqButtons();
}
function onLqAmountA() { return _mirrorLq("lq-amount-a", "lq-amount-b", tokenIn, tokenOut, false); }
function onLqAmountB() { return _mirrorLq("lq-amount-b", "lq-amount-a", tokenOut, tokenIn, true); }

function updateLqButtons() {
  const addBtn = document.getElementById("lq-add-btn");
  const remBtn = document.getElementById("lq-remove-btn");
  if (!addBtn || !remBtn) return;

  const a = parseFloat(document.getElementById("lq-amount-a").value);
  const b = parseFloat(document.getElementById("lq-amount-b").value);
  if (!userAddress)               { addBtn.textContent = "Connect wallet to add liquidity"; addBtn.disabled = true; }
  else if (!tokenIn || !tokenOut) { addBtn.textContent = "Select tokens"; addBtn.disabled = true; }
  else if (isNative(tokenIn) || isNative(tokenOut)) { addBtn.textContent = "Use WETH for liquidity"; addBtn.disabled = true; }
  else if (!a || a <= 0 || !b || b <= 0) { addBtn.textContent = "Enter amounts"; addBtn.disabled = true; }
  else { addBtn.textContent = `Add ${tokenIn.symbol} + ${tokenOut.symbol}`; addBtn.disabled = false; }

  const hasLp = lpBalanceWei && !lpBalanceWei.isZero();
  remBtn.disabled = !userAddress || !hasLp || removePct <= 0;
  remBtn.textContent = (hasLp && removePct > 0) ? `Remove ${removePct}%` : "Remove liquidity";
}

function setRemovePct(pct) {
  removePct = pct;
  document.querySelectorAll(".lq-pct-row .slip-btn").forEach(b => b.classList.remove("slip-active"));
  if (typeof event !== "undefined" && event?.target) event.target.classList.add("slip-active");
  updateLqButtons();
}

function showLqTx(hash) {
  const link = document.getElementById("lq-tx-link");
  if (link) { link.href = `https://sepolia.arbiscan.io/tx/${hash}`; link.classList.remove("hidden"); }
}

async function handleAddLiquidity() {
  if (!userAddress || !tokenIn || !tokenOut) return;
  if (isNative(tokenIn) || isNative(tokenOut)) return; // LP positions use WETH
  const aStr = document.getElementById("lq-amount-a").value;
  const bStr = document.getElementById("lq-amount-b").value;
  if (!aStr || !bStr || parseFloat(aStr) <= 0 || parseFloat(bStr) <= 0) return;

  const btn = document.getElementById("lq-add-btn");
  const orig = btn.textContent;
  try {
    btn.disabled = true;
    const amtA = ethers.utils.parseUnits(aStr, tokenIn.decimals);
    const amtB = ethers.utils.parseUnits(bStr, tokenOut.decimals);
    const slip = Math.floor((100 - slippagePct) * 100);
    const aMin = amtA.mul(slip).div(10000);
    const bMin = amtB.mul(slip).div(10000);

    // Approve both tokens to the router if needed.
    for (const [tok, amt] of [[tokenIn, amtA], [tokenOut, amtB]]) {
      const c = new ethers.Contract(tok.address, ERC20_ABI, signer);
      const allow = await c.allowance(userAddress, ADDRESSES.TimbSwapRouter);
      if (allow.lt(amt)) {
        btn.textContent = `Approving ${tok.symbol}…`;
        DebugHub.logCheckpoint("Liquidity Approve Requested", "pass");
        const gas = await getGasParams(); const nonce = await getPendingNonce();
        await (await c.approve(ADDRESSES.TimbSwapRouter, ethers.constants.MaxUint256, { ...gas, nonce })).wait();
      }
    }

    // Router v6 creates a missing pair INSIDE addLiquidity, so go straight
    // to the add — no fragile pre-create step (wallets wrap its estimation
    // reverts as opaque -32603 errors). On failure, decode the revert
    // selector to self-diagnose instead of surfacing wallet noise.
    const SEL_PAIR_NOT_FOUND = "0x4db171d4"; // PairNotFound(addr,addr) — pre-v6 router
    const SEL_CREATE_PAUSED  = "0xaaed1932"; // PairCreationPaused() — factory paused

    const revertSel = (err) => {
      const d = err?.data?.originalError?.data ?? err?.error?.data?.data ??
                err?.error?.data ?? err?.data;
      const hex = typeof d === "string" ? d
        : (typeof d?.data === "string" ? d.data : null);
      if (hex && hex.startsWith("0x") && hex.length >= 10) return hex.slice(0, 10).toLowerCase();
      const m = String(err?.message || "").match(/0x[0-9a-fA-F]{8}/);
      return m ? m[0].toLowerCase() : null;
    };

    const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, signer);
    const sendAdd = async () => {
      const deadline = Math.floor(Date.now() / 1000) + 1200;
      const gas = await getGasParams(); const nonce = await getPendingNonce();
      const t = await router.addLiquidity(tokenIn.address, tokenOut.address, amtA, amtB, aMin, bMin, userAddress, deadline, { ...gas, nonce });
      await t.wait();
      return t;
    };

    btn.textContent = "Adding liquidity…";
    DebugHub.logCheckpoint("Liquidity Add Requested", "pass");
    let tx;
    try {
      tx = await sendAdd();
    } catch (addErr) {
      const sel = revertSel(addErr);
      if (sel) DebugHub.logError("handleAddLiquidity.revertSelector", new Error("selector " + sel));

      if (sel === SEL_CREATE_PAUSED) {
        alert("Pair creation is PAUSED on the TimbSwapFactory — call unpause() as the factory owner, then retry.");
        throw addErr;
      }
      if (sel === SEL_PAIR_NOT_FOUND) {
        // Pre-v6 router without create-on-add: create via the permissionless
        // factory call, then retry the add once.
        btn.textContent = `Creating ${tokenIn.symbol}/${tokenOut.symbol} pair…`;
        DebugHub.logCheckpoint("Liquidity Pair Create Requested", "pass");
        const factory = new ethers.Contract(ADDRESSES.TimbSwapFactory, FACTORY_ABI, signer);
        const gasCp = await getGasParams(); const nonceCp = await getPendingNonce();
        await (await factory.createPair(tokenIn.address, tokenOut.address, { ...gasCp, nonce: nonceCp })).wait();
        DebugHub.logCheckpoint("Liquidity Pair Created", "pass");
        btn.textContent = "Adding liquidity…";
        tx = await sendAdd();
      } else {
        throw addErr;
      }
    }
    DebugHub.logCheckpoint("Liquidity Add Confirmed", "pass");

    document.getElementById("lq-amount-a").value = "";
    document.getElementById("lq-amount-b").value = "";
    btn.textContent = "Liquidity added ✓";
    showLqTx(tx.hash);
    await refreshLiquidity();
    setTimeout(() => updateLqButtons(), 6000);
  } catch (err) {
    console.error("Add liquidity failed:", err.message);
    DebugHub.logError("handleAddLiquidity", err);
    DebugHub.logCheckpoint("Liquidity Add Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = orig; updateLqButtons(); }, 3000);
  }
}

async function handleRemoveLiquidity() {
  if (!userAddress || !tokenIn || !tokenOut) return;
  if (!lpBalanceWei || lpBalanceWei.isZero() || removePct <= 0) return;
  if (!lpPairAddress || lpPairAddress === ethers.constants.AddressZero) return;

  const btn = document.getElementById("lq-remove-btn");
  const orig = btn.textContent;
  try {
    btn.disabled = true;
    const liquidity = lpBalanceWei.mul(removePct).div(100);
    if (liquidity.isZero()) { updateLqButtons(); return; }

    // Approve the LP token to the router if needed.
    const lp = new ethers.Contract(lpPairAddress, ERC20_ABI, signer);
    const allow = await lp.allowance(userAddress, ADDRESSES.TimbSwapRouter);
    if (allow.lt(liquidity)) {
      btn.textContent = "Approving LP…";
      DebugHub.logCheckpoint("Liquidity Remove Approve", "pass");
      const gas = await getGasParams(); const nonce = await getPendingNonce();
      await (await lp.approve(ADDRESSES.TimbSwapRouter, ethers.constants.MaxUint256, { ...gas, nonce })).wait();
    }

    btn.textContent = "Removing…";
    DebugHub.logCheckpoint("Liquidity Remove Requested", "pass");
    const router = new ethers.Contract(ADDRESSES.TimbSwapRouter, ROUTER_ABI, signer);
    const deadline = Math.floor(Date.now() / 1000) + 1200;
    const gas = await getGasParams(); const nonce = await getPendingNonce();
    // amountAMin/amountBMin 0 — acceptable on testnet; the burn returns the pro-rata share.
    const tx = await router.removeLiquidity(tokenIn.address, tokenOut.address, liquidity, 0, 0, userAddress, deadline, { ...gas, nonce });
    await tx.wait();
    DebugHub.logCheckpoint("Liquidity Remove Confirmed", "pass");

    btn.textContent = "Removed ✓";
    showLqTx(tx.hash);
    removePct = 0;
    document.querySelectorAll(".lq-pct-row .slip-btn").forEach(b => b.classList.remove("slip-active"));
    await refreshLiquidity();
    setTimeout(() => updateLqButtons(), 6000);
  } catch (err) {
    console.error("Remove liquidity failed:", err.message);
    DebugHub.logError("handleRemoveLiquidity", err);
    DebugHub.logCheckpoint("Liquidity Remove Failed", "fail");
    btn.textContent = "Failed — try again";
    setTimeout(() => { btn.textContent = orig; updateLqButtons(); }, 3000);
  }
}

// ─── Wallet Connect (page-specific wiring) ────────────────────────────────────

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

  await refreshBalances();
  updateSwapButton(tokenIn && tokenOut ? "Swap" : "Select tokens");
  await checkEligibility(); // reveal the (wallet-gated) prize panel now
  if (mode === "liquidity") await refreshLiquidity();

  listenForAccountChanges(async (newAddr) => {
    if (!newAddr) { handleDisconnect(); return; }
    document.getElementById("wallet-addr").textContent = fmtAddr(newAddr);
    await refreshBalances();
    await checkEligibility();
  });
}

function handleDisconnect() {
  DebugHub.endSession();
  provider = null; signer = null; userAddress = null;
  document.getElementById("connect-btn").classList.remove("hidden");
  document.getElementById("wallet-info").classList.add("hidden");
  document.getElementById("network-badge").classList.add("hidden");
  updateSwapButton("Connect wallet to swap");
  refreshBalances();
  checkEligibility(); // hide the prize panel / influence row again
}

// ─── Init ─────────────────────────────────────────────────────────────────────

(async () => {
  // Default to TIMBS in / WETH out
  tokenIn  = DEFAULT_TOKENS.find(t => t.symbol === "TIMBS");
  tokenOut = DEFAULT_TOKENS.find(t => t.symbol === "WETH");
  document.getElementById("token-in-symbol").textContent  = tokenIn.symbol;
  document.getElementById("token-out-symbol").textContent = tokenOut.symbol;
  checkEligibility();
  recalcQuote();

  // Auto-reconnect if wallet was connected before navigation
    DebugHub.logCheckpoint("Swap:Page Loaded", "pass");
  const _reconnected = await autoReconnect();
  if (_reconnected) {
    document.getElementById("connect-btn")?.classList.add("hidden");
    document.getElementById("wallet-info")?.classList.remove("hidden");
    document.getElementById("network-badge")?.classList.remove("hidden");
    const _addrEl = document.getElementById("wallet-addr");
    if (_addrEl) _addrEl.textContent = fmtAddr(_reconnected);
    await refreshBalances();
    updateSwapButton(tokenIn && tokenOut ? "Swap" : "Select tokens");
    await checkEligibility(); // reveal the (wallet-gated) prize panel now
    if (mode === "liquidity") await refreshLiquidity();
    DebugHub.startSession();
    DebugHub.logCheckpoint("Wallet Auto-Reconnected", "pass");
    listenForAccountChanges(async (newAddr) => {
      if (!newAddr) { handleDisconnect(); return; }
      const _el = document.getElementById("wallet-addr");
      if (_el) _el.textContent = fmtAddr(newAddr);
      await refreshBalances();
      await checkEligibility();
    });
  }
})();
