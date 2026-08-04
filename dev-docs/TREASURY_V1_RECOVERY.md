# Treasury v1 — why the TIMBS is unrecoverable

**Investigated 2026-08-04. Result: genuinely stranded.** `SPECS.md` was right;
what it lacked was the reason, which is worth having so nobody re-derives this.

**Target:** `0x486Fa4D8351EF81136E83340eA1e3aa2272c9955` (TimbTreasury v1,
retired), holding **9,117.798 TIMBS** — the ~6,532 originally written off,
gen-7's 2,500 reserve float which drained there during wind-down, and fees.

---

## The finding

v1's only token-moving function calls **`safeTransfer(address,uint256)`** on the
TIMBS token. Selector `423f6cef`. **TIMBS has no such function.**

`safeTransfer` is a *library* function from OpenZeppelin's `SafeERC20`, meant to
be reached as `token.safeTransfer(...)` via `using SafeERC20 for IERC20`, which
compiles to a plain `transfer` (`a9059cbb`) plus return-value checking. v1
instead declared `safeTransfer` **in its token interface**, so the compiler emits
a call to a selector that exists nowhere on the token. No match, no fallback,
immediate revert.

The trace, from a `cast call` against live state:

```
[16432] 0x486Fa4D8…::distributeToStaking(9117798252224818271293, 604800)
  ├─ [2962] 0x2Aaa61E2…::balanceOf(0x486Fa4D8…) [staticcall]
  │    └─ ← [Return] 9117798252224818271293
  ├─ [ 247] 0x2Aaa61E2…::safeTransfer(0xDA6470C6…, 9117798252224818271293)
  │    └─ ← [Revert] EvmError: Revert
  └─ ← [Revert] EvmError: Revert
```

`balanceOf` sees the full balance. The next line dies in **247 gas** — the cost
of dispatching to a selector that isn't there, having done no work.

## Why nothing can fix it

The failure happens **before** any address v1 exposes as configurable matters.
`timbStaking` is the destination of that transfer; it is irrelevant when the call
never reaches a real function. There is no setter for the token pointer, and
changing it would not help — no ERC20 implements `safeTransfer`, because it isn't
part of ERC20.

The other two value-moving functions (`withdrawOperational`, `distributeToPot`)
move **ETH**, not tokens. There is no generic exit: `withdrawToken`,
`withdrawERC20`, `recoverERC20`, `rescueToken`, `rescueERC20`, `sweepToken`,
`sweep`, `emergencyWithdraw`, `emergencyWithdrawToken` and `transferToken` are
all absent from the deployed bytecode.

So the balance is unreachable by any caller, including the owner. Burned in
effect, though not in the ERC20 sense — the tokens still exist and still count
against supply, they simply have no path out.

## What was tried

A receiver contract (`TreasuryV1Drain`, `0xDA6470C6aA8B5286b09B97c3b9cBe1C35F413d74`)
pointed at by `setTimbStaking`, on the theory that the real `TimbStaking.notifyRewardAmount`
**pulls** with `transferFrom` — which v1 can never satisfy, having no `approve`.

That reasoning was correct as far as it went, and the setup worked: the receiver
deployed, was whitelisted past `maxTransferAmount`, and `timbStaking()` read back
as the receiver. But it addressed the *second* obstacle. The transfer never gets
far enough for the destination to matter. The contract has been removed from the
tree; it solves a problem that is downstream of the one that bites.

**Restore v1 when convenient** — harmless either way, since nothing here works,
but leaving a retired contract pointed at a deleted shim reads as intentional:

```bash
cast send 0x486Fa4D8351EF81136E83340eA1e3aa2272c9955 "setTimbStaking(address)" 0xe776c7b700B190ED8248741F9b518B08d8733C8F --rpc-url https://sepolia-rollup.arbitrum.io/rpc --interactive
cast send 0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa "setTransferWhitelist(address,bool)" 0xDA6470C6aA8B5286b09B97c3b9cBe1C35F413d74 false --rpc-url https://sepolia-rollup.arbitrum.io/rpc --interactive
```

## The lesson worth keeping

A token interface hand-declared with `safeTransfer` on it compiles, deploys, and
verifies. Nothing catches it until a live call reverts with no reason data,
because the mistake is a *selector* that never existed rather than a rule that
was broken. Use `using SafeERC20 for IERC20` and let the library generate the
call; never name `safeTransfer` in an interface.

Second: the reason this took a trace rather than a guess is that a bare `0x`
revert carries no information at all. Three plausible explanations fit it equally
well — pull-vs-push semantics, a codeless token address, a missing selector — and
two of them were wrong. `cast call --trace` distinguished them in one command and
should have been the first move, not the fourth.
