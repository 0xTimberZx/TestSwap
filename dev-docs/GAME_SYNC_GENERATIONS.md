# GameRegistry v4 — game generations (cross-game round-collision fix)

One-time coordinated redeploy (**new GameRegistry + new TimbPrize**) that ends
the reused-registry genesis class permanently. After this, every future prize
redeploy is just `setTimbPrize` + `startGame` — no registry redeploy, no
contamination.

---

## 1. The bug this closes

The GameRegistry is reused across TimbPrize redeploys. `startGame` resets
`currentRound → 1`, but every round-keyed value from prior games persists under
the **same integer round keys** the new game reuses. Round 3 of game A and round
3 of game B are indistinguishable to storage.

Failure: an old Active ticket (`playRound 3`, `LER 12`) survives a redeploy; when
the *new* game reaches round 3, `verifyEntryValid` returns **valid**
(`3 >= playRound`, Active, `<= 12`). **A ticket set for a dead game can win the
new pot**, distort vault weight, and collide in the forfeiture buckets. It also
locks the wallet out via the one-per-wallet `_isLive` gate.

Root cause: round-keyed state has **no game identity**.

## 2. Owner requirement

Un-terminated tickets from a prior game must stay recoverable — never stranded
by round math that no longer applies. Satisfied by `reclaimFromPastGame` (§3.5):
principal back on demand the instant a new game starts.

## 3. Design — generation epochs

### 3.1 New state (`GameRegistry`)
```solidity
uint256 public generation = 1;   // current game epoch; 1-based
bool private _firstGameStarted;  // first startGame keeps gen 1
```
`Ticket` gains `uint256 generation;` (stamped at mint).

### 3.2 Namespacing — the whole fix
Every round-keyed mapping gets a leading `generation` key:

| before | after |
|--------|-------|
| `ticketAt[wallet][round]` | `ticketAt[gen][wallet][round]` |
| `roundEntrants[round]` | `roundEntrants[gen][round]` |
| `hasEntryInRound[round][wallet]` | `hasEntryInRound[gen][round][wallet]` |
| `stringEntrants[round][string6]` | `stringEntrants[gen][round][string6]` |

Mint writes use the ticket's own generation; round-lifecycle reads/writes
(`activateRoundEntries`, `onRoundSettled`, `_sweepLapsedBucket`, `recordWinners`,
`verifyEntry*`, `getRoundEntrants`, `getStringEntrants`, `getIdenticalCount`) use
the current `generation`. Ticket-id-keyed state (`tickets`, `activeTicketOf`,
`_ticketsOf`) is unchanged — already game-agnostic. **Function signatures of the
prize-facing accessors are unchanged**, so the TimbPrize↔registry interface only
gains `onGameStarted()`.

### 3.3 Generation bump — driven by the prize
```solidity
function onGameStarted() external onlyTimbPrize {
    if (_firstGameStarted) generation += 1;   // later prize deploys bump
    else _firstGameStarted = true;            // first game keeps gen 1
    currentRound = 1;
    emit GenerationStarted(generation);
    emit CurrentRoundUpdated(1);
}
```
`TimbPrize.startGame` now calls `registry.onGameStarted()` instead of the bare
`setCurrentRound(1)`. `startGame` is a one-way latch per prize, so **each prize
deploy bumps the generation exactly once**. The first-game-keeps-1 rule means any
pre-`startGame` entries (minted at gen 1) stay valid for game 1.

### 3.4 Liveness gate
```solidity
function _isLive(Ticket storage t) internal view returns (bool) {
    if (t.generation != generation) return false;   // prior game ⇒ inert
    if (t.status == TicketStatus.Pending) return true;
    if (t.status == TicketStatus.Active && currentRound <= t.lastEligibleRound) return true;
    return false;
}
```
A prior-gen ticket is not live → frees the wallet to enter the new game.
`verifyEntryValid` reads via the namespaced mapping, so it only ever sees
current-gen tickets — an old ticket can no longer win a colliding new round.

### 3.5 Reclaim path (owner requirement)
```solidity
function reclaimFromPastGame(uint256 ticketId) external nonReentrant {
    // owner-only; requires t.generation < generation and status Pending/Active
    // with escrow; sets Closed, removes vault weight, pays principal back.
}
```
Round-agnostic and available immediately when a new game starts. Terminal
statuses (Conceded/Ineligible/Cancelled/Closed) already had escrow handled and
are rejected.

## 4. Yield-vault note (documented, not looped)
Prior-gen Active tickets keep vault weight until reclaimed — no unbounded strip
at the bump. They lose weight lazily on `reclaimFromPastGame`. Minor yield
dilution until owners reclaim; owners are incentivised to (it returns principal),
so it self-cleans.

## 5. Frontend (compete.js) — shipped with this change
- `TICKET_TUPLE` gains `uint256 generation`; ABI gains `generation()` and
  `reclaimFromPastGame(uint256)`.
- `loadMyEntries` reads `generation()` → `currentGen`; live-entry checks
  (`hasPlayEntry`, `myActiveTicketStr`) require current gen.
- Prior-gen un-terminated tickets render a **Reclaim principal** button
  (`handleReclaimPastGame`) + hint "from a previous game · reclaim your deposit",
  and stay visible regardless of the current round.

## 6. Settler / ABI
No settler logic change (it only advances segments). `startGame` (owner tx) now
triggers `onGameStarted`. Regenerate any cached ABI carrying the `Ticket` tuple
(compete `TICKET_TUPLE` done; DebugHub if it decodes tickets).

## 7. Migration — the current live registry (0xcDd1633…)
No `generation` field there, so v4 is a **fresh deploy**. Current-registry
tickets (e.g. #1 "WORKIN", 0.0001 ETH) do **not** migrate — they live in the old
contract, which is still driven by the current prize, so each ages out to its
`Refund principal` window normally (ticket #1 at R16). **Decision: cut to v4 now**
(recommended) — keep the old compete reachable for stragglers, or eat the testnet
dust. This is the last redeploy that ever needs a fresh registry.

## 8. Redeploy checklist (coordinated: registry + prize)
1. Deploy **GameRegistry v4** (this file's contract).
2. `setEntryCosts(1000e18, 0.0001e18)` — i.e. `(1000000000000000000000,
   100000000000000)`; **does NOT carry over on a fresh registry**, so entries are
   free until set. Then `setYieldVault(vault)`, `vault.setGameRegistry(newReg)`,
   `setProtocolSink`.
3. Deploy **TimbPrize** against v4 (`_gameRegistry = v4`).
4. FOUR `setTimbPrize` re-points → new prize: PrizeEscrow, **v4 registry**,
   YieldVault, Router. `newPrize.setRouter(router)`; `newPrize.setYieldVault(...)`.
5. `newPrize.startGame()` → `onGameStarted()` → generation 1, round 1.
6. `config.js` ADDRESSES → v4 registry + new prize; bump cache tokens.
7. Settler reads addresses from config.js (§16) — confirm.
8. Verify: genesis meter `······`; simulate a *second* game (redeploy a throwaway
   prize on testnet, `startGame`) → confirm gen bumps to 2, old-gen ticket is
   inert (`_isLive` false, can't win a colliding round) and shows **Reclaim**.

## 9. Foundry tests (tests/GameRegistryGenerations.t.sol)
- gen bump makes an old Active ticket inert (`verifyEntryValid` false at the
  colliding round; `_isLive` false via a fresh submit succeeding).
- `reclaimFromPastGame` returns principal (ETH + TIMBS).
- reclaim reverts for a current-gen ticket and for terminal statuses.
- wallet with a stranded old ticket can enter the new game.
- no cross-gen forfeit sweep (gen-2 settle ignores gen-1 buckets).
