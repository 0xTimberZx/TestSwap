// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract SegmentBoardGen7Test -vvv
//
// Gen-7 rules — NOT DEPLOYED. Gen-6 is the live generation; this suite covers
// the rule changes accumulating for the next one.
//
//   - the Repeats-a-Digit stake is a BONUS chip: it requires a full six-token
//     load, matching what `place` has always required of segment bets.

import "forge-std/Test.sol";
import "../contracts/SegmentBoard.sol";
import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/CommitRevealEntropy.sol";
import "../contracts/UnderwriteReserve.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBS7 is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {}
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockTimbPrize7 {
    mapping(uint256 => bytes6) public roundWinningString;
    function setResult(uint256 round, bytes6 s) external { roundWinningString[round] = s; }
}

contract SegmentBoardGen7Test is Test {
    MockTIMBS7          timbs;
    MockTimbPrize7      prize;
    PoolLedger          ledger;
    SeedRegistry        registry;
    CommitRevealEntropy ent;
    UnderwriteReserve   reserve;
    SegmentBoard        board;

    address treasury = address(0x7EA5);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);
    address carol    = address(0xCA401);

    uint64 constant ENTRY_MAX    = 40 minutes;
    uint64 constant PLACE_WINDOW = 5 minutes;
    uint64 constant BETS_CLOSE   = 2 minutes;
    uint64 constant SIT_QUIET    = 5 minutes;
    uint64 constant SOLO_WAIT    = 15 minutes;

    uint8 constant CHIP5  = 0; // the smallest denomination the ladder offers
    uint8 constant CHIP25 = 2;

    uint256 nextRound = 7;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(1_000);

        timbs    = new MockTIMBS7();
        prize    = new MockTimbPrize7();
        ledger   = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry();
        ent      = new CommitRevealEntropy();
        reserve  = new UnderwriteReserve(address(timbs), treasury, address(0));

        board = new SegmentBoard(
            address(ledger), address(registry), address(ent),
            address(prize), address(reserve), treasury, treasury, address(0),
            ENTRY_MAX, PLACE_WINDOW, BETS_CLOSE, SIT_QUIET, SOLO_WAIT
        );
        ledger.setBoard(address(board));
        registry.addWriter(address(board));
        reserve.setBoard(address(board));
        reserve.approveLedger(address(ledger));

        timbs.mintTo(treasury, 100_000e18);
        vm.prank(treasury); timbs.approve(address(ledger), type(uint256).max);
        for (uint256 i; i < 3; ++i) {
            address p = [alice, bob, carol][i];
            timbs.mintTo(p, 10_000e18);
            vm.prank(p); timbs.approve(address(ledger), type(uint256).max);
        }
    }

    function _secret(uint256 id, uint8 seg) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("gen7-secret", id, seg));
    }

    function _open() internal returns (uint256 id) {
        prize.setResult(nextRound, bytes6("ABCDEF"));
        uint256 wantId = board.nextTableId();
        bytes32[6] memory secs;
        for (uint8 s = 1; s <= 6; ++s) secs[s-1] = _secret(wantId, s);
        id = board.openTable(nextRound, board.commitmentsFor(secs, wantId));
        ++nextRound;
    }

    function _sitLoad(address who, uint256 id) internal {
        vm.startPrank(who);
        board.sit(id, bytes6("TICKET"));
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        vm.stopPrank();
    }

    // ─── the bonus chip rides a full load ────────────────────────────────────

    /// A seat with no chips down could previously buy the Repeats-a-Digit
    /// stake — and, with the jackpot live, buy into a strike — while
    /// contributing nothing to the six segment pools.
    function test_UnloadedSeatCannotBuyTheBonusChip() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        vm.prank(bob); board.sit(id, bytes6("BBBBBB"));   // seated, never funded

        vm.prank(bob);
        vm.expectRevert(SegmentBoard.NotLoaded.selector);
        board.placeDoubleDigit(id, CHIP25);
    }

    function test_LoadedSeatBuysTheBonusChip() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        vm.prank(alice); board.placeDoubleDigit(id, CHIP25);
        (,, uint8 ddChip,,) = board.seats(id, alice);
        assertEq(ddChip, CHIP25 + 1, "stake recorded");
    }

    /// Gen-5 late loading still earns it: fund after entry closes, still get
    /// the bonus chip, right up until bets close.
    function test_LateLoaderStillEarnsTheBonusChip() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        vm.prank(carol); board.sit(id, bytes6("CCCCCC"));

        (,,,,,,,,,, uint64 entryCloseAt,,,,) = board.tables(id);
        vm.warp(uint256(entryCloseAt) + 1);              // entry shut

        vm.startPrank(carol);
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        board.placeDoubleDigit(id, CHIP25);              // now allowed
        vm.stopPrank();
        (,, uint8 ddChip,,) = board.seats(id, carol);
        assertEq(ddChip, CHIP25 + 1, "late loader keeps the bonus chip");
    }

    /// The chip ladder's floor IS 5 TIMBS — there is no denomination beneath
    /// it and loadTokens rejects any index off the end, so "every one of the
    /// six is worth at least 5" holds by construction, not by a new check.
    function test_ChipLadderFloorIsFive() public {
        assertEq(board.CHIPS(0), 5e18, "smallest denomination");
        uint256 id = _open();
        vm.startPrank(alice);
        board.sit(id, bytes6("AAAAAA"));
        board.loadTokens(id, [CHIP5, CHIP5, CHIP5, CHIP5, CHIP5, CHIP5]);
        vm.stopPrank();
        assertEq(ledger.tableEscrow(id), 100e18 + 6 * 5e18, "six floor chips landed");

        uint256 id2 = _open();
        vm.startPrank(bob);
        board.sit(id2, bytes6("BBBBBB"));
        vm.expectRevert(SegmentBoard.BadChip.selector);
        board.loadTokens(id2, [uint8(7), 7, 7, 7, 7, 7]);   // off the end of the ladder
        vm.stopPrank();
    }
}
