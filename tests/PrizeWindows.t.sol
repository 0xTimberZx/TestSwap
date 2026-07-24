// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import "../contracts/PrizeEscrow.sol";
import "../contracts/GameRegistry.sol";
import "../contracts/TimbPrize.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Minimal TIMBS stand-in — the registry only needs transferFrom/transfer.
contract MockTIMBS is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") { _mint(msg.sender, 1_000_000e18); }
}

/**
 * @title PrizeWindowsTest
 * @notice §14 claim/refund windows + §13.2 settlement jitter.
 *
 * Coverage:
 *   - Jitter: locked char equals the keccak mirror; winning string is built
 *     from locked chars, not counter % 36.
 *   - Prize claim: 2 rounds flat from the match (R+1, R+2 pass; R+3 reverts).
 *   - Principal refund: 4 rounds after lastEligibleRound for non-winners
 *     (LER+4 passes; sweep forfeits to the sink after; refund then reverts).
 *   - §14 (v5): a ticket that wins its LAST eligible round has its forfeiture
 *     pushed to LER+6 — the 4-round refund countdown starts after the 2-round
 *     claim window, not overlapping it. Refundable at LER+5 (past the old
 *     window); forfeited at LER+6.
 *   - Missed prize: recycleUnclaimed is permissionless once the window is
 *     over, reverts inside it, and never touches the winner's principal window.
 *
 * Determinism note: these tests never vm.roll, so blockhash(block.number-1)
 * is constant for the whole run — the expected winning string of any future
 * round (with untouched counters) is precomputable, which is how the winner
 * fixtures pre-commit a matching ticket.
 *
 * Run: forge test --match-contract PrizeWindowsTest -vvv
 */
contract PrizeWindowsTest is Test {
    bytes constant ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    MockTIMBS    timbs;
    PrizeEscrow  escrow;
    GameRegistry registry;
    TimbPrize    prize;

    address sink   = address(0xBEEF);
    address player = address(0xA11CE);
    address rando  = address(0xF00D);

    // v5 dynamic pricing: ETH entries sit on the floor here (escrow never nears
    // the 1.1 ETH threshold in these windows tests).
    uint256 constant ENTRY_ETH = 0.001 ether; // ETH_ENTRY_FLOOR

    function setUp() public {
        timbs    = new MockTIMBS();
        escrow   = new PrizeEscrow();
        registry = new GameRegistry(address(timbs), sink, address(0));
        prize    = new TimbPrize(address(escrow), address(registry), address(this));

        registry.setTimbPrize(address(prize));
        // Entry costs are dynamic in v5 — no setter.
        escrow.setTimbPrize(address(prize));

        prize.startGame();

        vm.deal(player, 1 ether);
        vm.deal(rando, 1 ether);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev The seed counter for (round, segment). Round 1 starts at 0 (startGame),
    ///      and every rollover seeds the next round's counter to the index of the
    ///      just-locked jittered char (TimbPrize line 506). No swaps run in these
    ///      tests, so the counter is never nudged mid-round and — starting from a
    ///      letter (index 0) — stays in the letter class every round, so each
    ///      locked-char index is `mix % 26`, which becomes the next round's seed.
    function counterAt(uint256 round, uint256 segment) internal view returns (uint256 c) {
        c = 0; // round 1
        for (uint256 r = 1; r < round; r++) {
            uint256 mix = uint256(keccak256(abi.encodePacked(
                blockhash(block.number - 1), c, r, segment
            )));
            c = mix % 26; // locked-char index (letter class) = next round's seed
        }
    }

    /// @dev Mirror of TimbPrize._lockCurrentSegment. Class-preserving jitter
    ///      (§13.2): the live char stays in the letter class here, so the locked
    ///      char is ALPHABET[mix % 26] with the round's carried-over counter.
    function expectedChar(uint256 round, uint256 segment) internal view returns (bytes1) {
        uint256 c = counterAt(round, segment);
        uint256 mix = uint256(keccak256(abi.encodePacked(
            blockhash(block.number - 1), c, round, segment
        )));
        return ALPHABET[mix % 26];
    }

    function expectedString(uint256 round) internal view returns (bytes6) {
        bytes memory s = new bytes(6);
        for (uint256 i = 1; i <= 6; i++) s[i - 1] = expectedChar(round, i);
        return bytes6(s);
    }

    function hasRepeats(bytes6 s) internal pure returns (bool) {
        for (uint256 i = 0; i < 6; i++) {
            for (uint256 j = i + 1; j < 6; j++) {
                if (s[i] == s[j]) return true;
            }
        }
        return false;
    }

    /// @dev Settle exactly one segment (or roll the round on segment 6).
    function settleOne() internal {
        vm.warp(prize.segmentStartTime() + prize.INTERACTION_WINDOW() + 1);
        prize.settleSegment();
    }

    /// @dev Run full rounds until currentRound == target.
    function runUntilRound(uint256 target) internal {
        while (prize.currentRound() < target) settleOne();
    }

    /// @dev First future round (≥ min) whose expected string has no repeats —
    ///      submitEntry enforces no-repeat tickets, so only such rounds are
    ///      winnable by a pre-committed exact match.
    function findWinnableRound(uint256 min) internal view returns (uint256) {
        for (uint256 r = min; r < min + 64; r++) {
            if (!hasRepeats(expectedString(r))) return r;
        }
        revert("no winnable round in range");
    }

    /// @dev Pre-commit a matching ticket for round T and run T to settlement.
    ///      Returns T. Player's ticket: playRound = lastEligibleRound = T.
    function makeWinner() internal returns (uint256 T) {
        T = findWinnableRound(prize.currentRound() + 2);
        runUntilRound(T - 1);                       // entry during T-1 plays T
        vm.prank(player);
        registry.submitEntry{value: ENTRY_ETH}(expectedString(T), true, 0);
        prize.fundPot{value: 1 ether}();            // a claimable pot must exist
        runUntilRound(T + 1);                       // round T fully settled
        assertEq(prize.roundWinningString(T), expectedString(T), "fixture: string mismatch");
        (, , address[] memory w, ,) = prize.getRoundResult(T);
        assertEq(w.length, 1, "fixture: expected exactly one winner");
        assertEq(w[0], player, "fixture: wrong winner");
    }

    // ─── §13.2 Jitter ────────────────────────────────────────────────────────

    function test_LockedCharMatchesKeccakMirror() public {
        uint256 round = prize.currentRound();
        bytes1 expect = expectedChar(round, 1);
        settleOne();
        assertEq(prize.segmentLockedChar(1), expect, "locked char != keccak mirror");
        assertTrue(prize.segmentDigitLocked(1), "segment not locked");
    }

    function test_WinningStringBuiltFromLockedChars() public {
        uint256 round = prize.currentRound();
        bytes6 expect = expectedString(round);
        runUntilRound(round + 1);
        assertEq(prize.roundWinningString(round), expect, "winning string != locked chars");
    }

    // ─── §14 Prize claim: 2 rounds flat ─────────────────────────────────────

    function test_ClaimSucceedsWithinTwoRounds() public {
        uint256 T = makeWinner();                   // currentRound == T+1
        runUntilRound(T + 2);                       // last allowed round
        uint256 balBefore = player.balance;
        vm.prank(player);
        prize.claimWinnings(T);
        assertGt(player.balance, balBefore, "no payout received");
    }

    function test_ClaimRevertsAfterTwoRounds() public {
        uint256 T = makeWinner();
        runUntilRound(T + 3);                       // window over
        vm.prank(player);
        vm.expectRevert();
        prize.claimWinnings(T);
    }

    // ─── §14 Principal refund: 4 rounds ─────────────────────────────────────

    function test_RefundSucceedsAtWindowEdge() public {
        runUntilRound(2);
        uint256 id;
        vm.prank(player);
        registry.submitEntry{value: ENTRY_ETH}(bytes6("AB12CD"), true, 0); // plays round 3
        id = registry.activeTicketOf(player);
        uint256 ler = 3;
        runUntilRound(ler + 4);                     // currentRound == LER+4: still refundable
        uint256 balBefore = player.balance;
        vm.prank(player);
        registry.claimRefund(id);
        assertEq(player.balance, balBefore + ENTRY_ETH, "principal not refunded");
    }

    function test_ForfeitedAfterFourRounds() public {
        runUntilRound(2);
        uint256 id;
        vm.prank(player);
        registry.submitEntry{value: ENTRY_ETH}(bytes6("AB12CD"), true, 0); // plays round 3
        id = registry.activeTicketOf(player);
        uint256 ler = 3;
        uint256 sinkBefore = sink.balance;
        runUntilRound(ler + 5);                     // settling LER+4 sweeps the lapse
        assertEq(sink.balance, sinkBefore + ENTRY_ETH, "escrow not forfeited to sink");
        vm.prank(player);
        vm.expectRevert();
        registry.claimRefund(id);
    }

    // ─── §14 Missed prize ≠ lost principal ───────────────────────────────────

    function test_RecycleRevertsInsideWindow() public {
        uint256 T = makeWinner();                   // currentRound == T+1
        runUntilRound(T + 2);                       // still claimable
        vm.prank(rando);
        vm.expectRevert();
        prize.recycleUnclaimed(T);
    }

    function test_MissedPrizeRecyclesPermissionlessly_PrincipalSurvives() public {
        uint256 T = makeWinner();
        runUntilRound(T + 3);                       // prize window over, never claimed
        uint256 potBefore = prize.currentAccumulatedRewards();
        vm.prank(rando);                            // anyone may sweep
        prize.recycleUnclaimed(T);
        assertGe(prize.currentAccumulatedRewards(), potBefore, "pot did not absorb recycle");
        vm.prank(player);
        vm.expectRevert();
        prize.claimWinnings(T);                     // prize is gone for good

        // …but the principal window is still open. This ticket won its last
        // eligible round (T == LER), so §14 pushes its forfeiture to LER+6.
        runUntilRound(T + 4);
        uint256 id = registry.activeTicketOf(player) != 0
            ? registry.activeTicketOf(player)
            : registry.ticketAt(registry.generation(), player, T);
        uint256 balBefore = player.balance;
        vm.prank(player);
        registry.claimRefund(id);
        assertEq(player.balance, balBefore + ENTRY_ETH, "expired winner lost principal");
    }

    // ─── §14 (v5): winning the last eligible round pushes forfeiture to LER+6 ──

    function _ticketId(uint256 round) internal view returns (uint256) {
        uint256 id = registry.activeTicketOf(player);
        return id != 0 ? id : registry.ticketAt(registry.generation(), player, round);
    }

    function test_WinnerLastRound_ForfeitRoundIsLERPlus6() public {
        uint256 T = makeWinner();                    // ticket plays & wins round T; LER == T
        (GameRegistry.Ticket memory t,) = registry.getTicket(_ticketId(T));
        assertEq(t.forfeitRound, T + 6, "last-round winner should forfeit at LER+6");
    }

    function test_WinnerLastRound_RefundableInExtendedWindow() public {
        uint256 T = makeWinner();
        // T+5 is PAST the old flat LER+4 window — under v5 it must still refund
        // because the claim right (T+1..T+2) delayed the forfeiture countdown.
        runUntilRound(T + 5);
        // Resolve the id BEFORE the prank — _ticketId makes an external ticketAt
        // staticcall, which would otherwise consume the prank and leave claimRefund
        // running as the test contract (NotTicketOwner).
        uint256 id = _ticketId(T);
        uint256 balBefore = player.balance;
        vm.prank(player);
        registry.claimRefund(id);
        assertEq(player.balance, balBefore + ENTRY_ETH, "extended refund window not honored");
    }

    function test_WinnerLastRound_ForfeitedAtLERPlus6() public {
        uint256 T = makeWinner();
        uint256 id = _ticketId(T);
        uint256 sinkBefore = sink.balance;
        runUntilRound(T + 7);                        // settling T+6 sweeps the lapse
        assertEq(sink.balance, sinkBefore + ENTRY_ETH, "escrow not forfeited at LER+6");
        vm.prank(player);
        vm.expectRevert();
        registry.claimRefund(id);                    // window truly closed now
    }
}
