-- Live "👁️ watching" count on /compete.
--
-- One row per open browser tab (sid = a random id the page makes per tab).
-- The page heartbeats every 15 s while visible; a tab counts as watching when
-- its last heartbeat is under 30 s old. A tab that closes or hides sends a
-- leave and its row is deleted; one that just vanishes ages out after 30 s.
-- Rows older than 2 minutes are pruned by the presence edge function.
--
-- Only the service role touches this table (RLS on, no policies), through the
-- `presence` edge function behind the /api/presence Worker route. No wallet
-- address or raw IP is stored: ip_hash is a salted SHA-256 used only to cap
-- how many tabs one IP can count.

create table if not exists public.presence (
  sid       uuid        primary key,
  page      text        not null check (page in ('compete')),
  ip_hash   text        not null,
  last_seen timestamptz not null default now()
);

create index if not exists presence_page_seen_idx on public.presence (page, last_seen);
create index if not exists presence_ip_seen_idx   on public.presence (ip_hash, last_seen);

alter table public.presence enable row level security;
