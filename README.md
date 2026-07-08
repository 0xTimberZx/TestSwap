# TimbSwap

A full-stack DeFi protocol on Arbitrum Sepolia — AMM DEX, prize game, LP farming, single-asset staking, token locking, and on-chain governance, all centered around the native TIMBS token.

**Live:** [0xtimberzx.github.io/TimbSwap](https://0xtimberzx.github.io/TimbSwap/)  
**Network:** Arbitrum Sepolia (Chain ID: 421614)  
**GitHub:** [github.com/0xTimberZx/TimbSwap](https://github.com/0xTimberZx/TimbSwap)  
**DebugHub:** [0xtimberzx.github.io/MyDapp/debughub](https://0xtimberzx.github.io/MyDapp/debughub/)

---

## Contracts

| Contract | Address |
|----------|---------|
| TIMBSToken | `0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa` |
| TimbSwapFactory | `0xCCd6d3f0A86042d2B7056eDd381d367126628AF5` |
| TimbSwapRouter v7 | `0xF554063223ECE3acC4f9664227Ba1E7a88c54e09` |
| EligibleTokenRegistry | `0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04` |
| GameRegistry v2 | `0xee2c3b12e8dED226a6AE8e950e5B6C67eF4CB774` |
| TimbPrize v3.2 | `0xc3fB39E0da3312c7f95bD7aD511ac76C4B86eE40` |
| TimbYieldVault | `0x619374B3BfB8E0B23406033e56cF2fCcb36FE57F` |
| PrizeEscrow | `0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D` |
| TimbStaking | `0xe776c7b700B190ED8248741F9b518B08d8733C8F` |
| TimbFarm | `0xE319E2206F71A5cD8dd2c411C6F29712935f9011` |
| TimbLockVault | `0x0157086E7670D1eFb15DC6b5158eE78279927a41` |
| TimbTreasury | `0x486Fa4D8351EF81136E83340eA1e3aa2272c9955` |
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

## Features

**AMM Swap** — Uniswap v2-style. 0.3% fee split 0.25% to LPs / 0.05% to treasury. Supports `addLiquidity`, `addLiquidityETH`, `removeLiquidity`, `removeLiquidityETH`.

**Prize Game** — Perpetual round-based game. Each round = 6 segments of 60 min (59 min 45 s open + 15 s settlement). Players hold a **ticket** — a 6-character string (A–Z, 0–9, no repeats) that plays the next round. Every eligible swap nudges the active segment's digit upward on a continuous meter; when a segment closes its digit locks and the next becomes active. After all 6 lock, an exact match wins the pot. Segments settle **permissionlessly** once the open window elapses (anyone can call `settleSegment`). Entry can be paid in ETH or TIMBS; **extra rounds** cost `entryCostTIMBS` each (up to 12, non-refundable). Ticket principal stays refundable within a 2-round claim window and, while active, earns yield via the **TimbYieldVault** that grows the pot.

**LP Farming** — Stake TIMBS/ETH LP tokens to earn TIMBS emissions.

**Single-Asset Staking** — Stake TIMBS to earn distributions from protocol buybacks.

**Lock Vault** — Lock any whitelisted ERC-20 for 24–320 hours. Public registry.

**Governance** — TIMBS holders deposit voting power to vote on protocol proposals. Hybrid on-chain voting, owner execution.

---

## Repo Structure

```
TimbSwap/
├── contracts/           ← 13 Solidity contracts (0.8.24, viaIR)
├── frontend/
│   ├── style.css        ← global design system
│   ├── config.js        ← addresses + ethers helpers + autoReconnect
│   ├── swap/            ← Swap + Add/Remove Liquidity
│   ├── compete/         ← Prize entry + claimWinnings
│   ├── farm/            ← LP farm + TIMBS staking
│   ├── lock/            ← Lock vault + public registry
│   ├── gov/             ← Governance proposals + voting
│   └── analytics/       ← Live metrics + event history
├── scripts/
│   ├── settler.js       ← Automated segment settler
│   └── package.json
├── .github/workflows/
│   └── settler.yml      ← GitHub Actions cron (10 min + daily health)
├── index.html           ← Landing page (GitHub Pages root)
├── style.css            ← Root copy for landing page
├── config.js            ← Root copy for landing page
├── SPECS.md             ← Full technical specs + addresses
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

Manual trigger: Actions → TimbSwap Settler → Run workflow → choose `settle` or `health`.

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
