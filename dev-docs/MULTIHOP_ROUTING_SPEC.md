# Multi-hop routing spec — `TimbSwapRouter`

> **STATUS: IMPLEMENTED** (contract + frontend). Awaiting router redeploy +
> re-authorization + ADDRESSES update — see dev-docs/ROUTER_REDEPLOY_CHECKLIST.md.

**Goal:** let a user swap `X → Y` when no direct `X/Y` pair exists, by hopping
through a bridge asset (`X → WETH → Y`). Today the router is single-hop only:
every swap function resolves exactly one pair via `_getPair(tokenIn, tokenOut)`
and reverts `PairNotFound` if that pair doesn't exist. USDT→TIMBS therefore
needs either a dedicated USDT/TIMBS pool or two manual swaps through WETH.

This spec adds **path-based** swaps while leaving the existing single-hop
functions untouched (frontend keeps using them for direct pairs — they're
cheaper).

---

## 0. Why this is safe to add

The pair already supports chained hops with **zero pair-contract changes**.
`TimbSwapPair.swap(amount0Out, amount1Out, to)`:

- derives the input amount from **balance delta** (`balance − (reserve − out)`),
  not from a parameter, and
- enforces the **K invariant** after moving output out.

So the Uniswap-V2 pattern works as-is: transfer the user's input into pair #1,
then have pair #1 send its output **directly into pair #2** (`to = pair2`), then
call pair #2's swap sending the final output to the user. Each pair validates
its own leg independently. (Verified: `TimbSwapPair.sol:377–406`,
`TimbSwapRouter._executeSwap` at `:287` already relies on transfer-then-swap.)

---

## 1. Design choice — recommended: generalized `path[]`

Two options were considered:

| | A. Hardcoded WETH bridge | **B. Generalized `path[]` (recommended)** |
|---|---|---|
| Signature | `...ThroughWeth(amountIn, min, tokenIn, tokenOut, …)` | `...(amountIn, min, address[] path, …)` |
| Hops | exactly 2, always via WETH | 1..MAX_HOPS, any route the frontend picks |
| Future routes | WETH only | also USDT→USDC→…, TIMBS hub, etc. |
| Code | slightly less | a small loop; industry standard |
| Frontend | must special-case WETH | picks best of {direct, via-WETH, via-USDC} |

**Recommendation: Option B.** It's the Uniswap-V2 shape, isn't meaningfully
more code, and future-proofs beyond WETH (stable-to-stable bridging, a TIMBS
hub). The frontend builds the `path` array and the router just executes it.
Option A is a fine minimal fallback if we want to cap scope — the spec below is
written for B, with the 2-hop case being the common instance of it.

---

## 2. New external functions

```solidity
// Exact-in multi-hop. path[0] = tokenIn, path[last] = tokenOut.
function swapExactTokensForTokensPath(
    uint256 amountIn,
    uint256 amountOutMin,
    address[] calldata path,
    address to,
    uint256 deadline,
    bool    influencePrize
) external nonReentrant whenNotPaused ensure(deadline) returns (uint256 amountOut);

// Exact-out multi-hop.
function swapTokensForExactTokensPath(
    uint256 amountOut,
    uint256 amountInMax,
    address[] calldata path,
    address to,
    uint256 deadline,
    bool    influencePrize
) external nonReentrant whenNotPaused ensure(deadline) returns (uint256 amountIn);

// View: amounts along a path (frontend quote + amountOutMin sizing).
function getAmountsOutPath(uint256 amountIn, address[] calldata path)
    external view returns (uint256[] memory amounts);
function getAmountsInPath(uint256 amountOut, address[] calldata path)
    external view returns (uint256[] memory amounts);
```

ETH-legged multi-hop (native in/out) is **out of scope for v1** — the frontend
already wraps/unwraps around a token path, so ETH→X→Y is "wrap to WETH, then
`swapExactTokensForTokensPath([WETH, X, Y])`". If we want it in-contract later,
add `swapExactETHForTokensPath` / `swapExactTokensForETHPath` mirroring the
existing ETH single-hop functions.

---

## 3. New constant + error

```solidity
uint256 public constant MAX_HOPS = 3;          // path.length ≤ 4 addresses
error InvalidPath();                            // len<2, len>MAX_HOPS+1, or dup/zero
```

`MAX_HOPS = 3` bounds gas (each hop is a `getReserves` + a `swap`) and covers
every realistic route (X→WETH→Y is 2). Bump later if needed.

---

## 4. Internal quote loop

```solidity
function _getAmountsOut(uint256 amountIn, address[] calldata path)
    internal view returns (uint256[] memory amounts)
{
    uint256 n = path.length;
    if (n < 2 || n > MAX_HOPS + 1) revert InvalidPath();
    amounts = new uint256[](n);
    amounts[0] = amountIn;
    for (uint256 i = 0; i < n - 1; i++) {
        if (path[i] == address(0) || path[i] == path[i + 1]) revert InvalidPath();
        (uint256 rIn, uint256 rOut) =
            _getReserves(_getPair(path[i], path[i + 1]), path[i]);
        amounts[i + 1] = _getAmountOut(amounts[i], rIn, rOut);
    }
}
```

`_getAmountsIn` is the mirror, filled back-to-front with `_getAmountIn`
(`amounts[n-1] = amountOut`, loop `i` from `n-1` down to `1`).

---

## 5. Internal execution loop

Reuses `_swapOnPair` and `_collectProtocolFee` unchanged. Protocol fee is
charged **once, on the input token** (`path[0]`) — same 5 bps as a single-hop.
The AMM's own 0.3% still applies per pool (so a 2-hop pays 0.3% twice inside
the pools, which is inherent to routing, plus 5 bps once at the router).

```solidity
function _executeSwapPath(
    address[] calldata path,
    uint256[] memory amounts,   // from _getAmountsOut/_getAmountsIn
    address to,
    bool influencePrize
) internal {
    uint256 n = path.length;

    // Input into pair #0; router fee taken on the input token.
    address firstPair = _getPair(path[0], path[1]);
    IERC20(path[0]).safeTransferFrom(msg.sender, firstPair, amounts[0]);
    _collectProtocolFee(path[0], amounts[0]);

    // Hop i sends output straight into pair i+1's contract; the last hop
    // sends to the final recipient.
    for (uint256 i = 0; i < n - 1; i++) {
        address pair = (i == 0) ? firstPair : _getPair(path[i], path[i + 1]);
        address next = (i < n - 2) ? _getPair(path[i + 1], path[i + 2]) : to;
        _swapOnPair(pair, path[i], amounts[i + 1], next);
    }

    // Prize eligibility keyed on the INPUT token, exactly as single-hop.
    _maybeNudge(path[0], influencePrize);
    emit SwapExecuted(msg.sender, path[0], path[n - 1], amounts[0], amounts[n - 1], to);
}
```

`swapExactTokensForTokensPath` then:
```solidity
if (amountIn == 0) revert ZeroAmount();
if (to == address(0)) revert ZeroAddress();
uint256[] memory amounts = _getAmountsOut(amountIn, path);
amountOut = amounts[amounts.length - 1];
if (amountOut < amountOutMin) revert InsufficientOutputAmount(amountOut, amountOutMin);
_executeSwapPath(path, amounts, to, influencePrize);
```
`swapTokensForExactTokensPath` mirrors it with `_getAmountsIn`, checks
`amounts[0] > amountInMax → ExcessiveInputAmount()`, then same execution.

---

## 6. Prize-game semantics (unchanged, intentional)

- **Eligibility is on `path[0]`** (the input token) — identical to today's
  single-hop `_maybeNudge(tokenIn, …)`. Routing USDT→WETH→TIMBS nudges iff
  **USDT** is eligible; the WETH middle leg does not grant a nudge. This is the
  right call: the swapper's *chosen input* is what the meter rewards, and it
  can't be gamed by inserting an eligible token mid-path.
- **Fee once** on `path[0]`, so nudge economics are unchanged vs a single swap.
- Settlement-window guard and `swapNudgeWeight` all flow through the existing
  `_maybeNudge`.

If instead we ever want "nudge if *any* hop touches an eligible token", that's a
deliberate future change — not part of v1.

---

## 7. Frontend changes (`swap/swap.js`)

1. **Route selection** in `recalcQuote`:
   - Try direct `getReserves(tokenIn, tokenOut)`. If the pair exists → single-hop
     (current path, cheapest).
   - Else build candidate paths `[in, WETH, out]` (and optionally
     `[in, USDC, out]`), quote each via `getAmountsOutPath`, pick the best output.
   - If none quote → "No route for this pair" (replaces today's "No liquidity
     for this pair" when a bridge exists).
2. **Execution**: if the chosen route has >2 addresses, call
   `swapExactTokensForTokensPath(amountIn, min, path, to, deadline, influence)`
   instead of the 2-arg token function. Approvals only ever needed on `path[0]`.
3. **Slippage / min-out**: size `amountOutMin` off `getAmountsOutPath`'s last
   element × (1 − slippage). Multi-hop has compounding price impact — keep the
   existing rounds-to-0 and revert guards, applied to the *final* amount.
4. **Display**: show the route ("USDT → WETH → TIMBS") and a combined price
   impact so the user sees the two-pool cost.
5. The V2 Pools "24h Volume" column already counts each pool's swaps
   independently, so a 2-hop naturally shows up as volume on both pools — no
   change needed there.

---

## 8. Testing checklist

- `[in, out]` direct still equals the single-hop function's output (parity).
- `[USDT, WETH, TIMBS]` exact-in: output matches two sequential single-hops
  minus the one router fee; recipient balances correct; both pools' K holds.
- Exact-out `[USDT, WETH, TIMBS]`: `amountIn ≤ amountInMax`, dust rounding (+1 in
  `_getAmountIn`) doesn't under-fund the first pair.
- Missing middle pair (`WETH/Y` absent) → `PairNotFound`.
- `path` with a zero addr, a duplicate neighbor, len 1, or len > MAX_HOPS+1 →
  `InvalidPath`.
- Nudge fires iff `path[0]` eligible; middle eligible token does **not** nudge.
- Fee charged once, on `path[0]`, to treasury.
- Reentrancy: `nonReentrant` on the externals; pair `swap` is itself guarded.
- Slippage: a front-run that moves either pool makes `amountOut < amountOutMin`
  and reverts cleanly.

---

## 9. Deployment / rollout

This is a **new router** (functions added → bytecode changes; router is
immutable-`factory` but itself is a fresh deploy). Sequence:

1. Deploy new `TimbSwapRouter` with the same `factory / treasury /
   eligibleRegistry / timbPrize`; `setWeth(WETH)`.
2. `TimbPrize`: authorize the new router as the `nudgeScroll` caller (and
   de-authorize the old one) — same step as any router redeploy (see the
   redeploy checklist in the deploy docs).
3. Update `ADDRESSES.TimbSwapRouter` in **root `config.js` and
   `frontend/config.js`** (kept in sync); bump the config cache token on all 7
   pages.
4. Existing LP positions and pairs are untouched — pairs live on the factory,
   not the router.

No pair or factory redeploy is required.

---

## 10. Scope estimate

- Contract: ~70 lines (4 externals + 2 internal loops + 1 constant + 1 error),
  all reusing existing `_getPair` / `_getReserves` / `_getAmountOut` /
  `_swapOnPair` / `_collectProtocolFee` / `_maybeNudge`.
- Frontend: route-selection in `recalcQuote` + path execution branch + route
  display (~1 focused pass on `swap.js`).
- Redeploy + re-authorize + config bump: one deploy cycle.
