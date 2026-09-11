# TimbSwap Governance v2 — design stub (DRAFT, post-beta)

**Status: DRAFT / not implemented.** This captures the intended future on-chain
governance so the idea is on record. It is explicitly **out of scope for the
mainnet beta** — details to be filled in later. Nothing here ships at launch.

## Beta posture (what actually governs at launch)

For the beta, on-chain `TimbGovernance` is **off-chain signaling only** (audit
H3), and real authority is a **timelock + multisig** that owns every contract
(runbook §6). Governance v2 is designed to **plug into that substrate later with
no rework**: the v2 module becomes the timelock's **proposer** (or its owner), so
adopting it is an ownership/role change, not a redeploy of the system. No lock-in.

Governance v2 will **replace** the current simple deposit/withdraw voting-power
module — it is a new governance-staking contract, separate from `TimbStaking`
(which is the rewards staker).

## Change model (LOCKED for beta): governed migration / repoint — NOT upgrades

The launch contracts are immutable `Ownable2Step` logic; **there are no proxies.**
A "contract update" is therefore a **governed repoint/migration**, not an in-place
upgrade:

1. Deploy the new contract version.
2. Governance (via the timelock) **repoints** the wiring pointers to it and
   **migrates ownership** — exactly the pattern the gen-3 migration already used
   (`setTimbPrize` / `setYieldVault` / `setGameRegistry`, etc.).
3. The old contract is retired; state migrates per the module's migration path.

This keeps the attack surface small (no upgradeable-proxy risk) and matches what
is already built and audited. True in-place upgradeability (proxies) is
deliberately **not** adopted.

## The idea (as described — to be detailed)

Two staker classes, one combined electorate:

- **Security class** — the **top 13 governance stakers** (by accumulated stake).
- **Community** — everyone else who stakes.
- **Combined**, they vote on **emergency proposals** and **contract updates**
  (repoints/migrations, per the model above).

Staking + lock mechanics:

- **Stakes accumulate** (add to a single position; no separate stake IDs).
- **Withdrawals pull out ALL** of a staker's position (no partial withdrawal).
- **Community lock: 7 days** — a community stake is not withdrawable for 7 days.
- **Security-class lock: 90 days** — a security staker who is *qualified and
  accepted by their next staker* (a rotation / hand-off mechanic, TBD) cannot
  withdraw for 90 days.

Goal: **keep the entire governance community engaged.** Design inspiration:
**speedmarkets.xyz** (specifics to be documented later).

## Open design questions (for the later design + threat-model pass)

These must be resolved before any implementation — several echo issues we already
hit and fixed in the current contracts:

- **Bounded top-13 set.** Maintaining a top-13 leaderboard on-chain must be
  O(1)/bounded per interaction — the exact unbounded-iteration/gas class of bug
  fixed in M6. Define insertion/eviction without unbounded loops.
- **"Accepted by their next staker" semantics.** What does acceptance mean, who is
  "the next staker," and what stops griefing (refusing acceptance to trap/free a
  90-day lock)? Define the rotation precisely.
- **Capture / sybil resistance.** Can a whale (or coordinated sybils) seize the
  13 security seats? How does accumulate-and-withdraw-all interact with seat churn?
- **Two-class vote weighting + quorum.** How are security vs community votes
  combined (equal weight? per-class quorum? veto?), and what quorum applies to
  emergency vs normal proposals? (Reuse the M-fix: a zero-snapshot proposal must
  fail quorum.)
- **Emergency vs normal path.** What distinguishes an "emergency proposal"
  (shorter delay? higher quorum? security-class only to raise?), and how does it
  interact with the timelock delay.
- **Execution target.** A passed "update" proposal executes via the timelock
  (target + calldata) to perform the repoint/migration — define the allowed
  action set.
- **Lock accounting.** 7-day / 90-day locks as high-water timestamps (not
  unbounded arrays), consistent with the M6 `votingLockUntil` approach.
- **Migration from beta governance.** How the v2 staking positions relate to (or
  supersede) any beta signaling deposits.

## Not doing (for beta)

- No proxies / in-place upgrades.
- No tiered classes, no 7/90-day locks, no security-class election on-chain.
- No wiring of `executeProposal` to real execution — that authority is the
  timelock/multisig until v2 is designed, audited, and adopted.
