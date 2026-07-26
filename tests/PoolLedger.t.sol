// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract PoolLedgerTest -vvv

import "forge-std/Test.sol";
import "../contracts/PoolLedger.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBS is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {
        _mint(msg.sender, 1_000_000e18);
    }
    function mintTo(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// @dev The test contract plays the role of the board (as the repo's tests let
///      the test stand in for a collaborator like TimbPrize).
contract PoolLedgerTest is Test {
    MockTIMBS   timbs;
    PoolLedger  ledger;

    address treasury = address(0x7EA5);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);
    address carol    = address(0xCA201);

    function setUp() public {
        timbs  = new MockTIMBS();
        ledger = new PoolLedger(address(timbs), treasury);
        ledger.setBoard(address(this)); // this test IS the board

        // fund players and approve the ledger for their stakes
        timbs.mintTo(alice, 1_000e18);
        timbs.mintTo(bob,   1_000e18);
        timbs.mintTo(carol, 1_000e18);
        vm.prank(alice); timbs.approve(address(ledger), type(uint256).max);
        vm.prank(bob);   timbs.approve(address(ledger), type(uint256).max);
        vm.prank(carol); timbs.approve(address(ledger), type(uint256).max);
        // the board (this) holds seed float and approves the ledger too
        timbs.approve(address(ledger), type(uint256).max);
    }

    // ─── wiring ──────────────────────────────────────────────────────────────

    function test_SetBoardOnlyOnce() public {
        PoolLedger l = new PoolLedger(address(timbs), treasury);
        l.setBoard(address(this));
        assertEq(l.board(), address(this));
        vm.expectRevert(PoolLedger.BoardAlreadySet.selector);
        l.setBoard(bob);
    }

    function test_ConstructorRejectsZero() public {
        vm.expectRevert(PoolLedger.ZeroAddress.selector);
        new PoolLedger(address(0), treasury);
        vm.expectRevert(PoolLedger.ZeroAddress.selector);
        new PoolLedger(address(timbs), address(0));
    }

    function test_OnlyBoardCanCollect() public {
        vm.prank(alice);
        vm.expectRevert(PoolLedger.NotBoard.selector);
        ledger.collect(alice, 100e18);
    }

    // ─── intake + credit + withdraw ────────────────────────────────────────────

    function test_CollectPullsStake() public {
        ledger.collect(alice, 100e18);
        assertEq(ledger.heldBalance(), 100e18);
        assertEq(timbs.balanceOf(alice), 900e18);
    }

    function test_CreditThenWithdraw() public {
        ledger.collect(alice, 100e18);
        ledger.collect(bob,   100e18);           // pot = 200

        address[] memory ws = new address[](2);
        uint256[] memory as_ = new uint256[](2);
        ws[0] = alice; as_[0] = 150e18;          // alice won
        ws[1] = bob;   as_[1] = 0;               // bob lost (skipped)
        ledger.creditWinnings(ws, as_);

        assertEq(ledger.credit(alice), 150e18);
        assertEq(ledger.totalCredited(), 150e18);

        vm.prank(alice);
        ledger.withdraw();
        assertEq(timbs.balanceOf(alice), 900e18 + 150e18);
        assertEq(ledger.credit(alice), 0);
        assertEq(ledger.totalCredited(), 0);
    }

    function test_WithdrawNothingReverts() public {
        vm.prank(carol);
        vm.expectRevert(PoolLedger.NothingToWithdraw.selector);
        ledger.withdraw();
    }

    function test_CreditLengthMismatchReverts() public {
        address[] memory ws = new address[](2);
        uint256[] memory as_ = new uint256[](1);
        vm.expectRevert(PoolLedger.LengthMismatch.selector);
        ledger.creditWinnings(ws, as_);
    }

    // ─── escrow is sacred ──────────────────────────────────────────────────────

    function test_CannotCreditMoreThanHeld() public {
        ledger.collect(alice, 100e18); // held = 100
        address[] memory ws = new address[](1);
        uint256[] memory as_ = new uint256[](1);
        ws[0] = alice; as_[0] = 101e18; // more than held
        vm.expectRevert(
            abi.encodeWithSelector(PoolLedger.ExceedsUnowed.selector, 101e18, 100e18)
        );
        ledger.creditWinnings(ws, as_);
    }

    function test_SweepCannotTouchCredit() public {
        ledger.collect(alice, 100e18);
        ledger.collect(bob,   100e18);      // held 200

        address[] memory ws = new address[](1);
        uint256[] memory as_ = new uint256[](1);
        ws[0] = alice; as_[0] = 120e18;     // credited 120, unowed = 80
        ledger.creditWinnings(ws, as_);

        assertEq(ledger.unowed(), 80e18);
        // sweeping 81 (into credit) must revert
        vm.expectRevert(
            abi.encodeWithSelector(PoolLedger.ExceedsUnowed.selector, 81e18, 80e18)
        );
        ledger.sweep(treasury, 81e18);
        // sweeping exactly the unowed surplus is fine
        ledger.sweep(treasury, 80e18);
        assertEq(timbs.balanceOf(treasury), 80e18);
        // alice's credit survived the sweep
        assertEq(ledger.credit(alice), 120e18);
    }

    function test_OwnerWithdrawOnlyUnowed() public {
        ledger.collect(alice, 100e18);
        address[] memory ws = new address[](1);
        uint256[] memory as_ = new uint256[](1);
        ws[0] = alice; as_[0] = 60e18;      // unowed = 40
        ledger.creditWinnings(ws, as_);

        // owner (this test deployed the ledger) cannot pull into credit
        vm.expectRevert(
            abi.encodeWithSelector(PoolLedger.ExceedsUnowed.selector, 41e18, 40e18)
        );
        ledger.ownerWithdraw(treasury, 41e18);

        ledger.ownerWithdraw(treasury, 40e18); // exactly the surplus
        assertEq(timbs.balanceOf(treasury), 40e18);
        assertEq(ledger.credit(alice), 60e18); // untouched

        // and alice can still withdraw her full credit afterwards
        vm.prank(alice);
        ledger.withdraw();
        assertEq(timbs.balanceOf(alice), 900e18 + 60e18);
    }

    function test_OnlyOwnerCanOwnerWithdraw() public {
        ledger.collect(alice, 100e18);
        vm.prank(bob);
        vm.expectRevert();
        ledger.ownerWithdraw(bob, 1e18);
    }

    function test_RefundIsBackedCredit() public {
        ledger.collect(alice, 100e18);
        ledger.refund(alice, 100e18);       // dislodge her unplayed chip
        assertEq(ledger.credit(alice), 100e18);
        vm.prank(alice);
        ledger.withdraw();
        assertEq(timbs.balanceOf(alice), 1_000e18); // whole again
    }

    /// @dev Conservation: for any sequence, totalCredited <= held always holds,
    ///      and the sum of every wallet's withdrawable credit is fully backed.
    function test_ConservationHeldGteCredited() public {
        ledger.collect(alice, 300e18);
        ledger.collect(bob,   200e18);      // held 500
        address[] memory ws = new address[](2);
        uint256[] memory as_ = new uint256[](2);
        ws[0] = alice; as_[0] = 250e18;
        ws[1] = bob;   as_[1] = 150e18;     // credited 400, unowed 100 (rake)
        ledger.creditWinnings(ws, as_);
        assertGe(ledger.heldBalance(), ledger.totalCredited());
        assertEq(ledger.unowed(), 100e18);
        ledger.sweep(treasury, 100e18);     // rake out
        assertEq(ledger.heldBalance(), ledger.totalCredited()); // exactly backed
    }
}
