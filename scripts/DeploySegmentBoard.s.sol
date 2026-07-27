// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Script.sol";
import "forge-std/console.sol";

import "../contracts/PoolLedger.sol";
import "../contracts/SeedRegistry.sol";
import "../contracts/CommitRevealEntropy.sol";
import "../contracts/SegmentBoard.sol";

/**
 * @title DeploySegmentBoard
 * @notice Deploys ONE generation of the SwapTables segment board
 *         (SwapTables/docs/SEGMENT_TABLES.md §13) on Arbitrum Sepolia.
 *
 * Generations:
 *   SegmentBoard, PoolLedger and the entropy module are immutable and redeployed
 *   per generation. SeedRegistry is NOT — it is the one long-lived contract that
 *   spans generations so a winning string is never reused as a seed. Set
 *   SEED_REGISTRY_ADDRESS to reuse the existing registry; leave it unset only for
 *   the very first generation, which deploys a fresh one.
 *
 * Usage:
 *   forge script scripts/DeploySegmentBoard.s.sol \
 *     --rpc-url $ARB_SEPOLIA_RPC \
 *     --broadcast \
 *     --verify \
 *     --verifier sourcify \
 *     -vvvv
 *
 * Environment variables required (.env — never commit):
 *   DEPLOYER_PRIVATE_KEY   — deployer wallet private key
 *   TIMBS_ADDRESS          — deployed TIMBSToken address
 *   TIMB_PRIZE_ADDRESS     — deployed TimbPrize address (seed source)
 *   TREASURY_ADDRESS       — treasury; funds the table seed, receives sweeps
 *   GUARDIAN_ADDRESS       — halt-only guardian (use address(0) for none)
 *
 * Optional:
 *   SEED_REGISTRY_ADDRESS  — existing registry to reuse (omit on generation 1)
 *   ENTRY_WINDOW_SECONDS   — seats/loads close after this (default 40 min, §10.3)
 *   PICK_DELAY_SECONDS     — open -> pick (default 45 min)
 *   BETS_CLOSE_SECONDS     — bets close this long before the pick (default 5 min)
 *
 * Post-deploy (MANUAL, required before play):
 *   1. TIMBS.setTransferWhitelist(poolLedger, true)
 *        The LEDGER custodies and pays TIMBS, so it — not the board — must be
 *        whitelisted or a large payout can trip maxTransferAmount.
 *   2. From TREASURY: TIMBS.approve(poolLedger, <seed budget>)
 *        openTable() pulls TABLE_SEED (100 TIMBS) per table from the treasury.
 *   3. Record the SegmentBoard address in SwapTables/onchain/addresses.js.
 *   4. At maturity: board.retireGuardian() and renounce ownership on both the
 *      board and the ledger for a zero-privilege generation (§13.2).
 */
contract DeploySegmentBoard is Script {
    PoolLedger          public ledger;
    SeedRegistry        public seedRegistry;
    CommitRevealEntropy public entropy;
    SegmentBoard        public board;

    function run() external {
        uint256 pk        = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address timbs     = vm.envAddress("TIMBS_ADDRESS");
        address timbPrize = vm.envAddress("TIMB_PRIZE_ADDRESS");
        address treasury  = vm.envAddress("TREASURY_ADDRESS");
        // Seed is PULLED via transferFrom, so this must be an address that can
        // call approve() — a treasury *contract* usually cannot. Defaults to the
        // treasury only when it is itself able to approve.
        address seedFunder = vm.envOr("SEED_FUNDER_ADDRESS", treasury);
        address guardian  = vm.envOr("GUARDIAN_ADDRESS", address(0));

        uint64 entryWindow   = uint64(vm.envOr("ENTRY_WINDOW_SECONDS", uint256(40 minutes)));
        uint64 pickDelay     = uint64(vm.envOr("PICK_DELAY_SECONDS",   uint256(45 minutes)));
        uint64 betsCloseLead = uint64(vm.envOr("BETS_CLOSE_SECONDS",   uint256(5 minutes)));

        address existingRegistry = vm.envOr("SEED_REGISTRY_ADDRESS", address(0));

        vm.startBroadcast(pk);

        // 1. Funds vault for this generation.
        ledger = new PoolLedger(timbs, treasury);
        console.log("PoolLedger          :", address(ledger));

        // 2. Seed registry — reused across generations, deployed only once.
        if (existingRegistry == address(0)) {
            seedRegistry = new SeedRegistry();
            console.log("SeedRegistry (NEW)  :", address(seedRegistry));
            console.log("  ^ record this and pass as SEED_REGISTRY_ADDRESS next generation");
        } else {
            seedRegistry = SeedRegistry(existingRegistry);
            console.log("SeedRegistry (reuse):", address(seedRegistry));
        }

        // 3. Entropy module (swap for a VRF module in a later generation, §10.6).
        entropy = new CommitRevealEntropy();
        console.log("CommitRevealEntropy :", address(entropy));

        // 4. The board itself.
        board = new SegmentBoard(
            address(ledger),
            address(seedRegistry),
            address(entropy),
            timbPrize,
            treasury,
            seedFunder,
            guardian,
            entryWindow,
            pickDelay,
            betsCloseLead
        );
        console.log("SegmentBoard        :", address(board));

        // 5. Wire: the ledger only takes orders from this board, and the board
        //    may consume seed rounds. setBoard is one-time.
        ledger.setBoard(address(board));

        // Only the registry's owner can authorise a writer. On a reused registry
        // that may be someone else, so don't revert the whole deploy over it.
        bool registryWired;
        if (seedRegistry.owner() == vm.addr(pk)) {
            seedRegistry.addWriter(address(board));
            registryWired = true;
        }

        vm.stopBroadcast();

        console.log("");
        console.log("--- SegmentBoard generation deployed ---");
        console.log("entryWindow  (s):", entryWindow);
        console.log("pickDelay    (s):", pickDelay);
        console.log("betsClose    (s):", betsCloseLead);
        console.log("guardian        :", guardian);
        console.log("seedFunder      :", seedFunder);
        console.log("");
        console.log("REQUIRED next steps:");
        console.log(" 1. TIMBS.setTransferWhitelist(poolLedger, true)");
        console.log(" 2. From the SEED FUNDER: TIMBS.approve(poolLedger, seedBudget)");
        console.log(" 3. Put SegmentBoard in SwapTables/onchain/addresses.js");
        if (!registryWired) {
            console.log(" 4. ACTION REQUIRED: registry owner must call");
            console.log("    seedRegistry.addWriter(board) - deployer is not the owner,");
            console.log("    so this board CANNOT open tables until they do.");
        }
    }
}
