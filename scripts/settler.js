// settler.js
// TimbSwap automated settler — runs via GitHub Actions every 10 minutes.
// Checks timeRemainingInSegment() on TimbPrize and calls settleSegment()
// when the interaction window has elapsed.
//
// One settleSegment() call resolves exactly one event: either a plain
// segment advance (segment N -> N+1), or — when the current segment is the
// 6th — the full round-boundary chain in one atomic transaction: lock the
// final digit, build the winning string, distribute the pot, expire old
// entries, then reset ALL 6 digit counters/locks and start the next round's
// segment 1 with a fresh segmentStartTime. That whole chain is one on-chain
// event even though a lot happens inside it.
//
// The previous version of this script only ever made ONE such call per run
// and exited. If a run was skipped, delayed, or this job was paused for a
// stretch, multiple segments (or a segment PLUS the round rollover) could
// go overdue at once. On the next run, settling just one of them and
// exiting left the rest still overdue — from the UI it reads as "the meter
// never reset," because the round-boundary call (the one that actually
// zeroes every counter back to 'A') may not be the call that happens to run
// next. This version drains the whole backlog in a single job run: it loops
// calling settleSegment() while a segment is overdue, so a lagging chain of
// events (including a round rollover) resolves as one connected sequence
// instead of trickling out over several 10-minute cron ticks.
//
// It also LINGERS: GitHub throttles the */10 cron to ~hourly in practice,
// and while a segment sits unsettled the whole game is stuck in its
// settlement window (nudges revert on-chain). Rather than exit when the
// segment isn't due, the run sleeps until the boundary and settles within
// seconds of it (budgeted by SETTLER_LINGER_MINUTES, default 65, enforced
// alongside the workflow's timeout + a concurrency group so overlapping
// scheduled runs queue instead of double-settling).

const { ethers } = require("ethers");
const { postRoundToX } = require("./xposter");

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL       = process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY   = process.env.SETTLER_PRIVATE_KEY;
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;        // ops: every message, incl. failures
const TG_CHAT_ID_PUBLIC = process.env.TELEGRAM_CHAT_ID_PUBLIC; // community group: round rollovers only
const TIMBPRIZE_ADDR = "0x35490DA1A7FF75C09eF90235Fdde700Fb04DB03F"; // TimbPrize v5 (forfeiture after later of claim/active)
const GAMEREGISTRY_ADDR = "0xD6c9001c6Bbb55761f7476009AaF5F71C21Fe0b5"; // GameRegistry v5 (forfeit at max(LER, wonRound+claim)+refund)

// ─── ABI (minimal) ───────────────────────────────────────────────────────────

const TIMBPRIZE_ABI = [
  "function timeRemainingInSegment() external view returns (uint256)",
  "function currentRound() external view returns (uint256)",
  "function currentSegment() external view returns (uint256)",
  "function segmentStartTime() external view returns (uint256)",
  "function settleSegment() external",
  "function gameStarted() external view returns (bool)",
  "function getRoundResult(uint256 round) external view returns (bytes6 winningString, uint256 potAmount, address[] winners, uint256 perWinner, uint256 remainder)"
];

const GAMEREGISTRY_ABI = [
  "function getRoundEntrants(uint256 round) external view returns (address[])"
];

// bytes6 hex ("0x4B375857 32 51") -> "K7XW2Q"
function bytes6ToStr(b6) {
  if (!b6 || b6 === "0x000000000000") return "??????";
  let s = "";
  for (let i = 2; i < 14; i += 2) {
    const code = parseInt(b6.slice(i, i + 2), 16);
    if (code > 0) s += String.fromCharCode(code);
  }
  return s;
}

// ─── Segment-delay alerting ──────────────────────────────────────────────────
// A segment is 60:00 on the grid (59:45 interaction + 0:15 intermission).
// If a rollover is still pending past these marks, tell Telegram how bad:
//   > 60:05 (5s past the grid mark)  → ⚠️ slightly later
//   > 60:30 (30s past the grid mark) → 🚨 critically delayed
const SEGMENT_TOTAL_S    = 60 * 60; // 60:00 grid slot
const DELAY_SLIGHT_S     = 5;
const DELAY_CRITICAL_S   = 30;

/** Alert (tiered) if this overdue segment blew past the 60:00 grid mark. */
async function alertIfDelayed(prize, round, segment) {
  try {
    const startTs  = await prize.segmentStartTime();
    const lateness = Math.floor(Date.now() / 1000) - (Number(startTs) + SEGMENT_TOTAL_S);
    if (lateness > DELAY_CRITICAL_S) {
      await notify(
        `🚨 CRITICALLY DELAYED segment\nRound #${round} | Segment ${segment}/6 ran ` +
        `${lateness}s past its 60:00 mark before settling. The keeper (or any ` +
        `interaction) didn't land in time — check GitHub cron health.`
      );
    } else if (lateness > DELAY_SLIGHT_S) {
      await notify(
        `⚠️ Slightly later segment\nRound #${round} | Segment ${segment}/6 ran ` +
        `${lateness}s past its 60:00 mark before settling.`
      );
    }
    return lateness;
  } catch (e) {
    console.warn(`[settler] delay check failed: ${e?.message || e}`);
    return null;
  }
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(chatId, text) {
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" })
    });
    if (!res.ok) console.error("[notify] Telegram error:", await res.text());
  } catch (e) {
    console.error("[notify] Failed to send Telegram message:", e.message);
  }
}

// Ops stream — every settle, delay alert, and failure goes here (private DM).
async function notify(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log("[notify] No Telegram config:", msg);
    return;
  }
  await sendTelegram(TG_CHAT_ID, `🔄 *TimbSwap Settler*\n${msg}`);
}

// Community stream — only clean, exciting beats (round rollovers), sent to
// the public group AFTER the tx confirms. Optional: silently skipped when
// TELEGRAM_CHAT_ID_PUBLIC isn't configured. Never carries ops/error detail.
async function notifyPublic(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID_PUBLIC) return;
  await sendTelegram(TG_CHAT_ID_PUBLIC, msg);
}

// Hard cap on settle calls per run — a ~340-min run covers up to 6 live
// boundaries, plus a backlogged round on arrival; 14 bounds the loop
// without ever cutting a healthy run short.
const MAX_SETTLES_PER_RUN = 14;

// ─── Linger mode ─────────────────────────────────────────────────────────────
// GitHub throttles the */10 cron to roughly hourly in practice, and the
// nominal 15-second settlement window really lasts "until this script lands
// a settle" — during which nudging is blocked on-chain. So instead of
// exiting when the segment isn't ready, the run stays alive and sleeps
// until the segment boundary, settles within seconds of it, then looks for
// the next boundary inside its budget. This turns an up-to-an-hour dead
// window into a few seconds.
//
// The budget must EXCEED one full segment (59:45): a run landing right
// after a boundary sees ~59.8 min remaining, and with a smaller budget it
// bails instead of covering that boundary (observed live: 3454s remaining
// vs the original 55-min budget).
//
// Originally 65 min — one boundary per run, handing off to the next cron
// tick. GitHub then left a 2.4-hour cron hole and Round 2 segment 1 ran
// 8734s past its 60:00 mark before anything settled it. Each run now
// lingers up to ~340 min (GitHub-hosted jobs cap at 6 h), covering ~5
// hourly boundaries back-to-back, so a single missed cron tick no longer
// strands the game — the previous run is still alive and settling.
const LINGER_BUDGET_MS =
  Number(process.env.SETTLER_LINGER_MINUTES || 340) * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settleOnce(provider, wallet, prize, round, segment) {
  // Gas config — 130% buffer on fee params (ecosystem pattern)
  const feeData = await provider.getFeeData();
  const maxFeePerGas         = feeData.maxFeePerGas         * 130n / 100n;
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * 130n / 100n;

  // Estimate gas with 50% buffer
  const gasEstimate = await prize.settleSegment.estimateGas();
  const gasLimit    = gasEstimate * 150n / 100n;

  // Explicit nonce — prevents NONCE_EXPIRED on rapid back-to-back calls
  const nonce = await provider.getTransactionCount(wallet.address, "pending");

  // segment 6 -> _settleRound(): builds the winning string, pays out,
  // expires old entries, and resets every counter for the next round.
  // Everything else is a plain single-segment advance.
  const isRoundBoundary = segment === 6n;

  const tx = await prize.settleSegment({
    maxFeePerGas,
    maxPriorityFeePerGas,
    gasLimit,
    nonce
  });

  console.log(`[settler] Submitted: ${tx.hash}`);
  await notify(
    isRoundBoundary
      ? `✅ Round #${round} settled (segment 6/6) — round #${round + 1n} starting fresh\nTx: \`${tx.hash}\``
      : `✅ Segment ${segment}/6 settled\nRound #${round}\nTx: \`${tx.hash}\``
  );

  const receipt = await tx.wait();
  console.log(`[settler] Confirmed in block ${receipt.blockNumber}`);

  // Community beat: announce the rollover in the public group only once the
  // round is actually settled on-chain (~every 6h, not the hourly segments).
  if (isRoundBoundary) {
    await notifyPublic(
      `📜 *Round #${round} has settled!*\n` +
      `The winning string is locked and the pot has been paid out on-chain.\n\n` +
      `🟢 Round #${round + 1n} is live — a fresh pot is building right now.\n` +
      `Enter or nudge the scroll → timbswap.xyz/compete`
    );

    // X post (opt-in via X_* secrets; see xposter.js). Fully fenced — a
    // failed read or post never affects settlement or the next loop turn.
    try {
      const registry = new ethers.Contract(GAMEREGISTRY_ADDR, GAMEREGISTRY_ABI, provider);
      const [res, entrants] = await Promise.all([
        prize.getRoundResult(round),
        registry.getRoundEntrants(round).catch(() => [])
      ]);
      const potEth = Number(ethers.formatEther(res.potAmount ?? res[1])).toFixed(4).replace(/\.?0+$/, "") || "0";
      await postRoundToX({
        round:   Number(round),
        string6: bytes6ToStr(res.winningString ?? res[0]),
        entries: entrants.length,
        potEth,
        winners: (res.winners ?? res[2]).length
      });
    } catch (e) {
      console.warn("[xposter] round post skipped:", e?.message || e);
    }
  }
  return isRoundBoundary;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!RPC_URL)      throw new Error("Missing ARB_SEPOLIA_RPC");
  if (!PRIVATE_KEY)  throw new Error("Missing SETTLER_PRIVATE_KEY");

  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);
  const prize    = new ethers.Contract(TIMBPRIZE_ADDR, TIMBPRIZE_ABI, wallet);

  // ── Sanity checks ────────────────────────────────────────────────────────

  const started = await prize.gameStarted();
  if (!started) {
    console.log("[settler] Game not started yet — exiting.");
    return;
  }

  // ── Drain the backlog: settle every overdue segment/round-boundary event
  //    this run finds, instead of stopping after the first one. Each
  //    iteration re-reads on-chain state, so a round rollover mid-loop is
  //    picked up correctly on the very next iteration.

  const startedAt   = Date.now();
  let settledCount  = 0;
  let roundsRolled  = 0;

  while (settledCount < MAX_SETTLES_PER_RUN) {
    const round     = await prize.currentRound();
    const segment   = await prize.currentSegment();
    const remaining = await prize.timeRemainingInSegment();

    console.log(`[settler] Round #${round} | Segment ${segment}/6 | ${remaining}s remaining`);

    if (remaining > 0n) {
      // Not due yet — linger to the boundary if it fits in this run's
      // budget, otherwise hand off to the next scheduled run.
      const waitMs = Number(remaining) * 1000 + 5_000; // small buffer past 59:45
      if (Date.now() - startedAt + waitMs > LINGER_BUDGET_MS) {
        console.log(`[settler] Next boundary is beyond this run's linger budget — exiting; next run picks it up.`);
        break;
      }
      console.log(`[settler] Lingering ${Math.round(waitMs / 1000)}s until the segment boundary…`);
      await sleep(waitMs);
      continue;
    }

    console.log(`[settler] Segment ready. Calling settleSegment()...`);
    // Tiered Telegram alert if this segment blew past its 60:00 grid mark
    // (>60:03 slight, >60:10 major) before we could settle it.
    await alertIfDelayed(prize, round, segment);
    try {
      const wasRoundBoundary = await settleOnce(provider, wallet, prize, round, segment);
      settledCount++;
      if (wasRoundBoundary) roundsRolled++;
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      console.error(`[settler] settleSegment() failed: ${msg}`);
      await notify(`❌ settleSegment() FAILED\nRound #${round} | Segment ${segment}/6\nError: ${msg}`);
      process.exit(1);
    }
  }

  if (settledCount === 0) {
    console.log("[settler] Nothing to settle this run.");
  } else {
    console.log(`[settler] Settled ${settledCount} event(s) this run (${roundsRolled} round rollover(s)).`);
    if (settledCount === MAX_SETTLES_PER_RUN) {
      // Hit the cap — there may still be more overdue than one run should
      // ever need to catch up in practice; flag it instead of looping more.
      await notify(
        `⚠️ Settled the max of ${MAX_SETTLES_PER_RUN} events this run and stopped — ` +
        `there may still be a backlog. Will keep draining on the next run.`
      );
    }
  }
}

main().catch(async (err) => {
  console.error("[settler] Fatal error:", err.message);
  await notify(`💥 Settler fatal error\n${err.message}`);
  process.exit(1);
});
