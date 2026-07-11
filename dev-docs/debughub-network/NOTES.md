# DebugHub — operational notes & known issues

Running notes on the DebugHub telemetry pipeline as wired for TimbSwap. Covers
wallet-connect behaviour, SDK caveats, and macro/architecture issues. The shared
error catalog (`ERROR_EXPLANATIONS`) is deliberately **out of scope here** — it
lives in `MyDapp/debughub/app.js` and evolves there.

Status at time of writing: pipe is **live and verified** — real page loads on
`timbswap.xyz` write to `public.debughub_events` (SDK v1.2.0), and the hub reads
them back across origins/devices.

---

## 1. Wallet connect & attribution

### Symptom (observed live)
Most rows land with `wallet: null`, and their `session_id` ends in the `0xNNN`
placeholder (e.g. `timbswap-1635-0xNNN`) instead of a wallet prefix. A few
events — typically `session_end` and later checkpoints — *do* carry the real
address (`0x4253…9800`). `chain_id` is likewise `null` on the earliest events of
a load and `421614` once the provider has settled.

### Cause (not a network-sink bug)
The SDK derives the wallet from `window.ethereum.selectedAddress` in
`getWallet()`. That property is **deprecated and frequently `null`** — including
while a wallet is genuinely connected, and especially in the first
milliseconds after page load before the provider initialises. The session id is
computed **at `startSession()` time** from whatever wallet is known then, so a
null-at-start session is stamped `0xNNN` for its whole life even if the address
resolves a moment later.

This is pre-existing SDK behaviour; the network sink just makes it visible in
aggregate for the first time.

### Why some events still get the wallet
- `startSession()` calls `backfillWallet()` which asynchronously queries
  `eth_accounts` and patches `currentSession.wallet` — so events emitted *after*
  that resolves carry the address (the session id is already fixed, though).
- `accountsChanged` handlers pass the fresh account into `startSession(accounts[0])`.

### Fix path (TimbSwap-side only — NO MyDapp copy) — ✅ applied
The v1.2.0 SDK already accepts `startSession(walletOverride)`. TimbSwap used to
call it with **no argument** at all 19 sites; those now pass the address the app
already has in hand right after `connectWallet()` / `autoReconnect()`
(connect handlers → `userAddress`, auto-reconnect branches → the returned
address, `accountsChanged` → the new account):

```js
// before
DebugHub.startSession();
// after (connect handler)
DebugHub.startSession(userAddress);
// after (auto-reconnect branch)
DebugHub.startSession(_reconnected);   // the address autoReconnect returned
```

Call sites (each file has two — the connect handler and the auto-reconnect
branch):

| File | Lines |
|------|-------|
| `landing.js` | 162, 179, 207 |
| `swap/swap.js` | 1405, 1464 |
| `analytics/analytics.js` | 562, 596 |
| `compete/compete.js` | 1361, 1407 |
| `explore/explore.js` | 425, 459 |
| `gov/gov.js` | 341, 383 |
| `farm/farm.js` | 259, 304 |
| `lock/lock.js` | 458, 506 |
| `docs/docs.js` | 88, 140 |

Effect: sessions get a wallet-prefixed id and per-wallet attribution in the hub's
Wallets tab. Purely additive; the override is optional and ignored when absent.

Note the page-load checkpoint (e.g. `Swap:Page Loaded`) fires *before* any
wallet is connected, so it will always be an anonymous session — that's correct,
not a defect.

---

## 2. SDK caveats (`debugger.js` v1.2.0)

- **Fire-and-forget transport.** Each event is a separate `fetch` POST with
  `keepalive: true`; failures are swallowed (`.catch(()=>{})`). Telemetry can
  never throw into or block the host app. The trade-off: no delivery guarantee
  and no retry — a dropped POST is simply lost (localStorage still has it).
- **One request per event + CORS preflight.** A non-simple POST (custom
  `apikey`/`Authorization`/`Prefer` headers) triggers an `OPTIONS` preflight, so
  a page-load burst of checkpoints is ~2 round-trips each. Fine for testnet
  volume; if it ever matters, batch or move to `navigator.sendBeacon`.
- **Config read lazily.** `transmit()` reads `window.DEBUGHUB_CONFIG` at send
  time, so `config.js` (loaded after the SDK `<script>`) can supply
  `supabaseUrl`/`supabaseKey`. `appName` is captured once at load from the head
  inline config — keep that inline `{ appName: "TimbSwap" }` present.
- **localStorage remains the source of truth offline.** Every event is written
  locally first; the remote POST is additive. The local `/debughub/` dashboard
  reads localStorage only and needs no backend.
- **200-event local ring buffer.** `MAX_EVENTS = 200` per app in localStorage;
  the remote sink has no such cap (see prune note in `schema.sql`).
- **Field length caps.** `message` truncated to 2000, `name`/`label` to 200 to
  satisfy the DB CHECK constraints; over-long values are clipped, not rejected.

---

## 3. Macro / architecture issues

- **Origin-scoping was the root problem.** DebugHub was localStorage-only, and
  localStorage is per-origin. Once TimbSwap moved to `timbswap.xyz` (CNAME), the
  hub on `0xtimberzx.github.io` could no longer read it. The Supabase sink is
  the durable fix; the same-origin `/debughub/` page is the no-backend fallback.
- **SDK is loaded cross-origin with cache-busting.** The `<script src>` points at
  `…/MyDapp/debughub/sdk/debugger.js?v=1.2.0`. GitHub Pages caches assets, so a
  version bump to the SDK **must** be matched by bumping that `?v=` token across
  all pages, or returning visitors keep the stale SDK. (This is exactly what
  broke the first go — the un-versioned tag served cached 1.1.0.)
- **Only apps with sink config transmit.** The hub reads Supabase for every app,
  but only TimbSwap currently carries `supabaseUrl`/`supabaseKey` in its config,
  so only TimbSwap populates the sink. Faucet / BlockpotDAO / MessageBoard stay
  localStorage-only until their own configs get the sink fields — the hub falls
  back to localStorage for any app whose remote result is empty, so they don't
  go blank.
- **Anon key is public by design.** It ships in client JS; RLS is the boundary
  (anon may INSERT only for the 5 whitelisted apps and SELECT read-only). Do not
  treat the key as a secret; do treat the RLS policies as the security surface.
- **Unrelated standing risk:** 10 *other* tables in the same Supabase project
  have RLS disabled (pre-existing, not part of this pipeline). Flagged to the
  owner; left untouched here.
- **No delivery/ordering guarantees.** Events can arrive out of order or be
  dropped; the hub sorts by `event_ts` and groups by `session_id`, so display is
  robust to that, but don't treat the sink as an audit log.

---

## 4. Redeploy quick-reference

| Change | Where | Re-copy to MyDapp? |
|--------|-------|--------------------|
| Pass `userAddress` into `startSession()` | TimbSwap page JS | **No** |
| Wallet-connect / SDK-usage notes, this file | `dev-docs/` | **No** |
| Local `/debughub/` dashboard | `debughub/index.html` | **No** |
| SDK transport / wallet detection | `debugger.js` | **Yes** → `sdk/debugger.js` (bump `?v=`) |
| Hub read/render | `app.js` | **Yes** → `debughub/app.js` |
| Error catalog entry | `ERROR_EXPLANATIONS` | **Yes** (MyDapp) + TimbSwap local mirror |
