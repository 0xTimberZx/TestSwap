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
      leg is live — see `MAINNET_AIRDROP_SPEC.md`)*. The leg is an on-chain
      `TimbAirdropDistributor` (Arb One) holding a pre-funded TIMB float, fed by
      the `airdrop-dispatch` edge fn. Every cap below is a **contract lever**,
      not a config flag — set them in the constructor and verify on-chain
      before the first `distribute()`:

      | Lever | Contract | Proposed (confirm at deploy) | Bound it gives |
      |---|---|---|---|
      | `amountPerClaim` | owner `setAmountPerClaim` | **1 TIMB** (1e18) | dispatcher chooses *who*, never *how much* |
      | `totalCap` | owner `setTotalCap` | **10,000 TIMB** | lifetime ceiling on everything the contract can ever send |
      | `perRoundCap` | owner `setPerRoundCap` | **= `totalCap`** while `AIRDROP_ROUND` stays `1` | per-round ceiling (matters only if you open a second round) |
      | `claimed[round][addr]` | one-way, no setter | round `1` for the whole beta | **per-address lifetime** cap of one claim — a second `distribute` for the same address reverts on-chain, whatever the DB says |
      | float on the contract | Safe → distributor `transfer` | **≤ 1,000 TIMB per top-up** + ~0.01 ETH gas on the dispatcher EOA | max loss from a leaked dispatcher key or a contract bug = float, never the cap |

      Rules that make those numbers hold:
      - **Float ≤ 10 % of `totalCap`, topped up in tranches** from the Safe —
        never the mint authority, never the treasury. A leaked dispatcher key
        drains at most the float; a wrong DB can't exceed `totalCap` or pay an
        address twice.
      - **Count the float toward the master ceiling.** Pre-LP TIMB has no
        market, so its dollar VaR is ≈ 0 today — the cap bounds *post-`startGame`
        dump pressure and marketing spend*, not cash. Re-price it the day LP
        goes live and lower `totalCap` if it then breaches the ceiling
        (`setTotalCap` is owner-only and can only go down without a re-fund).
      - **Reward stays TIMB**, not ETH/WETH (spec §2 — illiquid = a free Sybil
        brake; a liquid reward gated on a free testnet action is a faucet drain).
      - [x] **Deployed 2026-09-15 (Arbitrum One):**
        distributor `0x955e5800245164EC4DCd1da9062115bBdA132c83` · deploy tx
        `0x3436fe14397cd6dc564ac85dfefc912fafd591f70f7747b1982d5e2723d5a9b2`
        (block 505442198) · `owner()` = Safe `0xFbcD…79F9` (Ownable2Step accepted)
        · `dispatcher()` = `0x77F434D288Ca29a322ae4C947Ae3ae6a04e29921`
        (`airdrop-dispatch` hot key, 0.002 ETH gas) · `guardian()` = deployer
        `0x4253…9800` · `amountPerClaim` 1e18 · `totalCap` = `perRoundCap` = 1e22
        · float **1,000 TIMB** (10 % of cap) from the Safe · `TIMBSToken`:
        `paused=false`, `maxTransferAmount=0` (no per-tx cap; spec §8 satisfied)
        · smoke test: 1 TIMB distributed to the deployer, `isClaimed(1)=true`,
        `remaining(1)=9,999`, second enqueue deduped · rows in
        `MAINNET_ADDRESSES.md` + `SECURITY.md` scope.
      - **Retiring before mainnet launch** (decided 2026-09-16): stays paused,
        float recovered to the Safe, plumbing unscheduled — sequence in
        `MAINNET_FAUCET_PROPOSALS.md` §5. The mainnet faucet's TIMBS leg (below)
        becomes the only TIMB release.
- [ ] **Mainnet gas faucet** *(launch facilitation, not core scope — see
      `GAS_FAUCET_MAINNET.md`, sizing + payloads in `MAINNET_FAUCET_PROPOSALS.md`)*.
      An atomic `GasFaucet` on Arb One that, per eligible claim (a live
      **mainnet** `Active` ticket, 24 h cooldown, both enforced on-chain), pulls
      ETH from the treasury as its rate-limited operator and hands out gas +
      pot + 1 TIMB. Two ETH ceilings apply — the treasury's rolling cap and the
      faucet's cumulative cap — and a leaked dispatcher key can only spend into
      ticket-holding wallets, once a day each. Set every lever before the first
      `dispense()` and verify on-chain:

      | Lever | Contract | Proposed (confirm at deploy) | Bound it gives |
      |---|---|---|---|
      | `dripEth` | faucet owner `setParams` | **0.0002 ETH** (2e14) | gas to the claimant per claim; with `potEth` must stay `< GameRegistry.entryCostETH()` (floor 0.001 ETH) so a claim is never worth a ticket |
      | `potEth` | faucet owner `setParams` | **0.0001 ETH** (1e14) | ETH to the live round pot per claim (~10 % of the floor entry price) |
      | `timbsPerClaim` | faucet owner `setParams` | **1 TIMB** (1e18) | the fair-release unit — dispatcher chooses *who*, never *how much* |
      | `cooldown` | faucet owner `setParams` | **86400** | one claim per wallet per day, on-chain (the edge fn mirrors it) |
      | `operatorEthCap` / `operatorPeriod` | **treasury** owner `setOperatorEthCap` | **0.05 ETH / 24 h** (≈ 100 tickets × 0.0003 × 1.5) | the daily brake: past it `dispense()` reverts, so Sybils dilute each other, never the treasury. `0` = operator off |
      | `ethCap` | faucet owner `setEthCap` | **1.5 ETH** (~1 month) | lifetime ETH ceiling; raising it is the "approve more" tx |
      | `timbsCap` | faucet owner `setTimbsCap` | **10,000 TIMB** | lifetime TIMBS ceiling, independent of balance on hand |
      | TIMBS float on the faucet | **treasury** owner `withdrawToken(TIMBS, faucet, …)` | **3,000 TIMB** per pre-fund (~1 month), tranches | max TIMBS loss from a leaked key or bug = float, never the cap; `recoverTimbs` returns the rest |
      | treasury ETH on hand | ops | **≥ 1.5 ETH** before enabling the operator | the ETH legs revert on `InsufficientETH` otherwise — keep 30 × daily cap on hand |

      Rules that make those numbers hold:
      - **Count `operatorEthCap × 30` toward the master ceiling.** Unlike the
        airdrop's illiquid TIMB, this is treasury ETH leaving daily — hard
        assets, real VaR.
      - **Re-read `entryCostETH()` before any `setParams` that raises
        `dripEth + potEth`.** The price floors at 0.001 ETH and climbs with
        escrow; the invariant must hold at the *current* price.
      - **One key per leg.** Fresh mainnet dispatcher EOA (gas only); never the
        Sepolia faucet key or the airdrop key.
      - [ ] **Deployed (Arbitrum One):** *pending* — fill in address, deploy tx,
        `owner()` = Safe, `dispatcher()`, `guardian()`, on-chain lever values,
        treasury `operator()` / `operatorEthCap()`, smoke-test result, and the
        `MAINNET_ADDRESSES.md` row, in the same shape as the distributor entry
        above.

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
- [ ] **Airdrop distributor stop** *(if the leg is live)*:
      `TimbAirdropDistributor.setPaused(true)` — callable by **owner or
      `guardian`**, so the guardian must be a fast key (same posture as §4).
      Pause halts every `distribute()`; the dispatcher's next run sees the
      revert and leaves rows `pending` (no half-sends). Then `recover(to,
      amount)` (owner) pulls the float back to the Safe. Rehearse both on
      Sepolia before funding on Arb One.
- [ ] **Mainnet gas faucet stop** *(once live)*: three independent brakes, all
      one tx — `GasFaucet.setEthPaused(true)` / `setTimbsPaused(true)`
      (**guardian or owner**, instant; pause one leg and the other keeps
      running), and `TimbTreasury.setOperatorEthCap(0, 86400)` (treasury
      owner) which cuts the faucet off from treasury ETH regardless of the
      faucet's own state. Then `recoverTimbs(Safe, balance)` (faucet owner).
      Payloads in `MAINNET_FAUCET_PROPOSALS.md` §4. Rehearse on Sepolia — the
      pause switches and `recoverTimbs` exist there; the treasury cap does not
      (old treasury), so rehearse that one on a fork.
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
- [ ] **Airdrop leg** *(if live)*: distributor TIMB balance vs `MIN_TIMB_FLOAT`
      and dispatcher gas vs `MIN_GAS_ETH` (the dispatcher pauses itself and
      alerts once below either); `airdrop_outbox` rows stuck in `sending`
      past one cycle (a crashed run — the sweeper reopens them only after the
      pinned nonce is confirmed absent on-chain); `totalDistributed` vs
      `totalCap` (approaching = the leg is about to close; a *jump* between
      cycles larger than one batch = investigate the dispatcher key).
- [ ] **Mainnet gas faucet** *(once live)*: treasury `operatorSpentInWindow`
      vs `operatorEthCap` (hitting the cap daily = raise it or accept the
      queue; hitting it *early* in the window = investigate — more claims than
      tickets); faucet `ethDistributed` / `timbsDistributed` vs their caps;
      TIMBS `balanceOf(faucet)` vs the next month's burn (top up in tranches);
      treasury ETH balance vs 30 × daily cap; `faucet_claims` rows failing with
      `OperatorCapExceeded` / `InsufficientTimbsBalance` (the worker logs the
      revert reason). Any `Dispensed` event whose claimant has no `Active`
      ticket is impossible by construction — if you see one, the registry
      binding is wrong; pause both legs.
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
