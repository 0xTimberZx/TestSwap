// testnet-status.js — one read-only snapshot of the live testnet set.
//
// Reads the contracts named in config.js and prints: the game (started, round,
// segment, pot, settler, VRF wiring and whether PrizeVRFEntropy is a consumer
// on its subscription), the faucet (roles, pauses, balances), the treasury,
// the farm and staking reward windows, and the ETH / TIMBS of the keeper and
// team wallets passed in STATUS_WALLETS. Signs nothing.
//
// Env:
//   STATUS_RPC      Arbitrum Sepolia RPC (default: config.js public RPC)
//   STATUS_WALLETS  comma-separated label=address pairs to show balances for

"use strict";

const { ethers } = require("ethers");
const { addrFromConfig, rpcFromConfig } = require("./lib/config");

const PRIZE = ["function owner() view returns (address)", "function settler() view returns (address)",
  "function entropy() view returns (address)", "function gameStarted() view returns (bool)",
  "function currentRound() view returns (uint256)", "function currentSegment() view returns (uint256)",
  "function segmentStartTime() view returns (uint256)", "function SEGMENT_DURATION() view returns (uint256)",
  "function currentAccumulatedRewards() view returns (uint256)", "function entriesPaused() view returns (bool)"];
const ENTROPY = ["function owner() view returns (address)", "function coordinator() view returns (address)",
  "function subId() view returns (uint256)"];
const COORD = ["function getSubscription(uint256) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address subOwner, address[] consumers)"];
const FAUCET = ["function owner() view returns (address)", "function dispatcher() view returns (address)",
  "function guardian() view returns (address)", "function ethPaused() view returns (bool)",
  "function timbsPaused() view returns (bool)", "function ethCap() view returns (uint256)", "function timbsCap() view returns (uint256)"];
const OWNABLE = ["function owner() view returns (address)"];
const POOL = ["function owner() view returns (address)", "function periodFinish() view returns (uint256)",
  "function rewardRatePerSecond() view returns (uint256)", "function totalStaked() view returns (uint256)"];
const ERC20 = ["function balanceOf(address) view returns (uint256)"];

const fmt = (v, d = 18, p = 4) => Number(ethers.formatUnits(v, d)).toLocaleString("en-US", { maximumFractionDigits: p });
const iso = (s) => (Number(s) ? new Date(Number(s) * 1000).toISOString().replace(".000Z", "Z") : "-");
const tryCall = async (f) => { try { return await f(); } catch (e) { return `error: ${e.shortMessage || e.message}`.slice(0, 80); } };

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.STATUS_RPC || rpcFromConfig());
  const block = await provider.getBlock("latest");
  const c = (key, abi) => new ethers.Contract(addrFromConfig(key), abi, provider);
  const timbs = c("TIMBSToken", ERC20);
  const ethOf = (a) => provider.getBalance(a);
  const out = [];
  const say = (s = "") => { out.push(s); console.log(s); };

  say(`## Testnet status at block ${block.number} (${iso(block.timestamp)})`);

  const prize = c("TimbPrize", PRIZE);
  const [owner, settler, ent, started, round, seg, segStart, segDur, pot, paused] = await Promise.all([
    prize.owner(), prize.settler(), prize.entropy(), prize.gameStarted(), prize.currentRound(), prize.currentSegment(),
    prize.segmentStartTime(), prize.SEGMENT_DURATION(), prize.currentAccumulatedRewards(), prize.entriesPaused()]);
  say("\n### Game: TimbPrize " + prize.target);
  say(`- started: **${started}**, round ${round}, segment ${seg}, segment opened ${iso(segStart)} (segment length ${segDur}s)`);
  say(`- pot ${fmt(pot)} ETH, contract balance ${fmt(await ethOf(prize.target))} ETH, entries paused: ${paused}`);
  say(`- owner ${owner}, settler ${settler}`);
  const cfgEntropy = addrFromConfig("PrizeVRFEntropy");
  say(`- entropy ${ent}${ent === cfgEntropy ? " (matches config.js PrizeVRFEntropy)" : ` (config.js says ${cfgEntropy})`}`);

  const entropy = new ethers.Contract(ent, ENTROPY, provider);
  const [eOwner, coordAddr, subId] = await Promise.all([entropy.owner(), entropy.coordinator(), entropy.subId()]);
  const sub = await tryCall(() => new ethers.Contract(coordAddr, COORD, provider).getSubscription(subId));
  say("\n### VRF");
  say(`- PrizeVRFEntropy owner ${eOwner}, coordinator ${coordAddr}, sub …${subId.toString().slice(-4)}`);
  if (typeof sub === "string") say(`- subscription: ${sub}`);
  else {
    const isConsumer = sub.consumers.map((a) => a.toLowerCase()).includes(ent.toLowerCase());
    say(`- subscription owner ${sub.subOwner}, ${fmt(sub.balance)} LINK + ${fmt(sub.nativeBalance)} ETH, ${sub.reqCount} requests`);
    say(`- consumers (${sub.consumers.length}): ${sub.consumers.join(", ")}; PrizeVRFEntropy is a consumer: **${isConsumer}**`);
  }

  const faucet = c("GasFaucet", FAUCET);
  const [fOwner, disp, guard, eP, tP, eCap, tCap] = await Promise.all([faucet.owner(), faucet.dispatcher(),
    faucet.guardian(), faucet.ethPaused(), faucet.timbsPaused(), faucet.ethCap(), faucet.timbsCap()]);
  say("\n### Faucet: GasFaucet " + faucet.target);
  say(`- owner ${fOwner}, dispatcher ${disp}, guardian ${guard}`);
  say(`- holds ${fmt(await ethOf(faucet.target))} ETH and ${fmt(await timbs.balanceOf(faucet.target))} TIMBS; caps ${fmt(eCap)} ETH / ${fmt(tCap)} TIMBS; paused: ETH ${eP}, TIMBS ${tP}`);

  const treasury = c("TimbTreasury", OWNABLE);
  say("\n### Treasury and reward pools");
  say(`- TimbTreasury ${treasury.target}: owner ${await treasury.owner()}, ${fmt(await ethOf(treasury.target))} ETH, ${fmt(await timbs.balanceOf(treasury.target))} TIMBS`);
  for (const k of ["TimbFarm", "TimbStaking"]) {
    const p = c(k, POOL);
    const [o, fin, rate, staked] = await Promise.all([p.owner(), p.periodFinish(), p.rewardRatePerSecond(), p.totalStaked()]);
    say(`- ${k} ${p.target}: owner ${o}, ${fmt(rate * 86400n, 18, 2)} TIMBS/day until ${iso(fin)}, staked ${fmt(staked)}, holds ${fmt(await timbs.balanceOf(p.target))} TIMBS`);
  }

  const wallets = (process.env.STATUS_WALLETS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (wallets.length) {
    say("\n### Wallets");
    for (const w of wallets) {
      const [label, a] = w.includes("=") ? w.split("=") : [w, w];
      const addr = ethers.getAddress(a.trim());
      say(`- ${label.trim()} ${addr}: ${fmt(await ethOf(addr))} ETH, ${fmt(await timbs.balanceOf(addr))} TIMBS`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) require("fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join("\n") + "\n");
}

main().catch((e) => { console.error(`::error::${e.shortMessage || e.message}`); process.exit(1); });
