# Audit finding: the table seed is Sybil-farmable (§9 gate)

**Scope:** the (now retired) generation-8 board (`SegmentBoardVRF`), `PoolLedger`,
`UnderwriteReserve` — the generation live when this was found; gen-9 shipped the fix.
Read against deployed source, not from memory.
**Status:** confirmed, reproducible (`tests/SeedFarmExploit.t.sol`).
**Severity:** economic — a repeatable, risk-free extraction of house funds. Not
a custody bug: the escrow accounting is sound and no player credit is reachable.
**Remediation:** generation 9 (the gen-8 board is immutable). Design below.

---

## What is safe

Three things were checked and hold:

- **Pot flow.** The invariant `balance >= totalCredited + totalEscrowed` holds on
  every path. `creditWinnings` cannot pay more than a table's own escrow;
  `sweepTable` takes a table id, not an amount, so a cross-table sweep is
  unrepresentable (the old `sweep(to, amount)` bug, VALIDATION #11, is gone);
  `ownerWithdraw` is capped to genuine surplus. No double-spend, no cross-table
  reach.
- **Solo tables.** A one-wallet table can never arm (`armSegment` requires
  `loadedCount >= SEATS_MIN = 2`), so it never settles. The only exit is
  `cancelTable`, which refunds every chip. There is no solo-settlement path.
  (`test_OneWalletCannotArmASoloTable`.)
- **The underwrite reserve.** It tops a genuine winner toward
  `stake x fair x 0.90` — strictly below fair — and only on a real win. Every
  solo-bet EV is negative, so it rewards play and cannot be drained by it.
  (`test_UnderwriteIsNotFarmable`.)

## The finding

The §9 gate is *"a pool draws the table seed share only if it has `>= 2` distinct
wallets."* It was meant to stop seed-farming. It stops a **single** wallet
self-dealing. It does not stop **two**, and on a permissionless chain two wallets
are free.

### The hedge

One operator, two wallets. Wallet A bets **Red** on every segment, wallet B bets
**Black** on every segment. Colours partition all 36 symbols, so exactly one of
them wins each pool — always one of the operator's *own* wallets. The winning
pool includes the seed share, so the operator harvests it.

Per segment, 5-chip each:

| | |
|---|---|
| pot | `10 chips + SEED_SHARE 14.29 = 24.29` |
| `rake(2)` | `175 + 625/2 = 487 bps` |
| distributable → the winning wallet | `23.10` |
| operator stake | `10` |
| **net** | **`+13.10`, risk-free** |

Hedge all six segments: **`+78.62` TIMBS from a 100-TIMBS seed, every table.**
The house recovers only ~21% (rake + the unclaimed DD seed share). The exact
numbers are asserted in `test_TwoWalletHedgeFarmsTheSeed`, and hold for arbitrary
VRF words because the hedge is outcome-independent.

`Low/High` is a second even-money partition; the operator can vary between them.
Open → sit → load → hedge → arm → lock → retire → withdraw is permissionless end
to end.

### Why a bigger threshold doesn't fix it

A gate of `N` distinct wallets costs an attacker `N` wallets. Sybil-resistance
is not achievable on-chain, so **no fixed threshold closes this.** The seed must
not sit anywhere a winner can claim it without genuine risk.

### Blast radius (why it is a slow leak, not a catastrophe)

Bounded to `<= ~79` TIMBS per table, rate-limited by the entry windows and
`pickTime`, and gated on the **seedFunder** (a known ops wallet) continuing to
approve. The guardian can `setNewTablesHalted(true)` to stop it dead. Testnet
play-chips. But it is a real, repeatable, risk-free extraction by the mechanism
explicitly named "anti-farm," so it is worth fixing rather than tolerating.

### Same gate, same flaw: DDJackpot (quantified — accepted, not fixed)

`DDJackpot`'s "2+ DD wallets" strike gate (`MIN_DD_WALLETS = 2`) is the identical
§9 construction and has the identical Sybil weakness: two free wallets clear it.
Unlike the seed, this one is **accepted as bounded operational risk** rather than
reworked. The reasoning, quantified:

**The farm.** Two wallets each load segment tokens (to hold a seat) but *place*
nothing on the segments — unplaced loads refund at `retire`, so they cost
nothing — and each places one Double-Digit chip. On the two attacker wallets
being the only DD bettors, a strike pays them the whole metered slice. Their only
at-risk capital is the two DD chips, lost as a dead pot when the DD misses.

**The math (`sliceBps = 20%`, `sliceFloor = 50`, `stakeCapMult = 10`, min chip = 5),
confirmed by simulation:**

- **P(DD hit) = 0.3557 per table.** The winning string is six symbols over an
  alphabet of 36; a DD needs a repeat. `P = 1 − ∏_{k=0}^{5}(36−k)/36 = 0.3557`
  (exact and 5M-draw Monte-Carlo agree). Not rare — ~1 table in 2.8.
- **It is +EV at every jackpot balance.** With minimum chips the per-round edge
  runs from **+11.3 TIMBS** (pot at/near the floor, strike pays the 50 floor) to
  **+29.1 TIMBS** (fat pot, strike capped at `2 × 10 × chip = 100`). Break-even
  would need the strike to pay under 18.1 TIMBS; the 50 floor is far above it.
  **Rarity does not save us here** — the hit is common and the expectation is
  positive, so this is genuinely +EV, unlike a true "needs a rare event" hurdle.

**Why it is nonetheless acceptable — and why there is no on-chain fix that keeps
the feature:**

- **No reroute exists.** The seed fix worked because the seed's *job* (sweeten
  thin winners) could move to the capped underwrite. The jackpot payout *is* the
  feature — there is nothing to reroute it to. Any Sybil defence reduces to a
  bigger wallet threshold, which fails identically (Sybil-resistance is
  impossible on-chain).
- **The edge is small and does not scale super-linearly.** Bigger DD chips raise
  the payout but the per-wallet cap (`stakeCapMult × chip`) and the larger
  at-risk stake on the 64% miss keep the edge roughly proportional, not runaway.
- **It requires attacker-controlled empty tables.** The slice is split pro-rata
  with every DD bettor; once honest players sit in the DD pool, the cap collapses
  the attacker's share to "just another DD player." The clean farm only exists on
  tables the attacker fully owns — which is the legible signature below.
- **Worst case is a slow bleed of donated float, never insolvency.** The pot only
  ever holds recycled/donated TIMBS (no minting, no player escrow, no reserve
  float). An attacker can at most drain what was donated to the banner.
- **The meter bounds the rate but not the sign.** `setMeter` can lower `sliceBps`
  and raise `stakeCapMult`, shrinking the edge, but only `stakeCapMult = 1`
  (payout = one chip = a wash) removes it — and that guts the prize for honest
  players too. There is no meter setting that keeps a real jackpot and is −EV to
  the farmer.

**Decision (2026-08): accept with controls, do not redeploy.**

- Fund the banner modestly from recycled TIMBS; treat any drained float as a
  marketing cost, not a solvency event.
- Monitor for the signature: the same wallet pair striking repeatedly on
  otherwise-empty tables is fully legible on-chain (`JackpotStruck` +
  `betCount(tableId, DD_POOL) == 2` with both bets from linked wallets).
- Guardian `setHalted(true)` stops all strikes instantly if abuse appears; the
  banner keeps climbing while halted, so honest play resumes cleanly on unhalt.
- Revisit only if a future generation finds a payout mechanic that isn't a
  distributable pot (as the seed reroute did for the seed).

---

## The fix: route the whole seed to the reserve

**Don't add the seed to the distributable pot at all.** At `openTable`, push the
100-TIMBS seed to the `UnderwriteReserve` instead of table escrow. Pools then
distribute **only the players' own chips** — pure pari-mutuel among money
genuinely at risk. The house still sweetens thin winners, but only through the
capped underwrite path, which is already proven un-farmable.

```
  TODAY                              GEN-9
  seedFunder --100--> tableEscrow    seedFunder --100--> UnderwriteReserve
    settle: contested pool             settle: pool pays player chips only
      pot += SEED_SHARE                  no house money in the pot
      winner takes it  <-- FARMED        _underwrite tops thin winners
                                           toward stake x fair x 0.90 (capped)
```

A visual of both flows with the math annotated:
<https://claude.ai/code/artifact/ba9ec2bd-63b2-466c-8440-1fb47939f6b2>

### Honest winners are unaffected

The top-up backstops a genuine winner to `stake x fair x 0.90` regardless of
where the seed sits. Worked example — a 25-chip Vowels winner against one
opponent:

| | pool pays | reserve top-up | **winner receives** |
|---|---|---|---|
| today (seed in pot) | 61.16 | 73.84 | **135.00** |
| gen-9 (seed to reserve) | 47.56 | 87.44 | **135.00** |

Identical total. The reserve simply covers more of the same payout. The only
player who receives less is one whose pool *already* overshot the fair target
without the seed — and that surplus-above-fair was house money, precisely the
piece the hedge was engineered to capture. Fair winnings are untouched.

### Why the fix is also simpler

The seed stops being a per-pool special case in `_potOf` and `_settlePool`. It
becomes one call at open (reserve income) and the pari-mutuel math reduces to
"distribute the chips." Less surface, not more.

### As shipped (`contracts/SegmentBoardVRF9.sol`)

The reroute is smaller and safer than the first sketch (which transferred the
seed straight to the reserve at `openTable`). Keeping the seed in table escrow
until `retire` means a cancelled table refunds it to the seed funder with no
special case. Three surgical changes to a gen-8 copy:

- `openTable`: **unchanged** — `ledger.fundSeed(seedFunder, TABLE_SEED, tableId)`
  still parks the 100 TIMBS in *table escrow*. It is now simply never added to a
  pot, so it sits untouched through settlement.
- `_potOf`: the `if (n >= SEED_MIN_WALLETS) pot += SEED_SHARE` line is **gone**.
  `SEED_SHARE` is removed entirely; pots are the players' own chips only.
  `SEED_MIN_WALLETS` stays, now gating only the rake (an uncontested pool is
  rake-free), no longer any seed.
- `retire`: the whole seed is swept to the reserve alongside dead pots and half
  the rake — `toReserve = dead + rakeHalf + TABLE_SEED`. It moves *physically*
  via `sweepTablePartial`; it is deliberately **not** reported through
  `recordIncome`, so `gameIncome` stays a measure of what the game earned (rake +
  dead pots) while the seed is house-provided float. The reserve's waterfall keys
  off its balance, not `gameIncome`, so the seed parks into float/overflow
  correctly regardless.
- `cancelTable`: **unchanged** — the untouched seed is part of the leftover it
  already sweeps back to the seed funder. A cancelled table returns the seed
  automatically.
- `DDJackpot`: **not** changed — see the quantified accept-with-controls decision
  above. Its payout is the feature, so there is nothing to reroute.

`PoolLedger`, `VRFEntropy` and `UnderwriteReserve` bytecode are untouched but are
redeployed fresh per generation (immutable board pointer);
`scripts/DeploySegmentBoardVRF9.s.sol` wires the set. `SegmentBoardVRF9` verifies
fresh on Sourcify at deploy.

### Proof it works

`tests/SeedFarmClosed.t.sol` runs the *identical* two-wallet Red/Black hedge from
`SeedFarmExploit` against gen-9:

- `test_HedgeNoLongerFarmsTheSeed` — the operator now nets a small **loss** (the
  rake), not the +78 seed harvest; the whole seed lands in the reserve.
- `test_HonestContestedWinnerStillToppedToTarget` — a genuine contested winner
  still reaches `stake × fair × 0.90` (25-chip → 810), unchanged from gen-8.
- `test_FullRoundSettlesAndLedgerDrains` — escrow-sacred holds, table escrow
  resolves to zero, and every credit withdraws.

---

## Reproduction

```
forge test --match-contract SeedFarmExploitTest -vvv
```

`test_TwoWalletHedgeFarmsTheSeed` runs against the retired gen-8 board and stays
green — proof the vulnerability was present exactly as described. The gen-9 fix
has shipped: `tests/SeedFarmClosed.t.sol` runs the same hedge against
`SegmentBoardVRF9` and the operator no longer profits (a small rake loss). The
two "already safe" tests remain green across both.
