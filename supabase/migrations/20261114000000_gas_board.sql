-- Gas request board (testnet onboarding, step 2 of /start).
--
-- Public faucets now require a mainnet balance, which blocks newcomers. A
-- newcomer posts their address here; anyone can send them 0.003 test ETH on
-- Arbitrum Sepolia and paste the transaction hash, which the `gas-board` edge
-- function verifies on chain before marking the request filled. Requests still
-- open after 6 hours are filled by the team's fallback keeper
-- (scripts/gas-board-fallback.js). Requests expire after 48 hours.
--
-- Only the service role (the edge function) touches this table: RLS is on and
-- there is no anon or authenticated policy.

create table if not exists public.gas_requests (
  id             bigserial primary key,
  address        text        not null check (address ~ '^0x[0-9a-f]{40}$'),
  status         text        not null default 'open'
                             check (status in ('open', 'filled', 'expired')),
  created_at     timestamptz not null default now(),
  ip_hash        text        not null default '',
  filled_tx      text        unique,
  filled_by      text,
  filled_by_team boolean     not null default false,
  filled_at      timestamptz
);

-- One open request per address.
create unique index if not exists gas_requests_one_open
  on public.gas_requests (address) where status = 'open';

-- Per-network rate limit lookups.
create index if not exists gas_requests_ip_recent
  on public.gas_requests (ip_hash, created_at);

-- The board lists open requests oldest first.
create index if not exists gas_requests_open_age
  on public.gas_requests (created_at) where status = 'open';

alter table public.gas_requests enable row level security;
revoke all on public.gas_requests from anon, authenticated;
