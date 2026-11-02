#!/usr/bin/env bash
# rehearse-redeploy.sh — deploy-day rehearsal for the testnet redeploy
# (dev-docs/TESTNET_REDEPLOY_PLAN.md §1). Runs the real tools end to end on a
# throwaway anvil chain and exits non-zero if any step fails:
#
#   1. Deploy.s.sol from env (pre-flight, simulate, broadcast, on-chain read-back)
#   2. seed TIMBS/WETH with seed-pools-testnet.js (dry run, then --execute)
#   3. fund the pot and startGame
#   4. the real settler.js arms segment 1, the VRF word is delivered, it locks
#   5. solvency-watch.js reads the new game and must report OK
#
# MODE=fork  (default; the GitHub Actions workflow) anvil forks Arbitrum Sepolia
#            from FORK_URL: canonical WETH9 and tokens, the live VRF v2.5
#            coordinator. The new entropy joins the live testnet subscription
#            (its owner is impersonated) and requests a real draw; anvil has no
#            oracle, so the word is delivered by impersonating the coordinator.
# MODE=local a plain anvil at chain id 421614 with mock tokens and a mock
#            coordinator, for running the same script where Arbitrum RPCs are
#            unreachable.
#
# Every key is an anvil dev key; nothing here touches a real chain or a real key.
# The keepers read config.js, so they run from a scratch copy pointed at the new
# contracts; the repo's own config.js is never edited.
#
# Env: MODE, FORK_URL (fork mode), FORGE_FLAGS (extra forge flags, e.g. --offline),
#      WORK_DIR (scratch, default a temp dir), PORT (default 8545)
set -euo pipefail

MODE=${MODE:-fork}
PORT=${PORT:-8545}
R=http://127.0.0.1:$PORT
REPO=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK_DIR:-$(mktemp -d)}
FORGE_FLAGS=${FORGE_FLAGS:-}
mkdir -p "$WORK"
step() { echo; echo "=== $*"; }
fail() { echo "REHEARSAL FAILED: $*" >&2; exit 1; }
cfg()  { grep -oE "^  $1: +\"0x[0-9a-fA-F]{40}\"" "$REPO/config.js" | head -1 | grep -oE '0x[0-9a-fA-F]{40}'; }
num()  { awk '{print $1}'; }

step "1. anvil ($MODE)"
if [ "$MODE" = fork ]; then
  [ -n "${FORK_URL:-}" ] || fail "FORK_URL is required in fork mode"
  anvil --port "$PORT" --fork-url "$FORK_URL" > "$WORK/anvil.log" 2>&1 &
else
  anvil --port "$PORT" --chain-id 421614 > "$WORK/anvil.log" 2>&1 &
fi
ANVIL=$!; trap 'kill $ANVIL 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do cast chain-id --rpc-url $R >/dev/null 2>&1 && break; sleep 1; done
[ "$(cast chain-id --rpc-url $R)" = 421614 ] || fail "chain id is not 421614"
mapfile -t KEYS < <(grep -oE '0x[0-9a-f]{64}' "$WORK/anvil.log" | head -5)
addr() { cast wallet address --private-key "$1"; }
FUNDER_KEY=${KEYS[0]}; OWNER_KEY=${KEYS[1]}; SETTLER_KEY=${KEYS[2]}
OWNER=$(addr "$OWNER_KEY"); SETTLER=$(addr "$SETTLER_KEY")
START=$(cast block-number --rpc-url $R)   # log queries start here, never at genesis on a fork
echo "chain 421614, block $START, owner $OWNER, settler $SETTLER"
send() { cast send "$@" --rpc-url $R --private-key "$OWNER_KEY" > /dev/null; }
as()   { local who=$1; shift; cast rpc anvil_impersonateAccount "$who" --rpc-url $R >/dev/null
         cast rpc anvil_setBalance "$who" 0x56BC75E2D63100000 --rpc-url $R >/dev/null
         cast send "$@" --from "$who" --unlocked --rpc-url $R >/dev/null; }

step "2. tokens and VRF settings"
cd "$REPO"
if [ "$MODE" = fork ]; then
  WETH=$(cfg WETH); USDC=$(cfg USDC); USDT=$(cfg USDT); LINK=$(cfg LINK); DAPP=$(cfg DAPP)
  LIVE_ENTROPY=$(cfg PrizeVRFEntropy)
  COORD=$(cast call "$LIVE_ENTROPY" "coordinator()(address)" --rpc-url $R)
  KEY_HASH=$(cast call "$LIVE_ENTROPY" "keyHash()(bytes32)" --rpc-url $R)
  SUB_ID=$(cast call "$LIVE_ENTROPY" "subId()(uint256)" --rpc-url $R | num)
  CONFS=$(cast call "$LIVE_ENTROPY" "requestConfirmations()(uint16)" --rpc-url $R | num)
  CB_GAS=$(cast call "$LIVE_ENTROPY" "callbackGasLimit()(uint32)" --rpc-url $R | num)
  EXTRA=$(cast call "$LIVE_ENTROPY" "extraArgs()(bytes)" --rpc-url $R)
  SUB_OWNER=$(cast call "$COORD" "getSubscription(uint256)(uint96,uint96,uint64,address,address[])" "$SUB_ID" --rpc-url $R | sed -n 4p)
  echo "live coordinator $COORD, subscription owner $SUB_OWNER, confirmations $CONFS, callback gas $CB_GAS"
  # The Arbitrum coordinator reads ArbSys.arbBlockNumber() (0x64) when a draw is
  # requested; anvil has no Arbitrum precompiles. Stub ArbSys to return
  # block.number for any call, and ArbGasInfo (0x6C) to return zero.
  cast rpc anvil_setCode 0x0000000000000000000000000000000000000064 0x4360005260206000f3 --rpc-url $R >/dev/null
  cast rpc anvil_setCode 0x000000000000000000000000000000000000006C 0x60206000f3 --rpc-url $R >/dev/null
else
  mk() { forge create $FORGE_FLAGS "tests/DeployScript.t.sol:$1" --rpc-url $R --private-key "$FUNDER_KEY" --broadcast ${2:+--constructor-args $2} 2>&1 | awk '/Deployed to/{print $3}'; }
  WETH=$(mk DeployERC20 WETH); USDC=$(mk DeployERC20 USDC); USDT=$(mk DeployERC20 USDT)
  LINK=$(mk DeployERC20 LINK); DAPP=$(mk DeployERC20 DAPP); COORD=$(mk DeployCoordinator)
  KEY_HASH=0x$(printf '%064x' 1); SUB_ID=7; CONFS=3; CB_GAS=200000; EXTRA=0x01
  echo "mock tokens and coordinator $COORD"
fi
[ -n "$WETH" ] && [ -n "$COORD" ] || fail "token or coordinator address missing"

step "3. Deploy.s.sol (simulate, then broadcast)"
export DEPLOYER_PRIVATE_KEY=$OWNER_KEY TREASURY_ADDRESS=$OWNER PROTOCOL_SINK_ADDRESS=$OWNER
export SETTLER_ADDRESS=$SETTLER FAUCET_DISPATCHER=$(addr "${KEYS[3]}") FAUCET_GUARDIAN=$(addr "${KEYS[4]}")
export WETH_ADDRESS=$WETH USDC_ADDRESS=$USDC USDT_ADDRESS=$USDT LINK_ADDRESS=$LINK DAPP_ADDRESS=$DAPP
export VRF_COORDINATOR=$COORD VRF_KEY_HASH=$KEY_HASH VRF_SUB_ID=$SUB_ID VRF_EXTRA_ARGS=$EXTRA
export VRF_CONFIRMATIONS=$CONFS VRF_CALLBACK_GAS=$CB_GAS
export ENTRY_COST_TIMBS=100000000000000000000 INITIAL_SUPPLY=1000000000000000000000000
export TIMBS_ENTRY_FLOOR=500000000000000000000 TIMBS_STEP=100000000000000000000
export REWARD_RATE_PER_SEC=1000000000000000 FARM_REWARD_RATE=1000000000000000 YIELD_APR_BPS=10000
export FAUCET_DRIP_ETH=10000000000000 FAUCET_POT_ETH=10000000000000 FAUCET_TIMBS_PER_CLAIM=100000000000000000000
export FAUCET_COOLDOWN=86400 FAUCET_ETH_CAP=1500000000000000000 FAUCET_TIMBS_CAP=1000000000000000000000000
forge script scripts/Deploy.s.sol $FORGE_FLAGS --rpc-url $R > "$WORK/simulate.log" 2>&1 || { tail -20 "$WORK/simulate.log"; fail "simulation"; }
forge script scripts/Deploy.s.sol $FORGE_FLAGS --rpc-url $R --broadcast --slow > "$WORK/deploy.log" 2>&1 || { tail -20 "$WORK/deploy.log"; fail "broadcast"; }
grep -q "TESTNET DEPLOY COMPLETE" "$WORK/deploy.log" || fail "the read-back did not complete"
get() { grep -E "^ *$1: " "$WORK/deploy.log" | head -1 | awk '{print $NF}'; }
TIMBS=$(get TIMBSToken); ROUTER=$(get TimbSwapRouter); FACTORY=$(get TimbSwapFactory)
PRIZE=$(get TimbPrize); REG=$(get GameRegistry); ENTROPY=$(get PrizeVRFEntropy)
echo "deployed and read back: prize $PRIZE, entropy $ENTROPY, router $ROUTER"

if [ "$MODE" = fork ]; then
  as "$SUB_OWNER" "$COORD" "addConsumer(uint256,address)" "$SUB_ID" "$ENTROPY"
  echo "new entropy added as a consumer of the live subscription"
fi

step "4. keepers' config: a scratch copy pointed at the new contracts"
W=$WORK/keepers; rm -rf "$W"; mkdir -p "$W"
cp "$REPO/config.js" "$W/config.js"; cp -r "$REPO/scripts" "$W/scripts"
rm -rf "$W/scripts/node_modules"; ln -s "$REPO/scripts/node_modules" "$W/scripts/node_modules"
for kv in TIMBSToken=$TIMBS WETH=$WETH USDC=$USDC USDT=$USDT LINK=$LINK DAPP=$DAPP TimbSwapRouter=$ROUTER \
          TimbSwapFactory=$FACTORY TimbPrize=$PRIZE GameRegistry=$REG PrizeVRFEntropy=$ENTROPY \
          PrizeEscrow=$(get PrizeEscrow) TimbYieldVault=$(get TimbYieldVault) GasFaucet=$(get GasFaucet) \
          TimbStaking=$(get TimbStaking) TimbFarm=$(get TimbFarm) TimbBoostFarm=$(get TimbBoostFarm) \
          TimbLockVault=$(get TimbLockVault) TimbTreasury=$(get TimbTreasury); do
  k=${kv%%=*}; v=${kv#*=}; sed -i -E "0,/^(  $k: +\")0x[0-9a-fA-F]{40}/s//\1$v/" "$W/config.js"
done

step "5. seed TIMBS/WETH with seed-pools-testnet.js"
cd "$W/scripts"
export SEED_RPC=$R SEED_PAIRS=TIMBS/WETH SEED_USD_PER_SIDE=500 SEED_PRICE_TIMBS=0.05
SEED_FROM=$OWNER node seed-pools-testnet.js > "$WORK/seed-dry.log" 2>&1 || { cat "$WORK/seed-dry.log"; fail "seed dry run"; }
if [ "$MODE" = fork ]; then SEED_ARGS="--execute --wrap"; else SEED_ARGS="--execute"
  cast send "$WETH" "mint(address,uint256)" "$OWNER" 1000000000000000000 --rpc-url $R --private-key "$FUNDER_KEY" >/dev/null; fi
SEED_PRIVATE_KEY=$OWNER_KEY node seed-pools-testnet.js $SEED_ARGS > "$WORK/seed.log" 2>&1 || { cat "$WORK/seed.log"; fail "seeding"; }
grep -E "wrap|✓ pair" "$WORK/seed.log"

step "6. fund the pot, startGame"
send "$PRIZE" "fundPot()" --value 0.1ether
send "$PRIZE" "startGame()"
[ "$(cast call "$PRIZE" 'gameStarted()(bool)' --rpc-url $R)" = true ] || fail "game did not start"
echo "round $(cast call "$PRIZE" 'currentRound()(uint256)' --rpc-url $R | num), segment $(cast call "$PRIZE" 'currentSegment()(uint256)' --rpc-url $R | num)"

step "7. settler.js arms and locks segment 1"
LEFT=$(cast call "$PRIZE" 'timeRemainingInSegment()(uint256)' --rpc-url $R | num)
cast rpc evm_increaseTime $((LEFT + 5)) --rpc-url $R >/dev/null; cast rpc evm_mine --rpc-url $R >/dev/null
( ARB_SEPOLIA_RPC=$R SETTLER_PRIVATE_KEY=$SETTLER_KEY SETTLER_LINGER_MINUTES=3 SETTLER_VRF_POLL_SECONDS=2 \
  TELEGRAM_OPS_MODE=off node settler.js > "$WORK/settler.log" 2>&1 ) &
SETTLER_PID=$!
REQ=""
for _ in $(seq 1 90); do
  REQ=$(cast logs --from-block "$START" --address "$ENTROPY" "DrawRequested(bytes32 indexed,uint256 indexed,bool)" --rpc-url $R --json 2>/dev/null \
        | python3 -c "import json,sys; l=json.loads(sys.stdin.read() or '[]'); print(int(l[-1]['topics'][2],16) if l else '')" 2>/dev/null || true)
  [ -n "$REQ" ] && break; sleep 2
done
[ -n "$REQ" ] || { kill $SETTLER_PID 2>/dev/null || true; cat "$WORK/settler.log"; fail "settler never armed the segment"; }
echo "settler armed segment 1: VRF request $REQ"
WORD=$(cast to-dec "$(cast keccak rehearsal)")
as "$COORD" "$ENTROPY" "rawFulfillRandomWords(uint256,uint256[])" "$REQ" "[$WORD]"
echo "word delivered as the coordinator"
wait $SETTLER_PID || { cat "$WORK/settler.log"; fail "settler exited non-zero"; }
grep -E "Armed|Locking|settled|Settled" "$WORK/settler.log" | head -5
SEG=$(cast call "$PRIZE" 'currentSegment()(uint256)' --rpc-url $R | num)
[ "$SEG" = 2 ] || fail "segment is $SEG after the settler run, expected 2"

step "8. solvency-watch.js on the new game"
WATCH_RPC=$R WATCH_PRIZE=$PRIZE node solvency-watch.js --dry-run > "$WORK/watch.log" 2>&1 || { cat "$WORK/watch.log"; fail "solvency watch"; }
grep -E "registry|escrow|solvency OK" "$WORK/watch.log"

step "9. wind-down-inventory.js reads the new game"
# Give the LP split something to find: 30% of the owner's TIMBS/WETH LP staked
# in the farm (team staked), 10% sent to a stranger (everyone else).
FARM=$(get TimbFarm); PAIR=$(cast call "$FACTORY" "getPair(address,address)(address)" "$TIMBS" "$WETH" --rpc-url $R)
LP=$(cast call "$PAIR" "balanceOf(address)(uint256)" "$OWNER" --rpc-url $R | num)
STAKE=$(python3 -c "print($LP * 3 // 10)"); GIFT=$(python3 -c "print($LP // 10)")
send "$PAIR" "approve(address,uint256)" "$FARM" "$STAKE"; send "$FARM" "stake(uint256)" "$STAKE"
send "$PAIR" "transfer(address,uint256)" 0x000000000000000000000000000000000000bEEF "$GIFT"
INVENTORY_RPC=$R INVENTORY_OWNER=$OWNER node wind-down-inventory.js > "$WORK/inventory.log" 2>&1 || { cat "$WORK/inventory.log"; fail "inventory"; }
grep -q "TimbPrize | $(echo "$OWNER" | cut -c1-6)" "$WORK/inventory.log" || { cat "$WORK/inventory.log"; fail "inventory did not find the owner on the prize"; }
grep -qE "^\| (TIMBS \(old\)/WETH|WETH/TIMBS \(old\)) \|[^|]*\| (59\.99|60\.00)% \| (29\.99|30\.00)% \|[^|]*\| (9\.99|10\.00)% \|" "$WORK/inventory.log" \
  || { cat "$WORK/inventory.log"; fail "inventory did not split the seeded pool's LP 60 direct / 30 staked / 10 others"; }
grep -qE "^\| $(echo "$OWNER" | cut -c1-6)…[0-9a-fA-F]{4} \| (TIMBS \(old\)/WETH|WETH/TIMBS \(old\)) \| TimbFarm \|" "$WORK/inventory.log" \
  || { cat "$WORK/inventory.log"; fail "inventory did not list the owner's farm-staked LP by wallet"; }
grep -qE "^\| $(echo "$OWNER" | cut -c1-6)…[0-9a-fA-F]{4} \| (TIMBS \(old\)/WETH|WETH/TIMBS \(old\)) \| in wallet \|" "$WORK/inventory.log" \
  || { cat "$WORK/inventory.log"; fail "inventory did not list the owner's wallet LP by wallet"; }
sed -n '/## 4/,$p' "$WORK/inventory.log"

step "10. wind-down-owner.js: dry run sends nothing, run sweeps to the recipient"
# Something for every step: ETH and LP in the treasury, ETH in the vault.
TREASURY=$(get TimbTreasury); VAULT=$(get TimbYieldVault); SINK=0x000000000000000000000000000000000000c0DE
send "$TREASURY" --value 0.05ether; send "$VAULT" --value 0.02ether
send "$PAIR" "transfer(address,uint256)" "$TREASURY" "$GIFT"
export WIND_DOWN_RPC=$R WIND_DOWN_PRIVATE_KEY=$OWNER_KEY WIND_DOWN_TO=$SINK WIND_DOWN_FORCE_RETIRE=1
node wind-down-owner.js > "$WORK/winddown-dry.log" 2>&1 || { cat "$WORK/winddown-dry.log"; fail "wind-down dry run"; }
[ "$(cast balance "$SINK" --rpc-url $R)" = 0 ] || fail "the dry run moved ETH"
node wind-down-owner.js --execute > "$WORK/winddown.log" 2>&1 || { cat "$WORK/winddown.log"; fail "wind-down run"; }
grep -E "^- (sent|SKIP|FAIL|note)" "$WORK/winddown.log"
[ "$(cast balance "$SINK" --rpc-url $R)" = 70000000000000000 ] || fail "recipient did not get the treasury's 0.05 + the vault's 0.02 ETH"
[ "$(cast call "$PAIR" "balanceOf(address)(uint256)" "$SINK" --rpc-url $R | num)" = "$GIFT" ] || fail "recipient did not get the treasury's LP"
[ "$(cast call "$PRIZE" "entriesPaused()(bool)" --rpc-url $R)" = true ] || fail "entries not paused"
[ "$(cast call "$PRIZE" "retired()(bool)" --rpc-url $R)" = true ] || fail "prize not retired"
unset WIND_DOWN_RPC WIND_DOWN_PRIVATE_KEY WIND_DOWN_TO WIND_DOWN_FORCE_RETIRE

step "11. wind-down-lp.js: the owner's wallet and farm-staked LP come out to the recipient"
SINK2=0x000000000000000000000000000000000000c0DF
LP_BEFORE=$(cast call "$PAIR" "balanceOf(address)(uint256)" "$OWNER" --rpc-url $R | num)
export WIND_DOWN_RPC=$R WIND_DOWN_LP_PRIVATE_KEY=$OWNER_KEY WIND_DOWN_TO=$SINK2
node wind-down-lp.js > "$WORK/lpexit-dry.log" 2>&1 || { cat "$WORK/lpexit-dry.log"; fail "LP exit dry run"; }
[ "$(cast call "$PAIR" "balanceOf(address)(uint256)" "$OWNER" --rpc-url $R | num)" = "$LP_BEFORE" ] || fail "the LP dry run moved LP"
grep -q "TimbFarm.emergencyWithdraw()" "$WORK/lpexit-dry.log" || { cat "$WORK/lpexit-dry.log"; fail "LP dry run did not plan the farm exit"; }
# Like the leaked wallet: almost no ETH, so the run must top up its gas first.
cast rpc anvil_setBalance "$OWNER" 0x5AF3107A4000 --rpc-url $R >/dev/null   # 0.0001 ETH
WIND_DOWN_LP_GAS_KEY=$FUNDER_KEY node wind-down-lp.js --execute > "$WORK/lpexit.log" 2>&1 || { cat "$WORK/lpexit.log"; fail "LP exit run"; }
grep -q "^- sent gas " "$WORK/lpexit.log" || { cat "$WORK/lpexit.log"; fail "LP exit did not top up the signer's gas"; }
grep -E "^- (sent|SKIP|FAIL|note)" "$WORK/lpexit.log"
[ "$(cast call "$FARM" "stakedBalance(address)(uint256)" "$OWNER" --rpc-url $R | num)" = 0 ] || fail "LP still staked in the farm"
[ "$(cast call "$PAIR" "balanceOf(address)(uint256)" "$OWNER" --rpc-url $R | num)" = 0 ] || fail "LP still in the owner's wallet"
[ "$(cast call "$WETH" "balanceOf(address)(uint256)" "$SINK2" --rpc-url $R | num)" != 0 ] || fail "recipient got no WETH"
[ "$(cast call "$TIMBS" "balanceOf(address)(uint256)" "$SINK2" --rpc-url $R | num)" != 0 ] || fail "recipient got no TIMBS"
unset WIND_DOWN_RPC WIND_DOWN_LP_PRIVATE_KEY WIND_DOWN_TO

echo; echo "REHEARSAL PASSED ($MODE): deploy, seed, startGame, settle one segment, solvency OK, inventory OK, wind-down OK, LP exit OK"
