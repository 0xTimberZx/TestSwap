// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

// Selective imports (contract types only). Several of these files declare their
// own file-level `interface IWETH` / `interface ITimbSwapPair` (Router, Factory
// and Treasury each carry a private copy); wildcard-importing all of them into
// one script collides on those identifiers. Named imports pull just the contract
// (and its nested types), never the ambient interfaces — and touch no deployed
// contract source.
import {TIMBSToken} from "../contracts/TIMBSToken.sol";
import {PrizeEscrow} from "../contracts/PrizeEscrow.sol";
import {TimbSwapFactory} from "../contracts/TimbSwapFactory.sol";
import {TimbSwapRouter} from "../contracts/TimbSwapRouter.sol";
import {EligibleTokenRegistry} from "../contracts/EligibleTokenRegistry.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";
import {TimbPrize} from "../contracts/TimbPrize.sol";
import {VRFEntropy} from "../contracts/VRFEntropy.sol";
import {TimbStaking} from "../contracts/TimbStaking.sol";
import {TimbFarm} from "../contracts/TimbFarm.sol";
import {TimbBoostFarm} from "../contracts/TimbBoostFarm.sol";
import {TimbLockVault} from "../contracts/TimbLockVault.sol";
import {TimbTreasury} from "../contracts/TimbTreasury.sol";
import {TimbYieldVault} from "../contracts/TimbYieldVault.sol";
import {GasFaucet} from "../contracts/GasFaucet.sol";
import {TimbGovernance} from "../contracts/TimbGovernance.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title Deploy
 * @notice Fresh deployment of the whole testnet set on Arbitrum Sepolia
 *         (dev-docs/TESTNET_REDEPLOY_PLAN.md: everything except the canonical
 *         tokens). Deploys, wires every edge and role, then reads the wiring
 *         back and reverts on any mismatch, so a broadcast that completes is a
 *         deployment that is wired.
 *
 * Not deployed here: SwapTables (own scripts, out of scope since 2026-09-27),
 * BoostRewarder (per-pool extras, attached later in the TS-074 order: attach,
 * sync, fund), vesting and the release vault. TimbGovernance and its timelock
 * only when DEPLOY_GOVERNANCE=true (the testnet runs without them).
 *
 * Every contract is owned by the deployer key, which is the new testnet owner
 * (fresh keys, plan D3). Nothing is funded and the game is not started:
 * seed pools, fund rewards and the vault, add the VRF consumer, startGame.
 *
 * Usage:
 *   forge script scripts/Deploy.s.sol --rpc-url $ARB_SEPOLIA_RPC        # simulate, read the report
 *   forge script scripts/Deploy.s.sol --rpc-url $ARB_SEPOLIA_RPC --broadcast
 *
 * Environment (.env, never committed). Required:
 *   DEPLOYER_PRIVATE_KEY            new owner key
 *   TREASURY_ADDRESS                wallet that receives the TIMBS genesis supply
 *   PROTOCOL_SINK_ADDRESS           receives GameRegistry's TIMBS sinks
 *   SETTLER_ADDRESS                 keeper hot key: TimbPrize settler
 *   FAUCET_DISPATCHER               keeper hot key: GasFaucet dispatcher
 *   WETH_ADDRESS, USDC_ADDRESS, USDT_ADDRESS, LINK_ADDRESS, DAPP_ADDRESS
 *   VRF_COORDINATOR, VRF_KEY_HASH, VRF_SUB_ID, VRF_EXTRA_ARGS
 *   ENTRY_COST_TIMBS, INITIAL_SUPPLY                 TIMBSToken
 *   TIMBS_ENTRY_FLOOR, TIMBS_STEP                    GameRegistry TIMBS pricing
 *   REWARD_RATE_PER_SEC, FARM_REWARD_RATE            TimbStaking, TimbFarm
 *   YIELD_APR_BPS                                    TimbYieldVault (on the flat ticket weight)
 *   FAUCET_DRIP_ETH, FAUCET_POT_ETH, FAUCET_TIMBS_PER_CLAIM, FAUCET_COOLDOWN,
 *   FAUCET_ETH_CAP, FAUCET_TIMBS_CAP                 GasFaucet
 * Optional:
 *   FAUCET_GUARDIAN                 pause-only key (TS-054)
 *   VRF_CONFIRMATIONS (3), VRF_CALLBACK_GAS (200000)
 *   PROTOCOL_CUT_BPS (50)           0.5% of each settled pot (decided 2026-10-30)
 *   OPERATOR_ETH_CAP (0.1 ETH), OPERATOR_PERIOD (1 day)   faucet's pull on the treasury
 *   BOOST_EMISSION_WINDOW (302400 s = 3.5 days), BOOST_POOL_WEIGHT (100)
 *   DEPLOY_GOVERNANCE (false), then GOV_MULTISIG, PROPOSAL_THRESHOLD, QUORUM_BPS,
 *     VOTING_PERIOD, VOTING_DELAY, TIMELOCK_MIN_DELAY (48 h)
 */
contract Deploy is Script {

    struct Cfg {
        address deployer; address treasuryWallet; address sink; address settler;
        address dispatcher; address guardian;
        address weth; address usdc; address usdt; address link; address dapp;
        address vrfCoord; bytes32 vrfKeyHash; uint256 vrfSubId; bytes vrfExtra;
        uint16 vrfConfs; uint32 vrfCbGas;
        uint256 entryCostTimbs; uint256 initialSupply; uint256 timbsEntryFloor; uint256 timbsStep;
        uint256 stakingRate; uint256 farmRate; uint256 yieldAprBps; uint256 cutBps;
        uint256 dripEth; uint256 potEth; uint256 timbsPerClaim; uint256 cooldown;
        uint256 faucetEthCap; uint256 faucetTimbsCap; uint256 operatorCap; uint256 operatorPeriod;
        uint256 boostWindow; uint256 boostWeight;
        bool governance; address govMultisig; uint256 propThreshold; uint256 quorumBps;
        uint256 votingPeriod; uint256 votingDelay; uint256 timelockDelay;
    }

    // ─── Deployed addresses (read back by the report and by the test) ────────

    TIMBSToken            public timbs;
    PrizeEscrow           public prizeEscrow;
    TimbSwapFactory       public factory;
    TimbSwapRouter        public router;
    EligibleTokenRegistry public eligibleRegistry;
    GameRegistry          public gameRegistry;
    TimbPrize             public timbPrize;
    VRFEntropy            public prizeEntropy;
    TimbStaking           public staking;
    TimbFarm              public farm;
    TimbBoostFarm         public boostFarm;
    TimbLockVault         public lockVault;
    TimbTreasury          public treasury;
    TimbYieldVault        public yieldVault;
    GasFaucet             public faucet;
    TimbGovernance        public governance;
    TimelockController    public timelock;

    address public timbsEthPair;
    address public usdcEthPair;
    address public usdtEthPair;
    address public linkEthPair;

    function run() external {
        uint256 key = _key();
        Cfg memory c = _cfg(vm.addr(key));
        _preflight(c);

        vm.startBroadcast(key);
        _deployCore(c);
        _deployDex(c);
        _deployGame(c);
        _deployRewards(c);
        _deployFaucet(c);
        if (c.governance) _deployGovernance(c);
        vm.stopBroadcast();

        _report(c);
    }

    // ─── Config ──────────────────────────────────────────────────────────────
    // Both loaders are virtual so tests/DeployScript.t.sol can supply a config
    // directly instead of through process-wide environment variables.

    function _key() internal view virtual returns (uint256) {
        return vm.envUint("DEPLOYER_PRIVATE_KEY");
    }

    function _cfg(address deployer) internal view virtual returns (Cfg memory c) {
        c.deployer       = deployer;
        c.treasuryWallet = vm.envAddress("TREASURY_ADDRESS");
        c.sink           = vm.envAddress("PROTOCOL_SINK_ADDRESS");
        c.settler        = vm.envAddress("SETTLER_ADDRESS");
        c.dispatcher     = vm.envAddress("FAUCET_DISPATCHER");
        c.guardian       = vm.envOr("FAUCET_GUARDIAN", address(0));
        c.weth = vm.envAddress("WETH_ADDRESS");
        c.usdc = vm.envAddress("USDC_ADDRESS");
        c.usdt = vm.envAddress("USDT_ADDRESS");
        c.link = vm.envAddress("LINK_ADDRESS");
        c.dapp = vm.envAddress("DAPP_ADDRESS");
        c.vrfCoord   = vm.envAddress("VRF_COORDINATOR");
        c.vrfKeyHash = vm.envBytes32("VRF_KEY_HASH");
        c.vrfSubId   = vm.envUint("VRF_SUB_ID");
        c.vrfExtra   = vm.envBytes("VRF_EXTRA_ARGS");
        c.vrfConfs   = uint16(vm.envOr("VRF_CONFIRMATIONS", uint256(3)));
        c.vrfCbGas   = uint32(vm.envOr("VRF_CALLBACK_GAS", uint256(200_000)));
        // Prices and rates have no defaults on purpose: the right values depend
        // on this deployment, and a silent default is how a testnet number
        // reaches a live game (dev-docs/EMISSIONS_SCHEDULE.md §7).
        c.entryCostTimbs  = vm.envUint("ENTRY_COST_TIMBS");
        c.initialSupply   = vm.envUint("INITIAL_SUPPLY");
        c.timbsEntryFloor = vm.envUint("TIMBS_ENTRY_FLOOR");
        c.timbsStep       = vm.envUint("TIMBS_STEP");
        c.stakingRate     = vm.envUint("REWARD_RATE_PER_SEC");
        c.farmRate        = vm.envUint("FARM_REWARD_RATE");
        c.yieldAprBps     = vm.envUint("YIELD_APR_BPS");
        // Protocol cut per settlement: 0.5% (decided 2026-10-30; the contract
        // default is 2%, at most 10%).
        c.cutBps = vm.envOr("PROTOCOL_CUT_BPS", uint256(50));
        c.dripEth        = vm.envUint("FAUCET_DRIP_ETH");
        c.potEth         = vm.envUint("FAUCET_POT_ETH");
        c.timbsPerClaim  = vm.envUint("FAUCET_TIMBS_PER_CLAIM");
        c.cooldown       = vm.envUint("FAUCET_COOLDOWN");
        c.faucetEthCap   = vm.envUint("FAUCET_ETH_CAP");
        c.faucetTimbsCap = vm.envUint("FAUCET_TIMBS_CAP");
        c.operatorCap    = vm.envOr("OPERATOR_ETH_CAP", uint256(1e17));
        c.operatorPeriod = vm.envOr("OPERATOR_PERIOD", uint256(1 days));
        c.boostWindow    = vm.envOr("BOOST_EMISSION_WINDOW", uint256(302_400));
        c.boostWeight    = vm.envOr("BOOST_POOL_WEIGHT", uint256(100));
        c.governance     = vm.envOr("DEPLOY_GOVERNANCE", false);
        if (c.governance) {
            c.govMultisig   = vm.envAddress("GOV_MULTISIG");
            c.propThreshold = vm.envUint("PROPOSAL_THRESHOLD");
            c.quorumBps     = vm.envUint("QUORUM_BPS");
            c.votingPeriod  = vm.envUint("VOTING_PERIOD");
            c.votingDelay   = vm.envUint("VOTING_DELAY");
            c.timelockDelay = vm.envOr("TIMELOCK_MIN_DELAY", uint256(48 hours));
        }
    }

    /// @dev Refuse a run that would wire to the wrong thing: an old key in a
    ///      role, a token that is not deployed, or a cut above the cap.
    function _preflight(Cfg memory c) internal view {
        require(block.chainid == 421614 || block.chainid == 31337, "PRE-FLIGHT: not Arbitrum Sepolia (or a local chain)");
        require(c.cutBps <= 1_000, "PRE-FLIGHT: PROTOCOL_CUT_BPS above the 10% cap");
        // Keys leaked in the 22 October Railway incident must never hold a role
        // on the new contracts (plan D3).
        address leakedDeployer   = 0x42536623b503D4926DfAF6173B0357b7DfD19800;
        address[5] memory roles = [c.deployer, c.settler, c.dispatcher, c.guardian, c.treasuryWallet];
        for (uint256 i; i < roles.length; i++) {
            require(roles[i] != leakedDeployer, "PRE-FLIGHT: a role is the leaked deployer key");
        }
        address[5] memory tokens = [c.weth, c.usdc, c.usdt, c.link, c.dapp];
        for (uint256 i; i < tokens.length; i++) {
            require(tokens[i].code.length > 0, "PRE-FLIGHT: a canonical token has no code at its address");
        }
        console.log("PRE-FLIGHT OK. Deployer (new owner):", c.deployer);
        console.log("  settler:   ", c.settler);
        console.log("  dispatcher:", c.dispatcher);
        console.log("  guardian:  ", c.guardian);
    }

    // ─── Deploy and wire ─────────────────────────────────────────────────────

    /// @dev Token, escrow, factory, the reward pools and the treasury: the
    ///      contracts everything else takes in its constructor.
    function _deployCore(Cfg memory c) internal {
        timbs       = new TIMBSToken(c.treasuryWallet, c.initialSupply, c.entryCostTimbs);
        prizeEscrow = new PrizeEscrow();
        factory     = new TimbSwapFactory(c.treasuryWallet);
        staking     = new TimbStaking(address(timbs), c.stakingRate);
        farm        = new TimbFarm(address(timbs), c.farmRate);
        treasury    = new TimbTreasury(address(timbs), address(staking), address(prizeEscrow), address(0), c.weth);
        // The escrow delivers the round's protocol cut; counted as fees (TS-023).
        treasury.setFeeSender(address(prizeEscrow), true);
    }

    /// @dev Router, the four pairs the seed workflow fills, and the factory's
    ///      routing and fee wiring.
    function _deployDex(Cfg memory c) internal {
        router = new TimbSwapRouter(address(factory), address(treasury), address(0), address(0));
        router.setWeth(c.weth); // also sets the TS-009 WETH nudge floor

        factory.setRouter(address(router));
        factory.setTimbsToken(address(timbs));
        // The pools' protocol share is minted as LP to the treasury.
        factory.setFeeTo(address(treasury));

        timbsEthPair = _pair(address(timbs), c.weth);
        usdcEthPair  = _pair(c.usdc, c.weth);
        usdtEthPair  = _pair(c.usdt, c.weth);
        linkEthPair  = _pair(c.link, c.weth);
        factory.setEmissionsWhitelist(timbsEthPair, true);
        // TS-052: swaps earn nudges only through designated pairs.
        router.setNudgePair(timbsEthPair, true);
        router.setNudgePair(usdcEthPair, true);
        router.setNudgePair(usdtEthPair, true);
        router.setNudgePair(linkEthPair, true);

        treasury.setTimbsEthPair(timbsEthPair);
        treasury.setRouter(address(router)); // protocol-owned liquidity

        address[] memory eligible = new address[](6);
        eligible[0] = address(timbs); eligible[1] = c.weth; eligible[2] = c.usdc;
        eligible[3] = c.usdt;         eligible[4] = c.link; eligible[5] = c.dapp;
        eligibleRegistry = new EligibleTokenRegistry(eligible);
        router.setEligibleRegistry(address(eligibleRegistry));
        eligibleRegistry.registerConsumer(address(router));
    }

    function _pair(address a, address b) internal returns (address p) {
        p = factory.getPairAddress(a, b);
        if (p == address(0)) {
            factory.createPair(a, b);
            p = factory.getPairAddress(a, b);
        }
    }

    /// @dev Registry, prize, entropy and yield vault, wired to each other and
    ///      to the router and escrow.
    function _deployGame(Cfg memory c) internal {
        gameRegistry = new GameRegistry(address(timbs), c.sink, address(0), c.timbsEntryFloor, c.timbsStep);
        timbPrize    = new TimbPrize(address(prizeEscrow), address(gameRegistry), address(router));
        prizeEntropy = new VRFEntropy(c.vrfCoord, c.vrfKeyHash, c.vrfSubId, c.vrfConfs, c.vrfCbGas, c.vrfExtra);
        yieldVault   = new TimbYieldVault();

        gameRegistry.setTimbPrize(address(timbPrize));
        gameRegistry.setYieldVault(address(yieldVault));
        prizeEscrow.setTimbPrize(address(timbPrize));
        prizeEntropy.setBoard(address(timbPrize));

        timbPrize.setEntropy(address(prizeEntropy));
        timbPrize.setEligibleRegistry(address(eligibleRegistry));
        timbPrize.setYieldVault(address(yieldVault));
        timbPrize.setSettler(c.settler);
        if (c.cutBps != timbPrize.protocolCutBps()) timbPrize.setProtocolCutBps(c.cutBps);

        yieldVault.setGameRegistry(address(gameRegistry));
        yieldVault.setTimbPrize(address(timbPrize));
        yieldVault.setYieldAPRBps(c.yieldAprBps);

        router.setTimbPrize(address(timbPrize));
        eligibleRegistry.registerConsumer(address(timbPrize));
    }

    /// @dev Staking, the TIMBS/WETH farm, the boost farm over the other three
    ///      seeded pairs, the lock vault, and TIMBS's pool and whitelist wiring.
    function _deployRewards(Cfg memory c) internal {
        staking.setTreasury(address(treasury));
        farm.setLpToken(timbsEthPair);
        farm.setTreasury(address(treasury));

        boostFarm = new TimbBoostFarm(address(timbs), c.boostWindow, address(factory));
        boostFarm.addPool(usdcEthPair, c.boostWeight);
        boostFarm.addPool(usdtEthPair, c.boostWeight);
        boostFarm.addPool(linkEthPair, c.boostWeight);

        lockVault = new TimbLockVault(address(timbs));
        address[] memory lockTokens = new address[](3);
        lockTokens[0] = c.weth; lockTokens[1] = c.dapp; lockTokens[2] = c.link;
        lockVault.addManyToWhitelist(lockTokens);

        timbs.setStakingPool(address(staking));
        timbs.setFarmPool(address(farm));
        timbs.setTransferWhitelist(address(router), true);
        timbs.setTransferWhitelist(address(treasury), true);
    }

    /// @dev The faucet draws ETH from the treasury as its rate-limited operator.
    function _deployFaucet(Cfg memory c) internal {
        faucet = new GasFaucet(
            address(treasury), address(timbs), address(gameRegistry), address(timbPrize),
            c.dripEth, c.potEth, c.timbsPerClaim, c.cooldown
        );
        faucet.setDispatcher(c.dispatcher);
        if (c.guardian != address(0)) faucet.setGuardian(c.guardian);
        faucet.setEthCap(c.faucetEthCap);
        faucet.setTimbsCap(c.faucetTimbsCap);
        treasury.setOperator(address(faucet));
        treasury.setOperatorEthCap(c.operatorCap, c.operatorPeriod);
    }

    /// @dev Optional (DEPLOY_GOVERNANCE=true). Signalling governance and a
    ///      timelock the multisig drives; nothing is handed to the timelock here.
    function _deployGovernance(Cfg memory c) internal {
        governance = new TimbGovernance(address(timbs), c.propThreshold, c.quorumBps, c.votingPeriod, c.votingDelay);
        address[] memory roles = new address[](1);
        roles[0] = c.govMultisig;
        timelock = new TimelockController(c.timelockDelay, roles, roles, address(0));
    }

    // ─── Read-back ───────────────────────────────────────────────────────────

    /// @dev Every edge and role read from the chain; any mismatch reverts.
    function _report(Cfg memory c) internal view {
        // Ownership: the new owner key holds every owned contract.
        require(timbs.owner() == c.deployer && prizeEscrow.owner() == c.deployer && factory.owner() == c.deployer, "owner: token/escrow/factory");
        require(router.owner() == c.deployer && eligibleRegistry.owner() == c.deployer && gameRegistry.owner() == c.deployer, "owner: router/eligible/registry");
        require(timbPrize.owner() == c.deployer && prizeEntropy.owner() == c.deployer && yieldVault.owner() == c.deployer, "owner: prize/entropy/vault");
        require(staking.owner() == c.deployer && farm.owner() == c.deployer && boostFarm.owner() == c.deployer, "owner: staking/farm/boost");
        require(lockVault.owner() == c.deployer && treasury.owner() == c.deployer && faucet.owner() == c.deployer, "owner: lock/treasury/faucet");

        // DEX
        require(factory.router() == address(router) && factory.timbsToken() == address(timbs), "factory: router and TIMBS");
        require(factory.feeTo() == address(treasury), "factory: pool protocol share to the treasury");
        require(factory.emissionsWhitelist(timbsEthPair), "factory: TIMBS/WETH emissions-whitelisted");
        require(router.treasury() == address(treasury) && router.weth() == c.weth, "router: treasury and WETH");
        require(router.minNudgeAmountIn(c.weth) > 0, "router: WETH nudge floor (TS-009)");
        require(router.timbPrize() == address(timbPrize) && router.eligibleRegistry() == address(eligibleRegistry), "router: prize and eligible registry");
        require(router.nudgePairs(timbsEthPair) && router.nudgePairs(usdcEthPair) && router.nudgePairs(usdtEthPair) && router.nudgePairs(linkEthPair), "router: the four seeded pairs are nudge pairs (TS-052)");

        // Game
        require(gameRegistry.timbPrize() == address(timbPrize) && gameRegistry.yieldVault() == address(yieldVault), "registry: prize and vault");
        require(prizeEscrow.timbPrize() == address(timbPrize), "escrow: pays the prize");
        require(address(timbPrize.entropy()) == address(prizeEntropy) && prizeEntropy.board() == address(timbPrize), "prize <-> entropy");
        require(timbPrize.router() == address(router) && timbPrize.eligibleRegistry() == address(eligibleRegistry), "prize: router and eligible registry");
        require(timbPrize.yieldVault() == address(yieldVault) && timbPrize.settler() == c.settler, "prize: vault and settler");
        require(timbPrize.protocolCutBps() == c.cutBps, "prize: protocol cut as configured");
        require(!timbPrize.gameStarted(), "deploy must not start the game");
        require(yieldVault.gameRegistry() == address(gameRegistry) && yieldVault.timbPrize() == address(timbPrize), "vault: registry and prize");
        require(yieldVault.ratePerSecond1e18() == c.yieldAprBps * 1e18 / 10_000 / 365 days, "vault: yield rate as configured");
        require(eligibleRegistry.registeredConsumers(address(router)) && eligibleRegistry.registeredConsumers(address(timbPrize)), "eligible registry: router and prize");

        // Rewards and treasury
        require(timbs.stakingPool() == address(staking) && timbs.farmPool() == address(farm), "TIMBS: staking and farm pools");
        require(timbs.transferWhitelist(address(router)) && timbs.transferWhitelist(address(treasury)), "TIMBS: router and treasury whitelisted");
        require(staking.treasury() == address(treasury) && farm.treasury() == address(treasury), "staking/farm: treasury");
        require(address(farm.lpToken()) == timbsEthPair, "farm: TIMBS/WETH LP");
        require(boostFarm.poolCount() == 3, "boost farm: USDC, USDT, LINK pools");
        require(treasury.timbsEthPair() == timbsEthPair && treasury.router() == address(router), "treasury: pair and router");
        require(treasury.prizeEscrow() == address(prizeEscrow) && treasury.authorisedFeeSenders(address(prizeEscrow)), "treasury: escrow's cut counts as fees");
        require(lockVault.tokenWhitelist(c.weth) && lockVault.tokenWhitelist(c.dapp) && lockVault.tokenWhitelist(c.link), "lock vault: WETH, DAPP, LINK");

        // Faucet and keeper roles
        require(faucet.dispatcher() == c.dispatcher && faucet.guardian() == c.guardian, "faucet: dispatcher and guardian");
        require(faucet.ethCap() == c.faucetEthCap && faucet.timbsCap() == c.faucetTimbsCap, "faucet: caps");
        require(treasury.operator() == address(faucet) && treasury.operatorEthCap() == c.operatorCap, "treasury: faucet is the capped operator");
        if (c.governance) {
            require(governance.owner() == c.deployer, "owner: governance");
            require(timelock.hasRole(timelock.PROPOSER_ROLE(), c.govMultisig) && timelock.getMinDelay() == c.timelockDelay, "timelock: multisig proposes, delay as configured");
        }

        console.log("\n========== TESTNET DEPLOY COMPLETE (wiring read back) ==========");
        console.log("TIMBSToken:            ", address(timbs));
        console.log("PrizeEscrow:           ", address(prizeEscrow));
        console.log("TimbSwapFactory:       ", address(factory));
        console.log("TimbSwapRouter:        ", address(router));
        console.log("EligibleTokenRegistry: ", address(eligibleRegistry));
        console.log("GameRegistry:          ", address(gameRegistry));
        console.log("TimbPrize:             ", address(timbPrize));
        console.log("PrizeVRFEntropy:       ", address(prizeEntropy));
        console.log("TimbYieldVault:        ", address(yieldVault));
        console.log("GasFaucet:             ", address(faucet));
        console.log("TimbStaking:           ", address(staking));
        console.log("TimbFarm:              ", address(farm));
        console.log("TimbBoostFarm:         ", address(boostFarm));
        console.log("TimbLockVault:         ", address(lockVault));
        console.log("TimbTreasury:          ", address(treasury));
        console.log("TimbsEthPair:          ", timbsEthPair);
        console.log("USDC/WETH, USDT/WETH, LINK/WETH pairs:");
        console.log("  ", usdcEthPair);
        console.log("  ", usdtEthPair);
        console.log("  ", linkEthPair);
        if (address(governance) != address(0)) {
            console.log("TimbGovernance:        ", address(governance));
            console.log("TimelockController:    ", address(timelock));
        }
        console.log("NEXT (dev-docs/TESTNET_REDEPLOY_PLAN.md section 3):");
        console.log("1. Verify on Sourcify and Arbiscan (verify-contracts.yml)");
        console.log("2. Seed the four pairs (seed-pools.yml)");
        console.log("3. Fund rewards (admin-fund-rewards.yml), the yield vault, the treasury and the faucet's TIMBS");
        console.log("4. Add PrizeVRFEntropy as a consumer on the VRF subscription; then TimbPrize.startGame()");
        console.log("5. node scripts/check-roles.js <new owner>; then the config.js address PR");
    }
}
