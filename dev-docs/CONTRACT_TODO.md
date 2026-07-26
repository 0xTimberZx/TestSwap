# Deferred blockchain-level work

Work that needs **smart-contract changes and/or a redeploy** (plus updating the
contract address in `config.js`). Parked here on purpose — day-to-day we focus
on frontend/UI fixes, which don't touch this list. Revisit when we're ready to
do a contract round.

> Convention: anything here implies redeploy + update `ADDRESSES` in `config.js`
> + wire the new function into the relevant page. Frontend-only items do **not**
> belong in this file.

> ✅ **Done (game-sync / generations):** the reused-registry round-collision
> class is resolved by the **generations** rewrite — `GameRegistry`
> `0xfca8C2A1…` + `TimbPrize` `0x35976f4D…`. See `GAME_SYNC_GENERATIONS.md`.
> Future **prize** redeploys no longer need a registry redeploy: four
> `setTimbPrize` re-points + `startGame` (bumps the generation). After any fresh
> registry, remember `setEntryCosts(1000e18, 0.0001e18)` — it does **not** carry
> over.

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
> step 4 sets the agreed costs (100 TIMBS / 0.0001 ETH). Deploy §8.

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
   `setEntryCosts(100000000000000000000, 100000000000000)`
   (= 100 TIMBS, 0.0001 ETH — the agreed initial costs).
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

---

## §13 — External audit findings (July 2026 review)

Third-party review of the contract set surfaced three defects; verified
against source before acting.

### 13.1 TimbTreasury buyback — FIXED (redeploy pending)

Three confirmed defects, all corrected in `TimbTreasury.sol`:

1. **Native-ETH send to the pair could never succeed.** `executeBuyback`
   sent ETH via `payable(pair).call{value:}` — but `TimbSwapPair` has no
   `receive()`/fallback, so the call always returned false → every buyback
   reverted `BuybackFailed`. Fix: wrap via `IWETH.deposit` and
   `safeTransfer` the WETH into the pair (the pair derives swap input from
   its ERC20 balance delta), matching the router's `_wrapAndSend` pattern.
2. **Phantom `safeTransfer` on the token interface.** `ITimbsToken`
   declared `safeTransfer(address,uint256)` as a token method — TIMBSToken
   (ERC20 + Burnable) has no such function, so the staking legs of
   `executeBuyback` AND all of `distributeToStaking` reverted on a missing
   selector. Fix: SafeERC20 library call on `IERC20(address(timbsToken))`.
3. **Slippage/split measured total balance, not the swap delta.**
   Pre-existing treasury TIMBS would be swept into the burn/staking split
   and mask slippage. Fix: before/after balance delta.

Constructor now takes `_weth` (5th arg); `setWeth()` added. **Redeploy
steps:** deploy new TimbTreasury(timbs, staking, escrow, pair, WETH) →
`router.setTreasury(new)` → re-authorize fee senders → move any held
ETH/TIMBS from the old treasury (`withdrawOperational` for ETH) → update
ADDRESSES + README/SPECS.

### 13.2 TimbPrize `_buildWinningString` — FIXED in v4 (awaiting deploy, see §14)

Was: raw `counter % 36` per segment, fully deterministic → snipeable by
last-second nudge steering. Now: each segment's LOCKED character is
`ALPHABET[keccak256(blockhash(block.number-1), counter, round, segment) % 36]`
frozen at lock time (`_lockCurrentSegment`), stored in `segmentLockedChar`,
and the winning string is built from those stored chars. Swaps still
influence the outcome (every nudge changes the mix) but nobody can aim it.
`getCurrentWindow`/`getSegmentDigit` return locked (jittered) chars for
settled segments and the live pre-jitter char for the active one — the
frontend reads letters from `currentWindow` instead of deriving `% 36`.

Accepted residual (documented in-code): a manual settler can grind
settlement timing inside the 15s window (~1/36 per block) since
blockhash(n-1) is known within block n; the keeper settling within seconds
of each boundary leaves little room. Full elimination needs
commit-reveal/VRF — out of scope for testnet.

### 13.1b Treasury v3 — ERC20 fee exits (fix ready, redeploy when convenient)

Post-mortem on draining v1 revealed the deeper design gap: **protocol fees
arrive as the swap's INPUT token** (router `_collectProtocolFee` transfers
TIMBS/WETH/stables), but the treasury only had exits for ETH and TIMBS.
Consequences:

- v1 held 0 ETH and ~6,532 TIMBS at retirement; with `distributeToStaking`
  broken (13.1 #2) and no generic ERC20 withdrawal, that TIMBS is
  **permanently stranded** (documented in SPECS dead-address table).
- v2 fixes the TIMBS exit but would strand WETH/stablecoin fees the same way.

v3 additions (compiled, awaiting deploy):
- `withdrawToken(token, to, amount)` — generic owner ERC20 exit.
- `unwrapWeth(amount)` — converts WETH fee revenue to ETH so
  `executeBuyback` / `distributeToPot` can spend it.
- `receive()` early-returns for `msg.sender == weth`: WETH.withdraw refunds
  under a 2300-gas stipend, which the accounting SSTORE+event would exceed
  (the unwrap would otherwise revert).

Redeploy is same as v2 (5 constructor args) + the usual 5-pointer rewire.
No urgency: v2 holds ~nothing yet; do it before meaningful fees accumulate.

---

## 14. Claim-window rework — 2-round prize claim / 4-round principal refund
       (v3/v4 DEPLOYED; v5 refinement awaiting deploy)

Deployed: GameRegistry v3 `0x4d74F2111fB12f64F39A285251075cf455B84201`,
TimbPrize v4 `0xD69a518f04900762F460563d71Bdc8DdF86FB350`. The **v5**
refinement below (forfeiture starts after the later of active/claim end) needs
a fresh GameRegistry + TimbPrize redeploy on top.

The two windows were coupled at 2 rounds under one shared constant name
across two contracts. Now decoupled:

- **Prize claim (TimbPrize v4):** 2 rounds flat from the winning round —
  claimable during R+1 and R+2 only (the hidden `+1` grace round is gone).
  Runs even if the ticket is in its expiry tail.
- **Principal refund (GameRegistry v3):** `REFUND_WINDOW_ROUNDS = 4`
  (renamed from `CLAIM_WINDOW_ROUNDS`) — every ticket has a hard 4 rounds
  after `lastEligibleRound` to withdraw escrow before the lapse sweep
  forfeits it to the protocol sink.
- **Winning changes nothing about the ticket:** no status/escrow effect;
  a missed prize recycles to the pot (`recycleUnclaimed`, now
  **permissionless** with a window-lapsed guard — same posture as
  `settleSegment`) while the winner's principal window runs untouched.

**§14 (v5) refinement — forfeiture starts after the LATER of active-end and
claim-end.** The v3/v4 refund window was a flat LER+4, so a ticket that wins
its last one/two eligible rounds had its 2-round claim window *overlap* the
refund window ("half spent as an expired winner"). v5 sequences them: the
4-round forfeiture countdown starts at `max(lastEligibleRound, wonRound +
CLAIM_WINDOW)`, so:

- Non-winner / early winner (won ≤ LER−2): forfeit at **LER+4** (unchanged).
- Won round LER−1: forfeit at **LER+5**.
- Won round LER: forfeit at **LER+6** (full 4-round refund after claim closes).

Implementation:
- `Ticket.forfeitRound` — stored per ticket, set to `LER + REFUND_WINDOW` at
  mint. `refundEntry`/`claimRefund` gate on `currentRound > t.forfeitRound`.
- New `GameRegistry.recordWinners(round, winners)` (onlyTimbPrize) bumps each
  winner's `forfeitRound` to `round + CLAIM_WINDOW + REFUND_WINDOW`; monotonic.
  TimbPrize v5 calls it in `_settleRound` **before** `onRoundSettled` so the
  same round's lapse sweep sees the updated anchors.
- Lapse sweep scans LER buckets `[S−4 .. S−6]` (bounded by `MAX_FORFEIT_PUSH
  = 2`) and forfeits tickets whose `forfeitRound == S` — the per-ticket check,
  not LER alone, is what respects "whichever is later."

Timeline (ticket plays rounds 10–12, wins round 12 = its last eligible round):

```
round:        12   13   14   15   16   17   18
active        play
claim (won 12)     claim claim ╳ right over (14)
principal          ── withdraw 13 … 18 ──╳ forfeited → treasury (18 = LER+6)
                              ↑ old v4 would have forfeited at 16 (LER+4)
```

Tests: `tests/PrizeWindows.t.sol` (run locally: `forge test
--match-contract PrizeWindowsTest -vvv`; forge-std via
`forge install foundry-rs/forge-std`). Covers the keccak mirror, winning
string from locked chars, claim at R+2 pass / R+3 revert, refund at LER+4
pass / forfeit-then-revert after, recycle permissionless-after /
revert-during, and expired-winner-keeps-principal.

### Combined redeploy checklist (§13.2 + §14 — one session)

1. **Deploy** GameRegistry v3 (`timbsToken`, `protocolSink = Treasury v3`,
   `timbPrize = 0x0`), then TimbPrize v4 (`prizeEscrow`, `newRegistry`,
   `router v8`).
2. **Wire new pair:** `registry.setTimbPrize(prize)`,
   `registry.setEntryCosts(…, …)` (copy live values),
   `registry.setYieldVault(vault)`, `prize.setEligibleRegistry(…)`,
   `prize.setYieldVault(vault)`, `prize.setWinnersPerRound(…)`.
3. **Rewire ecosystem:** `escrow.setTimbPrize(prize)`,
   `vault.setGameRegistry(newRegistry)` (+ prize pointer if present),
   `router.setTimbPrize/setGameRegistry` (whichever the router exposes for
   nudge target), old prize/registry left dark.
4. `prize.startGame()` — fresh round 1 (old game history stays readable at
   the old addresses).
5. **Frontend:** config.js ADDRESSES (GameRegistry, TimbPrize) + cache
   token; settler.js `GAMEREGISTRY_ADDR` + prize address; docs address
   table; SPECS tables; Sourcify verify both.
6. Optional settler follow-up: call `recycleUnclaimed(round-3)`
   opportunistically after each rollover.

---

## 15. Class-preserving jitter — TimbPrize v6 (§13.2 favor)  ⟶ PENDING REDEPLOY

**What changed (code, compiled ✅ 0/0):** `_lockCurrentSegment()` keeps the
locked char in the SAME class as the live (pre-jitter) char, instead of
`mix % 36` across the whole alphabet:

- live index `counter % 36` < 26 (a letter A–Z) ⇒ `ALPHABET[mix % 26]`
- else (a digit 0–9)                            ⇒ `ALPHABET[26 + (mix % 10)]`

Effect: nudging lets a player **aim the class** (letter vs digit) of each of the
6 positions; the exact character within that class stays block-jittered and
unaimable. Header comment + player docs (docs/index.html, compete "How It
Works") + SPECS §13.2 updated to match.

**Redeploy — TimbPrize only** (GameRegistry v5, vault, escrow, router all
unaffected — same shape as §11):

1. **Deploy TimbPrize v6** with the current constructor args (prizeEscrow,
   GameRegistry v5 = `0xD6c9001c6Bbb55761f7476009AaF5F71C21Fe0b5`, router).
2. Wire prize v6: `setYieldVault(<vault>)`, `setEligibleRegistry(<existing>)`,
   `setWinnersPerRound(<current>)`, plus any other live setters. Entry costs
   live on the registry — unchanged.
3. Repoint neighbors to the new prize: `escrow.setTimbPrize(v6)`,
   `registry.setTimbPrize(v6)`, `vault.setTimbPrize(v6)` (if present),
   `router.setTimbPrize(v6)` (nudge target). Old prize left dark — once the
   escrow points away it can no longer pay out (escrow-pointer rule).
4. `startGame()` — fresh round 1 (old rounds stay readable at the v5 address).
5. **Frontend/settler:** `ADDRESSES.TimbPrize` in config.js + cache token,
   `TIMBPRIZE_ADDR` in scripts/settler.js, docs/SPECS address tables,
   Sourcify-verify v6.
6. Env-snapshot rule: the running settler keeps the old prize address until its
   next run — expect the usual startup "CRITICALLY DELAYED" alarm after
   cutover; self-corrects on the next run.

---

## 16. Settler single-source config — hardening (partly DONE)

**Done (#131):** `scripts/settler.js` no longer hardcodes `TIMBPRIZE_ADDR` /
`GAMEREGISTRY_ADDR` — `addrFromConfig()` reads them out of `config.js` (the
frontend's source of truth) at startup, checksum-validates via
`ethers.getAddress`, and throws loudly on a missing/bad key. A redeploy now only
needs `config.js` edited; the settler follows. (Root-caused after the settler was
found still targeting the retired v6 prize / v5 registry.)

**TODO — extend the same pattern to the settler's remaining config so nothing
else can drift:**
- **RPC:** `RPC_URL` is `process.env.ARB_SEPOLIA_RPC`. Fine as a secret, but
  consider falling back to `config.js`'s `RPC_URL` (already the public endpoint)
  when the env var is absent, so a fresh checkout still runs.
- **Any future addresses** the settler needs (vault, escrow) should go through
  `addrFromConfig(...)`, never a literal.
- Sweep on every redeploy: `grep -n '0x[0-9a-fA-F]\{40\}' scripts/*.js` should
  return **nothing** (all addresses derived), so a stale literal can't hide.

**Redeploy re-point rule — FOUR contracts, not three (learned the hard way,
v7):** a TimbPrize redeploy must repoint **PrizeEscrow, GameRegistry,
TimbYieldVault, AND TimbSwapRouter** via `setTimbPrize(new)`. The router is the
easy miss — it holds `timbPrize` and calls `nudgeScroll()`, so skipping it leaves
swaps + the Advance button nudging the OLD prize while the new meter sits frozen.
`dev-docs/TIMBPRIZE_V7_REDEPLOY.md` §4 now lists all four.

**Settler lint gotcha (v7 hotfix #133):** `node --check` only parses — it won't
catch a wrong-version API call. The settler is **ethers v6** (`ethers.getAddress`,
`ethers.formatEther`, `new ethers.JsonRpcProvider` — no `.utils`/`.providers`
namespaces). A `ethers.utils.getAddress` (v5) slipped through a syntax check and
crash-looped the keeper at startup. Before touching `scripts/settler.js`, actually
run it (`cd scripts && npm i ethers && node settler.js` — it exits fast if RPC/env
are unset) so a v5/v6 API mismatch surfaces locally, not in Actions.

**`TimbTreasury.distributeToStaking` is broken — fix before mainnet (found live,
round-55 epoch settle):** the function pushes TIMBS to the staking contract and
*then* calls `notifyRewardAmount`, which itself does
`safeTransferFrom(msg.sender, ...)` — a **second pull of the same amount** that
the Treasury never approved. It always reverts
`ERC20InsufficientAllowance(TimbStaking, 0, amount)`, so this path has **never
once succeeded**; `TimbStaking.periodFinish` stayed `0` ("not started") for the
life of the deployment.

Do **not** "fix" it by approving TimbStaking from the Treasury — with both the
transfer *and* the pull in place the Treasury would pay **twice**. The correct
contract fix is one or the other, not both:
- either drop the `safeTransfer` and `approve(timbStaking, amount)` before
  notifying (pull model, matches `notifyRewardAmount`'s own expectation), or
- give TimbStaking a push-style entry point that credits an already-received
  balance without a `transferFrom`.

Until a Treasury redeploy, the epoch keeper routes **around** it (#245) using the
same path the farm already uses: `withdrawToken(TIMBS, keeper, amt)` →
`approve(TimbStaking, amt)` → `staking.notifyRewardAmount(amt, duration)`. That
works because the keeper wallet is a registered `rewardNotifier` on TimbStaking
(as is the Treasury) — verify `rewardNotifiers[keeper] == true` after any
staking redeploy, or the keeper's staking grant reverts `NotAuthorised`.

**Keeper failures must not roll back a partial epoch (same incident):** the
staking revert threw *before* `saveState()`, so `lastEpochRound` never advanced
and every subsequent 2-hourly run re-settled the *same* epoch — re-granting the
farm each time. Four identical **8,725.95 TIMBS** grants (~34.9k total) landed on
TimbFarm before it was caught. Any new keeper step that spends funds belongs in
its own try/catch so one failing leg can't restart the whole settle.
