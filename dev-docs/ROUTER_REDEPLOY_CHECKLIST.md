# Router redeploy checklist — prize-meter balance (PR #55)

Copy-paste steps to make the swap-weighted-nudge + free-nudge-cap change live.
**Router-only redeploy.** TimbPrize, Factory, GameRegistry, pairs, all other contracts stay put.

Current live addresses (Arbitrum Sepolia, 421614):

| Role | Address |
|------|---------|
| Factory | `0xCCd6d3f0A86042d2B7056eDd381d367126628AF5` |
| Treasury | `0x486Fa4D8351EF81136E83340eA1e3aa2272c9955` |
| EligibleTokenRegistry | `0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04` |
| TimbPrize (v3.2) | `0xc3fB39E0da3312c7f95bD7aD511ac76C4B86eE40` |
| WETH | `0x980B62Da83eFf3D4576C647993b0c1D7faf17c73` |
| Router (current, to be replaced) | `0x6E53dc53Ea7B2fd8be171D74A381f009dA5F94bD` |

---

## 1. Compile (Remix)

- File: `contracts/TimbSwapRouter.sol`
- Compiler **0.8.24**, **Enable optimization = 200**, and **Advanced → viaIR = true** (Router needs viaIR).
- EVM version: cancun.

## 2. Deploy `TimbSwapRouter`

Constructor args, **in this exact order** `(_factory, _treasury, _eligibleRegistry, _timbPrize)`:

```
_factory          = 0xCCd6d3f0A86042d2B7056eDd381d367126628AF5
_treasury         = 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955
_eligibleRegistry = 0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04
_timbPrize        = 0xc3fB39E0da3312c7f95bD7aD511ac76C4B86eE40
```

Record the deployed address → call it `NEW_ROUTER` below.

> Nudge params `swapNudgeWeight = 3` and `freeNudgeCapPerSeg = 10` are set at declaration —
> **no setter calls needed** unless you want to tune them later
> (`setSwapNudgeWeight`, `setFreeNudgeCapPerSeg`, owner-only).

## 3. Configure the new Router (owner calls, on `NEW_ROUTER`)

```
setWeth(0x980B62Da83eFf3D4576C647993b0c1D7faf17c73)   // REQUIRED — ETH swaps revert without it
```
(`factory`, `treasury`, `eligibleRegistry`, `timbPrize` were all set by the constructor — verify
them with the public getters, but no calls needed.)

## 4. Rewire the protocol to trust `NEW_ROUTER`

```
TimbPrize(0xc3fB39E0da3312c7f95bD7aD511ac76C4B86eE40).setRouter(NEW_ROUTER)   // REQUIRED — authorises nudges
TimbSwapFactory(0xCCd6d3f0A86042d2B7056eDd381d367126628AF5).setRouter(NEW_ROUTER) // state consistency (create-on-add-liquidity registry)
```

> Note: existing pairs' `swap()` and `createPair()` aren't router-gated in code, so swaps keep
> working regardless — but keep the Factory's `router` pointer consistent with the live Router.

## 5. Frontend

- `config.js` **and** root `config.js`: set `ADDRESSES.TimbSwapRouter = "NEW_ROUTER"`.
- `SPECS.md` → Router Version History: add the new row (v7), mark v6 Retired.
- Bump the compete cache token (e.g. `20260711a → 20260712a`) so the new address ships past the
  GitHub Pages / mobile cache.

## 6. Verify (post-switch, do it in one sitting)

1. On `NEW_ROUTER`: `swapNudgeWeight()` == 3, `freeNudgeCapPerSeg()` == 10, `weth()` == WETH,
   `timbPrize()` == TimbPrize, `treasury()` == Treasury, `eligibleRegistry()` == registry.
2. On TimbPrize: `router()` == `NEW_ROUTER`.
3. Do one eligible swap → `positionCounter` jumps by **3** (not 1). Confirms #2.
4. Call `advanceScroll` on the free path 10 times in a segment → the 11th clamps to 0 /
   `freeNudgesRemaining(you)` reads 0; the compete button flips to "swap to move the meter".
   Confirms #1.
5. Compete page Advance panel shows the free-left countdown once the new Router is in `config.js`.

## Rollback

Point `TimbPrize.setRouter` (and `config.js`) back at `0x6E53…F94bD`. The old Router is unchanged
and fully functional; nothing is destructive.
