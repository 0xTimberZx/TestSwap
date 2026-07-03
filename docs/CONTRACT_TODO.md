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

## 3. (add future contract-level items here)

<!--
Template:
### <short title>
- Want:
- Blocked by (current contract behavior):
- Contract change:
- Follow-on (redeploy / config.js / frontend wiring):
-->
