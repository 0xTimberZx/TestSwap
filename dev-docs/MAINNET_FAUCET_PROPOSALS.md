# Mainnet GasFaucet — sizing sheet + treasury proposal payloads

Everything the Safe signers need to wire the mainnet `GasFaucet` to the live
Arbitrum One treasury, prepared **before** the faucet is deployed so launch day
is paste-and-sign, not arithmetic. Companion to `GAS_FAUCET_MAINNET.md`
(design), `env.mainnet.example` (deploy env), and `CAPPED_BETA_GUARDRAILS.md`
§1 (the lever table these numbers land in).

Status: **prepared, nothing executed.** No mainnet faucet exists yet. The
treasury is still owned by the deployer (handoff to the timelock pending —
`MAINNET_DEPLOY_RUNBOOK.md` §6), which changes *how* the three treasury calls
are sent (§2.3) but not *what* they are.

> Addresses here are public on-chain facts. No keys belong in this file, and no
> key should ever be pasted into a chat or screenshot to execute any of it.

---

## 0. Decisions this doc records

| Decision | Choice |
|---|---|
| Mainnet "fair release" of TIMBS | **The faucet's TIMBS leg only** — 100 TIMBS per eligible claim against a 500,000 TIMBS Era-1 budget, gated on a live *mainnet* ticket. See `EMISSIONS_SCHEDULE.md` §7. |
| Testnet-claim → mainnet-TIMB airdrop route | **Retired before mainnet launch.** Stays paused, float recovered to the Safe (§5; `MAINNET_AIRDROP_SPEC.md` §15). |
| Faucet owner during the beta | **The Safe directly** (fast pause), same posture as the airdrop distributor — not the timelock. |
| Treasury calls | Owner-only, so **deployer tx pre-handoff / timelock proposal post-handoff** (§2.3). |
| Scope framing | The faucet is launch facilitation, not core protocol scope; it may or may not survive into a later era of TIMBS. Every lever below is reversible in one tx. |

---

## 1. Sizing sheet

### 1.1 What the mainnet registry changes

On Sepolia the faucet was TIMBS-only (the old treasury has no operator role). On
mainnet both ETH legs are live and their size is anchored to the registry's
**dynamic entry price**:

- `GameRegistry.entryCostETH()` floors at **0.001 ETH** while `totalEthEscrow`
  ≤ 1.1 ETH, then tracks `escrow / 1000`. At launch, the floor is the number.
- A claim must never be worth a ticket: **`dripEth + potEth < entryCostETH()`**.
  Read `entryCostETH()` on deploy day and re-check this before every `setParams`.

### 1.2 The one principle: the cap is the budget

Sybil resistance on mainnet comes from the ticket (real ETH escrow + real gas)
**and** from the treasury's rolling cap. Once `operatorEthCap` is spent for the
window, `dispense()` reverts on `OperatorCapExceeded` — extra wallets dilute
each other's share of a fixed daily budget; they never widen the spigot. So
size the per-claim numbers for a *good player experience* and size the caps for
*what you are willing to spend per day*, independently.

### 1.3 Proposed numbers (confirm on deploy day)

| Quantity | Formula | Launch estimate | Proposed value |
|---|---|---|---|
| `dripEth` | ~5–10 Arbitrum txs of gas | — | **0.0002 ETH** (`2e14`) |
| `potEth` | ~10 % of `entryCostETH()` | floor 0.001 ETH | **0.0001 ETH** (`1e14`) |
| per-claim ETH | `dripEth + potEth` | must be `< entryCostETH()` | **0.0003 ETH** (30 % of floor ✓) |
| `timbsPerClaim` | fixed | — | **100 TIMBS** (`1e20`) |
| `cooldown` | one claim per wallet per day | — | **86400** |
| `operatorEthCap` (treasury) | `active_tickets × per-claim ETH × 1.5` | 100 tickets | **0.05 ETH / 24 h** (`5e16`, period `86400`) |
| `ethCap` (faucet, lifetime) | ~1 month at the daily cap | 30 × 0.03 ETH = 0.9 | **1.5 ETH** (`1.5e18`) |
| `timbsCap` (faucet, cumulative) | Era-1 fair-release budget | 100/day × 100 × 30 d = 300,000 | **500,000 TIMBS** (`5e23`) |
| TIMBS pre-fund (float) | ~30 % of the cap | — | **150,000 TIMBS** (`1.5e23`), top up in tranches |
| `maxTimbsPerWallet` | era budget ÷ wallets to serve | 500,000 ÷ 100 | **5,000 TIMBS** (`5e21`) — 50 claims a wallet |
| treasury ETH on hand | ≥ 30 days × `operatorEthCap` | — | **≥ 1.5 ETH** before enabling the operator |

Rules that keep the table honest:

- **Both ETH ceilings apply** — the treasury's rolling `operatorEthCap` *and*
  the faucet's cumulative `ethCap`. The rolling one is the daily brake; the
  cumulative one is the "approve more" lever (raise it in one owner tx).
- **Cap what one wallet can take.** The cooldown paces a wallet, it does not
  stop it: over Era 1 (250 days at one claim a day) a single wallet can claim
  251 times for 25,100 TIMBS, so **~20 dedicated wallets absorb the entire
  500,000 budget**. `setMaxTimbsPerWallet` bounds that without touching the
  cooldown or the ticket gate; 0 disables it. At 5,000 TIMBS a wallet, at least
  100 distinct wallets are served and no one wallet exceeds 1 % of the budget.
- **Float ≤ ~30 % of `timbsCap`**, topped up from the treasury via
  `withdrawToken`. A leaked dispatcher key can only spend the float *and* only
  to wallets that hold an `Active` ticket *and* only once per wallet per day —
  the on-chain checks in `dispense()` don't trust the dispatcher.
- **Count the ETH budget toward the value-at-risk ceiling**
  (`CAPPED_BETA_GUARDRAILS.md`): unlike the airdrop's illiquid TIMB, treasury
  ETH is hard assets leaving every day. `operatorEthCap × 30` is the monthly
  number to hold under the ceiling.
- **Re-size when the price moves.** When `totalEthEscrow` passes 1.1 ETH the
  entry price starts climbing; `potEth` at 10 % of the *floor* becomes a smaller
  share of the real price, which is fine. What must not happen is the reverse:
  if you ever *raise* `dripEth + potEth`, re-read `entryCostETH()` first.

---

## 2. Payloads

Three owner-only calls on **TimbTreasury `0xee3e403fa75ef3b17f4763880e019ad606837834`**.
`<FAUCET>` = the address printed by `DeployFaucet` (unknown until deployed).
Selectors are precomputed so you can eyeball what the Safe UI / `cast` produces.

### 2.1 The three calls

| # | Call | Selector | Args (proposed) |
|---|---|---|---|
| A | `setOperator(address)` | `0xb3ab15fb` | `<FAUCET>` |
| B | `setOperatorEthCap(uint256,uint256)` | `0xecc5ac20` | `50000000000000000`, `86400` |
| C | `withdrawToken(address,address,uint256)` | `0x01e33667` | TIMBS `0x44bc0ab521191e839c3cb5bb20c9d044c8471ea1`, `<FAUCET>`, `3000000000000000000000` |

Generate the calldata once `<FAUCET>` is known (all three are static-typed, so
the encoding is just selector + 32-byte-padded args):

```
FAUCET=0x...   # from the DeployFaucet output — paste, don't type

cast calldata "setOperator(address)" $FAUCET
cast calldata "setOperatorEthCap(uint256,uint256)" 50000000000000000 86400
cast calldata "withdrawToken(address,address,uint256)" 0x44bc0ab521191e839c3cb5bb20c9d044c8471ea1 $FAUCET 3000000000000000000000
```

Call B has no unknowns, so its calldata is final now:

```
0xecc5ac20
  00000000000000000000000000000000000000000000000000b1a2bc2ec50000   # 0.05 ETH
  0000000000000000000000000000000000000000000000000000000000015180   # 86400 s
```

as one line:

```
0xecc5ac2000000000000000000000000000000000000000000000000000b1a2bc2ec500000000000000000000000000000000000000000000000000000000000000015180
```

Calls A and C will start with their selector followed by `<FAUCET>` left-padded
to 32 bytes; C then carries the TIMBS address (padded) and
`0xa2a15d09519be00000` (= 3,000e18) as its last word. If what `cast` prints
doesn't match that shape, stop.

### 2.2 Faucet-side calls (owner = deployer at first, then the Safe)

`DeployFaucet` already runs `setDispatcher`, `setGuardian`, `setEthCap`,
`setTimbsCap` in the deploy broadcast. After it prints the address:

```
# deployer → hand the faucet to the Safe (Ownable2Step; nothing moves until accepted)
cast send $FAUCET "transferOwnership(address)" 0xFbcD2D0581a54cEE87Ab2693B9E9b7dCC19c79F9 --rpc-url $R1 --private-key $DEPLOYER_PRIVATE_KEY
# Safe → accept (direct Safe tx, to = $FAUCET, data = 0x79ba5097)
```

Later param changes (`setParams`, `setEthCap`, `setTimbsCap`, `setDispatcher`)
are then plain Safe transactions to `$FAUCET` — no delay, by design (§4 posture
in the guardrails).

### 2.3 How the treasury calls get sent

**Before the governance handoff** (treasury `owner()` = deployer — the state
today): the runbook's §6 says to set ops params *while the deployer still owns
things*, and this is exactly that. Three direct txs:

```
T=0xee3e403fa75ef3b17f4763880e019ad606837834
cast send $T "setOperator(address)" $FAUCET --rpc-url $R1 --private-key $DEPLOYER_PRIVATE_KEY
cast send $T "setOperatorEthCap(uint256,uint256)" 50000000000000000 86400 --rpc-url $R1 --private-key $DEPLOYER_PRIVATE_KEY
cast send $T "withdrawToken(address,address,uint256)" 0x44bc0ab521191e839c3cb5bb20c9d044c8471ea1 $FAUCET 3000000000000000000000 --rpc-url $R1 --private-key $DEPLOYER_PRIVATE_KEY
```

**After the handoff** (treasury `owner()` = TimelockController
`0x13e227499b2ce81da39179d113304fa4367efe7a`; Safe `0xFbcD…79F9` is proposer +
executor): one batched timelock proposal from the Safe, then the same batch
executed after the delay. In the Safe Transaction Builder, `to` = the Timelock:

| Field | `scheduleBatch` (selector `0x8f2a0bb0`) | `executeBatch` (selector `0xe38335e5`) |
|---|---|---|
| `targets` | `[T, T, T]` | same |
| `values` | `[0, 0, 0]` | same |
| `payloads` | `[calldata A, calldata B, calldata C]` | same |
| `predecessor` | `0x0000000000000000000000000000000000000000000000000000000000000000` | same |
| `salt` | any fixed bytes32, e.g. `keccak256("timbswap-faucet-wire-1")` | **the same salt** |
| `delay` | `Timelock.getMinDelay()` (48 h unless changed) | — |

The operation id is `hashOperationBatch(targets, values, payloads, predecessor,
salt)`; `isOperationReady(id)` flips true after the delay and is the cue to
execute. If you prefer three single `schedule` / `execute` calls, the selectors
are `0x01d5062a` / `0x134008d3` with the same field meanings.

### 2.4 Order of operations on launch day

1. Deploy (`env.mainnet.example` → `.env.mainnet`, `DeployFaucet`). Record the
   address in `MAINNET_ADDRESSES.md` (official repo) and `config.js`.
2. Faucet → Safe ownership (§2.2).
3. Treasury calls A, B, C (§2.3). Confirm the treasury holds ≥ 1.5 ETH first.
4. Verify (§3). Then point the keeper (`faucet-worker.js` env) at the mainnet
   faucet with the **new** dispatcher key and switch `faucet-claim` to the
   mainnet registry for eligibility.
5. Retire the testnet airdrop route (§5) — the same day, so there is never a
   moment with two TIMB-release paths live.

---

## 3. Verification reads (after §2)

```
cast call $T "operator()(address)"                 --rpc-url $R1   # == $FAUCET
cast call $T "operatorEthCap()(uint256)"           --rpc-url $R1   # 50000000000000000
cast call $T "operatorPeriod()(uint256)"           --rpc-url $R1   # 86400
cast call 0x44bc0ab521191e839c3cb5bb20c9d044c8471ea1 "balanceOf(address)(uint256)" $FAUCET --rpc-url $R1   # 3000e18
cast call $FAUCET "owner()(address)"               --rpc-url $R1   # Safe 0xFbcD…79F9
cast call $FAUCET "dispatcher()(address)"          --rpc-url $R1   # the new mainnet keeper key
cast call $FAUCET "guardian()(address)"            --rpc-url $R1
cast call $FAUCET "ethCap()(uint256)"              --rpc-url $R1   # 1500000000000000000
cast call $FAUCET "timbsCap()(uint256)"            --rpc-url $R1   # 500000000000000000000000
cast call $FAUCET "dripEth()(uint256)"             --rpc-url $R1   # 200000000000000
cast call $FAUCET "potEth()(uint256)"              --rpc-url $R1   # 100000000000000
cast call 0x8c40ed0cce3585b694a45106314b09dff4e04137 "entryCostETH()(uint256)" --rpc-url $R1   # must exceed drip+pot
```

Smoke test: one real claim from a wallet holding an `Active` mainnet ticket →
`Dispensed(claimant, 2e14, 1e14, 1e18)`; treasury ETH down by exactly 3e14;
`TimbPrize` pot up by 1e14; `lastClaimAt[claimant]` set; a second `dispense`
inside 24 h reverts.

---

## 4. Kill switches and rollback (rehearse before funding)

| Threat | Lever | Who | Payload |
|---|---|---|---|
| Anything odd in ETH outflow | `faucet.setEthPaused(true)` | guardian **or** owner (instant) | `0x7337c27b` + `bool` |
| Anything odd in TIMBS outflow | `faucet.setTimbsPaused(true)` | guardian **or** owner (instant) | `0x19f8005e` + `bool` |
| Cut the treasury off entirely | `treasury.setOperatorEthCap(0, 86400)` — cap `0` disables operator withdrawals | treasury owner | `0xecc5ac20000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000015180` |
| Revoke the role | `treasury.setOperator(0x0)` | treasury owner | `0xb3ab15fb` + 32 zero bytes |
| Pull the TIMBS float back | `faucet.recoverTimbs(Safe, amount)` | faucet owner (Safe) | `0x1b2b7071` + Safe + amount |

Pausing the ETH leg leaves the TIMBS leg running and vice-versa — that is the
point of the two switches. Pause both and `dispense()` reverts; the keeper marks
rows failed and stops (no half-sends).

---

## 5. Retiring the testnet → mainnet airdrop route

Decision: the route is retired **before** mainnet launch; the faucet's TIMBS leg
becomes the only TIMB release. The distributor is already paused with
`AIRDROP_ENABLED` off, so retirement is mostly bookkeeping — but the float must
come home and the plumbing must not be able to wake up by accident.

| Step | Where | Action |
|---|---|---|
| 1 | Supabase (dashboard) | Keep `AIRDROP_ENABLED=false`; unschedule pg_cron job `airdrop-dispatch` (jobid 1) so nothing polls the outbox. |
| 2 | Safe → distributor `0x955e5800245164EC4DCd1da9062115bBdA132c83` | `recover(Safe, 998e18)` — the whole remaining float. Owner is the Safe directly, no timelock. Payload: `0x5705ae43000000000000000000000000fbcd2d0581a54cee87ab2693b9e9b7dcc19c79f90000000000000000000000000000000000000000000000361a08405e8fd80000` (re-read `balanceOf` first; recover exactly that). |
| 3 | Distributor | Leave `paused = true`. Optionally `setDispatcher(0x0)` so the hot key can never `distribute()` again; then the `0x77F4…` key can be discarded. |
| 4 | Repo | Remove the `enqueue_airdrop` call from `faucet-claim`; keep `config.js` `AIRDROP_ENABLED=false`; mark `MAINNET_AIRDROP_SPEC.md` retired (§15 there) and the `MAINNET_ADDRESSES.md` row as **RETIRED — float recovered**. |
| 5 | Docs | Drop the distributor rows from `CAPPED_BETA_GUARDRAILS.md` §1/§2/§5 once the float is at 0 (they stop being live levers). |

The two smoke-test payouts (2 TIMB) stay where they are. Nothing else was ever
distributed.
