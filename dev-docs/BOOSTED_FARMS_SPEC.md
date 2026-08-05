# Boosted farms + 6-round epoch distribution — design spec

Status: **BUILT — awaiting deploy.** All three decisions locked (§5).
Artifacts: `contracts/TimbBoostFarm.sol` (compile-verified, solc 0.8.24
viaIR/optimizer-200/cancun, ~7.1 KB bytecode), `scripts/epoch.js` (keeper),
`.github/workflows/epoch.yml`. Deploy checklist in §9.

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

### 5b. On-chain hook vs keeper — ✅ DECIDED (keeper)
The keeper (settler-style script) computes `w`/`y`/`z` from events each epoch
and batches the 5% boost draws: it reads main-farm `RewardsClaimed` since its
last run, draws 5% of the batch from the Treasury into the boost pool (within
`boostBudget`), and re-notifies the boost emission. Since boost emissions
spread over ~6 rounds, per-claim immediacy isn't economically necessary —
batching at keeper cadence is equivalent. **No redeploy of live Staking/Farm,
no migration.** Same trust model as today's buybacks/settler. On-chain
counters + trustless EpochDistributor stay a possible later upgrade
(`CONTRACT_TODO.md` when chosen).

### 5c. Epoch trigger — ✅ DECIDED (keeper-fired, follows 5b)
Boundary = first keeper run where `TimbPrize.currentRound` has crossed the next
multiple of 6. The keeper persists the last-settled epoch + block cursor so
each epoch settles exactly once and `w`/`y`/`z` windows never overlap or gap.

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

## 7b. Hooks, secondary emitters, anti-phantom (v2)

Added after the initial build (pre-deploy, so no migration):

- **Hooks — call into other vaults.** Each pool carries up to 4 owner-managed
  hook contracts (`addPoolHook` / `removePoolHook`). Every
  deposit/withdraw/claim/emergency fans out to them
  (`IBoostHook.onBoostAction(action, pid, user, amount, stakedAfter)`).
  Calls are try/catch-guarded with a `HookFailed` event — a broken or
  malicious vault can never trap user LP.
- **Secondary emission tokens (WETH etc.) — `BoostRewarder.sol`.** One
  rewarder per (pool, token): it implements the hook interface, mirrors
  stake balances from the authoritative `stakedAfter` (sync semantics, not
  deltas), and streams its own token with the same self-retargeting
  reserve/window emission. **Add** a token by attaching another rewarder;
  **replace** one by swapping the hook. Users claim via
  `rewarder.claim(pid)`. A staker already in the pool before a rewarder
  attaches starts earning at their next farm interaction (first sync).
- **Anti-phantom validation.** `addPool` requires the LP to be a live
  contract AND a genuine factory pair: `lp.token0()/token1()` must
  round-trip through `TimbSwapFactory.getPair` back to the LP address — a
  fabricated pair contract cannot pass. Hooks must have code. `setFactory(0)`
  disables the pair check only as a deliberate owner action (legit external
  LP), set it back after.

## 7c. Solvency stop (v2.1)

Owner's integrity rule: **if total pending across wallets exceeds the balance
or reaches 99%, things stop — no accruing happens.** Implemented in both
TimbBoostFarm and BoostRewarder:

- `totalOwed` tracks accrued-but-unclaimed rewards across all pools/stakers
  (incremented on accrual, decremented on claim; emergency-forfeited pending
  is released back).
- Every retarget streams the **free** reserve (`rewardReserve − totalOwed`)
  over the window instead of the gross reserve — the flaw this fixes:
  repeated top-ups without claims previously re-promised TIMBS already owed.
- At `totalOwed ≥ 99%` of the reserve (`SOLVENCY_STOP_BPS = 9_900`), the
  rate retargets to **zero**: accrual halts, every accrued wei stays
  payable, and **LP deposit/withdraw keep functioning**. The next top-up
  (or claims freeing owed) restarts emission automatically — no owner
  intervention.

> Note (Jul 17): a fresh single-pool `TimbFarm` was deployed at
> `0xe4c67D18A8301B9A2e68a635FBCBb0E799C920a5` intending it as the extra-pairs
> farm — but TimbFarm holds exactly ONE lp token (locked on first stake), so
> it cannot serve "USDT/LINK/DAPP pairs etc.". Park it unfunded; deploy
> `TimbBoostFarm` (this spec) for that role.

## 8. Frontend (later)
- Boosted-farms tab: per-pool APR/weight, wallet's pro-rata claimable, paused
  badge, "not eligible for nudges" note.
- These pools must be **excluded** from any nudge/whitelist UI surface.

## 9. Deploy checklist

1. **Deploy `TimbBoostFarm(TIMBSToken, emissionWindow, TimbSwapFactory)`** —
   `emissionWindow` in seconds, "a bit over 6 rounds": `6 × ROUND_DURATION +
   buffer` (read `ROUND_DURATION()` off TimbPrize; e.g. +20% buffer).
   Owner-tunable later via `setEmissionWindow`. The factory arg arms the
   anti-phantom pair check from block one.
   *Operational note:* the live window was later stretched to **14 rounds
   (302,400s)** via `scripts/set-boost-window.js` (Admin — Set Boost Emission
   Window workflow) to slow the boost drip so each epoch's budget lasts
   longer between refills.
1b. **Per secondary token (optional, e.g. WETH):** deploy
   `BoostRewarder(boostFarm, weth, emissionWindow)`, then
   `boostFarm.addPoolHook(pid, rewarder)` and fund via
   `rewarder.notifyRewardAmount(amount)` (approve first). Keeper can be
   authorised with `rewarder.setRewardNotifier(keeper, true)`.
2. `addPool(lp, weight)` per boosted pair (USDC/USDT etc.). Weights are
   relative — the active set behaves as a scale of 1. **Never** add these LPs
   to `EligibleTokenRegistry`, and the pairs stay out of nudge eligibility.
3. `setRewardNotifier(<keeper wallet>, true)` on the BoostFarm.
4. Add `TimbBoostFarm: "0x…"` to `ADDRESSES` in `config.js`. The keeper reads
   it from there; until the key exists, `epoch.js` runs with the boost stream
   disabled (epoch waterfall still settles farm + staking).
5. **GitHub secrets/vars** for `.github/workflows/epoch.yml`:
   - `EPOCH_PRIVATE_KEY` (secret) — **must be the TimbTreasury owner**
     (`distributeToStaking` / `withdrawToken` are onlyOwner). Bigger key than
     the settler's — scope it tightly.
   - `EPOCH_GENESIS_BLOCK` (repo var) — block where epoch #1 starts measuring
     (first run only; afterwards `scripts/epoch-state.json` is the cursor).
   - Reuses `ARB_SEPOLIA_RPC`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
6. First run: `workflow_dispatch` with mode **dry-run** — verify the printed
   `z/y/w`, grants, and boostBudget look sane before letting the cron run live.
7. State file `scripts/epoch-state.json` is committed back by the workflow
   with `[skip ci]` (doesn't trigger the site deploy). Don't hand-edit it —
   it is the only record of the epoch cursor (a zero-grant epoch leaves no
   on-chain marker).

## 9c. ⚠ Live-contract emission-window note (0x551D…Bd35)

The deployed boost farm `0x551D…Bd35` was created with an **over-scaled
`emissionWindow` (2e15 seconds)**, so its first seed set `rate = 100e18 / 2e15
= 50000 wei/s` (≈0 TIMBS/day). `setEmissionWindow(129600)` fixed the variable
but — in the deployed version — did **not** re-aim the rate (only a
claim/`notifyRewardAmount` retargets). One-time fix for the LIVE contract:
approve TIMBS, then `notifyRewardAmount(1e18)` → retargets `~101e18 / 129600 ≈
7.8e14 wei/s ≈ 67 TIMBS/day`.

The source now retargets inside `setEmissionWindow` (both TimbBoostFarm and
BoostRewarder) so a **future redeploy** won't need the notify follow-up. The
live contract predates that and keeps the workaround above.

## 9b. Seed plan (agreed Jul 17)

`TimbBoostFarm` deployed: `0x551D919D517aBa40D2b3A57a91973ad5Ad3CBd35`.
Seed ALL factory pairs except TIMBS/WETH (that LP belongs to the main farm —
it must not compete against itself in boost). Weights are relative (scale of
1); starting shape — majors/stables heavy, DAPP tail; retune anytime with
`setPoolWeight`:

| addPool(lp, weight) | pair | weight |
|---|---|---|
| `0x0Bc8…9965` | WETH/USDT | 25 |
| `0xddB9…4940` | USDC/USDT | 20 |
| `0xaF37…fb6E` | LINK/WETH | 15 |
| `0xDb5F…E44E` | TIMBS/USDC | 15 |
| `0xb227…AF0C` | LINK/USDC | 10 |
| `0xbddc…4c28` | WETH/USDC | 10 |
| `0xba27…056D` | DAPP/WETH | 5 |

(Full addresses: copy from the explore page's Pair Address column or
`factory.getPair` — the anti-phantom check will reject anything that isn't
the genuine factory pair anyway.)

Decision (Jul 17): the explore/V2-pools page STAYS wallet-free — on-chain
data is public regardless (Arbiscan/RPC), and the page is top-of-funnel.
No connect-gate.

## 10. Keeper trust & failure notes

- `epoch.js` fails LOUD (Telegram ops ping + non-zero exit) rather than
  guessing; the waterfall math runs entirely from on-chain events, so a
  re-run after a fix recomputes the same window deterministically **as long
  as the state file wasn't advanced** (state saves only after settlement txs
  succeed).
- Solvency: `z` bounds the *budget*, but grants pay from the Treasury's whole
  TIMBS balance; the keeper checks balance ≥ grants and aborts loudly if not.
- Boost draws truncate at the remaining budget (never partial-over), then
  stop until the next epoch — matching "if boosted clears out, that is all
  until next cycle".
