# Keeper fleet — checks and balances without coupling

The automation runs as GitHub Actions cron jobs: no server, no daemon, each
job a fresh checkout that reads `config.js`, does one thing, and exits. This
document is the operating model for that fleet: what each job is, how they
watch each other, and the rules that let them cross-check without any of them
depending on another to succeed.

## 1. The fleet

| Job | Workflow | Cadence | Kind | Holds a key | Own state |
|---|---|---|---|---|---|
| Settler | `settler.yml` | 10 min, lingers across segments; noon health | writer | settler key | none (chain is the state) |
| Epoch keeper | `epoch.yml` | every 2 h | writer | epoch key | `epoch-state.json` |
| Faucet keeper | `faucet.yml` | 10 min | writer | faucet dispatcher key | Supabase `faucet_claims` |
| Fund rewards, boost window | `admin-*.yml` | manual | writer | epoch key | none |
| Match notifier | `match-notifier.yml` | lingers 55 min, self-chains; 15 min cron backstop | notifier | none | Supabase |
| Reclaim reminder | `reclaim-reminder.yml` | lingers 55 min on the round clock, self-chains; hourly cron backstop | notifier | none | Supabase |
| Points scorer | `points-scorer.yml` | hourly | notifier | none | Supabase cursors |
| Faucet invariants | `faucet-invariants.yml` | every 6 h | witness | none | `faucet-invariants-state.json` |
| Fleet heartbeat | `fleet-heartbeat.yml` | twice an hour | witness | none | `fleet-heartbeat-state.json` |

Three kinds:

- **Writers** hold a key and change chain state. They are the only jobs that
  can do damage, so they are the only jobs that get isolation guarantees.
- **Notifiers** read the chain and write to Supabase or Telegram. A wrong
  notifier annoys; it cannot lose funds.
- **Witnesses** read the chain, the database, or the Actions API, recompute
  what should be true, and alert on disagreement. They never act.

## 2. The rules

1. **Writers act. Witnesses alert.** A witness never calls a contract, never
   re-dispatches a workflow, never edits another job's state. The settler's
   self-chain is the one job that triggers another, and it triggers only itself,
   only on success.
2. **Every job owns exactly one state file, and nobody else reads it.** The
   epoch keeper's cursor is the epoch keeper's. A witness that wants to check
   the epoch recomputes from chain events; it does not read
   `epoch-state.json` to decide what to expect, because a wrong cursor would
   then look right to the thing meant to catch it.
3. **The only shared input is `config.js`.** It is the frontend's source of
   truth for addresses, so a keeper and the site cannot disagree about which
   contract is live. Every reader tolerates the file's previous shape and falls
   back to a known default rather than refusing to start.
4. **State carries its deployment identity** (chain id, contract address) and
   is discarded when that identity changes. A redeploy must never be read
   through the old deployment's cursor.
5. **A run that dies before its first save leaves its state untouched**, so the
   next run resumes from the last good run. Commit-back steps run `if:
   always()` and skip cleanly when there is nothing to commit.
6. **Reads go through the canonical public RPC; only transactions may use a
   keyed endpoint.** Metered endpoints cap `eth_getLogs` to a handful of blocks
   and every backfill is tens of thousands wide.
7. **Witnesses run a few minutes after the writer they watch**, plus one
   confirmation window, so they see the writer's result instead of racing it.
   Cron minutes are staggered on purpose: writers on `:00`-style ticks, the
   heartbeat at `:09` and `:39`, the invariants monitor at `:23`.
8. **Alerts are throttled per key, and a recovery is announced once.** A keeper
   that stays down produces one message per re-alert interval, not one per run.
9. **A Telegram failure never fails a job.** Sends are best-effort, Markdown
   retries as plain text, and the ops-mode switch (`all` / `errors` / `off`)
   never touches the community stream.

The point of the rules is symbiosis without dependence: two jobs can
observe the same chain and disagree, and the disagreement is the signal.
Neither needs the other to have run.

## 3. The heartbeat

`scripts/fleet-heartbeat.js` is the witness for absence. A keeper can report
its own errors but not that it was never scheduled, which is the fleet's most
common failure: GitHub throttles cron unpredictably (a 2.4-hour hole was
observed), a lingering run hits its timeout, or a keeper fails fast on every
tick.

For each scheduled workflow it reads the last fifteen runs from the Actions
API and classifies:

| Finding | Meaning |
|---|---|
| `stale` | nothing running and the last success started more than `max(cadence × slack, grace)` minutes ago, or there is no success at all |
| `failing` | the most recent completed runs are all failures (cancelled and skipped runs are ignored; concurrency groups cancel redundant backstops by design) |
| `runaway` | more than a handful of completed runs started inside one cadence window: a self-chain gone tight, a cron misfire, or a dispatch loop. Green runs count; cancelled backstops do not. Outranks every other finding |
| `unknown` | the API could not be read for that workflow |

Defaults: slack 3 cadences, grace 30 minutes, three failures make a streak,
four completions in one cadence are a runaway, re-alert every 6 hours. The
runaway finding exists because of an incident: a zero-minute linger once
chained the notifier and the reminder into a run every fifteen seconds, every
run green, and nothing in the fleet could have said so. Absence and failure
were watched; excess was not. The invariants monitor carries a per-entry slack of 2
so a six-hour job is not eighteen hours late before anyone hears. A run that
is in progress counts as alive at any age: the settler lingers across
segments by design and its own timeout bounds it.

It exits non-zero on any finding, so the heartbeat run itself shows red in
Actions. It needs no private key and no npm install: only the repo's own
token with `actions: read`.

**Blind spot, by construction.** If GitHub stops firing cron entirely, the
heartbeat stops with everything else. The only guard for that is an external
dead-man's switch that expects a call from this job and alerts when it
does not arrive. Not wired yet; the hook is a one-line `curl` at the end of
the check step.

## 4. The library

`scripts/lib/` is the plumbing every job shares, extracted so a new witness
is a page of logic rather than a page of logic plus a page of boilerplate:

| Module | Provides |
|---|---|
| `config.js` | `addrFromConfig(key)` (refuses the zero address), `rpcFromConfig()` (literal → `PUBLIC_RPCS[0]` → canonical) |
| `logs.js` | `scanLogs` / `scanEvents` / `sumEvents` in bounded chunks, `blockTimestamps` batched per distinct block; provider errors surfaced with the RPC's own message |
| `state.js` | `loadState(file, fresh, { matches })` that discards a file from another deployment, `saveState` |
| `telegram.js` | `makeTelegram({ token, chatId, mode })` with `send` / `notify`, and `shouldRealert` |

The heartbeat is its first consumer. The invariants monitor, the epoch keeper,
and the settler still carry their own copies of these functions; they migrate
one at a time, each in its own PR, with a live dispatch after merge as the
gate, because none of them can be exercised end to end outside CI.

The convention the invariants monitor set applies to every witness: pure
logic exported, a `--self-test` of synthetic cases that runs in the workflow
before the live check, and a `--dry-run` that reads everything and writes
nothing.

## 5. Witnesses still to build

Each of these shares a clock with a writer and catches a failure the writer
cannot see in itself. None of them can block the writer.

- **Settler liveness.** Every 15 minutes read the prize contract's current
  segment and its open time; alert if a segment is overdue by more than a few
  minutes or the last settled round has fewer than six locked segments. The
  self-chain covers scheduling gaps only on a successful run; this catches the
  run that happens and fails silently. Keep it separate from the match notifier
  so a notifier bug never hides a stuck settler.
- **Epoch reconciliation.** After each epoch boundary, recompute the waterfall
  input from buyback events independently and compare it to the reward-added
  events on the farm and staking contracts, and the period end the contracts
  now hold. The state file says what the keeper believed; the chain says what
  happened. The stale-cursor incident that produced the reset detection is
  exactly this class.
- **Faucet three-way.** The invariants monitor reconciles events against the
  contract's tally. Add the database leg: every claim marked dispensed in
  Supabase has a matching event, and no event lacks a row. Two of three
  disagreeing says which leg lied.
- **Points spot check.** Recompute one or two wallets' points from events each
  hour and compare to the leaderboard row. Catches cursor drift in the scorer
  the same way epoch drift was caught.
- **External dead-man's switch** for the heartbeat itself (§3).
