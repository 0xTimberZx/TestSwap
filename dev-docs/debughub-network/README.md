# DebugHub network sink — apply-ready patch package

## Why

DebugHub was localStorage-only. `localStorage` is **origin-scoped**, so once
TimbSwap moved to `timbswap.xyz` its telemetry stopped reaching the shared hub
on `0xtimberzx.github.io` (different origin → the hub can't read it). Even the
same-origin apps only ever showed data generated in *that one browser*.

This package adds a real network sink (Supabase) so **every app reports across
origins and devices** into one hub. localStorage stays as an offline fallback,
so nothing breaks if the backend is unreachable, and the change is fully
backward compatible (omit the config and the SDK behaves like 1.1.0).

```
  App (any origin)                     Supabase (PostgREST + RLS)          Hub
  ────────────────                     ──────────────────────────         ─────
  debugger.js v1.2.0  ──POST anon──▶   public.debughub_events   ◀──GET──  app.js
   (+ localStorage fallback)            anon INSERT (whitelist)           (+ localStorage
                                        anon SELECT (read-only)             fallback)
```

## Backend — already provisioned ✅

- **Project:** `0xTimberZx's Project` (ref `ipyfodnidwsdvwqrcjrl`)
- **URL:** `https://ipyfodnidwsdvwqrcjrl.supabase.co`
- **Anon key (public):** `sb_publishable_yg4wjMwvGrlf5C9vqs2nkw_Hfks0Ux9`
- **Table:** `public.debughub_events` with RLS enabled — see [`schema.sql`](./schema.sql).
- Verified end-to-end: anon INSERT for whitelisted apps succeeds; a
  non-whitelisted app is rejected by RLS (`42501`); anon SELECT reads back.

No further backend work is required unless you want the optional 30-day prune
(commented at the bottom of `schema.sql`).

## What you apply in `MyDapp` (the only remaining steps)

It's a **copy-two-files** job — no hand-editing:

1. **Replace the SDK.** Copy [`debugger.js`](./debugger.js) over
   `MyDapp/debughub/sdk/debugger.js`. Full v1.2.0 drop-in — same public API,
   now with the network sink.

2. **Replace the hub logic.** Copy [`app.js`](./app.js) over
   `MyDapp/debughub/app.js`. Full drop-in that reads from Supabase (with a
   localStorage fallback); the gate, tabs, `Export JSON`, and the
   `ERROR_EXPLANATIONS` catalog are byte-for-byte unchanged from the original.
   ([`hub-app-patch.md`](./hub-app-patch.md) explains exactly what it changed,
   if you'd rather review the delta than trust the drop-in.)

Push those two files to MyDapp and the shared hub lights up with TimbSwap (and
every other app) regardless of origin or device.

Both files have `SUPABASE_URL` / `SUPABASE_KEY` pre-filled for this project. The
SDK also reads them from `DEBUGHUB_CONFIG` if present (TimbSwap already supplies
them); the hub uses its own top-of-file constants.

Verified headless: the hub fetches `?app=eq.TimbSwap&order=event_ts.asc`, maps
DB columns (`fn`→`function`, `event_ts`→`timestamp`) back to the event shape,
and renders Sessions / Checkpoints / Errors / Wallets correctly.

## TimbSwap side — already wired ✅

`config.js` now sets `window.DEBUGHUB_CONFIG` with `supabaseUrl` + `supabaseKey`
alongside `appName`. The current (1.1.0) SDK ignores the extra fields, so this is
a no-op until you drop in the v1.2.0 SDK above — at which point TimbSwap starts
transmitting with **zero further TimbSwap changes**.

The same-origin local dashboard at `timbswap.xyz/debughub/` keeps working off
localStorage and needs nothing here; it's the "works right now, no backend"
view, complementary to the aggregated remote hub.

## Security model

- The **anon key is meant to be public** (embedded in client JS). RLS is the
  boundary: anon may only `INSERT` events for the five known apps and `SELECT`
  diagnostics — no update/delete.
- **No secrets are ever logged.** The SDK records app behaviour only
  (checkpoints, error codes/messages, wallet *addresses*, chain id). Never keys
  or seed phrases. Same data the hub already displayed.
- Free-text fields are length-capped (`message` ≤ 2000, `name` ≤ 200) at both
  the SDK (truncate) and DB (CHECK) layers.
