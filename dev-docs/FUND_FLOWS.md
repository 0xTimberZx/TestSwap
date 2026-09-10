# TimbSwap Prize Game — Fund Flows (ETH)

Where every wei enters and leaves the three money surfaces the analytics page
shows: **Pot Backing** (PrizeEscrow), the **Prize Pot** (the winnable slice),
and the **Yield Vault** (TimbYieldVault). Written against the mainnet-bound
contracts.

## The one thing that clears up most confusion

**All prize ETH physically lives in one place: `PrizeEscrow`.** The "Prize Pot"
number (`TimbPrize.currentAccumulatedRewards`) is *not* a separate wallet — it's
an **accounting pointer to the winnable slice** of the escrow balance. So:

- **Pot Backing** (escrow balance) ≥ **Prize Pot** (winnable), always.
- The gap between them is seed/reserve ETH that's in escrow but not yet accounted
  as the current round's winnable pot.
- When a round ends with no winner, the pot **snowballs**: the pointer re-points
  to next round. **No ETH moves** — it's already in escrow — so nothing shows up
  as a deposit. That's why "last funded" can read `1d` while rounds keep settling.
  The `PotCarried` event (added for exactly this) is the on-chain signal for the
  carry, and the analytics Prize Pot card now shows `carried X ETH from #N`.

---

## ① Pot Backing — how PrizeEscrow gets more ETH

Every inflow here fires a `Deposited(from, amount)` event → this is what the
analytics "last funded" line tracks.

- **`TimbPrize.fundPot()`** — owner seeding → `escrow.deposit{value}`
- **`TimbPrize.addToPot()`** — permissionless top-up (anyone) → `escrow.deposit{value}`
- **`TimbPrize._harvestYield()`** — at each settlement, accrued vault yield is
  pulled from the vault and forwarded straight into escrow → `escrow.deposit{value}`
- **`TimbTreasury.distributeToPot()`** — protocol fee revenue routed in → `escrow.deposit{value}`
- **Direct ETH send** → `receive()` (also emits `Deposited`)

**Outflows (only these):**
- `pay(winner, amount, round)` — winner claim (only TimbPrize can call it)
- `pay(revenueAddr, cut, …)` via `TimbPrize.withdrawProtocolCut()` — protocol-cut delivery
- `emergencyWithdraw(to, amount)` — owner last resort (post-hardening: timelock/multisig owned)

---

## ② Prize Pot — how the winnable slice (`currentAccumulatedRewards`) grows

This is accounting over the escrow balance, not a separate balance.

- **Yield harvest at settlement** — `_harvestYield` credits `currentAccumulatedRewards`
  (and the matching ETH lands in escrow via ①)
- **Snowball carry** — an unclaimed round's remainder becomes next round's opening
  pot (`currentAccumulatedRewards = remainder`). Accounting-only; emits `PotCarried`.
- **Recycled lapsed winnings** — winnings unclaimed past the claim window recycle
  back into the live pot (`recycleLapsedRound`). Pure bookkeeping; ETH never left escrow.
- **`addToPot` / `fundPot`** — top-ups (the ETH also lands physically in escrow via ①)

**Not a pot source:** ⚠️ **ticket entry fees do NOT feed the pot.** A ticket's cost
is *refundable principal* held in **GameRegistry**, returned to the player. While a
ticket is active it's counted as **weight** in the Yield Vault (so it *earns yield*
for the pot) — but the principal itself is never pot revenue.

**Outflow:** winner claims (which draw from escrow via ①), and the protocol cut
carved off each settled pot (tracked in `protocolCutAccrued`, delivered separately).

---

## ③ Yield Vault — how TimbYieldVault gets ETH

- **`fund()`** — Treasury / owner / anyone tops up the yield **reserve** → `Funded`
- **Direct ETH send** → `receive()` → `Funded`

This reserve is the **only** source of vault yield. Accrual is per-second,
proportional to active-ticket weight, and **capped by the funded reserve** — if the
reserve runs dry, accrual simply pauses. **Principal is never touched** (active-ticket
escrow is counted as weight only; it lives in GameRegistry, not here).

**Outflow:** `harvest()` — TimbPrize pulls all accrued yield at each round
settlement → into the Prize Pot (②) → forwarded into PrizeEscrow (①).

---

## The full picture

```
 Ticket entry fee ──► GameRegistry (refundable principal, counted as VAULT WEIGHT)
                             │ weight only, principal never moves to pot
                             ▼
 Treasury/owner ──fund()──► TimbYieldVault (reserve)
                             │ accrues yield, capped by reserve
                             │ harvest() at settlement
                             ▼
 Treasury fees ─distributeToPot()─┐
 Owner seed ────fundPot()─────────┤
 Anyone ────────addToPot()────────┼──► PrizeEscrow  ("Pot Backing")  ◄─ all prize ETH lives here
 Direct send ─────────────────────┘        │
                                            │ currentAccumulatedRewards = winnable slice ("Prize Pot")
                                            │   • grows via harvest + snowball carry (PotCarried) + recycle
                                            │
                                            ├─ pay() ───────► winner
                                            └─ pay() ───────► protocol-cut revenue address
```

## Events cheat-sheet (what analytics reads)

| Surface       | Inflow event                    | Notes                                  |
|---------------|---------------------------------|----------------------------------------|
| Pot Backing   | `Deposited(from, amount)`       | real ETH in (seed, harvest, fees, send)|
| Prize Pot     | `PotCarried(round, amt, wins)`  | round-end snowball (no ETH moves)      |
| Prize Pot     | `YieldHarvested(round, amount)` | vault yield swept into the pot         |
| Yield Vault   | `Funded(from, amount)`          | reserve top-up                         |
| Yield Vault   | `Harvested(amount, to)`         | yield pulled to TimbPrize at settlement|

---

*Note: the `PotCarried` event lives in the mainnet-bound `TimbPrize` (official
repo). The testnet-deployed contract predates it, so on testnet the analytics
carry line stays empty until the event ships with the mainnet deployment.*
