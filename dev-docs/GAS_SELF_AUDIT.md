# Gas Self-Audit — TimbSwap Contracts

Internal, pre-external-audit gas review. Not a substitute for a formal audit;
a scope of findings we can act on ourselves and measure. Findings reference
`file:line` at the time of writing — re-check after any refactor.

- **Build:** solc 0.8.24, `via_ir = true`, `optimizer_runs = 200`, `evm_version = paris`.
- **Target chain: UNDECIDED** — this reorders every priority (see §0).
- **Measure, don't guess:** `gas_reports = ["*"]` is already set. Run
  `forge test --gas-report` and `forge snapshot` / `forge snapshot --diff`
  before and after any change. Every claim below should be confirmed with real
  numbers.

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
1. **Decide mainnet chain** (Arbitrum One vs L1) — gates Finding 1 and Finding 4.
2. Run `forge test --gas-report` + `forge snapshot` to baseline real numbers.
3. If L1: implement Finding 1 behind a re-tested PR, confirm with
   `forge snapshot --diff`.
