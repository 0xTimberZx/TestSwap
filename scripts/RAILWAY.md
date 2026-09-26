# Keepers on Railway

The keeper fleet ran on GitHub Actions as self-chaining workflows. On
2026-09-25 GitHub disabled Actions and Pages on the account after ~124k
runner-minutes in a month (all discounted, all public, still enough to trip
the abuse heuristic). The site moved to Cloudflare Pages; the keepers move
here. Nothing in the keeper scripts changed: `scripts/keeper-loop.js` runs
the same script the workflow ran, pauses the same interval, and repeats.

Everything below is done in a browser. No terminal is needed.

## One-time: project and repo

1. railway.app → New Project → Deploy from GitHub repo → authorise Railway for
   **TestSwap** only → select it.
2. Railway creates one service. Rename it `settler` (Settings → Service name).
3. Settings → **Root Directory**: `scripts`. Railway now reads
   `scripts/railway.json` for the build and start commands, so leave those
   fields empty.
4. Variables → add the ones in the table below for this service → Deploy.
5. Logs should show `[loop] keeper=settler pause=1m` then the familiar
   `[settler] Round #…` lines within a minute.

## Each further keeper

New → GitHub repo → TestSwap again → same Root Directory `scripts` → set
`KEEPER` to the service name → paste that keeper's variables → Deploy.
One service per keeper. **Never run two settlers.**

| Service (KEEPER) | What it replaces | Variables |
|---|---|---|
| `settler` | settler.yml | `ARB_SEPOLIA_RPC`, `SETTLER_PRIVATE_KEY`, `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`, `X_POST_MODE=all`, optional `X_HASHTAGS`, `X_HASHTAGS_WINNER`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_CHAT_ID_PUBLIC`, `TELEGRAM_OPS_MODE` |
| `faucet` | faucet.yml | `ARB_SEPOLIA_RPC`, `FAUCET_DISPATCHER_PRIVATE_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, optional `FAUCET_DRAIN_LIMIT`, `FAUCET_POLL_SECONDS`, `FAUCET_LINGER_MINUTES`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| `points-scorer` | points-scorer.yml | `ARB_SEPOLIA_RPC`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, optional `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| `match-notifier` | match-notifier.yml | `ARB_SEPOLIA_RPC`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME=SettlerTimbBot`, optional `TELEGRAM_CHAT_ID` |
| `reclaim-reminder` | reclaim-reminder.yml | same as match-notifier |

Values are the same strings that were in GitHub → Settings → Secrets and
Variables. `DISPATCH_TOKEN` and the `*_LINGER_MINUTES` self-chain knobs are
not needed; the loop does that job.

Tip: Railway's **Shared Variables** (project level) hold `ARB_SEPOLIA_RPC`,
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and the Telegram pair once, and each
service references them, so a key rotation is one edit.

## Not yet moved

`epoch`, `bounty-post`, and the reconcilers write `scripts/*-state.json`,
which the workflows committed back to git. On Railway that file lives on the
container and is lost on every redeploy. Before enabling any of them, attach
a Volume to the service, mount it at `/data`, and point the keeper's state
path at it. Until then these stay off; nothing about the game depends on them
hour to hour.

`fleet-heartbeat`, `dead-man`, and `settler-liveness` watched GitHub Actions
runs and have nothing to watch here. Railway's own service health panel and
log alerts cover the same ground. Leave them off.

## Cost

Hobby plan, $5/month, covers all five services. Each idles at a few MB of RAM
between boundaries.

## Rollback

Stop a service in Railway (Settings → Remove, or scale to zero). The GitHub
workflows are untouched and resume the moment Actions is re-enabled, so never
run both at once: pick one host per keeper.
