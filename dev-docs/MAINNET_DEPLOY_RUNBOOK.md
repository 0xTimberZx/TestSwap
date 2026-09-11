# TimbSwap — Mainnet Deploy Runbook (Arbitrum One, 42161)

The single authoritative launch checklist. Two-phase deploy: the **DEX is the
native primitive and launches standalone first**; TIMBS + the prize game +
incentives are a **second deployment** that attaches to the live DEX. Behave as
if TIMBS/DAPP don't exist during phase 1.

> **Security.** The deployer key and all API keys live only in `.env` / CI
> secrets — never committed, never pasted into chat. Claude does **not** run the
> deploy (no keys, sandbox is firewalled from RPC): every `forge`/`cast` command
> below is **yours to run**. Verify every address you paste between phases.

Audit status: all coded items remediated — see `PRE_MAINNET_AUDIT.md`. Contracts
are on the official repo `main` (CI green). Fund-flow reference: `FUND_FLOWS.md`.

---

## 0. Pre-flight

- [ ] Official repo `main` is at the intended commit; `contracts.yml` CI green.
- [ ] Contracts verified to build locally: `forge build --sizes` and `forge test`.
- [ ] Decisions locked: double-letters OFF (governance toggle); governance =
      off-chain signaling; FoT/rebasing = unsupported (documented).
- [ ] Gnosis **Safe / multisig** deployed on Arbitrum One (`GOV_MULTISIG`).
- [ ] Timelock delay chosen (`TIMELOCK_MIN_DELAY`, default 48h).
- [ ] Chainlink **VRF v2.5** subscription created + funded (LINK or native);
      note `VRF_COORDINATOR`, `VRF_KEY_HASH`, `VRF_SUB_ID`, `VRF_EXTRA_ARGS`.
- [ ] Canonical `WETH_ADDRESS` (Arbitrum One), `DAPP_TOKEN_ADDRESS`,
      `LINK_TOKEN_ADDRESS` on hand.
- [ ] Deployer wallet funded with ETH for gas; `TREASURY_ADDRESS` +
      `PROTOCOL_SINK_ADDRESS` set.
- [ ] Sourcify (or Arbiscan) verification tooling ready.
- [ ] Keeper infra ready for: `settleSegment` (liveness backstop),
      `activateRoundEntries` / `onRoundSettled` (chunked), and — before buybacks —
      `treasury.updateTwap()`.

---

## 1. Phase 1 — DeployCore (standalone DEX)

`.env` (phase 1): `DEPLOYER_PRIVATE_KEY`, `TREASURY_ADDRESS`, `WETH_ADDRESS`.

```
forge script scripts/DeployCore.s.sol \
  --rpc-url $ARB_RPC --broadcast --verify --verifier sourcify -vvvv
```

- [ ] Record from the output: **`FACTORY_ADDRESS`**, **`ROUTER_ADDRESS`**.
- [ ] Sanity: `cast call $ROUTER "weth()(address)"` == WETH (immutable);
      `factory.router()` == ROUTER. ETH swaps work now (no `setWeth` needed).
- [ ] (Optional) Let the standalone DEX run / be tested before phase 2. It has no
      dependency on TIMBS or the game; the router's game hooks are no-ops until
      phase 2 sets them.

---

## 2. Phase 2 — DeployGame (TIMBS + game + incentives)

Run under the **same `DEPLOYER_PRIVATE_KEY` as phase 1** (it calls owner-only
setters on the phase-1 factory/router).

`.env` (phase 2): the phase-1 vars **plus** `FACTORY_ADDRESS`, `ROUTER_ADDRESS`,
`PROTOCOL_SINK_ADDRESS`, `DAPP_TOKEN_ADDRESS`, `LINK_TOKEN_ADDRESS`,
`VRF_COORDINATOR`, `VRF_KEY_HASH`, `VRF_SUB_ID`, `VRF_EXTRA_ARGS`,
`VRF_CONFIRMATIONS`(opt), `VRF_CALLBACK_GAS`(opt), `GOV_MULTISIG`,
`TIMELOCK_MIN_DELAY`(opt), `ENTRY_COST_TIMBS`, `INITIAL_SUPPLY`,
`REWARD_RATE_PER_SEC`, `FARM_REWARD_RATE`, `PROPOSAL_THRESHOLD`, `QUORUM_BPS`,
`VOTING_PERIOD`, `VOTING_DELAY`, `VAULT_RATE_PER_SEC1E18`(opt).

```
forge script scripts/DeployGame.s.sol \
  --rpc-url $ARB_RPC --broadcast --verify --verifier sourcify -vvvv
```

- [ ] Record all printed addresses: TIMBS, PrizeEscrow, EligibleRegistry,
      GameRegistry, TimbPrize, Prize VRFEntropy, TimbYieldVault, Staking, Farm,
      LockVault, Treasury, Governance, Timelock, TIMBS/WETH pair.
- [ ] The script wires everything, incl. the vault BOTH directions
      (`vault.setGameRegistry` + `vault.setTimbPrize`, and
      `gameRegistry.setYieldVault` + `timbPrize.setYieldVault`) — the gap that
      starved the pot on testnet.

---

## 3. Fund / seed (post-deploy)

- [ ] Verify all phase-2 contracts on Sourcify/Arbiscan.
- [ ] Transfer initial TIMBS allocations from the treasury wallet.
- [ ] Add liquidity to the TIMBS/WETH pair (sets the launch price).
- [ ] `TimbStaking.notifyRewardAmount(amount, duration)` and
      `TimbFarm.notifyRewardAmount(...)` — fund reward periods. (Reward-solvency
      assert now requires the contract to actually hold the rewards first.)
- [ ] Seed `PrizeEscrow` with the initial ETH pot.
- [ ] Fund the yield vault: `TimbYieldVault.fund{value:}()`; set the rate via
      `VAULT_RATE_PER_SEC1E18` at deploy or `setRatePerSecond` / `setYieldAPRBps`.
- [ ] Add **Prize VRFEntropy** as a consumer on the VRF subscription and confirm
      the sub is funded — BEFORE `startGame` (segments arm via VRF).

---

## 4. Verify the wiring matrix on-chain (do this BEFORE startGame)

Every silent cross-contract call depends on these pointers. Read each with
`cast call` and confirm it equals the phase-2 address. (These are also now
backed by observability events if they're ever wrong — see `PRE_MAINNET_AUDIT.md`.)

| Read | Expect |
|---|---|
| `GameRegistry.timbPrize()` | TimbPrize |
| `GameRegistry.yieldVault()` | TimbYieldVault |
| `TimbPrize.gameRegistry()` | GameRegistry |
| `TimbPrize.yieldVault()` | TimbYieldVault |
| `TimbPrize.prizeEscrow()` | PrizeEscrow |
| `TimbPrize.entropy()` | Prize VRFEntropy |
| `TimbPrize.eligibleRegistry()` | EligibleRegistry |
| `TimbPrize.router()` | Router |
| `TimbYieldVault.gameRegistry()` | GameRegistry |
| `TimbYieldVault.timbPrize()` | TimbPrize |
| `PrizeEscrow.timbPrize()` | TimbPrize |
| `VRFEntropy.board()` (prize entropy) | TimbPrize |
| `Router.timbPrize()` | TimbPrize |
| `Router.eligibleRegistry()` | EligibleRegistry |
| `Router.weth()` | WETH |
| `Factory.timbsToken()` | TIMBS |
| `Factory.router()` | Router |
| `Treasury.timbsEthPair()` / `timbStaking()` / `router()` | pair / Staking / Router |

- [ ] Any mismatch → fix with the one owner tx before proceeding.

---

## 5. Go live

- [ ] Frontend tested against the mainnet addresses (see §7).
- [ ] `TimbPrize.startGame()` — begins round #1.
- [ ] Confirm segment 1 arms (a `SegmentArmed` event) and the VRF callback lands.

---

## 6. Governance handoff (after full verification)

Set ops params FIRST (while the deployer still owns things):
- [ ] `Treasury.setBuybackMaxEth(...)`, `setBuybackMaxDeviationBps(...)` (default 3%).
- [ ] `Treasury` operator + operator ETH cap for routine ops (if used).
- [ ] `TimbPrize.setSettler(keeper)` if a dedicated settler is used.

Then hand every `Ownable2Step` contract to the timelock — TIMBS, Staking, Farm,
Governance, TimbPrize, PrizeEscrow, YieldVault, EligibleRegistry, Router, Factory,
LockVault, GameRegistry, Treasury:
- [ ] From the deployer: `contract.transferOwnership(timelock)` for each.
- [ ] Via a timelock proposal from the multisig: `contract.acceptOwnership()` for
      each (two-step — the timelock must accept; nothing transfers on step 1 alone).
- [ ] Verify `owner()` == timelock on each; confirm the deployer key retains no
      ownership anywhere.

> After handoff, every privileged action (pause, rate changes, `emergencyWithdraw`,
> the double-letters toggle, buyback params) is a multisig-proposed, delay-gated
> timelock action — which is the "delayed withdrawal" posture M3 asked for.

---

## 7. Frontend cutover (config.js + Pages)

- [ ] `config.js`: set the real mainnet contract addresses, `CHAIN_ID = 42161`,
      and the mainnet Cloudflare relay for `DEDICATED_RPC` + `telemetryUrl`.
- [ ] Rotate Alchemy + Supabase keys behind the Cloudflare worker (keys live in the
      worker/CI, never in the repo).
- [ ] "Testnet" → "Beta" prose + network badge (Arb One).
- [ ] Move the `timbswap.xyz` custom domain (CNAME) to the official repo's Pages at
      launch; add the required GitHub Actions secrets.
- [ ] DebugHub: point the SDK at the mainnet telemetry relay; add the mainnet tab.

---

## 8. Ops & monitoring (post-launch)

- [ ] Keepers running: `settleSegment` (backstop), `activateRoundEntries` /
      `onRoundSettled` (chunked), and `treasury.updateTwap()` before buybacks.
- [ ] Alert on the observability events (any of these = a wiring/keeper problem):
      `YieldHarvestFailed`, `YieldDepositFailed`, `WeightRegisterFailed`,
      `WeightRemoveFailed`, `PotShareForwardFailed`.
- [ ] Buybacks: only after `updateTwap` has a ≥30-min observation and
      `buybackMaxEth` is set; `minTimbsOut` must be > 0 (the TWAP floor is the real gate).
- [ ] Watch analytics: Pot Backing, the per-round carry (`PotCarried`), and
      `Yield → Pot` sweeps (confirms the vault→prize link is live on mainnet).
