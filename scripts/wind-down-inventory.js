// wind-down-inventory.js — what the old testnet holds, and who can take it out.
//
// Read-only. Before the redeploy we pull the team's test tokens out of the old
// contracts and pools to seed the new ones. This lists, from the chain:
//
//   1. who signs: owner() and guardian() of every contract in config.js
//   2. every contract's ETH and token balances, plus the game's books (prize
//      pot and protocol cut, vault reserve, ticket principal)
//   3. the team wallets' balances (the owner wallet, any wallets passed in,
//      and points_team_wallets when Supabase secrets are set)
//   4. every pool: reserves, and who holds its LP (team wallets directly or
//      staked in the farms, the treasury, everyone else)
//   5. what the team can recover per token, next to what seeding the new
//      pools needs
//
// Wallet addresses are printed shortened (0x1234…abcd): the run log is public.
// Nothing is sent; no key is read.
//
// Env:
//   INVENTORY_RPC        RPC (falls back to ARB_SEPOLIA_RPC, then config.js)
//   INVENTORY_OWNER      the wallet that owns the old contracts
//   INVENTORY_WALLETS    optional comma-separated extra team wallets
//   SUPABASE_URL, SUPABASE_SERVICE_KEY   optional: adds points_team_wallets
//   GITHUB_STEP_SUMMARY  set by Actions; the report is appended there too
// Args: --self-test

const fs = require("fs");
const { ethers } = require("ethers");
const { configSrc, addrFromConfig, rpcFromConfig } = require("./lib/config");

const CHAIN_ID = 421614;
const LOCKED_LP = 1000n; // MINIMUM_LIQUIDITY, burned to address(1) on a pair's first mint

// The game contracts and keepers' homes in config.js. Tokens are listed apart.
const CONTRACT_KEYS = [
  "PrizeEscrow", "TimbSwapFactory", "TimbSwapRouter", "EligibleTokenRegistry", "GameRegistry", "TimbPrize",
  "PrizeVRFEntropy", "GasFaucet", "TimbStaking", "TimbFarm", "TimbBoostFarm", "TimbLockVault", "TimbYieldVault",
  "TimbTreasury", "SegmentBoard", "PoolLedger", "VRFEntropy", "CommitRevealEntropy", "UnderwriteReserve",
  "DDJackpot", "SeedRegistry", "SegmentCrank",
];
// Tokens: [config key, label, carries over to the new deploy?]
const TOKEN_KEYS = [
  ["WETH", "WETH", true], ["USDC", "USDC", true], ["USDT", "USDT", true], ["LINK", "LINK", true],
  ["DAPP", "DAPP", true], ["TIMBSToken", "TIMBS (old)", false],
];
// What seeding the new pools needs (TESTNET_REDEPLOY_PLAN §3.4): stables at $1,000 a
// side (revised 1 Nov), TIMBS and LINK at $1,000 a side. ETH covers WETH.
const SEED_NEED = { ETH: 1.333333, USDC: 1000, USDT: 1000, LINK: 83.333333 };

const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const PAIR = [...ERC20, "function token0() view returns (address)", "function token1() view returns (address)",
  "function totalSupply() view returns (uint256)", "function getReserves() view returns (uint112, uint112, uint32)"];
const FACTORY = ["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"];
const ROLES = ["function owner() view returns (address)", "function guardian() view returns (address)"];
const PRIZE = ["function protocolCutAccrued() view returns (uint256)", "function currentAccumulatedRewards() view returns (uint256)", "function retired() view returns (bool)"];
const VAULT = ["function reserve() view returns (uint256)", "function accruedForPot() view returns (uint256)"];
const REGISTRY = ["function totalEthEscrow() view returns (uint256)"];
const FARM = ["function stakedBalance(address) view returns (uint256)", "function lpToken() view returns (address)"];
const BOOST = ["function poolCount() view returns (uint256)",
  "function poolInfo(uint256) view returns (address lpToken, uint256 weight, uint256 lastRewardTime, uint256 accRewardPerShare, uint256 totalStaked, bool paused)",
  "function userInfo(uint256, address) view returns (uint256 amount, uint256 rewardDebt, uint256 pending)"];

// ─── Pure helpers (self-tested) ──────────────────────────────────────────────

function short(a) { return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "—"; }

/** Underlying [amount0, amount1] for `lp` of a pair. */
function lpUnderlying(lp, totalSupply, r0, r1) {
  if (totalSupply === 0n || lp === 0n) return [0n, 0n];
  return [(lp * r0) / totalSupply, (lp * r1) / totalSupply];
}

/** Human number from base units, trimmed to `dp` decimals. */
function num(v, decimals, dp = 4) {
  const s = ethers.formatUnits(v, decimals);
  const [i, f = ""] = s.split(".");
  const ff = f.slice(0, dp).replace(/0+$/, "");
  return Number(i).toLocaleString("en-US") + (ff ? "." + ff : "");
}

/** Comma-separated addresses → unique checksummed list; bad entries throw. */
function parseWallets(text) {
  const out = [];
  for (const raw of String(text || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)) {
    const a = ethers.getAddress(raw.toLowerCase());
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/**
 * Split a pair's LP supply by holder group. `holdings` = [{ group, lp }], where
 * group is "team", "team (staked)", "treasury" or a label. Whatever is left
 * after the known holders and the locked minimum is "everyone else".
 */
function lpSplit(totalSupply, holdings) {
  const groups = {};
  let known = 0n;
  for (const { group, lp } of holdings) {
    if (lp === 0n) continue;
    groups[group] = (groups[group] || 0n) + lp;
    known += lp;
  }
  const locked = totalSupply >= LOCKED_LP ? LOCKED_LP : 0n;
  const rest = totalSupply - known - locked;
  if (rest > 0n) groups["everyone else"] = rest;
  return { groups, known, locked, rest: rest > 0n ? rest : 0n };
}

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => {
    const g = JSON.stringify(got, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const w = JSON.stringify(want, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    if (g === w) pass++; else { fail++; console.log(`FAIL ${name}: got ${g}, want ${w}`); }
  };
  eq("short", short("0x42536623b503D4926DfAF6173B0357b7DfD19800"), "0x4253…9800");
  eq("lp share", lpUnderlying(250n, 1000n, 400n, 800n), [100n, 200n]);
  eq("lp none", lpUnderlying(0n, 1000n, 400n, 800n), [0n, 0n]);
  eq("lp empty pool", lpUnderlying(5n, 0n, 0n, 0n), [0n, 0n]);
  eq("num trims", num(1234567890000000000000n, 18), "1,234.5678");
  eq("num 6dp token", num(2500000000n, 6), "2,500");
  eq("num zero", num(0n, 18), "0");
  eq("wallets dedupe + checksum", parseWallets("0x42536623b503d4926dfaf6173b0357b7dfd19800, 0x42536623B503D4926DfAF6173B0357b7DfD19800"), ["0x42536623b503D4926DfAF6173B0357b7DfD19800"]);
  eq("wallets empty", parseWallets(""), []);
  let threw = false; try { parseWallets("0x1234"); } catch { threw = true; }
  eq("wallets bad entry throws", threw, true);
  const s = lpSplit(10_000n, [{ group: "team", lp: 6_000n }, { group: "treasury", lp: 1_000n }, { group: "team", lp: 0n }]);
  eq("split groups", s.groups, { team: 6000n, treasury: 1000n, "everyone else": 2000n });
  eq("split locked", s.locked, 1000n);
  const all = lpSplit(10_000n, [{ group: "team", lp: 9_000n }]);
  eq("split all team, nothing else", all.groups, { team: 9000n });
  console.log(`self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

// ─── Chain reads ─────────────────────────────────────────────────────────────

async function tryCall(c, fn, ...args) {
  try { return await c[fn](...args); } catch { return null; }
}

async function teamFromSupabase() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return [];
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/points_team_wallets?select=address`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) { console.warn(`points_team_wallets: HTTP ${r.status}, skipped`); return []; }
    return (await r.json()).map((x) => ethers.getAddress(x.address));
  } catch (e) {
    console.warn(`points_team_wallets: ${e.message}, skipped`);
    return [];
  }
}

async function main() {
  const rpcUrl = process.env.INVENTORY_RPC || process.env.ARB_SEPOLIA_RPC || rpcFromConfig();
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== CHAIN_ID) throw new Error(`expected Arbitrum Sepolia (${CHAIN_ID}), got chain ${chainId}`);
  const block = await provider.getBlockNumber();
  const src = configSrc();

  const owner = process.env.INVENTORY_OWNER ? ethers.getAddress(process.env.INVENTORY_OWNER.trim().toLowerCase()) : null;
  const team = parseWallets([owner, process.env.INVENTORY_WALLETS].filter(Boolean).join(","));
  for (const a of await teamFromSupabase()) if (!team.includes(a)) team.push(a);

  const contracts = [];
  for (const key of CONTRACT_KEYS) {
    let a; try { a = addrFromConfig(key, { src }); } catch { continue; }
    if ((await provider.getCode(a)) === "0x") continue;
    contracts.push({ key, address: a });
  }
  const tokens = [];
  for (const [key, label, carries] of TOKEN_KEYS) {
    let address; try { address = addrFromConfig(key, { src }); } catch { continue; }
    if ((await provider.getCode(address)) === "0x") { console.warn(`${key}: no code at ${address}, skipped`); continue; }
    const c = new ethers.Contract(address, ERC20, provider);
    tokens.push({ key, label, carries, address, c, decimals: Number(await c.decimals()) });
  }
  const tokenByAddr = Object.fromEntries(tokens.map((t) => [t.address.toLowerCase(), t]));

  async function balances(holder) {
    const eth = await provider.getBalance(holder);
    const toks = await Promise.all(tokens.map((t) => t.c.balanceOf(holder)));
    return { eth, toks };
  }

  const out = [];
  const say = (line = "") => out.push(line);
  say(`# Old testnet inventory`);
  say(`Arbitrum Sepolia, block ${block}, ${new Date().toISOString()}. Read-only. Owner wallet: ${owner ? short(owner) : "not given"}; team wallets checked: ${team.length}.`);
  say();

  // 1. Who signs.
  say(`## 1. Who signs`);
  say(`| Contract | Owner | Guardian |`);
  say(`|---|---|---|`);
  const roleOf = {};
  for (const { key, address } of contracts) {
    const c = new ethers.Contract(address, ROLES, provider);
    const [o, g] = await Promise.all([tryCall(c, "owner"), tryCall(c, "guardian")]);
    roleOf[key] = { owner: o, guardian: g };
    const mark = (a) => (a ? short(a) + (owner && a === owner ? " **(owner wallet)**" : team.includes(a) ? " (team)" : "") : "—");
    say(`| ${key} | ${mark(o)} | ${mark(g)} |`);
  }
  say();

  // 2. Contract balances and the game's books.
  say(`## 2. Contract balances (non-zero only)`);
  say(`| Contract | ETH | ${tokens.map((t) => t.label).join(" | ")} |`);
  say(`|---|---|${tokens.map(() => "---").join("|")}|`);
  const held = {};
  for (const { key, address } of contracts) {
    const b = await balances(address);
    held[key] = b;
    if (b.eth === 0n && b.toks.every((x) => x === 0n)) continue;
    say(`| ${key} | ${num(b.eth, 18)} | ${b.toks.map((x, i) => (x === 0n ? "" : num(x, tokens[i].decimals))).join(" | ")} |`);
  }
  say();
  const book = {};
  const at = (key, abi) => contracts.find((c) => c.key === key) && new ethers.Contract(addrFromConfig(key, { src }), abi, provider);
  const prize = at("TimbPrize", PRIZE), vault = at("TimbYieldVault", VAULT), registry = at("GameRegistry", REGISTRY);
  if (prize) {
    book.cut = (await tryCall(prize, "protocolCutAccrued")) ?? 0n;
    book.pot = (await tryCall(prize, "currentAccumulatedRewards")) ?? 0n;
    book.retired = await tryCall(prize, "retired");
  }
  if (vault) { book.reserve = (await tryCall(vault, "reserve")) ?? 0n; book.vaultOwed = (await tryCall(vault, "accruedForPot")) ?? 0n; }
  if (registry) book.principal = (await tryCall(registry, "totalEthEscrow")) ?? 0n;
  say(`Game books: prize pot ${num(book.pot ?? 0n, 18)} ETH, protocol cut ${num(book.cut ?? 0n, 18)} ETH (withdrawProtocolCut), prize retired: ${book.retired ?? "?"}; vault free reserve ${num(book.reserve ?? 0n, 18)} ETH (emergencyWithdraw), owed to the pot ${num(book.vaultOwed ?? 0n, 18)} ETH; ticket principal in the registry ${num(book.principal ?? 0n, 18)} ETH (players', not ours).`);
  say();

  // 3. Team wallets.
  say(`## 3. Team wallets`);
  say(`| Wallet | ETH | ${tokens.map((t) => t.label).join(" | ")} |`);
  say(`|---|---|${tokens.map(() => "---").join("|")}|`);
  const teamHeld = {};
  for (const w of team) {
    const b = await balances(w);
    teamHeld[w] = b;
    say(`| ${short(w)}${w === owner ? " (owner)" : ""} | ${num(b.eth, 18)} | ${b.toks.map((x, i) => (x === 0n ? "" : num(x, tokens[i].decimals))).join(" | ")} |`);
  }
  say();

  // 4. Pools.
  say(`## 4. Pools and who holds the LP`);
  const factory = new ethers.Contract(addrFromConfig("TimbSwapFactory", { src }), FACTORY, provider);
  const nPairs = Number(await factory.allPairsLength());
  const farm = at("TimbFarm", FARM), boost = at("TimbBoostFarm", BOOST);
  const boostPools = [];
  if (boost) {
    const n = Number((await tryCall(boost, "poolCount")) ?? 0n);
    for (let pid = 0; pid < n; pid++) { const p = await tryCall(boost, "poolInfo", pid); if (p) boostPools.push({ pid, lp: p.lpToken.toLowerCase() }); }
  }
  const farmLp = farm ? String((await tryCall(farm, "lpToken")) || "").toLowerCase() : "";
  const treasuryAddr = contracts.find((c) => c.key === "TimbTreasury")?.address;

  const recover = {}; // label -> bigint, team-recoverable underlying
  const byWallet = []; // team LP per wallet, per pool, per place it sits
  const addRec = (t, v) => { if (t && v > 0n) recover[t.label] = (recover[t.label] || 0n) + v; };
  say(`| Pool | Reserves | LP: team direct | team staked | treasury | everyone else | Team + treasury share |`);
  say(`|---|---|---|---|---|---|---|`);
  for (let i = 0; i < nPairs; i++) {
    const pa = await factory.allPairs(i);
    const p = new ethers.Contract(pa, PAIR, provider);
    const [t0, t1, ts, res] = await Promise.all([p.token0(), p.token1(), p.totalSupply(), p.getReserves()]);
    const k0 = tokenByAddr[t0.toLowerCase()], k1 = tokenByAddr[t1.toLowerCase()];
    const sym = async (t, k) => (k ? k.label : (await tryCall(new ethers.Contract(t, ERC20, provider), "symbol")) || short(t));
    const dec = async (t, k) => (k ? k.decimals : Number((await tryCall(new ethers.Contract(t, ERC20, provider), "decimals")) ?? 18n));
    const [s0, s1, d0, d1] = await Promise.all([sym(t0, k0), sym(t1, k1), dec(t0, k0), dec(t1, k1)]);

    const holdings = [];
    const mine = []; // this pool's per-wallet rows: { w, where, how, lp }
    for (const w of team) {
      const direct = await p.balanceOf(w);
      holdings.push({ group: "team", lp: direct });
      mine.push({ w, where: "in wallet", how: "removeLiquidity", lp: direct });
      if (farm && farmLp === pa.toLowerCase()) {
        const st = (await tryCall(farm, "stakedBalance", w)) ?? 0n;
        holdings.push({ group: "team (staked)", lp: st });
        mine.push({ w, where: "TimbFarm", how: "TimbFarm.exit() (or emergencyWithdraw()), then removeLiquidity", lp: st });
      }
      for (const bp of boostPools.filter((x) => x.lp === pa.toLowerCase())) {
        const u = await tryCall(boost, "userInfo", bp.pid, w);
        const st = u ? u.amount : 0n;
        holdings.push({ group: "team (staked)", lp: st });
        mine.push({ w, where: `TimbBoostFarm pid ${bp.pid}`, how: `TimbBoostFarm.exit(${bp.pid}) (or emergencyWithdraw(${bp.pid})), then removeLiquidity`, lp: st });
      }
    }
    for (const m of mine.filter((x) => x.lp > 0n)) {
      const [a0, a1] = lpUnderlying(m.lp, ts, res[0], res[1]);
      byWallet.push({ ...m, pool: `${s0}/${s1}`, under: `${num(a0, d0)} ${s0} · ${num(a1, d1)} ${s1}` });
    }
    if (treasuryAddr) holdings.push({ group: "treasury", lp: await p.balanceOf(treasuryAddr) });
    const { groups } = lpSplit(ts, holdings);
    const pct = (g) => (ts === 0n || !groups[g] ? "" : `${(Number((groups[g] * 10000n) / ts) / 100).toFixed(2)}%`);
    const ours = (groups["team"] || 0n) + (groups["team (staked)"] || 0n) + (groups["treasury"] || 0n);
    const [u0, u1] = lpUnderlying(ours, ts, res[0], res[1]);
    addRec(k0, u0); addRec(k1, u1);
    say(`| ${s0}/${s1} | ${num(res[0], d0)} ${s0} · ${num(res[1], d1)} ${s1} | ${pct("team")} | ${pct("team (staked)")} | ${pct("treasury")} | ${pct("everyone else")} | ${num(u0, d0)} ${s0} · ${num(u1, d1)} ${s1} |`);
  }
  say();
  say(`Team staked = LP the team wallets have in TimbFarm / TimbBoostFarm (withdraw first). Treasury LP comes out with withdrawToken, then removeLiquidity. 1,000 LP per pool is locked for good.`);
  say();

  // 4b. Who signs each unstake: the wallet that staked it.
  say(`### Team LP by wallet`);
  if (!byWallet.length) say(`No team wallet holds LP in any pool.`);
  else {
    say(`| Wallet | Pool | Where | LP | Worth | To take it out (signed by that wallet) |`);
    say(`|---|---|---|---|---|---|`);
    byWallet.sort((a, b) => a.w.localeCompare(b.w) || a.pool.localeCompare(b.pool));
    for (const r of byWallet) say(`| ${short(r.w)} | ${r.pool} | ${r.where} | ${num(r.lp, 18)} | ${r.under} | ${r.how} |`);
  }
  say();

  // 5. Recoverable vs needed.
  say(`## 5. What the team can recover, against what seeding needs`);
  let ethRec = 0n;
  for (const w of team) ethRec += teamHeld[w].eth;
  if (treasuryAddr) ethRec += held["TimbTreasury"]?.eth ?? 0n;
  ethRec += (book.cut ?? 0n) + (book.reserve ?? 0n);
  const guardianIsTeam = (k) => roleOf[k]?.guardian && team.includes(roleOf[k].guardian);
  for (const k of ["UnderwriteReserve", "DDJackpot"]) if (guardianIsTeam(k)) ethRec += held[k]?.eth ?? 0n;
  tokens.forEach((t, i) => {
    let v = 0n;
    for (const w of team) v += teamHeld[w].toks[i];
    if (treasuryAddr) v += held["TimbTreasury"]?.toks[i] ?? 0n;
    addRec(t, v);
  });
  const weth = tokens.find((t) => t.key === "WETH");
  say(`| Token | Recoverable | Seeding needs | Short by |`);
  say(`|---|---|---|---|`);
  const ethTotal = ethRec + ((weth && recover[weth.label]) || 0n);
  const row = (label, v, decimals, need) => {
    const have = Number(ethers.formatUnits(v, decimals));
    const shortBy = need != null && have < need ? (need - have).toLocaleString("en-US", { maximumFractionDigits: 4 }) : "";
    say(`| ${label} | ${num(v, decimals)} | ${need != null ? need.toLocaleString("en-US") : ""} | ${shortBy} |`);
  };
  row("ETH + WETH", ethTotal, 18, SEED_NEED.ETH);
  for (const t of tokens.filter((x) => x.key !== "WETH")) row(t.label + (t.carries ? "" : " — does not carry over"), recover[t.label] || 0n, t.decimals, SEED_NEED[t.key]);
  say();
  say(`ETH counts: team wallets, the treasury, the prize protocol cut, the vault's free reserve${["UnderwriteReserve", "DDJackpot"].some(guardianIsTeam) ? ", and the older reserves whose guardian is a team wallet" : ""}. Tokens count: team wallets, the treasury, and the team and treasury share of every pool. Gas for the withdrawals is not deducted.`);

  const text = out.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n");
}

if (require.main === module) {
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  main().catch((e) => {
    let msg = e.shortMessage || e.message;
    for (const u of [process.env.INVENTORY_RPC, process.env.ARB_SEPOLIA_RPC]) if (u) msg = msg.split(u).join("<RPC>");
    console.error("inventory failed:", msg);
    process.exit(1);
  });
}

module.exports = { short, lpUnderlying, num, parseWallets, lpSplit };
