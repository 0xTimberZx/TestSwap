# Governance hardening — M1 / M3 / M6

Closes the three centralization / trust-model findings from the self-audit
before mainnet. Inspired by the Overtime/Thales authorization conventions:
two-step ownership, least-privilege operator roles instead of a raw owner key,
a single auditable place to re-point money flows, and a timelock+multisig as the
privileged owner so every dangerous action is delayed and public.

None of these findings let an attacker take player funds today without the owner
key — they are key-compromise / trust-minimization items. After this change a
compromised owner key is bounded by a timelock delay, a per-window operator cap,
and a guardian kill-switch.

---

## What changed in code

### M3 — GameRegistry: no admin confiscation of player escrow
`adminAbsorbEscrow` used to sweep a ticket's escrow to `protocolSink`, letting
the owner mark any live ticket `Ineligible` and seize a player's stake. It is
renamed **`adminRefundStuck`** and its destination is hard-wired to
**`t.owner`** — the admin path can now only ever *refund the player*, never the
sink, so the owner gains nothing by misusing it. `adminMarkIneligible` is
unchanged (status only, moves no funds). Legitimate §14 forfeiture of a
claim-window-lapsed ticket to the sink still happens automatically in the
settlement sweep; that path is untouched.

### M1 — TimbTreasury: rate-limited operator, timelock for the rest
- `Ownable2Step` (two-step ownership handoff).
- New **operator** role: may call `withdrawOperational` (ETH) and `unwrapWeth`,
  but ETH withdrawals are capped to `operatorEthCap` per rolling
  `operatorPeriod`. The cap defaults to **0**, so the operator can do nothing
  until the owner funds the allowance.
- Everything dangerous — uncapped withdrawals, `withdrawToken` (ERC20 sweeps),
  and re-pointing outflow targets (`setRouter`, `setPrizeEscrow`,
  `setTimbsEthPair`, `setWeth`, `setTimbStaking`) — stays `onlyOwner`, i.e. the
  timelock.

### M6 — UnderwriteReserve: single-holder, revocable ledger allowance
- `Ownable2Step`.
- `approveLedger` now tracks the approved `ledger` and **zeroes the previous
  one's allowance** on re-approval, so stale infinite allowances can never
  accumulate — at most one address is ever approved.
- New **`revokeLedger()`** — owner *or* guardian — is a fast kill-switch that
  needs no timelock delay. The guardian's existing `drainToTreasury` remains the
  ultimate rescue (empties the float to the immutable treasury).

### Governance topology
- `scripts/Deploy.s.sol` deploys an OZ **`TimelockController`** with the
  multisig (`GOV_MULTISIG`) as sole proposer and executor and `admin =
  address(0)` (self-administered — no one can re-grant roles to bypass the
  delay). `TIMELOCK_MIN_DELAY` defaults to 48h.
- Ownership is **not** transferred in the deploy script — that is a post-verify
  runbook step (below), so a wiring mistake can't strand setup behind the delay.

---

## Deploy runbook

### 1. Env
```
GOV_MULTISIG=0x…            # Gnosis Safe (2-of-3 / 3-of-5) — proposer+executor
TIMELOCK_MIN_DELAY=172800   # 48h (optional; this is the default)
```
Deploy as usual. The script logs `TimelockController: 0x…`.

### 2. Verify the system first
Run the full bring-up (liquidity, rewards, VRF subscription, `startGame`, a live
round) with the **deployer** still as owner. Only hand off once everything works
— a timelock makes fixes slow, so you want them done first.

### 3. Configure the treasury operator (optional, do before handoff)
The operator is your hot ops wallet for routine gas/expense spend:
```
treasury.setOperator(<opsWallet>)
treasury.setOperatorEthCap(<capWeiPerWindow>, 1 days)
```
Pick a cap that covers routine spend but not a meaningful fraction of the float.

### 4. Hand ownership to the timelock (two-step, per contract)
For each of **TimbTreasury**, **GameRegistry**, **UnderwriteReserve**:

1. As the current owner (deployer):
   ```
   contract.transferOwnership(<timelock>)
   ```
   Ownership does **not** move yet — `pendingOwner` is set.
2. Have the multisig schedule + execute, through the timelock, a call to:
   ```
   contract.acceptOwnership()
   ```
   (`TimelockController.schedule(...)` then `execute(...)` after the delay,
   targeting each contract's `acceptOwnership()` selector.)

`UnderwriteReserve` keeps its **guardian** as the fast halt/drain/`revokeLedger`
role — set it to a wallet (or a smaller multisig) that can react faster than the
timelock in an emergency.

> Consider also moving `TIMBSToken`, `TimbPrize`, `PrizeEscrow`,
> `EligibleTokenRegistry`, and the reserve/registry owners of the board stack to
> the same timelock in a follow-up. This PR scopes the handoff to the three
> audited money-critical owners (M1/M3/M6).

### 5. After handoff
- Every owner action (param changes, retargeting, uncapped withdrawals) is now a
  timelock proposal from the multisig, visible for `TIMELOCK_MIN_DELAY` before it
  can execute.
- Routine ops ETH spend goes through the operator, instantly, up to its cap.
- Publish the trust model (what the timelock/guardian/operator can and cannot do)
  alongside the audit.

---

## Tests
- `tests/GovernanceHardening.t.sol` — M3 refund-to-owner (+ owner-gated, reverts
  when not Ineligible), M6 single-holder/revocable allowance, Ownable2Step
  two-step transfer.
- `tests/TimbTreasury.t.sol` — operator cap enforced, window rolls, owner
  bypasses the cap, stranger rejected, operator disabled by default.
