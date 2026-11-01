-- Team wallets never rank on the points board.
--
-- The board already drops any wallet whose sybil_flag is set (the quests edge
-- function filters on it, and points_recompute scores a flagged wallet 0), but
-- the flag was manual and per row: a team wallet only gets a row once it plays,
-- so every new deployer, keeper or test wallet had to be caught by hand.
--
-- points_team_wallets is the standing list. A wallet on it is flagged 'team':
--   * on insert into points_wallets (any season, including one not yet started);
--   * at once, in every season, when the address is added to the list.
-- No points_apply_* upsert writes sybil_flag, so the flag is never cleared by
-- scoring. Removing an address from the list does not unflag it; clear the
-- flag by hand if that is wanted.
--
-- The list holds no names and is service-role only (RLS on, no policies).

create table if not exists public.points_team_wallets (
  address  text primary key check (address ~ '^0x[0-9a-f]{40}$'),
  reason   text not null,
  added_at timestamptz not null default now()
);
alter table public.points_team_wallets enable row level security;

create or replace function public.points_flag_team_wallet()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.sybil_flag is null
     and exists (select 1 from points_team_wallets t where t.address = lower(new.address)) then
    new.sybil_flag := 'team';
  end if;
  return new;
end;
$$;

drop trigger if exists points_wallets_team_flag on public.points_wallets;
create trigger points_wallets_team_flag
  before insert on public.points_wallets
  for each row execute function public.points_flag_team_wallet();

create or replace function public.points_team_wallet_added()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  update points_wallets
     set sybil_flag = 'team', display_tp = 0
   where address = new.address and sybil_flag is null;
  return new;
end;
$$;

drop trigger if exists points_team_wallets_flag_existing on public.points_team_wallets;
create trigger points_team_wallets_flag_existing
  after insert on public.points_team_wallets
  for each row execute function public.points_team_wallet_added();

revoke execute on function
  public.points_flag_team_wallet(),
  public.points_team_wallet_added()
from public, anon, authenticated;
