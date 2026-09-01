# Reclaim reminders (Telegram opt-in)

Makes §14 forfeiture *rare* and unambiguously fair: a holder is DM'd on Telegram
before an active ticket's refund window lapses, so a stake is only ever swept
(community-tilted split, `dev-docs/ABANDONED_TICKET_REVENUE.md`) after the person
was clearly reminded and chose not to reclaim.

Telegram only, per-user opt-in via a self-declared `/start <wallet>` deep link.
No funds, no PII beyond a Telegram chat id and a public wallet address.

## Pieces

| Component | File | Role |
|---|---|---|
| Registry + dedupe tables | `supabase/migrations/20260901120000_reclaim_reminders.sql` | `reclaim_subscribers` (wallet↔chat_id) and `reclaim_reminders_sent` (one DM per ticket-expiry). RLS on, no anon policy. |
| Bot webhook | `supabase/functions/telegram-webhook/index.ts` | Handles `/start <wallet>` (subscribe) and `/stop`. Secret-token gated. |
| Reminder worker | `scripts/reclaim-reminder.js` | Read-only chain scan → DMs opted-in holders whose forfeitRound is within `REMIND_LEAD_ROUNDS`. |
| Schedule | `.github/workflows/reclaim-reminder.yml` | Hourly; idempotent + deduped. |

## How it works

1. Holder taps **"Remind me on Telegram"** in the app → opens
   `https://t.me/<bot>?start=<wallet>`.
2. Telegram delivers `/start <wallet>` to the webhook → the wallet↔chat_id link
   is upserted (self-declared; a wallet address is public, so the worst case is
   subscribing to a public address's already-public expiry timing).
3. The hourly worker reads `generation` + `currentRound`, scans the recent
   play-round entrant buckets, and for each wallet's LIVE ticket keeps those that
   are still refundable (Active/Pending, escrow > 0) with `forfeitRound` within
   `REMIND_LEAD_ROUNDS` (default 2) of `currentRound`.
4. If that wallet is an active subscriber and hasn't already been reminded for
   this exact `(wallet, generation, forfeitRound)`, it DMs the chat and records
   the send. One reminder per ticket-expiry — never spammed.
5. `/stop` flips every wallet on that chat to inactive.

## Deploy / runbook

### 1. Migration
Apply `20260901120000_reclaim_reminders.sql` to the Supabase project (same one as
the faucet).

### 2. Edge function
```
supabase functions deploy telegram-webhook --no-verify-jwt
```
Set its secrets (Project Settings → Edge Functions):
- `TELEGRAM_BOT_TOKEN` — the bot (same token the settler/faucet send with).
- `TELEGRAM_WEBHOOK_SECRET` — a random string you generate.
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are auto-injected.

### 3. Register the webhook with Telegram
Point the bot at the function and hand Telegram the same secret it must echo:
```
curl -sS "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -d "url=https://<project>.supabase.co/functions/v1/telegram-webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```
(Every delivery then carries `X-Telegram-Bot-Api-Secret-Token`; the function
rejects anything without the match.)

### 4. Worker schedule
Repo secrets: `ARB_RPC`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (ops alerts, optional).
Repo variables (optional): `TELEGRAM_BOT_USERNAME` (for the in-DM link),
`REMIND_LEAD_ROUNDS` (default 2), `RECLAIM_SCAN_BACK_ROUNDS` (default 8),
`COMPETE_URL`.

### 5. Frontend deep link
Add a "Remind me on Telegram" control that opens the bot with the connected
wallet as the start param (raw 0x address — 42 chars, within Telegram's 64-char
start-param limit and charset):
```js
const url = `https://t.me/${BOT_USERNAME}?start=${account}`; // account = 0x… lowercased is fine
window.open(url, "_blank", "noopener");
```

## Notes
- The scan is bounded (`SCAN_BACK_ROUNDS` buckets, two reads per candidate). At
  large entrant counts, page the bucket scan — noted as a future refinement.
- The dedupe key is `(wallet, generation, forfeitRound)`, so a *replacement*
  ticket (new forfeitRound) is reminded again, but the same ticket is not.

## Also on these rails: segment-1 match notifications

The same opt-in registry powers a hype nudge: when a round's **segment 1 locks**,
holders whose ticket's **first letter matches** the locked character get a "you're
still in the running" DM.

| Component | File |
|---|---|
| Dedupe ledger | `supabase/migrations/20260901130000_match_notifications.sql` (`match_notifications_sent`) |
| Worker | `scripts/match-notifier.js` |
| Schedule | `.github/workflows/match-notifier.yml` (every 15 min — snappy after the lock) |

How it works: the worker reads `TimbPrize.segmentDigitLocked(1)` / `segmentLockedChar(1)`
and, once segment 1 is locked, compares each current-round entrant's live ticket
`string6[0]` to that character. Matching subscribers get one DM per `(wallet,
generation, round, segment 1)` — the matcher set is fixed the instant segment 1
locks, so it's a single notification per ticket-round. Reuses the same repo
secrets/vars as the reminder worker (no extra opt-in; a subscriber gets both).

Extending to later segments (a "still alive after segment N" streak) is a natural
follow-up — the ledger's `segment` column already accommodates it.
