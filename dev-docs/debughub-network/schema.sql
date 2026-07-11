-- DebugHub network sink — Supabase schema
-- Project: 0xTimberZx's Project (ref ipyfodnidwsdvwqrcjrl)
-- Already applied to that project via migrations:
--   create_debughub_events, tighten_debughub_insert_policy
-- Kept here so the table is reproducible and reviewable in-repo.

create table if not exists public.debughub_events (
  id           bigint generated always as identity primary key,
  app          text        not null,
  type         text        not null,
  session_id   text,
  wallet       text,
  chain_id     integer,
  sdk_version  text,
  name         text,
  status       text,
  fn           text,          -- source function for error events (SDK field: function)
  code         text,
  message      text,
  label        text,
  duration_ms  integer,
  event_ts     bigint,        -- client-provided ms epoch (SDK field: timestamp)
  created_at   timestamptz not null default now(),

  constraint debughub_app_allowed
    check (app in ('Faucet','BlockpotDAO','MessageBoard','TimbSwap','TestApp')),
  constraint debughub_type_allowed
    check (type in ('session_start','session_end','checkpoint','security','error','perf')),
  constraint debughub_message_len check (message is null or length(message) <= 2000),
  constraint debughub_name_len    check (name    is null or length(name)    <= 200)
);

create index if not exists debughub_events_app_created_idx
  on public.debughub_events (app, created_at desc);
create index if not exists debughub_events_session_idx
  on public.debughub_events (session_id);

alter table public.debughub_events enable row level security;

-- Anonymous clients may append events for known apps and known types only.
drop policy if exists debughub_anon_insert on public.debughub_events;
create policy debughub_anon_insert
  on public.debughub_events
  for insert to anon
  with check (
    app in ('Faucet','BlockpotDAO','MessageBoard','TimbSwap','TestApp')
    and type in ('session_start','session_end','checkpoint','security','error','perf')
  );

-- Diagnostics are non-sensitive; the hub reads them back with the anon key.
drop policy if exists debughub_anon_select on public.debughub_events;
create policy debughub_anon_select
  on public.debughub_events
  for select to anon
  using (true);

-- OPTIONAL: cap table growth. Supabase supports pg_cron. Uncomment to keep
-- only the last 30 days of telemetry (run in the SQL editor once):
--   select cron.schedule('debughub_prune', '0 4 * * *',
--     $$delete from public.debughub_events where created_at < now() - interval '30 days'$$);
