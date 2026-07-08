# Prize Game Balance Spec — #1 (anti-dominance) + #2 (feed fee/burn), and Scenario C (TIMBS hub)

Status: **DRAFT for approval** — no code written yet.
Target contracts: `contracts/TimbSwapRouter.sol` (primary), `contracts/TimbPrize.sol` (read-only unless the optional jitter is chosen).

---

## Problem recap (verified against source)

- Winning digit per segment = `segmentDigitCounter[i] % 36`, frozen at the 59:45 lock
  (`TimbPrize.sol:490`, `:317`). Deterministic, **last-nudge-wins**.
- Two nudge paths today, both weight **+1**:
  - Eligible swap → one nudge, `_maybeNudge` (`TimbSwapRouter.sol:219-238`).
  - `advanceScroll(count)` → gas-only, no swap, `count`≤`MAX_BATCH_NUDGE`(20) (`:468-483`).
- Consequence: the cheapest way to move the meter is **gas-only `advanceScroll`**, which
  (a) lets a bot snipe the final nudge and dominate, and (b) generates **no swap volume**, so
  the bot war does *not* feed the 0.05% fee → 50/50 burn/stake loop.

Goal #1: casual players can win (curb single-actor dominance of the final nudge).
Goal #2: make the meter race route through the AMM so it feeds Treasury/burn/stakers.

---

## Key design win: this is a **Router-only change**

All new logic lives in the Router. `TimbPrize.nudgeScroll()` is called as-is (one nudge per
call); a weighted swap simply calls it N times. The Router already reads `currentRound()`,
`currentSegment()`, `isSettlementWindow()` from TimbPrize (all public). So:

- **No TimbPrize redeploy.** No re-wiring of TimbPrize's escrow/registry/vault pointers.
- Redeploy scope = **new Router only**, then a single `TimbPrize.setRouter(newRouter)` call
  plus setting the new Router's own pointers (factory, eligibleRegistry, timbPrize, treasury,
  weth). Blast radius is the smallest possible for a nudge-path change.

(Exception: the *optional* jitter in §1b touches TimbPrize and is deliberately deferred.)

---

## #2 — Swap-weighted nudges (feed the fee/burn machine)

New Router state:
```solidity
uint256 public swapNudgeWeight = 3;   // meter units per eligible swap (owner-set, 1..MAX)
uint256 public constant MAX_SWAP_NUDGE_WEIGHT = 10; // sanity ceiling
```

In `_maybeNudge`, replace the single call with a weighted loop:
```solidity
// swap path — paid, uncapped, self-limiting via fees + slippage
uint256 w = swapNudgeWeight;
for (uint256 i = 0; i < w; i++) {
    try ITimbPrize(timbPrize).nudgeScroll() {} catch { break; } // stop if window opens mid-loop
}
```
Each call does `positionCounter++` and `segmentDigitCounter[seg]++`, so a swap moves the meter
by `w`. Effect: one swap is worth `w` gas-only nudges → the paid path dominates meter movement,
and because it flows through the pair, it books the LP fee + the 0.05% protocol fee → Treasury →
burn/stake. **This is the loop you wanted, driven by real trades.**

Owner setter: `setSwapNudgeWeight(uint256)` with `1 <= w <= MAX_SWAP_NUDGE_WEIGHT`.

---

## #1 — Cap the free path + unpredictable lock

### 1a. Per-address free-nudge cap (UX-preserving, recommended)

Only the **gas-only** `advanceScroll` path is capped; paid swap-nudges stay uncapped (they cost
real money per wallet, so they're self-limiting and sybil doesn't help).

New Router state:
```solidity
uint256 public freeNudgeCapPerSeg = 10;                 // owner-set
mapping(bytes32 => uint256) public freeNudgesUsed;      // key(round,segment,user) => used
```
Key includes round+segment, so it **auto-resets** every segment — no cleanup needed.

`advanceScroll(count)` becomes cap-aware and clamps instead of reverting mid-batch:
```solidity
uint256 round = ITimbPrize(timbPrize).currentRound();
uint256 seg   = ITimbPrize(timbPrize).currentSegment();
bytes32 k = keccak256(abi.encode(round, seg, msg.sender));
uint256 used = freeNudgesUsed[k];
uint256 room = freeNudgeCapPerSeg > used ? freeNudgeCapPerSeg - used : 0;
uint256 n = count < room ? count : room;
if (n == 0) revert FreeNudgeCapReached(round, seg);
freeNudgesUsed[k] = used + n;
for (uint256 i = 0; i < n; i++) ITimbPrize(timbPrize).nudgeScroll();
```
Plus a view `freeNudgesRemaining(address)` so the frontend shows remaining free nudges and
never submits a doomed batch.

Owner setter: `setFreeNudgeCapPerSeg(uint256)`.

**Honest limit:** a per-address cap is a speed bump, not a wall — a bot can sybil across wallets.
What gives it teeth is the pairing with #2: the *paid* path (swaps) costs fees per wallet
regardless of how many you spin up, so the only uncapped way to dominate the meter is to spend
real money that lands in your Treasury. The cap kills free spam; #2 makes the alternative pay you.

### 1b. Unpredictable lock value — OPTIONAL, DEFERRED (not in v1)

To fully stop final-nudge sniping you must decouple the *visible meter* from the *locked digit*
(e.g. `final = (counter + uint256(blockhash(block.number-1))) % 36`). This is Gemini's jitter.

**Recommendation: do NOT ship this in v1.** It breaks the core UX you just built — "the 6 locked
digits *are* the winning string" — because the final digit would jump ±random at settle. And on
Arbitrum the L2 blockhash is sequencer-influenced/low-entropy, so it isn't honest randomness
anyway. If you later want provable fairness, the right move is Chainlink VRF / commit-reveal as a
deliberate game redesign (own spec), not a cheap blockhash patch. Flagged here so it's a
conscious deferral, not an oversight.

---

## Redeploy & rewire checklist (for #1 + #2, Router-only)

1. Deploy new `TimbSwapRouter` with the added state/functions.
2. `TimbPrize.setRouter(newRouter)` — authorises the new Router to nudge.
3. On the new Router, set: factory, eligibleRegistry, timbPrize, treasury, WETH (mirror current).
4. Frontend: point `ADDRESSES.TimbSwapRouter` at the new Router; add `freeNudgesRemaining` read to
   the Advance panel; bump cache token.
5. Old Router keeps working for swaps but no longer nudges (Prize only trusts the new one) — do
   the switch in one sitting to avoid a dead-meter gap.

Config surface added: `setSwapNudgeWeight`, `setFreeNudgeCapPerSeg` (both owner-only, both with
bounds). Defaults proposed: **weight 3, cap 10 per segment.**

---

## Scenario C — TIMBS as the hub/routing token (separate, bigger decision)

**Idea:** every cross-token swap routes `A → TIMBS → B` instead of a direct `A/B` pool, making
TIMBS the base asset of the whole DEX (the role WETH usually plays).

### Why it supercharges #2
- All platform volume flows through TIMBS → structural TIMBS demand (ecosystem reserve currency).
- Cross swap = 2 hops = 2 protocol-fee events on TIMBS legs → more Treasury → more burn/stake,
  **automatically**, from organic trading rather than gamed nudges.
- If "TIMBS-leg swap = nudge", the meter is driven by genuine trade — dilutes pure-bot dominance.

### Real costs (why it's a DEX-architecture pivot, not a tweak)
1. **~2× cost per cross-trade** — two LP fees + two protocol fees + two slippage/impact events.
   A direct A/B pool always beats it on price. Fine in a closed testnet ecosystem; a real
   liability against competing routers.
2. **TIMBS volatility bleeds into every pair.** Hub tokens are normally *stable* (WETH/USDC) for
   exactly this reason; TIMBS is a volatile, gameable token, so its price noise sits inside every
   A→B trade.
3. **MEV surface grows structurally** — two hops = two sandwich spots per trade, permanently.
4. **Liquidity bootstrap burden** — every listed token needs a *deep* TIMBS pair or routing is
   unusable; you can't lean on external A/B liquidity.
5. **Swap-core rewrite** — multi-hop path `[A, TIMBS, B]`, two `_swapOnPair` calls, per-hop fee
   collection, nudge on the TIMBS leg.

### Enforcement choice (the decision)
- **Factory-hard:** Factory only permits `token/TIMBS` pairs. Clean, guarantees the hub, but
  rigid and irreversible-ish.
- **Router-soft (recommended):** direct pairs may exist, but the Router *prefers* the TIMBS route
  (falls back to direct only when no TIMBS path). Keeps optionality, reversible, lets you A/B the
  double-fee cost before committing. Downside: a user can call the pair directly to bypass.

### Interaction with #1/#2
- C **largely absorbs #2**: if all volume already routes through TIMBS, "weight swap-nudges" just
  becomes "TIMBS-leg swap nudges." The #2 work above is **forward-compatible** — building it now
  is not wasted if you later adopt C.
- C **does not fix #1**: last-nudge sniping still needs the free-cap (1a). #1 stands alone.

### Recommendation
Ship **#1 + #2 first** (small, Router-only, reversible). Treat **C** as its own decision after
you've seen #2's effect on volume/fees — and if you pursue C, start with **Router-soft**
enforcement so the double-fee UX cost is measured before it's mandatory.

---

## Decisions needed from you
1. `swapNudgeWeight` default — proposed **3**. (Higher = swaps dominate the meter more.)
2. `freeNudgeCapPerSeg` default — proposed **10** free nudges/address/segment.
3. Jitter (§1b) — **defer** (my rec) or include now (accepts meter-UX change)?
4. Scenario C — pursue now / after seeing #2 / not at all; and Factory-hard vs Router-soft.
