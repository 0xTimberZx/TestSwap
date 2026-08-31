# Gas faucet — active-ticket gas drip

A paste-your-address faucet for mainnet launch. Any wallet that **holds a live
active ticket** can claim **once per 24h**; each claim sends a small amount of
ETH to the wallet *and* an equal amount to the current round's pot.

Status: **built, awaiting mainnet wiring** (addresses, secrets, hot-wallet
funding). Files: `supabase/functions/faucet-claim/`, `scripts/faucet-worker.js`,
`supabase/migrations/20260831000000_faucet.sql`, `.github/workflows/faucet.yml`.

---

## 1. What it does

- **Eligibility:** the pasted address must currently hold a **live active
  ticket** — `GameRegistry.effectiveStatus(activeTicketOf(addr)) == Active`. No
  pre-existing ETH balance is required; this is a keep-alive drip for real
  players who've run their gas dry. The ticket (which cost gas to mint) is the
  Sybil gate.
- **Amount, per claim:** `DRIP_ETH` to the wallet + `POT_ETH` to the pot.
  Launch default **0.000005 ETH each** (~$0.01 apiece at ETH $2,000; the drip
  covers ~500k gas at the Arb One 0.01 gwei floor). The pot half is sent via
  `TimbPrize.addToPot()` — every claim grows the live round.
- **Cooldown:** once per 24h per address, enforced atomically in Postgres.

> Units note: the original ask said "0.05 gwei" — that's ~$0.0000001 and can't
> cover a single tx. The figure is **0.000005 ETH**.

## 2. Architecture — gatekeeper + single sender

Two pieces, because the hot wallet must send on **one sequential nonce stream**
or concurrent claims collide:

- **Edge function `faucet-claim` (gatekeeper).** Validates the address, reads the
  **chain** for a live ticket (never a mirror), atomically reserves the 24h slot,
  and **enqueues** a `reserved` row. It never sends ETH. Returns `202 queued`.
- **Worker `faucet-worker.js` (single sender).** The *only* thing that touches
  the hot wallet. Drains `reserved` claims oldest-first, re-checks eligibility
  on-chain, and sends the drip + `addToPot()` with sequential nonces. Lingers and
  polls every ~10s (like the settler) so a claim lands within seconds, then exits
  and self-chains. `concurrency: timbswap-faucet` guarantees one sender.

```
paste address → POST faucet-claim
                  ├─ ethers.getAddress (valid?)
                  ├─ chain: activeTicketOf → effectiveStatus == Active ?
                  ├─ reserve_faucet_claim() : advisory-locked 24h check + enqueue
                  └─ 202 { queued }
                                   ⇓  (queue)
   faucet-worker (single) → re-check ticket → sendTransaction(drip)
                                             → addToPot{value:POT}()
                                             → mark sent (tx hashes)
```

## 3. Data model (`faucet_claims`)

`id · address · ticket_id · status(reserved|sent|failed) · wallet_tx · pot_tx ·
reserved_at · sent_at · error`. RLS **on, no anon policy** — only the
service_role backend reads/writes it (mirrors `dev-docs/supabase-rls-policies.sql`).

- **`reserve_faucet_claim(address, ticket_id)`** — `pg_advisory_xact_lock` +
  24h-window check + insert. Returns the new id, or `null` on cooldown. A
  `failed` send does **not** burn the day; a `reserved` row **does** hold the
  slot until the worker resolves it.
- **`expire_stale_reservations()`** — flips `reserved` rows older than 15 min to
  `failed` (worker crash between reserve and send), releasing the slot. The
  worker calls it on start.

## 4. Abuse / Sybil

- **Ticket gate:** each active ticket cost real gas (and TIMBS/ETH escrow) to
  mint. One drip per ticket per day.
- **Self-limiting economics:** a farmer nets only `DRIP_ETH`/day/ticket while an
  equal `POT_ETH` goes to a pot they probably don't win — farming funds the game.
- **24h cooldown** per address, atomic (no double-claim race).
- **Optional hardening (not in MVP):** per-IP rate limit at the edge; reject
  contract addresses; cap total daily faucet outflow.

## 5. Hot-wallet ops

- Dedicated **faucet wallet**, funded from treasury, separate from the settler.
- **Balance guard:** the worker refuses to send below `MIN_BALANCE_ETH`
  (default 0.01) and alerts Telegram once — claims pause, nothing bricks.
- **Daily ceiling:** `active_tickets × (DRIP+POT)`. At 0.00001 ETH/claim and
  1,000 active tickets that's 0.01 ETH/day (~$20 at ETH $2,000).
- Alerts reuse the settler's Telegram channel.

## 6. Config & secrets

**config.js** supplies `TimbPrize` + `GameRegistry` (worker reads them, same as
the settler). **Update both to the mainnet addresses before launch.**

GitHub Actions secrets: `ARB_RPC`, `FAUCET_PRIVATE_KEY`, `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
`FAUCET_DISPATCH_TOKEN` (PAT, Actions r/w, for the self-chain). Vars:
`FAUCET_DRIP_ETH`, `FAUCET_POT_ETH`, `FAUCET_MIN_BALANCE_ETH`.

Edge-function secrets (Supabase → Edge Functions): `RPC_URL`,
`GAME_REGISTRY_ADDR` (`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` auto-injected).
Deploy: `supabase functions deploy faucet-claim --no-verify-jwt`.

## 7. Cold-start caveat

Eligibility requires an **active ticket**, but minting the first ticket costs
gas. So the faucet **replenishes existing players; it does not onboard a
zero-ETH cold wallet**. If launch needs cold-start onboarding, that's a separate
path (e.g. a first-entry sponsor, or entering via a trade that bundles gas) —
out of scope here, flagged deliberately.

## 8. Frontend (paste-to-claim)

Minimal wiring — a text box + button hitting the edge function:

```js
async function claimGas(address) {
  const r = await fetch("https://<project>.functions.supabase.co/faucet-claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address }),
  });
  const body = await r.json();
  return { ok: r.ok, ...body };   // ok → "Gas is on the way"; else body.error (voice-tuned)
}
```

Error copy from the function is already written in the house voice ("No active
ticket for this address. Enter a round first." / "Already claimed. Come back in
about {h}h.").

## 9. Launch checklist

1. Deploy `TimbPrize` + `GameRegistry` on Arb One; update **config.js**.
2. Apply the migration (`faucet_claims` + functions) to Supabase.
3. Fund the faucet hot wallet from treasury.
4. Set the secrets/vars (§6); deploy the edge function; enable the workflow.
5. Wire the paste-to-claim box (§8) into the play page.
6. Smoke test: claim once (arrives), claim again (429 cooldown), non-ticket
   address (403).
