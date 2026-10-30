// seed-pools-testnet.js — seed the four testnet pools on Arbitrum Sepolia.
//
// The testnet twin of seed-pools.js, which is the mainnet seeder (Arbitrum One
// only, Chainlink-priced). Testnet tokens have no feeds and TIMBS has no market,
// so prices come from a fixed table instead: ETH at config.js ETH_USD_PRICE (the
// same rate the site values testnet ETH at), stables at $1, and LINK and TIMBS
// as per-run inputs with no default. The first add to a new pool sets its
// price, and on testnet that price is what every page, the faucet and the game
// read back. Everything else is seed-pools.js's tested math: amounts per side,
// the existing-pool deviation check, slippage mins (required from it, not copied).
//
// Default pools, the ones Deploy.s.sol creates and marks as nudge pairs:
//   TIMBS/WETH, USDC/WETH, USDT/WETH, LINK/WETH
//
// What it checks before spending anything:
//   • chain id is Arbitrum Sepolia (421614)
//   • the router's factory is config.js TimbSwapFactory
//   • every token address returns the symbol and decimals it is supposed to
//   • the wallet holds enough of every token for the whole plan (--wrap first
//     wraps any WETH shortfall from the wallet's ETH)
//
// Dry run by default: prints the plan and sends nothing. --execute sends.
//
// Env:
//   SEED_RPC                 Arbitrum Sepolia RPC (default: config.js public RPC)
//   SEED_PRIVATE_KEY         the LP wallet key; --execute only
//   SEED_FROM                address to check balances for in a dry run without a key
//   SEED_USD_PER_SIDE        USD of EACH token per pool — required, a per-run decision
//   SEED_PRICE_TIMBS         TIMBS price in USD — required (it sets TIMBS's testnet price)
//   SEED_PRICE_LINK          LINK price in USD — required when a LINK pool is in the plan
//   SEED_PRICE_ETH           override config.js ETH_USD_PRICE
//   SEED_PAIRS               default "TIMBS/WETH,USDC/WETH,USDT/WETH,LINK/WETH"
//   SEED_LP_TO               LP token recipient (default: the sending wallet)
//   SEED_SLIPPAGE_BPS        min-amount tolerance (default 100 = 1 %)
//   SEED_MAX_DEVIATION_BPS   refuse an existing pool further than this from the table (default 200)
//   SEED_DEADLINE_SEC        tx deadline (default 600)
//   SEED_ROUTER, SEED_TOKEN_<SYMBOL>   overrides for the config.js addresses
//
// Flags: --self-test (no network)  --execute (send)  --wrap (wrap a WETH shortfall first)

"use strict";

const { ethers } = require("ethers");
const { configSrc, addrFromConfig, rpcFromConfig } = require("./lib/config");
const { parsePairs, planAdd } = require("./seed-pools");

const SELF_TEST = process.argv.includes("--self-test");
const EXECUTE   = process.argv.includes("--execute");
const WRAP      = process.argv.includes("--wrap");

const CHAIN_ID = 421614;
const DEFAULT_PAIRS = "TIMBS/WETH,USDC/WETH,USDT/WETH,LINK/WETH";

// symbol → config.js ADDRESSES key and the identity the token must report.
const TOKENS = {
  TIMBS: { key: "TIMBSToken", symbol: "TIMBS", decimals: 18 },
  WETH:  { key: "WETH",       symbol: "WETH",  decimals: 18 },
  USDC:  { key: "USDC",       symbol: "USDC",  decimals: 6 },
  USDT:  { key: "USDT",       symbol: "USDT",  decimals: 6 },
  LINK:  { key: "LINK",       symbol: "LINK",  decimals: 18 },
};

// ─── Pure logic (exported for --self-test) ──────────────────────────────────

/** ETH_USD_PRICE from config.js source text. */
function ethPriceFromConfig(src) {
  const m = src.match(/\bconst\s+ETH_USD_PRICE\s*=\s*([0-9.]+)/);
  if (!m) throw new Error("ETH_USD_PRICE not found in config.js — set SEED_PRICE_ETH");
  return Number(m[1]);
}

/**
 * USD prices for the symbols in the plan, as 8-decimal bigints (the shape
 * seed-pools.js planAdd takes). ETH from config unless overridden; stables $1;
 * TIMBS and LINK only from env, and only required when a pool needs them.
 */
function priceTable(symbols, env, configEth) {
  const usd = { USDC: 1, USDT: 1, WETH: env.SEED_PRICE_ETH ? Number(env.SEED_PRICE_ETH) : configEth };
  if (symbols.includes("TIMBS")) usd.TIMBS = Number(env.SEED_PRICE_TIMBS);
  if (symbols.includes("LINK"))  usd.LINK  = Number(env.SEED_PRICE_LINK);
  const out = {};
  for (const s of symbols) {
    const v = usd[s];
    if (!(v > 0)) throw new Error(`no price for ${s}: set SEED_PRICE_${s === "WETH" ? "ETH" : s} (USD, > 0) — there is no default`);
    out[s] = BigInt(Math.round(v * 1e8));
  }
  return out;
}

module.exports = { ethPriceFromConfig, priceTable, TOKENS, main };

// ─── Self-test ──────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) pass++; else { fail++; console.log("  FAIL", name); } };
  const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

  t("reads ETH_USD_PRICE from config text", ethPriceFromConfig("const ETH_USD_PRICE = 3000;\n") === 3000);
  t("missing ETH_USD_PRICE says so", throws(() => ethPriceFromConfig("const X = 1;"), /SEED_PRICE_ETH/));

  const p = priceTable(["TIMBS", "WETH", "USDC"], { SEED_PRICE_TIMBS: "0.05" }, 3000);
  t("ETH from config", p.WETH === 300_000_000_000n);
  t("stables at $1", p.USDC === 100_000_000n);
  t("TIMBS from env", p.TIMBS === 5_000_000n);
  t("ETH override wins", priceTable(["WETH"], { SEED_PRICE_ETH: "2500" }, 3000).WETH === 250_000_000_000n);
  t("TIMBS has no default", throws(() => priceTable(["TIMBS", "WETH"], {}, 3000), /SEED_PRICE_TIMBS/));
  t("LINK required only when pooled", throws(() => priceTable(["LINK", "WETH"], {}, 3000), /SEED_PRICE_LINK/)
    && priceTable(["USDC", "WETH"], {}, 3000).USDC === 100_000_000n);

  t("default pairs parse against the testnet symbols", parsePairs(DEFAULT_PAIRS, Object.keys(TOKENS)).length === 4);
  t("mainnet-only symbol refused", throws(() => parsePairs("WBTC/WETH", Object.keys(TOKENS)), /unknown token/));

  // A new TIMBS/WETH pool at $500 a side, TIMBS $0.05, ETH $3000: 10,000 TIMBS
  // and 0.1666… WETH, so the pool prices TIMBS at 1/60,000 ETH = $0.05.
  { const plan = planAdd({ usdPerSide: 500, priceA8: p.TIMBS, priceB8: p.WETH, decA: 18, decB: 18,
                           reserves: null, slippageBps: 100, maxDeviationBps: 200 });
    t("new pool: 10,000 TIMBS a side", plan.mode === "new" && plan.amountA === 10_000n * 10n ** 18n);
    t("new pool: WETH side worth the same $500", plan.amountB === 166_666_666_666_666_666n);
    t("slippage mins 1% under", plan.minA === 9_900n * 10n ** 18n); }

  // An existing pool 5% off the table is refused at a 2% limit.
  { const plan = planAdd({ usdPerSide: 500, priceA8: p.TIMBS, priceB8: p.WETH, decA: 18, decB: 18,
                           reserves: { reserveA: 10_000n * 10n ** 18n, reserveB: 175_000_000_000_000_000n },
                           slippageBps: 100, maxDeviationBps: 200 });
    t("drifted existing pool refused", plan.refused !== null && plan.deviation === 500); }

  console.log(`self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

if (SELF_TEST && require.main === module) selfTest();

// ─── Live run ───────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address, uint256) returns (bool)",
  "function deposit() payable",
];
const FACTORY_ABI = ["function getPairAddress(address, address) view returns (address)"];
const PAIR_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
  "function token0() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
];
const ROUTER_ABI = [
  "function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)",
  "function factory() view returns (address)",
];

const fmtUnits = (x, dec, dp = 6) => Number(ethers.formatUnits(x, dec)).toFixed(dp);
const tokenAddr = (sym) => process.env[`SEED_TOKEN_${sym}`] ? ethers.getAddress(process.env[`SEED_TOKEN_${sym}`]) : addrFromConfig(TOKENS[sym].key);

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.SEED_RPC || rpcFromConfig());
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== CHAIN_ID) throw new Error(`wrong chain: ${net.chainId} (expected Arbitrum Sepolia ${CHAIN_ID}; seed-pools.js is the mainnet seeder)`);

  // NonceManager: Arbitrum confirms in ~250 ms, faster than the provider's
  // nonce cache expires, so back-to-back sends (wrap, approve, add) would
  // otherwise reuse a nonce ("nonce has already been used").
  const wallet = process.env.SEED_PRIVATE_KEY ? new ethers.NonceManager(new ethers.Wallet(process.env.SEED_PRIVATE_KEY, provider)) : null;
  if (EXECUTE && !wallet) throw new Error("--execute needs SEED_PRIVATE_KEY");
  const from = wallet ? await wallet.getAddress() : (process.env.SEED_FROM ? ethers.getAddress(process.env.SEED_FROM) : null);
  const lpTo = process.env.SEED_LP_TO ? ethers.getAddress(process.env.SEED_LP_TO) : from;

  const routerAddr  = process.env.SEED_ROUTER ? ethers.getAddress(process.env.SEED_ROUTER) : addrFromConfig("TimbSwapRouter");
  const factoryAddr = addrFromConfig("TimbSwapFactory");
  const router  = new ethers.Contract(routerAddr, ROUTER_ABI, wallet ?? provider);
  const factory = new ethers.Contract(factoryAddr, FACTORY_ABI, provider);
  const routerFactory = await router.factory();
  if (routerFactory.toLowerCase() !== factoryAddr.toLowerCase()) throw new Error(`router.factory() is ${routerFactory}, not config.js TimbSwapFactory ${factoryAddr}`);

  const usdPerSide = Number(process.env.SEED_USD_PER_SIDE);
  if (!(usdPerSide > 0)) throw new Error("SEED_USD_PER_SIDE is required (USD of each token per pool) — a per-run decision, so there is no default");
  const slippageBps     = Number(process.env.SEED_SLIPPAGE_BPS || 100);
  const maxDeviationBps = Number(process.env.SEED_MAX_DEVIATION_BPS || 200);
  const deadlineSec     = Number(process.env.SEED_DEADLINE_SEC || 600);
  const pairs  = parsePairs(process.env.SEED_PAIRS || DEFAULT_PAIRS, Object.keys(TOKENS));
  const needed = [...new Set(pairs.flat())];
  const price8 = priceTable(needed, process.env, ethPriceFromConfig(configSrc()));

  console.log(`seed-pools-testnet on Arbitrum Sepolia  router ${routerAddr}  mode ${EXECUTE ? "EXECUTE" : "DRY RUN"}`);
  console.log(`  $${usdPerSide} per side · slippage ${slippageBps} bps · max pool/table deviation ${maxDeviationBps} bps · LP to ${lpTo || "(unset)"}`);
  for (const s of needed) console.log(`  price ${s.padEnd(5)} $${fmtUnits(price8[s], 8, 4)}`);

  // 1. Tokens: identity checks.
  const tok = {};
  for (const sym of needed) {
    const spec = TOKENS[sym];
    const addr = tokenAddr(sym);
    const c = new ethers.Contract(addr, ERC20_ABI, provider);
    const [onSym, onDec] = await Promise.all([c.symbol(), c.decimals()]);
    if (onSym !== spec.symbol || Number(onDec) !== spec.decimals) {
      throw new Error(`${sym} at ${addr} is "${onSym}" with ${onDec} decimals, expected ${spec.symbol}/${spec.decimals} — wrong address`);
    }
    tok[sym] = { addr, contract: c, decimals: spec.decimals };
  }

  // 2. Plan every pair.
  const plans = [];
  for (const [a, b] of pairs) {
    const A = tok[a], B = tok[b];
    const pairAddr = await factory.getPairAddress(A.addr, B.addr);
    let reserves = null;
    if (pairAddr !== ethers.ZeroAddress) {
      const pc = new ethers.Contract(pairAddr, PAIR_ABI, provider);
      const [[r0, r1], t0] = await Promise.all([pc.getReserves(), pc.token0()]);
      const aIs0 = t0.toLowerCase() === A.addr.toLowerCase();
      reserves = { reserveA: BigInt(aIs0 ? r0 : r1), reserveB: BigInt(aIs0 ? r1 : r0) };
    }
    const plan = planAdd({ usdPerSide, priceA8: price8[a], priceB8: price8[b], decA: A.decimals, decB: B.decimals,
                           reserves, slippageBps, maxDeviationBps });
    plans.push({ a, b, A, B, pairAddr, ...plan });
  }

  console.log("\nplan:");
  const need = {};
  for (const p of plans) {
    const tag = p.pairAddr === ethers.ZeroAddress ? "create + seed" : p.mode === "new" ? "seed (empty pair)" : `join (pool ${p.deviation} bps from the table)`;
    if (p.refused) { console.log(`  ✗ ${p.a}/${p.b}  REFUSED — ${p.refused.replace("the feed", "the price table")}`); continue; }
    console.log(`  • ${p.a}/${p.b}  ${tag}`);
    console.log(`      ${fmtUnits(p.amountA, p.A.decimals)} ${p.a}  +  ${fmtUnits(p.amountB, p.B.decimals)} ${p.b}   (mins ${fmtUnits(p.minA, p.A.decimals)} / ${fmtUnits(p.minB, p.B.decimals)})`);
    need[p.a] = (need[p.a] || 0n) + p.amountA;
    need[p.b] = (need[p.b] || 0n) + p.amountB;
  }

  // 3. Balances for the whole plan; --wrap covers a WETH shortfall from ETH.
  if (from) {
    if (WRAP && need.WETH) {
      const have = BigInt(await tok.WETH.contract.balanceOf(from));
      if (have < need.WETH) {
        const gap = need.WETH - have;
        if (!EXECUTE) console.log(`\n(--wrap would wrap ${fmtUnits(gap, 18)} ETH to WETH)`);
        else {
          const tx = await tok.WETH.contract.connect(wallet).deposit({ value: gap });
          console.log(`\nwrap ${fmtUnits(gap, 18)} ETH → WETH  ${tx.hash}`);
          await tx.wait();
        }
      }
    }
    let short = false;
    console.log(`\nwallet ${from}:`);
    for (const sym of Object.keys(need)) {
      const bal = BigInt(await tok[sym].contract.balanceOf(from));
      const ok = bal >= need[sym] || (sym === "WETH" && WRAP && !EXECUTE);
      if (!ok) short = true;
      console.log(`  ${ok ? "✓" : "✗"} ${sym.padEnd(5)} need ${fmtUnits(need[sym], tok[sym].decimals)}  have ${fmtUnits(bal, tok[sym].decimals)}${bal >= need[sym] ? "" : `  SHORT ${fmtUnits(need[sym] - bal, tok[sym].decimals)}`}`);
    }
    if (short && EXECUTE) throw new Error("wallet is short on at least one token — nothing sent");
  } else {
    console.log("\n(no SEED_PRIVATE_KEY / SEED_FROM — balances not checked)");
  }

  const refused = plans.filter((p) => p.refused);
  if (refused.length && EXECUTE) throw new Error(`${refused.length} pool(s) refused — fix or drop them from SEED_PAIRS before --execute`);
  if (!EXECUTE) { console.log("\nDRY RUN — nothing sent. Re-run with --execute to seed."); return; }

  // 4. Execute, one pool at a time, exact approvals.
  for (const p of plans) {
    console.log(`\n${p.a}/${p.b}:`);
    for (const [sym, T, amt] of [[p.a, p.A, p.amountA], [p.b, p.B, p.amountB]]) {
      const c = T.contract.connect(wallet);
      if (BigInt(await c.allowance(from, routerAddr)) < amt) {
        const tx = await c.approve(routerAddr, amt);
        console.log(`  approve ${sym} ${fmtUnits(amt, T.decimals)}  ${tx.hash}`);
        await tx.wait();
      }
    }
    const deadline = Math.floor(Date.now() / 1000) + deadlineSec;
    const tx = await router.addLiquidity(p.A.addr, p.B.addr, p.amountA, p.amountB, p.minA, p.minB, lpTo, deadline);
    console.log(`  addLiquidity  ${tx.hash}`);
    const rc = await tx.wait();
    const pairAddr = await factory.getPairAddress(p.A.addr, p.B.addr);
    const lp = BigInt(await new ethers.Contract(pairAddr, PAIR_ABI, provider).balanceOf(lpTo));
    console.log(`  ✓ pair ${pairAddr}  block ${rc.blockNumber}  LP held by ${lpTo}: ${fmtUnits(lp, 18)}`);
  }
  console.log("\nall pools seeded");
}

if (!SELF_TEST && require.main === module) main().catch((e) => { console.error("SEED-POOLS-TESTNET FAILED:", e.shortMessage || e.message || e); process.exit(1); });
