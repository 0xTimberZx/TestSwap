# Explore page

**Status: built (first cut).** Lives at `frontend/explore/` (index.html +
explore.js + explore.css). The nav "Explore" link (desktop `.nav-links` +
mobile `#mobile-nav`) is repointed to `../explore/` on all six pages.

## Shipped in the first cut

- **Overview** — Total Liquidity (USD, summed across pools using best-effort
  pricing), pool count, and trade count over the last 50,000 blocks (~7d).
- **Pools** — every factory pair with reserves, USD TVL, and a link out to the
  pair on Arbiscan. Sorted by TVL.
- **Recent Trades** — `Swap` events across all pools (block, pair, in→out, trader).
- **Recent Liquidity** — `Mint`/`Burn` events across all pools (add/remove,
  pair, amounts, provider).
- **Search** — one box filters pools + both activity tables live (token symbol,
  `SYM0/SYM1`, or an address), no re-fetch.

Zero-infra: all data is read client-side from the public RPC (factory pair
enumeration + reserves + event scanning over `BLOCK_RANGE = 50,000`). Fully
public — no wallet needed and no game state on this surface. Polls refresh only
while the tab is visible.

USD pricing is best-effort: WETH via the USDC/WETH pool, stables at $1, TIMBS
via TIMBS/WETH; a constant-product pool's TVL is twice its priced side, so any
pool touching a priced asset gets a TVL. Two-unknown-token pools show reserves
but no USD.

## Deferred (needs an indexer/subgraph or a small backend)

- **Per-day history charts** (volume/fees/TVL over time) — event scanning gives
  a bounded snapshot, not retained time series.
- **Cumulative volume/fees** beyond the block window.

## Purpose

An exchange-info / analytics page ("Explore / Pool Search / Exchange Info")
with **simple trading and pool activity recorded throughout** — in the spirit
of a DEX info page (overview stats, pairs, tokens) but scoped to TimbSwap.

## Intended contents (first cut)

- **Overview stats** — TVL/liquidity, volume, fees; per-day history charts.
- **Pool activity** — recent adds/removes of liquidity per pair
  (`addLiquidity`/`removeLiquidity` events from `TimbSwapRouter`/pairs).
- **Trade activity** — recent swaps per pair (router swap events), with
  amounts, pair, and time.
- **Pool search** — find a pair/token, see its reserves, volume, and recent
  activity.

## Open decisions (owner: Timber)

- **Retention** — how much history to keep and for how long is TBD by Timber
  ("I'll determine the length and time of what to keep in the future").
- **Name** — currently "Explore"; alternatives considered: "Exchange Info",
  "Pools".
- **Data source** — client-side event scanning via the read RPC is the
  zero-infra option (bounded lookback, e.g. last N blocks); anything longer
  needs an indexer/subgraph or a tiny backend.

## Notes

- Wallet-gating: overview stats can stay public, but follow the site rule that
  **game state is wallet-gated** — no prize/scroll detail on this page without
  a connected wallet.
- The nav placeholder was added in the same commit that pointed Airdrop at the
  landing page; search for `>Explore<` to find all link sites when repointing.
