# TimbSwap first-party API (Cloudflare Worker)

`timbswap-api.js` serves the app's backend calls from the site's **own origin**
so Brave Shields / adblockers can't throttle or block them (they were failing as
third-party calls to Alchemy/Supabase). It handles the POST routes below and passes
everything else through to the origin (GitHub Pages):

| Route | Forwards to | Purpose |
|-------|-------------|---------|
| `POST /api/rpc` | Alchemy JSON-RPC (`ALCHEMY_RPC_URL`) | all on-chain reads (single + batch) |
| `POST /api/waitlist` | Supabase `waitlist` edge fn (`WAITLIST_UPSTREAM`) | mainnet signup capture |
| `POST /api/quests` | Supabase `quests` edge fn (`QUESTS_UPSTREAM`) | Timber Points leaderboard read |
| `POST /api/faucet-claim` | Supabase `faucet-claim` edge fn (`FAUCET_UPSTREAM`) | testnet faucet claim (Turnstile-gated) |

Because `/api/*` is **same-origin** with the site, the browser skips CORS and
Brave treats it as first-party — the RPC issues (and the signup / claim POSTs)
disappear for every browser. For `/api/waitlist` and `/api/faucet-claim` the Worker
also forwards the caller's real IP (`X-Real-IP`) and, for the waitlist, country
(`X-Client-Country`) — which only Cloudflare sees — plus an optional `X-Proxy-Secret`,
so the public Supabase functions can trust only proxied calls. See `dev-docs/WAITLIST.md`.

> **Not served:** `POST /api/debughub_events` (DebugHub telemetry sink). Client
> telemetry is localStorage-only during the capped beta (see `config.js`), so there
> is no sink and no `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` secret on the Worker.
> See `SECURITY.md` before adding one (harden it and bring it into bounty scope first).

## Migration steps (one-time)

1. **Move `timbswap.xyz` to Cloudflare (free plan).**
   - Add the site in the Cloudflare dashboard; it imports your existing DNS.
   - Change the domain's nameservers (at your registrar) to the two Cloudflare
     nameservers Cloudflare shows you. Wait for "Active" (usually minutes–hours).
   - Keep the GitHub Pages records **Proxied** (orange cloud) so the Worker route
     can sit in front. GitHub Pages custom-domain setup is unchanged.

2. **Deploy the Worker.**
   ```sh
   cd workers
   npx wrangler login
   npx wrangler secret put ALCHEMY_RPC_URL            # the keyed Alchemy Arb-Sepolia URL
   # Upstreams (WAITLIST_UPSTREAM / QUESTS_UPSTREAM / FAUCET_UPSTREAM) live in wrangler.toml [vars]; then
   npx wrangler secret put WAITLIST_PROXY_SECRET      # optional; must match the waitlist fn
   npx wrangler secret put FAUCET_PROXY_SECRET        # optional; must match the faucet-claim fn
   npx wrangler deploy
   ```
   `wrangler.toml` already pins the route `timbswap.xyz/api/*` and the entrypoint.

3. **Smoke-test the routes** (from any terminal):
   ```sh
   # RPC — expect {"jsonrpc":"2.0","id":1,"result":"0x66eee"}
   curl -s https://timbswap.xyz/api/rpc \
     -H 'content-type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'

   # Waitlist — expect {"ok":true,"status":"new"}
   curl -s https://timbswap.xyz/api/waitlist \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","source":"smoke-test"}'
   ```

4. **Tell Claude "Cloudflare is live"** and the config flip lands:
   - `config.js`: `DEDICATED_RPC` → `https://timbswap.xyz/api/rpc`
   - `config.js` DebugHub: `telemetryUrl` → `https://timbswap.xyz/api/debughub_events`

   Until that flip, the app keeps using the Supabase-hosted proxy + direct
   telemetry, so nothing breaks while DNS propagates.

## Notes
- The service-role key stays a Worker secret — never in page JS. (Anon key also
  works, since RLS already allows the telemetry insert; service-role is what the
  earlier relay used.)
- The `ALCHEMY_RPC_URL` upstream is a public frontend RPC regardless; keeping it
  a Worker secret just lets you rotate it without a redeploy of the site.
- The full waitlist deploy (DB migration + edge function + Worker) is documented
  in `dev-docs/WAITLIST.md`.
- Supersedes the earlier standalone `debughub-relay.js`; the telemetry relay it
  folded in has since been removed (see the note above).
