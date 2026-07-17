// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title TimbBoostFarm
 * @notice Multi-pool "boosted farms" — extra LP pairs (stables, boosted extra
 *         pairs, etc.) competing for ONE shared TIMBS reward pool.
 *
 * Model (see dev-docs/BOOSTED_FARMS_SPEC.md):
 *   - Funded by the epoch keeper: 5% of every main-farm (TIMB/ETH) claim is
 *     drawn from the Treasury into this contract, batched at keeper cadence,
 *     hard-capped by the epoch waterfall's boostBudget (farm → staking → boost).
 *   - Pools compete on WEIGHT: total weight behaves as a scale of 1 —
 *     each pool accrues rewardRate × weight / totalWeight. Within a pool,
 *     wallets claim pro-rata to their staked LP share (MasterChef accumulator).
 *   - SELF-RETARGETING emission: the rate always aims the CURRENT reserve
 *     over `emissionWindow` (a bit over 6 rounds). Every claim (deduction)
 *     and every notify (top-up) recalculates rate = reserve / emissionWindow.
 *   - Per-pool pause: a paused pool stops accruing and its weight leaves
 *     totalWeight, so the remaining pools compete for the full emission.
 *   - NOT part of the game loop: boosted pool assets are never added to
 *     EligibleTokenRegistry (whitelist) and never count toward swap nudges.
 *     Nothing in this contract touches the prize meter — keep it that way.
 *
 * Security (defiSKILL):
 *   - ReentrancyGuard on deposit/withdraw/claim/exit/notify.
 *   - SafeERC20 everywhere; per-pool staked accounting protects deposits
 *     from recoverERC20.
 *   - lpToken can never be the TIMBS token (reserve = full TIMBS balance).
 *   - Duplicate-LP guard: one pool per LP token.
 *   - Emergency per-pool withdraw (forfeits pending), works while paused.
 *
 * Deployment:
 *   1. Deploy TimbBoostFarm(timbsToken, emissionWindow)
 *   2. addPool(lp, weight) per boosted pair
 *   3. setRewardNotifier(keeper, true)  — keeper batches the 5% draws
 *   4. Keeper funds via notifyRewardAmount(amount); rate self-targets
 */
contract TimbBoostFarm is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Types ───────────────────────────────────────────────────────────────

    struct PoolInfo {
        IERC20  lpToken;            // staked LP token for this boosted pool
        uint256 weight;             // share of emissions (vs totalWeight)
        uint256 lastRewardTime;     // last accumulator update
        uint256 accRewardPerShare;  // cumulative TIMBS per LP, 1e18 fixed point
        uint256 totalStaked;        // LP staked in this pool
        bool    paused;             // paused pools accrue nothing
    }

    struct UserInfo {
        uint256 amount;             // LP staked
        uint256 rewardDebt;         // accumulator snapshot (amount × acc / 1e18)
        uint256 pending;            // earned but unclaimed, snapshotted
    }

    // ─── State ───────────────────────────────────────────────────────────────

    /// @notice TIMBS — the shared reward token across all boosted pools.
    IERC20 public immutable timbsToken;

    /// @notice Seconds the current reserve is aimed over ("a bit over 6
    ///         rounds"). Every claim/top-up retargets rate = reserve / window.
    uint256 public emissionWindow;

    /// @notice Shared TIMBS emission per second, split across pools by weight.
    uint256 public rewardRatePerSecond;

    /// @notice Emission stops here unless retargeted first (reserve exhausted).
    uint256 public periodFinish;

    /// @notice Sum of weights of ACTIVE (non-paused) pools.
    uint256 public totalWeight;

    /// @notice Reward reserve accounting — TIMBS received minus TIMBS claimed.
    ///         (Equals timbsToken.balanceOf(this) since LP tokens are separate
    ///         ERC20s, but tracked explicitly so a stray TIMBS transfer can't
    ///         inflate emissions without a notify.)
    uint256 public rewardReserve;

    PoolInfo[] public poolInfo;

    /// @notice pid => user => position.
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;

    /// @notice LP token => pool id + 1 (0 = no pool). One pool per LP.
    mapping(address => uint256) public poolIdPlusOne;

    /// @notice Authorised reward notifiers (owner + keeper).
    mapping(address => bool) public rewardNotifiers;

    /// @notice Global emergency pause (per-pool pause is in PoolInfo).
    bool public paused;

    // ─── Events ──────────────────────────────────────────────────────────────

    event PoolAdded(uint256 indexed pid, address indexed lpToken, uint256 weight);
    event PoolWeightSet(uint256 indexed pid, uint256 weight);
    event PoolPaused(uint256 indexed pid);
    event PoolUnpaused(uint256 indexed pid);
    event Deposited(address indexed user, uint256 indexed pid, uint256 lpAmount);
    event Withdrawn(address indexed user, uint256 indexed pid, uint256 lpAmount);
    event RewardsClaimed(address indexed user, uint256 indexed pid, uint256 timbsAmount);
    event RewardNotified(address indexed notifier, uint256 amount, uint256 newRate);
    event RateRetargeted(uint256 reserve, uint256 newRate, uint256 periodFinish);
    event EmissionWindowSet(uint256 windowSeconds);
    event RewardNotifierSet(address indexed notifier, bool authorised);
    event Paused(address indexed by);
    event Unpaused(address indexed by);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 lpAmount);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error InvalidPool();
    error PoolExists();
    error PoolIsPaused();
    error PoolNotPaused();
    error LpCannotBeReward();
    error NotAuthorised();
    error ContractPaused();
    error NoPendingRewards();
    error InsufficientStake(uint256 requested, uint256 available);
    error InsufficientRewardBalance(uint256 required, uint256 available);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier validPool(uint256 pid) {
        if (pid >= poolInfo.length) revert InvalidPool();
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    /**
     * @param _timbsToken     TIMBS ERC-20 (reward token).
     * @param _emissionWindow Seconds to aim the reserve over (a bit over 6
     *                        rounds of the prize game).
     */
    constructor(address _timbsToken, uint256 _emissionWindow)
        Ownable(msg.sender)
    {
        if (_timbsToken == address(0)) revert ZeroAddress();
        if (_emissionWindow == 0) revert ZeroAmount();
        timbsToken     = IERC20(_timbsToken);
        emissionWindow = _emissionWindow;
        rewardNotifiers[msg.sender] = true;
    }

    // ─── View helpers ────────────────────────────────────────────────────────

    function poolCount() external view returns (uint256) {
        return poolInfo.length;
    }

    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    /**
     * @notice Pending TIMBS for `account` in pool `pid` (view, no state).
     */
    function pendingReward(uint256 pid, address account)
        external
        view
        validPool(pid)
        returns (uint256)
    {
        PoolInfo storage pool  = poolInfo[pid];
        UserInfo storage user  = userInfo[pid][account];
        uint256 acc = pool.accRewardPerShare;
        if (
            !pool.paused &&
            pool.totalStaked > 0 &&
            totalWeight > 0 &&
            lastTimeRewardApplicable() > pool.lastRewardTime
        ) {
            uint256 elapsed    = lastTimeRewardApplicable() - pool.lastRewardTime;
            uint256 poolReward = elapsed * rewardRatePerSecond * pool.weight / totalWeight;
            acc += poolReward * 1e18 / pool.totalStaked;
        }
        return user.pending + (user.amount * acc / 1e18) - user.rewardDebt;
    }

    /**
     * @notice Estimated annual TIMBS emission APR (bps) for pool `pid`,
     *         denominated in LP units (frontend converts to USD).
     */
    function estimatedPoolAPR(uint256 pid)
        external
        view
        validPool(pid)
        returns (uint256 aprBps)
    {
        PoolInfo storage pool = poolInfo[pid];
        if (pool.paused || pool.totalStaked == 0 || totalWeight == 0) return 0;
        uint256 poolAnnual = rewardRatePerSecond * 365 days * pool.weight / totalWeight;
        aprBps = poolAnnual * 10_000 / pool.totalStaked;
    }

    // ─── Accumulator ─────────────────────────────────────────────────────────

    /**
     * @dev Roll pool `pid`'s accumulator forward to now. Paused pools and
     *      empty pools just advance the clock (no accrual).
     */
    function _updatePool(uint256 pid) internal {
        PoolInfo storage pool = poolInfo[pid];
        uint256 applicable = lastTimeRewardApplicable();
        if (applicable <= pool.lastRewardTime) return;

        if (!pool.paused && pool.totalStaked > 0 && totalWeight > 0) {
            uint256 elapsed    = applicable - pool.lastRewardTime;
            uint256 poolReward = elapsed * rewardRatePerSecond * pool.weight / totalWeight;
            pool.accRewardPerShare += poolReward * 1e18 / pool.totalStaked;
        }
        pool.lastRewardTime = applicable;
    }

    /**
     * @dev Snapshot `account`'s earnings in `pid` into pending. Call after
     *      _updatePool and before mutating user.amount.
     */
    function _snapshotUser(uint256 pid, address account) internal {
        UserInfo storage user = userInfo[pid][account];
        PoolInfo storage pool = poolInfo[pid];
        if (user.amount > 0) {
            user.pending += (user.amount * pool.accRewardPerShare / 1e18) - user.rewardDebt;
        }
    }

    /**
     * @dev Re-aim the CURRENT reserve over emissionWindow. The spec's
     *      "recalculates whenever claims are called, after the deduction or
     *      top-up": rate = reserve / window, window restarts from now.
     *      Must run AFTER rolling every pool forward at the OLD rate — the
     *      per-pool lastRewardTime handles that lazily, so callers must
     *      _updatePool(all) first (see _updateAllPools).
     */
    function _retarget() internal {
        rewardRatePerSecond = rewardReserve / emissionWindow;
        periodFinish        = block.timestamp + emissionWindow;
        emit RateRetargeted(rewardReserve, rewardRatePerSecond, periodFinish);
    }

    /**
     * @dev Roll ALL pools to now at the current rate. Required before any
     *      rate change so past accrual isn't rewritten. Pool count is
     *      owner-curated and small (a handful of boosted pairs), so the
     *      loop is bounded in practice.
     */
    function _updateAllPools() internal {
        uint256 n = poolInfo.length;
        for (uint256 pid = 0; pid < n; pid++) {
            _updatePool(pid);
        }
    }

    // ─── Deposit / Withdraw ──────────────────────────────────────────────────

    /**
     * @notice Stake LP tokens into boosted pool `pid`.
     * @dev Approve this contract for the pool's lpToken first.
     */
    function deposit(uint256 pid, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        validPool(pid)
    {
        if (amount == 0) revert ZeroAmount();
        PoolInfo storage pool = poolInfo[pid];
        if (pool.paused) revert PoolIsPaused();

        _updatePool(pid);
        _snapshotUser(pid, msg.sender);

        UserInfo storage user = userInfo[pid][msg.sender];
        user.amount     += amount;
        pool.totalStaked += amount;
        user.rewardDebt  = user.amount * pool.accRewardPerShare / 1e18;

        pool.lpToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, pid, amount);
    }

    /**
     * @notice Withdraw staked LP from pool `pid`. Allowed while the pool is
     *         paused — pause stops earnings, never exit.
     */
    function withdraw(uint256 pid, uint256 amount)
        external
        nonReentrant
        whenNotPaused
        validPool(pid)
    {
        if (amount == 0) revert ZeroAmount();
        UserInfo storage user = userInfo[pid][msg.sender];
        if (amount > user.amount) revert InsufficientStake(amount, user.amount);
        PoolInfo storage pool = poolInfo[pid];

        _updatePool(pid);
        _snapshotUser(pid, msg.sender);

        user.amount      -= amount;
        pool.totalStaked -= amount;
        user.rewardDebt   = user.amount * pool.accRewardPerShare / 1e18;

        pool.lpToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, pid, amount);
    }

    // ─── Claim ───────────────────────────────────────────────────────────────

    /**
     * @notice Claim pending TIMBS from pool `pid`. Claiming retargets the
     *         emission rate to the post-claim reserve (spec: recalculate
     *         after every deduction).
     */
    function claimRewards(uint256 pid)
        external
        nonReentrant
        whenNotPaused
        validPool(pid)
    {
        _updatePool(pid);
        _snapshotUser(pid, msg.sender);

        UserInfo storage user = userInfo[pid][msg.sender];
        PoolInfo storage pool = poolInfo[pid];
        uint256 reward = user.pending;
        if (reward == 0) revert NoPendingRewards();
        if (reward > rewardReserve) {
            revert InsufficientRewardBalance(reward, rewardReserve);
        }

        user.pending    = 0;
        user.rewardDebt = user.amount * pool.accRewardPerShare / 1e18;
        rewardReserve  -= reward;

        // Deduction changed the reserve — re-aim it over the window.
        _updateAllPools();
        _retarget();

        timbsToken.safeTransfer(msg.sender, reward);
        emit RewardsClaimed(msg.sender, pid, reward);
    }

    /**
     * @notice Withdraw all LP and claim all pending from pool `pid` in one tx.
     *         LP always returns even if the reward reserve can't cover pending.
     */
    function exit(uint256 pid)
        external
        nonReentrant
        whenNotPaused
        validPool(pid)
    {
        _updatePool(pid);
        _snapshotUser(pid, msg.sender);

        UserInfo storage user = userInfo[pid][msg.sender];
        PoolInfo storage pool = poolInfo[pid];

        uint256 staked = user.amount;
        uint256 reward = user.pending;

        if (staked > 0) {
            user.amount       = 0;
            pool.totalStaked -= staked;
            pool.lpToken.safeTransfer(msg.sender, staked);
            emit Withdrawn(msg.sender, pid, staked);
        }
        user.rewardDebt = 0;

        if (reward > 0 && reward <= rewardReserve) {
            user.pending   = 0;
            rewardReserve -= reward;
            _updateAllPools();
            _retarget();
            timbsToken.safeTransfer(msg.sender, reward);
            emit RewardsClaimed(msg.sender, pid, reward);
        }
        // If reserve is short, pending stays claimable later — LP still returned.
    }

    // ─── Funding (keeper / owner) ────────────────────────────────────────────

    /**
     * @notice Top up the shared reward pool. Called by the epoch keeper with
     *         the batched 5%-of-main-farm-claims draw (within boostBudget).
     *         Top-up retargets the rate over emissionWindow (spec).
     */
    function notifyRewardAmount(uint256 amount)
        external
        nonReentrant
    {
        if (!rewardNotifiers[msg.sender] && msg.sender != owner()) {
            revert NotAuthorised();
        }
        if (amount == 0) revert ZeroAmount();

        // Roll all pools to now at the old rate BEFORE the rate changes.
        _updateAllPools();

        timbsToken.safeTransferFrom(msg.sender, address(this), amount);
        rewardReserve += amount;

        _retarget();
        emit RewardNotified(msg.sender, amount, rewardRatePerSecond);
    }

    // ─── Owner: pools ────────────────────────────────────────────────────────

    /**
     * @notice Add a boosted pool. Weights are relative — the set of active
     *         weights behaves as a scale of 1 (pool share = weight/totalWeight).
     * @dev Boosted pool assets must NOT be whitelisted in
     *      EligibleTokenRegistry and are never nudge-eligible — this contract
     *      has no path into the prize meter by design; keep it that way.
     */
    function addPool(address lp, uint256 weight) external onlyOwner {
        if (lp == address(0)) revert ZeroAddress();
        if (lp == address(timbsToken)) revert LpCannotBeReward();
        if (poolIdPlusOne[lp] != 0) revert PoolExists();
        if (weight == 0) revert ZeroAmount();

        _updateAllPools();

        poolInfo.push(PoolInfo({
            lpToken:           IERC20(lp),
            weight:            weight,
            lastRewardTime:    lastTimeRewardApplicable(),
            accRewardPerShare: 0,
            totalStaked:       0,
            paused:            false
        }));
        totalWeight += weight;
        poolIdPlusOne[lp] = poolInfo.length; // pid + 1

        emit PoolAdded(poolInfo.length - 1, lp, weight);
    }

    /**
     * @notice Change a pool's weight (competition dial). Applies to a paused
     *         pool too — takes effect when unpaused.
     */
    function setPoolWeight(uint256 pid, uint256 weight)
        external
        onlyOwner
        validPool(pid)
    {
        if (weight == 0) revert ZeroAmount();
        _updateAllPools();
        PoolInfo storage pool = poolInfo[pid];
        if (!pool.paused) {
            totalWeight = totalWeight - pool.weight + weight;
        }
        pool.weight = weight;
        emit PoolWeightSet(pid, weight);
    }

    /**
     * @notice Pause ONE pool's earnings. Its weight leaves totalWeight so the
     *         other pools compete for the full emission. Deposits blocked;
     *         withdraw/claim of already-earned stay open.
     */
    function pausePool(uint256 pid) external onlyOwner validPool(pid) {
        PoolInfo storage pool = poolInfo[pid];
        if (pool.paused) revert PoolIsPaused();
        _updateAllPools();
        pool.paused  = true;
        totalWeight -= pool.weight;
        emit PoolPaused(pid);
    }

    /**
     * @notice Resume a paused pool's earnings.
     */
    function unpausePool(uint256 pid) external onlyOwner validPool(pid) {
        PoolInfo storage pool = poolInfo[pid];
        if (!pool.paused) revert PoolNotPaused();
        _updateAllPools();
        pool.paused         = false;
        pool.lastRewardTime = lastTimeRewardApplicable();
        totalWeight        += pool.weight;
        emit PoolUnpaused(pid);
    }

    // ─── Owner: config ───────────────────────────────────────────────────────

    /**
     * @notice Set the emission window ("a bit over 6 rounds", in seconds).
     *         Takes effect at the next retarget (claim or top-up).
     */
    function setEmissionWindow(uint256 windowSeconds) external onlyOwner {
        if (windowSeconds == 0) revert ZeroAmount();
        emissionWindow = windowSeconds;
        emit EmissionWindowSet(windowSeconds);
    }

    /**
     * @notice Authorise / revoke a reward notifier (the epoch keeper).
     */
    function setRewardNotifier(address notifier, bool authorised)
        external
        onlyOwner
    {
        if (notifier == address(0)) revert ZeroAddress();
        rewardNotifiers[notifier] = authorised;
        emit RewardNotifierSet(notifier, authorised);
    }

    function pause()   external onlyOwner { paused = true;  emit Paused(msg.sender); }
    function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }

    // ─── Emergency ───────────────────────────────────────────────────────────

    /**
     * @notice Emergency withdraw LP from pool `pid` — works even when the
     *         contract or pool is paused. Forfeits all pending rewards.
     */
    function emergencyWithdraw(uint256 pid)
        external
        nonReentrant
        validPool(pid)
    {
        UserInfo storage user = userInfo[pid][msg.sender];
        PoolInfo storage pool = poolInfo[pid];
        uint256 staked = user.amount;
        if (staked == 0) revert ZeroAmount();

        user.amount      = 0;
        user.rewardDebt  = 0;
        user.pending     = 0;
        pool.totalStaked -= staked;

        pool.lpToken.safeTransfer(msg.sender, staked);
        emit EmergencyWithdraw(msg.sender, pid, staked);
    }

    /**
     * @notice Owner recovers stray ERC20s. Staked LP is protected by each
     *         pool's totalStaked; TIMBS is protected by rewardReserve.
     */
    function recoverERC20(address token, uint256 amount) external onlyOwner {
        if (token == address(timbsToken)) {
            uint256 recoverable = timbsToken.balanceOf(address(this)) - rewardReserve;
            if (amount > recoverable) {
                revert InsufficientRewardBalance(amount, recoverable);
            }
        } else if (poolIdPlusOne[token] != 0) {
            PoolInfo storage pool = poolInfo[poolIdPlusOne[token] - 1];
            uint256 recoverable = IERC20(token).balanceOf(address(this)) - pool.totalStaked;
            if (amount > recoverable) {
                revert InsufficientRewardBalance(amount, recoverable);
            }
        }
        IERC20(token).safeTransfer(owner(), amount);
    }
}
