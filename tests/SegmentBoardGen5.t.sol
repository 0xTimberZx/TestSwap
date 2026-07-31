// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract SegmentBoardGen5Test -vvv
//
// Gen-5 behaviour suite (SwapTables/docs/GEN5_ADAPTIVE_ENTRY.md +
// UNDERWRITE_SPEC.md Layer 0): adaptive entry, late loading, arm on funded
// seats, and the no-rake-uncontested settle rule. The legacy suite
// (SegmentBoard.t.sol) pins its timers to the ceiling so gen-4 behaviour is
// regression-tested there; everything here uses tight timers on purpose.

import "forge-std/Test.sol";
import "../contracts/SegmentBoard.sol";
import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/CommitRevealEntropy.sol";
import "../contracts/UnderwriteReserve.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBS5 is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {}
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockTimbPrize5 {
    mapping(uint256 => bytes6) public roundWinningString;
    function setResult(uint256 round, bytes6 s) external { roundWinningString[round] = s; }
}

contract SegmentBoardGen5Test is Test {
    MockTIMBS5          timbs;
    MockTimbPrize5      prize;
    PoolLedger          ledger;
    SeedRegistry        registry;
    CommitRevealEntropy ent;
    SegmentBoard        board;
    UnderwriteReserve   reserve;

    address treasury = address(0x7EA5);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);
    address carol    = address(0xCA401);

    // Tight gen-5 production-shaped dials.
    uint64 constant ENTRY_MAX    = 40 minutes;
    uint64 constant PLACE_WINDOW = 5 minutes;
    uint64 constant BETS_CLOSE   = 2 minutes;
    uint64 constant SIT_QUIET    = 5 minutes;
    uint64 constant SOLO_WAIT    = 15 minutes;

    uint8 constant CHIP25 = 2; // 25 TIMBS
    uint256 constant SEED_SHARE_WEI = uint256(100e18) / 7;

    uint256 nextRound = 7;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(1_000);

        timbs    = new MockTIMBS5();
        prize    = new MockTimbPrize5();
        ledger   = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry();
        ent      = new CommitRevealEntropy();

        // Empty reserve: grants are 0, so gen-5 behaviour is unchanged here.
        reserve = new UnderwriteReserve(address(timbs), treasury, address(0));
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

    // ─── helpers ──────────────────────────────────────────────────────────────

    function _secret(uint256 id, uint8 seg) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("gen5-secret", id, seg));
    }

    function _open() internal returns (uint256 id) {
        prize.setResult(nextRound, bytes6("ABCDEF"));
        uint256 wantId = board.nextTableId();
        bytes32[6] memory secs;
        for (uint8 s = 1; s <= 6; ++s) secs[s-1] = _secret(wantId, s);
        bytes32[6] memory commits = board.commitmentsFor(secs, wantId);
        id = board.openTable(nextRound, commits);
        ++nextRound;
    }

    function _sitLoad(address who, uint256 id) internal {
        vm.startPrank(who);
        board.sit(id, bytes6("TICKET"));
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        vm.stopPrank();
    }

    function _marks(uint256 id) internal view
        returns (uint64 openedAt, uint64 pickTime, uint64 entryCloseAt, uint8 loadedCount)
    {
        (openedAt, pickTime,,,,,,,,, entryCloseAt,,, loadedCount,) = board.tables(id);
    }

    function _lockAllSix(uint256 id) internal {
        vm.roll(vm.getBlockNumber() + 2);
        for (uint8 s = 1; s <= 6; ++s) board.lockSegment(id, s, _secret(id, s));
    }

    // ─── adaptive entry ───────────────────────────────────────────────────────

    function test_CeilingStandsWhileNobodyIsFunded() public {
        uint256 id = _open();
        (uint64 openedAt, uint64 pickTime, uint64 closeAt,) = _marks(id);
        assertEq(closeAt, openedAt + ENTRY_MAX, "ceiling on open");
        assertEq(pickTime, closeAt + PLACE_WINDOW + BETS_CLOSE, "schedule rides the close");

        // seats without chips do not start any clock
        vm.prank(alice); board.sit(id, bytes6("AAAAAA"));
        vm.prank(bob);   board.sit(id, bytes6("BBBBBB"));
        (,, uint64 closeAt2,) = _marks(id);
        assertEq(closeAt2, closeAt, "unfunded sits never pull the close in");
    }

    function test_QuorumQuietClosesEntry() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        vm.warp(vm.getBlockTimestamp() + 60);
        _sitLoad(bob, id);                      // quorum forms at T+60

        (uint64 openedAt, uint64 pickTime, uint64 closeAt, uint8 loaded) = _marks(id);
        assertEq(loaded, 2);
        assertEq(closeAt, uint64(vm.getBlockTimestamp()) + SIT_QUIET, "quiet clock from last join");
        assertLt(closeAt, openedAt + ENTRY_MAX, "earlier than the ceiling");
        assertEq(pickTime, closeAt + PLACE_WINDOW + BETS_CLOSE);

        // and it actually closes: a sit after the quiet period reverts
        vm.warp(closeAt);
        vm.prank(carol);
        vm.expectRevert(SegmentBoard.TableClosedForEntry.selector);
        board.sit(id, bytes6("CCCCCC"));
    }

    function test_EveryJoinPushesTheQuietClock() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        (,, uint64 closeA,) = _marks(id);

        vm.warp(vm.getBlockTimestamp() + 3 minutes);
        vm.prank(carol); board.sit(id, bytes6("CCCCCC"));   // a bare sit is a join too
        (,, uint64 closeB,) = _marks(id);
        assertEq(closeB, uint64(vm.getBlockTimestamp()) + SIT_QUIET, "sit pushed the clock");
        assertGt(closeB, closeA, "later than before");
    }

    function test_QuietClockClampsAtTheCeiling() public {
        uint256 id = _open();
        (uint64 openedAt,,,) = _marks(id);
        // seats only — no clock starts, so the door stays open to the ceiling
        vm.prank(alice); board.sit(id, bytes6("AAAAAA"));
        vm.prank(bob);   board.sit(id, bytes6("BBBBBB"));

        // quorum forms with 30 seconds left: the quiet clock would land past
        // the ceiling, so the close (and the schedule) clamp to it instead
        vm.warp(openedAt + ENTRY_MAX - 30);
        vm.prank(alice); board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        vm.prank(bob);   board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        (, uint64 pickTime, uint64 closeAt, uint8 loaded) = _marks(id);
        assertEq(loaded, 2);
        assertEq(closeAt, openedAt + ENTRY_MAX, "clamped to the ceiling");
        assertEq(pickTime, closeAt + PLACE_WINDOW + BETS_CLOSE);
    }

    function test_LoneFundedPlayerWaitsSoloWaitOnly() public {
        uint256 id = _open();
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        _sitLoad(alice, id);
        (uint64 openedAt,, uint64 closeAt, uint8 loaded) = _marks(id);
        assertEq(loaded, 1);
        assertEq(closeAt, uint64(vm.getBlockTimestamp()) + SOLO_WAIT, "solo clock from first load");
        assertLt(closeAt, openedAt + ENTRY_MAX);
    }

    function test_SoloToQuorumTransitionNeverWritesThePast() public {
        uint256 id = _open();
        _sitLoad(alice, id);                     // solo close = T + SOLO_WAIT
        (,, uint64 soloClose,) = _marks(id);

        vm.warp(vm.getBlockTimestamp() + SOLO_WAIT - 1 minutes);
        _sitLoad(bob, id);                       // rule switches to quiet quorum
        (,, uint64 closeAt,) = _marks(id);
        assertEq(closeAt, uint64(vm.getBlockTimestamp()) + SIT_QUIET,
            "quiet clock measured from the join that formed quorum");
        assertGe(closeAt, uint64(vm.getBlockTimestamp()), "never in the past");
        // and the schedule may legitimately land earlier than the solo close would have
        assertLt(closeAt, soloClose + SIT_QUIET);
    }

    // ─── late loading ─────────────────────────────────────────────────────────

    function test_SeatedWalletLoadsAndPlacesAfterEntryCloses() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        vm.prank(carol); board.sit(id, bytes6("CCCCCC"));   // seated, unfunded

        // let entry close (quiet quorum)
        (, uint64 pickTime, uint64 closeAt,) = _marks(id);
        vm.warp(closeAt + 1);

        // gen-4 stranded this seat; gen-5 lets it fund until bets close
        vm.startPrank(carol);
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        board.place(id, 1, board.KIND_LETTER(), 0);
        vm.stopPrank();
        (,,, uint8 loaded) = _marks(id);
        assertEq(loaded, 3, "late load counted");

        // but never after bets close
        vm.warp(pickTime - BETS_CLOSE);
        vm.prank(address(0xDEAD));
        vm.expectRevert(SegmentBoard.TableClosedForEntry.selector);
        board.sit(id, bytes6("DDDDDD"));
    }

    function test_LoadRejectedOnceBetsClose() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        vm.prank(carol); board.sit(id, bytes6("CCCCCC"));

        (, uint64 pickTime,,) = _marks(id);
        vm.warp(pickTime - BETS_CLOSE);          // exactly at the cutoff
        vm.prank(carol);
        vm.expectRevert(SegmentBoard.BetsClosed.selector);
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
    }

    function test_LateLoadCannotReopenEntry() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        vm.prank(carol); board.sit(id, bytes6("CCCCCC"));
        (,, uint64 closeAt,) = _marks(id);
        vm.warp(closeAt + 30);

        vm.prank(carol);
        board.loadTokens(id, [CHIP25, CHIP25, CHIP25, CHIP25, CHIP25, CHIP25]);
        (, uint64 pickAfter, uint64 closeAfter,) = _marks(id);
        assertEq(closeAfter, closeAt, "a late load must not move a closed window");
        assertEq(pickAfter, closeAt + PLACE_WINDOW + BETS_CLOSE);
    }

    // ─── arm on funded seats ──────────────────────────────────────────────────

    function test_ArmRefusesUnfundedQuorum() public {
        uint256 id = _open();
        _sitLoad(alice, id);                     // 1 funded
        vm.prank(bob); board.sit(id, bytes6("BBBBBB")); // 2 seated, 1 funded

        (, uint64 pickTime,,) = _marks(id);
        vm.warp(pickTime + 1);
        vm.expectRevert(abi.encodeWithSelector(
            SegmentBoard.NotEnoughSeats.selector, uint8(1), uint8(2)));
        board.armTable(id);

        // and the table is cancellable on the same test: funded count < min
        board.cancelTable(id);
        (,,,,,,, bool retired,,,,,,,) = board.tables(id);
        assertTrue(retired, "under-funded table cancels");
    }

    function test_TwoFundedSeatsArm() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);
        (, uint64 pickTime,,) = _marks(id);
        vm.warp(pickTime + 1);
        board.armTable(id);                       // must not revert
        (,, uint64 lockBlock,,,,,,,,,,,,) = board.tables(id);
        assertGt(lockBlock, 0, "armed");
    }

    // ─── Layer 0: no rake on an uncontested pool ─────────────────────────────

    function test_SoloPoolsPayParOrForfeitWhole_ContestedPoolStillRaked() public {
        uint256 id = _open();
        _sitLoad(alice, id);
        _sitLoad(bob, id);

        // Segment 1 is CONTESTED: alice letters vs bob numbers (exactly one wins).
        // Segments 2-6 are SOLO alice letter bets; bob leaves five tokens unplaced.
        uint8 L = board.KIND_LETTER();
        uint8 N = board.KIND_NUMBER();
        vm.startPrank(alice);
        for (uint8 s = 1; s <= 6; ++s) board.place(id, s, L, 0);
        vm.stopPrank();
        vm.prank(bob); board.place(id, 1, N, 0);

        (, uint64 pickTime,,) = _marks(id);
        vm.warp(pickTime + 1);
        board.armTable(id);
        vm.recordLogs();
        _lockAllSix(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("PoolSettled(uint256,uint8,uint256,uint256,uint256)");
        uint256 chip = 25e18;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            // pools are 0-indexed: segment s settles as pool s-1, Double-Digit as 6
            uint8 pool = uint8(uint256(logs[i].topics[2]));
            (uint256 pot, uint256 rake, uint256 distributed) =
                abi.decode(logs[i].data, (uint256, uint256, uint256));
            if (pool == 0) {
                // contested (segment 1): pot = 2 chips + seed share, graduated rake applies
                assertEq(pot, 2 * chip + SEED_SHARE_WEI, "contested pot");
                uint256 expDist = (pot * (10000 - 487)) / 10000; // rake(2) = 175 + 625/2 = 487 bps
                assertEq(distributed, expDist, "graduated rake still taken when contested");
                assertEq(rake, pot - distributed);
            } else if (pool >= 1 && pool <= 5) {
                // solo: either the winner takes the WHOLE pot (par - Layer 0,
                // was 0.92x before) or there is no winner and it all forfeits.
                assertEq(pot, chip, "solo pot is the player's own chip, no seed");
                if (distributed > 0) {
                    assertEq(distributed, pot, "Layer 0: solo winner takes par, zero rake");
                    assertEq(rake, 0, "no rake without a contest");
                } else {
                    assertEq(rake, pot, "no winner: whole pot forfeits");
                }
            }
        }
    }

    // ─── the deployed crank still fits the new ABI ────────────────────────────

    function test_TablesGetterAppendsFieldsOnly() public {
        // The generation-agnostic SegmentCrank destructures the first ten
        // return values of tables(). Appending gen-5 fields must not disturb
        // their positions.
        uint256 id = _open();
        _sitLoad(alice, id);
        (uint64 openedAt,,,, uint8 seatCount, uint8 lockedMask,,,,,,,,,) = board.tables(id);
        assertEq(openedAt, uint64(vm.getBlockTimestamp()));
        assertEq(seatCount, 1);
        assertEq(lockedMask, 0);
    }
}
