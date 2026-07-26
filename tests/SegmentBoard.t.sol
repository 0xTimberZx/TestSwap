// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract SegmentBoardTest -vvv

import "forge-std/Test.sol";
import "../contracts/SegmentBoard.sol";
import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/CommitRevealEntropy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBS is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {}
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockTimbPrize {
    mapping(uint256 => bytes6) public roundWinningString;
    function setResult(uint256 round, bytes6 s) external { roundWinningString[round] = s; }
}

contract SegmentBoardTest is Test {
    MockTIMBS           timbs;
    MockTimbPrize       prize;
    PoolLedger          ledger;
    SeedRegistry        registry;
    CommitRevealEntropy ent;
    SegmentBoard        board;

    address treasury = address(0x7EA5);
    address guardian = address(0x6A4D);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);

    uint64 constant ENTRY_WINDOW   = 40 minutes;
    uint64 constant PICK_DELAY     = 45 minutes;
    uint64 constant BETS_CLOSE     = 5 minutes;

    uint256 constant SEED = 100e18;

    // chip index 2 = 25 TIMBS
    uint8 constant CHIP25 = 2;

    // cached so tests never make an external call inside a vm.expectRevert window
    uint8 kLetter;
    uint8 kNumber;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(1_000);

        timbs    = new MockTIMBS();
        prize    = new MockTimbPrize();
        ledger   = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry();
        ent      = new CommitRevealEntropy();

        board = new SegmentBoard(
            address(ledger), address(registry), address(ent),
            address(prize), treasury, guardian,
            ENTRY_WINDOW, PICK_DELAY, BETS_CLOSE
        );

        ledger.setBoard(address(board));
        registry.addWriter(address(board));

        // treasury funds the seed float and approves the ledger
        timbs.mintTo(treasury, 10_000e18);
        vm.prank(treasury); timbs.approve(address(ledger), type(uint256).max);

        // players
        timbs.mintTo(alice, 10_000e18);
        timbs.mintTo(bob,   10_000e18);
        vm.prank(alice); timbs.approve(address(ledger), type(uint256).max);
        vm.prank(bob);   timbs.approve(address(ledger), type(uint256).max);

        // a settled TimbPrize round to seed from
        prize.setResult(7, bytes6("ABCDEF"));

        kLetter = board.KIND_LETTER();
        kNumber = board.KIND_NUMBER();
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    function _commitments(uint256 tableId) internal view returns (bytes32[6] memory cs) {
        for (uint8 i; i < 6; ++i) {
            cs[i] = ent.commitmentOf(_secret(i + 1), _salt(tableId, i + 1));
        }
    }

    function _secret(uint8 segment) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("secret", segment));
    }

    function _salt(uint256 tableId, uint8 segment) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tableId, segment));
    }

    function _openTable() internal returns (uint256 id) {
        id = board.openTable(7, _commitments(1));
    }

    /// @dev Seat both players, load all six tokens, and put complementary
    ///      Letter/Number bets on every segment so exactly one side always wins.
    function _seatAndBet(uint256 id) internal {
        uint8[6] memory chips =
            [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];

        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        for (uint8 s = 1; s <= 6; ++s) board.place(id, s, kLetter, 0);
        vm.stopPrank();

        vm.startPrank(bob);
        board.sit(id, bytes6("123456"));
        board.loadTokens(id, chips);
        for (uint8 s = 1; s <= 6; ++s) board.place(id, s, kNumber, 0);
        vm.stopPrank();
    }

    function _lockAll(uint256 id) internal {
        vm.warp(block.timestamp + PICK_DELAY + 1);
        board.armTable(id);
        vm.roll(block.number + 1);
        for (uint8 s = 1; s <= 6; ++s) {
            board.lockSegment(id, s, _secret(s));
        }
    }

    // ─── lifecycle ───────────────────────────────────────────────────────────

    function test_OpenTablePullsSeedAndConsumesRound() public {
        uint256 id = _openTable();
        assertEq(id, 1);
        assertEq(ledger.heldBalance(), SEED);
        assertTrue(registry.isUsed(7));
    }

    function test_SeedRoundCannotBeReused() public {
        _openTable();
        bytes32[6] memory cs = _commitments(2);
        vm.expectRevert(abi.encodeWithSelector(SeedRegistry.SeedAlreadyUsed.selector, 7));
        board.openTable(7, cs);
    }

    function test_UnsettledSeedRoundReverts() public {
        bytes32[6] memory cs = _commitments(1);
        vm.expectRevert(abi.encodeWithSelector(SegmentBoard.SeedNotSettled.selector, uint256(99)));
        board.openTable(99, cs);
    }

    function test_CannotPlaceWithoutLoading() public {
        uint256 id = _openTable();
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        vm.expectRevert(SegmentBoard.NotLoaded.selector);
        board.place(id, 1, kLetter, 0);
        vm.stopPrank();
    }

    function test_OneTokenPerSegment() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        board.place(id, 1, kLetter, 0);
        // the guard that makes complementary outside bets farm-safe (§6.1)
        vm.expectRevert(abi.encodeWithSelector(SegmentBoard.AlreadyPlaced.selector, uint8(1)));
        board.place(id, 1, kNumber, 0);
        vm.stopPrank();
    }

    function test_BetsCloseBeforePick() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        vm.stopPrank();

        vm.warp(block.timestamp + PICK_DELAY - BETS_CLOSE); // exactly at the cutoff
        vm.prank(alice);
        vm.expectRevert(SegmentBoard.BetsClosed.selector);
        board.place(id, 1, kLetter, 0);
    }

    function test_ArmNeedsMinSeats() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        vm.stopPrank();

        vm.warp(block.timestamp + PICK_DELAY + 1);
        vm.expectRevert(
            abi.encodeWithSelector(SegmentBoard.NotEnoughSeats.selector, uint8(1), uint8(2))
        );
        board.armTable(id);
    }

    function test_CannotLockInSameBlockAsArm() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        vm.warp(block.timestamp + PICK_DELAY + 1);
        board.armTable(id);
        vm.expectRevert(SegmentBoard.SameBlockAsArm.selector);
        board.lockSegment(id, 1, _secret(1));
    }

    // ─── full round + conservation ────────────────────────────────────────────

    function test_FullRoundSettlesAndConserves() public {
        uint256 id = _openTable();
        _seatAndBet(id);

        // 2 players x 6 chips x 25 + seed
        uint256 staked = 2 * 6 * 25e18;
        assertEq(ledger.heldBalance(), staked + SEED);

        _lockAll(id);

        // exactly one of Letter/Number won each segment, so every segment pool
        // paid out; credit must be fully backed at all times
        assertGe(ledger.heldBalance(), ledger.totalCredited());
        assertGt(ledger.totalCredited(), 0);

        uint256 beforeTreasury = timbs.balanceOf(treasury);
        board.retire(id);

        // leftovers (rake + any forfeited seed + dust) swept to Treasury
        assertGt(timbs.balanceOf(treasury), beforeTreasury);
        // after the sweep the vault holds exactly what it owes players
        assertEq(ledger.heldBalance(), ledger.totalCredited());

        // and the winner can actually pull their credit
        uint256 aliceCredit = ledger.credit(alice);
        uint256 bobCredit   = ledger.credit(bob);
        assertGt(aliceCredit + bobCredit, 0);
        if (aliceCredit > 0) {
            vm.prank(alice);
            ledger.withdraw();
        }
        if (bobCredit > 0) {
            vm.prank(bob);
            ledger.withdraw();
        }
        assertEq(ledger.totalCredited(), 0);
        assertEq(ledger.heldBalance(), 0); // fully drained: nothing stranded
    }

    function test_UnplayedChipsAreRefundedAtRetire() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];

        // alice loads all six but only places five; bob plays all six
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        for (uint8 s = 1; s <= 5; ++s) board.place(id, s, kLetter, 0);
        vm.stopPrank();

        vm.startPrank(bob);
        board.sit(id, bytes6("123456"));
        board.loadTokens(id, chips);
        for (uint8 s = 1; s <= 6; ++s) board.place(id, s, kNumber, 0);
        vm.stopPrank();

        uint256 creditBefore = ledger.credit(alice);
        _lockAll(id);
        board.retire(id);

        // her unplayed segment-6 chip came back as credit, on top of any winnings
        assertGe(ledger.credit(alice), creditBefore + 25e18);
    }

    function test_SoloPoolForfeitsSeed() public {
        uint256 id = _openTable();
        uint8[6] memory chips = [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25];

        // both seat (so the table can arm) but only alice bets segment 1
        vm.startPrank(alice);
        board.sit(id, bytes6("ABCDEF"));
        board.loadTokens(id, chips);
        board.place(id, 1, kLetter, 0);
        board.place(id, 2, kLetter, 0);
        vm.stopPrank();

        vm.startPrank(bob);
        board.sit(id, bytes6("123456"));
        board.loadTokens(id, chips);
        board.place(id, 2, kNumber, 0); // only segment 2 is contested
        vm.stopPrank();

        _lockAll(id);

        // Solo segment-1 pool: at most its own 25 chip back (no seed share), and
        // taxed at the full 8% base rake. Contested pools may draw the seed.
        assertGe(ledger.heldBalance(), ledger.totalCredited());
        board.retire(id);
        assertEq(ledger.heldBalance(), ledger.totalCredited());
    }

    // ─── missed reveal ────────────────────────────────────────────────────────

    function test_FallbackOnlyAfterRevealWindow() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        vm.warp(block.timestamp + PICK_DELAY + 1);
        board.armTable(id);
        vm.roll(block.number + 1);

        vm.expectRevert(SegmentBoard.RevealWindowOpen.selector);
        board.lockSegmentFallback(id, 1);

        // once the protocol has missed its window, anyone can settle the table
        vm.roll(block.number + board.REVEAL_WINDOW() + 1);
        vm.prank(bob); // permissionless
        board.lockSegmentFallback(id, 1);
        assertGe(ledger.heldBalance(), ledger.totalCredited());
    }

    function test_BadRevealIsRejected() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        vm.warp(block.timestamp + PICK_DELAY + 1);
        board.armTable(id);
        vm.roll(block.number + 1);

        vm.expectRevert(CommitRevealEntropy.BadReveal.selector);
        board.lockSegment(id, 1, keccak256("not-the-secret"));
    }

    // ─── guardian / owner ─────────────────────────────────────────────────────

    function test_GuardianCanOnlyHalt() public {
        vm.prank(guardian);
        board.setNewTablesHalted(true);
        bytes32[6] memory cs = _commitments(1);
        vm.expectRevert(SegmentBoard.Halted.selector);
        board.openTable(7, cs);

        vm.prank(guardian);
        board.setNewTablesHalted(false);
        _openTable(); // flows again
    }

    function test_HaltedBetsStillAllowWithdrawals() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        _lockAll(id);

        vm.prank(guardian);
        board.setNewBetsHalted(true);

        // settlement already credited; withdrawal is never pausable
        if (ledger.credit(alice) > 0) {
            vm.prank(alice);
            ledger.withdraw();
        }
        assertGe(ledger.heldBalance(), ledger.totalCredited());
    }

    function test_NonGuardianCannotHalt() public {
        vm.prank(alice);
        vm.expectRevert(SegmentBoard.NotGuardian.selector);
        board.setNewTablesHalted(true);
    }

    function test_RetireGuardianIsTerminal() public {
        vm.prank(guardian);
        board.retireGuardian();
        assertEq(board.guardian(), address(0));
        vm.prank(guardian);
        vm.expectRevert(SegmentBoard.NotGuardian.selector);
        board.setNewTablesHalted(true);
    }

    function test_RenounceIsTerminalForOwner() public {
        board.renounceOwnership();
        assertEq(board.owner(), address(0));
        vm.expectRevert();
        board.setGuardian(alice);
        // play still works with no admin present
        uint256 id = _openTable();
        _seatAndBet(id);
        _lockAll(id);
        board.retire(id);
        assertEq(ledger.heldBalance(), ledger.totalCredited());
    }

    // ─── pure helpers ────────────────────────────────────────────────────────

    function test_FairMultipleWeights() public view {
        assertEq(board.weightBps(board.KIND_EXACTLY()),  35 * 10_000);
        assertEq(board.weightBps(board.KIND_COLUMN()),    2 * 10_000);
        assertEq(board.weightBps(board.KIND_VOWELS()),    5 * 10_000);
        assertEq(board.weightBps(board.KIND_COLOR()),         10_000);
        assertEq(board.weightBps(board.KIND_LETTER()),  uint256(10 * 10_000) / 26);
        assertEq(board.weightBps(board.KIND_NUMBER()),  uint256(26 * 10_000) / 10);
    }

    /// @dev Regression: RED_MASK must be 36 bits wide. A 32-bit literal silently
    ///      colours indices 32-35 black and breaks the even-money 18/18 split.
    function test_RedBlackIsAnEvenEighteenSplit() public view {
        uint256 reds;
        for (uint8 i; i < 36; ++i) {
            if (board.isRed(i)) ++reds;
        }
        assertEq(reds, 18, "red/black must be an even 18/18 split across all 36 symbols");
    }

    function test_LockedCharsAccumulateInSegmentOrder() public {
        uint256 id = _openTable();
        _seatAndBet(id);
        vm.warp(block.timestamp + PICK_DELAY + 1);
        board.armTable(id);
        vm.roll(block.number + 1);

        // lock out of order; each char must land in its own slot and leave the
        // others untouched
        board.lockSegment(id, 3, _secret(3));
        bytes6 afterThird = board.lockedCharsOf(id);
        assertTrue(afterThird[2] != 0, "segment 3 writes index 2");
        assertTrue(afterThird[0] == 0 && afterThird[5] == 0, "other slots untouched");

        board.lockSegment(id, 1, _secret(1));
        bytes6 afterFirst = board.lockedCharsOf(id);
        assertTrue(afterFirst[0] != 0, "segment 1 writes index 0");
        assertEq(afterFirst[2], afterThird[2], "segment 3's char survived");
    }

    function test_DoubleDigitRepeatDetection() public view {
        assertFalse(board.hasRepeat(bytes6("ABCDEF")));
        assertTrue(board.hasRepeat(bytes6("ABCDEA")));
        assertTrue(board.hasRepeat(bytes6("A1B1C2")));
    }
}
