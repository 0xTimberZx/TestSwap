# DebugHub — operational notes & known issues

Running notes on the DebugHub telemetry pipeline as wired for TimbSwap. Covers
wallet-connect behaviour, SDK caveats, and macro/architecture issues. The shared
error catalog (`ERROR_EXPLANATIONS`) is deliberately **out of scope here** — it
lives in `MyDapp/debughub/app.js` and evolves there.

Status at time of writing: pipe is **live and verified** — real page loads on
`timbswap.xyz` write to `public.debughub_events` (SDK v1.3.0), and the hub reads
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
The SDK has accepted `startSession(walletOverride)` since 1.2.0. TimbSwap used to
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

## 2. SDK caveats (`debugger.js` v1.3.0)

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
- **The `?v=` cache token is the single most repeated failure here.** TimbSwap
  now self-hosts the SDK at `debughub/sdk/debugger.js?v=<version>` (it used to
  load MyDapp's copy cross-origin, which meant it could only run whatever
  version MyDapp served). Either way GitHub Pages caches by full URL, so a
  version bump **must** be matched by bumping that `?v=` token across every
  page or returning visitors keep the stale SDK. This has now broken three
  rollouts in a row: the un-versioned tag served cached 1.1.0; 1.2.0 shipped
  behind a stale token; and 1.3.0 landed with all ten pages still requesting
  `?v=1.2.1`. **Bump the token in the same commit as `SDK_VERSION`** — treat
  them as one edit, not two.
- **All four apps transmit.** TimbSwap, Faucet, BlockpotDAO and MessageBoard
  each carry `supabaseUrl`/`supabaseKey`. (This bullet used to say only
  TimbSwap did; the 1.2.1 rollout wired the rest.) The hub still falls back to
  localStorage for any app whose remote result is empty, so a
  not-yet-configured app doesn't go blank.
- **`appName` is the silo key**, and `index` / `swap` / `compete` deliberately
  share `"TimbSwap"` — one silo, one snapshot covering the whole site.
  `tables/play.html` uses its own `"SwapTables"`. Splitting any page out is a
  one-line config change, but note the RLS allowlist is case-sensitive and a
  new name needs adding there or inserts fail with `42501`.
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

## 3b. Local snapshot / viewer path (1.3.0)

A viewer with no wallet and no special access can append **`#debug`** (also
`#snapshot`, `#dbg`, or the `?debug` query form) to any page URL. That arms:

- an immediate `startSession()`, so logging begins without waiting for a connect;
- `window.onerror` + `unhandledrejection` capture, so even a lightly wired page
  yields something useful;
- a floating **🐛 snapshot** button.

The snapshot reads **only this app's silo** (`STORAGE_KEY` is `appName`-scoped),
renders it to a canvas with no external library, and hands off to the OS share
sheet: image where the device supports file share, text summary where it
doesn't, clipboard + on-screen card on desktop. There is **no download path** —
that was a deliberate constraint, not an oversight.

### The claim to be careful about

The snapshot itself is never uploaded. The **events it summarises already were**,
on any page with a sink configured — `transmit()` POSTs each one as it happens.
So the card's wording is conditional on `sinkConfigured()`:

| page | sink | card says |
|------|------|-----------|
| `tables/play.html` | none | "Your local record only — nothing is uploaded or downloaded." |
| TimbSwap pages | Supabase | "This snapshot is never uploaded … this app also reports its own diagnostics to the operator." |

The unconditional local-only wording shipped briefly in 1.3.0 and was false on
the TimbSwap pages. If you add a sink to a page that didn't have one, the
disclosure follows automatically — but if you ever hardcode the wording again,
this is the trap.

### Exposure

The card shows a masked wallet (`0x4253…9800`), chain id, session/event counts,
the last 6 error messages and last 10 events. Error `message` fields are
app-authored and could carry more than intended — worth a glance before telling
players to share snapshots publicly.

---

## 4. Redeploy quick-reference

| Change | Where | Re-copy to MyDapp? |
|--------|-------|--------------------|
| Pass `userAddress` into `startSession()` | TimbSwap page JS | **No** |
| Wallet-connect / SDK-usage notes, this file | `dev-docs/` | **No** |
| Local `/debughub/` dashboard | `debughub/index.html` | **No** |
| SDK transport / wallet detection / snapshot | `debugger.js` | **Yes** → `sdk/debugger.js` **and** `dev-docs/debughub-network/debugger.js` (bump `SDK_VERSION` **and** the `?v=` token on all pages, same commit) |
| Hub read/render | `app.js` | **Yes** → `debughub/app.js` |
| Error catalog entry | `ERROR_EXPLANATIONS` | **Yes** (MyDapp) + TimbSwap local mirror |
