# DebugHub relay

Deploy `debughub-relay.js` as a Cloudflare Worker on:

`https://timbswap.xyz/api/debughub_events`

Set these Worker secrets:

- `SUPABASE_URL`: the Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: the Supabase service-role key

The service-role key must remain in Worker secrets and must never be added to
frontend JavaScript. The Worker accepts only `POST` telemetry for `TimbSwap`,
limits payloads to 32 KiB, and allows the custom domain plus GitHub Pages
origins. The frontend keeps a temporary direct PostgREST fallback so deployment
can be rolled out without dropping events; remove that fallback only after the
relay returns successful responses from both published hosts.

The current GitHub Pages deployment cannot serve `/api` itself. Configure the
Worker route at the DNS/edge layer before treating the first-party path as the
production-only transport.
