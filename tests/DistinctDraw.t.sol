// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {PrizeWindowsTest} from "./PrizeWindows.t.sol";
import {GameRegistry} from "../contracts/GameRegistry.sol";

/// TS-004 port (fix-list 41): the winning string and the entry rule read one
/// flag, so a round can never settle on a string nobody could have entered.
contract DistinctDrawTest is PrizeWindowsTest {
    function test_TS004_winningStringNeverRepeatsByDefault() public {
        assertFalse(registry.allowRepeatedChars(), "ships distinct-only");
        for (uint256 r = 1; r <= 8; r++) {
            for (uint256 s = 0; s < 6; s++) settleOne();
            assertFalse(hasRepeats(prize.roundWinningString(r)), "repeat in winning string");
        }
    }

    function test_TS004_entryRuleFollowsTheSameFlag() public {
        uint256 cost = registry.entryCostETH();
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(GameRegistry.RepeatingCharacter.selector, bytes1("A")));
        registry.submitEntry{value: cost}(bytes6("AABCDE"), true, 0);
        registry.setAllowRepeatedChars(true);
        vm.prank(player);
        registry.submitEntry{value: cost}(bytes6("AABCDE"), true, 0);
        assertTrue(registry.activeTicketOf(player) != 0, "repeat entry accepted once allowed");
    }

    function test_TS004_setterOwnerOnly() public {
        vm.prank(rando);
        vm.expectRevert();
        registry.setAllowRepeatedChars(true);
    }
}
