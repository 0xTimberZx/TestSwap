# Security Policy & Bug Bounty (testnet phase)

TimbSwap is live on **Arbitrum Sepolia** as a capped, unaudited testnet. Every
token is a test asset with no monetary value, and the bug bounty runs **now**,
before the independent audit and any mainnet launch, so vulnerabilities are
found and fixed while nothing real is at stake. Rewards are real: **USDT on
Arbitrum One**, paid from a public bounty wallet.

> **Report privately — do not open a public issue.**
> Primary channel: **devhub@timbswap.xyz** (security-only inbox; put the
> contract name in the subject). A GitHub private advisory on this repo
> (Security → "Report a vulnerability") is also accepted whenever the repo is
> reachable; email is the channel that is always open.

The full program terms, the reward tiers, and the live pool balance are on the
[Protocol page](https://testnet.timbswap.xyz/gov/#bounty). This file is the short form.

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
[Docs address table](https://testnet.timbswap.xyz/docs/) and their source in
`contracts/` (also served at [testnet.timbswap.xyz/source](https://testnet.timbswap.xyz/source/)): DEX core, prize game, token and incentives, governance.

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
| TS-005 | `VRFEntropy` | Permissionless `rerequest` has no per-salt retry cap; each call spends the VRF subscription. The cap shipped in the mainnet source first and reached the testnet source later (credit: Ginan Saputra for catching the gap) |
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

---

*The mainnet program, with larger bands and real value at risk, is described in
the [TimbSwap repository's SECURITY.md](https://github.com/0xTimberZx/TimbSwap/blob/main/SECURITY.md)
and takes over after the independent audit.*
