# Prize game — VRF entropy migration (H1)

Move `TimbPrize`'s per-segment winning character off grindable `blockhash`
entropy and onto Chainlink VRF, mirroring the board's gen-9 path. Keeps the
nudge-steered, class-preserving meter — only the exact-char entropy changes from
`blockhash(n-1)` (grindable on the permissionless settle) to an unpredictable VRF
word.

Status: **design spec — for review before implementation.** H1 is the last HIGH
in the self-audit and money-critical (it determines winners), so the mechanics
below want a sanity check from the §-author before code lands.

---

## 1. The finding (H1)

`_lockCurrentSegment` derives the locked char from
`keccak256(blockhash(block.number-1), counter, round, segment)`. `settleSegment`
is permissionless and callable across the whole settlement window, and
`blockhash(n-1)` is known inside block `n` — so a caller can simulate each block's
result and only broadcast in one that yields the char they hold. Grindable →
aimable → pot-theft. The code documents it as an accepted *testnet* residual.

## 2. Approach — mirror the board

- **Dedicated `VRFEntropy` for the prize game.** Deploy a second `VRFEntropy`
  instance and `setBoard(TimbPrize)`; one VRF v2.5 subscription can list both the
  board and this as consumers. `TimbPrize` gets a one-time `setEntropy(addr)`.
- **Salt** = `keccak256(abi.encodePacked(round, segment))`, exposed as a public
  `saltFor(round, segment)` view so keepers/frontend can compute it for stall
  recovery.
- **Per-segment arm → lock** (staggered, one word per segment), keeping the
  segment-by-segment drumroll. The nudge-steered **class-preserving jitter is
  kept**: `segmentDigitCounter % 36` sets the class (letter/digit), the VRF word
  picks the exact char within it.

## 3. Lifecycle change (the core)

`_settleDueSegment` (shared by `settleSegment` and `nudgeScroll`'s lazy path)
becomes arm-then-lock for the current segment, once its interaction window has
elapsed:

1. **Not requested** → `entropy.requestFor(salt)`; snapshot the class (§4);
   emit `SegmentArmed`; **return** (word not knowable yet).
2. **Requested, not ready** → revert `EntropyNotReady` (wait for the callback).
3. **Ready** → `_lockCurrentSegment(salt)` using
   `uint256(entropy.entropyFor(salt))` as the mix, then advance the segment (or
   `_settleRound()` on segment 6) exactly as today.

`_lockCurrentSegment(salt)` keeps its class-preserving body verbatim; only the
`mix` source changes from `blockhash(...)` to `entropy.entropyFor(salt)`.

## 4. Security-critical: freeze the class at arm time

**The new gap this must not open.** Today locking is synchronous at the window
boundary, so "no nudges land after the boundary" and the class is frozen. VRF
makes locking async, so between arm and lock the fulfilled word is public. If the
class could still be nudged in that gap, a player could read the word and steer
letter↔digit to make the char match their ticket — a fresh pick, the exact class
of bug H1 removes.

**Two guards, together:**
- **Arm only *after* the interaction window closes** (nudging done), like the
  board arms at `betsClose`. The word is never knowable while nudging is open.
- **Freeze the class at arm.** `nudgeScroll` must not touch a segment's counter
  once it is armed/awaiting-lock: after its lazy `_settleDueSegment()`, it
  increments the counter **only if the segment actually advanced** (i.e. it is no
  longer in the settlement window). While awaiting the VRF callback, nudges are
  skipped, so the class the word applies to is fixed at arm time.

Net: the class is set by nudges *before* the window closes; the word is drawn
*after*; neither party can pair a known word with a chosen class.

## 5. Stall handling

Reuse `VRFEntropy.rerequest` (permissionless, `REREQUEST_DELAY`). Expose a
`rearmSegment()` passthrough on `TimbPrize` (→ `entropy.rerequest(salt)`) and the
public `saltFor` so a stuck segment can be re-drawn by anyone. A fulfilled draw
is never re-requestable (module enforces), so no selection edge.

## 6. Timing

VRF latency (arm → callback) delays the lock and thus the next segment — the same
gap the board already lives with. The settler lingers/keeper-drives it; the
60-minute grid start (`_nextSegmentStart`) is unchanged, and the latency is small
against 60-min segments. `nudgeScroll`'s lazy settle still un-sticks the window
while the game is being played.

## 7. Deploy wiring

Add to the deploy script: deploy `VRFEntropy(coordinator, keyHash, subId, conf,
gasLimit, extraArgs)` for the prize game; `prizeEntropy.setBoard(timbPrize)`;
`timbPrize.setEntropy(prizeEntropy)`; add `timbPrize`'s entropy as a consumer on
the VRF subscription. Same runbook values as the board's entropy.

> ⚠️ **`extraArgs` must be copied byte-for-byte from a working entropy**, not
> re-encoded — the deployed coordinator rejects the canonical `_argsToBytes` blob
> with an empty-data revert (`data: "0x"`) at the first segment arm. Full detail +
> the `setExtraArgs` recovery in `dev-docs/GEN3_MIGRATION.md`.

## 8. Settler

Extend the prize settler to arm→wait→lock each segment (it already does this for
the board): call `settleSegment()` to arm; once `entropy.isReady(salt)`, call
again to lock; `rearmSegment()` if a draw stalls past the delay.

## 9. Tests

`PrizeWindows.t.sol` derives expected winning strings from `blockhash`; it must
be reworked to drive a **mock VRF coordinator** (as `SeedFarmClosed.t.sol` does
with `MockVRFCoordinator9`) and derive expected chars from the mock word via the
same `keccak(word, salt)` → class formula. `settleOne()` becomes arm → fulfil
(mock callback) → lock. This is the largest test change; verify locally with
`forge test --match-contract PrizeWindows -vvv` (it is CI-excluded from
execution, compiled only).

## 10. Checklist

1. `TimbPrize`: `IVRFEntropy` interface, `entropy` + `setEntropy`, `saltFor`,
   arm/lock split in `_settleDueSegment`, `_lockCurrentSegment(salt)` via VRF,
   class-freeze in `nudgeScroll`, `rearmSegment` passthrough, events/errors.
2. Deploy script: prize `VRFEntropy` + wiring (§7).
3. Settler: arm/lock the prize segments (§8).
4. `PrizeWindows.t.sol`: mock-VRF rework (§9); update any other TimbPrize tests.
5. Local `forge test` green (incl. PrizeWindows) + CI green; audit before mainnet.
