// wind-down-lp.js — take one wallet's LP out of the old testnet, straight to a recipient.
//
// The wind-down inventory showed most of the team's pool liquidity staked by
// the leaked deployer wallet (0x4253…9800), whose key is still the
// DEPLOYER_PRIVATE_KEY secret. This signs as that wallet (or any wallet whose
// key it is given) and, in order:
//
//   1. TimbFarm.emergencyWithdraw()            if it has LP staked there
//   2. TimbBoostFarm.emergencyWithdraw(pid)    for every pool it has LP staked in
//      (emergencyWithdraw forfeits the pending rewards, which are old TIMBS
//      and worthless, so a short reward balance can never block the exit)
//   3. for every pool on the old factory where it then holds LP: approve the
//      old router if needed, then removeLiquidity(..., to = recipient). The
//      tokens go straight to the recipient and never sit in the wallet.
//
// Gas: the leaked wallet was swept, so it may hold almost no ETH. With
// WIND_DOWN_LP_GAS_KEY set (the old owner's key), the run first tops the
// signer up to GAS_TARGET from that wallet, capped at GAS_MAX.
//
// Dry run by default: it simulates the farm exits and approvals from the
// signer and lists the removals it would make (a removal can only be
// simulated once its LP is in the wallet and approved, so the run re-reads
// the chain before each step). Removal minimums are 0: testnet, and the
// router call is atomic, so nobody can take the LP between steps.
//
// Env:
//   WIND_DOWN_LP_PRIVATE_KEY  the wallet whose LP comes out
//   WIND_DOWN_LP_GAS_KEY      optional: a wallet that pays the signer's gas
//   WIND_DOWN_TO              recipient (default TSDeployer 0xAA68…d3a5)
//   WIND_DOWN_RPC             RPC (default: the public RPC in config.js)
//   GITHUB_STEP_SUMMARY       set by Actions; the report is appended there too
// Args: --execute (send), --self-test

const fs = require("fs");
const { ethers } = require("ethers");
const { configSrc, addrFromConfig, rpcFromConfig } = require("./lib/config");
const { checkRecipient, short } = require("./wind-down-owner");

const CHAIN_ID = 421614;
const DEFAULT_TO = "0xAA6820D22cF59C9d143fe1a943F19FE6EcdAd3a5";
const GAS_MIN = ethers.parseEther("0.002");    // top up below this
const GAS_TARGET = ethers.parseEther("0.004"); // to this
const GAS_MAX = ethers.parseEther("0.005");    // never send more than this in one top-up

const FARM = ["function stakedBalance(address) view returns (uint256)", "function lpToken() view returns (address)", "function emergencyWithdraw()"];
const BOOST = ["function poolCount() view returns (uint256)",
  "function poolInfo(uint256) view returns (address lpToken, uint256 weight, uint256 lastRewardTime, uint256 accRewardPerShare, uint256 totalStaked, bool paused)",
  "function userInfo(uint256, address) view returns (uint256 amount, uint256 rewardDebt, uint256 pending)",
  "function emergencyWithdraw(uint256)"];
const FACTORY = ["function allPairsLength() view returns (uint256)", "function allPairs(uint256) view returns (address)"];
const PAIR = ["function token0() view returns (address)", "function token1() view returns (address)", "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)",
  "function totalSupply() view returns (uint256)", "function getReserves() view returns (uint112, uint112, uint32)"];
const ERC20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
const ROUTER = ["function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) returns (uint256,uint256)"];

/** Pure: how much gas ETH to send the signer (0 if it has enough). */
function gasTopUp(balance) {
  if (balance >= GAS_MIN) return 0n;
  const want = GAS_TARGET - balance;
  return want > GAS_MAX ? GAS_MAX : want;
}

function selfTest() {
  let pass = 0, fail = 0;
  const eq = (name, got, want) => { if (got === want) pass++; else { fail++; console.log(`FAIL ${name}: got ${got}, want ${want}`); } };
  eq("no top-up when funded", gasTopUp(GAS_MIN), 0n);
  eq("top-up to target", gasTopUp(ethers.parseEther("0.0001")), ethers.parseEther("0.0039"));
  eq("top-up from empty", gasTopUp(0n), GAS_TARGET);
  eq("top-up never above cap", gasTopUp(0n) <= GAS_MAX, true);
  console.log(`self-test: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const provider = new ethers.JsonRpcProvider(process.env.WIND_DOWN_RPC || rpcFromConfig());
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== CHAIN_ID) throw new Error(`expected Arbitrum Sepolia (${CHAIN_ID}), got chain ${chainId}`);
  const key = (process.env.WIND_DOWN_LP_PRIVATE_KEY || "").trim();
  if (!key) throw new Error("WIND_DOWN_LP_PRIVATE_KEY is not set");
  const signer = new ethers.Wallet(key, provider);
  const to = checkRecipient(process.env.WIND_DOWN_TO || DEFAULT_TO, signer.address);
  const gasKey = (process.env.WIND_DOWN_LP_GAS_KEY || "").trim();
  const src = configSrc();
  const addr = (k) => addrFromConfig(k, { src });

  const out = [];
  const say = (l = "") => { out.push(l); console.log(l); };
  say(`# Old testnet LP exit (${execute ? "RUN" : "dry run"})`);
  say(`Signer ${short(signer.address)} → recipient ${short(to)} · block ${await provider.getBlockNumber()}`);
  say();

  const farm = new ethers.Contract(addr("TimbFarm"), FARM, signer);
  const boost = new ethers.Contract(addr("TimbBoostFarm"), BOOST, signer);
  const router = new ethers.Contract(addr("TimbSwapRouter"), ROUTER, signer);
  const factory = new ethers.Contract(addr("TimbSwapFactory"), FACTORY, provider);
  const routerAddr = await router.getAddress();

  // What is staked where.
  const exits = [];
  const farmStake = await farm.stakedBalance(signer.address).catch(() => 0n);
  if (farmStake > 0n) exits.push({ label: `TimbFarm.emergencyWithdraw()  ${ethers.formatEther(farmStake)} LP`, c: farm, fn: "emergencyWithdraw", args: [] });
  const nPools = Number(await boost.poolCount().catch(() => 0n));
  for (let pid = 0; pid < nPools; pid++) {
    const u = await boost.userInfo(pid, signer.address).catch(() => null);
    if (u && u.amount > 0n) exits.push({ label: `TimbBoostFarm.emergencyWithdraw(${pid})  ${ethers.formatEther(u.amount)} LP`, c: boost, fn: "emergencyWithdraw", args: [pid] });
  }

  // Pools, and what the signer's LP (wallet + staked) is worth.
  const pairs = [];
  const n = Number(await factory.allPairsLength());
  for (let i = 0; i < n; i++) {
    const pa = await factory.allPairs(i);
    const p = new ethers.Contract(pa, PAIR, signer);
    const [t0, t1] = await Promise.all([p.token0(), p.token1()]);
    const meta = async (t) => { const c = new ethers.Contract(t, ERC20, provider); return [await c.symbol().catch(() => short(t)), Number(await c.decimals().catch(() => 18n))]; };
    const [[s0, d0], [s1, d1]] = await Promise.all([meta(t0), meta(t1)]);
    pairs.push({ pa, p, t0, t1, name: `${s0}/${s1}`, s0, s1, d0, d1 });
  }
  let staked = {};
  if (farmStake > 0n) { const lp = String(await farm.lpToken()).toLowerCase(); staked[lp] = (staked[lp] || 0n) + farmStake; }
  for (let pid = 0; pid < nPools; pid++) {
    const u = await boost.userInfo(pid, signer.address).catch(() => null);
    if (!u || u.amount === 0n) continue;
    const info = await boost.poolInfo(pid); const lp = info.lpToken.toLowerCase();
    staked[lp] = (staked[lp] || 0n) + u.amount;
  }
  const worth = async (x, lp) => {
    const [ts, r] = await Promise.all([x.p.totalSupply(), x.p.getReserves()]);
    if (ts === 0n) return "0";
    return `${ethers.formatUnits((lp * r[0]) / ts, x.d0)} ${x.s0} · ${ethers.formatUnits((lp * r[1]) / ts, x.d1)} ${x.s1}`;
  };

  say(`## Plan`);
  for (const e of exits) {
    try { await e.c[e.fn].staticCall(...e.args); say(`- ok   ${e.label}`); e.ok = true; }
    catch (err) { say(`- SKIP ${e.label}: would revert (${(err.shortMessage || err.message).slice(0, 140)})`); }
  }
  const removals = [];
  for (const x of pairs) {
    const lp = (await x.p.balanceOf(signer.address)) + (staked[x.pa.toLowerCase()] || 0n);
    if (lp === 0n) continue;
    removals.push(x);
    say(`- then removeLiquidity ${x.name}: ${ethers.formatEther(lp)} LP ≈ ${await worth(x, lp)} → ${short(to)}`);
  }
  if (!exits.length && !removals.length) say(`- nothing: ${short(signer.address)} holds no LP in the old pools or farms`);

  const bal = await provider.getBalance(signer.address);
  const topUp = gasTopUp(bal);
  const txCount = exits.length + removals.length * 2;
  say();
  say(`Signer gas: ${ethers.formatEther(bal)} ETH for about ${txCount} transactions${topUp > 0n ? `; needs a top-up of ${ethers.formatEther(topUp)} ETH${gasKey ? " from the gas wallet" : " (set fund_gas, or send it from TSDeployer)"}` : ""}.`);
  say();

  if (!execute) {
    say(`Dry run: nothing sent.`);
  } else {
    say(`## Sent`);
    let failed = 0;
    const send = async (label, fn) => {
      try { const tx = await fn(); const rc = await tx.wait(); say(`- sent ${label}  ${rc.hash}`); return true; }
      catch (err) { failed++; say(`- FAIL ${label}: ${(err.shortMessage || err.message).slice(0, 160)}${err.data ? ` [${String(err.data).slice(0, 74)}]` : ""}`); return false; }
    };
    if (topUp > 0n) {
      if (!gasKey) throw new Error(`the signer has ${ethers.formatEther(bal)} ETH; fund its gas first (fund_gas, or send ${ethers.formatEther(topUp)} ETH from TSDeployer)`);
      const funder = new ethers.Wallet(gasKey, provider);
      await send(`gas ${ethers.formatEther(topUp)} ETH from ${short(funder.address)} to ${short(signer.address)}`, () => funder.sendTransaction({ to: signer.address, value: topUp }));
    }
    // Explicit nonces: back-to-back sends otherwise reuse one.
    let nonce = await provider.getTransactionCount(signer.address, "pending");
    const sendS = async (label, fn) => { const ok = await send(label, () => fn({ nonce })); nonce = ok ? nonce + 1 : await provider.getTransactionCount(signer.address, "pending"); return ok; };
    for (const e of exits.filter((x) => x.ok)) await sendS(e.label, (o) => e.c[e.fn](...e.args, o));
    // Deadline from the chain's clock, not the runner's (they can disagree).
    const deadline = (await provider.getBlock("latest")).timestamp + 1800;
    for (const x of removals) {
      const lp = await x.p.balanceOf(signer.address); // re-read: the exits above have landed
      if (lp === 0n) { say(`- note ${x.name}: no LP in the wallet after the exits`); continue; }
      const w = await worth(x, lp);
      if ((await x.p.allowance(signer.address, routerAddr)) < lp) {
        if (!(await sendS(`approve ${x.name} LP to the old router`, (o) => x.p.approve(routerAddr, lp, o)))) continue;
      }
      await sendS(`removeLiquidity ${x.name} ${ethers.formatEther(lp)} LP ≈ ${w} → ${short(to)}`,
        (o) => router.removeLiquidity(x.t0, x.t1, lp, 0, 0, to, deadline, o));
    }
    if (failed) { process.exitCode = 1; say(`${failed} call(s) failed; a re-run is safe (it reads the chain again).`); }
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join("\n") + "\n");
}

if (require.main === module) {
  if (process.argv.includes("--self-test")) process.exit(selfTest() ? 0 : 1);
  main().catch((e) => {
    let msg = e.shortMessage || e.message;
    if (process.env.WIND_DOWN_RPC) msg = msg.split(process.env.WIND_DOWN_RPC).join("<RPC>");
    console.error("LP exit failed:", msg);
    process.exit(1);
  });
}

module.exports = { gasTopUp };
