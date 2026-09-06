# TimbSwap — Mainnet Beta Launch Checklist

An ordered runbook for taking TimbSwap from the Arbitrum Sepolia testnet to a
**mainnet beta**. Real ETH is involved from step 1 of "Deploy" onward — treat
every economic parameter and key as production.

> Cross-references: `ROUTER_REDEPLOY_CHECKLIST.md` (router), `GEN3_MIGRATION.md`
> (full stack migration pattern), `PRIZE_VRF_MIGRATION.md` (VRF), and the
> keeper scripts under `scripts/`.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done

---

## 0. Decisions to lock before any deploy

- [ ] **Target chain** — Arbitrum One (`42161`) unless decided otherwise. Record
      `CHAIN_ID`, `CHAIN_NAME`, public RPC(s), and explorer base URL.
- [ ] **Beta scope** — which surfaces ship (Swap, Farm, Compete, Analytics) and
      which stay gated (`nav-off`) for beta.
- [ ] **Economics sign-off** (real money now — these were loose on testnet):
  - [ ] Prize entry cost + floor (`compete` entry: `0.001 ETH` floor on testnet)
  - [ ] `freeNudgeCapPerSeg` (testnet 10) and `swapNudgeWeight` (testnet 3)
  - [ ] Yield vault APR (`setYieldAPRBps`) and `timbsWeight1e18`
  - [ ] Farm/staking emission rates + `periodFinish` funding cadence
  - [ ] Protocol fee (`PROTOCOL_FEE_BPS = 5`) and treasury buyback split
  - [ ] TIMBS initial distribution / LP seeding amounts
- [ ] **Segment/round timing** — testnet uses 1h segments / 6h rounds
      (`SEGMENT_DURATION`, `ROUND_DURATION`). Confirm for mainnet beta.

---

## 1. Contracts — deploy & wire (fresh addresses)

Deploy the full stack fresh; do **not** reuse testnet addresses. Follow the
gen-3 wiring order.

- [ ] Deploy tokens/core: `TIMBSToken`, `WETH` (use canonical mainnet WETH — do
      **not** deploy the test WETH), `TimbSwapFactory`, `TimbSwapRouter`
      (**from current source** — carries the free-nudge prize-namespacing fix),
      `EligibleTokenRegistry`.
- [ ] Deploy game: `GameRegistry`, `TimbPrize`, `PrizeVRFEntropy`,
      `TimbYieldVault`, `PrizeEscrow`.
- [ ] Deploy farms/vaults/treasury/gov: `TimbStaking`, `TimbFarm`,
      `TimbBoostFarm`, `TimbLockVault`, `TimbTreasury`, `TimbGovernance`.
- [ ] Deploy SwapTables segment tables (current generation).
- [ ] **Wire** (owner txs):
  - [ ] `Router.setTimbPrize`, `Router.weth`, `Router.setFreeNudgeCapPerSeg`,
        `Router.setSwapNudgeWeight`
  - [ ] `TimbPrize.setSettler`, `TimbPrize.setRouter`, VRF consumer wiring
  - [ ] `TimbYieldVault.setGameRegistry`, `setTimbPrize`, `setYieldAPRBps`,
        `setTimbsWeight1e18`, then `fund()`
  - [ ] `GameRegistry` ↔ prize/registry cross-refs; `setCurrentRound` start
  - [ ] Treasury/gov ownership + buyback config
- [ ] **Fund**: yield vault reserve, prize seed/pot, TIMBS/ETH LP, farm emission
      reserves, boost-farm epoch reserve.
- [ ] Verify all contracts on the mainnet explorer.
- [ ] Record every address in one place → feeds step 3.

---

## 2. Keepers & infra (the operational risks)

The game freezes if these stall (we saw exactly this on testnet). Each needs a
**funded hot wallet** and a **dispatch PAT** so a cron gap can't halt it.

- [ ] **Chainlink VRF v2.5 subscription on the mainnet chain**, funded with LINK,
      with `PrizeVRFEntropy` (and any per-segment consumer) added as a consumer.
      This is the single most likely thing to stall settlement (arm→lock) — set
      a LINK balance alarm.
- [ ] **Settler keeper** (`scripts/settler.js`, `.github/workflows/settler.yml`):
      `ARB_SEPOLIA_RPC`→mainnet RPC secret, funded `SETTLER_PRIVATE_KEY`,
      `SETTLER_DISPATCH_TOKEN` (fine-grained PAT, Actions R/W) so it self-chains.
- [ ] **Epoch distributor** (`epoch.yml`) — mainnet RPC + funded wallet + dispatch token.
- [ ] **Boost window** (`admin-boost-window.yml`) — same.
- [ ] **Match notifier / reclaim reminder** — mainnet RPC; Telegram creds.
- [ ] Decide the **faucet**'s fate: testnet-only. Disable `faucet.yml` + the
      `/faucet/` page for mainnet (no free ETH dispensing on mainnet).
- [ ] **Cloudflare Worker** (`workers/timbswap-api.js`): set `ALCHEMY_RPC_URL`
      secret to the **mainnet** keyed RPC. `SUPABASE_URL` /
      `SUPABASE_SERVICE_ROLE_KEY` unchanged. Confirm route + SSL Full.

---

## 3. Frontend config cutover (`config.js`)

- [ ] `CHAIN_ID`, `CHAIN_NAME`, `PUBLIC_RPCS`, explorer URL → mainnet.
- [ ] `DEDICATED_RPC` stays `https://timbswap.xyz/api/rpc` (Worker now points at
      mainnet upstream).
- [ ] All `ADDRESSES.*` → the step-1 mainnet deploys.
- [ ] `ETH_USD_PRICE` display value (or wire a real feed for mainnet).
- [ ] Remove/adjust testnet-only UI (faucet link, "Testnet" badge → "Beta").
- [ ] Bump cache tokens where non-timestamped (`farm.js`, `dh.js?v=`, CSS).

---

## 4. Telemetry / DebugHub (see the review notes)

- [ ] SDK 1.3.4 shipped (Brave provider-proxy fix — #391). Confirm SDK
      checkpoints land from Brave post-merge.
- [ ] **RLS**: `debughub_anon_select` is currently `USING true` (world-readable).
      Decide: lock reads to the hub's reader for mainnet, or accept a public
      debug feed. Wallet + error strings are exposed either way.
- [ ] **Abuse**: `/api/debughub_events` + anon insert are open writes (allowlist
      only, no rate limit). Add a Worker rate-limit and/or a table TTL/size cap.
- [ ] Point DebugHub `appName`/keys at the mainnet project if the hub is separated
      per environment; otherwise events from both envs share one table.

---

## 5. Pre-launch verification (mainnet, small amounts)

- [ ] Swap round-trip (approve + swap) signs and confirms in Brave + one mobile wallet.
- [ ] Stake / unstake / claim on Farm.
- [ ] Compete: buy a ticket, free-nudge (fresh router → cap resets per segment),
      swap-nudge, and let a segment settle (VRF arm→lock) end-to-end.
- [ ] Yield accrues to the pot; harvest at settlement.
- [ ] Reads populate with Brave Shields **up** at any tab count (Cloudflare path).
- [ ] Telemetry (SDK, not just raw) lands from Brave.
- [ ] Explorer links, OG images, custom domain, HTTPS redirect all correct.

---

## 6. Ops readiness

- [ ] Alarms: VRF LINK balance, settler/epoch wallet ETH balance, keeper run
      failures (workflow failure notifications), Cloudflare Worker error rate.
- [ ] Runbook for a stalled settlement (`rearmSegment` / VRF re-request).
- [ ] Owner keys: multisig or hardware wallet for owner-only functions; document
      who holds them.
- [ ] Rollback / pause plan (`whenNotPaused` levers, emergency withdraw scope).
- [ ] Comms: beta scope + known limitations published (e.g., account-switch on
      Brave needs a reload — the wallet-listener degrade).

---

## Known accepted items (not blockers)

- Account-switch auto-detection is skipped on Brave (provider-proxy guard);
  a manual reload picks up the new account. Optional polling fallback exists.
- Sibling DebugHub SDK copies (`debughub/sdk/debugger.js`,
  `dev-docs/debughub-network/debugger.js`) still carry the pre-1.3.4 wiring;
  patch when the hub is next deployed.
