# Deferred blockchain-level work

Work that needs **smart-contract changes and/or a redeploy** (plus updating the
contract address in `config.js`). Parked here on purpose — day-to-day we focus
on frontend/UI fixes, which don't touch this list. Revisit when we're ready to
do a contract round.

> Convention: anything here implies redeploy + update `ADDRESSES` in `config.js`
> + wire the new function into the relevant page. Frontend-only items do **not**
> belong in this file.

---

## 1. Cancel / withdraw a Pending prize entry (pre-round) — CODE WRITTEN

**Status:** `GameRegistry.cancelEntry(round)` implemented and compile-verified
(solc 0.8.24). Frontend "Withdraw" button wired on Compete for Pending entries
whose round hasn't started. **Needs GameRegistry redeploy:**

1. Deploy updated `GameRegistry` (same constructor args as current).
2. New registry: `setTimbPrize(<TimbPrize>)`, `setProtocolSink(...)`, and
   re-set entry costs if they were changed from defaults.
3. `TimbPrize.setGameRegistry(<new registry>)` (setter exists).
4. `setCurrentRound` sync: TimbPrize pushes the round on next settle; verify
   `currentRound` matches after one segment settles.
5. Update `ADDRESSES.GameRegistry` in BOTH `config.js` and `frontend/config.js`.
6. Note: entries/escrow in the OLD registry stay there — refund/cancel old
   entries through the old contract before switching, or drain via claimRefund.


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
- **Confirmed cause:** `settleSegment()` is `onlySettler` and reverts until the
  59:45 interaction window elapses (`TimbPrize.sol:346-357`). Nothing is calling
  it on the testnet, so `_isInSettlementWindow()` stays true forever and the UI
  shows "Settling…" indefinitely. Eligible swaps only call `nudgeScroll`; they do
  not advance segments or roll the round.

- **Timing (from `TimbPrize.sol:86-101`):**
  - `INTERACTION_WINDOW` = 59:45 (nudging open) · `SETTLEMENT_WINDOW` = 15s
  - `SEGMENT_DURATION` = 1 hour · `SEGMENTS_PER_ROUND` = 6 · `ROUND_DURATION` = 6 hours
  - `CLAIM_WINDOW_ROUNDS` = 2 (refund/claim window = 12 hours after lastEligibleRound)
  - Nominal settlement is 15s, but real duration = "until the settler calls
    `settleSegment()`" — currently unbounded.

- **To resolve (mostly infra, possibly contract):**
  - **Keeper cadence:** run a settler bot/cron that calls `settleSegment()` once
    per segment, **just after each 59:45 mark** (i.e. ~hourly, aligned to
    `segmentStartTime + INTERACTION_WINDOW`). Calling earlier reverts with
    `SegmentNotComplete`. One call advances one segment; the 6th call of a round
    triggers `_settleRound()` which pays out and auto-queues the next round.
    Poll a little past the mark (e.g. every ~30-60s once elapsed ≥ 59:45) so a
    missed block doesn't stall a full segment. The keeper wallet must be the
    configured `settler` address.
  - Alternatively make it trigger-free: a contract change to advance/settle
    lazily on the next interaction, or make `settleSegment()` permissionless —
    that's the blockchain-level part.

## 3. User-callable "Advance" (nudge) — CODE WRITTEN (router redeploy)

**Status:** `TimbSwapRouter.advanceScroll(count)` implemented (router is the
address TimbPrize authorizes, so no TimbPrize change). count=1 = single nudge;
up to MAX_BATCH_NUDGE=20 = batchNudge (one tx, applied one at a time, in
order). Compete page has wallet-gated "Advance +1" buttons (meter card +
entry card), disabled during settlement. Ships in the same router redeploy as
the native-ETH swaps — redeploy the router once more from this code and
follow §5's checklist. NOTE: nudges via this path are free (gas only) — the
economics decision below still stands if you want to charge.

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

## 4. `batchNudge` — DONE (covered by §3, advanceScroll(count))

- **Want:** batch N nudges into a single transaction ("batch 5" = one submit,
  applied one-at-a-time ×5), to cleanly handle ordering when many nudge requests
  arrive at once.
- **Depends on #3** (a user-callable nudge must exist first).
- **Contract change:** add `batchNudge(uint256 count)` that loops `count` times
  applying the same per-nudge effect/accounting sequentially in one tx (bounded
  `count` to cap gas). Emit per-nudge events so the scroll animation/order stays
  correct. Redeploy + update `config.js` + wire a batch stepper in the UI.

## 5. Native ETH swaps — CODE WRITTEN, needs router redeploy

- **Status:** `TimbSwapRouter.sol` now has `swapExactETHForTokens` (payable) and
  `swapExactTokensForETH`, compile-verified on solc 0.8.24. The Swap page
  frontend is already wired: ETH appears as a native token, ETH↔WETH is a 1:1
  wrap/unwrap directly on the WETH contract (works with the CURRENT deployment,
  no redeploy needed), and ETH↔token routes through the new router functions.
- **No new ETH funding needed:** WETH↔ETH is a wrap/unwrap on the WETH contract
  (always 1:1, no pool); TIMBS↔ETH rides the existing TIMBS/WETH pool + unwrap.
- **Fee model:** ETH-in swaps charge the same 0.05% protocol fee on top of
  amountIn, paid to the treasury as WETH; the frontend sends
  `msg.value = amountIn + fee`. Token-in→ETH swaps collect the fee in tokenIn
  exactly like today.

### Redeploy checklist (Remix, owner wallet)

1. Deploy the updated `TimbSwapRouter` with the SAME constructor args as the
   current one: `(factory, treasury, eligibleRegistry, timbPrize)`.
2. On the NEW router: `setWeth(0x980B62Da83eFf3D4576C647993b0c1D7faf17c73)`.
3. On `TimbPrize`: `setRouter(<new router>)` — otherwise nudges revert
   (`onlyRouter` still points at the old router).
4. Optional hygiene: `pause()` the OLD router so no one keeps trading through it.
5. Update `ADDRESSES.TimbSwapRouter` in BOTH `config.js` and
   `frontend/config.js` to the new address.
6. Users' token approvals target the old router; the frontend already checks
   allowance per-swap and will prompt a fresh approve automatically.
7. Smoke test: WETH→ETH unwrap (works pre-redeploy too), ETH→TIMBS,
   TIMBS→ETH, and one eligible swap with influence ON to confirm the nudge
   fires from the new router.

## 6. (add future contract-level items here)

<!--
Template:
### <short title>
- Want:
- Blocked by (current contract behavior):
- Contract change:
- Follow-on (redeploy / config.js / frontend wiring):
-->
