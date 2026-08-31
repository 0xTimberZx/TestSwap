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

## 5. Rewards are a separate, hand-set policy

The unlock and the reward rates are **decoupled by design.**

- The vault moves TIMBS from locked → treasury on the fixed schedule above.
- **Reward rates are set by hand** — the owner/governance decides, per pool, how
  much to distribute and how fast, via the existing `notifyRewardAmount(amount,
  duration)` / `setRewardRate` on `TimbStaking`, `TimbFarm`, and `TimbBoostFarm`.
- Reward funding draws from the **spendable treasury float** (whatever has
  unlocked) plus the **buyback waterfall** and the WETH `BoostRewarder` real
  yield — exactly as today.

The only relationship between the two: the unlock schedule is a **ceiling** on
how much float the hand-set policy has available at any time. Within that
ceiling, distribution is entirely discretionary. This keeps rate-setting
flexible and reversible while the supply-availability curve stays fixed and
credible.

## 6. `TimbReleaseVault` — contract (stub, needs audit)

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

## 7. Launch checklist

1. Add `cumulativeRounds` to `GameRegistry` (monotonic, generation-safe) + a
   view the vault reads.
2. Deploy `TimbReleaseVault(timbs, treasury, gameRegistry)`.
3. Genesis split in the deploy script: 50M treasury / 50M vault.
4. Reward rates stay hand-set (§5) — no keeper wiring tied to the unlock.
5. Fix `scripts/docs/TOKENOMICS_AND_GAME_THEORY.md` (stale: says 1B cap +
   inflationary; corrected to 100M fixed + this schedule).
6. Audit the vault before mainnet — it custodies 50M TIMBS.
