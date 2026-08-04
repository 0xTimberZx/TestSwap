// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract SegmentBoardVRFEconomicsTest -vvv
//
// The economic machinery of the LIVE generation.
//
// `SegmentBoardVRF.t.sol` covers what gen-8 changed — the entropy — and proves
// it thoroughly. What it does not cover is everything gen-8 inherited: the
// monotonic underwrite, the rake split, dead-pot routing, dealer tips and the
// board-only access control. That code all ships in `SegmentBoardVRF.sol`, but
// its tests were pointed at `SegmentBoard.sol`, a board that is retired and can
// never be deployed again. The live generation's money rules were, in effect,
// untested.
//
// These are the gen-6 economic tests ported to the VRF board. The port is not a
// copy: on a commit-reveal board a test had to PREDICT the outcome from a future
// block hash before it could bet on it, which is why the old suite carried
// `_predictChars`. Here the test picks the VRF word, so the character is chosen
// rather than predicted — the assertions get sharper and the helper disappears.
//
// Once this lands, `SegmentBoardGen5/6/7.t.sol` have nothing left to guard that
// is not guarded here against the board that is actually running.

import "forge-std/Test.sol";
import "../contracts/SegmentBoardVRF.sol";
import "../contracts/VRFEntropy.sol";
import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/UnderwriteReserve.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBSE is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {}
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockTimbPrizeE {
    mapping(uint256 => bytes6) public roundWinningString;
    function setResult(uint256 round, bytes6 s) external { roundWinningString[round] = s; }
}

contract MockVRFCoordinatorE is IVRFCoordinatorV2Plus {
    uint256 public nextId = 1;
    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256) {
        return nextId++;
    }
    function fulfil(address consumer, uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        VRFEntropy(consumer).rawFulfillRandomWords(requestId, words);
    }
}

contract SegmentBoardVRFEconomicsTest is Test {
    MockTIMBSE          timbs;
    MockTimbPrizeE      prize;
    MockVRFCoordinatorE coord;
    VRFEntropy          ent;
    PoolLedger          ledger;
    SeedRegistry        registry;
    UnderwriteReserve   reserve;
    SegmentBoardVRF     board;

    address treasury = address(0x7EA5);
    address guardian = address(0x6DA12);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);
    address carol    = address(0xCA401);
    address stranger = address(0x57A);

    uint64 constant ENTRY_MAX    = 40 minutes;
    uint64 constant PLACE_WINDOW = 5 minutes;
    uint64 constant BETS_CLOSE   = 2 minutes;
    uint64 constant SIT_QUIET    = 5 minutes;
    uint64 constant SOLO_WAIT    = 15 minutes;

    uint8 constant CHIP5    = 0;
    uint8 constant CHIP25   = 2;
    uint8 constant CHIP500  = 5;

    uint8 KX;   // KIND_EXACTLY, cached — reading it inline would eat a vm.prank

    uint256 nextRound = 900;

    /// One arbitrary word per segment. Nothing about them is special — the point
    /// is that the TEST fixes them, so every character below is chosen, not
    /// predicted, and a failure can never be the fixture's fault.
    uint256 constant W1 = 1111;
    uint256 constant W2 = 2222;
    uint256 constant W3 = 3333;
    uint256 constant W4 = 4444;
    uint256 constant W5 = 5555;
    uint256 constant W6 = 6666;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(1_000);

        timbs    = new MockTIMBSE();
        prize    = new MockTimbPrizeE();
        coord    = new MockVRFCoordinatorE();
        ledger   = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry();
        reserve  = new UnderwriteReserve(address(timbs), treasury, guardian);

        ent = new VRFEntropy(address(coord), bytes32(uint256(0xABC)), 42, 3, 200_000, hex"1234");

        board = new SegmentBoardVRF(
            address(ledger), address(registry), address(ent),
            address(prize), address(reserve), treasury, treasury, guardian,
            ENTRY_MAX, PLACE_WINDOW, BETS_CLOSE, SIT_QUIET, SOLO_WAIT
        );
        ledger.setBoard(address(board));
        registry.addWriter(address(board));
        reserve.setBoard(address(board));
        reserve.approveLedger(address(ledger));
        ent.setBoard(address(board));

        KX = board.KIND_EXACTLY();

        timbs.mintTo(treasury, 1_000_000e18);
        vm.prank(treasury); timbs.approve(address(ledger), type(uint256).max);
        address[3] memory players = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            timbs.mintTo(players[i], 100_000e18);
            vm.prank(players[i]); timbs.approve(address(ledger), type(uint256).max);
        }
    }

    // ─── helpers ─────────────────────────────────────────────────────────────

    /// Initial variance cover arrives as a PLAIN TRANSFER, per the deploy
    /// runbook — `fundBudgeted` reverts on a fresh reserve whose earned counter
    /// is still zero, and that trap is worth encoding in the fixture.
    function _fund(uint256 amount) internal {
        timbs.mintTo(address(reserve), amount);
    }

    function _open() internal returns (uint256 id) {
        prize.setResult(nextRound, bytes6("ABCDEF"));
        id = board.openTable(nextRound);
        ++nextRound;
    }

    function _tbl(uint256 id) internal view returns (
        uint64 pickTime, uint8 lockedMask, bool retired, address opener
    ) {
        (, pickTime, , , , lockedMask, , retired, , , , , , , opener, ) = board.tables(id);
    }

    function _sitLoad(address who, uint256 id, uint8 chip) internal {
        vm.startPrank(who);
        board.sit(id, bytes6("ZZZZZZ"));
        board.loadTokens(id, [chip, chip, chip, chip, chip, chip]);
        vm.stopPrank();
    }

    /// The character a given word produces — the same arithmetic anyone watching
    /// can repeat from the public fulfilment.
    function _charIdxFor(uint256 id, uint8 segment, uint256 word) internal view returns (uint8) {
        return uint8(uint256(keccak256(abi.encodePacked(word, board.saltFor(id, segment)))) % 36);
    }

    function _armLock(uint256 id, uint8 segment, uint256 word) internal {
        uint256 reqId = coord.nextId();
        vm.prank(stranger); board.armSegment(id, segment);
        coord.fulfil(address(ent), reqId, word);
        vm.prank(stranger); board.lockSegment(id, segment);
    }

    function _words() internal pure returns (uint256[6] memory) {
        return [W1, W2, W3, W4, W5, W6];
    }

    /// Warp to the pick and run all six segments through arm → fulfil → lock.
    function _runRound(uint256 id) internal {
        (uint64 pickTime,,,) = _tbl(id);
        vm.warp(uint256(pickTime));
        uint256[6] memory w = _words();
        for (uint8 s = 1; s <= 6; ++s) _armLock(id, s, w[s - 1]);
    }

    /// M1's target: stake x fair x 0.90. For Exactly, fair is 36.
    function _exactlyTarget(uint256 stake) internal pure returns (uint256) {
        return stake * 36 * 9000 / 10000;
    }

    /// The escrow-sacred invariant, asserted the same way gen-3 introduced it:
    /// the ledger must always hold at least what it owes.
    function _assertSolvent() internal view {
        assertGe(ledger.heldBalance(), ledger.totalCredited() + ledger.totalEscrowed(),
                 "escrow-sacred: ledger holds less than it owes");
    }

    // ─── M1: the monotonic underwrite ────────────────────────────────────────

    /// The spec's worked example, now on the live board: a solo 25 on Exactly
    /// pays 810 — stake x 36 x 0.90 — with par from the pool and the rest from
    /// the reserve.
    function test_SoloExactlyIsToppedUpToTarget() public {
        _fund(10_000e18);
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        (uint64 pickTime,,,) = _tbl(id);
        uint8 winIdx = _charIdxFor(id, 1, W1);
        vm.prank(alice); board.place(id, 1, KX, winIdx);

        vm.warp(uint256(pickTime));
        uint256[6] memory w = _words();
        for (uint8 s = 1; s <= 6; ++s) _armLock(id, s, w[s - 1]);

        assertEq(ledger.credit(alice), _exactlyTarget(25e18),
                 "25 -> 810: par from the pool, the rest from the reserve");
        _assertSolvent();
    }

    /// **The monotonicity law.** More players must never worsen any player's
    /// outcome. A loser joining the pool makes it contested and therefore raked,
    /// and the winner must still clear 810 — the loser's chips only reduce the
    /// reserve's share of the top-up, never the payout.
    function test_MonotonicityLosingJoinerNeverLowersThePayout() public {
        _fund(10_000e18);
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        (uint64 pickTime,,,) = _tbl(id);
        uint8 winIdx = _charIdxFor(id, 1, W1);
        vm.prank(alice); board.place(id, 1, KX, winIdx);
        vm.prank(bob);   board.place(id, 1, KX, (winIdx + 1) % 36);

        vm.warp(uint256(pickTime));
        uint256[6] memory w = _words();
        for (uint8 s = 1; s <= 6; ++s) _armLock(id, s, w[s - 1]);

        assertEq(ledger.credit(alice), _exactlyTarget(25e18),
                 "monotonic: the loser's chips only reduce the reserve's share");
        _assertSolvent();
    }

    /// An empty reserve must never block a settle. The grant simply comes back
    /// smaller — pari-mutuel still pays, the round still closes.
    function test_EmptyReserveNeverBlocksSettlement() public {
        // deliberately NOT funded
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        (uint64 pickTime,,,) = _tbl(id);
        uint8 winIdx = _charIdxFor(id, 1, W1);
        vm.prank(alice); board.place(id, 1, KX, winIdx);

        vm.warp(uint256(pickTime));
        uint256[6] memory w = _words();
        for (uint8 s = 1; s <= 6; ++s) _armLock(id, s, w[s - 1]);

        assertGt(ledger.credit(alice), 0, "an unfunded reserve still lets the pool pay par");
        assertLt(ledger.credit(alice), _exactlyTarget(25e18), "and cannot reach the target");
        _assertSolvent();
    }

    /// A halted reserve grants nothing, and settlement is unaffected — the
    /// guardian can stop the subsidy without being able to stop the game.
    function test_HaltedReserveGrantsNothing() public {
        _fund(10_000e18);
        vm.prank(guardian); reserve.setHalted(true);

        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        (uint64 pickTime,,,) = _tbl(id);
        uint8 winIdx = _charIdxFor(id, 1, W1);
        vm.prank(alice); board.place(id, 1, KX, winIdx);

        vm.warp(uint256(pickTime));
        uint256[6] memory w = _words();
        for (uint8 s = 1; s <= 6; ++s) _armLock(id, s, w[s - 1]);

        assertGt(ledger.credit(alice), 0, "halted reserve still lets the pool pay");
        assertLt(ledger.credit(alice), _exactlyTarget(25e18), "but grants nothing on top");
        _assertSolvent();
    }

    /// Only the board may pull a top-up. Anyone else asking gets nothing.
    function test_GrantTopUpIsBoardOnly() public {
        _fund(10_000e18);
        vm.prank(stranger);
        vm.expectRevert();
        reserve.grantTopUp(1, 100e18);
    }

    // ─── the retire waterfall ────────────────────────────────────────────────

    /// Rake splits half to the reserve and half to Treasury, and a pool nobody
    /// won forfeits whole to the reserve. Both are the reserve's income, and
    /// both have to survive the entropy swap untouched.
    function test_RetireSplitsRakeAndRoutesDeadPots() public {
        _fund(1_000e18);
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        (uint64 pickTime,,,) = _tbl(id);
        // segment 1 contested and won -> real rake
        uint8 winIdx = _charIdxFor(id, 1, W1);
        vm.prank(alice); board.place(id, 1, KX, winIdx);
        vm.prank(bob);   board.place(id, 1, KX, (winIdx + 1) % 36);
        // segment 2 contested and LOST by everyone -> dead pot
        uint8 miss = (_charIdxFor(id, 2, W2) + 1) % 36;
        vm.prank(alice); board.place(id, 2, KX, miss);
        vm.prank(bob);   board.place(id, 2, KX, (miss + 1) % 36);

        vm.warp(uint256(pickTime));
        uint256[6] memory w = _words();
        for (uint8 s = 1; s <= 6; ++s) _armLock(id, s, w[s - 1]);

        // Snapshot AFTER settlement, not before the round. The reserve is not a
        // one-way account: it paid alice's monotonic top-up while the segments
        // were settling, and that grant can exceed the income retire brings
        // back -- so measuring across the whole round tests the net of two
        // unrelated mechanisms and fails on a board that is behaving correctly.
        // This test is about what RETIRE routes, so it measures only retire.
        uint256 reserveBefore  = timbs.balanceOf(address(reserve));
        uint256 treasuryBefore = timbs.balanceOf(treasury);

        board.retire(id);

        assertGt(timbs.balanceOf(address(reserve)), reserveBefore,
                 "reserve takes half the rake plus the whole dead pot");
        assertGt(timbs.balanceOf(treasury), treasuryBefore,
                 "Treasury takes the other half of the rake");
        (, , bool retired, ) = _tbl(id);
        assertTrue(retired, "table retired");
        _assertSolvent();
    }

    /// The Repeats-a-Digit pool is never underwritten — it is a round-wide
    /// bonus stake, outside the per-segment monotonicity guarantee.
    function test_DoubleDigitIsNeverUnderwritten() public {
        _fund(10_000e18);
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        vm.prank(alice); board.placeDoubleDigit(id, CHIP25);

        uint256 reserveBefore = timbs.balanceOf(address(reserve));
        _runRound(id);
        board.retire(id);

        assertGe(timbs.balanceOf(address(reserve)), reserveBefore,
                 "the reserve never pays into the DD pool -- it only ever takes from it");
        _assertSolvent();
    }

    // ─── M6: dealer tips ─────────────────────────────────────────────────────

    /// A tip is impossible while a reveal is outstanding — paying the dealer
    /// mid-round could read as paying to influence what is still to come — and
    /// becomes possible once all six have landed.
    function test_TipIsRefusedUntilAllSixLandThenPaysTheOpener() public {
        uint256 id = _open();                 // opener = this test contract
        (, , , address opener) = _tbl(id);
        assertEq(opener, address(this), "opener recorded");

        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        (uint64 pickTime,,,) = _tbl(id);
        uint8 winIdx = _charIdxFor(id, 1, W1);
        vm.prank(alice); board.place(id, 1, KX, winIdx);
        vm.prank(bob);   board.place(id, 1, KX, (winIdx + 1) % 36);

        vm.warp(uint256(pickTime));
        uint256[6] memory w = _words();
        for (uint8 s = 1; s <= 5; ++s) _armLock(id, s, w[s - 1]);

        vm.prank(alice);
        vm.expectRevert(SegmentBoardVRF.SegmentsOutstanding.selector);
        board.tipDealer(id, 1e18);

        _armLock(id, 6, W6);

        uint256 openerBefore = ledger.credit(address(this));
        vm.prank(alice); board.tipDealer(id, 1e18);
        assertEq(ledger.credit(address(this)), openerBefore + 1e18,
                 "the tip moves credit to credit, zero rake");
        _assertSolvent();
    }

    /// A wallet that never sat cannot tip — the tip is a table courtesy, not an
    /// open transfer rail into the opener's credit.
    function test_TipRequiresASeat() public {
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);
        _runRound(id);

        vm.prank(stranger);
        vm.expectRevert();
        board.tipDealer(id, 1e18);
    }

    // ─── §9: the anti-farm rule ──────────────────────────────────────────────

    /// No subsidy flows to a pool with fewer than two distinct wallets across
    /// the table. A single wallet cannot open a table, bet itself and mine the
    /// reserve — the guarantee is for players, not for a loop.
    function test_UncontestedTableDrawsNoSubsidy() public {
        _fund(10_000e18);
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);

        // one seat only: the table can never arm, so it cancels rather than pays
        (uint64 pickTime,,,) = _tbl(id);
        vm.warp(uint256(pickTime));
        vm.expectRevert();
        vm.prank(stranger); board.armSegment(id, 1);

        assertEq(timbs.balanceOf(address(reserve)), 10_000e18, "reserve untouched");
    }
}
