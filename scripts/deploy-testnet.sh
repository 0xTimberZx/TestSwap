#!/usr/bin/env bash
# deploy-testnet.sh — the testnet redeploy: scripts/Deploy.s.sol with the inputs
# decided 30 Oct – 1 Nov (TESTNET_REDEPLOY_PLAN §3), for the Admin — Deploy
# Testnet workflow.
#
#   MODE=simulate   forge script without --broadcast: runs the whole deploy and
#                   its read-back on a local copy of the chain, prints the
#                   report, sends nothing (default)
#   MODE=broadcast  sends it (--slow: one transaction at a time)
#
# Required env:
#   DEPLOYER_PRIVATE_KEY   the new owner (TSDeployer)
#   EXPECT_DEPLOYER        the address that key must belong to; stops otherwise
#   SETTLER_ADDRESS        keeper hot key: TimbPrize settler
#   FAUCET_DISPATCHER      keeper hot key: GasFaucet dispatcher
#   FAUCET_GUARDIAN        pause-only key
# Optional env:
#   DEPLOY_RPC             default: the public Arbitrum Sepolia RPC
#   TREASURY_ADDRESS, PROTOCOL_SINK_ADDRESS     default: the deployer
#   WETH_ADDRESS … DAPP_ADDRESS                 default: config.js (same tokens as before)
#   VRF_COORDINATOR, VRF_KEY_HASH, VRF_SUB_ID, VRF_EXTRA_ARGS, VRF_CONFIRMATIONS,
#   VRF_CALLBACK_GAS                            default: read from the live PrizeVRFEntropy
#                                               (same coordinator and subscription)
#   REWARD_RATE_PER_SEC, FARM_REWARD_RATE, YIELD_APR_BPS
#                                               default: read from the live contracts
#   OUT_DIR                where the log and addresses.json go (default: a temp dir)
#
# Role checks before anything runs: the three keeper/guardian addresses must be
# distinct, none may be the deployer, and none may be a leaked key or the old
# owner wallet. Deploy.s.sol's own pre-flight then checks again.

set -euo pipefail
MODE=${MODE:-simulate}
RPC=${DEPLOY_RPC:-https://sepolia-rollup.arbitrum.io/rpc}
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=${OUT_DIR:-$(mktemp -d)}
FORGE_FLAGS=${FORGE_FLAGS:-}
mkdir -p "$OUT"
fail() { echo "DEPLOY STOPPED: $*" >&2; exit 1; }
lc()   { echo "$1" | tr 'A-F' 'a-f'; }
cfg()  { grep -oE "^  $1: +\"0x[0-9a-fA-F]{40}\"" "$REPO/config.js" | head -1 | grep -oE '0x[0-9a-fA-F]{40}'; }
num()  { awk '{print $1}'; }
summary() { [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "$*" >> "$GITHUB_STEP_SUMMARY"; echo "$*"; }

case "$MODE" in simulate|broadcast) ;; *) fail "MODE must be simulate or broadcast" ;; esac
[ -n "${DEPLOYER_PRIVATE_KEY:-}" ] || fail "DEPLOYER_PRIVATE_KEY is not set"
[ "$(cast chain-id --rpc-url "$RPC")" = 421614 ] || fail "not Arbitrum Sepolia (chain id $(cast chain-id --rpc-url "$RPC"))"

# ── Who signs, and who gets which role ─────────────────────────────────────────
DEPLOYER=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
[ -n "${EXPECT_DEPLOYER:-}" ] || fail "EXPECT_DEPLOYER is not set"
[ "$(lc "$DEPLOYER")" = "$(lc "$EXPECT_DEPLOYER")" ] || fail "the key belongs to $DEPLOYER, not the expected $EXPECT_DEPLOYER"

LEAKED="0x42536623b503d4926dfaf6173b0357b7dfd19800 0x490ae1ec3452c32da2643715bd310f1ebc87c652"
OLD_OWNER="0xf27b6ff61fce2b11889ad130cde443093bc2d8f2"   # the 22 Oct rotation's owner: stays on the old contracts
for role in SETTLER_ADDRESS FAUCET_DISPATCHER FAUCET_GUARDIAN; do
  v=${!role:-}; [ -n "$v" ] || fail "$role is not set"
  echo "$v" | grep -qE '^0x[0-9a-fA-F]{40}$' || fail "$role is not an address: $v"
  a=$(lc "$v")
  [ "$a" != "$(lc "$DEPLOYER")" ] || fail "$role is the deployer; each role gets its own key"
  for k in $LEAKED; do [ "$a" != "$k" ] || fail "$role is a leaked key"; done
  [ "$a" != "$OLD_OWNER" ] || fail "$role is the old owner wallet (0xF27B…d8f2); use a fresh one"
done
[ "$(lc "$SETTLER_ADDRESS")" != "$(lc "$FAUCET_DISPATCHER")" ] || fail "settler and dispatcher are the same key"
[ "$(lc "$SETTLER_ADDRESS")" != "$(lc "$FAUCET_GUARDIAN")" ] || fail "settler and guardian are the same key"
[ "$(lc "$FAUCET_DISPATCHER")" != "$(lc "$FAUCET_GUARDIAN")" ] || fail "dispatcher and guardian are the same key"

export TREASURY_ADDRESS=${TREASURY_ADDRESS:-$DEPLOYER}
export PROTOCOL_SINK_ADDRESS=${PROTOCOL_SINK_ADDRESS:-$DEPLOYER}

# ── Tokens: the same canonical/test tokens as before ──────────────────────────
export WETH_ADDRESS=${WETH_ADDRESS:-$(cfg WETH)} USDC_ADDRESS=${USDC_ADDRESS:-$(cfg USDC)}
export USDT_ADDRESS=${USDT_ADDRESS:-$(cfg USDT)} LINK_ADDRESS=${LINK_ADDRESS:-$(cfg LINK)} DAPP_ADDRESS=${DAPP_ADDRESS:-$(cfg DAPP)}

# ── VRF: same coordinator and subscription as the live game ────────────────────
if [ -z "${VRF_COORDINATOR:-}" ]; then
  E=$(cfg PrizeVRFEntropy)
  export VRF_COORDINATOR=$(cast call "$E" "coordinator()(address)" --rpc-url "$RPC")
  export VRF_KEY_HASH=$(cast call "$E" "keyHash()(bytes32)" --rpc-url "$RPC")
  export VRF_SUB_ID=$(cast call "$E" "subId()(uint256)" --rpc-url "$RPC" | num)
  export VRF_CONFIRMATIONS=$(cast call "$E" "requestConfirmations()(uint16)" --rpc-url "$RPC" | num)
  export VRF_CALLBACK_GAS=$(cast call "$E" "callbackGasLimit()(uint32)" --rpc-url "$RPC" | num)
  export VRF_EXTRA_ARGS=$(cast call "$E" "extraArgs()(bytes)" --rpc-url "$RPC")
fi

# ── Reward and yield rates: as the live contracts run them ─────────────────────
[ -n "${REWARD_RATE_PER_SEC:-}" ] || export REWARD_RATE_PER_SEC=$(cast call "$(cfg TimbStaking)" "rewardRatePerSecond()(uint256)" --rpc-url "$RPC" | num)
[ -n "${FARM_REWARD_RATE:-}" ]    || export FARM_REWARD_RATE=$(cast call "$(cfg TimbFarm)" "rewardRatePerSecond()(uint256)" --rpc-url "$RPC" | num)
if [ -z "${YIELD_APR_BPS:-}" ]; then
  R=$(cast call "$(cfg TimbYieldVault)" "ratePerSecond1e18()(uint256)" --rpc-url "$RPC" | num)
  export YIELD_APR_BPS=$(python3 -c "print(round($R * 10000 * 365 * 86400 / 10**18))")
fi

# ── Game and faucet inputs decided 30 Oct (TESTNET_REDEPLOY_PLAN §3.4) ────────
export INITIAL_SUPPLY=10000000000000000000000000          # 10M TIMBS to the treasury wallet
export ENTRY_COST_TIMBS=100000000000000000000             # 100 TIMBS (informational, = floor)
export TIMBS_ENTRY_FLOOR=100000000000000000000            # 100 TIMBS
export TIMBS_STEP=10000000000000000000                    # +10 per active TIMBS entry
export FAUCET_TIMBS_PER_CLAIM=100000000000000000000       # 100 TIMBS
export FAUCET_DRIP_ETH=20000000000000                     # 0.00002 ETH (double mainnet)
export FAUCET_POT_ETH=20000000000000                      # 0.00002 ETH
export FAUCET_COOLDOWN=86400
export FAUCET_ETH_CAP=160000000000000000                  # 0.16 ETH
export FAUCET_TIMBS_CAP=1000000000000000000000000         # 1M TIMBS
export PROTOCOL_CUT_BPS=${PROTOCOL_CUT_BPS:-50}           # 0.5%

summary "## Testnet deploy (${MODE})"
summary ""
summary "| Input | Value |"
summary "|---|---|"
summary "| Deployer / owner | \`$DEPLOYER\` |"
summary "| Treasury wallet (10M TIMBS), protocol sink | \`$TREASURY_ADDRESS\`, \`$PROTOCOL_SINK_ADDRESS\` |"
summary "| Settler | \`$SETTLER_ADDRESS\` |"
summary "| Faucet dispatcher | \`$FAUCET_DISPATCHER\` |"
summary "| Faucet guardian | \`$FAUCET_GUARDIAN\` |"
summary "| Tokens | WETH \`$WETH_ADDRESS\` · USDC \`$USDC_ADDRESS\` · USDT \`$USDT_ADDRESS\` · LINK \`$LINK_ADDRESS\` · DAPP \`$DAPP_ADDRESS\` |"
summary "| VRF | coordinator \`$VRF_COORDINATOR\`, key hash \`$VRF_KEY_HASH\`, sub $VRF_SUB_ID, confirmations $VRF_CONFIRMATIONS, callback gas $VRF_CALLBACK_GAS |"
summary "| Rates | staking $REWARD_RATE_PER_SEC/s, farm $FARM_REWARD_RATE/s, yield $YIELD_APR_BPS bps, protocol cut $PROTOCOL_CUT_BPS bps |"
summary "| Deployer ETH | $(cast balance "$DEPLOYER" --ether --rpc-url "$RPC") |"
summary ""

cd "$REPO"
ARGS=(--rpc-url "$RPC")
[ "$MODE" = broadcast ] && ARGS+=(--broadcast --slow)
# shellcheck disable=SC2086
if ! forge script scripts/Deploy.s.sol $FORGE_FLAGS "${ARGS[@]}" > "$OUT/deploy.log" 2>&1; then
  tail -30 "$OUT/deploy.log" | grep -v -i "private" >&2
  fail "forge script failed (log above); nothing was sent"
fi
grep -q "TESTNET DEPLOY COMPLETE" "$OUT/deploy.log" || { tail -30 "$OUT/deploy.log" >&2; fail "the read-back did not complete"; }

# The report's "Name: 0x…" lines → addresses.json, for the address-switch PR.
python3 - "$OUT/deploy.log" "$OUT/addresses.json" <<'EOF'
import json, re, sys
seen = {}
for line in open(sys.argv[1]):
    m = re.match(r"^\s*([A-Za-z][A-Za-z0-9]+):\s+(0x[0-9a-fA-F]{40})\s*$", line)
    if m and m.group(1) not in seen: seen[m.group(1)] = m.group(2)
json.dump(seen, open(sys.argv[2], "w"), indent=2)
print(f"{len(seen)} addresses")
EOF

summary "### Deployed addresses ($( [ "$MODE" = broadcast ] && echo 'on chain' || echo 'simulated: these are NOT live' ))"
summary ""
summary "| Contract | Address |"
summary "|---|---|"
python3 -c "import json,sys; [print(f'| {k} | \`{v}\` |') for k,v in json.load(open(sys.argv[1])).items()]" "$OUT/addresses.json" | while read -r l; do summary "$l"; done
summary ""
summary "$( [ "$MODE" = broadcast ] && echo 'Deployed and read back. Next: verify, the address-switch PR, seed, fund rewards, add the VRF consumer, startGame.' || echo 'Simulation passed: the deploy and its read-back ran on a local copy of the chain. Nothing was sent. Run again with mode=broadcast.' )"
echo "DEPLOY OK ($MODE)"
