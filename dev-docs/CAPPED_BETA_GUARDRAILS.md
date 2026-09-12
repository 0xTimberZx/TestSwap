# TimbSwap — Capped-Beta Guardrails

The checklist for turning on **real economics with bounded downside** — the
window *after* a low-budget audit and *before* a fuller audit + uncapping. Every
item maps to a real contract lever or a concrete op. Companion to
`MAINNET_DEPLOY_RUNBOOK.md`.

> **The principle.** A Uniswap-V2 AMM has **no built-in TVL cap** — anyone can
> add liquidity to a permissionless pair. So the caps here are mostly
> **operational discipline**, not on-chain limits. Pick one number and hold it:

- [ ] **Value-at-risk ceiling.** Choose a dollar figure you could absorb losing
      entirely. Keep total reachable protocol value (LP you seed + prize pot +
      staked + vault + treasury) **under it** until the fuller audit. This is the
      master cap; everything below serves it.

---

## 1. Financial caps (operational)

- [ ] **Liquidity:** seed only to a target depth; don't chase deep liquidity
      until post-audit. You control how much you add and how hard you market.
- [ ] **Prize pot:** seed the escrow modestly — it holds exactly what you put in.
- [ ] **Rewards:** fund `TimbStaking` / `TimbFarm` via `notifyRewardAmount` in
      **small tranches / short durations**. (The reward-solvency assert already
      forbids promising tokens the contract doesn't hold.)
- [ ] **Buybacks:** `TimbTreasury.setBuybackMaxEth(<small>)` (per-buyback ETH
      cap) + `setBuybackMaxDeviationBps(300)` (TWAP deviation floor, M7).
- [ ] **Operator:** `TimbTreasury.setOperatorEthCap(<small>, <period>)` — rate-
      limit routine operational ETH withdrawals (M1).
- [ ] **VRF subscription:** fund enough to run, but don't overfund the hot
      subscription; monitor and top up (§5).
- [ ] **Airdrop distributor** *(only if the testnet-claim → mainnet-TIMB airdrop
      leg is live — see `MAINNET_AIRDROP_SPEC.md`)*: fund the distributor wallet
      with only a **small TIMB float + gas**, never the Safe/mint; set a **hard
      total-airdrop cap** and a **per-address cap**. The float is real
      value-at-risk — count it toward the master ceiling. Keep the reward **TIMB**
      (illiquid pre-LP = a free Sybil brake); **not** ETH/WETH (spec §2).

## 2. Emergency controls — wire and test BEFORE opening

- [ ] **Pause:** `GameRegistry.pause()` halts new prize entries (`onlyOwner`).
      Confirm the pause key is **fast** (see §4 — you cannot wait 48h on a live
      exploit).
- [ ] **Verify pause authority** on `TimbSwapRouter` and `TIMBSToken`
      (`whenNotPaused` guards exist — confirm who can flip them and that it's
      fast).
- [ ] **Privileged recovery known & rehearsed:**
      `PrizeEscrow.emergencyWithdraw`, `TimbYieldVault.emergencyWithdraw`
      (recover pot / vault backing if compromised), and the reward-liability-
      capped `recoverERC20` on staking/farm.
- [ ] **Dry-run on testnet:** pause → confirm entries/swaps halt → unpause.

## 3. User exit must always work — verify each (the "no funds trapped" property)

- [ ] `TimbStaking.exit()` / `emergencyWithdraw()` — principal out, permissionless.
- [ ] `TimbFarm.exit()` / `emergencyWithdraw()` — same.
- [ ] `GameRegistry.claimRefund(ticketId)` — ticket principal refundable per the
      refund windows (even for missed prizes).
- [ ] `TimbLockVault.withdraw(lockId)` — after the lock elapses.
- [ ] **Publish** these paths so users know they can always leave.

## 4. Ownership posture for the beta (the key trade-off)

The 48h timelock is right for **non-emergency** changes but **too slow to stop a
live exploit** — and the mainnet contracts have **no fast guardian role** (pause
is `onlyOwner`). Decide this before opening:

- [ ] **Recommended:** during the capped beta, keep **pause-critical contracts
      owned by the multisig directly** (immediate multisig pause), and route
      **non-emergency** privileged ops through the timelock. At graduation, move
      everything to full timelock ownership.
- [ ] Alternative: a dedicated **guardian EOA** with pause-only power for instant
      response, retired at graduation. (Requires a small contract change to add a
      guardian role — not present today.)
- [ ] Confirm `owner()` on every contract matches the chosen posture.
- [ ] Deployer key owns nothing operationally and holds no protocol funds.

## 5. Monitoring — a guardrail is only as good as its alert

- [ ] Alert on the observability events (any = a wiring/keeper problem):
      `YieldHarvestFailed`, `YieldDepositFailed`, `WeightRegisterFailed`,
      `WeightRemoveFailed`, `PotShareForwardFailed`.
- [ ] Keeper liveness: `settleSegment`, `activateRoundEntries` / `onRoundSettled`,
      `treasury.updateTwap` (before buybacks).
- [ ] Watch **Total Pot vs Prize Pot**, VRF sub balance, pair reserves/price,
      treasury balance.
- [ ] **On-call:** who responds, how fast, with which keys — written down.

## 6. Whitehat channel — turn "real money live" into a discovery channel

Done — see the policy in the official repo:
[`SECURITY.md`](https://github.com/0xTimberZx/TimbSwap/blob/main/SECURITY.md).

- [x] Publish a **security contact** + responsible-disclosure policy — GitHub
      Private Vulnerability Reporting is the primary channel; 72h ack, 90-day
      coordinated disclosure.
- [x] A **modest bug bounty** scoped to the deployed contracts (the SwapTables
      cleanup keeps that scope tight) — five impact tiers (T1 UI → T5 drain)
      under a **$500** capped-beta program cap.
- [x] Safe-harbor language for good-faith researchers.

> The bounty cap and the value-at-risk ceiling move together: a $500 top payout
> only out-competes a drain while reachable value stays near it, so its approach
> is a graduation trigger (§8). See the "flow vs. stock" note in `SECURITY.md`.

## 7. Disclosure — set expectations

- [ ] Label clearly: **capped beta**, internally reviewed + low-budget audited,
      **not fully audited**, funds at risk, caps in place. Keep consistent with
      the litepaper/roadmap framing.

## 8. Graduation gate — when to uncap

- [ ] Fuller **independent audit** complete + findings remediated.
- [ ] A defined window of clean operation (no guardrail trips, keepers healthy).
- [ ] Then, in stages: move to full **timelock** ownership, lift the caps,
      deepen liquidity, raise the value-at-risk ceiling.

---

*Companion docs: `MAINNET_DEPLOY_RUNBOOK.md` (deploy + handoff),
`PRE_MAINNET_AUDIT.md` (internal review), `GOVERNANCE_V2.md` (post-beta tiered
governance).*
