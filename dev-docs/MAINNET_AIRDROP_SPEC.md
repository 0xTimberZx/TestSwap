# Testnet-claim → mainnet-TIMB airdrop

A cross-environment reward: an **eligible testnet faucet claim** (Sepolia ETH, as
today) *also* drips **real TIMB on Arbitrum One**. Runs during the capped-beta /
bug-bounty window, **before any LP exists** — so the TIMB isn't tradeable through
TimbSwap until mainnet `startGame`; this is pre-seeding a holder base, not a
market.

Status: **design only.** Companion to `FAUCET_SPEC.md` (the Sepolia leg, already
built) and `CAPPED_BETA_GUARDRAILS.md` (where the float + cap belong).

> **The one-line shape:** Turnstile-gated claim → eligibility + reserve in
> Supabase (unchanged) → an **airdrop outbox row** (unique per claim) → a
> **scheduled Supabase edge function** batches pending rows and sends TIMB from
> an **isolated, small-float distributor wallet** on Arbitrum One →
> atomically-claimed, nonce/hash-pinned, hard-capped. **No GitHub anywhere in
> this leg.**

---

## 1. Why this is *not* the existing faucet path

The Sepolia leg (`faucet-claim` edge fn + `faucet-worker.js` on GitHub Actions)
stays exactly as-is. The TIMB leg is deliberately **separate** on every axis,
because it moves **real value**:

| | Sepolia ETH leg (exists) | Arbitrum TIMB leg (this doc) |
|---|---|---|
| Value | testnet, ~free | **real TIMB** |
| Sender | GitHub Actions worker | **Supabase scheduled edge fn** (no GitHub) |
| Wallet | faucet hot wallet | **separate distributor wallet** |
| Key lives in | GitHub secrets | Supabase edge-fn secrets |
| Cadence | poll every ~10s (instant) | **batched** (gas economics, §7) |

Keeping the real-money key out of GitHub Actions (smaller supply-chain surface,
no `actions:write` = drain path) and off the testnet faucet wallet is the whole
point of the split.

## 2. The Sybil reality — read this before tuning caps

The existing faucet's Sybil gate is *"a ticket cost real gas to mint."* **That
gate is weak here**: eligibility is a **testnet** active ticket, and testnet gas
is free from faucets. So a bot can mint tickets cheaply and farm the TIMB leg.
The value is also **deferred, not zero** — no LP now, but a farmer banks TIMB to
dump after `startGame`.

Therefore the real defenses for this leg are, in order of weight:

1. **Hard total-airdrop cap** — the backstop. Pick a TIMB number you're happy to
   have fully farmed; when it's hit, the leg stops (Sepolia claims still work).
2. **Per-address lifetime cap** — e.g. N TIMB per address, ever (not per-claim),
   so daily re-claims don't compound into a farm.
3. **Turnstile CAPTCHA** (§5) — raises cost-per-attempt. Not a wall (solver farms
   exist), but "makes botting deserve it," and slows throughput — a win.
4. 24h cooldown + active-ticket gate (inherited) — weak here, but free to keep.

> **Decision to make:** per-claim (1 TIMB every eligible 24h claim) vs
> per-address-lifetime (1 TIMB once, ever). Per-address-lifetime is far more
> farm-resistant and more "airdrop-shaped"; per-claim rewards ongoing testnet
> play but compounds. Default this spec to **per-address-lifetime** and make it a
> config flag.

### Asset choice — why the reward stays TIMB (not ETH/WETH)

The dispatcher is **asset-agnostic** — the reward is just a parameter (`TIMB`,
`WETH`, or native ETH; WETH is a drop-in swap of the token address, native ETH
swaps the ERC-20 transfer for a value send and makes the optional §9.4 contract
`payable`). It is tempting to hand out ETH/WETH instead. **Don't, during the
beta** — swapping an *illiquid* reward for a *liquid* one deletes the single
biggest Sybil brake this design has:

- **No LP = a free brake.** TIMB has no market until `startGame`, so farming it
  now yields something a bot **can't sell yet** (deferred value — the whole
  reason the beta window is farm-resistant at all). ETH/WETH is **instantly
  liquid**: every claim is immediately-realizable cash, anywhere. You'd have built
  a **mainnet ETH faucet gated by a *free* testnet action** — among the most
  aggressively farmed things in crypto.
- **VaR becomes real money.** TIMB is your own minted supply (marketing spend).
  ETH/WETH is hard assets leaving the treasury on *every* claim, and the
  distributor float is real ETH — a far juicier drain target for the bounty.
- **Gating mismatch (the crux).** Real-value rewards must be gated on **costly**
  actions. A *testnet* ticket costs ~free gas; gating **real ETH** on it leaves
  only Turnstile + caps between the spigot and a drain, and Turnstile is beatable
  by solver farms. If you ever want to hand out real ETH, gate it on **mainnet**
  activity (a mainnet ticket / stake), not the free testnet gate.
- **Optics.** Giving away your own token is ordinary; giving away cash-like ETH at
  scale can touch promotions / money-transmission / tax-reporting rules a token
  airdrop doesn't. Review before scaling, not after.

**Verdict: the beta reward stays TIMB.** Illiquidity is a free Sybil brake and it
costs your own supply, not cash. ETH/WETH is out of scope until there is real
**mainnet** gating — or a narrow, mainnet-gated "gas top-up for verified players,"
which is really the cold-start case in `FAUCET_SPEC.md §7`, not this airdrop.

## 3. Flow

```
paste address → POST faucet-claim  (edge fn, extended)
                  ├─ verify Turnstile token (siteverify)         ← NEW
                  ├─ ethers.getAddress (valid? reject contracts?)
                  ├─ chain: activeTicketOf → effectiveStatus == Active ?
                  ├─ reserve_faucet_claim()  (Sepolia leg, unchanged)
                  ├─ enqueue_airdrop(address)  → airdrop_outbox   ← NEW
                  │     (unique per address/round; caps checked)
                  └─ 202 { queued }
                                   ⇓  (outbox, drained on a schedule)
   airdrop-dispatch (Supabase cron edge fn, single batched sender)
                  ├─ pg_advisory_lock(fixed key)  → one run at a time
                  ├─ SELECT … FOR UPDATE SKIP LOCKED  (grab a batch)
                  ├─ send TIMB (batched) from distributor wallet on Arb One
                  ├─ record nonce + tx hash BEFORE marking sent
                  └─ status: pending → sending → sent | failed
```

## 4. Data model — a dedicated outbox

A **separate table**, not new columns on `faucet_claims` — the two legs have
different chains, wallets, caps, and failure modes.

```sql
create table public.airdrop_outbox (
  id           bigserial primary key,
  address      text not null,
  round        int  not null default 1,      -- bump to run a fresh airdrop later
  amount_wei   numeric not null,             -- TIMB (18dp) as the row's promise
  status       text not null default 'pending'
               check (status in ('pending','sending','sent','failed','skipped')),
  claim_id     bigint references faucet_claims(id),  -- provenance (nullable)
  tx_hash      text,
  nonce        bigint,
  locked_at    timestamptz,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz,
  error        text,
  -- DEDUP LAYER 1: at most one airdrop per address per round.
  unique (address, round)
);
alter table public.airdrop_outbox enable row level security;
-- RLS on, NO anon policy — service_role only (mirrors faucet_claims).
```

- `enqueue_airdrop(p_address text, p_round int)` — a `SECURITY DEFINER` RPC
  (service_role-only execute, per the pattern we just applied): advisory-lock,
  check the **total cap** and **per-address cap**, then `insert … on conflict
  (address, round) do nothing`. Returns the row id or `null` (already queued / cap
  hit). Called by `faucet-claim` in the same request, *after* eligibility.
- `enforce`: a partial index or a running-total row for the total cap; the
  per-address cap is the `unique(address, round)` for lifetime, or a count for
  per-round.

## 5. CAPTCHA — Cloudflare Turnstile

You're already on Cloudflare, so Turnstile is the natural fit (free,
privacy-preserving, no Google).

- **Frontend:** render the Turnstile widget on the claim box; on solve you get a
  token; send it with the claim body (`{ address, cfTurnstileToken }`).
- **Edge fn:** *before* any eligibility/reserve work, POST to
  `https://challenges.cloudflare.com/turnstile/v0/siteverify` with
  `{ secret: TURNSTILE_SECRET, response: token, remoteip }`. Reject on
  `success != true`. Keep the secret in Supabase edge-fn secrets.
- It gates **both** legs (Sepolia + TIMB) since it sits at the front of
  `faucet-claim` — good, one solve per claim.

## 6. The dispatcher — single batched sender, no GitHub

A **Supabase scheduled edge function `airdrop-dispatch`** (pg_cron + `pg_net`, or
Supabase Cron), e.g. every 5–15 min. It is the *only* thing that touches the
distributor key.

Per run:

1. `pg_advisory_lock(<fixed key>)` — even if two invocations overlap, only one
   proceeds (mirrors your `reserve_faucet_claim` advisory discipline). Release in
   a `finally`.
2. Grab a batch: `SELECT … FROM airdrop_outbox WHERE status='pending' ORDER BY
   created_at LIMIT :N FOR UPDATE SKIP LOCKED` → immediately `UPDATE … SET
   status='sending', locked_at=now(), nonce=:seq`. (**DEDUP LAYER 2**: a row can
   only be picked once.)
3. Send TIMB to the batch from the distributor wallet on **one sequential nonce
   stream** (single sender ⇒ no nonce collisions). Batch either via a short loop
   or a disperse/multicall (§7).
4. **Record `tx_hash` + `nonce` BEFORE marking `sent`.** (**DEDUP LAYER 3**: a
   crash-retry reuses the pinned nonce → a *replacement* tx, never a second
   transfer; and on restart, check the recorded hash on-chain before resending.)
5. `status → sent` (with `sent_at`) on confirmation, or `failed` (with `error`)
   for retry. A `stuck 'sending'` sweeper (like `expire_stale_reservations`)
   re-opens rows whose `locked_at` is older than a threshold **only after**
   confirming on-chain that nothing landed for that nonce.

## 7. Economics → batch it

At the $0.0003 pool price, 1 TIMB ≈ **0.03¢**, while an Arbitrum transfer costs
more in gas than the token is worth. So per-claim on-chain sends are pouring
money into gas. **Batch**: the cron drains N recipients per run in one disperse
(a tiny disperse/multicall contract, or a short loop — cheap on Arb One). Bonus:
a batch is a **review window** — filter obvious sybil clusters before it sends,
and it's one auditable tx. No LP exists yet, so instant delivery buys nothing;
periodic batches are strictly better. Treat the whole thing as **marketing
spend**, and keep totals bounded (§2).

## 8. Distributor wallet & key hygiene

- A **dedicated hot wallet**, funded from the Safe with only a **small TIMB float
  + a little Arbitrum ETH for gas** — **never** the Safe, treasury, or mint
  authority. Compromise = you lose the float, capped.
- Top it up **deliberately**; the on-hand float should always equal a loss you'd
  accept (it's part of your value-at-risk, §10).
- **TIMB transfer cap:** `TIMBSToken` caps transfers unless from/to is whitelisted
  (the Safe is). 1 TIMB is almost certainly under any `maxTransferAmount`, but
  **confirm** — you may need the distributor whitelisted. Note whitelisting a hot
  wallet removes its own transfer cap, so prefer "amounts stay under the cap" over
  whitelisting if you can.
- **Balance guard:** the dispatcher refuses to send below `MIN_TIMB_FLOAT` /
  `MIN_GAS_ETH` and alerts once (reuse the settler/faucet Telegram channel), so
  the leg pauses instead of half-sending.

## 9. Double-distribution — layered to "impossible"

Stack these; each is independent, so no single failure leaks a double:

1. **DB unique** `(address, round)` — duplicate enqueue is impossible (§4).
2. **Atomic work-claiming** — `FOR UPDATE SKIP LOCKED` + `status='sending'` — two
   runs can't process one row (§6.2).
3. **Nonce-pinned, hash-recorded sends** — retry reuses the nonce (replacement,
   not a second transfer); confirm the recorded hash on-chain before any resend
   (§6.4).

That is **programmatically improbable**. For **actually impossible**, add:

4. *(optional)* **On-chain dedup contract** — a tiny `TimbAirdropDistributor`
   holding the float, `distribute(address[] recipients, uint round)` callable only
   by the backend signer, that checks `claimed[recipient][round]` and skips dupes
   internally. Even a wrong DB or buggy signer can't double-send — the chain
   refuses. Cost: a new mainnet contract → deploy + it lands **in bounty scope**.
   For a micro-amount airdrop, layers 1–3 are realistically enough; reach for #4
   only if "impossible" is a hard requirement.

## 10. Bug-bounty / value-at-risk integration (do not skip)

This leg adds **new value-at-risk** (the distributor float) and **new attack
surface** (Turnstile bypass, `enqueue_airdrop`, the dispatcher, and — if you build
#4 — a contract), running *alongside* the bounty. So:

- Add the **distributor float + total-airdrop cap** as financial-cap lines in
  `CAPPED_BETA_GUARDRAILS.md §1`.
- Fold the float into the **$500-bounty-vs-drain** math (`SECURITY.md`): a bug
  that drains the distributor or triggers unbounded/duplicate distributions is a
  legitimate finding (~T3–T4 by impact). Name the airdrop path in scope.
- Keep the total cap ≤ a number that stays under your capped-beta VaR ceiling.

## 11. Config & secrets

Supabase edge-fn secrets (new): `ARB_ONE_RPC`, `DISTRIBUTOR_PRIVATE_KEY`,
`TIMBS_ADDRESS` (Arb One), `TURNSTILE_SECRET`, plus reused
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (auto-injected). Vars:
`AIRDROP_AMOUNT_TIMB`, `AIRDROP_TOTAL_CAP_TIMB`, `AIRDROP_PER_ADDRESS_CAP_TIMB`,
`AIRDROP_BATCH_SIZE`, `AIRDROP_ROUND`, `MIN_TIMB_FLOAT`, `MIN_GAS_ETH`.

Frontend: Turnstile **site key** (public) in the claim page.

Deploy: `supabase functions deploy airdrop-dispatch` + schedule it (pg_cron).
Never `--no-verify-jwt` on a fund-moving function unless it's locked to
service_role internally.

## 12. Failure modes & recovery

- **Sepolia sent, TIMB failed** → the `airdrop_outbox` row is `failed`/`pending`,
  retried next run. The Sepolia claim is unaffected (separate leg).
- **Dispatcher crash mid-batch** → rows stuck `sending`; the sweeper re-opens them
  only after on-chain confirmation that the pinned nonce didn't land.
- **Float/gas exhausted** → guard pauses the leg, alerts once; Sepolia keeps
  working.
- **Cap hit** → `enqueue_airdrop` returns null; claim still succeeds for the
  Sepolia leg; frontend copy says the TIMB airdrop is fully allocated.

## 13. Open decisions for the implementer

1. **Per-claim vs per-address-lifetime** (§2) — recommend lifetime.
2. **Layers 1–3 vs add the on-chain contract (#4)** (§9) — recommend 1–3 for a
   micro-amount beta.
3. **Total cap + per-address cap numbers** (§2, §10) — yours to set against VaR.
4. **Reject contract addresses?** (bots often claim to a contract) — cheap to add.
5. **Batch cadence + size** (§6, §7) — trade latency vs gas.
6. **Reward asset** — *settled: TIMB.* ETH/WETH is out of scope until real mainnet
   gating exists (§2 asset-choice). Not an open decision — listed so it isn't
   reopened by accident.

## 14. Build checklist

1. Migration: `airdrop_outbox` + `enqueue_airdrop()` (service_role-only execute).
2. Extend `faucet-claim`: Turnstile verify (front), `enqueue_airdrop` (after
   eligibility).
3. New `airdrop-dispatch` scheduled edge fn (advisory lock, batch, nonce/hash pin).
4. Provision the **distributor wallet**; fund a small TIMB float + gas from the
   Safe; confirm the transfer-cap path (§8).
5. Set secrets/vars (§11); add Turnstile widget to the claim page.
6. Add caps to `CAPPED_BETA_GUARDRAILS.md`; add scope line to `SECURITY.md` (§10).
7. Smoke test: claim (TIMB lands), re-claim (deduped/capped), bad Turnstile
   (rejected), cap hit (Sepolia still works, TIMB declines cleanly).
