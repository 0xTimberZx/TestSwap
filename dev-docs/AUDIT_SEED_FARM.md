# Audit finding: the table seed is Sybil-farmable (§9 gate)

**Scope:** the live generation-8 board (`SegmentBoardVRF`), `PoolLedger`,
`UnderwriteReserve`. Read against deployed source, not from memory.
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

### Same gate, same flaw: DDJackpot

`DDJackpot`'s "2+ DD wallets" strike gate is the identical construction and has
the identical weakness. Not quantified here; fold it into the same gen-9 change.

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

### Sketch

- `openTable`: replace `ledger.fundSeed(seedFunder, TABLE_SEED, tableId)` with a
  transfer of `TABLE_SEED` into the reserve (a new `reserve.fundSeed`-style
  intake, booked as float income — it may raise `floatTarget` behaviour, decide
  during design).
- `_potOf`: drop the `if (n >= SEED_MIN_WALLETS) pot += SEED_SHARE` line. `SEED_SHARE`
  and `SEED_MIN_WALLETS` disappear from the board.
- `retire`: the seed no longer sits in table escrow, so there is no unconsumed
  seed to sweep; the sweep is now purely rake + dead pots, unchanged otherwise.
- `DDJackpot`: apply the same principle to its strike funding.

This changes the board's constructor/settlement surface, so it ships with the
next board deploy, verified fresh on Sourcify.

---

## Reproduction

```
forge test --match-contract SeedFarmExploitTest -vvv
```

`test_TwoWalletHedgeFarmsTheSeed` passes today — green means the vulnerability is
present exactly as described. When the gen-9 reroute lands it flips red (the
operator no longer profits), which is the regression signal that the fix worked.
The two "already safe" tests must stay green across the change.
