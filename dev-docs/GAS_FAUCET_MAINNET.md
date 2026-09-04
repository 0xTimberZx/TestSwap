# Gas faucet — mainnet architecture (reserve-backed, atomic, fair-release)

The testnet faucet (see `FAUCET_SPEC.md`) is a hot wallet that sends its own
ETH. For mainnet it becomes an **atomic, treasury-backed dispenser** that, per
eligible claim, hands out gas ETH, grows the round pot, **and issues 1 TIMB** —
a participation-gated "fair release". This doc covers the on-chain side
(`contracts/GasFaucet.sol`); eligibility, cooldown, and the off-chain gatekeeper
are unchanged from `FAUCET_SPEC.md`.

Status: **contract drafted (design stub, UNAUDITED)**. Not wired on testnet —
testnet keeps the simple hot-wallet worker. Audit before mainnet.

## Decisions (locked)

| Question | Choice | Why |
|---|---|---|
| ETH source | **Treasury operator role** | Treasury already holds ETH and has a rate-limited `operator` (`withdrawOperational`, capped per window). No new fund-custody contract, no funded hot wallet. |
| Dispense shape | **Atomic `GasFaucet` contract** | ETH drip + pot + 1 TIMB in ONE tx; on-chain eligibility + cooldown; provable 1-TIMB-per-claim. |
| ETH pause / TIMBS pause | **Independent** | `ethPaused` and `timbsPaused` are separate switches — pause one leg, the other still runs. |
| Max approved to distribute | **Per-asset cumulative caps** | `ethCap` / `timbsCap` bound lifetime outflow; raising a cap "approves" more. |

## What one claim does (`dispense(claimant)`, atomic)

1. **Eligibility** — `registry.effectiveStatus(registry.activeTicketOf(claimant))
   == Active`. The active ticket (which cost gas + escrow to mint) is the Sybil
   gate. Enforced on-chain, so a leaked dispatcher key can't bypass it.
2. **Cooldown** — `lastClaimAt[claimant] + cooldown <= now` (default 24h).
3. **ETH leg** (if `!ethPaused`): pull `dripEth + potEth` from the treasury via
   `withdrawOperational(faucet, …)`, send `dripEth` to the claimant, and
   `potEth` to `TimbPrize.addToPot()`.
4. **TIMBS leg** (if `!timbsPaused`): transfer `timbsPerClaim` (default 1e18 =
   1 TIMB) from the faucet's pre-funded balance to the claimant.
5. Stamp cooldown; bump `ethDistributed` / `timbsDistributed`; emit `Dispensed`.

Both legs are cap-checked before anything moves (checks-effects-interactions +
`nonReentrant`).

## Funding model (asymmetric — dictated by the treasury's access design)

The treasury's `operator` can move **ETH** but **not ERC20** — ERC20 sweeps stay
with the timelock owner on purpose (`GOVERNANCE_HARDENING.md`). So:

- **ETH stays in the treasury** and is pulled live per claim (operator path). Two
  ceilings apply: the treasury's `operatorEthCap`/window *and* the faucet's own
  `ethCap`.
- **TIMBS is pre-funded into the faucet.** The owner moves the approved budget in
  with `TimbTreasury.withdrawToken(TIMBS, faucet, budget)` (owner-only). The
  faucet dispenses from its balance; the owner tops it up; `recoverTimbs` returns
  the unused remainder. `timbsCap` bounds lifetime TIMBS outflow independently of
  the balance on hand.

> Rejected alternative: adding a capped operator-ERC20 path to the treasury.
> That widens the operator role the governance design deliberately keeps narrow,
> so we pre-fund instead.

## Roles

- **owner** (Ownable2Step; mainnet = timelock+multisig) — caps, params, wiring,
  recovery, pause/unpause.
- **guardian** — may flip either pause switch (fast kill), alongside the owner.
- **dispatcher** — the keeper worker EOA; the only address (besides the owner)
  that may call `dispense`. On-chain eligibility + cooldown are defense in depth
  behind it.

## Deploy / wire (runbook, mainnet)

1. Deploy `GasFaucet(treasury, TIMBS, GameRegistry, TimbPrize, dripEth, potEth,
   1e18, 24h)`.
2. `treasury.setOperator(faucet)` and `treasury.setOperatorEthCap(cap, 1 days)`
   — sized to `active_tickets × (drip+pot)` with headroom.
3. `faucet.setEthCap(...)` and `faucet.setTimbsCap(...)` — the approved budgets.
4. `treasury.withdrawToken(TIMBS, faucet, timbsBudget)` — pre-fund the TIMBS leg.
5. `faucet.setDispatcher(keeperEOA)`; `faucet.setGuardian(guardian)`.
6. Point `scripts/faucet-worker.js` at `faucet.dispense(...)` instead of raw
   sends (worker rewrite — see below); keep the edge-function gatekeeper +
   Postgres cooldown as the first line, with the on-chain checks as backstop.

## Still to do (not in this drop)

- **Audit** — custodies treasury ETH access + a TIMBS budget.
- **Foundry tests** — `tests/GasFaucet.t.sol` (happy dual-dispense, each pause,
  each cap, cooldown, eligibility, recovery).
- **Worker rewrite** — `faucet-worker.js` to call `dispense` as dispatcher (one
  tx per claim) instead of drip + `addToPot` as two raw sends.
- **Deploy script** — `scripts/DeployGasFaucet.s.sol`.
- **Cold-start** is still out of scope (a zero-ETH wallet can't mint the first
  ticket) — same caveat as `FAUCET_SPEC.md` §7.
