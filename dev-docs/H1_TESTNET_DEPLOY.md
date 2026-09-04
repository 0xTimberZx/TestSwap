# H1 prize-VRF migration — testnet deploy runbook

Brings the on-chain prize up to the H1 code: swaps the deployed pre-H1 prize for
a new VRF-backed `TimbPrize` + a dedicated `VRFEntropy`, reusing everything else
(TIMBS, AMM, farms, GameRegistry, PrizeEscrow). The settler already expects this;
until it's done, every settle reverts.

Targeted swap via `scripts/DeployPrizeVRFMigration.s.sol`. Generation-safe: the
new prize's `startGame()` bumps the registry generation, so the old game's
tickets retire cleanly (reclaimable via `reclaimFromPastGame`) and rounds restart
at 1.

> Prereq: the Settler workflow should be **disabled** (Actions → TimbSwap Settler
> → ⋯ → Disable) until step 6, so it isn't reverting against a half-migrated state.

## 1. Create + note a Chainlink VRF v2.5 subscription (Arbitrum Sepolia)
- Go to https://vrf.chain.link (Arbitrum Sepolia), create a subscription, note the
  **subscription id**.
- From Chainlink's "Supported Networks" page grab the Arbitrum Sepolia **VRF v2.5
  coordinator address** and a **key hash** (gas lane).
- Decide LINK vs native payment → that's the `extraArgs` blob (build with
  `VRFV2PlusClient._argsToBytes`; native-payment blob is
  `0x92fd13380000000000000000000000000000000000000000000000000000000000000001`).
  - ⚠️ **On a RE-migration (a new entropy replacing a working one), do NOT re-encode
    this — copy the live entropy's `extraArgs()` verbatim.** The deployed Arbitrum
    Sepolia coordinator rejected the canonical 36-byte `_argsToBytes` output with an
    empty-data revert on the gen-3 cutover; the entropy that works carries a
    non-canonical 37-byte value and byte-identical is what's accepted. Full write-up
    in `GEN3_MIGRATION.md` (the extraArgs gotcha).
- Fund the subscription (LINK or native ETH).

You'll add the new entropy as a *consumer* in step 4 (its address doesn't exist
until the deploy).

## 2. Env (.env — never commit)
```
DEPLOYER_PRIVATE_KEY=0x…        # current owner of the contracts below
ARB_SEPOLIA_RPC=https://…

# existing addresses — copy from config.js
GAME_REGISTRY_ADDR=0x…          # ADDRESSES.GameRegistry
PRIZE_ESCROW_ADDR=0x…           # ADDRESSES.PrizeEscrow
ROUTER_ADDR=0x…                 # ADDRESSES.TimbSwapRouter
ELIGIBLE_REGISTRY_ADDR=0x…      # ADDRESSES.EligibleTokenRegistry

# VRF (from step 1)
VRF_COORDINATOR=0x…
VRF_KEY_HASH=0x…
VRF_SUB_ID=…
VRF_EXTRA_ARGS=0x…              # the LINK/native blob
# VRF_CONFIRMATIONS=3           # optional
# VRF_CALLBACK_GAS=200000       # optional
```

## 3. Deploy + re-wire
```
forge script scripts/DeployPrizeVRFMigration.s.sol \
  --rpc-url $ARB_SEPOLIA_RPC --broadcast -vvvv
```
The script deploys the new `TimbPrize` + `VRFEntropy`, wires entropy both ways,
points the new prize at the eligible registry, and re-points registry / escrow /
router / eligible-registry at the new prize. **Copy the two logged addresses.**

## 4. Add the consumer + fund
- On the VRF subscription, **add the new `VRFEntropy` address as a consumer**.
- Confirm the sub is funded.

## 5. config.js
- Set `ADDRESSES.TimbPrize` to the **new** prize address.
- Record the prize `VRFEntropy` address (add an `ADDRESSES.PrizeVRFEntropy` entry
  for reference; the settler reads the entropy off the prize, so it's not
  strictly required by the keeper).
- Commit config.js (frontend + settler both read it).

## 6. Open the game + re-enable the keeper
- Call `TimbPrize.startGame()` on the **new** prize (owner tx). This bumps the
  registry to the next generation and opens round 1. It needs the entropy wired
  (done in step 3) — VRF is only pulled once a segment settles, so the funded sub
  from step 4 must be in place before the first settle.
- **Re-enable** the Settler workflow (Actions → TimbSwap Settler → Enable). With
  PR #338's `success()`-gated self-chain, a transient failure can no longer
  hammer-loop.

## 7. Verify
- `TimbPrize.entropy()` → the new VRFEntropy (non-zero).
- Watch one settle cycle: `SegmentArmed` on the first due segment, then a lock
  after the VRF callback. The settler logs `Armed segment …` then `Segment …
  settled`.
- Old-generation tickets: holders reclaim principal via `reclaimFromPastGame`.

## Notes
- Owners are still the deployer on testnet (the M1/M3/M6 timelock handoff is a
  separate, post-verify step), so the deployer can run all the re-point setters.
- The segment-1 match + reclaim reminder workers pick up the new prize/registry
  automatically (they read addresses from config.js).
