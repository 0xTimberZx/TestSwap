// epoch.js
// TimbSwap epoch distributor — the keeper for the 6-round reward waterfall
// (dev-docs/BOOSTED_FARMS_SPEC.md). Runs via GitHub Actions on a slow cron.
//
// Every 6 rounds (one EPOCH), one shared budget z = TIMBS collected into the
// Treasury this epoch is distributed in strict priority order:
//
//   B = z
//   farmGrant  = min(0.80 × y, B)        y = main-farm claims this epoch
//   B         -= farmGrant
//   stakeGrant = min(1.25 × w, 0.80 × B) w = staking claims this epoch
//   B         -= stakeGrant
//   boostBudget = B                       5%-per-claim boost draws until empty
//
// Farm cleaning out the budget starves staking AND boost. Staking cleaning
// out the remainder starves boost. Boost exhausting its remainder ends draws
// until the next cycle. Total epoch outflow can never exceed z.
//
// Between epoch settlements, every run batches the boost stream: 5% of the
// main-farm RewardsClaimed volume since the last run is drawn from the
// Treasury into TimbBoostFarm.notifyRewardAmount(), clamped to what remains
// of boostBudget. Batching at keeper cadence is economically equivalent to
// per-claim draws because boost emissions self-target over ~6 rounds anyway.
//
// IMPORTANT — key requirements:
//   EPOCH_PRIVATE_KEY must be the TimbTreasury OWNER: distributeToStaking()
//   and withdrawToken() are onlyOwner. This is a bigger key than the
//   settler's (which only calls permissionless functions) — scope the secret
//   accordingly.
//
// State: scripts/epoch-state.json, committed back by the workflow with
// [skip ci]. Stateless recovery is impossible here because a zero-grant
// epoch leaves no on-chain marker — the state file is the cursor. First run
// needs EPOCH_GENESIS_BLOCK to bound the first event scan.

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL     = process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY = process.env.EPOCH_PRIVATE_KEY;
const TG_TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID  = process.env.TELEGRAM_CHAT_ID;
const DRY_RUN     = process.argv.includes("--dry-run");

const STATE_PATH  = path.join(__dirname, "epoch-state.json");
const ROUNDS_PER_EPOCH = 6;
const FARM_SHARE_BPS   = 8_000;  // 0.80 × y
const STAKE_BOOST_BPS  = 12_500; // 1.25 × w
const STAKE_CAP_BPS    = 8_000;  // ≤ 0.80 × leftover
const BOOST_DRAW_BPS   = 500;    // 5% of each farm claim
const LOG_CHUNK        = 50_000; // getLogs block-range chunk

// Addresses from config.js — same single source of truth as the settler.
function addrFromConfig(key, { optional = false } = {}) {
  const src = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
  const m = src.match(new RegExp("\\b" + key + '\\s*:\\s*"(0x[0-9a-fA-F]{40})"'));
  if (!m) {
    if (optional) return null;
    throw new Error(`Address "${key}" not found in config.js — refusing to start epoch keeper`);
  }
  return ethers.getAddress(m[1]);
}

const TIMBPRIZE_ADDR   = addrFromConfig("TimbPrize");
const TIMBSTAKING_ADDR = addrFromConfig("TimbStaking");
const TIMBFARM_ADDR    = addrFromConfig("TimbFarm");
const TREASURY_ADDR    = addrFromConfig("TimbTreasury");
const TIMBS_ADDR       = addrFromConfig("TIMBSToken");
// Boost farm ships after this keeper — treat "not in config yet" as disabled.
const BOOSTFARM_ADDR   = addrFromConfig("TimbBoostFarm", { optional: true });

// ─── ABIs (minimal) ──────────────────────────────────────────────────────────

const PRIZE_ABI = [
  "function currentRound() external view returns (uint256)",
  "function ROUND_DURATION() external view returns (uint256)",
];
const CLAIM_EVENT_ABI = [
  "event RewardsClaimed(address indexed user, uint256 amount)",
];
const TREASURY_ABI = [
  "event BuybackExecuted(uint256 ethSpent, uint256 timbsBought, uint256 timbsBurned, uint256 timbsToStaking)",
  "function distributeToStaking(uint256 timbsAmount, uint256 duration) external",
  "function withdrawToken(address token, address to, uint256 amount) external",
];
const FARM_ABI = [
  "function notifyRewardAmount(uint256 amount, uint256 duration) external",
];
const BOOST_ABI = [
  "function notifyRewardAmount(uint256 amount) external",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address) external view returns (uint256)",
];

// ─── State ───────────────────────────────────────────────────────────────────

function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  }
  const genesis = process.env.EPOCH_GENESIS_BLOCK;
  if (!genesis) {
    throw new Error(
      "No epoch-state.json and no EPOCH_GENESIS_BLOCK — cannot bound the first scan. " +
      "Set EPOCH_GENESIS_BLOCK to the block you want epoch #1 to start measuring from."
    );
  }
  return {
    lastEpochRound: 0,          // round at last settlement (0 = never settled)
    lastEpochBlock: Number(genesis),
    boostCursorBlock: Number(genesis),
    boostBudget: "0",           // wei strings — JSON-safe
    boostDrawn:  "0",
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ─── Event scans (chunked getLogs) ───────────────────────────────────────────

async function sumEvents(provider, address, iface, eventName, fromBlock, toBlock, pick) {
  let total = 0n;
  const topic = iface.getEvent(eventName).topicHash;
  for (let from = fromBlock; from <= toBlock; from += LOG_CHUNK) {
    const to = Math.min(from + LOG_CHUNK - 1, toBlock);
    const logs = await provider.getLogs({ address, topics: [topic], fromBlock: from, toBlock: to });
    for (const log of logs) {
      total += pick(iface.parseLog(log).args);
    }
  }
  return total;
}

// ─── Telegram (ops-only, best-effort) ────────────────────────────────────────

async function tg(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (e) { console.error("telegram failed (non-fatal):", e.message); }
}

const fmt = (wei) => ethers.formatEther(wei);

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!RPC_URL)     throw new Error("ARB_SEPOLIA_RPC not set");
  if (!PRIVATE_KEY && !DRY_RUN) throw new Error("EPOCH_PRIVATE_KEY not set (or use --dry-run)");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = PRIVATE_KEY ? new ethers.Wallet(PRIVATE_KEY, provider) : null;

  const prize    = new ethers.Contract(TIMBPRIZE_ADDR, PRIZE_ABI, provider);
  const treasury = new ethers.Contract(TREASURY_ADDR, TREASURY_ABI, wallet ?? provider);
  const farm     = new ethers.Contract(TIMBFARM_ADDR, FARM_ABI, wallet ?? provider);
  const timbs    = new ethers.Contract(TIMBS_ADDR, ERC20_ABI, wallet ?? provider);
  const boost    = BOOSTFARM_ADDR ? new ethers.Contract(BOOSTFARM_ADDR, BOOST_ABI, wallet ?? provider) : null;

  const claimsIface   = new ethers.Interface(CLAIM_EVENT_ABI);
  const treasuryIface = new ethers.Interface(TREASURY_ABI);

  const state    = loadState();
  const nowBlock = await provider.getBlockNumber();
  const round    = Number(await prize.currentRound());
  const epochOf  = (r) => Math.floor((r - 1) / ROUNDS_PER_EPOCH); // rounds 1-6 = epoch 0

  console.log(`round=${round} epoch=${epochOf(round)} lastEpochRound=${state.lastEpochRound} block=${nowBlock}`);

  // ── 1. Epoch settlement — beginning of each 6-round block ────────────────
  const due = state.lastEpochRound === 0
    ? round > ROUNDS_PER_EPOCH               // let the first full epoch elapse
    : epochOf(round) > epochOf(state.lastEpochRound);

  if (due) {
    const fromBlock = state.lastEpochBlock + 1;

    const y = await sumEvents(provider, TIMBFARM_ADDR, claimsIface, "RewardsClaimed",
      fromBlock, nowBlock, (a) => a.amount);
    const w = await sumEvents(provider, TIMBSTAKING_ADDR, claimsIface, "RewardsClaimed",
      fromBlock, nowBlock, (a) => a.amount);
    // z = TIMBS that stayed in the Treasury from buybacks (bought − burned −
    // routed straight to staking at buyback time).
    const z = await sumEvents(provider, TREASURY_ADDR, treasuryIface, "BuybackExecuted",
      fromBlock, nowBlock, (a) => a.timbsBought - a.timbsBurned - a.timbsToStaking);

    // Waterfall — farm → staking → boost, one shared budget, never exceeds z.
    let B = z;
    const farmGrant = (() => { const g = (y * BigInt(FARM_SHARE_BPS)) / 10_000n; return g < B ? g : B; })();
    B -= farmGrant;
    const stakeWant = (w * BigInt(STAKE_BOOST_BPS)) / 10_000n;
    const stakeCap  = (B * BigInt(STAKE_CAP_BPS)) / 10_000n;
    const stakeGrant = stakeWant < stakeCap ? stakeWant : stakeCap;
    B -= stakeGrant;
    const boostBudget = B;

    const duration = Number(await prize.ROUND_DURATION()) * ROUNDS_PER_EPOCH;

    console.log(`EPOCH SETTLE  z=${fmt(z)} y=${fmt(y)} w=${fmt(w)}`);
    console.log(`  farmGrant=${fmt(farmGrant)} stakeGrant=${fmt(stakeGrant)} boostBudget=${fmt(boostBudget)} duration=${duration}s`);

    if (!DRY_RUN) {
      // Solvency: grants draw on the Treasury's whole TIMBS balance (z only
      // bounds the budget); fail loudly if the balance can't cover them.
      const treasuryBal = await timbs.balanceOf(TREASURY_ADDR);
      if (farmGrant + stakeGrant > treasuryBal) {
        throw new Error(`Treasury TIMBS balance ${fmt(treasuryBal)} < grants ${fmt(farmGrant + stakeGrant)}`);
      }
      if (farmGrant > 0n) {
        await (await treasury.withdrawToken(TIMBS_ADDR, wallet.address, farmGrant)).wait();
        await (await timbs.approve(TIMBFARM_ADDR, farmGrant)).wait();
        await (await farm.notifyRewardAmount(farmGrant, duration)).wait();
        console.log("  farm funded ✓");
      }
      if (stakeGrant > 0n) {
        await (await treasury.distributeToStaking(stakeGrant, duration)).wait();
        console.log("  staking funded ✓");
      }
    }

    state.lastEpochRound   = round;
    state.lastEpochBlock   = nowBlock;
    state.boostCursorBlock = nowBlock;
    state.boostBudget      = boostBudget.toString();
    state.boostDrawn       = "0";
    saveState(state);

    await tg(
      `⚙️ Epoch settled @ round ${round}\n` +
      `z=${fmt(z)} y=${fmt(y)} w=${fmt(w)}\n` +
      `farm=${fmt(farmGrant)} stake=${fmt(stakeGrant)} boostBudget=${fmt(boostBudget)}` +
      (DRY_RUN ? "\n(dry-run — no txs)" : "")
    );
  } else {
    console.log("epoch not due");
  }

  // ── 2. Boost stream — 5% of new main-farm claims, within boostBudget ─────
  if (boost) {
    const budget = BigInt(state.boostBudget) - BigInt(state.boostDrawn);
    if (budget > 0n && nowBlock > state.boostCursorBlock) {
      const claims = await sumEvents(provider, TIMBFARM_ADDR, claimsIface, "RewardsClaimed",
        state.boostCursorBlock + 1, nowBlock, (a) => a.amount);
      let draw = (claims * BigInt(BOOST_DRAW_BPS)) / 10_000n;
      if (draw > budget) draw = budget; // truncate at the cap, then stop until next cycle

      if (draw > 0n) {
        console.log(`BOOST DRAW  claims=${fmt(claims)} draw=${fmt(draw)} budgetLeft=${fmt(budget - draw)}`);
        if (!DRY_RUN) {
          await (await treasury.withdrawToken(TIMBS_ADDR, wallet.address, draw)).wait();
          await (await timbs.approve(BOOSTFARM_ADDR, draw)).wait();
          await (await boost.notifyRewardAmount(draw)).wait();
          console.log("  boost funded ✓");
        }
        state.boostDrawn = (BigInt(state.boostDrawn) + draw).toString();
        await tg(`🚀 Boost draw ${fmt(draw)} TIMBS (budget left ${fmt(budget - draw)})` + (DRY_RUN ? " (dry-run)" : ""));
      } else {
        console.log("no new farm claims — no boost draw");
      }
      state.boostCursorBlock = nowBlock;
      saveState(state);
    } else {
      console.log(budget <= 0n ? "boost budget exhausted — waiting for next epoch" : "no new blocks for boost scan");
    }
  } else {
    console.log("TimbBoostFarm not in config.js yet — boost stream disabled");
  }
}

main().catch(async (err) => {
  console.error("EPOCH KEEPER FAILED:", err);
  await tg(`🔴 Epoch keeper failed: ${err.message}`);
  process.exit(1);
});
