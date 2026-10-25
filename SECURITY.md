# Security Policy & Bug Bounty (testnet phase)

TimbSwap is live on **Arbitrum Sepolia** as a capped, unaudited testnet. Every
token is a test asset with no monetary value, and the bug bounty runs **now**,
before the independent audit and any mainnet launch, so vulnerabilities are
found and fixed while nothing real is at stake. **The testnet program closes on
26 October 2026 at 23:59 UTC.** Rewards are real: **USDT on Arbitrum One**,
paid from a public bounty wallet.

> **Report privately — do not open a public issue.**
> Primary channel: **devhub@timbswap.xyz** (security-only inbox; put the
> contract name in the subject). A GitHub private advisory on this repo
> (Security → "Report a vulnerability") is also accepted whenever the repo is
> reachable; email is the channel that is always open.

The full program terms, the reward tiers, and the live pool balance are on the
[Protocol page](https://timbswap.xyz/gov/#bounty). This file is the short form.

`devhub@timbswap.xyz` is for security reports only. Player support goes to
`hello@timbswap.xyz`, partnerships and press to `marketing@timbswap.xyz`.

---

## How to report

1. Email the report to devhub@timbswap.xyz with: affected contract(s) +
   address, a description, impact, and a **proof of concept** (a Foundry test
   or a fork script is ideal).
2. Acknowledgement within **72 hours**, triage by severity, updates through
   the fix.
3. Give up to **90 days** (or until a fix ships, whichever is sooner) before
   any public disclosure. Coordinated disclosure only.

## Scope

**In:** the deployed Arbitrum Sepolia contracts listed in the
[Docs address table](https://timbswap.xyz/docs/) and their source in
`contracts/` (also served at [timbswap.xyz/source](https://timbswap.xyz/source/)): DEX core, prize game, token and incentives, governance.

**Out:** the frontend and static site (except a display bug that could mislead
a user into a losing on-chain action, which is T1), off-chain keepers and
telemetry, **SwapTables** (`SegmentBoard*`, `SeedRegistry`, `PoolLedger`,
`UnderwriteReserve`: testnet-only and not part of the mainnet deployment), third-party code and infra (Chainlink VRF, OpenZeppelin, the
Arbitrum sequencer, RPC providers, wallets), already-documented behavior,
gas-optimisation notes, and scanner output without a working PoC.

**Unsupported token classes:** the AMM is Uniswap V2-style and, like V2, does
not support fee-on-transfer, rebasing or ERC-777 hook tokens. Reports that a
swap, add or remove delivers less of such a token than quoted are by design
and earn nothing.

## Known issues

The testnet contracts are an **earlier build** than the mainnet source in the
[TimbSwap repository](https://github.com/0xTimberZx/TimbSwap/tree/main/contracts).
A finding that is already fixed, or already configurable, in that mainnet
source is **known** and earns nothing, even though the testnet build still
shows it. The testnet will not be redeployed to fix it. Check a finding against
the mainnet source before you submit. Reports about the items below are also
closed as known. This list covers reports received after it was published.

**Different by design on mainnet:**

- **Winning-string repeats.** The winning string follows the same
  `GameRegistry.allowRepeatedChars` rule as tickets in both sources now
  (TS-004); the deployed testnet prize and registry predate the port and
  still draw six independent characters until the next testnet redeploy.
- **Reward solvency and reserve guards.** `TimbFarm` and `TimbStaking` carry
  the reward-reserve guard on `recoverERC20` and the funding-time solvency
  checks in both sources (TS-011, TS-037, TS-044); the deployed testnet farm
  and staking predate them until the next testnet redeploy.
- **Ownership and privileged roles.** Testnet contracts are owned by a single
  key. On mainnet, ownership sits behind a timelock + multisig, so owner-power
  and centralisation findings against the testnet key are out.
- **Governance.** No governance module is live on testnet and on-chain voting
  is switched off. Findings against a testnet governance address or the
  `/gov/` voting flow are out.
- **Testnet wiring and configuration.** Addresses, whitelists and parameters
  that the owner can reset in one transaction on testnet are set separately
  for mainnet. A testnet misconfiguration pays only if the same mistake is in
  the mainnet deploy script.
- **Permissionless pair swaps.** `TimbSwapPair.swap()` is open to any caller,
  as in Uniswap V2; the constant-product invariant is enforced after fees. The
  router's extra protocol fee and the prize-game nudge apply only to swaps
  routed through the router, so a direct swap skips both (and gives up its own
  nudge). Earlier testnet builds carried an "only factory-registered router"
  comment; the mainnet source documents the permissionless design.

**Accepted risks on mainnet (known, bounded, not bugs):**

- **Oracle discretion on VRF re-requests.** When a VRF request stalls past
  `REREQUEST_DELAY`, `rerequest` fires a replacement, and whichever word lands
  first is used. Players and the protocol cannot predict either word, but the
  Chainlink node that fulfils them can compute both before submitting. A node
  operator could in principle withhold one fulfilment and deliver the other.
  This is the standard Chainlink VRF trust assumption. It is bounded by the
  per-segment re-request cap (`MAX_PUBLIC_REREQUESTS`, see TS-005), and every
  re-request is alerted by the settler. Reports that restate it are closed as
  known. A way to force or exceed extra draws beyond the cap is still in scope:
  **T2** if it only burns extra draws and subscription balance, **T5** if it
  lets anyone choose among outcomes.
- **Arbitrum node disagreement.** Arbitrum has a single canonical ordering set
  by the sequencer, every node replays it deterministically, and faulty state
  is resolved by the rollup's dispute protocol on Ethereum. The VRF word is
  proof-checked by the coordinator and written once per segment
  (`rawFulfillRandomWords` ignores late arrivals). Node disagreement cannot
  produce two outcomes for a segment. A sequencer reorg can drop a request or
  fulfilment, which the settler recovers by re-arming. Reports built on
  node-level disagreement or reorg splitting the outcome are out of scope.

**Already reported (duplicates earn nothing):**

| Ref | Area | Issue |
|---|---|---|
| TS-001 | Frontend config | Governance address pointed at a retired router |
| TS-002 | `TimbBoostFarm` | Rate retarget after `periodFinish` accrues across the dead window |
| TS-003 | `TIMBSToken` | Transfer-cap whitelist misses `TimbFarm` / `TimbBoostFarm`; `farmPool` mis-set |
| TS-004 | `TimbPrize` | Winning string can repeat characters (in both sources; deployed testnet build predates it) |
| TS-005 | `VRFEntropy` | Permissionless `rerequest` has no per-salt retry cap; each call spends the VRF subscription. The cap shipped in the mainnet source first and reached the testnet source later (caught by a reporter) |
| TS-006 | `TimbTreasury` | `distributeToPot` deposits into `PrizeEscrow` without crediting `TimbPrize.currentAccumulatedRewards`, so the ETH never reaches a winner |
| TS-007 | Frontend | Prize headline (landing "Up for Grabs", compete banner) showed the PrizeEscrow balance instead of the winnable pot |
| TS-008 | `GameRegistry` / `TimbPrize` | Settlement counted only Active tickets, so selectively activating one's own ticket could exclude matching Pending winners |
| TS-009 | `TimbSwapRouter` | Swap nudges had no minimum input, so dust swaps drove the meter for gas alone and bypassed the free-nudge cap |
| TS-010 | `TimbSwapRouter` | Exact-output swaps checked only the swap input against `amountInMax`, so the protocol fee was charged beyond the caller's limit |
| TS-011 | `TimbStaking` / `TimbFarm` | `emergencyWithdraw` forfeited pending rewards without releasing them from `rewardReserve`, so `recoverERC20` could never reclaim them |
| TS-012 | Frontend | Token `symbol()`/`name()` from permissionless pairs were rendered via `innerHTML` unescaped (stored XSS on Explore and Swap) |
| TS-013 | `TimbSwapRouter` | An `advanceScroll` batch that settled the segment carried its remaining nudges into the next segment uncharged, bypassing the free-nudge cap |
| TS-015 | `TimbPrize` | `_settleRound` read the entrant count by copying the full `roundEntrants` array, so a sybil flood could push settlement past the block gas limit and halt the game |
| TS-014 | `TimbYieldVault` / `GameRegistry` | Ticket yield weight outlived its game: a registry swap or generation bump left stale weight drawing on the reserve, and a fresh registry's ticket id aliased a retired one |
| TS-016 | `TimbTreasury` (mainnet) | Permissionless `updateTwap` reset the single TWAP observation, so anyone could keep `executeBuyback`'s age gate unmet for ~40k gas per call |
| TS-017 | `TimbPrize` | `startGame` activated the whole round-1 entrant array in one transaction, so a pre-launch submit-and-cancel flood could push it past the gas cap on every attempt |
| TS-018 | `PrizeEscrow` | Repointing the escrow at a new prize cut the old game off from `pay()`, so its unclaimed winners and protocol-cut withdrawal reverted until the owner intervened |
| TS-019 | `TimbPrize` | `entriesPaused` was never read, so the owner's documented entry-pause control did nothing and meter nudges continued during a pause |
| TS-020 | `TimbSwapRouter` | A 1-wei donation plus `sync()` on an unseeded pair left one reserve at zero, so every router add-liquidity call for that pair reverted |
| TS-021 | `TimbGovernance` (mainnet) | The quorum base was fixed at proposal creation, so deposits parked at creation and withdrawn mid-vote still raised the bar and could veto an honestly supported proposal |
| TS-022 | `GameRegistry` | A ticket whose activation was missed counted as live with no round bound, so its wallet could not re-enter until the LER+4 forfeiture sweep |
| TS-023 | `TimbTreasury` | Fee and distribution metrics were unreliable: `receiveFees` and plain ETH credited any sender to `totalFeesReceived` (testnet), and `totalTimbsDistributed` was never written |
| TS-024 | `TimbSwapRouter` | The TS-020 guard covered only the token/token path; `addLiquidityETH` still quoted a dusted, unseeded pair against its reserves and reverted on every ETH-side seed |
| TS-025 | `GasFaucet` / `GameRegistry` | The faucet gated on a ticket's stored status, which a retired generation keeps forever, so a wallet whose game had ended stayed faucet-eligible without playing |
| TS-026 | `TimbBoostFarm` | An emptied pool kept its weight in `totalWeight`, so its emission slice was skipped and live pools were diluted until the owner paused it (fix adopted from the reporter) |
| TS-027 | `GasFaucet` | An exhausted ETH or TIMBS cap reverted the whole `dispense` call, halting the other leg although `claimable` still reported true (fix adopted from the reporter) |
| TS-028 | `GameRegistry` | The first `startGame` kept generation 1 so pre-start tickets stayed valid, but wiped the pricing meters anyway, under-pricing entries for the first game (fix adopted from the reporter) |
| TS-029 | `TimbSwapRouter` | `advanceScroll` charged the free-nudge allowance for nudges the prize dropped as no-ops while awaiting its VRF word (fix adopted from the reporter) |
| TS-030 | `TimbBoostFarm` | Pool clocks parked at `periodFinish`, so a top-up after a keeper gap charged the dead window at the new rate; the TS-002 roll-forward left this open (fix adopted from the reporter) |
| TS-031 | `GameRegistry` | The forfeit sweep's TIMBS leg was a bare transfer, so a paused token or transfer cap reverted the whole settlement call and parked the cursor, while the ETH legs were best-effort (fix adopted from the reporter) |
| TS-032 | `TimbTreasury` | The router's excess-ETH refund from `provideLiquidityETH` landed in `receive()` from an authorised sender and was booked as fee revenue; the TS-023 sender gate left this open (fix adopted from the reporter) |
| TS-033 | `GasFaucet` | A TIMBS balance shortfall or a wallet's lifetime TIMBS cap still reverted the whole `dispense`, locking that wallet out of the ETH drip; the TS-027 leg retirement covered only the global caps (fix adopted from the reporter) |
| TS-034 | `TimbGovernance` (mainnet) | Votes were weighed by the voter's live deposit while the quorum base was frozen at creation, so a deposit made after a proposal existed could vote at full weight; the mirror of TS-021 (fix adopted from the reporter) |
| TS-035 | `GasFaucet` | The ETH leg's treasury pull and pot deposit were bare calls, so a counterparty revert took the independent, pre-funded TIMBS leg down with it (fix adopted from the reporter) |
| TS-036 | Frontend (`swap.js`) | Remove-liquidity signed with zero minimums while the preview quoted amounts, so a price move between preview and execution delivered less with no revert (fix adopted from the reporter) |
| TS-037 | `TimbFarm` / `TimbStaking` (mainnet) | The owner rate-change solvency check compared the new rate over the remaining period against the whole TIMBS balance, ignoring rewards already accrued but unclaimed, so a hike could pass the check and still leave claims reverting until a refill (fix adopted from the reporter) |
| TS-038 | `GasFaucet` | The claimant ETH drip hard-reverted when the claimant could not receive ETH, which also reverted the independent, pre-funded TIMBS leg and left `claimable()` reporting true for a wallet that could never claim (fix adopted from the reporter) |
| TS-039 | `GameRegistry` (mainnet) | The per-string entrant list was appended on every mint and never pruned on cancel or replace, so a mint-and-cancel loop could fill `maxEntrantsPerString` for gas alone and lock every other wallet out of that string (fix adopted from the reporter) |
| TS-040 | `TimbGovernance` (mainnet) | Voting-power checkpoints had one-second granularity with same-second overwrite, so a deposit mined in the same second as `createProposal` was weighed as held at creation, bypassing the TS-034 snapshot within that second (credit: the reporter) |
| TS-041 | `TimbTreasury` (mainnet) | `splitLpFees` took the pair on trust, so a contract claiming a WETH side and returning a chosen burn amount could make the treasury unwrap its real WETH into the prize pot and inflate the fee-split counter (fix adopted from the reporter) |
| TS-042 | Frontend (Compete) | The pot line showed the previous round's carry as "rolled over X ETH" beside a pot that already contained it, so on a no-winner round the two labels read as twice the payable prize; now worded as a breakdown of the pot (fix adopted from the reporter) |
| TS-043 | `GameRegistry` | A migration deploys a fresh registry and never advances the outgoing one's generation, so its outstanding tickets failed the `reclaimFromPastGame` guard and the runbook's recovery path could not execute; the owner can now retire a registry, opening reclaim for every ticket (fix adopted from the reporter) |
| TS-044 | `TimbFarm` / `TimbStaking` (mainnet) | The TS-037 solvency check inferred accrued liability from the reward reserve, which is not recalibrated on a rate cut, so a later hike could revert while the contract was solvent; liability is now tracked explicitly (fix adopted from the reporter) |
| TS-045 | Frontend / docs (fee disclosure) | The docs and the swap quote stated a 0.30% all-in swap fee with a 0.05% protocol share while the testnet router added a 0.05% fee on top of the pool's 0.30%, so routed swaps cost 0.35% with a 0.10% protocol take; the quote now shows the live total and the docs state 0.35% on testnet and 0.30% on mainnet, where the router fee is zero (fix adopted from the reporter) |
| TS-046 | `GameRegistry` | The TS-043 `retireGame()` bumped the generation but did not call the yield vault's `newEpoch()`, so a registry retired without first repointing the vault left the last generation's ticket weight live in the vault, letting abandoned tickets keep drawing on the yield reserve; every generation bump now retires the prior weight through one shared path (fix adopted from the reporter) |
| TS-047 | `TimbAirdropDistributor` (mainnet) | `distribute(recipients, round)` took `round` from the caller and keyed both the one-way `claimed[round][recipient]` flag and `perRoundCap` on it, so the "double-send is impossible" guarantee only held within a label the dispatcher itself picked; a queue row with a wrong or fresh round number paid the same address again (privileged key required, bounded by the float). The round is now owner-set and monotonic: `distribute` requires `round == currentRound` and only `advanceRound()` opens the next campaign (fix adopted from the reporter) |
| TS-048 | `TimbSwapRouter` | The router's `receive()` accepted ETH from any sender, where the reference V2 router only accepts it from WETH, so ETH sent directly to the router (a fat-fingered transfer) was accepted and had no exit; `receive()` now reverts unless the sender is WETH, so a direct send bounces instead of locking the sender's ETH, with no owner sweep added (narrower fix than the one suggested; reported by the hunter) |
| TS-050 | `TimbGovernance` (mainnet) | `castVote` weighed a vote by the proposal-creation snapshot alone while `withdrawVotingPower` ratcheted the quorum base down, so a holder could withdraw right after creation, move the tokens, and still vote at full snapshot weight against a smaller base with the vote lock guarding an empty balance; the counted power is now the creation snapshot less whatever the voter withdrew while the proposal was open, capped by what is still deposited, so power that left a proposal's base can never return to its votes through a redeposit (fix adopted from the reporter; amended 2026-10-14 after the reporter showed a same-block withdraw-and-redeposit still passed the first version; supersedes the TS-034 fix) |
| TS-051 | `TimbPrize` | The TS-004 distinct draw probed linearly from the VRF start, so a start that hit an already-locked char slid to the next free one and the char after a run of locked chars absorbed every start on that run; ascending run strings (ABCDEF, 012345) won 109x to 386x more often than a fair distinct draw. The lock now draws uniformly over the free chars of the class (fix adopted from the reporter; the deployed testnet build predates the distinct draw and is unaffected) |
| TS-052 | `TimbSwapRouter` | Swap nudges were gated on the input token and its minimum size but never on the pool, and pools are permissionless, so a swapper who owned a WETH/anything pool outright got the LP share of every swap straight back and could steer each segment's letter-or-digit class for the pool's protocol share plus gas; a swap now earns nudges only when its first hop is a protocol-designated pool (fix adopted from the reporter; amended 2026-10-17 after the reporter showed that one provider holding most of a designated pool's liquidity recovers the LP share the same way: designated pools are seeded deep and taken off the list while a single provider holds most of one) |
| TS-053 | `GasFaucet` (mainnet) | The top-trader cooldown reset was stored as the grant's timestamp and honoured only when the wallet's last claim was strictly earlier, so a grant landing in the same second as that claim spent the round's one reset and emitted `ResetGranted` while lifting nothing; a grant now sets a pending reset that the wallet's next claim spends, whatever the order within a block (fix adopted from the reporter; the testnet faucet has no reset and is unaffected) |
| TS-054 | `GasFaucet`, `TimbAirdropDistributor` | The guardian, meant as a fast stop for a leaked hot key, could set the pause either way, so a compromised guardian could undo the owner's pause and let distributions resume; the guardian can now only pause, and lifting a pause is the owner's (the timelock on mainnet) (fix adopted from the reporter; the live Arbitrum One airdrop stays paused until its TIMBS-launch redeploy) |
| TS-055 | `TimbSwapRouter` | The free-nudge cap on `advanceScroll` was keyed per address, so several wallets multiplied it and steered a segment's letter-or-digit class for gas alone; free nudges are off in the mainnet beta, so only paid swaps through the designated pools steer |
| TS-056 | `GameRegistry` | `setYieldVault` moved the pointer without retiring the outgoing vault's ticket weight, unlike the vault-side repoint and the generation bump, so the orphaned vault kept accruing on dead weight until the earmark covered its whole reserve (fix adopted from the reporter) |
| TS-057 | Frontend (token approvals) | The swap, liquidity, farm, lock and game-entry flows computed the exact amount each transaction needed, then approved an unlimited allowance (`MaxUint256`) to the protocol's own contracts, so one small interaction left the user's whole balance of that token approved indefinitely; each flow now approves exactly the amount it needs (fix adopted from the reporter) |
| TS-058 | `BoostRewarder` | Once the farm's hook was removed (the documented token-replacement step), nothing synced the rewarder's shares again, so the shares frozen at removal kept collecting its whole reserve after their holders left the farm, each claim re-arming a full emission window, and the owner could neither stop it nor recover the reserve; an owner `retire()` now ends emission, keeps accrued rewards claimable and makes the unowed reserve recoverable (fix adopted from the reporter) |
| TS-059 | `GameRegistry` / migration | During a migration the escrow was repointed at the new prize before the old prize and registry were retired; in that window the old registry's permissionless lapse sweep called `addToPot` on a prize the escrow no longer accepts, and the lapse leg's try/catch sent 100% of each ETH lapse to the treasury instead of 70/30. The migration now retires the old pair in the same broadcast, before the repoint, so no sweep runs in between and old tickets are reclaimed by their holders (no contract change) |
| TS-060 | `TimbBoostFarm` | `emergencyWithdraw` released the forfeited pending from the solvency ledger without retargeting, so a farm at the 99% solvency stop kept a zero rate on the freed reserve and fresh deposits earned nothing until an unrelated claim or top-up; the forfeiture now retargets, as `claimRewards` does (fix adopted from the reporter) |
| TS-061 | `TimbLockVault` | The vault's only exit was `withdraw(lockId)`, so an ERC-20 sent to it without `lock()` (a fat-fingered transfer) was stranded for good, unlike every other custody contract; the vault now tracks locked principal per token and an owner `recoverERC20` can return only the balance above it (fix adopted from the reporter) |
| TS-062 | `TimbSwapRouter` | Swap and liquidity entry points passed the recipient `to` through unchecked, and the pair rejects only its own tokens and itself, so a swap, LP mint or liquidity withdrawal sent to the router's own address succeeded and the tokens were stranded with no exit (TS-048 had closed the ETH side only); every entry point now reverts when `to` is the router (fix adopted from the reporter) |
| TS-063 | `TimbPrize` (mainnet) | When the escrow rejected a yield-harvest deposit (a prize/escrow wiring mismatch), the harvested ETH stayed on TimbPrize uncredited, and the promised recovery on the next deposit never happened: only each new harvest was forwarded, and the prize has no other ETH exit. Every settlement now forwards the prize's whole ETH balance, which can only be harvest, so stranded yield reaches the pot on the next successful deposit (fix adopted from the reporter) |
| TS-064 | `TimbFarm` / `TimbStaking` | While a reward period ran with nobody staked, its emission accrued to no one but was never taken off `rewardReserve`, so `recoverERC20` could not reach it and no later `notifyRewardAmount` re-streamed it: a farm funded before its first stake, or emptied mid-period, kept that TIMBS committed for good. The zero-stake stretch is now released from the reserve as it passes (fix adopted from the reporter), and `setRewardRate` recommits the reserve to the accrued liability plus the new rate over the rest of the period, so a cut releases its difference and a hike keeps re-emitted TIMBS reserved |
| TS-065 | `TimbGovernance` | TIMBS sent to the contract by plain transfer, instead of `depositVotingPower`, was credited to no one, and `withdrawVotingPower` pays only credited balances, so it was stranded for good with no owner exit, unlike every other custody contract. The owner can now return it with `recoverERC20`, bounded for TIMBS by `totalVotingPower` so deposited voting power is never touched (fix adopted from the reporter) |
| TS-066 | Frontend (swap fee disclosure) | The swap page's "Total fee" line showed one pool fee plus the router fee for every route, but a route through WETH (A → WETH → B) pays the 0.30% pool fee in each of its two pools, so a two-hop swap's fee was shown as 0.35% when it was about 0.65%. The line now counts the route's hops and shows the pool fee compounded over every pool plus the router fee once, in both the percentage and the amount; the quoted output, minimum received and rate were already correct (follows TS-045) |
| TS-067 | `DeployGen3Migration` / `DeployPrizeVRFMigration` (scripts) | A prize migration retired the outgoing prize and repointed PrizeEscrow at the new one, but nothing carried the outgoing live pot across: its ETH stayed in the escrow while the new prize started at `currentAccumulatedRewards = 0`, so the pot players had built was owed to no one until an owner emergency withdrawal. Both migration scripts now carry the outgoing prize's unallocated pot into the new prize (`emergencyWithdraw` then `fundPot`) right after the repoint and check it was credited; settled winnings still owed stay in the escrow for their claims |
| TS-068 | `TimbSwapRouter` | TS-062 rejected the router itself as a recipient but not WETH. On an ETH-out call (`swapExactTokensForETH`, `removeLiquidityETH`) with `to` set to the WETH contract, the router unwrapped the output and sent the ETH to WETH, whose `receive()` deposits for the sender, i.e. the router, which has no token exit; the recipient check now rejects WETH as well (follows TS-062) |
| TS-069 | `TimbGovernance` | The TS-021 quorum ratchet lowered a proposal's base to the live total voting power, but deposits made after the proposal was created (which cannot vote on it, TS-034) kept that total up, so a snapshot holder's withdrawal could leave the base unchanged and departed power still propped the quorum bar. A withdrawal now takes the departing creation-time power off each open proposal's base directly (follows TS-021) |
| TS-070 | `TimbGovernance` | The TS-040 seal moves a voting-power change made after a proposal to the next second, but a second proposal created in that same second read the withdrawn power as still held at creation while its base already excluded it, so a later redeposit could vote above the base. Proposals are now limited to one per second (follows TS-040) |

## Severity & rewards

Severity is **impact-based**: what the bug would do with real funds, guided by
the [Immunefi severity classification](https://immunefi.com/immunefi-vulnerability-severity-classification-system-v2-3/).
Rewards settle **pari-mutuel**: each tier holds a share of the pool, split
among all accepted reports in that tier. The bands below are what a report
pays when it is the only accepted report in its tier. **No single payout
exceeds $500** in this pre-mainnet phase. First valid reporter of a unique
issue is eligible; duplicates earn nothing.

| Tier | Class | What lands here | Reward (tier share, if unshared) |
|---|---|---|---|
| **T1** | UI / display | A display or labelling bug that could mislead a user into a losing on-chain action. | **credit + up to $50** |
| **T2** | Operational / fallback | Keeper or automation failures, VRF stall or re-request griefing, recoverable settlement or liveness DoS. Value stuck, not lost. A stall must be one someone can cause, or one the protocol cannot recover from; slow fulfilment by Chainlink or Arbitrum infrastructure is not a finding. | **$50 – $100** |
| **T3** | Misrouting / contractual | Value routed to the wrong place or mis-split: buyback, lapse, pot / escrow / refund accounting. Off-chain-signalling governance manipulation. | **$100 – $250** |
| **T4** | Token & DEX structural | TIMBS mint / inflate / cap bypass, whitelist bypass, DEX k-invariant break, reward-solvency break, LP theft. | **$250 – $450** |
| **T5** | Deep exploit / drain | Full drain of `PrizeEscrow` / `TimbYieldVault` / `TimbTreasury` / the pair; prize-outcome manipulation; owner or privilege escalation; chained exploit. | **up to $500** (cap) |

Reentrancy that bypasses the `nonReentrant` guards is priced by its impact.
Final severity and reward are at the maintainers' discretion.

## Rules of engagement

- Prefer your own local fork. Do not grief, spam, or DoS the shared Arbitrum
  Sepolia deployment, the faucet, or the keepers other players rely on.
- No social engineering, phishing, physical attacks, or targeting of team
  members or third parties.
- One report per unique root cause.

## Safe harbor

For research conducted in good faith and within these rules, TimbSwap will not
pursue or support legal action against you, and considers your activity
authorized. This is not authorization to violate any law or to access accounts
or data that are not yours. If in doubt, ask first via the private channel.

## Eligibility

- Not open to current or former TimbSwap contributors, or their immediate
  family.
- You must comply with applicable sanctions and AML law. KYC may be required
  before payout.
- Reports must be received by **26 October 2026, 23:59 UTC**. Because tiers
  settle pari-mutuel, tier counts and payouts are calculated after the program
  closes; each accepted reporter is emailed their calculation before payment.

---

*The mainnet program, with larger bands and real value at risk, is described in
the [TimbSwap repository's SECURITY.md](https://github.com/0xTimberZx/TimbSwap/blob/main/SECURITY.md)
and takes over after the independent audit.*
