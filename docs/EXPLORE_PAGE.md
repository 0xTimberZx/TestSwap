# Explore page — planned scope

The "Explore" nav tab currently points at the landing page as a placeholder.
This note captures the intended scope so it isn't lost; repoint the nav link
(desktop `.nav-links` + mobile `#mobile-nav` on all 5 pages) once the page
exists.

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
