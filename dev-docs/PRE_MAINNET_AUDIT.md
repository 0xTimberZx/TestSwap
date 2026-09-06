# TimbSwap — Pre-Mainnet Security Audit (internal record)

Date: 2026-09-06. Scope: the mainnet-bound contract set (DEX core, prize game,
token + incentive layer). Excludes the removed SwapTables mini-app
(SegmentBoard*, DDJackpot, SegmentCrank, PoolLedger, SeedRegistry,
CommitRevealEntropy) and test-only tokens (TestUSDT, GasFaucet).

Method: three independent source-level review passes + manual consolidation.
Findings are substantiated against source; severity reflects fund/liveness impact
under a mainnet threat model (unauthenticated griefers + trusted-but-fallible
owner keys).

**Headline:** the DEX hot path is clean (no Critical/High); reward math, VRF
randomness, and reentrancy posture are sound. The blockers are (1) two unbounded
array reads in the prize game that let a gas-cheap sybil permanently brick launch
and settlement, (2) a game-fairness bug making ~36% of rounds unwinnable, and
(3) system-wide single-key ownership.

Status legend: [ ] open · [~] in progress · [x] fixed

---

## CRITICAL

- [ ] **C1 — Permanent launch DoS.** `TimbPrize.startGame()` → `_activateRoundEntries`
  synchronously copies+iterates the entire round-1 entrants array via
  `GameRegistry.getRoundEntrants(1)`. A sybil floods `roundEntrants[gen][1]`
  pre-launch (refundable principal, cost ≈ gas) until `startGame()` always
  OOG-reverts. `gameStarted` is one-shot and generation only advances *inside*
  `startGame`, so there is no escape — redeploy is the only remedy.
  **Fix:** remove the round-1 synchronous activation; rely on the chunked,
  permissionless `activateRoundEntries(currentRound, chunk)` after start. Drop
  `getRoundEntrants(1)` from the launch path.

## HIGH

- [ ] **H1 — Settlement freeze.** `TimbPrize._settleRound` reads
  `getRoundEntrants(round).length` (fetches the whole array over ABI) only to
  populate an event field. A sybil-flooded round OOG-reverts settlement →
  round/segment can never advance → game + escrow + pot freeze permanently.
  **Fix:** O(1) `roundEntrantsCount[gen][round]` maintained in `_mintTicket`, or
  a length-only view, or drop the field.
- [ ] **H2 — Single-key ownership.** TIMBS/Staking/Farm/Governance are single-step
  `Ownable` (only Treasury uses `Ownable2Step`). Owner can `mintEmissions` to the
  100M cap, `pause()` all transfers, and `recoverERC20` earned-but-unclaimed
  rewards (farm's variant can pull the entire TIMBS reward reserve).
  **Fix:** `Ownable2Step` everywhere + timelock/multisig; exclude accrued reward
  liabilities from `recoverERC20`.
- [ ] **H3 — Governance is a no-op.** `TimbGovernance.executeProposal` only flips a
  flag — no target/calldata/call, nothing wired to it. On-chain governance is
  ceremonial; all authority stays with the owner key.
  **Fix:** wire to a timelock that owns the other contracts, or document as
  off-chain signaling only.

## MEDIUM

- [ ] **M1 — ~36% of rounds unwinnable.** Entries forbid repeated characters, but
  the winning string is drawn with no distinctness constraint (~64% all-distinct),
  so ~36% of rounds no valid entry can match → pot silently snowballs.
  **Fix:** enforce distinctness in the winning-string draw, or relax the entry
  no-repeat rule — entry space and outcome space must agree.
- [ ] **M2 — Yield harvest can brick settlement.** In `TimbPrize._harvestYield`
  the `prizeEscrow.deposit{value:amount}()` runs inside the `try` success body;
  a vault amount/balance mismatch reverts settlement.
  **Fix:** move the deposit out of the try body / cap at `address(this).balance`.
- [ ] **M3 — PrizeEscrow owner can drain the pot.** `emergencyWithdraw` (whole
  balance, any time) + re-settable `setTimbPrize`; `addToPot` is permissionless.
  **Fix:** timelock + multisig; remove the unconditional drain (pause + delayed
  withdrawal instead).
- [ ] **M4 — FoT/rebasing tokens.** Permissionless pairs, no
  `...SupportingFeeOnTransfer` variant: FoT `tokenIn` bricks the pool (K revert);
  rebasing-up leaks to `skim`. Standard V2 behavior.
  **Fix (policy):** allow-list standard ERC-20s for the launch set, or document
  FoT/rebasing as unsupported.
- [ ] **M5 — `Treasury.distributeToStaking` reverts** (transfer + `notifyRewardAmount`
  pull with no allowance → double path). Non-functional funding flow.
  **Fix:** one path only.
- [ ] **M6 — `Governance.withdrawVotingPower` unbounded loop** over append-only
  `voterParticipation` can permanently lock a voter's deposit.
  **Fix:** prune on resolve/withdraw, or a per-voter locked-until high-water.
- [ ] **M7 — Buyback sandwich.** `Treasury.executeBuyback` uses only caller-supplied
  `minTimbsOut`, no TWAP. **Fix:** derive `minTimbsOut` from an on-chain TWAP, cap
  per block, and/or private mempool; hard-require nonzero minOut.

## LOW (track)

- [ ] L — `TimbSwapRouter.weth` should be `immutable` (mutable setter routes ETH).
- [ ] L — read-only reentrancy on `Pair.getReserves()` (integrator hazard; document).
- [ ] L — exact-out protocol fee sits outside `amountInMax` (true max = ×1.0005).
- [ ] L — staking/farm `notifyRewardAmount`/`setRewardRate` lack a reward-solvency assert.
- [ ] L — governance quorum bypass when the creation-time snapshot is 0.
- [ ] L — owner can deny a specific winner via `adminMarkIneligible` pre-settle.
- [ ] L — `_findVerifiedWinners` O(k²) dedup could OOG on a very popular string.
- [ ] L — dead `winnersPerRound` (pays every matcher) and dead `eligibleRegistry` in TimbPrize.
- [ ] L — VRFEntropy liveness edges (permissionless `rerequest` LINK drain; under-set `callbackGasLimit`).
- [ ] L — `GameRegistry.totalEthEscrow` under-count on double-failed partial lapse.

## Reviewed clean (no fund-impacting attacker vector)

DEX: K-invariant, inflation/donation mitigations, reentrancy coverage, ETH refund
paths, multi-hop chaining, deadline/slippage, lazy protocol-fee, Factory CREATE2.
Game: VRFEntropy randomness design (one word/segment, one-way ready, no choosable
branch, non-repeating salts), claim/settle/forfeit reentrancy + window boundaries.
Token: reward accumulators (no over/double-claim, no flash-stake benefit),
reward/staked separation, LockVault, YieldVault reserve cap (never touches principal).

## Pre-mainnet gate

1. Fix C1, H1, M1, M2, M3 in the contracts (launch-blockers + game correctness).
2. Ownership hardening: `Ownable2Step` + timelock/multisig across the set; `weth` immutable.
3. Deploy phase 1 (DEX, audit-clean) then phase 2 (game) only after 1–2 land.
