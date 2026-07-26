// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title PoolLedger
 * @notice Custody + credit ledger for a SegmentBoard generation. Holds all TIMBS
 *         staked into a board's pools and the seed float, and records what each
 *         wallet is owed. Players pull their own credit; the board instructs all
 *         accounting.
 *
 * Design:
 *   - Single responsibility: hold TIMBS, credit balances on the board's
 *     instruction, and let wallets withdraw their own credit. It owns NO
 *     game logic — the pari-mutuel math (winners, weights, rake) lives in
 *     SegmentBoard, exactly as PrizeEscrow holds ETH while TimbPrize owns the
 *     accounting.
 *   - Only the wired board may collect stakes, credit winnings, refund, or
 *     sweep. No other address can move pooled funds.
 *   - Withdrawals are never pausable: a halted or retired board can always be
 *     drained by the wallets it owes.
 *
 * Security (escrow is sacred):
 *   - `totalCredited` is the sum of every wallet's owed credit and can never
 *     exceed the contract's TIMBS balance — credit is always fully backed.
 *   - Sweeps (to Treasury) and the owner's protocol-fund withdrawal are both
 *     capped to the UNOWED surplus (`heldBalance - totalCredited`), so neither
 *     the board, the Treasury path, nor the owner can ever touch a wallet's
 *     credit.
 *   - ReentrancyGuard on every function that transfers TIMBS out;
 *     checks-effects-interactions throughout.
 *   - The owner is renounceable (OZ Ownable): once renounced, `setBoard` and
 *     `ownerWithdraw` are permanently uncallable while withdrawals keep working.
 *
 * Deployment:
 *   1. Deploy PoolLedger(timbs, treasury)
 *   2. Deploy SegmentBoard(poolLedger, ...)
 *   3. poolLedger.setBoard(segmentBoard)   // one-time, owner-only
 *   4. Add poolLedger to TIMBS transferWhitelist so payouts never trip the cap
 *   5. Renounce ownership at maturity
 */
contract PoolLedger is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State ─────────────────────────────────────────────────────────────────

    /// @notice The TIMBS token this ledger custodies.
    IERC20 public immutable timbs;

    /// @notice Treasury address that receives sweeps (no-winner pots, rake, dust).
    address public immutable treasury;

    /// @notice The SegmentBoard authorised to drive all accounting. Set once.
    address public board;

    /// @notice wallet => TIMBS currently owed to it and withdrawable on demand.
    mapping(address => uint256) public credit;

    /// @notice Sum of all `credit` entries. Never exceeds the TIMBS balance.
    uint256 public totalCredited;

    // ─── Events ────────────────────────────────────────────────────────────────

    event BoardSet(address indexed board);
    event Collected(address indexed from, uint256 amount);
    event SeedFunded(address indexed from, uint256 amount);
    event WinningsCredited(address indexed to, uint256 amount);
    event Refunded(address indexed to, uint256 amount);
    event Swept(address indexed to, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event ProtocolWithdrawn(address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NotBoard();
    error BoardAlreadySet();
    error LengthMismatch();
    error ExceedsUnowed(uint256 requested, uint256 available);
    error NothingToWithdraw();

    // ─── Modifiers ─────────────────────────────────────────────────────────────

    modifier onlyBoard() {
        if (msg.sender != board) revert NotBoard();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    constructor(address _timbs, address _treasury) Ownable(msg.sender) {
        if (_timbs == address(0) || _treasury == address(0)) revert ZeroAddress();
        timbs    = IERC20(_timbs);
        treasury = _treasury;
    }

    // ─── Board: intake ─────────────────────────────────────────────────────────

    /**
     * @notice Pull a player's stake into the vault. Caller must have approved
     *         this ledger for `amount`. Board-gated; the board records which pool.
     */
    function collect(address from, uint256 amount) external onlyBoard {
        if (from == address(0)) revert ZeroAddress();
        if (amount == 0)        revert ZeroAmount();
        timbs.safeTransferFrom(from, address(this), amount);
        emit Collected(from, amount);
    }

    /**
     * @notice Pull seed float into the vault (e.g. from the Treasury). Caller
     *         must have approved this ledger for `amount`.
     */
    function fundSeed(address from, uint256 amount) external onlyBoard {
        if (from == address(0)) revert ZeroAddress();
        if (amount == 0)        revert ZeroAmount();
        timbs.safeTransferFrom(from, address(this), amount);
        emit SeedFunded(from, amount);
    }

    // ─── Board: settlement accounting ──────────────────────────────────────────

    /**
     * @notice Credit a pool's winners. The board computes each amount from the
     *         pari-mutuel weights; this ledger only records and backs them. The
     *         array is bounded by the board (<= seats per pool), so no unbounded
     *         loop reaches this contract.
     * @dev Reverts if the resulting `totalCredited` would exceed the held
     *      balance — credit must always be fully backed.
     */
    function creditWinnings(address[] calldata recipients, uint256[] calldata amounts)
        external
        onlyBoard
    {
        uint256 len = recipients.length;
        if (len != amounts.length) revert LengthMismatch();

        uint256 added;
        for (uint256 i; i < len; ++i) {
            address to     = recipients[i];
            uint256 amount = amounts[i];
            if (to == address(0)) revert ZeroAddress();
            if (amount == 0)      continue; // losers carry zero weight; skip cheaply
            credit[to] += amount;
            added      += amount;
            emit WinningsCredited(to, amount);
        }

        uint256 newTotal = totalCredited + added;
        if (newTotal > timbs.balanceOf(address(this))) {
            revert ExceedsUnowed(added, _unowed());
        }
        totalCredited = newTotal;
    }

    /**
     * @notice Credit a single wallet a refund (e.g. an unplayed/dislodged chip
     *         at retire). Backed like any other credit.
     */
    function refund(address to, uint256 amount) external onlyBoard {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0)      revert ZeroAmount();
        uint256 newTotal = totalCredited + amount;
        if (newTotal > timbs.balanceOf(address(this))) {
            revert ExceedsUnowed(amount, _unowed());
        }
        credit[to]   += amount;
        totalCredited = newTotal;
        emit Refunded(to, amount);
    }

    /**
     * @notice Sweep unowed surplus (no-winner pots, rake, dust) to `to`
     *         (typically the Treasury). Capped to the unowed balance so a sweep
     *         can never reach into a wallet's credit.
     */
    function sweep(address to, uint256 amount) external onlyBoard nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0)      revert ZeroAmount();
        uint256 avail = _unowed();
        if (amount > avail) revert ExceedsUnowed(amount, avail);
        timbs.safeTransfer(to, amount);
        emit Swept(to, amount);
    }

    // ─── Player: pull-claim ────────────────────────────────────────────────────

    /**
     * @notice Withdraw the caller's entire credit. Always available — never
     *         pausable — so a halted or retired board can always be exited.
     */
    function withdraw() external nonReentrant {
        uint256 amount = credit[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        credit[msg.sender] = 0;
        totalCredited     -= amount;
        timbs.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ─── Owner: config ─────────────────────────────────────────────────────────

    /// @notice Wire the board once. Renouncing ownership afterwards locks it.
    function setBoard(address _board) external onlyOwner {
        if (_board == address(0)) revert ZeroAddress();
        if (board != address(0))  revert BoardAlreadySet();
        board = _board;
        emit BoardSet(_board);
    }

    /**
     * @notice Narrow protocol-fund move: withdraw only the UNOWED surplus (rake
     *         awaiting sweep, stray tokens, seed float not backing a credit) to
     *         `to`. Capped to `heldBalance - totalCredited`, so player credit is
     *         provably untouchable. Removed forever once ownership is renounced.
     */
    function ownerWithdraw(address to, uint256 amount)
        external
        nonReentrant
        onlyOwner
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0)      revert ZeroAmount();
        uint256 avail = _unowed();
        if (amount > avail) revert ExceedsUnowed(amount, avail);
        timbs.safeTransfer(to, amount);
        emit ProtocolWithdrawn(to, amount);
    }

    // ─── View ──────────────────────────────────────────────────────────────────

    /// @notice TIMBS currently held by the ledger.
    function heldBalance() external view returns (uint256) {
        return timbs.balanceOf(address(this));
    }

    /// @notice Unowed surplus: held balance minus all owed credit.
    function unowed() external view returns (uint256) {
        return _unowed();
    }

    function _unowed() internal view returns (uint256) {
        return timbs.balanceOf(address(this)) - totalCredited;
    }
}
