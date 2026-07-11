# Genesis / migration invariant checklist

**Run this before every *partial* redeploy** — i.e. any time you deploy a fresh
copy of one contract while keeping a live copy of another it talks to.

These bugs don't revert. Nothing throws, no tx fails, no audit tool for
front-facing attack vectors flags them. State just **silently misaligns**,
because a fresh contract's counters start at genesis (`0` / `1`) while the live
contract it's wired to is mid-life at some `N`. You find out when yield stops
accruing or entries vanish, not when you deploy.

> Root cause, every time: **a stateful contract keyed by a counter that
> restarts at genesis is wired to a live contract whose counter did not.**

---

## The two that bit us (2026-07-11 registry cutover)

Concrete instances, kept here as the canonical examples.

### 1. Shared ID namespace + idempotent guard → new tickets silently earn nothing
Deployed a fresh `GameRegistry` but **reused** the live `TimbYieldVault`.

- Both registries start `nextTicketId = 1` (`GameRegistry.sol`).
- Vault `register()` is idempotent: `if (weightOf[ticketId] != 0) return;`
  (`TimbYieldVault.sol`).
- Old ticket #1 already has weight in the vault. New registry activates *its*
  ticket #1 → `register(1, …)` sees `weightOf[1] != 0` → **returns early**.
  New ticket registers **zero** weight and earns no yield. No error.
- Bonus: old weight is stranded in `totalWeight` forever — `remove()` is
  `onlyGameRegistry`, which now points at the *new* registry, which doesn't
  know the old IDs. Phantom weight keeps draining the reserve into the pot.

**Fix:** redeploy the keyed contract (fresh vault) too, or namespace the IDs so
they can't collide.

### 2. Latched init + rollover-only sync → registry stuck at round 0
The prize pushes the round into the registry only in `startGame()` and at round
rollover (`setCurrentRound`, `onlyTimbPrize`).

- `gameStarted` is a **one-way latch** — set once, no `resetGame`. So on a live
  prize, `startGame()` **reverts** and never pushes the round to a fresh
  registry.
- A freshly-deployed registry therefore sits at `currentRound = 0` while the
  prize is mid-round `N`. `submitEntry` files at `currentRound + 1 = 1`, but the
  prize next activates round `N+1`. **Every entry made in the gap is orphaned.**
- It self-heals at the next rollover (prize does `currentRound++` →
  `setCurrentRound(N+1)`), but entries before then are already lost.

**Mitigation (no redeploy):** `pauseEntries()` on the prize, let the settler
carry the round to its rollover (that's the sync push), then `unpauseEntries()`.

---

## Pre-flight — check all five before repointing anything

1. **Shared ID namespaces.** Every `mapping(id => …)` in a contract you're
   *keeping* (vault `weightOf`, escrows, per-round arrays, winner lists) will
   collide with a redeployed sibling that restarts IDs at genesis. Idempotent
   guards (`if (x != 0) return;`) turn the collision into a *silent skip*, not a
   revert. → Redeploy the keyed contract, or namespace the IDs.

2. **Latched init.** Grep for one-way `bool`s (`gameStarted`, `initialized`,
   `seeded`). If the init path that seeds a sibling is guarded by one and
   there's no reset, a fresh sibling can never be initialized normally.
   → Confirm a reset exists, or plan to push the state another way / redeploy
   the latching contract.

3. **Cross-contract counter sync.** If A pushes a value into B only on specific
   events (rollover, settle), a freshly-deployed B stays at its default until
   that event fires. → Confirm there's a manual sync lever, or gate all activity
   until the first natural sync lands.

4. **Access-control lockout after rewire.** After `setX(new)`, the *old*
   contract usually loses its right to call back (`onlyGameRegistry`,
   `onlyTimbPrize`). Any cleanup that had to *originate from* the old contract
   becomes impossible the instant you repoint. → Do that cleanup **before**
   repointing, or make sure an owner escape hatch covers it.

5. **Stranded value.** Principal, funded reserve, `accruedForPot` — balances in
   the contract you're orphaning do not move themselves. → Enumerate every
   balance in the old contract and its reclaim path (`emergencyWithdraw`,
   old-registry `claimRefund`, etc.) before you cut it loose.

---

## Order of operations that avoids most of these

1. **Pause** activity on the live side (`pauseEntries`, `pause`) so no new state
   is created mid-migration.
2. **Drain / reclaim** stranded value from any contract you're orphaning
   (checklist #5) — while its access rights are still intact (#4).
3. **Deploy** every contract that shares a keyed namespace with a redeployed one
   (#1) — don't reuse half.
4. **Wire** the new set both ways (`setGameRegistry` / `setYieldVault` /
   `setTimbPrize`), and re-apply every tunable (rate, weight, APR, entry costs —
   constructors rarely carry them).
5. **Sync** the counters (#2, #3): trigger the first natural sync, or verify the
   fresh contract's counter already matches its live sibling.
6. **Unpause**, then verify one real cycle end-to-end (an entry activates, yield
   accrues, a settle doesn't revert) before walking away.
7. Update `config.js` `ADDRESSES` + bump cache tokens last.
