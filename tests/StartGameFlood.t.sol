// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import "forge-std/Test.sol";

import "../contracts/PrizeEscrow.sol";
import "../contracts/GameRegistry.sol";
import "../contracts/TimbPrize.sol";
import "../contracts/VRFEntropy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FloodTIMBS is ERC20 {
    constructor() ERC20("Mock TIMBS", "TIMBS") { _mint(msg.sender, 1_000_000e18); }
}

contract FloodVRF is IVRFCoordinatorV2Plus {
    uint256 public nextId = 1;
    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256) { return nextId++; }
}

/**
 * TS-017 — startGame() must not touch the round-1 entrant array.
 *
 * Pre-start entries target round 1 and can be submitted (and cancelled) by
 * anyone, so a synchronous activation loop inside startGame let a pre-launch
 * flood push it past the per-transaction gas cap on every attempt. Round 1 is
 * now activated like every later round: by the keeper, in bounded chunks.
 *
 * Run: forge test --match-contract StartGameFloodTest -vvv
 */
contract StartGameFloodTest is Test {
    uint256 constant ENTRY_ETH = 0.001 ether;
    uint256 constant N = 200;

    function _deploy() internal returns (GameRegistry registry, TimbPrize prize) {
        FloodTIMBS timbs = new FloodTIMBS();
        PrizeEscrow escrow = new PrizeEscrow();
        registry = new GameRegistry(address(timbs), address(0xBEEF), address(0), 2e18, 1e18);
        prize    = new TimbPrize(address(escrow), address(registry), address(this));
        VRFEntropy entropy = new VRFEntropy(address(new FloodVRF()), bytes32(uint256(0xABC)), 42, 3, 200_000, hex"1234");
        entropy.setBoard(address(prize));
        prize.setEntropy(address(entropy));
        registry.setTimbPrize(address(prize));
        escrow.setTimbPrize(address(prize));
    }

    function _wallet(uint256 i) internal pure returns (address) {
        return address(uint160(0x100000 + i));
    }

    function _measureStart(TimbPrize prize) internal returns (uint256 used) {
        uint256 g = gasleft();
        prize.startGame();
        used = g - gasleft();
    }

    function test_TS017_StartGameGasIndependentOfPreStartEntrants() public {
        (GameRegistry quiet, TimbPrize quietPrize) = _deploy();
        uint256 baseline = _measureStart(quietPrize);

        (GameRegistry flooded, TimbPrize floodedPrize) = _deploy();
        for (uint256 i = 0; i < N; i++) {
            address w = _wallet(i);
            vm.deal(w, 1 ether);
            vm.prank(w);
            flooded.submitEntry{value: ENTRY_ETH}(bytes6("AB12CD"), true, 0);
        }
        assertEq(flooded.getRoundEntrants(1).length, N, "flood landed in round 1");

        uint256 floodedGas = _measureStart(floodedPrize);
        // The old loop cost several thousand gas per entrant; now the flood
        // adds nothing beyond cold-slot noise.
        assertApproxEqAbs(floodedGas, baseline, 30_000, "startGame gas must not scale with entrants");

        // Round 1 is still activated, by the keeper, in bounded chunks.
        address[] memory all = flooded.getRoundEntrants(1);
        address[] memory chunk = new address[](N / 2);
        for (uint256 c = 0; c < 2; c++) {
            for (uint256 k = 0; k < N / 2; k++) chunk[k] = all[c * (N / 2) + k];
            vm.prank(address(0xC0FFEE));
            flooded.activateRoundEntries(1, chunk);
        }
        uint256 id = flooded.ticketAt(flooded.generation(), _wallet(N - 1), 1);
        (GameRegistry.Ticket memory t, ) = flooded.getTicket(id);
        assertEq(uint8(t.status), uint8(GameRegistry.TicketStatus.Active), "keeper activated round 1");
        quiet; // silence unused
    }
}
