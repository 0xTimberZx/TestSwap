# Boosted farms + 6-round epoch distribution — design spec

Status: **DRAFT / design.** No contracts written yet. This captures the rule as
described so we can lock the math and the architecture before touching code.
Open questions are marked **⚠ DECIDE**.

Extends `FARM_FUNDING.md` (which is the manual owner-funding reference). This doc
is about the **automatic** funding loop.

---

## 0. Vocabulary

| Term | Meaning |
|---|---|
| **Epoch** | A block of **6 rounds**. The settlement fires at the *beginning* of each 6-round block. |
| **Main farm** | Existing `TimbFarm` — the TIMB/ETH LP farm. |
| **Staking** | Existing `TimbStaking` — single-sided TIMBS staking. |
| **Boosted farms** (aka sub-liquidity) | **NEW** multi-pool farm for extra pairs — stable pairs, boosted extra pairs, etc. Competes for one shared TIMBS pool. |
| **Treasury** | `TimbTreasury` — accrues TIMBS via buybacks; the funding source. |

## 1. Measured inputs (all "since the last epoch call")

| Var | Definition | Source |
|---|---|---|
| `w` | TIMBS claimed via **staking** this epoch | `TimbStaking.RewardsClaimed` |
| `y` | TIMBS claimed via **main farm** this epoch | `TimbFarm.RewardsClaimed` |
| `z` | TIMBS **collected into Treasury** this epoch (net buyback acquisition) | `TimbTreasury.BuybackExecuted` |
| `x` | Per-claim boost draw = **5% of a main-farm claim** | computed on each main-farm claim |

> **None of `w`, `y`, `z` are tracked on-chain today.** The contracts only emit
> per-event logs — there is no running counter and no epoch checkpoint. This is
> the pivotal constraint (see §5).

## 2. Epoch settlement (every 6 rounds)

At the epoch boundary:

```
B = z                                       # one shared epoch budget

farmGrant  = min( 0.80 × y , B )            # farm replenishes first
B          = B − farmGrant

stakeGrant = min( 1.25 × w , 0.80 × B )     # staking replenishes second
B          = B − stakeGrant

boostBudget = B                             # boost draws from what's left
```

**One shared epoch budget — strict waterfall (DECIDED).** All three sinks draw
from the same pool `z`, in priority order **farm → staking → boost**:

1. **Farm** replenishes its calculated claims first
   (`TimbFarm.notifyRewardAmount(farmGrant, epochSeconds)`). If the farm's
   grant consumes the entire budget, **staking gets nothing and boost gets
   nothing** this epoch.
2. **Staking** replenishes second
   (`TimbTreasury.distributeToStaking(stakeGrant, epochSeconds)` — already
   exists) — up to 1.25× its claims, capped at 80% of what the farm left. If
   staking cleans out the remainder, **boost cannot refill** this epoch.
3. **Boost** gets whatever survives (`boostBudget`). Draws happen *while*
   main-farm claims are made during the epoch (5% per claim, §3). When
   `boostBudget` is exhausted, **that is all until the next cycle** — no
   mid-epoch top-up, draws simply stop.

Total epoch outflow can never exceed `z` — the Treasury never pays out more
than it collected in the epoch, so reserves are never drawn down by this loop.

## 3. Boosted farms — continuous 5% stream

Runs throughout the epoch, drawing against `boostBudget` fixed at settlement:

- On **every TIMB/ETH main-farm claim** of `c` TIMBS, draw `x = 0.05 × c` from
  the Treasury into the **shared boost pool**.
- **Cap:** cumulative boost draws in an epoch **cannot exceed `boostBudget`**
  (the waterfall remainder from §2). A draw that would cross the cap is
  truncated to the remaining budget; after that, draws stop until next epoch.
- The boost pool is **shared**: all boosted sub-pools draw emissions from it.
- **Competition / "scale of 1":** total pool weight = 1, split across the
  boosted pools. How much TIMBS accumulates in each pool is set by its weight;
  within a pool, each wallet claims **pro-rata to its LP share**. Assets in
  boosted pools are competing for the same TIMBS, so the split is
  weight-of-pool × share-of-wallet.
- **Emission speed:** the boost emission rate is set to drain the accumulated
  pool over **a bit over 6 rounds**. It **recalculates on every claim** — after
  each deduction (a claim) or top-up (a 5% draw), `rate = poolRemaining /
  (~6 rounds + buffer)`. This is the standard MasterChef "notify resets the
  rate" pattern, re-run continuously.

## 4. Boosted-farm rules / constraints

- **Individually pausable** — each boosted pool can be paused on its own without
  touching the others or the shared pool.
- **NOT whitelisted** — boosted pool assets are never added to
  `EligibleTokenRegistry`.
- **NOT nudge-eligible** — boosted activity contributes **nothing** to the prize
  meter (no swap-nudge influence). Kept entirely out of the game loop.

## 5. Decision log + remaining forks

### 5a. Budget composition — ✅ DECIDED (one shared waterfall)
One shared epoch budget `z`, strict priority **farm → staking → boost** as
encoded in §2. Farm cleaning out the budget starves staking and boost; staking
cleaning out the remainder starves boost; boost exhausting its remainder ends
draws until the next cycle. Total outflow ≤ `z`; no reserve drawdown.

### 5b. On-chain hook vs keeper
The 5% boost draw reacts to **each main-farm claim**. Two ways:
- **On-chain hook** — `TimbFarm.claimRewards()` calls the Treasury→BoostFarm
  draw inline. Cleanest economics, but requires **redeploying `TimbFarm`**,
  which forces an **LP migration** (every farmer unstakes from old, restakes
  into new).
- **Keeper (batched)** — the settler reads main-farm claims since its last run,
  draws 5% of the batch into the boost pool, and re-notifies the boost emission.
  Since boost emissions already spread over ~6 rounds, per-claim immediacy isn't
  economically necessary — batching at keeper cadence is equivalent. **No
  redeploy, no migration.** Same trust model as today's buybacks/settler.

Same fork governs `w`/`y`/`z`: on-chain needs counters in
Staking+Farm+Treasury (⇒ redeploy all three, migrate stakers+farmers); keeper
reads events (⇒ no redeploy).

### 5c. Epoch trigger
Boundary = first settle where `TimbPrize.currentRound` crosses a multiple of 6.
Either a permissionless `runEpoch()` with a once-per-epoch guard, or the keeper
fires it. (Keeper is consistent with the settler that already advances rounds.)

## 6. Recommended architecture (greenfield-first)

1. **NEW `TimbBoostFarm`** — multi-pool MasterChef: `addPool(lp, weight)`,
   `poolInfo[]`, per-user per-pool accounting, per-pool `paused`, one shared
   TIMBS reward reserve, `notifyRewardAmount` that recomputes the rate over
   ~6-rounds-plus-buffer. **Fresh deploy — no migration** (it holds no existing
   stakes). This is buildable now regardless of the §5b decision.
2. **Distribution loop** — start as a **keeper** (extend `scripts/settler.js`):
   compute `w`/`y`/`z` from events each epoch, execute via
   `Treasury.distributeToStaking(...)`, `Treasury.withdrawToken(TIMBS, farm, farmGrant)`
   + `farm.notifyRewardAmount(...)`, and batch the 5% boost draws into
   `TimbBoostFarm.notifyRewardAmount(...)`. Ships the whole product with **zero
   redeploys of the live staking/farm contracts**.
3. **Later, if we want it trustless** — redeploy Staking/Farm/Treasury with
   cumulative counters + an on-chain `EpochDistributor`, and migrate. Deferred;
   put on `CONTRACT_TODO.md` when chosen.

## 7. Contracts touched (summary)

| Contract | Change | Redeploy? |
|---|---|---|
| `TimbBoostFarm` (new) | multi-pool boosted farm | new deploy (no migration) |
| `TimbTreasury` | authorize BoostFarm draws; (on-chain path) add TIMBS-acquired counter | keeper path: **no**; on-chain path: yes |
| `TimbFarm` | (on-chain path only) 5%-on-claim hook + claimed counter | keeper path: **no**; on-chain path: yes + migration |
| `TimbStaking` | (on-chain path only) claimed counter | keeper path: **no**; on-chain path: yes + migration |
| `TimbPrize` | epoch-boundary read (`currentRound % 6`) | no (read-only) |

## 8. Frontend (later)
- Boosted-farms tab: per-pool APR/weight, wallet's pro-rata claimable, paused
  badge, "not eligible for nudges" note.
- These pools must be **excluded** from any nudge/whitelist UI surface.
