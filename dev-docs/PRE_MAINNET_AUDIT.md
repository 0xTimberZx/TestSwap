# TimbSwap — Pre-Mainnet Security Audit (internal record)

Date: 2026-09-06. Remediation completed 2026-09-11. Scope: the mainnet-bound
contract set (DEX core, prize game, token + incentive layer). Excludes the
removed SwapTables mini-app (SegmentBoard*, DDJackpot, SegmentCrank, PoolLedger,
SeedRegistry, CommitRevealEntropy) and test-only tokens (TestUSDT, GasFaucet).

Method: three independent source-level review passes + manual consolidation.
Findings are substantiated against source; severity reflects fund/liveness impact
under a mainnet threat model (unauthenticated griefers + trusted-but-fallible
owner keys).

**Headline:** the DEX hot path is clean (no Critical/High); reward math, VRF
randomness, and reentrancy posture are sound. The blockers were (1) two unbounded
array reads in the prize game that let a gas-cheap sybil permanently brick launch
and settlement, (2) a game-fairness bug making ~36% of rounds unwinnable, and
(3) system-wide single-key ownership. **All are now remediated** (see each item).

Status legend: [ ] open · [~] deferred/documented · [x] fixed

**Remediation landed across (official repo, main):** C1/H1/M2 (07bb0ac), M1
(5ea3cad), Ownable2Step (bdb9ab0), snapshot-class-at-arm (PR #1), settlement
observability (PR #2), H2/M5/M6 (PR #6), and Lows + M4 + M7 (PR #8). Deploy is
scripted as DeployCore (phase 1) → DeployGame (phase 2); see
`MAINNET_DEPLOY_RUNBOOK.md`.

---

## CRITICAL

- [x] **C1 — Permanent launch DoS.** `startGame()` synchronously copied+iterated
  the round-1 entrants array; a pre-launch sybil flood could OOG-revert it forever.
  **Fixed:** removed the round-1 synchronous activation; round-1 entrants are
  activated by the chunked, permissionless `activateRoundEntries(currentRound, chunk)`
  after start. (07bb0ac)

## HIGH

- [x] **H1 — Settlement freeze.** `_settleRound` read the whole entrants array over
  ABI only for an event field; a sybil-flooded round OOG-reverted settlement.
  **Fixed:** O(1) `roundEntrantsLength(round)` view; settlement no longer copies the
  array. (07bb0ac)
- [x] **H2 — Single-key ownership + reward recovery.** **Fixed:** `Ownable2Step`
  across all 11 single-key contracts (bdb9ab0); handoff to a timelock/multisig is a
  deploy step (runbook). `recoverERC20` now excludes accrued reward liabilities — a
  committed `rewardReserve` is tracked in staking + farm, and the farm's reward-token
  branch (which had fallen through to an unconditional transfer, letting the owner
  drain the reserve) is capped. (PR #6)
- [x] **H3 — Governance is a no-op.** **Resolved (decision):** on-chain governance
  is documented as OFF-CHAIN SIGNALING only; real authority moves to the
  timelock/multisig via the ownership handoff. No rewire of `executeProposal`.

## MEDIUM

- [x] **M1 — ~36% of rounds unwinnable.** **Fixed:** the winning string is drawn
  fully distinct (class-preserving probe), matching the entry no-repeat rule so every
  round is winnable. A governance toggle (`allowRepeatedChars`, default off) can later
  relax BOTH sides together. (5ea3cad + double-letters toggle)
- [x] **M2 — Yield harvest can brick settlement.** **Fixed:** the escrow deposit is
  isolated in its own try/catch and capped at `address(this).balance`; the pot is
  credited only on a successful deposit. (07bb0ac)
- [x] **M3 — PrizeEscrow owner can drain the pot.** **Resolved:** PrizeEscrow is
  `Ownable2Step`; ownership moves to the timelock/multisig at handoff, so the 48h
  timelock delay is the "delayed withdrawal" the finding asked for (any
  `emergencyWithdraw` is a delayed, multisig-proposed timelock action). The
  unconditional drain was retained (deliberately) behind that gate. (bdb9ab0 + handoff)
- [x] **M4 — FoT/rebasing tokens.** **Resolved (decision: document as unsupported):**
  NatSpec on `TimbSwapRouter` (header) and `TimbSwapFactory.createPair` — pairs are
  permissionless but only standard ERC-20s are supported; FoT bricks the pool on the
  k-check, rebasing leaks to `skim()`, no FoT swap variant. Caveat emptor. (PR #8)
- [x] **M5 — `Treasury.distributeToStaking` double path.** **Fixed:** single funding
  path — `forceApprove → notifyRewardAmount (pulls) → forceApprove(0)`. (PR #6)
- [x] **M6 — `Governance.withdrawVotingPower` unbounded loop.** **Fixed:** replaced
  with an O(1) per-voter `votingLockUntil` high-water set at vote time;
  `voterParticipation` retained for history but no longer iterated. (PR #6)
- [x] **M7 — Buyback sandwich.** **Fixed:** `executeBuyback` now floors the fill at an
  on-chain TWAP — `≥ max(minTimbsOut, TWAP × (1 − maxDeviationBps))` — with the
  observation `≥ MIN_TWAP_PERIOD (30m)` old (keeper primes `updateTwap()`); hard-
  requires `minTimbsOut > 0` and a per-buyback size cap. (PR #8)

## LOW

- [x] L — `TimbSwapRouter.weth` is now `immutable` (constructor arg; `setWeth` removed). (PR #8)
- [x] L — staking/farm `notifyRewardAmount`/`setRewardRate` now assert reward solvency. (PR #8)
- [x] L — governance quorum bypass when the creation-time snapshot is 0 — now fails quorum. (PR #8)
- [~] L — read-only reentrancy on `Pair.getReserves()` — documented integrator hazard; standard V2, no core change.
- [~] L — exact-out protocol fee sits outside `amountInMax` (true max ×1.0005) — documented; minor.
- [~] L — owner can deny a winner via `adminMarkIneligible` pre-settle — intentional admin power; timelock-gated after handoff.
- [~] L — `_findVerifiedWinners` O(k²) dedup — bounded: the winning string is VRF-jittered/unguessable, so a "popular string" can't be targeted.
- [~] L — VRFEntropy liveness (`rerequest` LINK drain; `callbackGasLimit`) — operational/config; `callbackGasLimit` set at deploy via `VRF_CALLBACK_GAS`.
- [~] L — `GameRegistry.totalEthEscrow` under-count on double-failed partial lapse — display/accounting edge on a doubly-failed transfer; tracked.
- [ ] L — dead `winnersPerRound` / dead `eligibleRegistry` in TimbPrize — cosmetic dead-code cleanup, no impact; left for a later pass.

## Reviewed clean (no fund-impacting attacker vector)

DEX: K-invariant, inflation/donation mitigations, reentrancy coverage, ETH refund
paths, multi-hop chaining, deadline/slippage, lazy protocol-fee, Factory CREATE2.
Game: VRFEntropy randomness design (one word/segment, one-way ready, no choosable
branch, non-repeating salts), claim/settle/forfeit reentrancy + window boundaries.
Token: reward accumulators (no over/double-claim, no flash-stake benefit),
reward/staked separation, LockVault, YieldVault reserve cap (never touches principal).

## Additional hardening beyond the original findings

- **Settler fairness (snapshot-class-at-arm):** the winning char's class is now
  snapshotted at VRF-arm time and the lock reads the snapshot, so a nudge between arm
  and lock cannot steer the class even if the nudge-window guard were bypassed. (PR #1)
- **Settlement observability:** every swallowed cross-contract call now emits on
  failure — `YieldHarvestFailed`, `YieldDepositFailed`, `WeightRegisterFailed`,
  `WeightRemoveFailed`, `PotShareForwardFailed` — so a stale wiring pointer surfaces
  on-chain instead of silently degrading the game. (PR #2)
- **Deploy wiring:** the gen-3 migration's missing `vault.setTimbPrize` (which
  silently starved the pot on testnet) is fixed in the migration script and baked
  into `DeployGame` (vault↔prize wired both directions).

## Pre-mainnet gate — status

1. [x] Fix C1, H1, M1, M2, M3 (launch-blockers + game correctness).
2. [x] Ownership hardening: `Ownable2Step` across the set; `weth` immutable. Timelock/
   multisig handoff is a deploy step (runbook §6).
3. [ ] Deploy phase 1 (DeployCore) then phase 2 (DeployGame) — operational, see
   `MAINNET_DEPLOY_RUNBOOK.md`.
