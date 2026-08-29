# Multichain meter — one meter, N vaults

How the prize meter services **local pots on more than one chain from a single
shared game clock**. Arbitrum is the home (canonical) chain at mainnet launch;
Base joins as a satellite months later. The design is additive: nothing about the
home meter changes when a satellite is added, *provided* three hooks are baked in
at the Arbitrum launch (§7).

Status: **design spec, forward-looking.** No satellite code is built yet. Phase 1
(Arbitrum-only mainnet) ships the dormant hooks; Phase 2 (Base) is pure addition.

---

## 1. The principle

Split the system into two halves that never mix:

- **Outcome** — the round id, the six segment characters, the winning string.
  This must be **identical on every chain**. One source, singular.
- **Money** — the pot, the entrants, the payouts. This stays **local to each
  chain**. Nothing crosses.

> **Money horizontal and local; outcome vertical and singular.**

The only thing that ever crosses a chain boundary is a small authenticated
message — never user funds. Each chain pays its own winners from its own pot, so
the escrow-sacred invariant holds *per chain* and there is zero bridge-custody
risk on principal.

Explicit non-goals: **no aggregated jackpots** (no shared pot across chains), and
**no Ethereum-mainnet hub** (§3).

## 2. What "the meter" is

In `TimbPrize.sol` the meter is four pieces of state: `currentRound`,
`currentSegment` (1–6), `segmentStartTime`, and the progressively-revealed
`roundWinningString[round]` (bytes6). The pot (`currentAccumulatedRewards` →
`frozenPot[round]`) settles against that string in `_settleRound()`.

**The constraint that forces the architecture:** today the per-segment character
comes from *local* state — `_lockSegment()` mixes `segmentDigitCounter` (on-chain
nudge activity) with block data. That is chain-local by construction. Deploy the
same contract on two chains and their nudges produce **two different winning
strings**. So one meter across chains requires moving the character source to a
**single VRF authority** and broadcasting it. This is the prerequisite; see §5.

## 3. Trust model — no Ethereum mainnet as a security layer

- **No contract on Ethereum mainnet, no L1 hub, no L1 settlement/verification
  leg.** Cross-chain messages go **home ↔ satellite directly** through the
  messaging protocol.
- **The security layer for the cross-chain hop is the messaging protocol's own
  trust set** — LayerZero DVNs (choose ≥2 independent) or CCIP's DON + risk
  network. This is the one new trust assumption the multichain step introduces;
  choose it deliberately.
- **Arbitrum and Base are both Ethereum rollups**, so each chain *itself* roots
  its security in Ethereum's DA + settlement. That is inherent to picking those
  chains and is a plus — but it is the chains' own property, not a layer inserted
  into this design. Arb + Base is a homogeneous pair (both EVM, both have
  Chainlink VRF, both reachable by LZ/CCIP). BSC is **not** an Ethereum rollup
  and is out of near-term scope.

## 4. Canonical id vs. local display number

Two separate round identities, kept decoupled:

- **Canonical round id** — home-authoritative, shared, monotonic. Carried in the
  cross-chain message; keys idempotency, verification, and the winning-string
  derivation. Players never see it.
- **Local display number** — per chain, cosmetic, owned by that chain's
  GameRegistry. Base starts at **Round 1** the day it goes live, even if the
  canonical counter is already at (say) 512. It honestly reflects *that chain's*
  time running.

The message keys on the **canonical id only**. Local numbers are chain-private —
never put them on the wire, or they collide. Each satellite keeps
`localToCanonical[localN] = canonicalId` for reconciliation/audit.

### 4.1 What increments the local counter

The home meter is authoritative and **never waits on a satellite** (§6), so
canonical rounds can elapse that a satellite did not service. The local counter
therefore ticks **only when that chain actually settles a round** — the count is
"rounds this chain served," the truest reflection of its time running. If a
satellite misses a canonical round during an outage, its local number does not
inflate; the gap is visible only in `localToCanonical`, never on the display.

## 5. Randomness — one string, verify-not-trust

- **VRF runs on the home chain only.** One Chainlink VRF v2.5 subscription
  produces the round's random `word`. Never run VRF per chain — three subscriptions
  are three strings are three games.
- Each segment character is deterministic: `char = f(word, salt)` with a
  per-segment `salt` (mirrors the existing `saltFor` / `_charFor` derivation).
- **The home contract publishes `word` + `salt`, not the bare character.** The
  satellite recomputes the character with the identical formula. It *verifies*
  the outcome rather than being handed it, so a compromised relayer can **stall
  but never forge** a result.

Trust chain: satellite → messaging-layer origin authentication (message provably
from the home meter) → home meter (bound to Chainlink VRF).

## 6. Settlement unison — the honest guarantees

Two different meanings of "in unison," with opposite feasibility:

- **Outcome unison (same winning string): guaranteed.** Identical inputs
  (`word`, `salt`) → identical string, every time, verified on-chain.
- **Wall-clock unison (same-instant settlement): not literal.** Independent
  chains + a message hop cannot settle atomically. What is guaranteed is
  **"within the settlement window,"** which at hourly-segment / ~6h-round scale is
  simultaneous to any observer. Sequence:

  ```
  home boundary → home locks char (VRF) + broadcasts (word, salt)
               → messaging layer delivers (seconds–minutes)
               → satellite verifies char, settles local pot, pays local winners
  ```

  Both frontends animate their meter to the *same scheduled boundary* (cosmetic);
  the satellite's on-chain confirm lands a beat behind, inside the window.

**Gotcha — the 15s window is too tight to bridge in.** The current settlement /
intermission window (~15s of the 59:45 / 0:15 split) cannot double as the
cross-chain delivery window; LZ/CCIP can exceed it. In the multichain phase,
separate the concepts: (a) home boundary + lock + broadcast, (b) a *satellite*
delivery window sized in **minutes**, (c) satellite settles when verified. The
satellite is slaved to the home boundary — its next segment never begins until it
has applied the home char — so it can confirm behind without ever diverging.

## 7. Liveness

- **Home never waits on a satellite.** A satellite outage never stalls the home
  meter. Conversely a home stall freezes every satellite — a single point, the
  price of one meter. (The `TimbPrize` phase-ratchet lesson applies harder here:
  a delayed home settle shifts every subsequent round on every chain. See
  `settler.js` and the settler investigation notes.)
- **Permissionless catch-up.** Because the character is deterministic from
  `(word, salt)`, *anyone* can re-feed a stuck satellite via a `replaySegment`
  path that takes the same authenticated payload — same spirit as the
  permissionless `lockSegment`. Do not depend on a single relayer.
- **Delivery: protocol executor primary, keeper backstop.** Let the CCIP/LZ
  executor deliver; the existing GitHub-Actions keeper re-pokes any satellite
  that falls behind (the cron-backstop philosophy already in production).
- **Send only after home finality** so a reorg cannot propagate a character that
  is later retracted.
- Satellite `applySegment` is **idempotent + strictly monotonic + origin-checked**
  so replays and reordering are no-ops.

## 8. Contract surface (stubs)

Forward-compat stubs — invariants and seams, not drop-in code.

### 8.1 GameRegistry — dual numbering (additive, ship on Arb now)

```solidity
uint256 public currentCanonicalRound;                 // shared meter id (home-authoritative)
uint256 public currentLocalRound;                     // cosmetic, per-chain "time running"
mapping(uint256 => uint256) public localToCanonical;  // reconciliation / audit / indexing

function setRound(uint256 canonicalRound, uint256 localRound) external onlyMeter {
    currentCanonicalRound        = canonicalRound;
    currentLocalRound            = localRound;
    localToCanonical[localRound] = canonicalRound;
    emit RoundRolled(canonicalRound, localRound, block.timestamp);
}
```

`onlyMeter` = `TimbPrize` on Arb; the satellite Vault on Base. On Arb the two
numbers are equal (offset 0); the existing `setCurrentRound` call site in
`_settleRound` becomes `setRound(canonical, local)`.

### 8.2 Home broadcast hook — bake into the Arb launch contract (dormant Phase 1)

```solidity
address[]     public satellites;   // empty at Arb launch → hook is a no-op
IMeterBridge  public bridge;       // LZ/CCIP adapter; address(0) until Phase 2

// Call right after a segment's char is locked from VRF (and at rollover).
function _broadcastSegment(uint256 round, uint8 segment, uint256 word, bytes32 salt) internal {
    if (address(bridge) == address(0) || satellites.length == 0) return;   // free in Phase 1
    bytes memory payload = abi.encode(round, segment, word, salt);
    for (uint256 i; i < satellites.length; ++i) {
        bridge.send(satellites[i], payload);   // delivery + retries live in the adapter
    }
}
```

Publish `word` + `salt`, never the bare character (§5).

### 8.3 Satellite Vault — Base, Phase 2

```solidity
contract PrizeVaultSatellite {
    // ── outcome, mirrored from home ────────────────────────────────
    uint256 public currentCanonicalRound;
    uint8   public currentSegment;
    mapping(uint256 => mapping(uint8 => bytes1)) public segChar; // [canonicalRound][seg]
    mapping(uint256 => bool) public roundSettled;

    // ── local display numbering (served-rounds, §4.1) ──────────────
    uint256 public currentLocalRound;                 // ++ ONLY when this chain settles
    mapping(uint256 => uint256) public localToCanonical;

    // ── local money, never bridged ─────────────────────────────────
    uint256 public localPot;
    mapping(uint256 => address[]) public entrants;    // keyed by canonical round

    IMeterEndpoint public endpoint;   // LZ/CCIP receiver
    address        public homeMeter;  // authenticated origin (the Arb TimbPrize)

    // SOLE driver of the satellite meter. Idempotent + monotonic + origin-checked.
    function applySegment(uint256 canonicalRound, uint8 segment, uint256 word, bytes32 salt) external {
        _verifyOrigin(msg.sender, homeMeter);              // provably from the home meter
        require(canonicalRound >= currentCanonicalRound, "stale round");
        if (segChar[canonicalRound][segment] != 0x00) return;   // idempotent: replay = no-op
        require(_isExpectedNext(canonicalRound, segment), "out of order");  // monotonic

        segChar[canonicalRound][segment] = _deriveChar(word, salt);  // identical formula to home
        currentCanonicalRound = canonicalRound;
        currentSegment        = segment;

        if (segment == 6) _settleLocalRound(canonicalRound);
    }

    function _settleLocalRound(uint256 canonicalRound) internal {
        require(!roundSettled[canonicalRound], "settled");
        roundSettled[canonicalRound] = true;

        bytes6 winning = _assembleString(canonicalRound);   // the 6 mirrored chars
        _payLocalWinners(canonicalRound, winning);          // LOCAL pot → LOCAL winners only

        uint256 localN = ++currentLocalRound;               // advances ONLY here
        localToCanonical[localN] = canonicalRound;
        registry.setRound(canonicalRound, localN);
        emit RoundSettled(canonicalRound, localN, winning);
    }
}
```

Notes:
- **No VRF, no clock authority.** `applySegment` is the *only* thing that moves
  the satellite meter. Players enter/nudge locally during the round; the lock
  always comes from home. A cosmetic local timer (shared segment duration + a
  broadcast `segmentStartTime`) drives the UI countdown — decoration, not
  authority.
- **`_verifyOrigin` is the transport seam.** Swap it for LayerZero's `_lzReceive`
  peer check or CCIP's `ccipReceive` (sourceChainSelector + sender allowlist).
  Nothing else in the contract depends on the bridge choice.
- **`replaySegment`** (not shown) exposes the permissionless catch-up path (§7).

## 9. Build order

**Bake into Arbitrum at Phase 1 launch — cheap now, saves a home-meter migration:**

1. Character sourced from **VRF**, and the home meter **publishes `word` + per-segment `salt`** (§5).
2. Dormant `_broadcastSegment` hook + `satellites` / `bridge` fields (§8.2).
3. GameRegistry dual-number fields — `setRound(canonical, local)` (§8.1).

Ship Phase 1 as an Arbitrum-only mainnet game; items 1–3 are inert until a
satellite exists.

**Phase 2 (Base, months later) is pure addition:**

1. Deploy `PrizeVaultSatellite` on Base.
2. Deploy the bridge adapter (LZ OApp or CCIP) on both chains; set peers.
3. Register Base in `satellites`; set `bridge`.
4. Base local numbering starts at 1.

Zero changes to the live Arbitrum meter.

## 10. Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Message to satellite not delivered | That satellite stalls at segment N (local nudges revert, as in the settlement window today) | Protocol executor retry; keeper backstop; permissionless `replaySegment` from published `(word, salt)` |
| Relayer / keeper key compromised | Can delay or stall a satellite | Cannot forge: satellite re-derives + verifies the char (§5). Delay only |
| Home VRF stalls | Whole game freezes on every chain | Single point, accepted cost of one meter. Same class as today's single-chain VRF risk |
| Home chain reorg before finality | Risk of propagating a retracted char | Broadcast only after home finality (§7) |
| Satellite offline for maintenance | Misses canonical rounds; its local count does not inflate | Resume on next delivered segment; gap visible in `localToCanonical` only |
| Duplicate / reordered message | — | No-op: `applySegment` is idempotent + monotonic (§7) |
