# Scenario C — TIMBS as the hub / routing token

Status: **DRAFT for decision** — no code written. Depends on nothing; independent of PR #55, but
PR #55's #2 (swap-weighted nudges) is forward-compatible and partly absorbed here.
Primary target: `contracts/TimbSwapRouter.sol` (swap core rewrite). Optionally
`contracts/TimbSwapFactory.sol` (only if hard enforcement).

---

## 1. Goal

Make **TIMBS the base pair of the whole DEX**: every cross-token swap routes `A → TIMBS → B`
instead of a direct `A/B` pool (the role WETH normally plays on a v2 DEX). Every trade then
consumes TIMBS as its medium, so TIMBS volume = total platform volume, and the fee/burn loop is
fed by *all* trading, automatically.

## 2. Where we are today (verified)

- The Router is **single-hop only**: `swapExactTokensForTokens` → `_executeSwap(tokenIn, tokenOut,
  …)` → one `_swapOnPair` against the `A/B` pair (`TimbSwapRouter.sol:330, :289, :275`).
- The Factory creates **arbitrary pairs** (`createPair` is unguarded, `:153`). So any `A/B` pool
  can exist and be traded directly.
- Nudges fire once per eligible swap via `_maybeNudge(tokenIn, …)` (`:253`). With PR #55 a swap is
  worth `swapNudgeWeight` meter units.

So today TIMBS is just one token among many; nothing forces trades through it.

## 3. Enforcement model — the core decision

### 3a. Router-soft (RECOMMENDED)
Direct `A/B` pairs may still exist, but the **Router always routes via TIMBS when a TIMBS path
exists**, falling back to a direct pair only when one leg has no TIMBS pool.

- Policy for a swap `A → B`:
  1. If `A == TIMBS` or `B == TIMBS` → single hop (already a TIMBS pair). Nudge on the TIMBS leg.
  2. Else if both `A/TIMBS` and `TIMBS/B` pools exist → route `A → TIMBS → B` (two hops).
  3. Else if a direct `A/B` pool exists → single hop, no TIMBS involvement (no nudge).
  4. Else → revert `PairNotFound`.
- **Reversible** (it's just Router logic — swap it back by redeploying the Router), lets you
  measure the double-fee UX cost before committing, and never bricks a token that lacks a TIMBS
  pair. Downside: a determined user can call `pair.swap()` directly to bypass routing (pairs
  aren't router-gated), so it's a strong default, not an absolute mandate.

### 3b. Factory-hard
Factory only permits `token/TIMBS` pairs (`createPair` reverts unless one side is TIMBS).

- Guarantees the hub; no direct `A/B` pools can exist.
- **Rigid and near-irreversible** (existing non-TIMBS pairs would be stranded), and it's a Factory
  redeploy on top of the Router. Recommend **only after** Router-soft has proven the model.

**Recommendation: ship Router-soft first.** Treat Factory-hard as a later hardening step.

## 4. Router implementation (soft routing)

New internal routing + multi-hop execution. Sketch:

```solidity
// Returns the hop path: [A, TIMBS, B], [A, B] (direct), or reverts.
function _route(address tokenIn, address tokenOut) internal view returns (address[] memory path);

// Execute N-1 hops over `path`, collecting the protocol fee on each hop's input and
// nudging once on the TIMBS leg. amountOutMin checked against the FINAL output only.
function _swapPath(address[] memory path, uint256 amountIn, uint256 amountOutMin,
                   address to, bool influencePrize) internal returns (uint256 amountOut);
```

Changes to the public entry points (`swapExactTokensForTokens`, `swapExactETHForTokens`,
`swapExactTokensForETH`, `swapTokensForExactTokens`):
- Replace the single `_executeSwap` call with `_route` + `_swapPath`.
- **Fee per hop:** `_collectProtocolFee` runs on each hop's input token (so a 2-hop trade pays the
  0.05% twice — once on A, once on the intermediate TIMBS). Explicit and intended (it's the point).
- **Nudge once per swap** on the TIMBS leg: in a 2-hop `A→TIMBS→B`, the `TIMBS→B` hop has
  `tokenIn == TIMBS`; nudge there (subject to the existing settlement-window skip). Keep
  `swapNudgeWeight` from PR #55 — a hub swap is worth the same weight, now triggered by real
  cross-trades. (This is why #2 is forward-compatible and largely **absorbed**: "eligible swap
  nudges" becomes "the TIMBS leg nudges".)
- **Slippage:** `amountOutMin` guards the final `B` amount. The intermediate TIMBS amount is
  derived via `getAmountOut` on hop 1 and fed into hop 2. Price impact compounds across both hops —
  document it in the UI quote.
- **ETH paths:** `ETH → WETH → TIMBS → B` and `A → TIMBS → WETH → ETH`. WETH wrap/unwrap stays at
  the ends; TIMBS sits in the middle. If `WETH == one endpoint` and TIMBS is the other, it's a
  single hop (the existing TIMBS/WETH pool).
- **Gas:** ~2× a direct swap (two pair calls, two fee transfers, one nudge loop). Acceptable on
  Arbitrum; note it in the quote.

No TimbPrize change. The Router still needs the same pointers; nudge authorisation is unchanged.

## 5. Worked cost example (why users pay more)

Swap `USDC → DAI`, both with TIMBS pools, hub-routed `USDC → TIMBS → DAI`:

| Component | Direct USDC/DAI | Hub USDC→TIMBS→DAI |
|-----------|-----------------|--------------------|
| LP fee (0.3%/hop) | 0.30% | ~0.60% |
| Protocol fee (0.05%/hop) | 0.05% | ~0.10% |
| Price impact | 1× pool | 2× (compounds) |
| Exposure to TIMBS volatility | none | full (mid-trade) |

Net: a hub cross-trade costs roughly **2× the fees + compounded slippage** vs a direct pool. In a
closed testnet ecosystem that's fine; against competing routers it's a real disadvantage — which is
exactly why hub tokens are normally *stable* (WETH/USDC), not a volatile game token.

## 6. Volatility bleed

Because TIMBS is a **gameable, speculative** token, its price noise sits inside every `A→B` trade.
A TIMBS pump/dump mid-trade distorts the effective `A/B` rate and widens slippage. This is the
single biggest reason to think twice: you'd be coupling every unrelated trade to the token whose
price you're deliberately letting a bot-driven meter game move around.

Mitigations if pursued: keep TIMBS pools **deep** (so single trades move TIMBS price little), and/or
only hub-route pairs where neither side is itself a stable (route stables directly to avoid taxing
stable↔stable flow with TIMBS volatility).

## 7. MEV

Two hops = two sandwich opportunities per trade, and the thin/volatile TIMBS leg is the juicy one.
Hub routing makes this a **permanent, structural** surface on every cross-trade (vs today, where
MEV is only a meter-gaming concern). Deep TIMBS liquidity and tight `amountOutMin` are the only
real defenses at the AMM layer.

## 8. Liquidity bootstrap burden

Every listed token needs a **deep TIMBS pair** or hub routing is unusable (huge slippage). You
can't lean on external `A/B` liquidity. Practically: seed `token/TIMBS` for each supported token
before enabling hub routing for it, and gate routing on a minimum-reserve check so a shallow TIMBS
pool falls back to direct rather than delivering a terrible quote.

## 9. Interaction with #1 / #2 (PR #55)

- **#2 is absorbed:** with all volume through TIMBS, "weight swap-nudges" simply becomes "the TIMBS
  leg nudges." PR #55's weighting still applies; nothing is wasted.
- **#1 still stands:** hub routing doesn't stop a bot landing the final nudge, so the per-address
  free-nudge cap remains the anti-dominance lever.

## 10. Migration / redeploy

- **Router-soft:** Router redeploy only — same rewire as PR #55
  (`TimbPrize.setRouter`, `Factory.setRouter`, `config.js`, cache bump). Reversible.
- **Factory-hard (later):** additionally a Factory redeploy + repointing; strands non-TIMBS pairs.
- Frontend: the swap quote must show the route (`A → TIMBS → B`), the compounded slippage, and the
  doubled fee. The analytics "recent swaps" already reads pair events — it would show two legs per
  cross-trade.

## 11. Open decisions
1. **Enforce Router-soft or Factory-hard?** (Rec: soft first.)
2. **Best-execution or force-TIMBS?** Soft can either always prefer TIMBS (forces volume, may cost
   users) or pick the cheaper of direct vs hub (best-ex, but defeats the purpose). Rec: **prefer
   TIMBS whenever a TIMBS path exists**, with a min-reserve fallback to direct.
3. **Exempt stable↔stable** from hub routing to avoid taxing stable flow with TIMBS volatility?
4. **Minimum TIMBS-pool reserve** to qualify a token for hub routing (anti-bad-quote).

## 12. Recommendation

Ship **PR #55 (#1+#2)** first and watch what #2 alone does to swap volume and fees. If the fee/burn
loop still needs more fuel, implement **Scenario C Router-soft** with "prefer TIMBS + min-reserve
fallback" and (probably) a **stable↔stable exemption**, keeping direct pairs alive so it's
reversible. Only consider Factory-hard once the double-fee UX cost has been measured and accepted.
