# TimbSwap — Project Specs & Development Notes

**Protocol:** TimbSwap  
**Token:** TIMBS  
**Network:** Arbitrum Sepolia (Chain ID: 421614)  
**Repo:** github.com/0xTimberZx/TimbSwap  
**Live:** 0xtimberzx.github.io/TimbSwap/  
**DebugHub:** 0xtimberzx.github.io/MyDapp/debughub/  
**Pragma:** `pragma solidity 0.8.24` — exact, never `^`  
**Compiler:** viaIR enabled, optimizer 200 runs, EVM cancun  
**Verification:** Sourcify preferred  
**Last updated:** August 2026

---

## Deployed Contracts — Arbitrum Sepolia

| Contract | Address | Verified |
|----------|---------|---------|
| PrizeEscrow | 0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D | Sourcify ✅ |
| TIMBSToken (TIMBS) | 0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa | Sourcify ✅ |
| TimbSwapFactory | 0xCCd6d3f0A86042d2B7056eDd381d367126628AF5 | Sourcify ✅ |
| TimbSwapRouter v8 | 0x40C7Caf90817C9891D278Ec1400B9deb180911f1 | Sourcify ✅ |
| EligibleTokenRegistry | 0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04 | Sourcify ✅ |
| GameRegistry (generations) | 0xfca8C2A107298273508BE8C5f469344b0Fc8B5B4 | Sourcify ✅ (game-generation epochs; supersedes all earlier registries) |
| TimbPrize (generations) | 0x35976f4D2260127848a6274D2eC89ee054412432 | Sourcify ✅ (startGame bumps the registry generation) |
| TimbYieldVault | 0x43D833e828e2AF951527C2b573Eb70c358FfEB0B | Sourcify ✅ |
| TimbStaking | 0xe776c7b700B190ED8248741F9b518B08d8733C8F | Sourcify ✅ |
| TimbFarm | 0xE319E2206F71A5cD8dd2c411C6F29712935f9011 | Sourcify ✅ |
| TimbLockVault | 0x0157086E7670D1eFb15DC6b5158eE78279927a41 | Sourcify ✅ |
| TimbTreasury v4 | 0xd3F40042aFA8074EA68C9f61dE6aDADD539F0D5c | Sourcify ✅ — three-way buyback split (burn/reserve/waterfall) + protocol-owned liquidity; live per config.js and confirmed by on-chain drains |
| TimbGovernance | 0x8a324EfDc457BfB9Cf3D077E4CBC5A16a1c6a061 | Sourcify ✅ |
| TIMBS/ETH Pair | 0x5a911CBfD2808Ad5214E842a0E8ae34d8199BB95 | via Factory ✅ |
| WETH (Arb Sepolia) | 0x980B62Da83eFf3D4576C647993b0c1D7faf17c73 | — |
| USDC (Circle canonical, 6 dec) | 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d | — |
| LINK (Chainlink canonical) | 0xb1D4538B4571d411F07960EF2838Ce337FE1E80E | — |
| DAPP Token | 0x3d0cB8929c22F93A9dd33921E6f43C1621FCfC04 | — |

### SwapTables — generation 9 (live)

Boards are immutable and redeployed per generation; the seed registry and jackpot span all of
them. Gen-9 keeps gen-8's Chainlink VRF entropy and its entire external ABI unchanged — it changes
only where the table seed goes: the 100-TIMBS seed no longer enters any pool (two wallets hedging
Red/Black could Sybil-farm ~79% of it, `dev-docs/AUDIT_SEED_FARM.md`) and is swept whole to the
UnderwriteReserve at retire. Honest winners still land on `stake × fair × 0.90`. The VRF entropy
design carried over from gen-8:

Gens 1–7 drew each character from a commit-reveal with a 64-block blockhash fallback. That gave
the wallet holding the secret a **selection edge**: once the lock block was public it could
compute both the reveal outcome and the fallback outcome, then choose between them by acting or
not acting — a Colour bet worth 50% honestly became 75% with the pick.
Gen-8 deletes the second path rather than policing it. One Chainlink VRF v2.5 draw per segment,
no secret, no fallback, nothing to choose between.

One request per **segment**, not per round: a fulfilled word is public the instant the callback
lands, so requesting six at once would publish the whole round and kill the staggered reveal.
`armSegment(id, seg)` fires one draw; `lockSegment(id, seg)` is permissionless and takes no
secret. A draw that never returns is replaceable after 30 minutes — the only stall escape, and
not a second way to produce a character, since an unfulfilled request has no knowable value.

| Contract | Address | Notes |
|---|---|---|
| SegmentBoard (gen 9) | 0xB2D10cA505909b909835f4b5684B205b157b5Bf2 | Sourcify ✅ `exact_match` — VRF board; seed routed whole to the reserve (§9 farm closed) |
| PoolLedger (gen 9) | 0xE7dE0Fc722369Bd96b98453676E331EB24d9161b | Sourcify ✅ — custodies chips PER TABLE; pays winners |
| UnderwriteReserve (gen 9) | 0x3c4E9fF78e9017b23aA97F6FfeDdDb73cF79F040 | Sourcify ✅ — top-up float **+ the whole table seed**; income = dead pots + half rake |
| VRFEntropy (gen 9) | 0xa5Fde993ec0a38a57249E06F5A0BF93e2C6093A6 | Sourcify ✅ `exact_match` — Chainlink VRF v2.5 consumer, one word per segment |
| SegmentBoard (gen 8) | 0x89eE2553AD7c72700A7BfD7A095440cc8BE55227 | Retired 2026-08-05 — superseded by gen 9; ledger still pays withdrawals |
| PoolLedger (gen 8) | 0x9195803ecA9A0F4F813502A110b32C842330fD0D | Retired board, **live ledger** — old credit is payable forever |
| UnderwriteReserve (gen 8) | 0x69C9E840aEc4368016038bF54e603E345ede1063 | Retired 2026-08-05 — drained to treasury at gen-9 cutover |
| VRFEntropy (gen 8) | 0xD982C7218cBD3c395a0A1461732ADEc99A3A87c0 | Superseded by the gen-9 VRFEntropy; kept for reading old rounds |
| SegmentBoard (gen 7) | 0xf3FF34488D472b89497Cf31631c77bE85524A65a | Retired 2026-08-04 — reserve drained, ledger still pays withdrawals |
| PoolLedger (gen 7) | 0xAA4f4303b747bEa63F9818Bc9C38dAe5aebDe218 | Retired board, **live ledger** — old credit is payable forever |
| CommitRevealEntropy (gen 7) | 0x57A1F889A30178b62Bc39844D73B68d0f8a274d6 | Superseded by VRFEntropy; kept for reading old rounds |
| SeedRegistry | 0x2460C8ed63414F36838542982A5Ab263C9Fcb914 | **Cross-generation** — never redeploy; stops a winning string seeding two tables |
| SegmentCrank | 0x09B8bC3eD49491DA2AaC47ad6DDC9A0cB6B2783D | Stateless lock/retire batcher, **generations 4-7 only** — its `lockSegment` takes a secret and the VRF boards (gen-8/9) have none. Apps gate every crank path; `retire` is all the VRF boards share |
| DDJackpot | 0x73D3c3224Ed4F4fA663878bf32B8605A2DAe96B9 | **Cross-generation** — metered strikes, stake-capped, §9 two-wallet guard |

| Parameter | Value |
|---|---|
| Seats | 2 minimum to arm, 12 hard cap |
| Pools | 7 = six segment pools + round-wide Repeats a Digit |
| Chips | 5 / 10 / 25 / 50 / 100 / 500 / 1000 TIMBS |
| Table seed | 100 TIMBS, routed **whole to the UnderwriteReserve** at retire (gen-9); never enters a pool. (Gen-8 split it 7 ways among contested pools — Sybil-farmable, closed in gen-9.) |
| Rake | 1.75% + 6.25%/n, n = distinct wallets; **0% uncontested** |
| Underwrite | toward `stake × fair × 0.90`; caps 1000/pool, 1500/round, 10% of free float |
| Dials (gen 9) | entry ≤ 40 min, place 5 min, bets close 2 min before the pick, sit-quiet 5 min, solo wait 15 min |
| Jackpot slice | 20% of the banner, floor 50 TIMBS, ≤ 50% cap, your own chip × 10 as a per-wallet ceiling |

Retired boards keep paying withdrawals from their own ledgers — retiring a generation never
strands credit. Gen 6 (`0x1de9889da2083F5f1693DfCf589A453E9b39EEA7`) retired 2026-08-03.

**Seed-farm finding — fixed in gen-9.** The gen-8 §9 two-distinct-wallets gate was
Sybil-farmable: two wallets hedging Red/Black harvested ~79% of every table seed risk-free
(~78.6 TIMBS on a 100 seed). Escrow accounting was sound and no player credit was ever reachable —
it was an economic leak of house seed, bounded per table and haltable via the guardian. **Gen-9
(`contracts/SegmentBoardVRF9.sol`) closes it**: the whole seed is routed to the UnderwriteReserve
at retire so it never enters a distributable pot; honest winners still reach `stake × fair × 0.90`.
Full audit, math and both regression tests: `dev-docs/AUDIT_SEED_FARM.md`,
`tests/SeedFarmExploit.t.sol` (drains gen-8), `tests/SeedFarmClosed.t.sol` (proves gen-9 dead).

**DDJackpot Sybil gate — accepted, not fixed.** The same §9 construction on the jackpot's
2-DD-wallet gate is +EV to a two-wallet farmer (P(DD hit)=0.3557; +11.3 to +29.1 TIMBS/round at
min chips, simulation-confirmed). It is accepted as bounded operational risk: no on-chain fix keeps
the feature (the payout *is* the jackpot — nothing to reroute), the pot holds only recycled/donated
TIMBS so the worst case is a slow float bleed, the farm signature is legible on-chain, and the
guardian can halt strikes instantly. Reasoning and numbers in `dev-docs/AUDIT_SEED_FARM.md`.

### Router Version History

| Version | Address | Status |
|---------|---------|--------|
| v1 | 0x1f4C522E55FfE336eD474e6deAAc3a4bBe3Fd117 | Retired |
| v2 | 0xf69ca9Ac2E39aD5f86A8410b10D290A49984e6AB | Retired |
| v3 | 0x781833D60800b93C3a9EFf234b15934F9AE0C5E7 | Retired |
| v5 | 0xbD183E52806D6fddA680cFe3e7929E869Abf6F67 | Retired |
| v6 | 0x6E53dc53Ea7B2fd8be171D74A381f009dA5F94bD | Retired |
| v7 | 0xF554063223ECE3acC4f9664227Ba1E7a88c54e09 | swap-weighted nudges (swapNudgeWeight) + per-address free-nudge cap (freeNudgeCapPerSeg) |
| v8 | 0x40C7Caf90817C9891D278Ec1400B9deb180911f1 | **Current** — multi-hop path routing (swapExactTokensForTokensPath, X→WETH→Y) |

### Deprecated / Dead Addresses

| Address | Reason |
|---------|--------|
| 0x06aebE938113524D9E29C51BacE7d7A155051a60 | Old factory — no bytecode redeployed |
| 0xefFea3C2D1aA32eE9D93Cc0E888647E6A168293f | Phantom pair — 500k TIMBS permanently locked (treated as burned) |
| 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 | Treasury v1 — retired; **9,117.798 TIMBS unrecoverable**, confirmed by trace 2026-08-04. Its only token-moving function, `distributeToStaking`, calls `safeTransfer(address,uint256)` (`423f6cef`) on the token — a SafeERC20 *library* function that was mistakenly declared in v1's token interface. TIMBS has no such selector, so the call reverts in 247 gas before the destination matters. Nothing an owner can set fixes it: the failure precedes every configurable address. See `dev-docs/TREASURY_V1_RECOVERY.md` |
| 0x566395B9FAd004520e39FCacbA7E5e805ae97889 | Treasury v2 — retired same-day (held nothing); superseded by v3's ERC20 fee exits |
| 0x05D47F639F8E76BD12Cfc9647F6CcaCe21C10A33 | Treasury v3 — retired; superseded by v4 (three-way buyback split + protocol-owned liquidity). Old fee history readable here |
| 0x4d74F2111fB12f64F39A285251075cf455B84201 | GameRegistry v3 — retired; superseded by v5 (forfeiture after later of claim/active) |
| 0x35490DA1A7FF75C09eF90235Fdde700Fb04DB03F | TimbPrize v5 — retired; superseded by v6 (class-preserving jitter: letter→letter, digit→digit). Old rounds readable here |
| 0xD69a518f04900762F460563d71Bdc8DdF86FB350 | TimbPrize v4 — retired; superseded by v5 |
| 0xee2c3b12e8dED226a6AE8e950e5B6C67eF4CB774 | GameRegistry v2 — retired; superseded by v3 (4-round refund window). Old game history readable here |
| 0xc3fB39E0da3312c7f95bD7aD511ac76C4B86eE40 | TimbPrize v3.2 — retired; superseded by v4 (jittered locks, 2-round prize claim). Old rounds readable here |
| 0xD6c9001c6Bbb55761f7476009AaF5F71C21Fe0b5 | GameRegistry v5 — retired; superseded by the generations rewrite. Old game history readable here |
| 0xcDd1633F9FBD4dD189cF69FF82a005B4fcBe09eB | GameRegistry — retired; last non-generation registry, superseded by the generations rewrite. Un-terminated tickets here refund on their own round windows |
| 0xBBcb21Ef7DBEef21d8a0DE5972E61fd0369Ed3c0 | TimbPrize v6 — retired; superseded by v7 (meter resumes from jittered winning char) |
| 0x52dF701BD15B63Ece56141c22392a5435B608B72 | TimbPrize v7 — retired; superseded by the generations-compatible prize. Old rounds readable here |
| 0x619374B3BfB8E0B23406033e56cF2fCcb36FE57F | TimbYieldVault — retired; superseded by 0x43D833… (fresh weight on the registry cutover) |

---

## Deployment Log

- [x] All 13 contracts deployed + Sourcify verified
- [x] Factory v2 + Router v3 deployed after phantom pair bug fix
- [x] TIMBS/ETH pair created with real bytecode (0x5a911CB…)
- [x] All contracts wired and re-pointed to Router v3
- [x] PrizeEscrow seeded with ETH (tx: 0x0e03bc015b64df175a932f5129d4ebc9f23fe5bd48afbb7a0866cb456510b808)
- [x] TimbStaking funded: 25e18 TIMBS, 2592000s
- [x] TimbFarm funded: 50e18 TIMBS, 2592000s
- [x] startGame() called — Round #1 LIVE
- [x] GitHub Actions settler running — confirmed green run #63
- [x] DebugHub TimbSwap tab live
- [x] All 7 frontend pages deployed to GitHub Pages

### Permanent Burn Event

| Field | Detail |
|-------|--------|
| Amount | 500,000 TIMBS (0.5% of supply) |
| Address | 0xefFea3C2D1aA32eE9D93Cc0E888647E6A168293f |
| Cause | Phantom pair — no bytecode, unrecoverable |
| Date | June 2026 |
| Effect | Effective circulating supply ~99.5M TIMBS |

---

## Core Principle

The game should be entertaining even if the token price is flat. Revenue comes from gameplay and trading volume, not token inflation. TIMBS represents ownership of the ecosystem. Player entry principal is always refundable — zero capital risk to participate.

---

## Protocol Architecture

### Fee Structure

| Fee | Amount | Destination |
|-----|--------|-------------|
| Total swap fee | 0.3% | — |
| LP share | 0.25% | Liquidity providers |
| Protocol share | 0.05% | TimbTreasury |
| Protocol game cut | Owner-set % | TimbTreasury |
| Buyback burn | 50% of purchased TIMBS | Burned via burn() |
| Buyback staking | 50% of purchased TIMBS | TimbStaking distributions |

### Capital Bucket Separation — Never Violate

```
GameRegistry escrow    → player principal only, always refundable
PrizeEscrow            → protocol-funded prize ETH only
TimbTreasury           → protocol revenue, buybacks, operations
```

These three buckets must never mingle.

### Prize Game

- **Round:** 6 segments × 60 min = 6 hours
- **Segment:** 59:45 interaction + 0:15 settlement
- **Scroll:** positionCounter +1 per eligible swap, never resets
- **Window:** alphabet[(counter+i) % 36] for i 0–5
- **Lock (§13.2):** per segment, char jittered from keccak256(blockhash(n-1), counter, round, segment), kept in the live char's class — letter→letter (mod 26), digit→digit (mod 10). Class is aimable via nudging; exact char is not
- **Rollover (v7):** at round settle, each segment's next-round counter is seeded to the index of the char it just locked, so the meter opens the new round on the previous round's **jittered winning string** and nudges up from there (pre-jitter continuity, now linked to the scored char, not the raw counter)
- **Entry:** 6 chars, A-Z + 0-9, no repeats, plays in round N+1
- **Payout:** floor(pot/n) × n, remainder r snowballs
- **Prize claim window:** 2 rounds from the winning round (flat, no grace)
- **Principal refund window:** 4 rounds after lastEligibleRound (decoupled; a lapsed prize never shortens it)
- **Verification:** dual-layer — verifyEntryExisted() + verifyEntryValid()

### Yield Vault rate (TimbYieldVault)

The vault mints pot yield from active ticket escrow. `ratePerSecond1e18` = **pot wei
per 1e18 of weight per second** (weight is ETH-equivalent: 1 ETH escrow = 1e18 weight;
TIMBS escrow converts via `timbsWeight1e18`). Accrual is
`totalWeight × ratePerSecond1e18 / 1e18 × elapsed`, **capped by the vault's reserve**
(`balance − accruedForPot`) so it can never pay out ETH it doesn't hold.

**APR ⇄ rate conversion** (365-day year = 31,536,000 s):

```
ratePerSecond1e18 = aprBps × 1e18 / 10_000 / 365 days      // setYieldAPRBps(aprBps)
APR%              = ratePerSecond1e18 × 31_536_000 / 1e18 × 100
```

Decode examples:
- `3_170_979_198`  → 10% APR  (`setYieldAPRBps(1000)`)
- `95_129_375_951` → **300% APR** (`setYieldAPRBps(30000)`) ← current

APR is a rate on *active weight* — 300% of a tiny active escrow is still tiny. Grow the
pot by raising active weight (more/larger tickets) or seeding directly via
`TimbPrize.fundPot()`.

---

## Frontend

### Pages

| Page | URL | Status |
|------|-----|--------|
| Landing | / | ✅ Live |
| Swap | /swap/ | ✅ Live |
| Compete | /compete/ | ✅ Live |
| Farm | /farm/ | ✅ Live |
| Lock Vault | /lock/ | ✅ Live |
| Governance | /gov/ | ✅ Live |
| Analytics | /analytics/ | ✅ Live |
| V2 Pools | /explore/ | ✅ Live |
| Docs | /docs/ | ✅ Live |

### Path Rule

The app is served from the **repo root** (GitHub Pages, `path: "."`), so page URLs
are clean: `/swap/`, `/compete/`, etc. — no `frontend/` segment.

Inner pages at `<page>/index.html` use `../style.css` and `../config.js`, which
resolve to the single root `style.css` / `config.js` (one copy each, shared by
every page including the landing). Absolute in-app links are root-relative (`/…`)
so they work on any host/custom domain.

### Key Frontend Rules

- ethers CDN: `cdnjs.cloudflare.com/ajax/libs/ethers/5.7.2/ethers.umd.min.js`, no `type` attribute
- Gas: `getFeeData()` × 1.30 on both fee params + 50% gasLimit buffer
- Nonce: explicit `getTransactionCount(address, "pending")` on every write
- Wallet persistence: `autoReconnect()` via sessionStorage on every page load
- DebugHub stub: always defined after SDK script tag — never let it break the page

---

## Settler Automation

| Setting | Value |
|---------|-------|
| Schedule | Every 10 minutes (cron) |
| Health check | Daily at 12:00 UTC |
| Working directory | `scripts` (plural) |
| Node version | 22 |
| Retry logic | Up to 3 attempts with 8s backoff |
| Error categories | NONCE / FUNDS / REVERT / NETWORK / GAS / UNKNOWN |

### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `ARB_SEPOLIA_RPC` | Arbitrum Sepolia RPC URL (Alchemy/Infura/public) |
| `SETTLER_PRIVATE_KEY` | Deployer wallet private key (no 0x prefix) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token — regenerate after any exposure |
| `TELEGRAM_CHAT_ID` | `8726225587` |

---

## Tokenomics

| Parameter | Value |
|-----------|-------|
| Hard cap | 100,000,000 TIMBS |
| Effective supply | ~99,500,000 TIMBS |
| Entry cost | ETH (`entryCostETH`) or TIMBS (`entryCostTIMBS`), both governance-adjustable |
| Extra rounds | `entryCostTIMBS` each, max 12/ticket, non-refundable |
| Segment timing | 60 min = 59 min 45 s open + 15 s permissionless settlement; 6 segments/round |
| Prize claim window | 2 rounds from the round the ticket matched |
| Principal refund window | 4 rounds after the LATER of the ticket's last eligible round and its prize-claim window (LER+4 for non-winners; up to LER+6 if it wins its last eligible round) |
| Buyback burn ratio | 50% (adjustable via TimbTreasury) |
| Emissions | Governance-unlockable, off by default |
| Protocol fee | 0.05% of swap volume |

---

## DebugHub Integration

**appName:** `TimbSwap`

Error catalog lives in `MyDapp/debughub/app.js` → `ERROR_EXPLANATIONS`.  
**Must evolve** — add new entries every time a new error pattern is encountered.  
Never treat the catalog as complete.

### Checkpoint Format

```
Module:Action Stage
e.g. Swap:Approve Confirmed / Prize:Claim Failed / Gov:Vote Submitted
```

---

## Ecosystem Notes

TimbSwap is isolated from BlockpotDAO/MessageBoard/0xFaucet at launch.  
All four share the DebugHub dashboard.  
Deployer: `0x42536623b503D4926DfAF6173B0357b7DfD19800`

Optional future hook: partner pool flag routes LP fees to BlockpotDAO PrizeVault v3 (not active at launch).
