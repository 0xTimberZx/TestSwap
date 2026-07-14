# TimbSwap — Content / TODO

Marketing content backlog and ready-to-post assets. Not code — safe to move or trim.

---

## Onboarding card series (testnet how-to)

Five cards, TimbSwap dark/green brand style, rendered at **2400×1350 (16:9)**.
All logos that could be rebuilt as clean vectors are baked in; the rest are drop-in slots.

| # | Card | Shows | Logo status |
|---|------|-------|-------------|
| 1 | **Get Testnet ETH** | QuickNode + Alchemy faucets · Arb Sepolia · chainId 421614 | ✅ QuickNode + Alchemy vector marks |
| 2 | **Get Tokens to Swap** | USDC (faucet.circle.com) + LINK (faucets.chain.link) · decimals · use | ✅ USDC + LINK vector marks |
| 3 | **Pick a Wallet** | MetaMask · Rabby · OKX · Brave (all custom-network capable) | ✅ OKX vector · ⬜ MetaMask/Rabby/Brave = drop-in slots |
| 4 | **Mainnet vs Testnet** | Side-by-side; testnet marked "you are here"; 42161 vs 421614 | ✅ no logos |
| 5 | **Connect to Arbitrum Sepolia** | Network name · chainId 421614 · ETH · RPC · explorer · "prize game live on-chain" | ✅ no logos |

### Open to-dos before posting
- [ ] Card 3: drop real **MetaMask / Rabby / Brave** logos over the M/R/B slots (use the **plain MetaMask fox**, not the "10" anniversary version).
- [ ] **Verify every faucet URL + current requirements** (mainnet-balance gates, login, drip amounts drift often).
- [ ] Optional: cut **square 1080×1080** versions for feed/IG.
- [ ] Optional: swap the gas-pump emoji on card 4 for a mono glyph (consistency with the other icons).

### Network params (source: config.js — keep in sync)
- Network name: **Arbitrum Sepolia**
- Chain ID: **421614**
- Currency: **ETH**
- RPC URL: **https://sepolia-rollup.arbitrum.io/rpc**
- Explorer: **https://sepolia.arbiscan.io**
- Canonical USDC (6 dp): `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (Circle)
- Canonical LINK (18 dp): `0xb1D4538B4571d411F07960EF2838Ce337FE1E80E` (Chainlink)

---

## Thread structure — "New to testnet? Play TimbSwap in 5 steps 🧵"

Order follows the real new-user path. One card per tweet.

1. **Mainnet vs Testnet** —
   > First, the basics: testnet is a free, zero-risk copy of the network. Play tokens, free gas, nothing to lose. That's where TimbSwap's prize game lives.

2. **Pick a Wallet** —
   > You need an EVM wallet that supports custom networks. Any of these work — MetaMask, Rabby, OKX, Brave.

3. **Connect to Arbitrum Sepolia** —
   > Point your wallet at Arbitrum Sepolia (chainId 421614). Connect at timbswap.xyz and it's added in one tap.

4. **Get Testnet ETH** —
   > Grab free gas from a faucet — QuickNode or Alchemy. This pays for your transactions.

5. **Get Tokens to Swap** —
   > Want to trade too? Claim testnet USDC (Circle) and LINK (Chainlink). Then swap, pool, and play.

**CTA (final tweet):**
> That's it — you're on-chain. Go match the meter 👉 timbswap.xyz/compete

---

## Other queued content (not yet built)

- **Prize Scroll Weekend** launch post + supporting thread (game-only framing; no pot-value talk until ~10–14 days in). Copy drafted — revisit when timing's right.
- **GM city series** — reusable card (LONDON built; PARIS/TOKYO/BERLIN/DUBAI fit the 6 hexes; NYC → shorten).
- Founder "what shipped this week" recurring post format (drawn from real commits).
- Campaign framework: Prize Scroll Weekend · Bug Hunter Week · LP Challenge · Build-With-Me Fridays.
