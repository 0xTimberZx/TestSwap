// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "../contracts/BoostRewarder.sol";

/**
 * @title DeployBoostRewarder
 * @notice Deploys a BoostRewarder against the CORRECT farm (TimbBoostFarm, not
 *         TimbFarm) and attaches it to a boost pool in one broadcast. Fixes the
 *         earlier deploy that pointed at the wrong farm and was never hooked.
 *
 * The rewarder pays a SECONDARY ERC-20 (e.g. WETH) on top of the pool's TIMBS
 * emission. One rewarder per (pool, token).
 *
 * Run (from the TimbBoostFarm owner key):
 *   REWARD_TOKEN=0x…      # secondary reward token (e.g. WETH 0x980B62…)
 *   BOOST_POOL_PID=0      # which boost pool to attach to
 *   EMISSION_WINDOW=129600 # optional, default 6 rounds (36h)
 *   BOOST_FARM=0x551D…    # optional, defaults to the live TimbBoostFarm
 *   forge script scripts/DeployBoostRewarder.s.sol --rpc-url $RPC --broadcast --verify
 *
 * Then FUND it (separate txs, owner or any authorised notifier):
 *   rewardToken.approve(rewarder, amount)
 *   rewarder.notifyRewardAmount(amount)   // pulls `amount`, retargets the rate
 */
interface IBoostFarmHooks {
    function addPoolHook(uint256 pid, address hook) external;
    function poolInfo(uint256 pid) external view returns (
        address lpToken, uint256 weight, uint256 lastRewardTime,
        uint256 accRewardPerShare, uint256 totalStaked, bool paused
    );
}

contract DeployBoostRewarder is Script {
    // Live TimbBoostFarm (the CORRECT farm — the boost tier, not TimbFarm).
    address constant DEFAULT_FARM = 0x551D919D517aBa40D2b3A57a91973ad5Ad3CBd35;

    function run() external {
        address farm   = vm.envOr("BOOST_FARM", DEFAULT_FARM);
        address token  = vm.envAddress("REWARD_TOKEN");
        uint256 window = vm.envOr("EMISSION_WINDOW", uint256(129_600)); // 6 rounds
        uint256 pid    = vm.envUint("BOOST_POOL_PID");

        // Sanity: the pool must exist (reverts if pid is out of range).
        IBoostFarmHooks(farm).poolInfo(pid);

        vm.startBroadcast();
        BoostRewarder rewarder = new BoostRewarder(farm, token, window);
        IBoostFarmHooks(farm).addPoolHook(pid, address(rewarder));
        vm.stopBroadcast();

        console2.log("BoostRewarder deployed:", address(rewarder));
        console2.log("  farm  :", farm);
        console2.log("  token :", token);
        console2.log("  pid   :", pid);
        console2.log("  window:", window);
        console2.log("Next: approve the rewarder for `amount` of the reward token, then");
        console2.log("      rewarder.notifyRewardAmount(amount) to start the secondary stream.");
    }
}
