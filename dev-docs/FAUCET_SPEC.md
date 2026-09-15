# Faucet — active-ticket keep-alive drip

A paste-nothing, connect-and-claim faucet for live players. Any wallet holding a
live **Active** ticket can claim **once per 24h**; each claim sends a little ETH
to the wallet (gas), an equal amount to the current round's pot, and
`timbsPerClaim` TIMBS — all in one on-chain transaction.

Status: **built (Phase 1), awaiting chain wiring** — the deployed `GasFaucet`
address, the edge-function + worker secrets, treasury operator wiring, and the
TIMBS pre-fund. Files:

- `contracts/GasFaucet.sol` — the on-chain faucet (single-chain).
- `scripts/DeployFaucet.s.sol` — deploy + owner-side wiring.
- `supabase/functions/faucet-claim/` — the gatekeeper edge function.
- `scripts/faucet-worker.js` + `.github/workflows/faucet.yml` — the sender.
- `faucet/` — the claim page (`index.html`, `faucet.js`, `faucet.css`).
- `supabase/migrations/20260831000000_faucet.sql` (+ the 3-arg soft-check
  migration) — the `faucet_claims` ledger and its RPCs.

---

## 1. What it does

- **Eligibility (on-chain Sybil gate):** `GameRegistry.effectiveStatus(activeTicketOf(addr)) == Active`. The ticket cost gas + escrow to mint — that is the gate. No pre-existing balance required.
- **Per claim:** `dripEth` to the wallet + `potEth` to the pot (`TimbPrize.addToPot`) + `timbsPerClaim` TIMBS to the wallet. All legs are independently pausable and independently capped on-chain (`GasFaucet.sol`).
- **Cooldown:** once per 24h per address, enforced BOTH in Postgres (`reserve_faucet_claim`, fast pre-check) and on-chain (`lastClaimAt + cooldown`, the authority).

## 2. Architecture — gatekeeper + single sender + on-chain enforcement

Three layers; the hot wallet is touched by exactly one of them:

- **Edge fn `faucet-claim` (gatekeeper).** Verifies Turnstile, validates the
  address, reads the **chain** for a live Active ticket + `TimbYieldVault.weightOf`
  (soft), atomically reserves the 24h slot (`reserve_faucet_claim`), and returns
  `202`. **Never sends anything.**
- **Worker `faucet-worker.js` (single sender).** The only thing that holds a key.
  Drains `reserved` rows oldest-first, re-checks `GasFaucet.claimable()` on-chain,
  calls `dispense(claimant)` on one sequential nonce stream, and resolves each row
  to `sent`/`failed`. Lingers + polls (like the settler) so a claim lands within
  seconds; `concurrency: timbswap-faucet` guarantees one sender.
- **`GasFaucet.dispense` (on-chain enforcement).** Re-checks eligibility, cooldown,
  and caps itself — so a leaked dispatcher key still cannot over-drip or bypass the
  Sybil gate.

```
connect wallet → POST /api/faucet-claim  (Worker → Supabase faucet-claim)
                   ├─ Turnstile siteverify
                   ├─ chain: activeTicketOf → effectiveStatus == Active ?
                   ├─ reserve_faucet_claim() : advisory-locked 24h + enqueue
                   └─ 202 { queued }
                                  ⇓  (faucet_claims, drained on a schedule)
   faucet-worker (single) → claimable()? → dispense(claimant)
                                          → mark sent (tx hash)
```

## 3. Data model (`faucet_claims`)

`id · address · ticket_id · reserve_weight · status(reserved|sent|failed) ·
wallet_tx · pot_tx · reserved_at · sent_at · error`. RLS **on, no anon policy** —
only the service_role backend touches it.

- `reserve_faucet_claim(address, ticket_id, reserve_weight)` — `pg_advisory_xact_lock`
  + 24h-window check + insert; returns the new id, or `null` on cooldown. A
  `failed` row does **not** burn the day.
- `expire_stale_reservations()` — flips `reserved` rows older than 15 min to
  `failed` (a crashed sender), releasing the slot. The worker calls it on start.

Note: `dispense` is one tx (drip + pot + TIMBS), so the worker records that single
hash in `wallet_tx`; `pot_tx` is left null.

## 4. Config & secrets

**config.js:** `GasFaucet` (ADDRESSES — the worker reads it), and
`window.TURNSTILE_SITE_KEY` (public). `GameRegistry` / `TimbPrize` are already read
by the ecosystem.

**Cloudflare Worker (vars/secrets):** `FAUCET_UPSTREAM` (the Supabase faucet-claim
URL), optional `FAUCET_PROXY_SECRET`.

**Edge fn (Supabase → Edge Functions):** `FAUCET_RPC_URL` (Sepolia),
`GAME_REGISTRY_ADDR`, `TIMB_YIELD_VAULT_ADDR`, `TURNSTILE_SECRET`, optional
`FAUCET_PROXY_SECRET`; `AIRDROP_ENABLED`/`AIRDROP_ROUND` gate the Phase-2 leg
(default off). `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` auto-injected.
Deploy: `supabase functions deploy faucet-claim --no-verify-jwt`.

**Worker keeper (GitHub Actions secrets):** `ARB_SEPOLIA_RPC`,
`FAUCET_DISPATCHER_PRIVATE_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`; optional `FAUCET_DISPATCH_TOKEN`
(self-chain PAT). Vars: `FAUCET_LINGER_MINUTES`, `FAUCET_POLL_SECONDS`,
`FAUCET_DRAIN_LIMIT`.

## 5. Hot-wallet & funding

- Dedicated **faucet dispatcher** wallet (set as `GasFaucet.dispatcher`), holds
  only gas — never the treasury or the TIMBS budget.
- **ETH** stays in the treasury and is pulled live per claim: the faucet must be
  the treasury's `operator` (`setOperator` + `setOperatorEthCap`).
- **TIMBS** is **pre-funded** into the faucet (`treasury.withdrawToken(timbs,
  faucet, budget)`); `recoverTimbs` returns unused budget.
- Two ceilings on each asset: the faucet's own `ethCap`/`timbsCap` **and** the
  treasury's operator cap.

## 6. Cold-start caveat

Eligibility is an Active ticket, and minting the first ticket costs gas — so the
faucet **replenishes existing players; it does not onboard a zero-ETH cold
wallet.** Cold-start onboarding (a public testnet faucet, or a sponsored first
entry) is a separate path, flagged deliberately.

## 7. Launch checklist

1. `forge script scripts/DeployFaucet.s.sol` (env per its header) → note the address.
2. Owner/Safe: `treasury.setOperator(faucet)`, `setOperatorEthCap(...)`,
   `withdrawToken(timbs, faucet, budget)` to pre-fund TIMBS.
3. Set `GasFaucet` in config.js; set `window.TURNSTILE_SITE_KEY`.
4. Deploy the edge fn + set its secrets; set the Worker `FAUCET_UPSTREAM` var;
   set the keeper GitHub secrets; enable the workflow.
5. Smoke test: claim with an Active ticket (arrives), claim again (429 cooldown),
   an address with no ticket (403), bad/absent Turnstile (403).
