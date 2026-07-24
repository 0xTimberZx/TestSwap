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

// ─── Display pricing ──────────────────────────────────────────────────────────
// Fixed USD-per-ETH for the marketing "Win the Pot" USD figure on the landing.
// Testnet ETH has no market price, so we value it as if it were real ETH at
// this rate rather than reading a meaningless testnet pool. Adjust to track ETH.
const ETH_USD_PRICE = 3000;

// ─── Contract Addresses ───────────────────────────────────────────────────────

const ADDRESSES = {
  PrizeEscrow:          "0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D",
  TIMBSToken:           "0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa",
  TimbSwapFactory:      "0xCCd6d3f0A86042d2B7056eDd381d367126628AF5",
  TimbSwapRouter:       "0x40C7Caf90817C9891D278Ec1400B9deb180911f1", // v8 — multi-hop path routing
  EligibleTokenRegistry:"0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04",
  GameRegistry:         "0xBAb1CBaF0dE094322A49B379d0AC4510D1F78530", // v5 — dynamic per-round entry pricing (ETH floats off escrow, TIMBS steps with entries)
  TimbPrize:            "0x35976f4D2260127848a6274D2eC89ee054412432", // re-pointed to registry v5 via setGameRegistry; drives its round lifecycle
  TimbStaking:          "0xe776c7b700B190ED8248741F9b518B08d8733C8F",
  TimbFarm:             "0xE319E2206F71A5cD8dd2c411C6F29712935f9011",
  TimbBoostFarm:        "0x551D919D517aBa40D2b3A57a91973ad5Ad3CBd35", // boosted extra-pair farms (USDT/LINK/DAPP…), TIMBS emission funded by the epoch-keeper waterfall boost tier
  TimbLockVault:        "0x0157086E7670D1eFb15DC6b5158eE78279927a41",
  TimbYieldVault:       "0x43D833e828e2AF951527C2b573Eb70c358FfEB0B", // fresh deploy — clears stranded/colliding weight
  TimbTreasury:         "0xd3F40042aFA8074EA68C9f61dE6aDADD539F0D5c", // v4 — three-way buyback split (burn/reserve/waterfall) + protocol-owned liquidity
  TimbGovernance:       "0x8a324EfDc457BfB9Cf3D077E4CBC5A16a1c6a061",
  TimbsEthPair:         "0x5a911CBfD2808Ad5214E842a0E8ae34d8199BB95",
  WETH:                 "0x980B62Da83eFf3D4576C647993b0c1D7faf17c73",
  USDC:                 "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", // Circle canonical (6 decimals)
  LINK:                 "0xb1D4538B4571d411F07960EF2838Ce337FE1E80E", // Chainlink canonical (18 decimals)
  USDT:                 "0xbEEa6bc48adb31831bFCe5e91E48E08B3a836163", // TestUSDT — 6 decimals, 1M supply
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
    symbol:  "USDT",
    name:    "Tether USD (Test)",
    address: ADDRESSES.USDT,
    decimals: 6,
    logoChar: "₮"
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

// De-dupe concurrent connect attempts. A mobile wallet rejects a SECOND
// eth_requestAccounts with -32002 ("Already processing. Please wait.") while
// its first popup is still open, so every impatient re-tap logged a bogus
// "Wallet Connect Failed" (the tight Requested→Failed loop seen in DebugHub)
// even though the original request was still live. While one attempt is in
// flight, hand every caller the SAME promise instead of firing a new request.
let _connectInFlight = null;

async function connectWallet() {
  if (!window.ethereum) {
    alert("No wallet detected. Please use MetaMask or Brave Wallet.");
    return false;
  }
  if (_connectInFlight) return _connectInFlight;

  _connectInFlight = (async () => {
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
      // -32002 = a request is already pending in the wallet. Not a real
      // failure — the user just needs to finish the popup that's already open.
      if (err && (err.code === -32002 || /already processing/i.test(err.message || ""))) {
        console.warn("connectWallet: a connect request is already pending in the wallet");
      } else {
        console.error("connectWallet failed:", err);
      }
      return false;
    } finally {
      _connectInFlight = null;
    }
  })();
  return _connectInFlight;
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

// Mobile in-app wallets (MetaMask, Brave) can drop the injected provider after a
// background/tab-switch/reload while the session (userAddress) persists — leaving
// a tx handler running with provider/signer = null. Re-establish silently before
// any write, and fail with a clear message if the wallet truly isn't available
// (instead of "null is not an object (evaluating 'provider.getTransactionCount')").
async function ensureSigner() {
  if (provider && signer) return true;
  try { await autoReconnect(); } catch {}
  return !!(provider && signer);
}

// Build a signer-bound contract for a WRITE, guaranteeing the signer is live
// FIRST. ensureSigner() may silently reconnect after a mobile provider drop,
// which reassigns the global `signer`; a contract constructed *before* that ran
// would stay bound to the stale/null signer even after reconnect (the
// "null is not an object (evaluating 'provider.getTransactionCount')" crash
// seen in the DebugHub logs). Always `await writeContract(addr, abi)` for
// writes instead of `new ethers.Contract(addr, abi, signer)`.
async function writeContract(address, abi) {
  if (!(await ensureSigner())) throw new Error("Wallet disconnected — reconnect and try again.");
  return new ethers.Contract(address, abi, signer);
}

async function getGasParams() {
  if (!(await ensureSigner())) throw new Error("Wallet disconnected — reconnect and try again.");
  // getFeeData() from a mobile in-app wallet's injected node can return null
  // for maxPriorityFeePerGas (Arbitrum's tip is ~0) or even maxFeePerGas.
  // Calling .mul() on null threw "null is not an object" for EVERY write —
  // swap, advance, entry — before the wallet was ever asked to sign. Tolerate
  // the gaps: prefer EIP-1559 when a maxFeePerGas is reported (priority 0 is
  // valid on Arbitrum), fall back to legacy gasPrice, and finally let the
  // wallet fill fees itself rather than crash.
  let feeData;
  try { feeData = await provider.getFeeData(); }
  catch { return {}; }

  const bump = (v) => (v && v.mul) ? v.mul(130).div(100) : null;
  const maxFee = bump(feeData.maxFeePerGas);
  if (maxFee) {
    const prio = bump(feeData.maxPriorityFeePerGas);
    return { maxFeePerGas: maxFee, maxPriorityFeePerGas: prio || ethers.constants.Zero };
  }
  const gasPrice = bump(feeData.gasPrice);
  if (gasPrice) return { gasPrice };
  return {}; // nothing usable → wallet estimates its own fees
}

// Let the WALLET assign the nonce. Forcing a manual nonce (from a "pending"
// count) desyncs with mobile MetaMask's own nonce tracking and throws
// NONCE_EXPIRED ("nonce too low") — seen in the mobile DebugHub logs. Every
// call site sends a single, awaited tx (no batching that needs sequential
// nonces), so undefined is correct: ethers/the wallet fills the right nonce.
// Kept as a function (not removed) so all ~25 `{ ...gas, nonce }` call sites
// keep working unchanged, and so the ensureSigner guard still runs pre-tx.
async function getPendingNonce() {
  if (!(await ensureSigner())) throw new Error("Wallet disconnected — reconnect and try again.");
  return undefined;
}

// ─── Transaction Confirmation (ecosystem pattern) ────────────────────────────

// Dedicated read-only provider on the canonical Arbitrum Sepolia RPC. Used to
// confirm transactions independently of the wallet's in-app provider.
let _confirmProv = null;
function _confirmProvider() {
  return _confirmProv || (_confirmProv = new ethers.providers.JsonRpcProvider(RPC_URL));
}

// Confirm a submitted tx by polling the canonical public RPC for its receipt,
// instead of awaiting the wallet's own tx.wait(). Mobile in-app wallets often
// never push the receipt back to the page, which leaves a button stuck in its
// loading state ("Adding liquidity…", "Staking…", "Voting…") long after the tx
// has actually mined. The public RPC is authoritative: this resolves the
// moment the receipt lands, and throws on a reverted tx (status 0) or after a
// ~3-minute ceiling. `tx` is an ethers TransactionResponse (needs `.hash`).
async function confirmTx(tx, { tries = 90, intervalMs = 2000 } = {}) {
  const prov = _confirmProvider();
  for (let i = 0; i < tries; i++) {
    try {
      const r = await prov.getTransactionReceipt(tx.hash);
      if (r && r.blockNumber) {
        if (r.status === 0) throw Object.assign(new Error("transaction reverted"), { receipt: r });
        return r;
      }
    } catch (e) { if (e && e.receipt) throw e; /* transient RPC read — keep polling */ }
    await new Promise(res => setTimeout(res, intervalMs));
  }
  throw new Error("confirmation timeout — check the explorer");
}

// ─── Event-Scan Block Windows ────────────────────────────────────────────────

// Arbitrum Sepolia mints blocks on demand — lately ~3/second (≈270k/day), so a
// fixed block count is meaningless as a time window (50k blocks is ~4½ hours,
// not days). Calibrate blocks-per-second from two real block timestamps once
// per page load, then convert time windows into block counts from that.
let _blocksPerSec = null;
async function blocksPerSecond(prov) {
  if (_blocksPerSec) return _blocksPerSec;
  try {
    const cur  = await prov.getBlockNumber();
    const span = Math.min(Math.max(cur - 1, 0), 200000);
    if (span > 0) {
      const [a, b] = await Promise.all([prov.getBlock(cur), prov.getBlock(cur - span)]);
      const dt = a.timestamp - b.timestamp;
      if (dt > 0) _blocksPerSec = span / dt;
    }
  } catch {}
  return _blocksPerSec || 3; // sane Arb Sepolia default if the probe fails
}

async function blocksForDays(prov, days) {
  return Math.round((await blocksPerSecond(prov)) * 86400 * days);
}

// Compact abbreviated "time ago" from a seconds delta: 30 → "30s", 5 → "5m",
// 2 → "2h", 3 → "3d". Used for activity tables. Approximate when fed a
// block-time estimate (blocks ÷ blocksPerSecond), which is fine for relative
// display.
function fmtAgo(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60)    return sec + "s";
  const m = Math.floor(sec / 60);    if (m < 60) return m + "m";
  const h = Math.floor(sec / 3600);  if (h < 24) return h + "h";
  return Math.floor(sec / 86400) + "d";
}

// "Nx ago" label for a block, given the current head and calibrated block rate
// (blocks/sec). Returns "" if inputs are missing.
function blockAge(block, currentBlock, bps) {
  if (!block || !currentBlock || !bps) return "";
  return fmtAgo((currentBlock - block) / bps);
}

// eth_getLogs over a multi-day window can exceed a public RPC's range/result
// limits. Try the wanted window first, then shrink (¼, then 1/20) before
// giving up, so a strict endpoint still yields the most recent slice of
// activity instead of nothing.
async function queryFilterWindow(contract, filter, currentBlock, windowBlocks) {
  let lastErr = null;
  for (const f of [1, 0.25, 0.05]) {
    const from = Math.max(0, currentBlock - Math.round(windowBlocks * f));
    try { return await contract.queryFilter(filter, from, currentBlock); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// ─── Add Token to Wallet (EIP-747 wallet_watchAsset) ─────────────────────────

// Prompt the connected wallet to track an ERC-20 (MetaMask/Brave "Add token").
// `token` needs { address, symbol, decimals }. Symbol is capped at 11 chars
// (MetaMask rejects longer). Returns true if the wallet reports it was added.
// Safe to call from an onclick — it swallows the user-rejected case quietly.
async function addTokenToWallet(token) {
  if (!window.ethereum) { alert("No wallet detected. Open in a wallet browser or install MetaMask/Brave Wallet."); return false; }
  if (!token || !token.address || token.address === "native") return false;
  try {
    const wasAdded = await injectedProvider().request({
      method: "wallet_watchAsset",
      params: {
        type: "ERC20",
        options: {
          address:  token.address,
          symbol:   (token.symbol || "TOKEN").slice(0, 11),
          decimals: Number(token.decimals ?? 18)
        }
      }
    });
    return !!wasAdded;
  } catch (e) {
    console.warn("addTokenToWallet:", e && e.message);
    return false;
  }
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

// ─── Shared pair labeling (base/quote orientation) ────────────────────────────
// Single source of truth for how a pair reads: the higher-priority token is the
// QUOTE (denominator), shown second — stables > native (WETH) > everything else.
// So every pair reads consistently (X/USDC, X/WETH) instead of in arbitrary
// factory token0/token1 order. Used by explore, analytics, and the farm's
// boosted pools so the SAME pair labels the same way everywhere.
function pairQuoteRank(addr) {
  const a = (addr || "").toLowerCase();
  const is = (k) => ADDRESSES[k] && a === ADDRESSES[k].toLowerCase();
  if (is("USDC") || is("USDT")) return 3; // stables quote first
  if (is("WETH")) return 2;               // then native
  return 1;                               // then whitelisted / others
}
// Order two tokens base/quote by that priority (higher rank = quote, shown 2nd).
// Equal priority keeps the given order. Returns {base, quote} of {addr, sym}.
function orientPair(t0, sym0, t1, sym1) {
  const flip = pairQuoteRank(t0) > pairQuoteRank(t1);
  return flip
    ? { base: { addr: t1, sym: sym1 }, quote: { addr: t0, sym: sym0 } }
    : { base: { addr: t0, sym: sym0 }, quote: { addr: t1, sym: sym1 } };
}
// "BASE/QUOTE" label from token addresses + symbols.
function pairLabelFor(t0, sym0, t1, sym1) {
  const o = orientPair(t0, sym0, t1, sym1);
  return `${o.base.sym}/${o.quote.sym}`;
}

// ─── Shared USD price oracle ──────────────────────────────────────────────────
// Prices any listed token in USD off the live V2 pools, so any page can show an
// "≈ $" estimate. Stables = $1; WETH via the USDC/WETH pool; anything else via
// its USDC pair (direct), else its WETH pair × the ETH price. Cached with a
// short TTL so readouts track pool moves (other wallets' trades) on refresh
// without hammering the RPC. All reads hit the canonical public RPC.
const _PRICE_PAIR_ABI = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)"
];
const _PRICE_FACTORY_ABI = ["function getPairAddress(address a, address b) external view returns (address)"];
const _PRICE_TTL = 12000; // ms; a tick of ~12s keeps estimates live but cheap
const _usdCache = {};     // lowercased addr -> { px: number|null, ts }
let _priceProv = null;
function _priceProvider() {
  return _priceProv || (_priceProv = new ethers.providers.JsonRpcProvider(RPC_URL));
}
function _tokenDecimals(lc) {
  const t = DEFAULT_TOKENS.find(x => x.address.toLowerCase() === lc);
  return t ? t.decimals : 18;
}
function _isStableAddr(lc) {
  return (ADDRESSES.USDC && lc === ADDRESSES.USDC.toLowerCase()) ||
         (ADDRESSES.USDT && lc === ADDRESSES.USDT.toLowerCase());
}
// USD value of one whole `quote` token = quoteUsd; returns USD-per-`token`, read
// off the token/quote pool. null if the pair doesn't exist or is empty.
async function _priceViaPair(prov, factory, token, quote, quoteUsd) {
  if (quoteUsd === null || quoteUsd === undefined) return null;
  const addr = await factory.getPairAddress(token, quote);
  if (!addr || addr === ethers.constants.AddressZero) return null;
  const pc = new ethers.Contract(addr, _PRICE_PAIR_ABI, prov);
  const [r, t0] = await Promise.all([pc.getReserves(), pc.token0()]);
  const tokLc  = token.toLowerCase();
  const tokIs0 = t0.toLowerCase() === tokLc;
  const tokRes = parseFloat(ethers.utils.formatUnits(tokIs0 ? r.reserve0 : r.reserve1, _tokenDecimals(tokLc)));
  const qRes   = parseFloat(ethers.utils.formatUnits(tokIs0 ? r.reserve1 : r.reserve0, _tokenDecimals(quote.toLowerCase())));
  if (tokRes <= 0 || qRes <= 0) return null;
  return (qRes / tokRes) * quoteUsd; // (quote per token) × (USD per quote)
}
async function _oracleEthUsd(prov, factory) {
  return _priceViaPair(prov, factory, ADDRESSES.WETH, ADDRESSES.USDC, 1);
}
// USD per 1 whole token (number), or null if unpriceable. TTL-cached.
async function usdPriceOf(tokenAddr) {
  if (!tokenAddr) return null;
  const lc  = tokenAddr.toLowerCase();
  const now = Date.now();
  const c   = _usdCache[lc];
  if (c && now - c.ts < _PRICE_TTL) return c.px;
  let px = null;
  try {
    const prov    = _priceProvider();
    const factory = new ethers.Contract(ADDRESSES.TimbSwapFactory, _PRICE_FACTORY_ABI, prov);
    if (_isStableAddr(lc)) px = 1;
    else if (lc === ADDRESSES.WETH.toLowerCase()) px = await _oracleEthUsd(prov, factory);
    else {
      px = await _priceViaPair(prov, factory, tokenAddr, ADDRESSES.USDC, 1);
      if (px === null) {
        const eth = await _oracleEthUsd(prov, factory);
        px = await _priceViaPair(prov, factory, tokenAddr, ADDRESSES.WETH, eth);
      }
    }
  } catch {}
  _usdCache[lc] = { px, ts: now };
  return px;
}
// "≈ $X.XX" for `amountFloat` of the token at `tokenAddr`, or "" if unpriceable.
async function usdEst(tokenAddr, amountFloat) {
  const a = parseFloat(amountFloat);
  if (!isFinite(a) || a <= 0) return "";
  const px = await usdPriceOf(tokenAddr);
  if (px === null || px === undefined) return "";
  const v = a * px;
  if (v === 0) return "≈ $0";
  if (v < 0.01) return "≈ $" + v.toPrecision(2);
  return "≈ $" + v.toLocaleString("en-US", { maximumFractionDigits: 2 });
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
//
// supabaseUrl/Key point the SDK at the shared network sink so telemetry reaches
// the hub across origins/devices (localStorage alone can't — timbswap.xyz is a
// different origin than the hub). The SDK reads these lazily at send time, so
// setting them here (after the SDK script tag) is fine. The current 1.1.0 SDK
// ignores them; they activate once MyDapp ships debugger.js v1.2.0. Anon key is
// public by design — RLS is the boundary. See dev-docs/debughub-network/.

window.DEBUGHUB_CONFIG = {
  appName:     "TimbSwap",
  supabaseUrl: "https://ipyfodnidwsdvwqrcjrl.supabase.co",
  supabaseKey: "sb_publishable_yg4wjMwvGrlf5C9vqs2nkw_Hfks0Ux9"
};

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
