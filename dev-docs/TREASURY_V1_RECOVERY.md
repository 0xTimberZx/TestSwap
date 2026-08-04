# Recovering the TIMBS stranded in Treasury v1

**Status:** written, not yet run. Every step below is literal — no placeholders,
no line continuations — because both have cost this project time before.

**Target:** `0x486Fa4D8351EF81136E83340eA1e3aa2272c9955` (TimbTreasury v1,
retired). Holding **9,117.798 TIMBS** as of 2026-08-04: the ~6,532 `SPECS.md`
wrote off as burned, gen-7's 2,500 reserve float that drained there during
wind-down, and accumulated fees.

Everything is signed by `0x42536623b503D4926DfAF6173B0357b7DfD19800`, which owns
both v1 and the token.

---

## Why it was thought unrecoverable, and why it isn't

`SPECS.md:102` recorded *"no working ERC20 exit in v1; treated as burned"*. That
is nearly right. Probing the deployed bytecode for every plausible exit selector,
only three value-moving functions exist, and two move ETH:

| selector | function | moves |
|---|---|---|
| `2cb97183` | `withdrawOperational(address,uint256)` | ETH |
| `eb164026` | `distributeToPot(uint256)` | ETH |
| `330ac98d` | `distributeToStaking(uint256,uint256)` | **TIMBS** |

Absent: `withdrawToken`, `withdrawERC20`, `recoverERC20`, `rescueToken`,
`rescueERC20`, `sweepToken`, `sweep`, `emergencyWithdraw`,
`emergencyWithdrawToken`, `transferToken`. Whoever wrote the SPECS line was
almost certainly looking for one of those, and was right that none exists.

`distributeToStaking` pushes the TIMBS to whatever `timbStaking` points at, then
calls `notifyRewardAmount` on it. Against the real `TimbStaking` this can never
succeed:

1. `notifyRewardAmount` **pulls** — `safeTransferFrom(msg.sender, ...)` — so v1
   would have to send the same tokens a second time, from a balance the push has
   already emptied;
2. v1 exposes no `approve`, so it could never grant that allowance at any
   balance.

Confirmed on chain: the call reverts with empty data.

**But it does not care what `timbStaking` is**, and v1 kept an owner-only
`setTimbStaking(address)` (selector `9fe65f19`, confirmed present). Point it at a
receiver that accepts the push and returns, and the transfer the pull semantics
made impossible simply completes.

`contracts/TreasuryV1Drain.sol` is that receiver. It is almost empty on purpose.

## What is inferred rather than proven

v1's source is not in this repo — git history for `TimbTreasury.sol` only reaches
v3, which already has the generic `withdrawToken` that v1 lacks. Its behaviour
above is read from **deployed selectors plus v3's source**, and a selector
matches a *signature*, not an implementation.

Step 5 is a `cast call` for exactly this reason: it executes the real v1
bytecode against real state and changes nothing. If it returns, the inference
held. If it reverts, stop and read the reason before spending gas.

---

## The sequence

### 0. Re-read the balance

Do not trust the figure above — anything could have landed since.

```bash
cast call 0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa "balanceOf(address)(uint256)" 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

Use whatever it prints, in wei, wherever `<BALANCE>` appears below. It is the one
substitution in this file and it has to come off the chain.

### 1. Deploy the receiver

```bash
ARBISCAN_API_KEY=unused forge create contracts/TreasuryV1Drain.sol:TreasuryV1Drain --rpc-url https://sepolia-rollup.arbitrum.io/rpc --broadcast --interactive
```

Note the deployed address — `<DRAIN>` below. `--interactive` prompts for the key
without it touching an env var, the shell history or the screen. If your Foundry
predates `--broadcast` on `forge create`, drop that flag.

The deploying wallet becomes `owner` and is the only address that can sweep, so
deploy from `0x4253…9800`.

### 2. Exempt the receiver from the transfer cap

v1's balance is far above `maxTransferAmount`, and the cap is bypassed when
**either** side of a transfer is whitelisted — so whitelisting the receiver
covers both the inbound push and the outbound sweep.

```bash
cast send 0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa "setTransferWhitelist(address,bool)" <DRAIN> true --rpc-url https://sepolia-rollup.arbitrum.io/rpc --interactive
```

### 3. Point v1 at it

```bash
cast send 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 "setTimbStaking(address)" <DRAIN> --rpc-url https://sepolia-rollup.arbitrum.io/rpc --interactive
```

### 4. Confirm it took

```bash
cast call 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 "timbStaking()(address)" --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

Must print `<DRAIN>`. If it still prints `0xe776c7b7…`, step 3 did not land and
step 6 would send 9,117 TIMBS into the staking contract as an unpullable push.

### 5. Simulate — this is the step that converts inference into fact

```bash
cast call 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 "distributeToStaking(uint256,uint256)" <BALANCE> 604800 --from 0x42536623b503D4926DfAF6173B0357b7DfD19800 --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

Returns cleanly → proceed. Reverts → stop, and read it:

| revert | meaning |
|---|---|
| `ZeroAmount` | balance mismatch — re-run step 0 and use the exact figure |
| `ZeroAddress` | `timbStaking` is unset; step 3 did not land |
| empty `0x` | still hitting a pull somewhere — do **not** send; tell me the trace |

### 6. Send it

```bash
cast send 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 "distributeToStaking(uint256,uint256)" <BALANCE> 604800 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --interactive
```

Then verify both sides moved:

```bash
cast call 0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa "balanceOf(address)(uint256)" 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 --rpc-url https://sepolia-rollup.arbitrum.io/rpc
cast call 0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa "balanceOf(address)(uint256)" <DRAIN> --rpc-url https://sepolia-rollup.arbitrum.io/rpc
```

v1 should read `0`, the receiver `<BALANCE>`.

### 7. Sweep to Treasury v4

```bash
cast send <DRAIN> "sweep(address,address)" 0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa 0xd3F40042aFA8074EA68C9f61dE6aDADD539F0D5c --rpc-url https://sepolia-rollup.arbitrum.io/rpc --interactive
```

v4 is the live treasury and where protocol funds belong. Any address works — the
receiver holds nothing back — but sending it somewhere with no ERC20 exit would
be an unusually literal way to repeat the original mistake.

### 8. Put v1 back as you found it

```bash
cast send 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 "setTimbStaking(address)" 0xe776c7b700B190ED8248741F9b518B08d8733C8F --rpc-url https://sepolia-rollup.arbitrum.io/rpc --interactive
cast send 0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa "setTransferWhitelist(address,bool)" <DRAIN> false --rpc-url https://sepolia-rollup.arbitrum.io/rpc --interactive
```

Neither is load-bearing — v1 is retired and the receiver is spent — but leaving a
dead contract pointed at a one-off shim, and a stale whitelist entry on the
token, is the sort of residue that reads as intentional to whoever finds it next.

---

## Afterwards

Correct `SPECS.md:102`. The current entry says the balance is burned; it should
say v1 has no *generic* ERC20 exit, that `distributeToStaking` is a usable one
via a receiver, and that the balance was recovered on whatever date this runs.
Leaving it as "burned" would mean the next person re-derives all of this from
scratch — or, worse, believes it and writes off the next stranded balance too.
