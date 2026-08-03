# TimbSwap

**An exchange with a prize game built in — and one incentive engine underneath both.**

TimbSwap is a decentralized exchange whose swap fees and idle-capital yield fund a recurring,
on-chain prize game. The swap, the staking, the farming, and the game are not separate products
— they are modules of a single self-funding loop. What the protocol earns is swept back to the
people who generate it, on a fixed cadence, under hard solvency limits. Rewards are funded by
real inflow, never printed.

It is **source-available, permissionless, and non-custodial**: the protocol is a set of **Solidity
smart contracts** on Arbitrum, verified on Sourcify, that anyone can call directly — settlement
and payouts need no privileged operator, and you always hold your own keys.

**Live:** [timbswap.xyz](https://timbswap.xyz/)  
**Network:** Arbitrum Sepolia (Chain ID: 421614)  
**GitHub:** [github.com/0xTimberZx/TimbSwap](https://github.com/0xTimberZx/TimbSwap)  
**DebugHub:** [0xtimberzx.github.io/MyDapp/debughub](https://0xtimberzx.github.io/MyDapp/debughub/)  
**Litepaper:** [timbswap.xyz/litepaper](https://timbswap.xyz/litepaper/)

> **Status:** live on Arbitrum **Sepolia testnet** — all tokens are test assets with no
> monetary value. Unaudited; an independent audit is a gating condition for any mainnet launch.
> See [Roadmap](./ROADMAP.md) and the [Risks](https://timbswap.xyz/docs/#risks) section.

---

## The incentive engine

One inflow drives every module. Value moves in one direction, on a fixed cadence:

```
        ┌──────────────────────── the loop repeats every 6 rounds ───────────────────────┐
        │                                                                                 │
   ①  TRADE ───▶  ②  COLLECT ───▶  ③  REWARD ───────────────▶  ④  RETURN ────────────────┘
   swaps pay a     fees + yield      the epoch sweep refills, in fixed order:               players & LPs
   0.30% fee       on pooled         pot → farm → staking → boost                           come back;
   (0.25% LP /     capital feed      (each capped; boost gets only the remainder)           deeper pools,
    0.05% treas.)  the treasury      accrual halts at 99% of obligations                    more volume
```

- **Funded, never printed.** Emissions retarget to what the treasury actually collected; a
  **solvency stop** freezes accrual at 99% of outstanding obligations. The system cannot promise
  tokens it does not hold.
- **Fixed supply.** 100,000,000 TIMBS, hard-capped. No mint beyond it.
- **Prize-linked, not extractive.** The pot is paid from *yield on deposited capital* (the
  `TimbYieldVault`), so a player's principal stays theirs and refundable — closer to a
  prize-linked savings account than a lottery.

The "modules" below (swap, farm, staking, game, treasury, governance) are the parts of this one
machine — read them as gears, not a product menu.

---

## Contracts

| Contract | Address |
|----------|---------|
| TIMBSToken | `0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa` |
| TimbSwapFactory | `0xCCd6d3f0A86042d2B7056eDd381d367126628AF5` |
| TimbSwapRouter v8 | `0x40C7Caf90817C9891D278Ec1400B9deb180911f1` |
| EligibleTokenRegistry | `0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04` |
| GameRegistry (v5, dynamic pricing) | `0xBAb1CBaF0dE094322A49B379d0AC4510D1F78530` |
| TimbPrize (generations) | `0x35976f4D2260127848a6274D2eC89ee054412432` |
| TimbYieldVault | `0x43D833e828e2AF951527C2b573Eb70c358FfEB0B` |
| PrizeEscrow | `0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D` |
| TimbStaking | `0xe776c7b700B190ED8248741F9b518B08d8733C8F` |
| TimbFarm | `0xE319E2206F71A5cD8dd2c411C6F29712935f9011` |
| TimbBoostFarm | `0x551D919D517aBa40D2b3A57a91973ad5Ad3CBd35` |
| TimbLockVault | `0x0157086E7670D1eFb15DC6b5158eE78279927a41` |
| TimbTreasury v4 | `0xd3F40042aFA8074EA68C9f61dE6aDADD539F0D5c` |
| TimbGovernance | `0x8a324EfDc457BfB9Cf3D077E4CBC5A16a1c6a061` |
| TIMBS/ETH Pair | `0x5a911CBfD2808Ad5214E842a0E8ae34d8199BB95` |
| WETH (Arb Sepolia) | `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73` |
| USDC (Circle canonical, 6 dec) | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` |
| LINK (Chainlink canonical) | `0xb1D4538B4571d411F07960EF2838Ce337FE1E80E` |

All TimbSwap contracts verified on [Sourcify](https://repo.sourcify.dev/421614/). WETH and USDC are the canonical Arbitrum Sepolia testnet tokens.

---

## Testnet Faucets

Everything runs on **Arbitrum Sepolia (Chain ID 421614)**. Grab gas and stables before you swap, farm, or play.

**Gas — Arbitrum Sepolia ETH** *(pick up to 3; each has its own daily limit)*

- [Alchemy Faucet](https://www.alchemy.com/faucets/arbitrum-sepolia) — drips directly on Arbitrum Sepolia
- [QuickNode Faucet](https://faucet.quicknode.com/arbitrum/sepolia) — Arbitrum Sepolia ETH
- [Chainlink Faucet](https://faucets.chain.link/arbitrum-sepolia) — Arbitrum Sepolia (also bridges from Sepolia)

**Stablecoins** *(up to 2)*

- [Circle USDC Faucet](https://faucet.circle.com/) — select **Arbitrum Sepolia**; mints the exact canonical USDC (`0x75faf114…46AA4d`) TimbSwap trades
- [Aave Testnet Faucet](https://app.aave.com/faucet/) — switch to **Arbitrum Sepolia** for test USDC / DAI / USDT balances to experiment with

> Tip: if a faucet is dry, get Sepolia ETH first (e.g. the Chainlink or Alchemy Sepolia faucet) and bridge to Arbitrum Sepolia via the [Arbitrum Bridge](https://bridge.arbitrum.io/).

---

## The modules

Each is a gear in the engine above, not a standalone feature.

**AMM Swap** — Uniswap v2-style. 0.3% fee split 0.25% to LPs / 0.05% to treasury. Supports `addLiquidity`, `addLiquidityETH`, `removeLiquidity`, `removeLiquidityETH`.

**Prize Game** — Perpetual round-based game. Each round = 6 segments of 60 min (59 min 45 s open + 15 s settlement). Players hold a **ticket** — a 6-character string (A–Z, 0–9, no repeats) that plays the next round. Every eligible swap nudges the active segment's digit upward on a continuous meter; when a segment closes its digit locks and the next becomes active. After all 6 lock, an exact match wins the pot. Segments settle **permissionlessly** once the open window elapses (anyone can call `settleSegment`). Entry can be paid in ETH or TIMBS; **extra rounds** cost `entryCostTIMBS` each (up to 12, non-refundable). Ticket principal stays refundable for **4 rounds** after the ticket's last eligible round (and if you win near the end, the refund window starts *after* your claim window closes — up to LER+6) and, while active, earns yield via the **TimbYieldVault** that grows the pot. Winners claim their prize on a separate, shorter clock — **2 rounds from the match** — and a lapsed prize recycles into the pot without touching the winner's principal window. At each segment close the locked letter is the nudge counter **jittered with the settling block's hash**, so swaps influence the outcome but nobody can aim it. The registry is keyed by a **game generation**: when a new TimbPrize is deployed and `startGame` runs, the generation bumps and every prior-game ticket goes inert — its principal is recoverable any time via **Reclaim principal** on the compete page — so a redeploy never contaminates the new game and never needs a fresh registry again.

**SwapTables** — Pari-mutuel roulette on TIMBS play-chips, run live on stream. A table seats up
to 12 wallets; each loads six chips, one per segment, and places them across seven pools (six
segment pools plus the round-wide **Repeats a Digit**). The six characters lock one at a time —
the drumroll — and each pool pays its winners pro-rata as it locks. Rake is graduated (8% solo
down to 1.75% crowded, and **0% on an uncontested pool**), so the house earns most exactly when
tables are busy. Thin winning pools are topped up from the **UnderwriteReserve** toward
`stake × fair × 0.90`, funded by dead pots and half the rake — the rule being that more players
must never make any player's outcome worse. Unclaimed Repeats-a-Digit money rolls into a
cross-generation **DDJackpot** that pays a metered slice, stake-capped so a 5-chip bet cannot
drain what 1,000-chip bets built. Boards are immutable and redeployed per generation; the
SeedRegistry, SegmentCrank and DDJackpot span every generation. **Generation 7** is live.

**LP Farming** — Stake TIMBS/ETH LP tokens to earn TIMBS emissions.

**Single-Asset Staking** — Stake TIMBS to earn distributions from protocol buybacks.

**Lock Vault** — Lock any whitelisted ERC-20 for 24–320 hours. Public registry.

**Governance** — TIMBS holders deposit voting power to vote on protocol proposals. Hybrid on-chain voting, owner execution.

---

## Repo Structure

```
TimbSwap/                ← served at the site root (GitHub Pages, custom domain)
├── contracts/           ← 13 Solidity contracts (0.8.24, viaIR)
├── index.html           ← Landing page (site root: timbswap.xyz/)
├── style.css            ← global design system (all pages)
├── config.js            ← addresses + ethers helpers + autoReconnect (all pages)
├── landing.js           ← landing-page script
├── swap/                ← Swap + Add/Remove Liquidity      → /swap/
├── compete/             ← Prize entry + claimWinnings       → /compete/
├── farm/                ← LP farm + TIMBS staking           → /farm/
├── lock/                ← Lock vault + public registry      → /lock/
├── gov/                 ← Governance proposals + voting     → /gov/
├── analytics/           ← Live metrics + event history      → /analytics/
├── explore/             ← V2 Pools explorer                 → /explore/
├── docs/                ← User-facing documentation page    → /docs/
├── tables/              ← SwapTables: console, felt, watch, lobby → /tables/
│   ├── index.html       ←   operator console (open / arm / reveal / retire)
│   ├── play.html        ←   the felt — sit, load, place
│   ├── live.html        ←   the stream page (spectate, no wallet)
│   └── games.html       ←   every running table, read-only
├── CNAME                ← Custom domain (timbswap.xyz) for GitHub Pages
├── dev-docs/            ← Internal design specs (not the /docs/ web page)
├── scripts/
│   ├── settler.js       ← Automated segment settler
│   └── package.json
├── .github/workflows/
│   └── settler.yml      ← GitHub Actions cron (10 min + daily health)
├── abi/                 ← hand-kept contract ABIs (for integrators)
├── SPECS.md             ← Full technical specs + addresses
├── ROADMAP.md           ← Shipped / next / vision + the mainnet graduation gate
├── CLAUDE.md            ← Agent rules for Claude Code
└── foundry.toml
```

---

## Settler

Segments settle automatically via GitHub Actions every 10 minutes. Health check fires daily at noon UTC. Telegram notifications on success and failure.

**Required secrets** (repo → Settings → Secrets → Actions):

| Secret | Value |
|--------|-------|
| `ARB_SEPOLIA_RPC` | Arbitrum Sepolia RPC URL |
| `SETTLER_PRIVATE_KEY` | Deployer wallet private key |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |
| `TELEGRAM_CHAT_ID_PUBLIC` | (Optional) Community group chat ID — receives only confirmed round-rollover announcements |
| `X_API_KEY` / `X_API_SECRET` | (Optional) X app consumer keys — enables auto-posting settled rounds to @timbswap |
| `X_ACCESS_TOKEN` / `X_ACCESS_TOKEN_SECRET` | (Optional) X account tokens (must be Read and Write) |

Manual trigger: Actions → TimbSwap Settler → Run workflow → choose `settle` or `health`.

X posting (repo **Variables**, not secrets — these are public):

| Variable | Value |
|----------|-------|
| `X_POST_MODE` | `all` (default), `winners` (only rounds that paid out), or `off` |
| `X_HASHTAGS` | (Optional) trailing hashtag line, e.g. `TimbSwap Arbitrum DeFi Markets DApp Testnet`. Space/comma separated (`#` added if missing); several `\|`-separated groups rotate by round number so posts aren't identical. Trimmed to fit X's 280-char limit. Unset ⇒ no hashtags |
| `X_HASHTAGS_WINNER` | (Optional) hashtag line for winner posts only; falls back to `X_HASHTAGS` when unset |

---

## Development

```bash
# Install
forge install OpenZeppelin/openzeppelin-contracts
forge install foundry-rs/forge-std

# Build
forge build

# Test
forge test -vvvv

# Deploy
cp env.example .env   # fill in values
forge script scripts/Deploy.s.sol \
  --rpc-url $ARB_SEPOLIA_RPC \
  --broadcast --verify --verifier sourcify
```

**Compiler:** Solidity 0.8.24, viaIR, optimizer 200 runs, EVM paris.  
**Remix:** Enable viaIR in Advanced Configurations before compiling Router or TimbPrize.

---

## Tokenomics

- **Hard cap:** 100,000,000 TIMBS
- **Effective supply:** ~99,500,000 TIMBS *(500k at unreachable phantom pair address — permanent burn)*
- **Entry cost:** paid in ETH (`entryCostETH`) or TIMBS (`entryCostTIMBS`), both governance-adjustable
- **Extra rounds:** `entryCostTIMBS` each, up to 12 per ticket, non-refundable
- **Buyback:** 50% burned, 50% to stakers
- **Protocol fee:** 0.05% of swap volume → TimbTreasury

---

## Ecosystem

Part of the 0xTimberZx ecosystem alongside BlockpotDAO, MessageBoard, and 0xFaucet.  
All four share the [DebugHub](https://0xtimberzx.github.io/MyDapp/debughub/) dashboard. 

---

## License

TimbSwap is **source-available** under the [Business Source License 1.1](./LICENSE).
You may read, audit, fork, and use the code for **non-production** purposes
(development, testing, research, security review). Production and commercial use
is not granted until the **Change Date (2029-07-25)**, on which the license
automatically converts to **MIT**.

The **TimbSwap** name, logo, and branding are trademarks of the project and are
**not** licensed — you may fork the code, but may not present a deployment as
"TimbSwap".
