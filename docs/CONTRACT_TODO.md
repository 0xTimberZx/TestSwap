# Deferred blockchain-level work

Work that needs **smart-contract changes and/or a redeploy** (plus updating the
contract address in `config.js`). Parked here on purpose — day-to-day we focus
on frontend/UI fixes, which don't touch this list. Revisit when we're ready to
do a contract round.

> Convention: anything here implies redeploy + update `ADDRESSES` in `config.js`
> + wire the new function into the relevant page. Frontend-only items do **not**
> belong in this file.

---

## 1. Cancel / withdraw a Pending prize entry (pre-round)

- **Want:** withdraw the principal of a queued entry *before* its round plays, so
  the game is truly risk-free / entries feel un-stuck.
- **Why it's blocked:** `GameRegistry` exposes only:
  - `submitEntry` — create an entry for the next round (one per round),
  - `replaceEntry` — change a Pending/Active entry's string (reuses escrow),
  - `claimRefund` — refund principal **only after** the entry expires
    (`currentRound > lastEligibleRound`, within a 2-round claim window).
  There is **no** function to cancel a not-yet-played entry and return its escrow.
- **Contract change:** add e.g. `cancelEntry(uint256 round)` that
  - requires `msg.sender` owns a `Pending` (not yet Active/settling) entry,
  - refunds the escrowed principal (ETH or TIMBS) to the owner,
  - marks the entry `Inactive` (or deletes it) and clears its escrow,
  - keeps additional-round TIMBS non-refundable (already sunk to `protocolSink`),
  - emits an event; reverts once the entry's round is active/settling.
- **Follow-on:** redeploy `GameRegistry`, update its address in `config.js`,
  add a "Withdraw entry" button on the Compete page wired to it.
- **Frontend interim (already shipped):** `replaceEntry` is wired as
  "Update entry" so users can at least change a stuck Pending entry instead of
  hitting `UNPREDICTABLE_GAS_LIMIT` from the one-entry-per-round rule.

## 2. Prize round stuck in "Settling…" (round not advancing)

- **Symptom:** Compete/landing show "Settling segment…" indefinitely; the
  segment countdown never runs because the round never advances on testnet.
- **Likely cause:** no keeper is triggering segment settlement / round rollover.
  Eligible swaps call `nudgeScroll`, but advancing a segment at the end of its
  window and settling/rolling the round needs a periodic trigger.
- **To resolve (mostly infra, possibly contract):**
  - Confirm whether settlement is **permissionless** or owner-gated in
    `TimbPrize` / `GameRegistry`.
  - If gated: run a keeper (cron/bot) that calls the settle/advance function on
    schedule.
  - If we want it trigger-free: a contract change to advance/settle lazily on
    the next interaction (or make settlement permissionless) — that's the
    blockchain-level part.

## 3. User-callable "Advance" (nudge) on the Compete page

- **Want:** a wallet-gated **Advance / nudge** button (on the meter card and near
  game registration) that pushes the scroll +1 directly — one nudge at a time
  for now.
- **Why it's blocked:** `TimbPrize.nudgeScroll()` is `onlyRouter` — it can only
  be called by `TimbSwapRouter` inside an eligible swap (`_maybeNudge`). There is
  **no** user-callable nudge path, so a tap-to-nudge button would revert.
- **Design decision (not just code):** today you must *swap* to nudge, so nudges
  cost a trade + fee. A direct nudge button changes the game economics — decide
  the cost/eligibility model (free? costs TIMBS/ETH? rate-limited?) before adding.
- **Contract change:** add a user-facing nudge entry point (e.g. on `TimbPrize`
  or mediated by `GameRegistry`) with whatever cost/guard we choose; keep the
  settlement-window block and `whenGameStarted` guard. Redeploy + update address
  in `config.js` + wire the button.

## 4. `batchNudge` — multiple nudges in one call

- **Want:** batch N nudges into a single transaction ("batch 5" = one submit,
  applied one-at-a-time ×5), to cleanly handle ordering when many nudge requests
  arrive at once.
- **Depends on #3** (a user-callable nudge must exist first).
- **Contract change:** add `batchNudge(uint256 count)` that loops `count` times
  applying the same per-nudge effect/accounting sequentially in one tx (bounded
  `count` to cap gas). Emit per-nudge events so the scroll animation/order stays
  correct. Redeploy + update `config.js` + wire a batch stepper in the UI.

## 5. (add future contract-level items here)

<!--
Template:
### <short title>
- Want:
- Blocked by (current contract behavior):
- Contract change:
- Follow-on (redeploy / config.js / frontend wiring):
-->
