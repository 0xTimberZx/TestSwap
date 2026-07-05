// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ITimbYieldVault {
    function register(uint256 ticketId, address token, uint256 amount) external;
    function remove(uint256 ticketId) external;
}

/**
 * @title GameRegistry (v2 — ticket model)
 * @notice Prize game ticket storage, escrow, lifecycle, and yield-weight hooks.
 *
 * Ticket model:
 *   - Every entry mints a Ticket with a globally unique id.
 *   - One eligible live ticket per wallet, enforced via activeTicketOf.
 *   - Replacement mints a NEW ticket; the senior ticket becomes Conceded and
 *     stays visible, cross-linked (supersedes / supersededBy). The principal
 *     moves onto the replacement; extra-round TIMBS on the conceded ticket is
 *     already forfeited to the protocol sink (Treasury) and must be re-paid
 *     for the replacement to carry extra rounds again.
 *   - Tickets are indexed into EVERY round they are eligible for
 *     (playRound..lastEligibleRound), fixing the v1 bug where extra-round
 *     entries could never win or activate beyond their first round.
 *
 * Ticket statuses:
 *   Pending    — waiting for its play round to begin.
 *   Active     — counted into the round; escrow weight registered in the
 *                yield vault (earning for the prize pool); eligible to win.
 *                After lastEligibleRound passes it is refundable (derived,
 *                not a stored status) within the claim window.
 *   Conceded   — replaced; ineligible to win; principal moved to replacement;
 *                stays visible tethered beneath the replacement.
 *   Ineligible — claim window lapsed unclaimed (escrow absorbed to protocol
 *                sink) or admin-flagged ticket/game inconsistency.
 *   Cancelled  — voluntary pre-round withdrawal; principal refunded; no tally.
 *                Reported as Closed (derived) once its play round begins.
 *   Closed     — principal withdrawn; terminal; hidden from active lists.
 *
 * Yield hooks (TimbYieldVault):
 *   - Weight registered when a ticket becomes Active, removed the moment it
 *     stops being eligible (conceded / expired / ineligible / refunded).
 *   - Principal NEVER moves to the vault — weight is bookkeeping only; the
 *     vault pays yield to the prize pot from its own treasury-funded reserve.
 *   - All vault calls are try/catch guarded so the game can never brick on
 *     vault failure.
 *
 * Security:
 *   - ReentrancyGuard on all state-changing user functions.
 *   - Escrow ring-fenced: ETH/TIMBS held here equals the sum of live +
 *     refundable ticket principal; never mingles with protocol revenue.
 *   - Only TimbPrize can drive round lifecycle (activate / settle hooks).
 *   - Emergency pause blocks new/replacement tickets; refunds & cancels
 *     always available.
 *
 * Deployment:
 *   1. Deploy GameRegistry(timbsToken, protocolSink, timbPrize?)
 *   2. setEntryCosts(1000e18, 0.0001e18)
 *   3. setYieldVault(vault); vault.setGameRegistry(this)
 *   4. timbPrize.setGameRegistry(this)
 */
contract GameRegistry is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Types ───────────────────────────────────────────────────────────────

    enum TicketStatus { Pending, Active, Conceded, Ineligible, Cancelled, Closed }

    struct Ticket {
        uint256      id;
        address      owner;
        bytes6       string6;           // 6-char alphanumeric entry string
        uint256      playRound;         // first round this ticket plays
        uint256      lastEligibleRound; // last round this ticket plays
        uint256      escrowAmount;      // principal held (ETH wei or TIMBS wei)
        address      escrowToken;       // address(0) = ETH, else TIMBS
        TicketStatus status;
        uint256      supersedes;        // conceded ancestor id (0 = none)
        uint256      supersededBy;      // replacement id (0 = live end of chain)
        uint256      createdAt;         // block timestamp at mint
    }

    // ─── Constants ───────────────────────────────────────────────────────────

    /// @notice Cap on extra rounds per ticket — bounds the round-index loop.
    uint256 public constant MAX_EXTRA_ROUNDS = 12;

    /// @notice Refund claim window after lastEligibleRound (in rounds).
    uint256 public constant CLAIM_WINDOW_ROUNDS = 2;

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice TIMBS token.
    IERC20 public immutable timbsToken;

    /// @notice Protocol sink (Treasury) — receives extra-round TIMBS and
    ///         absorbed escrow from claim-window-lapsed tickets.
    address public protocolSink;

    /// @notice TimbPrize — only address allowed to drive round lifecycle.
    address public timbPrize;

    /// @notice TimbYieldVault — receives active-escrow weight updates.
    address public yieldVault;

    /// @notice Entry cost in TIMBS (governance-set).
    uint256 public entryCostTIMBS;

    /// @notice Entry cost in ETH wei (governance-set).
    uint256 public entryCostETH;

    /// @notice Current active round number (pushed by TimbPrize).
    uint256 public currentRound;

    /// @notice Emergency pause — blocks new tickets; refunds always available.
    bool public paused;

    /// @notice Next ticket id (first ticket = 1; 0 = null).
    uint256 public nextTicketId = 1;

    /// @notice ticket id → ticket.
    mapping(uint256 => Ticket) public tickets;

    /// @notice wallet → its current live ticket id (0 = none).
    mapping(address => uint256) public activeTicketOf;

    /// @notice wallet → all ticket ids ever minted (history, incl. terminal).
    mapping(address => uint256[]) private _ticketsOf;

    /// @notice wallet → round → the ticket id eligible for that round.
    mapping(address => mapping(uint256 => uint256)) public ticketAt;

    /// @notice round → wallets with a ticket eligible in that round (deduped).
    mapping(uint256 => address[]) public roundEntrants;

    /// @notice round → wallet → already in roundEntrants.
    mapping(uint256 => mapping(address => bool)) public hasEntryInRound;

    /// @notice round → string → wallets that hold that string for the round.
    ///         Stale rows (conceded/replaced) are filtered at verification.
    mapping(uint256 => mapping(bytes6 => address[])) public stringEntrants;

    // ─── Events ──────────────────────────────────────────────────────────────

    event TicketMinted(
        uint256 indexed ticketId,
        address indexed owner,
        bytes6  string6,
        uint256 playRound,
        uint256 lastEligibleRound,
        uint256 escrowAmount,
        address escrowToken,
        uint256 supersedes
    );
    event TicketActivated(uint256 indexed ticketId, uint256 indexed round);
    event TicketConceded(uint256 indexed oldTicketId, uint256 indexed newTicketId);
    event TicketCancelled(uint256 indexed ticketId, uint256 refundAmount, address escrowToken);
    event TicketExpired(uint256 indexed ticketId, uint256 indexed round);
    event TicketClosed(uint256 indexed ticketId, uint256 refundAmount, address escrowToken);
    event TicketIneligible(uint256 indexed ticketId, uint256 absorbedAmount, address escrowToken);
    event ExtraRoundsSunk(address indexed player, uint256 indexed ticketId, uint256 timbsAmount);
    event EntryCostUpdated(uint256 timbsCost, uint256 ethCost);
    event CurrentRoundUpdated(uint256 round);
    event TimbPrizeSet(address indexed timbPrize);
    event ProtocolSinkSet(address indexed sink);
    event YieldVaultSet(address indexed vault);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error ContractPaused();
    error NotTimbPrize();
    error InvalidCharacter(bytes1 char);
    error RepeatingCharacter(bytes1 char);
    error ActiveTicketExists(uint256 ticketId);
    error NoLiveTicket(address player);
    error TicketNotFound(uint256 ticketId);
    error NotTicketOwner(uint256 ticketId, address caller);
    error TicketNotPending(TicketStatus status);
    error TicketNotReplaceable(TicketStatus status);
    error TicketNotRefundable(TicketStatus status);
    error TicketStillEligible(uint256 lastEligibleRound, uint256 currentRound);
    error ClaimWindowClosed(uint256 lastEligibleRound, uint256 currentRound);
    error RoundAlreadyStarted(uint256 playRound, uint256 currentRound);
    error WrongEscrowAmount(uint256 sent, uint256 required);
    error InsufficientAllowance(uint256 required, uint256 available);
    error TooManyExtraRounds(uint256 requested, uint256 max);
    error EthTransferFailed();

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier onlyTimbPrize() {
        if (msg.sender != timbPrize) revert NotTimbPrize();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(
        address _timbsToken,
        address _protocolSink,
        address _timbPrize
    ) Ownable(msg.sender) {
        if (_timbsToken   == address(0)) revert ZeroAddress();
        if (_protocolSink == address(0)) revert ZeroAddress();
        timbsToken   = IERC20(_timbsToken);
        protocolSink = _protocolSink;
        timbPrize    = _timbPrize; // allowed address(0) at deploy
    }

    // ─── String Validation ───────────────────────────────────────────────────

    /// @dev 6 chars, A-Z / 0-9 only, no repeats (bitmask over 36 symbols).
    function _validateString(bytes6 s) internal pure {
        uint64 seen = 0;
        for (uint256 i = 0; i < 6; i++) {
            bytes1 c = s[i];
            bool isUpper = c >= 0x41 && c <= 0x5A;
            bool isDigit = c >= 0x30 && c <= 0x39;
            if (!isUpper && !isDigit) revert InvalidCharacter(c);
            uint256 idx = isUpper
                ? uint256(uint8(c)) - 0x41
                : uint256(uint8(c)) - 0x30 + 26;
            uint64 bit = uint64(1 << idx);
            if (seen & bit != 0) revert RepeatingCharacter(c);
            seen |= bit;
        }
    }

    // ─── Internal: Ticket Lifecycle Helpers ──────────────────────────────────

    /// @dev True while a ticket blocks its wallet from minting another.
    function _isLive(Ticket storage t) internal view returns (bool) {
        if (t.status == TicketStatus.Pending) return true;
        if (t.status == TicketStatus.Active && currentRound <= t.lastEligibleRound) return true;
        return false;
    }

    /// @dev Mints a ticket and indexes it into every round it plays.
    function _mintTicket(
        address owner_,
        bytes6  string6,
        uint256 playRound,
        uint256 lastRound,
        uint256 escrowAmount,
        address escrowToken,
        uint256 supersedes
    ) internal returns (uint256 id) {
        id = nextTicketId++;
        tickets[id] = Ticket({
            id:                id,
            owner:             owner_,
            string6:           string6,
            playRound:         playRound,
            lastEligibleRound: lastRound,
            escrowAmount:      escrowAmount,
            escrowToken:       escrowToken,
            status:            TicketStatus.Pending,
            supersedes:        supersedes,
            supersededBy:      0,
            createdAt:         block.timestamp
        });
        activeTicketOf[owner_] = id;
        _ticketsOf[owner_].push(id);

        for (uint256 r = playRound; r <= lastRound; r++) {
            ticketAt[owner_][r] = id;
            stringEntrants[r][string6].push(owner_);
            if (!hasEntryInRound[r][owner_]) {
                hasEntryInRound[r][owner_] = true;
                roundEntrants[r].push(owner_);
            }
        }

        emit TicketMinted(
            id, owner_, string6, playRound, lastRound,
            escrowAmount, escrowToken, supersedes
        );
    }

    /// @dev Vault weight on — never bricks the game on vault failure.
    function _vaultRegister(uint256 ticketId, address token, uint256 amount) internal {
        if (yieldVault == address(0) || amount == 0) return;
        try ITimbYieldVault(yieldVault).register(ticketId, token, amount) {} catch {}
    }

    /// @dev Vault weight off — idempotent, never bricks the game.
    function _vaultRemove(uint256 ticketId) internal {
        if (yieldVault == address(0)) return;
        try ITimbYieldVault(yieldVault).remove(ticketId) {} catch {}
    }

    /// @dev Pay out ETH or TIMBS principal.
    function _payEscrow(address to, address token, uint256 amount) internal {
        if (amount == 0) return;
        if (token == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // ─── Submit Entry (mint ticket) ──────────────────────────────────────────

    /**
     * @notice Mint a ticket for the next round.
     * @dev One eligible live ticket per wallet — enforced across rounds, not
     *      just per-round. ETH entries: msg.value >= entryCostETH (excess
     *      refunded). TIMBS entries: approve entryCostTIMBS first. Extra
     *      rounds: TIMBS only, forfeited to the protocol sink, non-refundable.
     * @param string6     6-char entry string (A-Z / 0-9, no repeats).
     * @param useETH      True = principal in ETH, false = TIMBS.
     * @param extraRounds Rounds beyond the first (≤ MAX_EXTRA_ROUNDS).
     */
    function submitEntry(
        bytes6  string6,
        bool    useETH,
        uint256 extraRounds
    )
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (extraRounds > MAX_EXTRA_ROUNDS) {
            revert TooManyExtraRounds(extraRounds, MAX_EXTRA_ROUNDS);
        }

        // One eligible live ticket per wallet.
        uint256 liveId = activeTicketOf[msg.sender];
        if (liveId != 0 && _isLive(tickets[liveId])) {
            revert ActiveTicketExists(liveId);
        }

        _validateString(string6);

        uint256 playRound = currentRound + 1;
        uint256 escrowAmount;
        address escrowToken;

        if (useETH) {
            // `<` alone also covers the free-entry (cost 0) case correctly.
            if (msg.value < entryCostETH) {
                revert WrongEscrowAmount(msg.value, entryCostETH);
            }
            escrowAmount = entryCostETH;
            escrowToken  = address(0);
            if (msg.value > entryCostETH) {
                (bool ok,) = payable(msg.sender).call{value: msg.value - entryCostETH}("");
                if (!ok) revert EthTransferFailed();
            }
        } else {
            if (msg.value > 0) {
                (bool ok,) = payable(msg.sender).call{value: msg.value}("");
                if (!ok) revert EthTransferFailed();
            }
            escrowAmount = entryCostTIMBS;
            escrowToken  = address(timbsToken);
            timbsToken.safeTransferFrom(msg.sender, address(this), entryCostTIMBS);
        }

        uint256 id = _mintTicket(
            msg.sender, string6, playRound, playRound + extraRounds,
            escrowAmount, escrowToken, 0
        );

        // Extra rounds — TIMBS only, straight to the protocol sink.
        uint256 additionalCost = extraRounds * entryCostTIMBS;
        if (additionalCost > 0) {
            timbsToken.safeTransferFrom(msg.sender, protocolSink, additionalCost);
            emit ExtraRoundsSunk(msg.sender, id, additionalCost);
        }
    }

    // ─── Replace Entry (concede + mint) ──────────────────────────────────────

    /**
     * @notice Replace the wallet's live ticket with a new one (same string
     *         allowed). The senior ticket becomes Conceded — visible, tethered
     *         beneath the replacement, ineligible to win. Its principal moves
     *         onto the new ticket. Extra-round TIMBS must be paid again for
     *         the replacement to carry extra rounds.
     * @param newString6  New (or same) 6-char entry string.
     * @param extraRounds Extra rounds for the NEW ticket (paid fresh in TIMBS).
     */
    function replaceEntry(bytes6 newString6, uint256 extraRounds)
        external
        nonReentrant
        whenNotPaused
    {
        uint256 oldId = activeTicketOf[msg.sender];
        if (oldId == 0) revert NoLiveTicket(msg.sender);

        Ticket storage old = tickets[oldId];
        if (!_isLive(old)) revert TicketNotReplaceable(old.status);

        if (extraRounds > MAX_EXTRA_ROUNDS) {
            revert TooManyExtraRounds(extraRounds, MAX_EXTRA_ROUNDS);
        }
        _validateString(newString6);

        // Pre-flight the extra-round TIMBS pull before any state changes.
        uint256 additionalCost = extraRounds * entryCostTIMBS;
        if (additionalCost > 0) {
            uint256 allowance_ = timbsToken.allowance(msg.sender, address(this));
            if (allowance_ < additionalCost) {
                revert InsufficientAllowance(additionalCost, allowance_);
            }
        }

        // Concede the senior ticket; principal carries to the replacement.
        uint256 principal = old.escrowAmount;
        address token     = old.escrowToken;
        old.status        = TicketStatus.Conceded;
        old.escrowAmount  = 0;
        _vaultRemove(oldId);

        uint256 playRound = currentRound + 1;
        uint256 newId = _mintTicket(
            msg.sender, newString6, playRound, playRound + extraRounds,
            principal, token, oldId
        );
        old.supersededBy = newId;

        if (additionalCost > 0) {
            timbsToken.safeTransferFrom(msg.sender, protocolSink, additionalCost);
            emit ExtraRoundsSunk(msg.sender, newId, additionalCost);
        }

        emit TicketConceded(oldId, newId);
    }

    // ─── Cancel (voluntary pre-round withdrawal) ─────────────────────────────

    /**
     * @notice Cancel the wallet's Pending ticket before its round starts and
     *         reclaim the principal immediately. The ticket becomes Cancelled
     *         (no tally, ineligible) and reads as Closed once its play round
     *         begins.
     */
    function cancelEntry() external nonReentrant {
        uint256 id = activeTicketOf[msg.sender];
        if (id == 0) revert NoLiveTicket(msg.sender);

        Ticket storage t = tickets[id];
        if (t.status != TicketStatus.Pending) revert TicketNotPending(t.status);
        if (t.playRound <= currentRound) {
            revert RoundAlreadyStarted(t.playRound, currentRound);
        }

        uint256 amount = t.escrowAmount;
        address token  = t.escrowToken;
        t.status       = TicketStatus.Cancelled;
        t.escrowAmount = 0;
        activeTicketOf[msg.sender] = 0;

        _payEscrow(msg.sender, token, amount);
        emit TicketCancelled(id, amount, token);
    }

    // ─── Refund (post-expiry principal withdrawal) ───────────────────────────

    /**
     * @notice Withdraw the principal of a ticket whose run has ended, within
     *         the claim window. Ticket becomes Closed (terminal, hidden).
     * @param ticketId The ticket to close.
     */
    function claimRefund(uint256 ticketId) external nonReentrant {
        Ticket storage t = tickets[ticketId];
        if (t.id == 0)               revert TicketNotFound(ticketId);
        if (t.owner != msg.sender)   revert NotTicketOwner(ticketId, msg.sender);
        // Active is the normal path; Pending covers a ticket whose activation
        // was missed (safety hatch) — both hold escrow.
        if (t.status != TicketStatus.Active && t.status != TicketStatus.Pending) {
            revert TicketNotRefundable(t.status);
        }
        if (currentRound <= t.lastEligibleRound) {
            revert TicketStillEligible(t.lastEligibleRound, currentRound);
        }
        if (currentRound > t.lastEligibleRound + CLAIM_WINDOW_ROUNDS) {
            revert ClaimWindowClosed(t.lastEligibleRound, currentRound);
        }

        uint256 amount = t.escrowAmount;
        address token  = t.escrowToken;
        t.status       = TicketStatus.Closed;
        t.escrowAmount = 0;
        _vaultRemove(ticketId);
        if (activeTicketOf[msg.sender] == ticketId) activeTicketOf[msg.sender] = 0;

        _payEscrow(msg.sender, token, amount);
        emit TicketClosed(ticketId, amount, token);
    }

    // ─── TimbPrize: Round Lifecycle ──────────────────────────────────────────

    /**
     * @notice Activate Pending tickets at round start. Registers their escrow
     *         weight in the yield vault — Active tickets earn for the pot.
     */
    function activateRoundEntries(uint256 round, address[] calldata players)
        external
        onlyTimbPrize
    {
        for (uint256 i = 0; i < players.length; i++) {
            uint256 id = ticketAt[players[i]][round];
            if (id == 0) continue;
            Ticket storage t = tickets[id];
            if (t.status == TicketStatus.Pending && t.playRound <= round) {
                t.status = TicketStatus.Active;
                _vaultRegister(id, t.escrowToken, t.escrowAmount);
                emit TicketActivated(id, round);
            }
        }
    }

    /**
     * @notice Post-settlement hook, called once per settled round:
     *         1. Tickets whose run ended this round stop earning yield and
     *            free their wallet to enter again (refund window opens).
     *         2. Tickets whose claim window just lapsed become Ineligible and
     *            their unclaimed escrow is absorbed to the protocol sink.
     */
    function onRoundSettled(uint256 settledRound) external onlyTimbPrize {
        // 1. End-of-run: eligibility ended with this round.
        address[] storage ended = roundEntrants[settledRound];
        for (uint256 i = 0; i < ended.length; i++) {
            uint256 id = ticketAt[ended[i]][settledRound];
            if (id == 0) continue;
            Ticket storage t = tickets[id];
            if (t.status == TicketStatus.Active &&
                t.lastEligibleRound == settledRound) {
                _vaultRemove(id);
                if (activeTicketOf[t.owner] == id) activeTicketOf[t.owner] = 0;
                emit TicketExpired(id, settledRound);
            }
        }

        // 2. Claim-window lapse: lastEligibleRound == settledRound - 2 closes
        //    now (refund window spans the two rounds after the run ends).
        if (settledRound <= CLAIM_WINDOW_ROUNDS) return;
        uint256 lapsedRound = settledRound - CLAIM_WINDOW_ROUNDS;
        address[] storage lapsed = roundEntrants[lapsedRound];
        for (uint256 i = 0; i < lapsed.length; i++) {
            uint256 id = ticketAt[lapsed[i]][lapsedRound];
            if (id == 0) continue;
            Ticket storage t = tickets[id];
            if (t.lastEligibleRound != lapsedRound) continue;
            if (t.status != TicketStatus.Active &&
                t.status != TicketStatus.Pending) continue;

            uint256 amount = t.escrowAmount;
            address token  = t.escrowToken;
            t.status = TicketStatus.Ineligible;
            _vaultRemove(id);
            if (activeTicketOf[t.owner] == id) activeTicketOf[t.owner] = 0;

            if (amount > 0) {
                if (token == address(0)) {
                    // Best-effort: never brick settlement on a sink transfer.
                    (bool ok,) = payable(protocolSink).call{value: amount}("");
                    if (ok) t.escrowAmount = 0;
                } else {
                    t.escrowAmount = 0;
                    IERC20(token).safeTransfer(protocolSink, amount);
                }
            }
            emit TicketIneligible(id, amount, token);
        }
    }

    /// @notice Update current round number — called by TimbPrize at round start.
    function setCurrentRound(uint256 round) external onlyTimbPrize {
        currentRound = round;
        emit CurrentRoundUpdated(round);
    }

    // ─── Dual-Layer Verification (TimbPrize settlement) ──────────────────────

    /// @notice Layer 1: a ticket existed for this player and round.
    function verifyEntryExisted(address player, uint256 round)
        external
        view
        returns (bool exists, bytes6 string6)
    {
        uint256 id = ticketAt[player][round];
        if (id == 0) return (false, bytes6(0));
        return (true, tickets[id].string6);
    }

    /// @notice Layer 2: the ticket is Active and eligible for this round.
    function verifyEntryValid(address player, uint256 round)
        external
        view
        returns (bool valid, bytes6 string6)
    {
        uint256 id = ticketAt[player][round];
        if (id == 0) return (false, bytes6(0));
        Ticket storage t = tickets[id];
        if (t.status != TicketStatus.Active)                       return (false, bytes6(0));
        if (round < t.playRound || round > t.lastEligibleRound)    return (false, bytes6(0));
        return (true, t.string6);
    }

    /// @notice Wallets holding a given string for a round (raw; settlement
    ///         applies the dual-layer filter over this list).
    function getStringEntrants(uint256 round, bytes6 string6)
        external
        view
        returns (address[] memory)
    {
        return stringEntrants[round][string6];
    }

    /// @notice Wallets with a ticket eligible in a round.
    function getRoundEntrants(uint256 round)
        external
        view
        returns (address[] memory)
    {
        return roundEntrants[round];
    }

    // ─── Views: Tickets ──────────────────────────────────────────────────────

    /**
     * @notice Status as it should be displayed: Cancelled reads as Closed
     *         once its play round has begun (settlement rolled the round).
     */
    function effectiveStatus(uint256 ticketId) public view returns (TicketStatus) {
        Ticket storage t = tickets[ticketId];
        if (t.status == TicketStatus.Cancelled && currentRound >= t.playRound) {
            return TicketStatus.Closed;
        }
        return t.status;
    }

    /// @notice One ticket + its display status.
    function getTicket(uint256 ticketId)
        external
        view
        returns (Ticket memory t, TicketStatus displayStatus)
    {
        t = tickets[ticketId];
        if (t.id == 0) revert TicketNotFound(ticketId);
        displayStatus = effectiveStatus(ticketId);
    }

    /// @notice Every ticket a wallet has ever minted, with display statuses.
    function getTicketsOf(address owner_)
        external
        view
        returns (Ticket[] memory list, TicketStatus[] memory displayStatuses)
    {
        uint256[] storage ids = _ticketsOf[owner_];
        list            = new Ticket[](ids.length);
        displayStatuses = new TicketStatus[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            list[i]            = tickets[ids[i]];
            displayStatuses[i] = effectiveStatus(ids[i]);
        }
    }

    /// @notice Conceded ancestry of a ticket, newest → oldest.
    function getTicketChain(uint256 ticketId)
        external
        view
        returns (uint256[] memory ancestors)
    {
        // Count first (chain is bounded by replacements made; hard cap 64).
        uint256 count;
        uint256 cursor = tickets[ticketId].supersedes;
        while (cursor != 0 && count < 64) { count++; cursor = tickets[cursor].supersedes; }

        ancestors = new uint256[](count);
        cursor = tickets[ticketId].supersedes;
        for (uint256 i = 0; i < count; i++) {
            ancestors[i] = cursor;
            cursor = tickets[cursor].supersedes;
        }
    }

    /// @notice Identical-string count for the next round (collision display).
    function getIdenticalCount(bytes6 string6) external view returns (uint256) {
        return stringEntrants[currentRound + 1][string6].length;
    }

    /// @notice Extra-round cost helper.
    function additionalRoundCost(uint256 extraRounds) external view returns (uint256) {
        return extraRounds * entryCostTIMBS;
    }

    // ─── Owner: Config ───────────────────────────────────────────────────────

    /// @notice Governance-driven entry costs (per eligible token).
    function setEntryCosts(uint256 _timbsCost, uint256 _ethCost) external onlyOwner {
        if (_timbsCost == 0 || _ethCost == 0) revert ZeroAmount();
        entryCostTIMBS = _timbsCost;
        entryCostETH   = _ethCost;
        emit EntryCostUpdated(_timbsCost, _ethCost);
    }

    function setTimbPrize(address _timbPrize) external onlyOwner {
        if (_timbPrize == address(0)) revert ZeroAddress();
        timbPrize = _timbPrize;
        emit TimbPrizeSet(_timbPrize);
    }

    function setProtocolSink(address _sink) external onlyOwner {
        if (_sink == address(0)) revert ZeroAddress();
        protocolSink = _sink;
        emit ProtocolSinkSet(_sink);
    }

    function setYieldVault(address _vault) external onlyOwner {
        yieldVault = _vault; // address(0) allowed = yield disabled
        emit YieldVaultSet(_vault);
    }

    /// @notice Escape hatch for a ticket/game inconsistency ("contract error
    ///         between ticket and game") — flags the ticket Ineligible.
    ///         Escrow stays on the ticket for a follow-up adminAbsorbEscrow
    ///         or manual resolution.
    function adminMarkIneligible(uint256 ticketId) external onlyOwner {
        Ticket storage t = tickets[ticketId];
        if (t.id == 0) revert TicketNotFound(ticketId);
        t.status = TicketStatus.Ineligible;
        _vaultRemove(ticketId);
        if (activeTicketOf[t.owner] == ticketId) activeTicketOf[t.owner] = 0;
        emit TicketIneligible(ticketId, t.escrowAmount, t.escrowToken);
    }

    /// @notice Sweep escrow stranded on an Ineligible ticket to the sink
    ///         (e.g. after an ETH send to the sink failed during settlement).
    function adminAbsorbEscrow(uint256 ticketId) external onlyOwner {
        Ticket storage t = tickets[ticketId];
        if (t.id == 0) revert TicketNotFound(ticketId);
        if (t.status != TicketStatus.Ineligible) revert TicketNotRefundable(t.status);
        uint256 amount = t.escrowAmount;
        if (amount == 0) revert ZeroAmount();
        address token = t.escrowToken;
        t.escrowAmount = 0;
        _payEscrow(protocolSink, token, amount);
        emit TicketIneligible(ticketId, amount, token);
    }

    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }
}
