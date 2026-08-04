// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

/**
 * @title TreasuryV1Drain
 * @notice A one-off receiver that unsticks the TIMBS stranded in Treasury v1
 *         (`0x486Fa4D8351EF81136E83340eA1e3aa2272c9955`).
 *
 * ## Why this exists
 *
 * `SPECS.md` recorded v1's balance as "permanently stranded (no working ERC20
 * exit in v1; treated as burned)". Reading the deployed bytecode, that is nearly
 * true: of v1's whole surface only three functions move value, and two of them
 * move ETH —
 *
 *   withdrawOperational(address,uint256)  ETH
 *   distributeToPot(uint256)              ETH
 *   distributeToStaking(uint256,uint256)  TIMBS   <-- the only token exit
 *
 * `distributeToStaking` does two things in order: `safeTransfer` the TIMBS to
 * whatever address `timbStaking` points at, then call `notifyRewardAmount` on
 * it. Against the real `TimbStaking` that can never succeed, for two independent
 * reasons:
 *
 *   1. `notifyRewardAmount` **pulls** — `safeTransferFrom(msg.sender, ...)` — so
 *      after v1 has already pushed the tokens away it would have to send them a
 *      second time, from a balance that is now zero;
 *   2. v1 exposes no `approve`, so it could never grant the allowance that pull
 *      needs, at any balance.
 *
 * Confirmed on chain: the call reverts.
 *
 * ## The unsticking
 *
 * `distributeToStaking` does not care what `timbStaking` *is*. It pushes, then
 * calls. v1 keeps an owner-only `setTimbStaking(address)`, so pointing it at a
 * receiver that simply **accepts the push and returns** completes the transfer
 * that the real staking contract's pull semantics made impossible.
 *
 * That is the entire trick, and it is why this contract is almost empty: the
 * value is in `notifyRewardAmount` doing nothing at all.
 *
 * ## Use once, then put v1 back
 *
 *   1. deploy this from the wallet that owns Treasury v1
 *   2. `TIMBS.setTransferWhitelist(<this>, true)` from the token owner — v1's
 *      balance is far above `maxTransferAmount`, and the cap is bypassed when
 *      EITHER side of a transfer is whitelisted
 *   3. `v1.setTimbStaking(<this>)`
 *   4. `v1.distributeToStaking(<v1's exact TIMBS balance>, 604800)`
 *   5. `sweep(TIMBS, <destination>)`
 *   6. `v1.setTimbStaking(0xe776c7b700B190ED8248741F9b518B08d8733C8F)` to leave
 *      v1 as it was found, and un-whitelist this address
 *
 * Simulate step 4 with `cast call` before sending it. v1's source is not in this
 * repo — its behaviour above is read from the deployed bytecode's selectors and
 * from v3's source, and a selector matches a signature, not an implementation.
 */
interface IERC20Min {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

contract TreasuryV1Drain {
    /// @notice The wallet that may sweep. Set once, at deploy, and never moved.
    address public immutable owner;

    event Swept(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NothingToSweep();
    error TransferFailed();

    constructor() {
        owner = msg.sender;
    }

    /**
     * @notice Accept the push and do nothing.
     * @dev This is the whole point. The real `TimbStaking.notifyRewardAmount`
     *      pulls the tokens it is told about, which is what makes v1's
     *      push-then-notify sequence unsatisfiable. Doing nothing here is not a
     *      stub for something unfinished — it is the behaviour that lets the
     *      preceding `safeTransfer` stand.
     *
     *      Deliberately takes no access control: it is only ever reached by v1,
     *      it holds nothing back, and only `owner` can move what arrives.
     */
    function notifyRewardAmount(uint256, uint256) external {}

    /// @notice Send this contract's entire balance of `token` to `to`.
    function sweep(address token, address to) external returns (uint256 amount) {
        if (msg.sender != owner) revert NotOwner();
        amount = IERC20Min(token).balanceOf(address(this));
        if (amount == 0) revert NothingToSweep();
        if (!IERC20Min(token).transfer(to, amount)) revert TransferFailed();
        emit Swept(token, to, amount);
    }
}
