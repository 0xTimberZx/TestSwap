# Scenario D — emissions + registry + staking/farm rework (PARKED)

Status: **PARKED — to be discussed later.** No design, no code. This file just holds the scope so
it isn't lost. Nothing here is decided.

Scope (as stated): change **TIMBS token emissions**, **registry rules**, and **staking + farm**.

## Affected contracts (current state, for reference when we pick this up)
- `TIMBSToken` (`0x2Aaa…bfaAa`) — emissions currently governance-unlockable, **off by default**;
  100M hard cap, ~99.5M effective (500k phantom-pair burn).
- `EligibleTokenRegistry` (`0xbFF5…9F04`) — which tokens' swaps nudge the prize meter.
  (Also relevant: `GameRegistry` v2 if "registry rules" means entry/ticket rules — clarify which.)
- `TimbStaking` (`0xe776…3C8F`) — single-asset TIMBS staking, funded by buyback distributions.
- `TimbFarm` (`0xE319…9011`) — TIMBS/ETH LP farming, TIMBS emissions.

## Open questions to resolve when we discuss (seed list — not answered)
1. **Emissions:** turn them on? what rate/schedule/cap interaction? who receives (farm? stakers?
   both)? fixed vs governance-tunable? interaction with the 100M hard cap.
2. **"Registry rules":** which registry — `EligibleTokenRegistry` (eligibility criteria for
   nudging) or `GameRegistry` (entry/ticket rules)? what specifically changes?
3. **Staking/Farm:** new reward source (emissions vs buyback vs fees)? change lock/boost mechanics?
   merge or keep separate? migration for existing stakers/LPs.
4. **Cross-scenario coupling:** how does this interact with Scenario C (TIMBS hub → more fee flow to
   buyback/stakers) and PR #55 (#2 already routes swap volume to the burn/stake loop)?
5. **Migration/redeploy:** which of these need redeploys vs. owner-config? existing-position
   migration plan.

## Relationship to other scenarios
- Scenarios A/B = the game-balance changes in PR #55 (#1 anti-dominance, #2 fee-loop).
- Scenario C = TIMBS as hub routing token (`docs/SCENARIO_C_TIMBS_HUB_SPEC.md`).
- Scenario D = this (emissions + registry + staking/farm).

When we take this up, promote this stub into a full spec like C — with the same
cost/risk/migration sections.
