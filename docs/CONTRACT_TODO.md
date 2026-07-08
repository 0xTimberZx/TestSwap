# Deferred blockchain-level work

Work that needs **smart-contract changes and/or a redeploy** (plus updating the
contract address in `config.js`). Parked here on purpose — day-to-day we focus
on frontend/UI fixes, which don't touch this list. Revisit when we're ready to
do a contract round.

> Convention: anything here implies redeploy + update `ADDRESSES` in `config.js`
> + wire the new function into the relevant page. Frontend-only items do **not**
> belong in this file.

---

## 1. Cancel / withdraw a Pending prize entry (pre-round) — SUPERSEDED BY §8

> The v1 `cancelEntry(round)` below was rewritten as the ticket-model
> `cancelEntry()` (→ Cancelled status) in §8's GameRegistry v2. Deploy §8.

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

## 2. Prize round stuck in "Settling…" — RESOLVED (keeper + §9 fixes)

> Settler keeper shipped (linger mode settles at the boundary), and §9's
> permissionless + lazy settlement removes the dependency entirely once
> §10 deploys. Kept below for the original analysis.

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

## 3. User-callable "Advance" (nudge) — DEPLOYED (router 0xbD18…6F67)

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

## 5. Native ETH swaps — DEPLOYED (router 0xbD18…6F67)

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

## 6. `addLiquidity`/`addLiquidityETH` revert on a brand-new pair — CODE WRITTEN, deploy via §10

> Interim frontend workaround SHIPPED: the Swap page calls the factory's
> permissionless `createPair` first for brand-new pools, so this works
> today on the deployed router. §10's redeploy bakes it into the router.

- **Symptom:** Adding liquidity for a token pair that has no pool yet fails
  gas estimation (`UNPREDICTABLE_GAS_LIMIT`); swaps on existing pairs are fine.
- **Confirmed cause:** `_getPair()` only looks up `factory.getPairAddress(...)`
  and reverts with `PairNotFound` if it's `address(0)` — neither
  `addLiquidity` nor `addLiquidityETH` ever called `factory.createPair(...)`,
  so the very first LP for a pair had no way to bootstrap it (`createPair`
  itself has no auth restriction, callable by anyone, factory-side).
- **Fix:** added `_getOrCreatePair()` (creates the pair via
  `factory.createPair` if missing) and pointed only the two add-liquidity
  prepare paths at it. Swaps and `removeLiquidity` still use the original
  `_getPair()` and correctly keep reverting on a nonexistent pair — auto-
  creating there would let anyone spam empty pairs via a swap call, or
  "remove" liquidity from a pool that was never funded.
- **Status:** compile-verified on solc 0.8.24 (viaIR). Needs a router
  redeploy — follow §5's checklist (same constructor args, `setWeth`,
  `TimbPrize.setRouter(new)`, update `ADDRESSES.TimbSwapRouter` in both
  config.js files). Until redeployed, adding liquidity to a not-yet-created
  pair still reverts on the currently deployed router.

## 7. Entry cost shows 0.0000 ETH and ETH entries always revert — SUPERSEDED BY §8

> Both fixes below are carried into §8's GameRegistry v2, and §8's checklist
> step 4 sets the agreed costs (1000 TIMBS / 0.0001 ETH). Deploy §8.

- **Symptom:** Compete's "Entry cost" reads 0.0000 ETH, and submitting an ETH
  entry always fails gas estimation (`UNPREDICTABLE_GAS_LIMIT` on
  `submitEntry`), even sending the "correct" (zero) amount.
- **Confirmed root cause (two separate issues, both on `GameRegistry`):**
  1. `entryCostTIMBS`/`entryCostETH` are plain state variables, only ever set
     via the owner-only `setEntryCosts(timbsCost, ethCost)` — they are **not**
     initialized in the constructor. The registry deployed for §1's
     `cancelEntry` redeploy was apparently never followed up with a
     `setEntryCosts(...)` call, so both read as 0 — that's the literal "entry
     cost disappeared."
  2. Independent of #1, `submitEntry`'s ETH-escrow check was
     `if (msg.value == 0 || msg.value < entryCostETH) revert
     WrongEscrowAmount(...)`. The `msg.value == 0 ||` clause is redundant
     whenever `entryCostETH > 0` (since `0 < entryCostETH` already reverts),
     but it makes a **free entry (entryCostETH == 0) impossible** — the
     correct `msg.value == 0` always trips that first clause. Fixed to just
     `if (msg.value < entryCostETH) revert ...`.
- **Status:** fixed and compile-verified on solc 0.8.24 in `GameRegistry.sol`.
  Needs the redeploy already tracked in §1's checklist — when redeploying,
  make sure step 2 (`setEntryCosts(...)`) actually runs with the intended
  TIMBS/ETH cost values; skipping it reproduces this exact symptom again.

## 8. THE TICKET-MODEL ROUND — GameRegistry v2 + TimbYieldVault + TimbPrize v2 (DEPLOYED)

**Status: live.** Deployed addresses:
- `GameRegistry` v2: `0xee2c3b12e8dED226a6AE8e950e5B6C67eF4CB774`
- `TimbPrize` v2: `0x03a895DD42893dD20EF39420fDc93FE86E3c6055`
- `TimbYieldVault`: `0x619374B3BfB8E0B23406033e56cF2fCcb36FE57F`

`ADDRESSES` updated in both `config.js` and `frontend/config.js`;
`scripts/settler.js`'s `TIMBPRIZE_ADDR` updated to the v2 address.
Double-check the wiring steps below were completed on-chain (setTimbPrize,
setYieldVault, setEntryCosts, vault funding/rate, PrizeEscrow/Router
repoint, startGame) — this doc can't verify on-chain state itself.

**Supersedes the redeploy halves of §1 and §7** — everything lands in this one
coordinated deploy. All three contracts compile clean on solc 0.8.24
(optimizer 200, no viaIR needed; registry ~13KB, prize ~12KB, vault ~4KB).

### What changed

**GameRegistry v2 — ticket model:**
- Every entry mints a Ticket (global id) with lineage links. `replaceEntry`
  now mints a NEW ticket and Concedes the senior one (visible, tethered,
  principal carried over; extra-round TIMBS must be re-paid). Statuses:
  Pending / Active / Conceded / Ineligible / Cancelled / Closed
  (Cancelled reads as Closed once its play round begins — derived).
- REAL one-live-ticket-per-wallet enforcement (v1 only guarded per-round, so
  wallets could stack tickets across rounds).
- Tickets index into EVERY round they play (v1 bug: extra-round entries
  could never win or activate beyond their first round).
- `cancelEntry()` (pre-round withdraw, → Cancelled), `claimRefund(ticketId)`
  (post-run, → Closed), claim-window lapse → Ineligible with escrow absorbed
  to the Treasury sink, `onRoundSettled` hook replaces the v1
  expire/markInactive flow (which never actually fired — v1 only scanned the
  just-settled round's entrants, where nothing is ever expired yet).
- Yield-weight hooks into TimbYieldVault on Active enter/exit (try/catch —
  vault failure can never brick the game).

**TimbYieldVault (new) — PoolTogether-style, fully internal:**
- Active tickets' escrow counts as weight ONLY (principal never leaves the
  registry). While weight > 0, yield accrues per-second ∝ weight, capped by
  the vault's treasury-funded ETH reserve; reserve dry ⇒ accrual pauses.
- Yield goes to ONE place: the prize pot, harvested by TimbPrize at each
  round settlement. Depositors get principal back + a shot at the pot.

**TimbPrize v2:**
- `_harvestYield()` at settlement — 4th pot source (swap fees, seeding,
  snowball/unclaimed, now escrow yield). `YieldHarvested` event.
- `recycleUnclaimed(round)` — returns expired-window unclaimed winnings to
  the live pot ("seeding from unclaimed rounds"; v1 stranded them forever).
- FIXED: `IPrizeEscrow.pay` selector mismatch (2-arg declared vs 3-arg real)
  that made every `claimWinnings` revert against the deployed escrow.
- Registry interface swapped to `onRoundSettled` hook.

### Deploy checklist (Remix, owner wallet, Arb Sepolia)

1. **GameRegistry v2**: deploy `(TIMBSToken, TimbTreasury, address(0))`.
2. **TimbYieldVault**: deploy `()`.
3. **TimbPrize v2**: deploy `(PrizeEscrow, <registry v2>, TimbSwapRouter)`.
4. Wire registry: `setTimbPrize(<prize v2>)`, `setYieldVault(<vault>)`,
   `setEntryCosts(1000000000000000000000, 100000000000000)`
   (= 1000 TIMBS, 0.0001 ETH — the agreed initial costs).
5. Wire vault: `setGameRegistry(<registry v2>)`, `setTimbPrize(<prize v2>)`,
   `setTimbsWeight1e18(100000000000)` (1e11 ⇒ 1000 TIMBS ≙ 0.0001 ETH
   weight, entry-cost parity), `setYieldAPRBps(<e.g. 1000 = 10%>)`,
   then `fund()` with ETH from the Treasury (this reserve IS the yield).
6. Wire prize: `setYieldVault(<vault>)`, `setEligibleRegistry(<existing>)`,
   `setSettler(<settler wallet>)`.
7. Repoint neighbors: `PrizeEscrow.setTimbPrize(<prize v2>)`,
   `TimbSwapRouter.setTimbPrize(<prize v2>)`.
8. `prize2.startGame()` — fresh round #1.
9. Update `ADDRESSES` in BOTH `config.js` and `frontend/config.js`:
   `GameRegistry`, `TimbPrize`, and the new `TimbYieldVault`.
10. **`scripts/settler.js` hardcodes `TIMBPRIZE_ADDR` — update it to the new
    TimbPrize or the keeper keeps settling the old game.**
11. Old contracts: pause the old registry; drain old entries through it
    (cancel/refund) — escrow does not migrate.

## 9. Keeper-bound settlement window — CODE WRITTEN (both fixes), deploy via §10

The "15-second" settlement window's real duration is *until the settler
lands a `settleSegment()`*. While it's open, `nudgeScroll` reverts
(`InSettlementWindow`) — the whole game reads as frozen and nobody can
advance the meter. Two incidents on launch day of the ticket-model round:

1. **Settler address timing gap (resolved).** The game was deployed and
   started while `scripts/settler.js` on `main` still hardcoded the OLD
   TimbPrize (the address update rode a not-yet-merged PR). The keeper
   spent ~5 hours dutifully tending the dead game while the live one sat
   in its first settlement window. Lesson: the settler address is
   duplicated between `config.js` and `scripts/settler.js` — a future
   hardening is to make the settler read one source of truth so a config
   update can't leave the keeper pointing at an old game.
2. **GitHub cron throttling (mitigated).** The `*/10` schedule actually
   fires roughly hourly on shared runners, so every segment spent up to
   an hour in "Settling…" limbo with nudges reverting.

**Mitigation shipped (infra):** settler "linger mode" — each run sleeps
until the segment boundary and settles within seconds of it
(`SETTLER_LINGER_MINUTES`, default 55; workflow `timeout-minutes: 62`
plus a concurrency group so overlapping ticks queue). Frontend now also
records `Prize:Settlement Overdue` (fail) to DebugHub when a window
outlives its nominal 15s by 2+ minutes, so a stalled keeper is visible
in exports instead of silent.

**Permanent fix — IMPLEMENTED in `TimbPrize.sol` (both halves):**
- `settleSegment()` is now PERMISSIONLESS: `onlySettler` dropped, timing
  guard kept (it's the timing that protects the game, not the caller).
  The `settler` role remains as the keeper's identity only.
- Lazy settlement: `nudgeScroll()` settles a due segment inline (locking
  the digit exactly as the keeper would — no nudges landed since the
  boundary) and applies the nudge to the fresh segment, so the game can
  never stall in its settlement window while in use. Nudges only stay
  blocked when settlement is owner-paused.
- Frontend: the Advance button stays enabled through the window and reads
  "Advance ×N — rolls the segment".
Compile-verified on solc 0.8.24. **Deploy via §10's checklist** (TimbPrize
redeploy; the keeper keeps running unchanged as a liveness backstop).

## 10. THE KEEPER-INDEPENDENCE ROUND — TimbPrize v3 + Router v6

**Status: LIVE (v3.1).** TimbPrize redeployed from post-§10 main at
`0xc8292043Dfb14d740aA45391a67d5F795a22c7CC` — permissionless + lazy
settlement, 60-minute grid anchoring, intermission semantics. Configs and
settler repointed. (History: the first "v3" deploy at `0xd2D2…Bd6A` was
compiled from a pre-§9 source and is retired; Router v6 was always fine.)

TimbPrize v3 now ALSO carries the confirmed game semantics:
- **60-minute grid:** segments live on exact 60:00 marks. A settle landing
  anywhere in the following slot anchors the next segment to the boundary
  (`_nextSegmentStart`); only a full-slot stall falls back to wall clock.
  Elapsed-time reads saturate at 0 for a grid-anchored future start.
- **Intermission (59:45–60:00):** USER nudges deactivated (frontend disables
  Advance: "Intermission — calculations in progress"); eligible-SWAP nudges
  keep flowing and lazy-settle — the first one grabs the winning digit
  (immutable from 59:45 by construction) and nudges into the next segment.
- Settler alerts to Telegram when a segment blows past its 60:00 mark:
  >60:03 ⚠️ slight delay, >60:10 🚨 major delay (fires when the next
  settler run observes it — no run, no alert, which is itself the outage).

Deployed addresses:
- `TimbSwapRouter` v6: `0x6E53dc53Ea7B2fd8be171D74A381f009dA5F94bD`
- `TimbPrize` v3.1: `0xc8292043Dfb14d740aA45391a67d5F795a22c7CC` — retired, superseded by v3.2 (§11: `0xc3fB39E0da3312c7f95bD7aD511ac76C4B86eE40`)

`ADDRESSES` updated in both `config.js` files; `scripts/settler.js`
repointed. Settlement is now permissionless + lazy; addLiquidity
creates pairs on demand at the router level (the Swap page's
createPair pre-step remains as a harmless no-op). Verify the step-5
neighbor repoints (GameRegistry / YieldVault / PrizeEscrow →
prize v3) and `startGame()` ran — this doc can't check on-chain state.

One coordinated deploy that clears everything still pending: §9 (both
settlement fixes, TimbPrize) and §5/§6 (native-ETH liquidity + create-on-add,
router — code merged since PR #13, never deployed). Both compile clean on
solc 0.8.24 (router needs viaIR in Remix, per its header).

### Deploy checklist (Remix, owner wallet, Arb Sepolia)

1. **Router v6**: deploy `TimbSwapRouter` with the SAME constructor args as
   the current one `(TimbSwapFactory, TimbTreasury, EligibleTokenRegistry,
   <old prize — repointed in step 3>)`.
2. **TimbPrize v3**: deploy `(PrizeEscrow, <GameRegistry v2:
   0xee2c3b12e8dED226a6AE8e950e5B6C67eF4CB774>, <router v6>)`.
3. Wire router v6: `setWeth(0x980B62Da83eFf3D4576C647993b0c1D7faf17c73)`,
   `setTimbPrize(<prize v3>)`.
4. Wire prize v3: `setYieldVault(<TimbYieldVault:
   0x619374B3BfB8E0B23406033e56cF2fCcb36FE57F>)`,
   `setEligibleRegistry(<existing>)`. (`setSettler` optional — settlement
   is permissionless now; the role is identity/telemetry only.)
5. Repoint neighbors at prize v3: `GameRegistry.setTimbPrize`,
   `TimbYieldVault.setTimbPrize`, `PrizeEscrow.setTimbPrize`.
6. Optional hygiene: `pause()` the OLD router.
7. `prize3.startGame()` — fresh round #1.
8. Update `ADDRESSES.TimbSwapRouter` + `ADDRESSES.TimbPrize` in BOTH
   `config.js` and `frontend/config.js`.
9. **Update `TIMBPRIZE_ADDR` in `scripts/settler.js`** — the keeper stays
   as a liveness backstop even though settlement is permissionless.
10. Old game: entries in GameRegistry carry over (registry is NOT
    redeployed), but the round counter restarts at 1 — pending tickets
    queued for the old game's next round will activate at the new game's
    round 2. Cancel/refund through the registry beforehand if that
    matters.
11. Smoke test: LINK+WETH addLiquidity (create-on-add, no frontend
    pre-create needed anymore), one Advance during a settlement window
    (should roll the segment, not revert), one ETH↔TIMBS swap.

## 11. THE CONTINUOUS METER — TimbPrize v3.2 (LIVE at `0xc3fB39E0da3312c7f95bD7aD511ac76C4B86eE40`)

### The meter never clears
- Want: the six digit counters are a CONTINUOUS scroll. Round 1 ending
  `ABCJLA` means round 2's segments resume from A,B,C,J,L,A — visible on
  the meter from the moment the round starts, with nudging picking up from
  wherever each digit sat. No blanks, no reset to 'A'.
- Blocked by (v3.1 behavior): `_settleDueSegment` zeroed the incoming
  segment's counter on every advance, and `_settleRound` zeroed ALL six
  counters at rollover — the J and L were erased on-chain the moment
  round 2 started.
- Contract change (both in `_settleDueSegment`/`_settleRound`): counters
  are never reset; only `segmentDigitLocked` releases at rollover. The
  winning string still snapshots the locked values at each round's end.
- Frontend (`compete.js renderDigitTrack`): future segments now render
  their carried digit dimmed (`.future`) instead of a `·` placeholder.

### Deploy checklist (Remix, owner wallet, Arb Sepolia)

Same shape as §10 steps 2–10, prize-only (router v6 is unaffected):

1. **TimbPrize v3.2**: deploy `(PrizeEscrow, GameRegistry v2:
   0xee2c3b12e8dED226a6AE8e950e5B6C67eF4CB774, Router v6:
   0x6E53dc53Ea7B2fd8be171D74A381f009dA5F94bD)`. viaIR ON.
2. Wire prize v3.2: `setYieldVault(0x619374B3BfB8E0B23406033e56cF2fCcb36FE57F)`,
   `setEligibleRegistry(<existing>)`.
3. Repoint neighbors: `Router.setTimbPrize`, `GameRegistry.setTimbPrize`,
   `TimbYieldVault.setTimbPrize`, `PrizeEscrow.setTimbPrize`.
4. `startGame()` — fresh round #1 (counters all start at A once; they
   never reset again after this).
5. Update `ADDRESSES.TimbPrize` in BOTH `config.js` and
   `frontend/config.js`, and `TIMBPRIZE_ADDR` in `scripts/settler.js`.
6. Smoke test: meter should show all six digits (no dots) as soon as the
   game starts; after the first round settles, verify the counters carry
   into round 2 unchanged with locks released.

## 12. STABLES — USDC live, TestUSDT written, USD pricing derived

### What's in place
- **USDC**: Circle's canonical Arbitrum Sepolia deploy
  `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (6 decimals) — added to
  `ADDRESSES` (both configs) and the swap page token list. Faucet:
  faucet.circle.com.
- **TestUSDT** (`contracts/TestUSDT.sol`): Tether has no official testnet
  token, so the ecosystem ships its own — 6 decimals like the real thing,
  1M minted to deployer, owner `mint()`, public `faucet()` (100/day per
  address). Deploy via Remix (no viaIR needed), then add its address to
  `EXTRA_TOKENS` in swap.js.
- **USD pricing**: the USDC/WETH pool is the USD anchor. Analytics derives
  `usdPerEth` from its reserves and prices native pairs through it
  (TIMBS → ETH → USD): TIMBS Price and Prize Pot cards show `≈ $` values
  once the pool exists. No pool → USD readouts simply don't render.

### Pool creation (no contract work needed)
Router v6 `_getOrCreatePair()` creates pairs on first Add Liquidity:
- **USDC/WETH** — create FIRST; it's the USD anchor everything derives from.
- **USDC/TIMBS** — direct fiat-denominated TIMBS market.
- USDT pools after TestUSDT deploys.

### Eligibility decision (recorded 2026-07-06)
**TIMBS/USDC: whitelist. USDC/USDT: do NOT whitelist.**

Rationale — the intermission privilege: swap-driven nudges keep flowing
during the 15-second settlement window (user nudges don't), meaning
eligible swaps can influence the digit right as it locks. That privilege
should require economically meaningful volume. A stable↔stable swap has
zero price exposure and zero slippage risk — whitelisting USDC/USDT would
make intermission digit-sniping essentially free. TIMBS/USDC swaps carry
real TIMBS exposure and deepen fiat-side demand for the ecosystem token,
so they've earned the nudge. USDC/USDT can still exist as a plain
fee-earning pool — it just gets no game influence.

## 13. Router redeploy — prize-meter balance (#1 + #2)  ⟶ PENDING REDEPLOY

Full design: `docs/PRIZE_GAME_BALANCE_SPEC.md`. Router code is done + compiles; TimbPrize
untouched.

- **Want:** casual players can win (curb single-actor final-nudge dominance) AND the meter race
  feeds the fee/burn loop.
- **Change (Router only):** an eligible swap = `swapNudgeWeight` (3) nudges; gas-only
  `advanceScroll` capped at `freeNudgeCapPerSeg` (10) per address per segment (keyed by
  round+segment, auto-resets); paid swap-nudges uncapped. New views/setters:
  `freeNudgesRemaining`, `setSwapNudgeWeight`, `setFreeNudgeCapPerSeg`.
- **Redeploy / rewire:**
  1. Deploy new `TimbSwapRouter`.
  2. `TimbPrize.setRouter(newRouter)`.
  3. New Router pointers: factory, eligibleRegistry (`setEligibleRegistry`), timbPrize
     (`setTimbPrize`), treasury, WETH — mirror the current Router.
  4. `config.js` / root `config.js`: set `ADDRESSES.TimbSwapRouter` = newRouter.
  5. Frontend already wired (`freeNudgesRemaining` read in compete Advance panel); bump cache.
  6. Do the switch in one sitting — the old Router keeps swapping but no longer nudges.
- **Deferred (noted):** blockhash jitter / provable fairness (VRF); Scenario C (TIMBS hub).

## 14. (add future contract-level items here)

<!--
Template:
### <short title>
- Want:
- Blocked by (current contract behavior):
- Contract change:
- Follow-on (redeploy / config.js / frontend wiring):
-->
