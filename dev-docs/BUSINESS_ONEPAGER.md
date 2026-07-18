# TimbSwap — Business Brief

*One page. Plain terms. Testnet live; seeking seed capital for a mainnet launch.*

---

### The concept

TimbSwap is a **decentralized exchange with a prize-linked reward layer.** Traders swap
tokens (the exchange); a portion of activity and idle-capital *yield* funds a recurring
on-chain prize pot that active traders compete for.

The closest traditional analogue is a **prize-linked savings account** — UK Premium Bonds,
or US "Save-to-Win" credit-union programs. Prizes are paid from **yield earned on capital**,
not from new deposits. This is the single most important design decision: **it is structurally
not a Ponzi.** No participant is paid with another's principal. The token has a **fixed total
supply.**

### The game

Each round hides a **six-character combination** — think of it as a safe. Players don't buy
tickets; they **earn a turn at the dials by trading.** Every eligible swap works the
combination, and when a round settles, anyone whose combination matches the drawn one **cracks
the safe and splits that round's pot.** Showing up and playing is the price of a shot — getting
picked is like earning a spot on the roster, then being drafted into the winners at settlement.

### The redistribution cycle

The protocol doesn't accumulate value for insiders — it **recirculates.**

> **Comes in:** trading fees + yield on pooled capital →
> **held briefly:** collected by the treasury (backing visible on-chain) →
> **goes back out:** winners split the pot, and the same sweep funds emissions to the people
> who build the market — **liquidity providers, stakers, and boosted pools.**

The sweep runs **every six rounds, in a fixed priority order**, then restarts. Earnings in,
earnings back out.

### Barriers — the house vs. the player

**On the game's side** (why it can't over-extend):
- The pot is funded by **yield, never new deposits** — the safe only holds what's been earned.
- A **solvency stop** halts payouts at 99% of what's owed; it never writes a check it can't cash.
- Emissions **retarget to real revenue** — no printing to cover a shortfall.
- **Fixed total supply: 100,000,000 tokens**, with no mint beyond it.
- Core rewards are funded **before** speculative ones.

**On the player's side** (why a win is earned, not handed out):
- **Skin in to sit at the table** — hold the token or provide liquidity to play.
- **One dial per wallet** each round — no one buys the whole board.
- Only **active trades** work the dials; passive holders don't get drafted.
- Winners **claim inside a window** — collect, or the prize rolls back into the pot.

### Risk & the open item

Custody is **non-custodial**; contracts are testnet-hardened with permissionless refund/recovery
paths and full audit telemetry; the barriers above make over-emission and dilution structurally
impossible. **The one open item is legal/regulatory:** the yield-funded prize sits on the
prize-linked-savings precedent, but classification is jurisdiction-specific — so **formal counsel
and likely geofencing are treated as conditions to clear before mainnet, not afterthoughts.**

### Where we are

- **Live on Arbitrum testnet** — full loop working end-to-end: exchange, prize rounds, staking,
  farming, boosted-liquidity rewards.
- **~20+ prize rounds have settled autonomously**; the keeper is proven in production.
- **Community-building phase:** growing an active player base at zero monetary risk, to prove
  *engagement* before real capital is deployed.

### The ask — seed for mainnet

Testnet proves the machine *works*. Mainnet is where it earns. Seed capital covers:

1. **The initial mainnet prize pot** — the subsidy that makes early rounds worth playing before
   organic fees + yield carry it, and
2. **The graduation runway** — audit, legal counsel, deployment.

**Graduation gate (testnet → mainnet):** deploy when we have sustained **[N] active wallets**
across **[M] settled rounds** with **[repeat-play %]** returning and eligible trade volume that
tracks round activity — proof of *pull*, not just function.

> *Seed budget:* initial pot **[$X]** + audit **[$Y]** + legal **[$Z]** = **[$ total]**,
> plus **[months]** runway. *(To be finalized from live engagement data.)*

---

*Bracketed figures are placeholders to be filled from live on-chain metrics. This brief
describes a software project and is not an offer of securities or investment, nor legal advice;
the regulatory item above requires qualified counsel before any real-value deployment.*
