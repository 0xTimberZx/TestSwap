# TimbPrize v7 redeploy checklist — "meter resumes from the jittered winning char"

> ⚠️ **SUPERSEDED — historical.** This documents the v6→v7 prize cutover against
> the pre-generations registry (`0xcDd1633…`, now retired). For any **current**
> prize redeploy follow **`GAME_SYNC_GENERATIONS.md` §8** — the live registry
> (`0xfca8C2A1…`) and prize (`0x35976f4D…`) use game generations, so a prize
> redeploy is just the four `setTimbPrize` re-points + `startGame` (which bumps
> the generation), with **no registry redeploy**. The four-re-point and
> round-sync notes below still apply; the addresses do not.

**Prize-only redeploy.** GameRegistry, TimbYieldVault, PrizeEscrow, Router, and
everything else **stay put** — only TimbPrize's logic changed (§13.2 rollover:
each segment's next-round counter is seeded to the index of the char it just
locked). Because the registry and vault are reused, there is **no keyed-namespace
collision** this time (ticket IDs continue) — this is lighter than the registry
redeploy. Run the `GENESIS_CHECKLIST.md` pre-flight anyway; the one item that
applies here is round-sync (#3), handled below.

Live addresses (Arbitrum Sepolia, 421614) — these are **reused**:

| Role | Address |
|------|---------|
| PrizeEscrow | `0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D` |
| GameRegistry | `0xcDd1633F9FBD4dD189cF69FF82a005B4fcBe09eB` |
| TimbSwapRouter (v8) | `0x40C7Caf90817C9891D278Ec1400B9deb180911f1` |
| TimbYieldVault | `0x43D833e828e2AF951527C2b573Eb70c358FfEB0B` |
| TimbPrize v6 (to be replaced) | `0xBBcb21Ef7DBEef21d8a0DE5972E61fd0369Ed3c0` |

---

## 1. Compile (Remix)

- File: `contracts/TimbPrize.sol`
- Compiler **0.8.24**, optimizer **enabled, 200 runs**, **viaIR = true**, EVM **cancun**.
- (These match `foundry.toml`. viaIR is required.)

## 2. Deploy `TimbPrize`

Constructor args, **in this exact order** `(_prizeEscrow, _gameRegistry, _router)`:

```
_prizeEscrow  = 0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D
_gameRegistry = 0xcDd1633F9FBD4dD189cF69FF82a005B4fcBe09eB
_router       = 0x40C7Caf90817C9891D278Ec1400B9deb180911f1
```

The constructor also sets, automatically: `settler = deployer`, `winnersPerRound
= 3`, `protocolCutBps = 200`. It does **NOT** set the yield vault — that's step 3.

## 3. Wire the NEW prize (owner calls on the new prize)

| # | Call | Required? |
|---|------|-----------|
| a | `setYieldVault(0x43D833e828e2AF951527C2b573Eb70c358FfEB0B)` | **Yes** — not in the constructor; skip it and yield stays off |
| b | `setSettler(<keeper address>)` | Only if your settler wallet ≠ the deployer. `settleSegment` is permissionless (§9), so a keeper can settle regardless; this just designates the privileged settler |
| c | `setWinnersPerRound(n)` / `setProtocolCutBps(bps)` | Only if you changed them from the defaults (3 / 200) |
| d | `setEligibleRegistry(...)` | Optional/vestigial — set for consistency if you want |
| e | `fundPot()` (payable) | Seed the starting pot if desired |

## 4. Re-point the FOUR contracts that hold the prize address

Each stores `timbPrize` and either gates a call to `msg.sender == timbPrize` or
calls into the prize — so all four must point at the new prize. **Do these
before `startGame`.** (The router one is the easy miss — without it the meter
is dead to swaps.)

| Contract | Call | Why |
|----------|------|-----|
| **PrizeEscrow** `0x865C…fB6D` | `setTimbPrize(<new prize>)` | else prize **payouts** revert (`NotTimbPrize`) |
| **GameRegistry** `0xcDd1633…` | `setTimbPrize(<new prize>)` | else `setCurrentRound` / `recordWinners` / `onRoundSettled` revert |
| **TimbYieldVault** `0x43D833…` | `setTimbPrize(<new prize>)` | else `harvest` (yield → pot) reverts |
| **TimbSwapRouter** `0x40C7Caf…` | `setTimbPrize(<new prize>)` | **else swaps + the Advance button nudge the OLD prize** — the new meter never moves from user activity, only the settler's time-grid segment advances |

> Note the two-way router link: `newPrize.setRouter(router)` (step 3, so the
> prize authorizes the router's `nudgeScroll`) **and** `router.setTimbPrize(new)`
> here (so the router nudges *this* prize). Both are required.

## 5. Start the game

- `TimbPrize.startGame()` → resets to **round 1** and pushes `setCurrentRound(1)`
  into the registry.
- **Round-sync note:** the reused GameRegistry was at some round N; `startGame`
  resets its round to 1. Pre-existing tickets whose play round was > 1 will read
  correctly thanks to the frontend re-anchor (compete renders any not-yet-reached
  ticket as Pending). If you want a clean slate with zero old tickets, that needs
  a fresh GameRegistry too (see `GENESIS_CHECKLIST.md`) — not required for v7.

## 6. Frontend + settler

1. `config.js` → `ADDRESSES.TimbPrize = "<new prize>"` (and update the `// v6`
   comment to `v7 — meter resumes from jittered winning char`).
2. Bump the `config.js` cache token across all pages.
3. Settler secret/var `TIMBPRIZE_ADDR` (GitHub Actions) → `<new prize>`.
4. **Kick a fresh `settler.yml` run** — the env-snapshot rule means any in-flight
   run keeps the OLD prize address baked in; cancel it and dispatch a new one so
   segments advance against v7.

## 7. Verify one full cycle

- Meter opens the fresh game on **round 1 = genesis** (all counters 0 → the
  frontend shows `· · · · · ·`, not `AAAAAA`).
- Nudge/settle round 1; at rollover, confirm **round 2's meter opens on round 1's
  winning string** (the v7 behavior) and nudges up from there.
- Confirm a settle doesn't revert (proves PrizeEscrow / registry are re-pointed).
  ⚠️ A non-reverting settle does **NOT** prove the **vault** is re-pointed:
  `_harvestYield` swallows a rejected `harvest()` in `try/catch{}`, so a settle
  succeeds even with the yield wire dead. Verify yield separately — read back
  `TimbYieldVault.timbPrize()` == new prize, and confirm `previewAccrued()` drops
  to ~0 across a settlement (a `YieldHarvested` event fired). See
  `GAME_SYNC_GENERATIONS.md §8` step 9.

## 8. SPECS / docs

- `SPECS.md`: move v6 to the retired table, add the v7 row + address (mirror the
  v6→v5 entry style). The §13.2 rollover line is already updated.
