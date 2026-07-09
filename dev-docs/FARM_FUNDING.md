# Farm / Staking — funding sources & setting APR

Quick owner reference for keeping the TIMBS staking pool (`TimbStaking`) and the
LP farm (`TimbFarm`) funded, and for setting a sane APR. All amounts are in wei
(18 decimals) unless noted.

## The two things that must line up

The APR number and the ability to actually pay rewards are **separate**:

- **Rate** — drives the displayed APR and reward accrual. Set by the owner.
- **Solvency (reserve)** — the pool must physically hold enough TIMBS, or a
  `claimRewards()` reverts with `InsufficientRewardBalance`. `claimRewards`
  pays from `balanceOf(pool) − totalStaked`.

Fund the reserve **first**, then set the rate.

```
APR (bps) = rewardRatePerSecond × 365 days × 10000 / totalStaked
```
So APR moves only when the **rate** changes or **totalStaked** changes. Claims
and plain token transfers do NOT move it. (Tiny testnet stake ⇒ absurd APR; the
farm UI caps the *display* at ">10,000%".)

## Where TIMBS comes from (fund the reserve)

1. **`TIMBSToken.mintEmissions(pool, amount)`** — the intended faucet.
   `onlyMinter` = **stakingPool, farmPool, or owner**; must keep
   `totalSupply ≤ HARD_CAP` (100,000,000 TIMBS). Check headroom with
   `remainingEmissionsCapacity()`. Mints fresh TIMBS straight into the pool.
2. **Owner wallet** — `TIMBSToken.transfer(pool, amount)` from your own balance.
3. **Treasury** — the constructor minted `initialSupply` to `TimbTreasury`;
   move some to the pools.

## Setting the APR (set the rate)

Owner-only, on each pool (`TimbStaking` / `TimbFarm`):

- **`notifyRewardAmount(amount, duration)`** — the clean way. Recomputes
  `rewardRatePerSecond = (amount + leftover) / duration` (leftover = unspent
  rewards from the current period). This both sets the rate **and** implies the
  runway (`amount` over `duration`). Fund the pool with ≥ `amount` first.
- **`setRewardRate(ratePerSecond)`** — sets the rate directly (no runway
  implied); make sure the reserve can cover it.

### Target a specific APR
To hit a target APR at the current stake:
```
ratePerSecond = targetAprFraction × totalStaked / (365 × 24 × 3600)
amount        = ratePerSecond × duration        # fund at least this
```
Example — 50% APR on 2,300 TIMBS staked, funded for 90 days:
`ratePerSecond = 0.50 × 2300e18 / 31,536,000 ≈ 3.647e13 wei/s`;
`amount = 3.647e13 × (90×86400) ≈ 283.6e18` → mint ~284 TIMBS to the pool, then
`notifyRewardAmount(284e18, 7776000)`.

## Gotchas

- Do all of this on **Arbitrum Sepolia (chainId 421614)** — not mainnet.
- `notifyRewardAmount` reverts if the pool's reserve can't cover `amount`
  (fund first).
- More people staking lowers everyone's APR proportionally (same rewards, more
  weight) — expected.
