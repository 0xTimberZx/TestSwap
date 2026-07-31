// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

// Run: forge test --match-contract SegmentBoardGen6Test -vvv
//
// Gen-6 behaviour suite (SwapTables/docs/UNDERWRITE_SPEC.md + GEN6_DEALER_TIP.md
// + GAME_ECONOMY.md): the monotonic underwrite (M1), the rake split and
// dead-pot waterfall that fund it, the solvency counters, and dealer tips (M6).
//
// Determinism: forge's blockhash is deterministic, so the tests snapshot state,
// run the pick once to LEARN the chars, revert, and then bet EXACTLY on (or
// deliberately off) the known outcome. No test depends on luck.

import "forge-std/Test.sol";
import "../contracts/SegmentBoard.sol";
import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/CommitRevealEntropy.sol";
import "../contracts/UnderwriteReserve.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockTIMBS6 is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") {}
    function mintTo(address to, uint256 amt) external { _mint(to, amt); }
}

contract MockTimbPrize6 {
    mapping(uint256 => bytes6) public roundWinningString;
    function setResult(uint256 round, bytes6 s) external { roundWinningString[round] = s; }
}

contract SegmentBoardGen6Test is Test {
    MockTIMBS6          timbs;
    MockTimbPrize6      prize;
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

    uint8 constant CHIP5    = 0; // 5 TIMBS
    uint8 constant CHIP25   = 2; // 25 TIMBS
    uint8 constant CHIP500  = 5; // 500 TIMBS
    uint8 constant CHIP1000 = 6; // 1000 TIMBS

    uint256 constant SEED       = 100e18;
    uint256 constant SEED_SHARE = uint256(100e18) / 7;

    string constant ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    uint256 nextRound = 7;

    // Cached in setUp: board.KIND_EXACTLY() is an external call, and an
    // inline getter after vm.prank would CONSUME the prank — the very bug
    // the legacy suite's kLetter/kNumber cache exists to prevent.
    uint8 KX;

    function setUp() public {
        vm.warp(1_000_000);
        vm.roll(1_000);

        timbs    = new MockTIMBS6();
        prize    = new MockTimbPrize6();
        ledger   = new PoolLedger(address(timbs), treasury);
        registry = new SeedRegistry();
        ent      = new CommitRevealEntropy();
        // guardian = this test, so halt behaviour can be exercised
        reserve  = new UnderwriteReserve(address(timbs), treasury, address(this));

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

        KX = board.KIND_EXACTLY();
    }

    // ─── helpers ──────────────────────────────────────────────────────────────

    function _fund(uint256 amount) internal {
        // initial variance cover: a plain transfer, per the deploy runbook
        timbs.mintTo(address(reserve), amount);
    }

    function _secret(uint256 id, uint8 seg) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("gen6-secret", id, seg));
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

    function _sitLoad(address who, uint256 id, uint8 chip) internal {
        vm.startPrank(who);
        board.sit(id, bytes6("TICKET"));
        board.loadTokens(id, [chip, chip, chip, chip, chip, chip]);
        vm.stopPrank();
    }

    function _pickTimeOf(uint256 id) internal view returns (uint64 pickTime) {
        (, pickTime,,,,,,,,,,,,,) = board.tables(id);
    }

    function _openerOf(uint256 id) internal view returns (address opener) {
        (,,,,,,,,,,,,,, opener) = board.tables(id);
    }

    /// @dev Run the pick on a snapshot to learn the chars, then rewind.
    ///      Chars depend only on commitments, secrets, salts and
    ///      blockhash(armBlock) — none of which the rewind disturbs — so the
    ///      replay lands the exact same six characters.
    function _predictChars(uint256 id, uint256 armBlock) internal returns (bytes6 chars) {
        uint256 snap = vm.snapshotState();
        _armAndLock(id, armBlock);
        chars = board.lockedCharsOf(id);
        vm.revertToState(snap);
    }

    function _armAndLock(uint256 id, uint256 armBlock) internal {
        vm.warp(uint256(_pickTimeOf(id)) + 1);
        vm.roll(armBlock);
        board.armTable(id);
        vm.roll(armBlock + 1);
        for (uint8 s = 1; s <= 6; ++s) board.lockSegment(id, s, _secret(id, s));
    }

    function _idxOf(bytes1 c) internal pure returns (uint8) {
        uint8 b = uint8(c);
        return (b >= 65 && b <= 90) ? b - 65 : 26 + b - 48;
    }

    /// @dev target = stake x (36/symbols) x 0.90 for EXACTLY (36 symbols -> 1)
    function _exactlyTarget(uint256 stake) internal pure returns (uint256) {
        return stake * 36 * 9000 / 10000;
    }

    // ─── M1: the monotonic underwrite ────────────────────────────────────────

    /// The spec's worked example: a solo 25 on Exactly goes from 23 (gen-4)
    /// through 25 (gen-5 Layer 0) to 810 — stake x 36 x 0.90.
    function test_SoloExactlyIsToppedUpToTarget() public {
        _fund(10_000e18);
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);

        // alice bets the KNOWN outcome, solo; bob stays off this pool
        vm.prank(alice);
        board.place(id, 1, KX, _idxOf(chars[0]));

        _armAndLock(id, armBlock);

        assertEq(ledger.credit(alice), _exactlyTarget(25e18), "25 -> 810: par from the pool, the rest from the reserve");
        // ledger backed the top-up with real tokens before crediting
        assertGe(ledger.heldBalance(), ledger.totalCredited() + ledger.totalEscrowed(), "escrow-sacred invariant");
    }

    /// THE law (UNDERWRITE_SPEC acceptance criterion): a joiner who loses can
    /// never reduce the existing player's payout. Same 810, to the wei.
    function test_MonotonicityLosingJoinerNeverLowersThePayout() public {
        _fund(10_000e18);
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);
        uint8 winIdx = _idxOf(chars[0]);

        vm.prank(alice);
        board.place(id, 1, KX, winIdx);
        vm.prank(bob);   // joins the pool and loses — contested, raked, and STILL 810
        board.place(id, 1, KX, (winIdx + 1) % 36);

        _armAndLock(id, armBlock);

        assertEq(ledger.credit(alice), _exactlyTarget(25e18), "monotonic: the loser's chips only reduce the reserve's share");
    }

    /// A pool that already clears the target draws nothing — the mechanism
    /// fades out exactly where pari-mutuel starts working.
    function test_BusyPoolBeyondTargetDrawsNothing() public {
        _fund(10_000e18);
        uint256 id = _open();
        _sitLoad(alice, id, CHIP5);
        _sitLoad(bob,   id, CHIP500);
        _sitLoad(carol, id, CHIP500);

        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);
        uint8 winIdx = _idxOf(chars[0]);

        vm.prank(alice); board.place(id, 1, KX, winIdx);
        vm.prank(bob);   board.place(id, 1, KX, (winIdx + 1) % 36);
        vm.prank(carol); board.place(id, 1, KX, (winIdx + 2) % 36);

        uint256 reserveBefore = timbs.balanceOf(address(reserve));
        _armAndLock(id, armBlock);

        // pot = 5 + 500 + 500 + seed share, rake(3) = 175 + 625/3 = 383 bps
        uint256 pot  = 1005e18 + SEED_SHARE;
        uint256 pay  = (pot * (10000 - 383)) / 10000;
        assertGt(pay, _exactlyTarget(5e18), "sanity: pool alone beats the target");
        assertEq(ledger.credit(alice), pay, "winner takes the whole pool, unbounded by the target");
        assertEq(timbs.balanceOf(address(reserve)), reserveBefore, "reserve untouched");
    }

    /// Caps: per-pool 1000 clamps a whale's ask; the 1500 round cap then
    /// squeezes the second pool. First-settled-first-served.
    function test_PoolAndRoundCapsClampInOrder() public {
        _fund(30_000e18);
        uint256 id = _open();
        _sitLoad(alice, id, CHIP1000);
        _sitLoad(bob,   id, CHIP25);

        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);

        vm.startPrank(alice); // solo Exactly wins on segments 1 AND 2
        board.place(id, 1, KX, _idxOf(chars[0]));
        board.place(id, 2, KX, _idxOf(chars[1]));
        vm.stopPrank();

        _armAndLock(id, armBlock);

        // each pool: par 1000 from the pot; wanted 31,400 -> pool cap 1000;
        // pool 1 grants 1000, pool 2 hits the round cap's remaining 500
        assertEq(ledger.credit(alice), 2000e18 + 1500e18, "two pars + 1000 + 500");
        assertEq(reserve.roundUsed(id), 1500e18, "round cap exhausted");
    }

    /// An empty reserve grants zero and settlement completes — the shortfall
    /// is emitted, never thrown.
    function test_EmptyReserveNeverBlocksSettlement() public {
        uint256 id = _open(); // reserve NOT funded
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);
        vm.prank(alice);
        board.place(id, 1, KX, _idxOf(chars[0]));

        vm.recordLogs();
        _armAndLock(id, armBlock);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(ledger.credit(alice), 25e18, "par only - Layer 0 still holds");
        bytes32 sig = keccak256("PoolUnderwritten(uint256,uint8,uint256,uint256)");
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            (uint256 wanted, uint256 granted) = abi.decode(logs[i].data, (uint256, uint256));
            if (uint256(logs[i].topics[2]) == 0) {
                seen = true;
                assertEq(wanted, _exactlyTarget(25e18) - 25e18, "shortfall reported");
                assertEq(granted, 0, "nothing to grant");
            }
        }
        assertTrue(seen, "PoolUnderwritten emitted for the thin pool");
    }

    /// A halted reserve behaves like an empty one: grants zero, blocks nothing.
    function test_HaltedReserveGrantsNothing() public {
        _fund(10_000e18);
        reserve.setHalted(true); // this test is the guardian

        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);
        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);
        vm.prank(alice);
        board.place(id, 1, KX, _idxOf(chars[0]));

        _armAndLock(id, armBlock);
        assertEq(ledger.credit(alice), 25e18, "par only while halted");
    }

    /// Double-Digit is NOT underwritten (decision 2026-07-31): whatever the
    /// outcome, no PoolUnderwritten ever names pool 6.
    function test_DoubleDigitIsNeverUnderwritten() public {
        _fund(10_000e18);
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);
        vm.prank(alice); board.placeDoubleDigit(id, CHIP25);
        vm.prank(bob);   board.placeDoubleDigit(id, CHIP25);

        vm.recordLogs();
        _armAndLock(id, vm.getBlockNumber() + 50);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bytes32 sig = keccak256("PoolUnderwritten(uint256,uint8,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) {
                assertTrue(uint256(logs[i].topics[2]) != 6, "DD pool must never be underwritten");
            }
        }
    }

    function test_GrantTopUpIsBoardOnly() public {
        _fund(1_000e18);
        vm.prank(alice);
        vm.expectRevert(UnderwriteReserve.NotBoard.selector);
        reserve.grantTopUp(1, 1e18);
    }

    // ─── Layer 2: rake split, dead pots, waterfall, solvency ─────────────────

    /// The full-round split: every dead pot + half the rake to the reserve,
    /// the rest to Treasury — and the counters record both sides.
    function test_RetireSplitsRakeAndRoutesDeadPots() public {
        uint256 id = _open(); // reserve unfunded: its balance after = income only
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);
        uint8 winIdx = _idxOf(chars[0]);

        // pool 0: contested, alice wins -> real rake accrues
        vm.prank(alice); board.place(id, 1, KX, winIdx);
        vm.prank(bob);   board.place(id, 1, KX, (winIdx + 1) % 36);
        // pool 1: alice deliberately loses solo -> a 25 dead pot
        vm.prank(alice); board.place(id, 2, KX, (_idxOf(chars[1]) + 1) % 36);

        _armAndLock(id, armBlock);

        uint256 pot     = 50e18 + SEED_SHARE;
        uint256 rake    = pot - (pot * (10000 - 487)) / 10000; // rake(2) = 487 bps
        uint256 dead    = 25e18;
        uint256 tBefore = timbs.balanceOf(treasury);
        board.retire(id);

        assertEq(timbs.balanceOf(address(reserve)), dead + rake / 2, "reserve: dead pot + half the rake");
        assertEq(reserve.gameIncome(), dead + rake / 2, "income counter");
        uint256 sweptToTreasury = timbs.balanceOf(treasury) - tBefore;
        assertGt(sweptToTreasury, 0, "treasury still gets its half + unconsumed seed");
        assertEq(reserve.treasuryEarned(), sweptToTreasury, "solvency counter mirrors the sweep");
        assertEq(ledger.tableEscrow(id), 0, "table fully drained");
    }

    /// Waterfall: income beyond floatTarget parks as overflow, earmarked for
    /// the jackpot + la partage — and grants cannot spend the earmark.
    function test_WaterfallParksOverflowBeyondFloatTarget() public {
        reserve.setFloatTarget(10e18); // owner = this test
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);
        vm.prank(alice); // solo, deliberately wrong -> 25 dead pot
        board.place(id, 1, KX, (_idxOf(chars[0]) + 1) % 36);

        _armAndLock(id, armBlock);
        board.retire(id);

        assertEq(timbs.balanceOf(address(reserve)), 25e18);
        assertEq(reserve.overflowEarmark(), 15e18, "everything past the float target is parked");
        assertEq(reserve.freeFloat(), 10e18, "grants may only touch the float");
    }

    /// No minting, only recycling: budgeted Treasury support is bounded by
    /// what the game has actually swept to Treasury.
    function test_BudgetedSupportCannotExceedGameEarnings() public {
        // before any retire: nothing earned, nothing fundable
        timbs.mintTo(address(this), 1_000e18);
        timbs.approve(address(reserve), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(
            UnderwriteReserve.ExceedsBudget.selector, uint256(1e18), uint256(0), uint256(0)));
        reserve.fundBudgeted(1e18);

        // run a round that sweeps something to Treasury
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);
        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);
        uint8 winIdx = _idxOf(chars[0]);
        vm.prank(alice); board.place(id, 1, KX, winIdx);
        vm.prank(bob);   board.place(id, 1, KX, (winIdx + 1) % 36);
        _armAndLock(id, armBlock);
        board.retire(id);

        uint256 earned = reserve.treasuryEarned();
        assertGt(earned, 0);
        reserve.fundBudgeted(earned);              // exactly the budget: fine
        vm.expectRevert(abi.encodeWithSelector(
            UnderwriteReserve.ExceedsBudget.selector, uint256(1), earned, earned));
        reserve.fundBudgeted(1);                   // one wei past: refused
    }

    // ─── M6: tip the dealer ──────────────────────────────────────────────────

    function test_TipDealerAfterTheLocks() public {
        uint256 id = _open(); // opener = this test contract
        assertEq(_openerOf(id), address(this), "opener recorded");
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);

        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);
        uint8 winIdx = _idxOf(chars[0]);
        vm.prank(alice); board.place(id, 1, KX, winIdx);
        vm.prank(bob);   board.place(id, 1, KX, (winIdx + 1) % 36);

        // before the sixth lock a tip must be impossible — while a reveal is
        // outstanding it could read as paying to influence it
        vm.warp(uint256(_pickTimeOf(id)) + 1);
        vm.roll(armBlock);
        board.armTable(id);
        vm.roll(armBlock + 1);
        for (uint8 s = 1; s <= 5; ++s) board.lockSegment(id, s, _secret(id, s));
        vm.prank(alice);
        vm.expectRevert(SegmentBoard.SegmentsOutstanding.selector);
        board.tipDealer(id, 1e18);

        board.lockSegment(id, 6, _secret(id, 6));

        // sealed outcome: the winner tips from credit, one click, zero rake
        uint256 win = ledger.credit(alice);
        assertGt(win, 0);
        vm.prank(alice);
        board.tipDealer(id, 15e18);
        assertEq(ledger.credit(alice), win - 15e18);
        assertEq(ledger.credit(address(this)), 15e18, "dealer received the tip");

        // still open after retire — next-morning gratitude counts
        board.retire(id);
        vm.prank(alice);
        board.tipDealer(id, 5e18);
        assertEq(ledger.credit(address(this)), 20e18);
    }

    function test_TipRequiresASeatAndRealCredit() public {
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        _sitLoad(bob,   id, CHIP25);
        uint256 armBlock = vm.getBlockNumber() + 50;
        bytes6 chars = _predictChars(id, armBlock);
        vm.prank(alice);
        board.place(id, 1, KX, _idxOf(chars[0]));
        _armAndLock(id, armBlock);

        // spectators cannot tip — it is a table ritual
        vm.prank(carol);
        vm.expectRevert(SegmentBoard.NotSeated.selector);
        board.tipDealer(id, 1e18);

        // and nobody tips money they do not have
        uint256 have = ledger.credit(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(
            PoolLedger.ExceedsCredit.selector, alice, have + 1, have));
        board.tipDealer(id, have + 1);
    }

    function test_MoveCreditIsBoardOnly() public {
        vm.prank(alice);
        vm.expectRevert(PoolLedger.NotBoard.selector);
        ledger.moveCredit(alice, bob, 1e18);
    }

    // ─── ABI stability ───────────────────────────────────────────────────────

    function test_TablesGetterAppendsOpenerOnly() public {
        // The deployed crank reads the first ten fields; the gen-5 apps read
        // fourteen. `opener` is appended as the fifteenth — nothing moved.
        uint256 id = _open();
        _sitLoad(alice, id, CHIP25);
        (uint64 openedAt,,,, uint8 seatCount,,,,,,,,, uint8 loadedCount, address opener) = board.tables(id);
        assertEq(openedAt, uint64(vm.getBlockTimestamp()));
        assertEq(seatCount, 1);
        assertEq(loadedCount, 1);
        assertEq(opener, address(this));
    }
}
