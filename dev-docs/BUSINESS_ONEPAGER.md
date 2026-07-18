# TimbSwap — Business Brief

*One page. Plain terms. Testnet live; seeking seed capital for a mainnet launch.*

---

### The concept

TimbSwap is a **decentralized exchange with a prize-linked reward layer.** Traders swap
tokens (the exchange); a portion of activity and idle-capital *yield* funds a recurring
on-chain prize pot that active users compete for.

The closest traditional analogue is a **prize-linked savings account** — UK Premium Bonds,
or US "Save-to-Win" credit-union programs. Prizes are paid from **yield earned on capital**,
not from new deposits. This is the single most important design decision: **it is structurally
not a Ponzi.** No participant is paid with another's principal.

### Why it lasts (perpetuity)

A self-reinforcing loop that, once seeded, runs unattended:

> **Swaps generate fees → fees + deposit yield fund the prize pot → the pot attracts players →
> players swap and provide liquidity → more fees.**

Durability is enforced in code, not promised in a whitepaper:

- **Hard-capped token.** 100,000,000 TIMBS maximum. No discretionary minting.
- **Emissions cannot exceed reserves.** Rewards self-retarget to whatever the treasury has
  actually collected, and a **solvency stop halts all accrual at 99% of obligations.** The
  system mathematically cannot promise tokens it does not hold.
- **Autonomous operation.** An on-chain keeper runs the reward cycle every 6 rounds with no
  human in the loop — the flywheel turns without a standing team.

### Risk & controls

| Vector | Control in place |
|---|---|
| **Over-emission / inflation** | Hard cap + self-retargeting rate + 99% solvency ledger. Rewards are funded, never printed. |
| **Smart-contract failure** | Testnet-hardened, permissionless recovery/refund paths, live telemetry (every action logged and auditable). |
| **Custody** | Non-custodial. Users hold their own keys; the protocol never takes discretionary control of funds. |
| **Legal / regulatory** | The prize mechanic rewards *activity and skill* (you influence outcomes by trading), funded by yield — the prize-linked-savings precedent. **This is the open item: formal counsel and likely jurisdiction geofencing are required before any real-value launch.** We treat this as a gating condition, not an afterthought. |

### Capital: controls vs. incentives

- **Controls** — Prize funds sit in an on-chain escrow with **publicly visible backing.** Only
  the rule-bound keeper moves reward capital, in a fixed priority order (core rewards funded
  before speculative). Seeding is owner-gated; claim and refund windows are enforced by contract.
- **Incentives** — Emissions reward exactly the behaviors that grow the protocol: trading,
  providing liquidity, staking, and playing. Generous enough to bootstrap a community, but
  hard-capped and solvency-gated so incentives **cannot outrun the capital backing them.**

### Where we are

- **Live and running on Arbitrum testnet.** Full loop working end-to-end: exchange, prize
  rounds, staking, farming, and boosted-liquidity rewards.
- **~20+ prize rounds have settled autonomously**, keeper proven in production.
- **Community-building phase:** growing an active player base on testnet — real usage, at zero
  monetary risk to participants — to prove *engagement* before real capital is deployed.

### The ask — seed for mainnet

Testnet proves the machine *works*. Mainnet is where it earns. We are raising seed capital to:

1. **Fund the initial mainnet prize pot** (the subsidy that makes early rounds worth playing
   before organic fees + yield carry it), and
2. **Cover the graduation runway** — audit, legal counsel, and deployment.

**Graduation gate (testnet → mainnet):** we deploy to mainnet when we have sustained
**[N] active wallets** across **[M] settled rounds** with **[repeat-play %]** returning and
eligible swap volume tracking round activity — i.e., proof of *pull*, not just function.

> *Seed budget:* **[$ amount]** → initial pot **[$X]** + audit **[$Y]** + legal **[$Z]** +
> runway **[months]**. *(To be finalized from live engagement data.)*

---

*Bracketed figures are placeholders to be filled from live on-chain metrics. This brief
describes a software project and is not an offer of securities or investment, nor legal advice;
the regulatory item above requires qualified counsel before any real-value deployment.*
