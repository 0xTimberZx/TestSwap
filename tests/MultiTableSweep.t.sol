// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

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
    function setResult(uint256 r, bytes6 s) external { roundWinningString[r] = s; }
}

/// @dev Does the ledger's global `unowed()` let one table's close-out spend
///      another live table's seed? The board is designed for ~40 parallel
///      tables (TABLES_MAX), so this is the normal case, not a corner.
contract MultiTableSweepTest is Test {
    MockTIMBS timbs; MockTimbPrize prize; PoolLedger ledger;
    SeedRegistry registry; CommitRevealEntropy ent; SegmentBoard board;

    address treasury = address(0x7EA5);
    address alice = address(0xA11CE);
    address bob   = address(0xB0B);
    uint8 constant CHIP25 = 2;
    uint8 kLetter; uint8 kNumber;

    function setUp() public {
        vm.warp(1_000_000); vm.roll(1_000);
        timbs = new MockTIMBS(); prize = new MockTimbPrize();
        ledger = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry(); ent = new CommitRevealEntropy();
        board = new SegmentBoard(address(ledger), address(registry), address(ent),
            address(prize), treasury, treasury, address(0),
            40 minutes, 45 minutes, 5 minutes);
        ledger.setBoard(address(board)); registry.addWriter(address(board));
        timbs.mintTo(treasury, 10_000e18);
        vm.prank(treasury); timbs.approve(address(ledger), type(uint256).max);
        timbs.mintTo(alice, 10_000e18); timbs.mintTo(bob, 10_000e18);
        vm.prank(alice); timbs.approve(address(ledger), type(uint256).max);
        vm.prank(bob);   timbs.approve(address(ledger), type(uint256).max);
        prize.setResult(7, bytes6("ABCDEF"));
        prize.setResult(8, bytes6("GHIJKL"));
        kLetter = board.KIND_LETTER(); kNumber = board.KIND_NUMBER();
    }

    function _secret(uint256 id, uint8 seg) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("s", id, seg));
    }
    function _salt(uint256 id, uint8 seg) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(id, seg));
    }
    function _commits(uint256 id) internal view returns (bytes32[6] memory cs) {
        for (uint8 i; i < 6; ++i) cs[i] = ent.commitmentOf(_secret(id, i+1), _salt(id, i+1));
    }
    function _seatAndBet(uint256 id, bytes6 t1, bytes6 t2) internal {
        uint8[6] memory chips = [CHIP25,CHIP25,CHIP25,CHIP25,CHIP25,CHIP25];
        vm.startPrank(alice);
        board.sit(id, t1); board.loadTokens(id, chips);
        for (uint8 s=1; s<=6; ++s) board.place(id, s, kLetter, 0);
        vm.stopPrank();
        vm.startPrank(bob);
        board.sit(id, t2); board.loadTokens(id, chips);
        for (uint8 s=1; s<=6; ++s) board.place(id, s, kNumber, 0);
        vm.stopPrank();
    }

    /// @dev KNOWN BUG, documented so it cannot regress silently. This test
    ///      asserts the CURRENT (wrong) behaviour. When the per-table escrow fix
    ///      lands, this test must be inverted: table B should be untouched.
    function test_KNOWNBUG_RetiringOneTableSweepsAnotherLiveTablesEscrow() public {
        uint256 a = board.openTable(7, _commits(1));
        uint256 b = board.openTable(8, _commits(2));
        assertEq(ledger.heldBalance(), 200e18, "two seeds held");

        _seatAndBet(a, bytes6("ABCDEF"), bytes6("123456"));
        _seatAndBet(b, bytes6("ABCDEF"), bytes6("123456"));

        // settle + retire table A only; table B is still live and unsettled
        vm.warp(vm.getBlockTimestamp() + 45 minutes + 1);
        board.armTable(a);
        vm.roll(vm.getBlockNumber() + 1);
        for (uint8 s=1; s<=6; ++s) board.lockSegment(a, s, _secret(a, s));

        uint256 owedBefore = ledger.totalCredited();
        board.retire(a);

        // Everything not yet credited was swept — including table B's seed and
        // every chip its players loaded.
        assertEq(ledger.heldBalance(), owedBefore, "held collapsed to table A's credits");
        emit log_named_uint("swept to treasury", timbs.balanceOf(treasury));

        // Table B can no longer pay anyone.
        board.armTable(b);
        vm.roll(vm.getBlockNumber() + 1);
        vm.expectRevert(); // ExceedsUnowed — the tokens are gone
        board.lockSegment(b, 1, _secret(b, 1));
    }
}
