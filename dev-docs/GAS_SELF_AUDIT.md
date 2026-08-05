# Gas Self-Audit — TimbSwap Contracts

Internal, pre-external-audit gas review. Not a substitute for a formal audit;
a scope of findings we can act on ourselves and measure. Findings reference
`file:line` at the time of writing — re-check after any refactor.

- **Build:** solc 0.8.24, `via_ir = true`, `optimizer_runs = 200`, `evm_version = cancun`.
- **Target chain: UNDECIDED** — this reorders every priority (see §0).
- **Measure, don't guess:** `gas_reports = ["*"]` is already set. Run
  `forge test --gas-report` and `forge snapshot` / `forge snapshot --diff`
  before and after any change. Every claim below should be confirmed with real
  numbers.

---

## ⚠ Critical — buyback residual never reached the reward waterfall  *(FIXED in code, needs redeploy)*

Not a gas issue — a **liveness / economic defect** surfaced while auditing why
the epoch keeper funded nothing. Kept here because it's the most consequential
finding in this pass.

**Symptom.** Every epoch settlement since the keeper went live (epochs 4, 5, 6 —
07-18 → 07-21) reported `z=0.0` and granted **0** to farm / staking / boost,
while farm+staking demand grew into the tens of thousands of TIMBS. `boostBudget`
has been pinned at `"0"` in `epoch-state.json` since the first settlement.

**Two stacked root causes.**

1. **No buyback ever ran.** `TimbTreasury.executeBuyback` is `onlyOwner` and is
   called by *nothing* in the repo — no keeper step, no swap hook, no schedule.
   The 0.05% protocol fee accrues as ETH in the treasury and just sits there.

2. **Even if it ran, `z` was structurally zero.** The keeper computes the
   waterfall budget as `z = Σ(timbsBought − timbsBurned − timbsToStaking)` over
   `BuybackExecuted`. But the old `executeBuyback` split the purchase **100%**
   between burn and staking (`toStaking = received − toBurn`), so
   `bought − burned − toStaking ≡ 0` for every event, at any burn ratio. The
   treasury retained nothing; the keeper's funding variable could never be
   non-zero. The `z` formula wasn't wrong — the contract simply never produced a
   residual for it to measure.

**Fix (this change).** `executeBuyback` now splits **three** ways —
`burn / reserve / waterfall` — via `buybackBurnRatio` + `buybackReserveRatio`
(remainder = waterfall). Only the burn leaves the treasury; `reserve` and
`waterfall` both stay in the balance. The event emits `timbsToWaterfall`
explicitly (`= received − burn − reserve`), and the keeper now reads that field
directly as `z`. The direct-staking leg is removed — staking is funded through
the waterfall's `stakeGrant`, so no double-funding.

- Contract: `TimbTreasury.sol` — new `buybackReserveRatio`, three-way split,
  `BuybackExecuted(ethSpent, timbsBought, timbsBurned, timbsToWaterfall,
  timbsReserved)`, `setBuybackReserveRatio`, lifetime counters.
- Keeper: `epoch.js` — event ABI + `z = a.timbsToWaterfall`. No logic change.
- **Testnet split chosen:** burn **5%** / reserve **20%** / waterfall **75%**.
  Reserve is a solvency buffer that stacks sweep over sweep; both ratios are
  owner-tunable (`setBuybackBurnRatio` / `setBuybackReserveRatio`, capped so
  `burn + reserve ≤ 100`).

**Trigger (now automated).** The split fix makes buybacks *fundable*; a second
change makes them *fire*. The epoch keeper (`epoch.js`) now runs a **section 0**
on every invocation: it unwraps any WETH fee revenue, then spends the Treasury's
accrued ETH on `executeBuyback` with a computed `minTimbsOut` (constant-product
math, 15% default slippage floor for thin testnet pools). The keeper wallet is
already the Treasury owner, so `onlyOwner` authorises. Buybacks now accrue `z`
steadily across the epoch; settlement distributes it. Knobs (all optional, with
defaults): `BUYBACK_ENABLED`, `BUYBACK_MIN_ETH`, `BUYBACK_SPEND_BPS`,
`BUYBACK_SLIPPAGE_BPS`.

**Verify after redeploy:** run one buyback, confirm the `BuybackExecuted` event
carries a non-zero `timbsToWaterfall`, then confirm the next `EPOCH SETTLE`
prints `z > 0` and non-zero `farmGrant` / `stakeGrant` / `boostBudget`.

---

## 0. The chain question comes first

On **Arbitrum / any L2 rollup**, the dominant tx cost is **posting calldata to
L1**, not L2 compute or storage. Classic L1 wins (save an SLOAD, pack storage)
are **comparatively small on L2** — cheap L2 storage. What matters more on L2 is
**calldata size** (fewer / smaller function arguments).

- **Mainnet = Arbitrum One:** storage packing is a minor win — don't take
  redeploy risk for it. Focus on calldata shape and on the *frequency* of
  keeper-paid calls.
- **Mainnet = an EVM L1:** storage packing becomes a **major** win; do §2-Finding-1.

Decide this before spending effort.

---

## 1. Already good — leave it alone

- **AMM reserves packed canonically:** `reserve0(uint112) + reserve1(uint112) +
  blockTimestampLast(uint32)` = one slot, read once via `getReserves()`
  (`TimbSwapPair.sol:73-80`). Optimal V2 layout.
- **Custom errors everywhere** — no `require("string")` anywhere in `contracts/`.
  Saves deploy + runtime gas on every revert path.
- **Loops cache the storage array to memory first** before iterating — e.g.
  `claimWinnings` / `recycleUnclaimed`: `address[] memory winners =
  roundWinners[round]` (`TimbPrize.sol:703, 738`). Correct pattern.
- **viaIR on** — the IR optimizer already hoists common subexpressions and
  memory-array lengths.

---

## 2. Findings (prioritized)

### Finding 1 — Scalar storage packing in `TimbPrize` hot state  *(L1: high · L2: low)*
`currentRound`, `currentSegment`, `segmentStartTime`, the bools (`gameStarted`,
`shuffleEnabled`, `entriesPaused`, `settlementPaused`), and
`winnersPerRound` / `protocolCutBps` are each a full 256-bit slot
(`TimbPrize.sol:154-203`). They're read together ~40× across the contract, on
**every advance / settle / getRoundState**. They can collapse into ~1 slot:

| field | now | proposed | headroom |
|---|---|---|---|
| `currentSegment` | uint256 | `uint8` | 1–6 |
| `currentRound` | uint256 | `uint32` | 4.3B rounds |
| `segmentStartTime` | uint256 | `uint40` | ~35,000 years |
| 4× bool flags | 4 slots | 4 bits | — |
| `winnersPerRound`, `protocolCutBps` | 2 slots | `uint16` each | — |

**Savings:** several cold→warm SLOADs saved per keeper call (~2,000+ gas each on
L1). **Risk:** storage-layout change → redeploy (we're pre-mainnet, so free) and
full Foundry re-run. **Do only if mainnet = L1.**

### Finding 2 — `immutable` config addresses → NOT recommended
`prizeEscrow`, `gameRegistry`, `router`, `eligibleRegistry`, `settler`,
`yieldVault` look like immutable candidates but are set via `onlyOwner` setters
(`setRouter`, `setGameRegistry`, …). They're **deliberately re-wireable**;
keeping them mutable is worth more than the ~100 gas/read. **No change.**

### Finding 3 — `EligibleTokenRegistry.getEligibleTokens` double-loops a storage array  *(low)*
`EligibleTokenRegistry.sol:169-177` iterates `eligibleTokenList` twice, re-reading
`.length` (SLOAD) and each element (SLOAD) each pass. It's a `view` (usually
called off-chain → ~free). Cache `address[] memory list = eligibleTokenList` once
**only if** it's ever hit on a write path — confirm the router's on-chain
eligibility check doesn't call it before optimizing.

### Finding 4 — `optimizer_runs = 200` is chain-dependent
Higher runs lower *runtime* gas but grow bytecode. On **Arbitrum, larger bytecode
costs more to deploy** (L1 calldata) for little runtime gain — **leave at 200**.
On an **L1** target, raise it (≈1,000) for the hot contracts. Measure both ways.

### Finding 5 — Aim at frequency, not just per-call cost
Recurring gas is **keeper-paid**: `settleSegment` (~24×/day) + advance nudges +
the epoch `distribute`. That's where savings compound into real protocol cost.
When profiling, target those line items first, regardless of chain.

---

## 3. Batched entry — a design win, not a bug

**"A 12-round ticket costs the same gas as a 1-round ticket."**

`submitEntry(string6, useETH, extraRounds)` (`GameRegistry.sol`) mints **one**
`Ticket` covering a **range** — `playRound → playRound + extraRounds` — not one
entry per round:

```solidity
_mintTicket(msg.sender, string6, playRound, playRound + extraRounds, ...);
```

So playing 12 rounds and playing 1 round write the **same struct** (same gas);
`extraRounds` only bumps `lastEligibleRound`. Even the surcharge is a **single**
transfer: `additionalCost = extraRounds * entryCostTIMBS` → one
`safeTransferFrom`, not N.

**Entering 12 rounds one-at-a-time would cost ~8–12× more gas**, paying every
time:
- the **21,000-gas base tx cost** (×12 ≈ 252k just to start the txs),
- **calldata posting** ×12 (the dominant term on Arbitrum),
- a **full `Ticket` struct write** ×12 — that struct has ~14 fields over many
  slots; a new non-zero slot is a ~22,100-gas cold `SSTORE`. Writing it once vs
  twelve times is the single biggest difference.

Rough shape: batch ≈ *one mint + one base tx* (~250–350k gas, once) vs
individual ≈ *twelve mints + twelve base txs + twelve calldata payloads* (~3–4M
gas total).

Notes:
- **Economic cost is identical** either way — 12 rounds = `12 × entry` in TIMBS
  regardless. The difference is purely gas + calldata.
- **You can't hold 12 tickets in parallel anyway:** `activeTicketOf` /
  `ActiveTicketExists` enforces **one live ticket per wallet**; a new entry while
  one's live reverts or concedes the old one. `extraRounds` is the *intended*
  multi-round path — and the cheap one. The design nudges users to the efficient
  route.

---

## 4. Not yet reviewed
- Per-segment mappings (`segmentDigitCounter/Locked/Char`) — a per-round struct
  could pack, but it's a larger refactor; deferred.
- `TimbSwapRouter` multi-hop calldata shape (relevant on L2).
- `TimbBoostFarm` / `TimbStaking` reward-accrual loops.

## 5. Next actions
1. **Redeploy `TimbTreasury`** with the three-way buyback split (Critical
   finding) + protocol-owned liquidity. Update `config.js` `TimbTreasury`
   address, re-authorise fee senders (router + TimbPrize), reset the
   pair/escrow/staking wiring, **call `setRouter`** (enables
   `provideLiquidity` / `provideLiquidityETH` — LP held by the treasury), then
   reset the epoch keeper genesis so `z` scans start from the new deploy. Verify
   one buyback → non-zero `timbsToWaterfall` → non-zero grants at the next
   settle. `Deploy.s.sol` already wires `setRouter` and uses the 5-arg
   constructor.
2. **Buyback trigger — done.** Automated in `epoch.js` section 0 (unwrap WETH →
   spend accrued ETH via `executeBuyback` with slippage floor). Watch the first
   few live runs: confirm a `BUYBACK` line with non-zero `expectedOut`, then a
   later `EPOCH SETTLE` with `z > 0`. Tune `BUYBACK_SPEND_BPS` / slippage if the
   thin pool moves too much per buy.
3. **Decide mainnet chain** (Arbitrum One vs L1) — gates Finding 1 and Finding 4.
4. Run `forge test --gas-report` + `forge snapshot` to baseline real numbers.
5. If L1: implement Finding 1 behind a re-tested PR, confirm with
   `forge snapshot --diff`.

---

## v5 — Dynamic entry pricing  *(deployed `0xBAb1…8530`)*

Entry costs moved from static (`setEntryCosts`) to computed-on-chain, **fixed
per round**: ETH = `escrow ≤ 1.1 ETH ? 0.001 : escrow/1000`; TIMBS =
`2 + activeTimbEntries` with a ±2 deadband. Notes across the three axes.

### Gas
- **First entry of a round** now also runs `_fixPricesForRound`, writing
  `fixedEthCost`, `fixedTimbsCost`, `pricedForRound` and (on a TIMBS re-fix)
  `timbsPriceRefCount` — up to ~4 SSTOREs on the round's opening entry.
  Subsequent entries hit the `pricedForRound` early-return and pay only the
  meter bump.
- **Every entry** bumps one meter (`totalEthEscrow` or `activeTimbEntries`);
  **every terminal exit** (cancel / refund / forfeit / admin) decrements it once
  via `_onTicketDeactivated` — one extra SLOAD+SSTORE per entry and per exit vs v4.
- **`setEntryCosts` removed** — one fewer governance function + its slots.
- Baseline with `forge test --gas-report` on `GameRegistryDynamicPricing.t.sol`
  before/after any refactor.

### Security invariants (reviewed)
- **Per-round price lock:** price is fixed on the round's *first* entry and held
  via the `pricedForRound` guard → no intra-round price MEV; nobody can spike
  your cost after you've committed within the round.
- **Seat conservation:** +1 at submit, −1 at exactly one terminal exit.
  `_onTicketDeactivated` is generation-scoped and underflow-guarded (can't go
  negative or double-count). Concession (`replaceEntry`) is net-neutral (seat
  carries to the replacement); expiry is *not* terminal (ETH stays escrowed
  through the refund window). Covered by the 12 tests in
  `GameRegistryDynamicPricing.t.sol`.
- **Escrow-driven ETH price** (`escrow/1000`): a whale could inflate escrow to
  make ETH entries dear — but that ETH also backs the pot they're competing for,
  so it's self-aligning. Considered, benign.
- **Vault weight decoupled:** activation registers a constant `VAULT_WEIGHT_UNIT`
  (1e14, ETH-denominated) for both tokens, so yield share is uniform per ticket
  regardless of the variable cost.
- **Migration:** the old v4 registry (`0xfca8…B5B4`) keeps its in-flight tickets,
  reclaimable there via `reclaimFromPastGame`; the shared vault carries
  negligible stale weight until those exit.

### Frontend / DebugHub
- ETH cost floats, so a round rollover between the quoted price and a landing tx
  can undershoot `msg.value` → `WrongEscrowAmount` (`0x0ee6446f`). `compete.js`
  now re-reads `entryCostETH()` immediately before `submitEntry` and sends a +2%
  buffer (refunded on-chain) to absorb the drift, and `ENTRY_REVERTS` decodes
  `WrongEscrowAmount` (+ `ActiveTicketExists`, `NoLiveTicket`, `ContractPaused`)
  to plain-language guidance.
- TIMBS side is unaffected: the frontend approves `MaxUint256`, so allowance is
  never the binding constraint under a moving price.
