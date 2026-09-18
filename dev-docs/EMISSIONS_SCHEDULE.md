# TIMBS supply — halving release schedule

The mainnet TIMBS unlock schedule. **Fixed supply, no inflation** — the 100M cap
is minted once at genesis and never grows. This schedule governs only the *pace*
at which locked supply becomes spendable treasury float. **It does not set reward
rates** — those are a separate hand-set policy (§5).

Status: **design spec.** Requires a mainnet deploy-time genesis split, a new
`TimbReleaseVault` contract, and one additive `GameRegistry` counter (§4).

---

## 1. The model

The 100M does **not** sit freely in the treasury. It's split at genesis:

- **50M → treasury** immediately (spendable at launch).
- **50M → an immutable `TimbReleaseVault`**, released to the treasury by halving
  at round milestones.

**Milestones:** rounds **1,000 · 2ⁿ** → 1,000, 2,000, 4,000, 8,000, 16,000 …
At each milestone, **half of whatever is still locked** is released to the
treasury. Releases are **permissionless** (`vault.release()`), deterministic
from the round count — no trust, no keeper required.

Keying to *rounds* (not a clock) means supply only unlocks as the game actually
runs — a stalled ecosystem pauses unlocks.

## 2. Unlock schedule & runway

At the current **6h/round** cadence (0.25 days/round). Time axis scales with the
base interval (1,000) — the single tuning knob.

| Trigger | Released | Cumulative in treasury | Still locked | ≈ Time |
|---|---|---|---|---|
| Launch (genesis) | 50.0M | 50.0M (50%) | 50.0M | day 0 |
| Round 1,000 | 25.0M | 75.0M | 25.0M | ~8 mo |
| Round 2,000 | 12.5M | 87.5M | 12.5M | ~1.4 yr |
| Round 4,000 | 6.25M | 93.75M | 6.25M | ~2.7 yr |
| Round 8,000 | 3.125M | 96.9M | 3.125M | ~5.5 yr |
| Round 16,000 | 1.5625M | 98.4M | 1.5625M | ~11 yr |
| Round 32,000 | 0.78M | 99.2M | 0.78M | ~22 yr |
| Round 64,000 | 0.39M | 99.6M | 0.39M | ~44 yr |
| … | … | → 100M (asymptote) | → 0 | … |

~94% of supply reaches the treasury within ~2.7 years; the remainder is a
decades-long dust tail (geometric series → 100M in the limit). Strongly
front-loaded — deliberate, for bootstrapping. The intended cadence.

## 3. What the schedule is — and is not

- **Is:** a supply-availability ceiling. It controls how much of the 100M the
  treasury *can* spend at any point in time. Locked TIMBS is provably out of
  circulation until its milestone.
- **Is not:** a reward rate. Releasing a tranche to the treasury does not emit it
  to anyone. Nothing about the halving cadence sets how fast rewards flow.

## 4. Round source — must be generation-safe

`TimbPrize.currentRound` **resets to 1** on a game-generation redeploy (the
GameRegistry generations design). Over a decades-long schedule that WILL happen,
and a naive `currentRound` read would re-trigger or freeze the milestones.

The vault must read a **monotonic cross-generation counter**. Add one to
`GameRegistry`:

```solidity
uint256 public cumulativeRounds;   // never resets; ++ on every round settle,
                                   // carried across startGame / generation bumps
```

The vault reads `cumulativeRounds` only. On a multichain future (see
MULTICHAIN_METER_SPEC), the vault lives on the home chain and reads the
**canonical** cumulative round — same counter, unchanged.

## 5. Rewards are a separate policy from the unlock

- The vault moves TIMBS from locked → treasury on the fixed schedule above.
- **Reward grants follow the taper in §6**, not the unlock. The per-round figure
  is policy the keeper applies; it is changeable by governance and is in no way
  bound to a milestone. Delivery is the existing `notifyRewardAmount(amount,
  duration)` / `setRewardRate` on `TimbStaking`, `TimbFarm`, and `TimbBoostFarm`.
- Reward funding draws from the **spendable treasury float** (whatever has
  unlocked) plus the **buyback waterfall** and the WETH `BoostRewarder` real
  yield — exactly as today.

## 6. Farm emission schedule — the n-taper

The unlock (§1–2) says how much TIMBS the treasury *may* spend. This section says
how much it actually hands to the reward pools each round. **Decision: n = 3,000
at round 1.**

### The rule

```
grant(round r) = max(1, n − floor((r − 1) / 4))        n = 3,000
```

Four rounds at the same figure, then down one. At the 6h round cadence four
rounds is exactly one day, so the taper steps down by **1 TIMBS per round per
day** and never drifts against the clock.

The floor is deliberate. The taper's last step down lands on 1 at round
**11,997** (that step runs rounds 11,997–12,000), and from there the grant
**holds at 1 per round indefinitely**, until governance pauses it. It never
reaches zero.

### Closed form

Through round `4m` (m complete four-round steps, while the taper is above the
floor):

```
total(4m) = 4 · [ m·n − m(m−1)/2 ]
```

Shortcuts at n = 3,000:

| Horizon | Expression | TIMBS |
|---|---|---|
| Through round 8,000 | `8000n − 7,996,000` | **16,004,000** |
| Whole taper, through round 12,000 (its last step) | `2n(n+1)` | **18,006,000** |
| Tail, per year from round 12,001 | `4 × 365` | **1,460** |

### Milestones

| Round | Per round | Per day | Cumulative granted | Treasury unlocked (§2) | ≈ Time |
|---|---|---|---|---|---|
| 1 | 3,000 | 12,000 | 3,000 | 50.0M | day 0 |
| 1,000 | 2,751 | 11,004 | 2,875,500 | 75.0M | ~8 mo |
| 2,000 | 2,501 | 10,004 | 5,501,000 | 87.5M | ~1.4 yr |
| 4,000 | 2,001 | 8,004 | 10,002,000 | 93.75M | ~2.7 yr |
| 8,000 | 1,001 | 4,004 | 16,004,000 | 96.9M | ~5.5 yr |
| 12,000 | 1 | 4 | 18,006,000 | 96.9M | ~8.2 yr |
| beyond | 1 | 4 | +1,460 / yr | → 100M | — |

The taper spends **18.0M of the 100M cap** across its full run. Cumulative grants
sit well under the unlocked column at every milestone — the tightest point is the
end of the taper, 18.0M of grants against 96.9M unlocked — so the release curve is
never the binding constraint. The two curves are shaped differently on purpose:
the unlock is geometric and infinite, the taper is linear and lands on a flat
floor.

### Splitting the grant between pools

The per-round figure is the **total** for the emission layer. How it divides
between `TimbStaking` and `TimbFarm` remains the waterfall's job (claim-driven,
`scripts/epoch.js`) or an explicit owner split. The taper caps the sum; it does
not dictate the ratio.

### The 90-day period — every grant re-anchors it

`TimbStaking` and `TimbFarm` are Synthetix-style. `notifyRewardAmount(amount,
duration)` does this:

```solidity
if (block.timestamp < periodFinish) {
    uint256 remaining = periodFinish - block.timestamp;
    uint256 leftover  = remaining * rewardRatePerSecond;
    rewardRatePerSecond = (amount + leftover) / duration;
} else {
    rewardRatePerSecond = amount / duration;
}
periodFinish = block.timestamp + duration;      // unconditional
```

Two properties matter:

1. `periodFinish` is rewritten to `now + duration` on **every** successful call,
   on both branches. A grant therefore **corrects** the time remaining rather
   than extending it.
2. Unspent rewards are never lost — `leftover` rolls into the new rate.

So a constant duration pins the window. **`EMIT_PERIOD_DAYS = 90`** in the epoch
keeper, and the same default on the `Admin — Fund Rewards` workflow, means every
successful grant snaps both pools back to a 90-day runway. They can only
dead-zone if no grant lands for 90 straight days.

This replaces the earlier adaptive sizing (`EMIT_FLOOR_DAYS`, the observed epoch
length, and a slack multiplier), which produced windows anywhere from 4 to 60
days and quietly rewrote the pace on each settlement.

**Steady state.** A grant `G` every `T` days into a `W`-day window settles the
pool's reserve at `G(W − T)/T`, paying out `G` per cycle — about 59 epochs of
grant sitting as float at W = 90. That float is payable to stakers and is what
makes the window un-lapseable, so the farm page always reads ~90 days rather
than counting down to a cliff.

---

## 7. Allocation — lifetime frame, and the Era-1 split

### Eras

Nothing here is a single-shot budget. The unlock milestones (§2) cut the timeline
into **eras**, and both the taper and the wider allocation spread across them.

| Era | Rounds | Ends | Unlocked at its start | §6 taper draws |
|---|---|---|---|---|
| 1 | 1 – 1,000 | ~8 mo | **50.0M** (genesis) | 2,875,500 |
| 2 | 1,001 – 2,000 | ~1.4 yr | 75.0M | 2,625,500 |
| 3 | 2,001 – 4,000 | ~2.7 yr | 87.5M | 4,501,000 |
| 4 | 4,001 – 8,000 | ~5.5 yr | 93.75M | 6,002,000 |
| 5 | 8,001 – 12,000 | ~8.2 yr | 96.9M | 2,002,000 |

The farm layer's **18.0M is a lifetime figure** and no era takes more than about a
third of it. The other ~82.0M is likewise lifetime, and most of it is simply
**not allocated in Era 1** — it stays locked in the release vault and unlocks at
the milestones above.

### Launch price — decided

| Input | Value |
|---|---|
| ETH seeded into TIMBS/WETH | **5 ETH** |
| Target FDV | **100 ETH** |
| → launch price | **0.000001 ETH per TIMBS** (1 ETH = 1,000,000 TIMBS) |
| → TIMBS into the pair | **5,000,000** |
| → pool value at launch | 10 ETH (5 ETH + 5M TIMBS) |

### Era 1 — the genesis 50M

| Bucket | TIMBS | % of 50M | Note |
|---|---|---|---|
| Team | **7,500,000** | 15% | vested, see below |
| Founder / dev | **6,000,000** | 12% | vested, same schedule |
| Liquidity — LP seed at launch | **5,000,000** | 10% | 5 ETH @ 100 ETH FDV |
| Liquidity — depth reserve | **18,124,500** | 36.2% | later depth adds |
| Marketing | **10,000,000** | 20% | |
| Farm + staking taper, Era 1 (§6) | **2,875,500** | 5.75% | fixed by the taper |
| Faucet, Era-1 budget | **500,000** | 1.0% | 100 TIMBS per claim |
| **Total** | **50,000,000** | **100%** | |

Team and founder/dev percentages are **of the genesis 50M**, so 13.5% of the 100M
cap between them. Liquidity totals 23,124,500 (46.2%) across the seed and the
reserve.

> The liquidity / marketing **ratio** is the one number not yet chosen — "the rest
> split for liquidity and marketing" leaves it open. The table proposes
> 18,124,500 / 10,000,000, weighted to liquidity because pair depth is a
> game-integrity parameter (below) and because marketing spend is the harder line
> to reverse once distributed. Adjust freely; the two must sum to 28,124,500.

### Vesting — team and founder/dev

Both tranches **vest on a 6-month cliff inside a 24-month window.** They do not
land unlocked in the Safe at genesis.

**Contract: `contracts/TimbVesting.sol`** — one wallet per beneficiary, a thin
concrete wrapper over OpenZeppelin 5.6.1's audited `VestingWallet` +
`VestingWalletCliff`. It adds no custody logic of its own, so the audit surface
is the two OZ bases plus a refused `receive()`.

| Parameter | Era-1 value | Meaning |
|---|---|---|
| `start` | launch | the clock's origin |
| `cliff` | 180 days | nothing releasable before `start + cliff` |
| `duration` | 730 days | the **whole** window; fully vested at `start + duration` |

**Cliff semantics (OZ):** at the cliff, the linear amount for time already
elapsed unlocks in one step — a catch-up of 180/730 ≈ 24.7% — then it streams
linearly to month twenty-four. If the intended reading is "six months, *then*
twenty-four months of linear", that is the same contract with `duration = 910
days` and nothing else changes; a test pins both shapes.

The wallet vests **whatever it holds plus what it has released**, so the
allocation is simply the amount the Safe transfers in. A later top-up joins the
*same* schedule as if present from `start`, so fund each wallet **once, before
its cliff**. `scripts/DeployVesting.s.sol` deploys the wallets and prints the
exact Safe transfers; it moves no tokens itself.

Properties, and the decisions they encode:

- **Irrevocable.** No clawback. A departing team member keeps their schedule.
  Trustless for the beneficiary; the cost is that there is no lever for a bad
  leaver. If one is wanted it is a different contract, not a flag on this one.
- **Ownership is transferable** (key rotation). OZ's own caveat applies: unvested
  tokens can effectively be sold by selling the wallet. Accepted.
- **`release` is permissionless** and always pays the owner.
- **TIMBS only.** ETH is refused.
- **Beneficiary count is a deploy input.** "Team" at 7.5M is one wallet or
  several; the script takes a list and the sum is what matters.

Still needs the audit alongside the release vault — see §9.

### Fair release — faucet only, for now

**Decided: the mainnet faucet is the only release channel, gated on a live
mainnet ticket. It drips 100 TIMBS per claim against a 500,000 TIMBS Era-1
budget.** The testnet-claim → mainnet-TIMB bridge stays **off**, matching the
retirement already recorded in `MAINNET_FAUCET_PROPOSALS.md` §0 and §5. An
airdrop campaign may be added later; nothing in this table depends on one.

`timbsCap` on the contract is cumulative-for-life, so it is set to the Era-1
budget; raising it for Era 2 is one owner tx. At 100 per claim the budget is
**5,000 claims**. Era 1 runs 250 days, so ~20 claims a day sustains it for the
whole era, while 100 claimers a day exhausts it in 50.

> **Check before enabling.** The faucet doc's guard is that a claim must never be
> worth a ticket. A claim is now worth 0.0004 ETH (0.0002 drip + 0.0001 pot +
> 100 TIMBS at 0.0001), against a cheapest ticket — the TIMBS leg — of 0.0005
> ETH. That is 80% of a ticket, so one ticket pays for itself in about a day and
> a quarter of claiming, and the ticket gate stops being an economic barrier.
> The rolling `operatorEthCap` bounds the ETH legs but **not** the TIMBS leg.

**The concentration guard.** The cooldown paces a wallet; it never stops one.
Over an era of `E` days at one claim per day a wallet can claim `E + 1` times, so
Era 1 allows **251 claims = 25,100 TIMBS per wallet** — meaning roughly **20
dedicated wallets absorb the whole 500,000 budget**. `GasFaucet.maxTimbsPerWallet`
bounds that per address, leaving the cooldown and the ticket gate untouched. 0
disables it; the mainnet value is **5,000 TIMBS** (50 claims), which guarantees at
least 100 distinct wallets are served and caps any single wallet at 1% of the era
budget. It is owner-settable in one tx:

| Per-wallet cap | Wallets guaranteed served | Claims each |
|---|---|---|
| 1,000 TIMBS | 500 | 10 |
| 2,500 TIMBS | 200 | 25 |
| **5,000 TIMBS** | **100** | **50** |
| 10,000 TIMBS | 50 | 100 |

The same arithmetic gives the **detection half** of the guard, built as
`scripts/faucet-invariants.js` on the `TimbSwap Faucet Invariants` workflow
(every six hours, read-only, no key). It scans `Dispensed` events and checks
the record against what the cooldown and the era *permit*:

| | Invariant | On breach |
|---|---|---|
| A | every wallet's consecutive claims are ≥ cooldown apart | fail + alert |
| B | per wallet, claims ≤ `floor((last − first) / cooldown) + 1` | fail + alert |
| C | `total ≤ unique_wallets × (floor((now − eraStart)/cooldown) + 1)` | fail + alert |
| D | contract `timbsClaimedBy(w)` = Σ events, and ≤ `maxTimbsPerWallet` | fail + alert |
| E | TIMBS spent / cap vs era elapsed, within a slack | warn |
| F | top-5 wallets' share of the total | printed |

A is exact; B and C are the bound as spoken and follow from it. A breach of
A–D means the cooldown was **bypassed** rather than exhausted — a dispatcher or
contract bug, or a redeploy that lost `lastClaimAt` — which is a different and
worse failure than the budget draining, and the cap cannot catch it. The
monitor keeps one compact entry per wallet as its cursor, so only new claims
are fetched each run; set `FAUCET_GENESIS_BLOCK` to the faucet's deploy block
before the first mainnet run or older claims fall outside the record (the
testnet deploy block is the script's built-in default). The scan goes through
the canonical public RPC, as the epoch keeper's does: metered endpoints cap
`eth_getLogs` to a handful of blocks and the first backfill is millions wide.

### The TIMBS ticket leg — repriced at deploy, not pegged to the pair

A ticket is paid in ETH or TIMBS and `GameRegistry` prices the legs independently.
At the chosen launch price the stock constants put them 500× apart:

| Leg | Rule | At 1e-6 ETH/TIMBS |
|---|---|---|
| ETH | `ETH_ENTRY_FLOOR` 0.001 ETH, then `escrow / 1000` | 0.001 ETH |
| TIMBS (old) | floor 2 TIMBS `+ 1` per active TIMBS entry | 0.000002 ETH |

That matters beyond pricing. ETH entries fill `totalEthEscrow`, which funds the
yield vault whose accrual grows the pot. If every entry takes the TIMBS leg the
pot's funding stays empty, and `entryCostETH()` never leaves its floor because
escrow never grows — self-reinforcing. The constants were tuned on a testnet
where TIMBS had no market price.

**Decision: reprice at deploy; do not peg to the pair.** `TIMBS_ENTRY_FLOOR` and
`TIMBS_STEP` are now `immutable`, set in the `GameRegistry` constructor, instead
of hard-coded `constant`. They are still fixed forever at deploy and still have
no owner setter — the TIMBS leg stays a token-denominated price whose ETH value
drifts with the market, and that drift is accepted rather than tracked.

Deploy-time values:

| Deployment | Floor | Step | Floor in ETH |
|---|---|---|---|
| Mainnet, at 1e-6 ETH/TIMBS | **500 TIMBS** | 100 TIMBS | 0.0005 ETH — half an ETH ticket |
| Testnet | 2 TIMBS | 1 TIMBS | unchanged |

Testnet keeps the old numbers because TIMBS is faucet-dripped there and a
launch-priced floor would put the leg out of reach. Immutable is what lets one
source serve both without forking it.

**The mainnet floor is deliberately under the ETH leg.** At launch a TIMBS ticket
costs 0.0005 ETH against the ETH leg's 0.001 ETH floor, so paying in TIMBS is
half price — a standing incentive to hold and use the token. Congestion closes
the gap rather than the floor doing it: each concurrent TIMBS entry adds 100
TIMBS, so at **five** concurrent TIMBS entries the leg costs 1,000 TIMBS, exactly
an ETH ticket, and past that it is the dearer route.

> Worth watching once live: while fewer than five TIMBS tickets are active, the
> TIMBS leg is the cheaper seat, so the ETH escrow that funds the pot fills more
> slowly than the ticket count suggests. That is the intended trade, not a bug,
> but it is the number to check against real play before Era 2.

Derive the floor as `ETH_ENTRY_FLOOR ÷ launch price`, and re-derive if the launch
price moves. `Deploy.s.sol` **requires** `TIMBS_ENTRY_FLOOR` and `TIMBS_STEP`
with no default, so a mainnet deploy cannot silently inherit testnet pricing; the
constructor rejects a zero floor or a step above the floor.

This is cheap now and expensive later: mainnet is deployed but `startGame` has
**not** run, so there are no live tickets to migrate. After launch it is a
registry redeploy plus a generation migration.

---

## 8. `TimbReleaseVault` — contract (stub, needs audit)

See `contracts/TimbReleaseVault.sol`. Shape:

- Immutable `timbs`, `treasury`, `rounds` (the `cumulativeRounds` oracle),
  `BASE_INTERVAL = 1000`.
- `nextMilestoneRound() = BASE_INTERVAL << releasedCount` → 1000, 2000, 4000…
- `release()` — permissionless; while the next milestone has matured, halve
  `lockedRemaining`, accumulate, and transfer the sum to the treasury. Below a
  `DUST` floor, sweep the remainder and finish.
- Emits `Released(index, milestoneRound, amount, lockedRemaining)`.
- No owner powers over the funds — the schedule is immutable and trustless.

Genesis (deploy script): `_mint(treasury, 50M)` + `_mint(vault, 50M)` — replaces
the current single `_mint(treasury, 100M)`.

## 9. Launch checklist

1. Add `cumulativeRounds` to `GameRegistry` (monotonic, generation-safe) + a
   view the vault reads.
2. Deploy `TimbReleaseVault(timbs, treasury, gameRegistry)`.
3. Genesis split in the deploy script: 50M treasury / 50M vault.
4. Reward grants follow the §6 taper (n = 3,000, 90-day period) — policy in the
   keeper, never wired to an unlock milestone.
5. Fix `scripts/docs/TOKENOMICS_AND_GAME_THEORY.md` (stale: says 1B cap +
   inflationary; corrected to 100M fixed + this schedule).
6. Audit the vault before mainnet — it custodies 50M TIMBS.
7. **Era-1 split is decided** (§7) — 5 ETH at 100 ETH FDV, team 15% / founder-dev
   12% of the genesis 50M, faucet-only fair release. Remaining choice: the
   liquidity / marketing ratio inside 28,614,500.
8. **Audit `TimbVesting`** (written: `contracts/TimbVesting.sol`, tests, deploy
   script). It is a wrapper over OZ `VestingWalletCliff`, so the review is the
   two OZ bases plus the refused `receive()`. Decide the beneficiary list for
   the 7.5M team tranche, and confirm `duration` = 730 vs 910 days (§7).
9. **Redeploy `GameRegistry`** with the repriced TIMBS leg (§7). The constants are
   now constructor immutables; set `TIMBS_ENTRY_FLOOR=500e18` / `TIMBS_STEP=100e18`
   for mainnet. Must happen **before `startGame`** — no live tickets to migrate
   today, a generation migration afterwards. Re-run the §4 wiring matrix after,
   since every contract pointing at the old registry has to be re-pointed.
