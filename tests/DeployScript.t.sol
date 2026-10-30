// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Deploy} from "../scripts/Deploy.s.sol";

contract DeployERC20 is ERC20 {
    constructor(string memory n) ERC20(n, n) {}
    function mint(address to, uint256 a) external { _mint(to, a); }
}

contract DeployCoordinator {
    uint256 public n;
    struct RandomWordsRequest { bytes32 keyHash; uint256 subId; uint16 c; uint32 g; uint32 w; bytes x; }
    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256) { return ++n; }
}

/// @dev Feeds the script a config directly. vm.setEnv is process-wide and
///      forge runs tests in parallel, so env-driven cases could race.
contract TestDeploy is Deploy {
    uint256 private k;
    Cfg private cfgStore;
    function setCase(uint256 key, Cfg memory c) external { k = key; cfgStore = c; }
    function _key() internal view override returns (uint256) { return k; }
    function _cfg(address) internal view override returns (Cfg memory) { return cfgStore; }
}

/**
 * Runs scripts/Deploy.s.sol (the testnet redeploy) end to end on the test chain.
 * The script's own read-back reverts on any unwired edge, so a run that
 * completes is wired; the test then checks the roles the keepers rely on,
 * moves value through the router, and covers each pre-flight refusal.
 */
contract DeployScriptTest is Test {
    uint256 constant KEY = 0xD3B10;
    address constant SETTLER    = address(0x5E77);
    address constant DISPATCHER = address(0xD15);
    address constant GUARDIAN   = address(0x6A4D);
    address constant WALLET     = address(0x5AFE);
    address constant LEAKED     = 0x42536623b503D4926DfAF6173B0357b7DfD19800;

    DeployERC20 weth; DeployERC20 usdc; DeployERC20 usdt; DeployERC20 link; DeployERC20 dapp;
    address coord;

    function setUp() public {
        vm.deal(vm.addr(KEY), 100 ether);
        weth = new DeployERC20("WETH"); usdc = new DeployERC20("USDC"); usdt = new DeployERC20("USDT");
        link = new DeployERC20("LINK"); dapp = new DeployERC20("DAPP");
        coord = address(new DeployCoordinator());
    }

    function _cfg() internal view returns (Deploy.Cfg memory c) {
        c.deployer = vm.addr(KEY);
        c.treasuryWallet = WALLET; c.sink = WALLET; c.settler = SETTLER;
        c.dispatcher = DISPATCHER; c.guardian = GUARDIAN;
        c.weth = address(weth); c.usdc = address(usdc); c.usdt = address(usdt);
        c.link = address(link); c.dapp = address(dapp);
        c.vrfCoord = coord; c.vrfKeyHash = bytes32(uint256(1)); c.vrfSubId = 7; c.vrfExtra = hex"01";
        c.vrfConfs = 3; c.vrfCbGas = 200_000;
        c.entryCostTimbs = 100e18; c.initialSupply = 1_000_000e18;
        c.timbsEntryFloor = 500e18; c.timbsStep = 100e18;
        c.stakingRate = 1e15; c.farmRate = 1e15; c.yieldAprBps = 10_000; c.cutBps = 50;
        c.dripEth = 1e13; c.potEth = 1e13; c.timbsPerClaim = 100e18; c.cooldown = 1 days;
        c.faucetEthCap = 1.5 ether; c.faucetTimbsCap = 1_000_000e18;
        c.operatorCap = 0.1 ether; c.operatorPeriod = 1 days;
        c.boostWindow = 302_400; c.boostWeight = 100;
    }

    function _run(Deploy.Cfg memory c) internal returns (TestDeploy d) {
        d = new TestDeploy();
        d.setCase(KEY, c);
        d.run();
    }

    function test_DeployWiresEverythingAndRoutesValue() public {
        TestDeploy d = _run(_cfg());
        address owner = vm.addr(KEY);

        // Roles the keepers and the plan rely on (the script's read-back covers the rest).
        assertEq(d.timbPrize().owner(), owner);
        assertEq(d.timbPrize().settler(), SETTLER);
        assertEq(d.faucet().dispatcher(), DISPATCHER);
        assertEq(d.faucet().guardian(), GUARDIAN);
        assertEq(d.timbPrize().protocolCutBps(), 50, "0.5% cut (decided 2026-10-30)");
        assertFalse(d.timbPrize().gameStarted(), "the deploy never starts the game");
        assertEq(d.treasury().operator(), address(d.faucet()));
        assertEq(d.timbs().balanceOf(WALLET), 1_000_000e18, "genesis supply to the treasury wallet");
        assertEq(address(d.governance()), address(0), "governance off by default");

        // Four distinct pairs, all from the new factory.
        address[4] memory pairs = [d.timbsEthPair(), d.usdcEthPair(), d.usdtEthPair(), d.linkEthPair()];
        for (uint256 i; i < 4; i++) {
            assertTrue(pairs[i] != address(0));
            for (uint256 j; j < i; j++) assertTrue(pairs[i] != pairs[j]);
        }

        // Value moves through the router: seed USDC/WETH, then swap with a nudge
        // request (the game is not started, so the nudge exits early, no revert).
        address lp = address(0x11);
        usdc.mint(lp, 10_000e18); weth.mint(lp, 10e18);
        vm.startPrank(lp);
        usdc.approve(address(d.router()), type(uint256).max);
        weth.approve(address(d.router()), type(uint256).max);
        d.router().addLiquidity(address(usdc), address(weth), 10_000e18, 10e18, 0, 0, lp, block.timestamp);
        vm.stopPrank();

        address trader = address(0x22);
        weth.mint(trader, 1e18);
        vm.startPrank(trader);
        weth.approve(address(d.router()), type(uint256).max);
        d.router().swapExactTokensForTokens(0.1e18, 1, address(weth), address(usdc), trader, block.timestamp, true);
        vm.stopPrank();
        assertGt(usdc.balanceOf(trader), 0, "swap paid out");
    }

    function test_PreflightRefusesTheLeakedDeployerInAnyRole() public {
        Deploy.Cfg memory c = _cfg();
        c.settler = LEAKED;
        TestDeploy d = new TestDeploy();
        d.setCase(KEY, c);
        vm.expectRevert(bytes("PRE-FLIGHT: a role is the leaked deployer key"));
        d.run();
    }

    function test_PreflightRefusesACutAboveTheCap() public {
        Deploy.Cfg memory c = _cfg();
        c.cutBps = 1_001;
        TestDeploy d = new TestDeploy();
        d.setCase(KEY, c);
        vm.expectRevert(bytes("PRE-FLIGHT: PROTOCOL_CUT_BPS above the 10% cap"));
        d.run();
    }

    function test_PreflightRefusesATokenWithNoCode() public {
        Deploy.Cfg memory c = _cfg();
        c.usdt = address(0xDEAD);
        TestDeploy d = new TestDeploy();
        d.setCase(KEY, c);
        vm.expectRevert(bytes("PRE-FLIGHT: a canonical token has no code at its address"));
        d.run();
    }

    function test_GovernanceIsOptional() public {
        Deploy.Cfg memory c = _cfg();
        c.governance = true; c.govMultisig = address(0x5AFE5AFE);
        c.propThreshold = 1_000e18; c.quorumBps = 1_000; c.votingPeriod = 3 days; c.votingDelay = 1 days;
        c.timelockDelay = 48 hours;
        TestDeploy d = _run(c);
        assertEq(d.governance().owner(), vm.addr(KEY));
        assertTrue(d.timelock().hasRole(d.timelock().PROPOSER_ROLE(), c.govMultisig));
        assertEq(d.timelock().getMinDelay(), 48 hours);
    }
}
