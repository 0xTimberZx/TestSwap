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

const { ethers } = require("ethers");

// ─── Config ──────────────────────────────────────────────────────────────────

const RPC_URL       = process.env.ARB_SEPOLIA_RPC;
const PRIVATE_KEY   = process.env.SETTLER_PRIVATE_KEY;
const TG_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const TIMBPRIZE_ADDR = "0x03a895DD42893dD20EF39420fDc93FE86E3c6055"; // TimbPrize v2 (ticket model + yield vault)

// ─── ABI (minimal) ───────────────────────────────────────────────────────────

const TIMBPRIZE_ABI = [
  "function timeRemainingInSegment() external view returns (uint256)",
  "function currentRound() external view returns (uint256)",
  "function currentSegment() external view returns (uint256)",
  "function settleSegment() external",
  "function gameStarted() external view returns (bool)"
];

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function notify(msg) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log("[notify] No Telegram config:", msg);
    return;
  }
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const res  = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text:    `🔄 *TimbSwap Settler*\n${msg}`,
        parse_mode: "Markdown"
      })
    });
    if (!res.ok) console.error("[notify] Telegram error:", await res.text());
  } catch (e) {
    console.error("[notify] Failed to send Telegram message:", e.message);
  }
}

// Hard cap on settle calls per run — one full round is 6 segments; a few
// extra covers a genuinely lagging backlog without ever looping unbounded.
const MAX_SETTLES_PER_RUN = 8;

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

  let settledCount = 0;
  let roundsRolled  = 0;

  for (let i = 0; i < MAX_SETTLES_PER_RUN; i++) {
    const round     = await prize.currentRound();
    const segment   = await prize.currentSegment();
    const remaining = await prize.timeRemainingInSegment();

    console.log(`[settler] Round #${round} | Segment ${segment}/6 | ${remaining}s remaining`);

    if (remaining > 0n) {
      console.log(`[settler] Segment not ready — ${remaining}s left. Nothing else overdue.`);
      break;
    }

    console.log(`[settler] Segment ready. Calling settleSegment()...`);
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
