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

The unlock and the reward rates are **decoupled by design.**

- The vault moves TIMBS from locked → treasury on the fixed schedule above.
- **Reward grants follow the taper in §6**, not the unlock. The per-round figure
  is policy the keeper applies; it is changeable by governance and is in no way
  bound to a milestone. Delivery is the existing `notifyRewardAmount(amount,
  duration)` / `setRewardRate` on `TimbStaking`, `TimbFarm`, and `TimbBoostFarm`.
- Reward funding draws from the **spendable treasury float** (whatever has
  unlocked) plus the **buyback waterfall** and the WETH `BoostRewarder` real
  yield — exactly as today.

The only relationship between the two: the unlock schedule is a **ceiling** on
how much float the hand-set policy has available at any time. Within that
ceiling, distribution is entirely discretionary. This keeps rate-setting
flexible and reversible while the supply-availability curve stays fixed and
credible.

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

**Steady state.** With a grant `G` arriving every `T` days into a `W`-day window,
the pool's reserve settles at `G(W − T)/T` and pays out `G` per cycle. At W = 90
and the nominal 1.5-day epoch that is a standing buffer of about 59 epochs of
grant. The buffer is intentional: it is fully payable to stakers, it is what makes
the window un-lapseable, and it means the farm page's "ends in" always reads
~90 days instead of counting down to a cliff. A shorter period holds less float
but reintroduces the lapse risk.

---

## 7. `TimbReleaseVault` — contract (stub, needs audit)

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

## 8. Launch checklist

1. Add `cumulativeRounds` to `GameRegistry` (monotonic, generation-safe) + a
   view the vault reads.
2. Deploy `TimbReleaseVault(timbs, treasury, gameRegistry)`.
3. Genesis split in the deploy script: 50M treasury / 50M vault.
4. Reward grants follow the §6 taper (n = 3,000, 90-day period) — policy in the
   keeper, never wired to an unlock milestone.
5. Fix `scripts/docs/TOKENOMICS_AND_GAME_THEORY.md` (stale: says 1B cap +
   inflationary; corrected to 100M fixed + this schedule).
6. Audit the vault before mainnet — it custodies 50M TIMBS.
