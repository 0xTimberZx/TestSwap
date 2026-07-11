# Hub read-from-Supabase patch (`MyDapp/debughub/app.js`)

> **You don't have to hand-apply this.** A complete drop-in is provided as
> [`app.js`](./app.js) in this folder — just copy it over `MyDapp/debughub/app.js`.
> This document explains what that drop-in changes, for review.

The hub currently reads only its **own origin's** `localStorage` (line ~33,
`loadEvents`). To aggregate every app across origins and devices, make it read
the Supabase sink instead, falling back to localStorage when the backend isn't
configured or a fetch fails.

The render pipeline (`renderSessionsTab`, etc.) calls `loadEvents(appKey)`
synchronously, so the pattern is: **fetch remote into a cache, then re-render.**

## 1. Add config + cache near the top (after the `APPS` array)

```js
// Network sink (same project the SDK posts to). Leave blank to stay
// localStorage-only.
var SUPABASE_URL = "https://ipyfodnidwsdvwqrcjrl.supabase.co";
var SUPABASE_KEY = "sb_publishable_yg4wjMwvGrlf5C9vqs2nkw_Hfks0Ux9";

var _remote = {};        // appKey -> [events] (mapped to the SDK event shape)
var _remoteLoaded = {};  // appKey -> bool
```

## 2. Replace `loadEvents(appKey)` so it prefers the remote cache

```js
function loadEvents(appKey) {
  // Remote cache wins once fetched; otherwise fall back to same-origin
  // localStorage (dev/offline).
  if (_remote[appKey]) return _remote[appKey];
  try {
    var raw = localStorage.getItem(appKey + "_sessions");
    if (!raw) return [];
    return JSON.parse(b64decode(raw));
  } catch (e) {
    return [];
  }
}
```

## 3. Add a remote fetch that maps columns back to the SDK event shape

Supabase columns `fn` / `event_ts` map back to the SDK's `function` / `timestamp`
(what the render functions expect).

```js
function fetchRemote(appKey, cb) {
  if (!SUPABASE_URL || !SUPABASE_KEY) { cb && cb(); return; }
  var url = SUPABASE_URL.replace(/\/+$/, "") +
    "/rest/v1/debughub_events?app=eq." + encodeURIComponent(appKey) +
    "&order=event_ts.asc&limit=1000";
  fetch(url, { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } })
    .then(function (r) { return r.ok ? r.json() : []; })
    .then(function (rows) {
      _remote[appKey] = (rows || []).map(function (r) {
        return {
          type: r.type, sessionId: r.session_id, app: r.app, sdkVersion: r.sdk_version,
          wallet: r.wallet, chainId: r.chain_id, timestamp: r.event_ts || new Date(r.created_at).getTime(),
          name: r.name, status: r.status, function: r.fn, code: r.code,
          message: r.message, label: r.label, durationMs: r.duration_ms
        };
      });
      _remoteLoaded[appKey] = true;
      cb && cb();
    })
    .catch(function () { cb && cb(); }); // fall back to localStorage on failure
}
```

## 4. Fetch before painting

Wherever the hub renders the active app (the `render()` / tab-switch handler and
the app-select `change` handler), fetch first if not yet loaded, then paint:

```js
function renderActive() {
  var appKey = state.selectedApp;
  if (!_remoteLoaded[appKey]) {
    fetchRemote(appKey, renderActive); // fill cache, then re-enter
    // optional: show a "Loading…" state here on first paint
  }
  // ... existing tab-render switch unchanged ...
}
```

Add a small **Refresh** affordance that clears the cache and refetches:

```js
function refresh() {
  var appKey = state.selectedApp;
  _remoteLoaded[appKey] = false;
  _remote[appKey] = null;
  renderActive();
}
```

That's the whole change — no new dependencies, same render code, same
`ERROR_EXPLANATIONS` catalog. The `Export JSON` button already serializes
`loadEvents(appKey)`, so it exports the remote data for free.

## Notes

- **Anon key is public by design.** RLS is the security boundary: anon can only
  `INSERT` events for whitelisted apps and `SELECT` diagnostics. It cannot
  update/delete. Embedding the key in client JS is the intended Supabase model.
- **localStorage stays** as an offline fallback in both SDK and hub, so nothing
  breaks if Supabase is unreachable.
- **The owner-wallet gate** (`gate.js`) is unchanged — it still restricts who
  can open the dashboard UI. It does not gate the data fetch (that's RLS).
