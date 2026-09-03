# Gen-3 Migration — align the prize game (permissionless activation)

## Why

The live `GameRegistry` (`0xBAb1CB…`) is an older compile whose
`activateRoundEntries` is `onlyTimbPrize`. The live `TimbPrize` (`0x5AED…`) is
the H2 **keeper-driven** version — it only self-activates round 1 in
`startGame()` and delegates every later round's activation to a permissionless
keeper. Those two designs disagree: the keeper's `activateRoundEntries` call
reverts `NotTimbPrize()` (`0x3e94dce9`), and `TimbPrize` never makes the call —
so **no entry is ever activated past round 1** and every ticket sticks
`Pending`.

Confirmed on-chain (eth_call): `activateRoundEntries(round, [player])` reverts
`NotTimbPrize` from any EOA and succeeds only when called from `TimbPrize`.

The repo's current `contracts/GameRegistry.sol` already fixes this —
`activateRoundEntries` is `external`, gated only by `round == currentRound`, with
a try/catch-fenced vault call. This migration deploys that registry plus a
matching fresh prize so the keeper-driven design and the registry finally agree.

`TimbPrize.gameRegistry` is set at construction and the live prize is already
started (round 5), so it can't re-run `startGame()` to initialise a fresh
registry — hence a fresh prize, not a registry-only swap.

## What it deploys vs reuses

**New:** `GameRegistry`, `TimbPrize`, Prize `VRFEntropy`.

**Reused + repointed:** `PrizeEscrow`, `TimbSwapRouter`, `EligibleTokenRegistry`,
`TimbYieldVault` (its ETH reserve is kept). TIMBS, the AMM/factory, farms, and
staking are untouched.

## Prerequisites

- Deployer key = current owner of the reused contracts.
- The `PROTOCOL_SINK_ADDR` **must match the current sink** so lapsed-revenue
  routing is unchanged. Read it off the old registry:
  ```
  cast call 0xBAb1CBaF0dE094322A49B379d0AC4510D1F78530 "protocolSink()(address)" --rpc-url $ARB_SEPOLIA_RPC
  ```
- VRF v2.5 params (coordinator, key hash, sub id, extraArgs) — same values used
  for the H1 migration (see `dev-docs/H1_TESTNET_DEPLOY.md`).

## `.env` (never commit)

```
DEPLOYER_PRIVATE_KEY=0x...
TIMBS_TOKEN_ADDR=0x2Aaa61E2c08Ff61c93E960EcCd5Dd7fedF0bfaAa
PROTOCOL_SINK_ADDR=0x...            # from the cast call above
PRIZE_ESCROW_ADDR=0x865C50d933e63BbE388EEAFa017AE634B0A6fB6D
ROUTER_ADDR=0x40C7Caf90817C9891D278Ec1400B9deb180911f1
ELIGIBLE_REGISTRY_ADDR=0xbFF59a3408B2574AcE948F130f0fA2f2CB149F04
YIELD_VAULT_ADDR=0x43D833e828e2AF951527C2b573Eb70c358FfEB0B
SETTLER_ADDR=0x...                  # keeper EOA (SETTLER_PRIVATE_KEY's address)
VRF_COORDINATOR=0x...
VRF_KEY_HASH=0x...
VRF_SUB_ID=...
VRF_EXTRA_ARGS=0x...
# VRF_CONFIRMATIONS / VRF_CALLBACK_GAS optional
```

## Run

```
forge script scripts/DeployGen3Migration.s.sol \
  --rpc-url $ARB_SEPOLIA_RPC --broadcast -vvvv
```

It deploys and wires everything in one broadcast, then prints the three new
addresses. `startGame()` is intentionally **not** called yet.

## After the deploy

1. **VRF:** add the printed Prize `VRFEntropy` as a consumer on the VRF
   subscription, and make sure it's funded.
2. **config.js:** update `ADDRESSES` — `GameRegistry`, `TimbPrize`, and
   `PrizeVRFEntropy` to the new addresses. (config.js loads fresh on every page,
   so it ships on the next Pages deploy.) Also update the notification workers /
   settler pull addresses from config.js automatically — no separate edit.
3. **Start the epoch:** call `TimbPrize.startGame()` (owner). This calls the new
   registry's `onGameStarted()` (fresh epoch, round 1) and self-activates round 1.
4. **Verify the fix:** let the settler run one round rollover, then confirm its
   log shows `activation catch-up … for round #N` **succeeding** (no
   `NotTimbPrize` / "unknown custom error"), and that a ticket set for the next
   round flips `Pending → Active` on `/compete/`.
5. **Vault stranded weight (optional cleanup):** the reused vault keys weight by
   raw ticket id with no generation namespace, so the fresh registry's ids can
   collide with old stranded weight. After cutover, audit and drain:
   ```
   node scripts/vault-weight.js            # audit
   node scripts/vault-weight.js --drain    # remove stranded ids (restores the pointer)
   ```
6. **Old tickets (user-reclaim only):** tickets in the OLD registry
   (`0xBAb1CB…`) hold their principal there and are not carried over. Holders
   reclaim from the old registry directly (Withdraw on a Pending ticket =
   `cancelEntry`; or `claimRefund` once expired). Testnet ETH, no monetary value.

## Rollback

Nothing destructive happens until step 2 (config cutover) and step 3
(`startGame`). Before that, the old prize/registry are still live and reads still
resolve against them — so a bad deploy can simply be discarded by not cutting
config over.
