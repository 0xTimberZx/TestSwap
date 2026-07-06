// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

using SafeERC20 for IERC20;

// ─── Interfaces ──────────────────────────────────────────────────────────

interface IPrizeEscrow {
    // NOTE: 3-arg signature matching PrizeEscrow.pay(to, amount, round).
    // The old 2-arg interface declaration had a selector mismatch that made
    // every claimWinnings() call revert against the real escrow.
    function pay(address to, uint256 amount, uint256 round) external;
    function balance() external view returns (uint256);
    function deposit() external payable;
}

interface IGameRegistry {
    function verifyEntryExisted(address player, uint256 round)
        external view returns (bool, bytes6);
    function verifyEntryValid(address player, uint256 round)
        external view returns (bool, bytes6);
    function getStringEntrants(uint256 round, bytes6 string6)
        external view returns (address[] memory);
    function getRoundEntrants(uint256 round)
        external view returns (address[] memory);
    function activateRoundEntries(uint256 round, address[] calldata players) external;
    function onRoundSettled(uint256 settledRound) external;
    function setCurrentRound(uint256 round) external;
}

interface ITimbYieldVault {
    function harvest() external returns (uint256);
}

interface IEligibleTokenRegistry {
    function isEligible(address token) external view returns (bool);
}

/**
 * @title TimbPrize
 * @notice Prize game round logic, scroll mechanic, settlement, and payouts.
 *
 * Architecture:
 *   - Perpetual self-continuing rounds (6 hours each).
 *   - 6 segments per round: 59:45 interaction + 0:15 settlement.
 *   - positionCounter increments +1 per eligible swap (via nudgeScroll).
 *   - Winning string = 6-char window in 36-char alphabet at freeze point.
 *   - Freeze: keccak256(blockhash(block.number-1) + counter + roundNumber).
 *   - Winners: exact 6-char match, equal split, remainder (r) snowballs.
 *   - Prize ETH held in PrizeEscrow, paid on winner claim.
 *   - Dual-layer verification at settlement via GameRegistry.
 *
 * Prize pool accounting (balance sheet):
 *   currentAccumulatedRewards — live building pot
 *   gameUnclaimed_winningsPool — documented winners pending claim
 *   Entry escrow in GameRegistry — completely separate, never touched here
 *
 * Security:
 *   - ReentrancyGuard on claimWinnings(), nudgeScroll(), settleSegment().
 *   - settleSegment() is PERMISSIONLESS — the timing guard (reverts before
 *     the interaction window elapses) is what protects the game, not the
 *     caller. The settler keeper remains as a liveness backstop.
 *   - nudgeScroll() settles a due segment lazily instead of reverting, so
 *     the game cannot stall in its settlement window while in use.
 *   - Winner claim verified via dual-layer GameRegistry check.
 *   - ETH never held here — all prize ETH in PrizeEscrow.
 *   - Per-function pause (entries, settlement pausable independently).
 *
 * Deployment:
 *   1. Deploy PrizeEscrow → Deploy TimbPrize(escrow, registry, router)
 *   2. registry.setTimbPrize(address(this))
 *   3. router.setTimbPrize(address(this))
 *   4. setEligibleRegistry(address)
 *   5. Fund PrizeEscrow with initial ETH
 *   6. startGame() — begins round #1
 */
contract TimbPrize is Ownable, ReentrancyGuard {

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice 36-character alphabet: A-Z then 0-9.
    bytes constant ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    /// @notice Segment interaction window: 59 min 45 sec.
    uint256 public constant INTERACTION_WINDOW = 59 minutes + 45 seconds;

    /// @notice Settlement window: 15 seconds.
    uint256 public constant SETTLEMENT_WINDOW = 15 seconds;

    /// @notice Full segment duration.
    uint256 public constant SEGMENT_DURATION = INTERACTION_WINDOW + SETTLEMENT_WINDOW;

    /// @notice Segments per round.
    uint256 public constant SEGMENTS_PER_ROUND = 6;

    /// @notice Full round duration (6 hours).
    uint256 public constant ROUND_DURATION = SEGMENT_DURATION * SEGMENTS_PER_ROUND;

    /// @notice Claim window: 2 rounds after lastEligibleRound.
    uint256 public constant CLAIM_WINDOW_ROUNDS = 2;

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice PrizeEscrow — holds all prize ETH.
    address public prizeEscrow;

    /// @notice GameRegistry — entry storage and verification.
    address public gameRegistry;

    /// @notice TimbSwapRouter — authorised to call nudgeScroll().
    address public router;

    /// @notice EligibleTokenRegistry — token eligibility check.
    address public eligibleRegistry;

    /// @notice Settler address — authorised to call settleSegment().
    address public settler;

    /// @notice TimbYieldVault — active-escrow yield harvested into the pot
    ///         at each round settlement (address(0) = yield disabled).
    address public yieldVault;

    /// @notice Scroll position counter — increments +1 per eligible swap.
    uint256 public positionCounter;

    /// @notice Per-segment digit nudge counters. Index = segment number (1-6).
    mapping(uint256 => uint256) public segmentDigitCounter;

    /// @notice Whether each segment's digit is locked (settled).
    mapping(uint256 => bool) public segmentDigitLocked;

    /// @notice Shuffle enabled — if true, alphabet reseeded each round.
    bool public shuffleEnabled;

    /// @notice Current round number (starts at 0, first game round = 1).
    uint256 public currentRound;

    /// @notice Current segment within the round (1–6).
    uint256 public currentSegment;

    /// @notice Timestamp when the current segment started.
    uint256 public segmentStartTime;

    /// @notice Whether the game has been started.
    bool public gameStarted;

    /// @notice Current accumulated rewards (live prize pot, in ETH wei).
    uint256 public currentAccumulatedRewards;

    /// @notice Undistributed winnings documented for winners pending claim.
    uint256 public gameUnclaimed_winningsPool;

    /// @notice Number of winners per round (owner-configurable).
    uint256 public winnersPerRound;

    /// @notice Owner-set protocol cut % from round settlement (basis points).
    uint256 public protocolCutBps;

    /// @notice Frozen winning string for each round.
    mapping(uint256 => bytes6) public roundWinningString;

    /// @notice Frozen pot for each round (post-protocol-cut).
    mapping(uint256 => uint256) public roundPotAmount;

    /// @notice Winners documented per round.
    mapping(uint256 => address[]) public roundWinners;

    /// @notice Per-winner payout amount per round.
    mapping(uint256 => uint256) public roundPerWinnerAmount;

    /// @notice Remainder (r) for each round.
    mapping(uint256 => uint256) public roundRemainder;

    /// @notice Whether a winner has claimed for a round.
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    /// @notice Whether a round's unclaimed winnings were recycled to the pot.
    mapping(uint256 => bool) public roundRecycled;

    /// @notice Per-function pause flags.
    bool public entriesPaused;
    bool public settlementPaused;

    // ─── Events ──────────────────────────────────────────────────────────────

    event GameStarted(uint256 timestamp);
    event RoundStarted(uint256 indexed round, uint256 timestamp);
    event SegmentAdvanced(uint256 indexed round, uint256 segment, uint256 timestamp);
    event ScrollNudged(uint256 newPosition, uint256 indexed round, uint256 segment);
    event PositionFrozen(uint256 indexed round, uint256 position, bytes6 winningString);
    event RoundSettled(
        uint256 indexed round,
        bytes6  winningString,
        uint256 potAmount,
        uint256 numWinners,
        uint256 remainderR,
        uint256 totalEntries,
        uint256 timestamp
    );
    event WinningsClaimed(address indexed winner, uint256 indexed round, uint256 amount);
    event PotFunded(uint256 amount, address indexed from);
    event YieldHarvested(uint256 indexed round, uint256 amount);
    event UnclaimedRecycled(uint256 indexed round, uint256 amount);
    event ProtocolCutTaken(uint256 amount);
    event SettlerUpdated(address indexed newSettler);
    event WinnersPerRoundSet(uint256 count);
    event ProtocolCutSet(uint256 bps);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error GameNotStarted();
    error GameAlreadyStarted();
    error NotSettler();
    error NotRouter();
    error NotYieldVault();
    error SegmentNotComplete(uint256 elapsed, uint256 required);
    error NotInSettlementWindow();
    error InSettlementWindow();
    error RoundNotSettled(uint256 round);
    error AlreadyClaimed(address winner, uint256 round);
    error NotAWinner(address caller, uint256 round);
    error ClaimWindowExpired(uint256 round);
    error EntriesPaused();
    error SettlementPaused();
    error InvalidWinnersCount();
    error InsufficientPotBalance();
    error SettlingDigit();

    // ─── Modifiers ────────────────────────────────────────────────────────────
    // (No onlySettler — settleSegment() is permissionless; `settler` remains
    //  as the keeper's identity for ops/telemetry only.)

    modifier onlyRouter() {
        if (msg.sender != router) revert NotRouter();
        _;
    }

    modifier whenGameStarted() {
        if (!gameStarted) revert GameNotStarted();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────────

    constructor(
        address _prizeEscrow,
        address _gameRegistry,
        address _router
    ) Ownable(msg.sender) {
        if (_prizeEscrow  == address(0)) revert ZeroAddress();
        if (_gameRegistry == address(0)) revert ZeroAddress();
        if (_router       == address(0)) revert ZeroAddress();

        prizeEscrow  = _prizeEscrow;
        gameRegistry = _gameRegistry;
        router       = _router;
        settler      = msg.sender;
        winnersPerRound = 3;
        protocolCutBps  = 200;
    }

    // ─── Game Lifecycle ───────────────────────────────────────────────────────

    function startGame() external onlyOwner {
        if (gameStarted) revert GameAlreadyStarted();
        gameStarted      = true;
        currentRound     = 1;
        currentSegment   = 1;
        segmentStartTime = block.timestamp;

        // Reset digit counters for round 1
        for (uint256 i = 1; i <= SEGMENTS_PER_ROUND; i++) {
            segmentDigitCounter[i] = 0;
            segmentDigitLocked[i]  = false;
        }

        IGameRegistry(gameRegistry).setCurrentRound(currentRound);
        _activateRoundEntries(currentRound);

        emit GameStarted(block.timestamp);
        emit RoundStarted(currentRound, block.timestamp);
        emit SegmentAdvanced(currentRound, currentSegment, block.timestamp);
    }

    // ─── Scroll Mechanic ──────────────────────────────────────────────────────

    /**
     * @notice Nudge the active digit +1.
     * @dev Only affects the current segment's digit counter.
     *      Global positionCounter also increments (for entropy + analytics).
     *
     *      LAZY SETTLEMENT: if the segment's interaction window has already
     *      elapsed, the nudge settles it first (locking the digit exactly as
     *      the keeper would — no nudges landed since the boundary) and then
     *      applies to the fresh segment. The game can never sit stuck in a
     *      settlement window while someone is playing it; nudges only stay
     *      blocked if settlement itself is paused by the owner.
     */
    function nudgeScroll()
        external
        nonReentrant
        onlyRouter
        whenGameStarted
    {
        if (_isInSettlementWindow()) {
            if (settlementPaused) revert InSettlementWindow();
            _settleDueSegment();
        }
        positionCounter++;
        segmentDigitCounter[currentSegment]++;
        emit ScrollNudged(positionCounter, currentRound, currentSegment);
    }

    function isSettlementWindow() external view returns (bool) {
        return _isInSettlementWindow();
    }

    /// @dev Elapsed time in the current segment. Saturates at 0 while a
    ///      grid-anchored segment's official start is still a few seconds in
    ///      the future (a settle that lands inside the 59:45–60:00
    ///      intermission dates the next segment at the exact 60:00 mark).
    function _elapsedInSegment() internal view returns (uint256) {
        return block.timestamp > segmentStartTime
            ? block.timestamp - segmentStartTime
            : 0;
    }

    /// @dev Grid-anchored start for the next segment: segments live on exact
    ///      60-minute marks ("next segment before 60:01"), so a settle
    ///      landing anywhere inside the following slot anchors to the
    ///      boundary. Only a deep stall — a full extra slot with no settle —
    ///      falls back to wall clock to catch up.
    function _nextSegmentStart() internal view returns (uint256) {
        uint256 gridNext = segmentStartTime + SEGMENT_DURATION;
        return block.timestamp < gridNext + SEGMENT_DURATION
            ? gridNext
            : block.timestamp;
    }

    function _isInSettlementWindow() internal view returns (bool) {
        if (!gameStarted) return false;
        return _elapsedInSegment() >= INTERACTION_WINDOW;
    }

    // ─── Digit Window Derivation ──────────────────────────────────────────────

    /**
     * @notice Returns the current 6-char display.
     * @dev Past segments: locked digit. Current segment: live digit. Future: 0x00.
     */
    function getCurrentWindow() public view returns (bytes6 window) {
        bytes memory result = new bytes(6);
        for (uint256 i = 1; i <= SEGMENTS_PER_ROUND; i++) {
            uint8 idx = uint8(i - 1);
            if (i < currentSegment) {
                // Locked digit
                result[idx] = ALPHABET[segmentDigitCounter[i] % 36];
            } else if (i == currentSegment) {
                // Live digit — current nudge state
                result[idx] = ALPHABET[segmentDigitCounter[i] % 36];
            } else {
                // Future digit — not yet active
                result[idx] = 0x00;
            }
        }
        window = bytes6(bytes(result));
    }

    /**
     * @notice Returns the locked digit for a specific segment.
     * @dev Returns 0x00 if segment hasn't been settled yet.
     */
    function getSegmentDigit(uint256 segment) external view returns (bytes1) {
        if (segment > currentSegment) return 0x00;
        return ALPHABET[segmentDigitCounter[segment] % 36];
    }

    // ─── Settlement ───────────────────────────────────────────────────────────

    /**
     * @notice Settle the current segment once its interaction window elapsed.
     * @dev PERMISSIONLESS — the timing guard is what protects the game, not
     *      the caller: nothing about the outcome depends on who lands this
     *      transaction, so any wallet may unstick the game. The settler
     *      keeper keeps running as a liveness backstop, and nudgeScroll
     *      settles lazily too (see below), so the game can never stall in
     *      its settlement window while it is being used.
     */
    function settleSegment()
        external
        nonReentrant
        whenGameStarted
    {
        _settleDueSegment();
    }

    /// @dev Shared by settleSegment() and the lazy path in nudgeScroll().
    ///      Callers hold the reentrancy guard.
    function _settleDueSegment() internal {
        if (settlementPaused) revert SettlementPaused();

        uint256 elapsed = _elapsedInSegment();
        if (elapsed < INTERACTION_WINDOW) {
            revert SegmentNotComplete(elapsed, INTERACTION_WINDOW);
        }

        if (currentSegment < SEGMENTS_PER_ROUND) {
            // Lock current segment digit and advance on the 60-minute grid
            segmentDigitLocked[currentSegment] = true;
            currentSegment++;
            segmentStartTime = _nextSegmentStart();
            // Reset new segment's counter
            segmentDigitCounter[currentSegment] = 0;
            emit SegmentAdvanced(currentRound, currentSegment, block.timestamp);
        } else {
            // Final segment — lock and settle round
            segmentDigitLocked[currentSegment] = true;
            _settleRound();
        }
    }

    function _settleRound() internal {
        uint256 round = currentRound;

        // 4th pot source: harvest active-escrow yield BEFORE the split so
        // this round's winners benefit from this round's accrual.
        _harvestYield(round);

        bytes6 winningString = _buildWinningString();
        roundWinningString[round] = winningString;
        emit PositionFrozen(round, positionCounter, winningString);

        (address[] memory winners, uint256 winnerCount) =
            _findVerifiedWinners(round, winningString);

        _distributePotAndRecord(round, winners, winnerCount);

        // Registry post-settlement hook: ends yield weight for tickets whose
        // run finished this round, and absorbs escrow of tickets whose claim
        // window just lapsed (→ Ineligible).
        IGameRegistry(gameRegistry).onRoundSettled(round);

        uint256 totalEntries =
            IGameRegistry(gameRegistry).getRoundEntrants(round).length;

        emit RoundSettled(
            round,
            winningString,
            roundPotAmount[round],
            winnerCount,
            roundRemainder[round],
            totalEntries,
            block.timestamp
        );

        // Auto-queue next round — reset all digit counters. The new round's
        // first segment starts on the 60-minute grid, same as a plain
        // segment advance.
        uint256 nextStart = _nextSegmentStart();
        currentRound++;
        currentSegment   = 1;
        segmentStartTime = nextStart;
        for (uint256 i = 1; i <= SEGMENTS_PER_ROUND; i++) {
            segmentDigitCounter[i] = 0;
            segmentDigitLocked[i]  = false;
        }

        IGameRegistry(gameRegistry).setCurrentRound(currentRound);
        _activateRoundEntries(currentRound);

        emit RoundStarted(currentRound, block.timestamp);
        emit SegmentAdvanced(currentRound, 1, block.timestamp);
    }

    /**
     * @dev Build winning string from the 6 locked segment digit counters.
     */
    function _buildWinningString() internal view returns (bytes6) {
        bytes memory result = new bytes(6);
        for (uint256 i = 1; i <= SEGMENTS_PER_ROUND; i++) {
            result[i - 1] = ALPHABET[segmentDigitCounter[i] % 36];
        }
        return bytes6(bytes(result));
    }


    /**
     * @dev Step 2 — dual-layer verification. Both verifyEntryExisted() AND
     *      verifyEntryValid() must pass before a candidate is counted as a
     *      winner. Never skip either layer.
     */
    function _findVerifiedWinners(uint256 round, bytes6 winningString)
        internal
        view
        returns (address[] memory winners, uint256 winnerCount)
    {
        address[] memory candidates =
            IGameRegistry(gameRegistry).getStringEntrants(round, winningString);

        address[] memory verified = new address[](candidates.length);

        for (uint256 i = 0; i < candidates.length; i++) {
            address candidate = candidates[i];

            // Layer 1: entry existed at round start
            (bool existed, bytes6 existedString) =
                IGameRegistry(gameRegistry).verifyEntryExisted(candidate, round);
            if (!existed) continue;
            if (existedString != winningString) continue;

            // Layer 2: entry still valid at settlement
            (bool valid, bytes6 validString) =
                IGameRegistry(gameRegistry).verifyEntryValid(candidate, round);
            if (!valid) continue;
            if (validString != winningString) continue;

            verified[winnerCount++] = candidate;
        }

        winners = new address[](winnerCount);
        for (uint256 i = 0; i < winnerCount; i++) {
            winners[i] = verified[i];
        }
    }

    /**
     * @dev Step 3 — protocol cut, floor(x/n)*n pot split, snowball remainder,
     *      and bookkeeping. Only touches currentAccumulatedRewards /
     *      gameUnclaimed_winningsPool — never the GameRegistry entry escrow.
     */
    function _distributePotAndRecord(
        uint256 round,
        address[] memory winners,
        uint256 winnerCount
    ) internal {
        uint256 pot = currentAccumulatedRewards;
        uint256 perWinner;
        uint256 remainder;

        if (protocolCutBps > 0 && pot > 0) {
            uint256 cut = (pot * protocolCutBps) / 10_000;
            pot -= cut;
            emit ProtocolCutTaken(cut);
        }

        uint256 totalPaid = 0;
        remainder = pot;

        if (winnerCount > 0) {
            perWinner = pot / winnerCount;
            totalPaid = perWinner * winnerCount;
            remainder = pot - totalPaid;
        }

        for (uint256 i = 0; i < winnerCount; i++) {
            roundWinners[round].push(winners[i]);
        }

        roundPotAmount[round]       = pot;
        roundPerWinnerAmount[round] = perWinner;
        roundRemainder[round]       = remainder;

        gameUnclaimed_winningsPool += totalPaid;
        currentAccumulatedRewards   = remainder; // r snowballs to next round
    }

    /**
     * @dev Activates Pending entries for the given round in GameRegistry.
     */
    function _activateRoundEntries(uint256 round) internal {
        address[] memory entrants =
            IGameRegistry(gameRegistry).getRoundEntrants(round);
        if (entrants.length > 0) {
            IGameRegistry(gameRegistry).activateRoundEntries(round, entrants);
        }
    }

    /**
     * @dev Pull accrued active-escrow yield from the vault into the pot.
     *      try/catch + failure-tolerant vault: settlement can never brick
     *      on the yield path. Harvested ETH lands on this contract (vault
     *      pays msg-caller) and is forwarded straight into PrizeEscrow.
     */
    function _harvestYield(uint256 round) internal {
        if (yieldVault == address(0)) return;
        try ITimbYieldVault(yieldVault).harvest() returns (uint256 amount) {
            if (amount > 0) {
                currentAccumulatedRewards += amount;
                IPrizeEscrow(prizeEscrow).deposit{value: amount}();
                emit YieldHarvested(round, amount);
            }
        } catch {}
    }

    // ─── Claims ───────────────────────────────────────────────────────────────

    function claimWinnings(uint256 round)
        external
        nonReentrant
        whenGameStarted
    {
        if (roundWinningString[round] == bytes6(0)) revert RoundNotSettled(round);
        if (hasClaimed[round][msg.sender]) revert AlreadyClaimed(msg.sender, round);
        if (currentRound > round + CLAIM_WINDOW_ROUNDS + 1) revert ClaimWindowExpired(round);

        bool isWinner = false;
        address[] memory winners = roundWinners[round];
        for (uint256 i = 0; i < winners.length; i++) {
            if (winners[i] == msg.sender) { isWinner = true; break; }
        }
        if (!isWinner) revert NotAWinner(msg.sender, round);

        uint256 payout = roundPerWinnerAmount[round];
        if (payout == 0) revert ZeroAmount();

        hasClaimed[round][msg.sender] = true;
        gameUnclaimed_winningsPool -= payout;

        IPrizeEscrow(prizeEscrow).pay(msg.sender, payout, round);
        emit WinningsClaimed(msg.sender, round, payout);
    }

    /**
     * @notice Recycle unclaimed winnings from a round whose claim window has
     *         expired back into the live pot ("seeding from unclaimed
     *         rounds"). The ETH never left PrizeEscrow — this is pure
     *         bookkeeping between the unclaimed pool and the live pot.
     */
    function recycleUnclaimed(uint256 round) external onlyOwner {
        if (roundWinningString[round] == bytes6(0)) revert RoundNotSettled(round);
        // Claim window must be over (mirrors the claimWinnings deadline).
        if (currentRound <= round + CLAIM_WINDOW_ROUNDS + 1) revert ClaimWindowExpired(round);
        if (roundRecycled[round]) revert AlreadyClaimed(address(0), round);
        roundRecycled[round] = true;

        uint256 perWinner = roundPerWinnerAmount[round];
        uint256 recycled  = 0;
        address[] memory winners = roundWinners[round];
        for (uint256 i = 0; i < winners.length; i++) {
            if (!hasClaimed[round][winners[i]]) {
                recycled += perWinner;
                hasClaimed[round][winners[i]] = true; // permanently forfeit
            }
        }
        if (recycled == 0) return;

        gameUnclaimed_winningsPool -= recycled;
        currentAccumulatedRewards  += recycled;
        emit UnclaimedRecycled(round, recycled);
    }

    // ─── Pot Funding ──────────────────────────────────────────────────────────

    function fundPot() external payable onlyOwner {
        if (msg.value == 0) revert ZeroAmount();
        currentAccumulatedRewards += msg.value;
        IPrizeEscrow(prizeEscrow).deposit{value: msg.value}();
        emit PotFunded(msg.value, msg.sender);
    }

    function addToPot() external payable {
        if (msg.value == 0) revert ZeroAmount();
        currentAccumulatedRewards += msg.value;
        IPrizeEscrow(prizeEscrow).deposit{value: msg.value}();
        emit PotFunded(msg.value, msg.sender);
    }

    // ─── View: Round State ────────────────────────────────────────────────────

    /**
     * @notice Full live state for frontend. Includes per-segment digit counters
     *         and lock status so the UI can display locked vs live vs pending digits.
     */
    function getRoundState()
        external
        view
        returns (
            uint256 round,
            uint256 segment,
            uint256 segmentStart,
            uint256 counter,
            bytes6  currentWindow,
            uint256 pot,
            uint256 unclaimedPool,
            bool    inSettlement,
            uint256[6] memory digitCounters,
            bool[6]    memory digitLocked
        )
    {
        round         = currentRound;
        segment       = currentSegment;
        segmentStart  = segmentStartTime;
        counter       = positionCounter;
        currentWindow = getCurrentWindow();
        pot           = currentAccumulatedRewards;
        unclaimedPool = gameUnclaimed_winningsPool;
        inSettlement  = _isInSettlementWindow();

        for (uint256 i = 0; i < SEGMENTS_PER_ROUND; i++) {
            digitCounters[i] = segmentDigitCounter[i + 1];
            digitLocked[i]   = segmentDigitLocked[i + 1];
        }
    }

    function getRoundResult(uint256 round)
        external
        view
        returns (
            bytes6   winningString,
            uint256  potAmount,
            address[] memory winners,
            uint256  perWinner,
            uint256  remainder
        )
    {
        winningString = roundWinningString[round];
        potAmount     = roundPotAmount[round];
        winners       = roundWinners[round];
        perWinner     = roundPerWinnerAmount[round];
        remainder     = roundRemainder[round];
    }

    function timeRemainingInSegment() external view returns (uint256) {
        uint256 elapsed = _elapsedInSegment();
        if (elapsed >= INTERACTION_WINDOW) return 0;
        return INTERACTION_WINDOW - elapsed;
    }

    // ─── Owner: Config ────────────────────────────────────────────────────────

    function setSettler(address _settler) external onlyOwner {
        if (_settler == address(0)) revert ZeroAddress();
        settler = _settler;
        emit SettlerUpdated(_settler);
    }

    function setRouter(address _router) external onlyOwner {
        if (_router == address(0)) revert ZeroAddress();
        router = _router;
    }

    function setEligibleRegistry(address _registry) external onlyOwner {
        eligibleRegistry = _registry;
    }

    function setGameRegistry(address _registry) external onlyOwner {
        if (_registry == address(0)) revert ZeroAddress();
        gameRegistry = _registry;
    }

    function setPrizeEscrow(address _escrow) external onlyOwner {
        if (_escrow == address(0)) revert ZeroAddress();
        prizeEscrow = _escrow;
    }

    /// @notice Set the yield vault (address(0) disables the yield source).
    function setYieldVault(address _vault) external onlyOwner {
        yieldVault = _vault;
    }

    function setWinnersPerRound(uint256 _count) external onlyOwner {
        if (_count == 0) revert InvalidWinnersCount();
        winnersPerRound = _count;
        emit WinnersPerRoundSet(_count);
    }

    function setProtocolCutBps(uint256 _bps) external onlyOwner {
        if (_bps > 1000) revert ZeroAmount();
        protocolCutBps = _bps;
        emit ProtocolCutSet(_bps);
    }

    function setShuffleEnabled(bool _enabled) external onlyOwner {
        shuffleEnabled = _enabled;
    }

    function pauseEntries()      external onlyOwner { entriesPaused    = true; }
    function unpauseEntries()    external onlyOwner { entriesPaused    = false; }
    function pauseSettlement()   external onlyOwner { settlementPaused = true; }
    function unpauseSettlement() external onlyOwner { settlementPaused = false; }

    /// @dev Accept ETH only from the yield vault (harvest in-flight) — it is
    ///      immediately forwarded to PrizeEscrow inside _harvestYield().
    receive() external payable {
        if (msg.sender != yieldVault) revert NotYieldVault();
    }
}
