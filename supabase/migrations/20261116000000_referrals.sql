-- Referrals: one code per wallet per season, tallies D → S, credited only while
-- the referrer is on the board with an Active ticket.
--
-- Flow (edge function `referrals`, keeper scripts/points-scorer.js):
--   1. A wallet on the season board gets a code (referral_issue_code). The code is
--      fixed for that wallet for the season; a new season gives a new code.
--   2. A visitor arrives with ?r=CODE. After their first ticket (Pending or
--      Active) they confirm with a signature and referral_bind locks the referrer
--      for the season: first code wins, once.
--        - at most 3 credited referrals per network (salted IP hash) per season;
--          a 4th wallet on the same network is bound as 'capped' and never credits
--        - no self-referral (same wallet, or the referrer's own network)
--        - the referee must be new: no rounds in an earlier season and fewer than
--          5 rounds this season
--   3. Each scorer run, referrals_apply moves a referral whose referee has played
--      5 rounds to 'qualified' if the referrer is on the board with an Active
--      ticket, otherwise to 'held' (waits; credited when the referrer is back).
--      Waiting rows expire when their season ends.
--   4. points_wallets.referrals = qualified count (capped at 180). Tiers are read
--      off that count (horizontal): D 1, C 3, B 9, A 36, S 180 (max).
--   5. points_recompute adds seasons.weights->'referral_tier_tp'->>tier for the
--      highest tier reached. Unset weights add nothing.
--
-- Service-role only: RLS on, no policies, anon/authenticated revoked.

create table if not exists public.referral_codes (
  season_id  bigint not null references public.seasons(id) on delete cascade,
  address    text   not null check (address ~ '^0x[0-9a-f]{40}$'),
  code       text   not null check (code ~ '^[0-9A-HJKMNP-TV-Z]{7,8}$'),
  ip_hash    text   not null default '',           -- latest network that opened the card (self-referral check)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (season_id, address),
  unique (season_id, code)
);

create table if not exists public.referrals (
  id           bigserial primary key,
  season_id    bigint not null references public.seasons(id) on delete cascade,
  code         text   not null,
  referrer     text   not null check (referrer ~ '^0x[0-9a-f]{40}$'),
  referee      text   not null check (referee ~ '^0x[0-9a-f]{40}$'),
  ip_hash      text   not null default '',
  status       text   not null default 'pending'
                 check (status in ('pending', 'held', 'qualified', 'capped', 'expired', 'rejected')),
  reason       text,
  bound_at     timestamptz not null default now(),
  qualified_at timestamptz,
  unique (season_id, referee),
  check (referrer <> referee)
);
create index if not exists referrals_by_referrer on public.referrals (season_id, referrer, status);
create index if not exists referrals_by_network  on public.referrals (season_id, ip_hash);

alter table public.referral_codes enable row level security;
alter table public.referrals      enable row level security;
revoke all on public.referral_codes from anon, authenticated;
revoke all on public.referrals      from anon, authenticated;

-- Tier for a qualified count (horizontal: D's group into C, and so on).
create or replace function public.referral_tier(n integer)
returns text language sql immutable as $$
  select case
    when n >= 180 then 'S'
    when n >= 36  then 'A'
    when n >= 9   then 'B'
    when n >= 3   then 'C'
    when n >= 1   then 'D'
  end
$$;

-- Issue (or return) a wallet's code for the season. The code is computed by the
-- edge function; the first one stored wins, so it never changes mid-season.
-- Raises unique_violation if another wallet already holds p_code (the caller
-- retries with a longer code).
create or replace function public.referral_issue_code(p_season bigint, p_address text, p_code text, p_ip_hash text)
returns text language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  insert into referral_codes (season_id, address, code, ip_hash)
    values (p_season, lower(p_address), upper(p_code), coalesce(p_ip_hash, ''))
  on conflict (season_id, address) do update
    set ip_hash = case when excluded.ip_hash <> '' then excluded.ip_hash else referral_codes.ip_hash end,
        updated_at = now()
  returning code into v_code;
  return v_code;
end; $$;

-- Bind a referee to the code they arrived with. Returns:
--   'bound'          recorded; credits once the referee plays 5 rounds
--   'capped'         recorded, but the network already has 3 referred wallets
--   'already_bound'  this referee already has a referrer this season
--   'unknown_code'   no such code this season
--   'self'           the referee is the code's owner
--   'same_network'   the referee is on the referrer's own network
--   'not_new'        the referee played in an earlier season or already has 5 rounds
-- The edge function checks the signature and that the referee holds a ticket.
create or replace function public.referral_bind(p_season bigint, p_code text, p_referee text, p_ip_hash text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_referee  text := lower(p_referee);
  v_ip       text := coalesce(p_ip_hash, '');
  v_referrer text;
  v_ref_ip   text;
  v_net      integer;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_referrals_' || p_season::text));

  select address, ip_hash into v_referrer, v_ref_ip
    from referral_codes where season_id = p_season and code = upper(p_code);
  if v_referrer is null then return 'unknown_code'; end if;
  if v_referrer = v_referee then return 'self'; end if;
  if exists (select 1 from referrals where season_id = p_season and referee = v_referee) then
    return 'already_bound';
  end if;
  if v_ip <> '' and v_ip = v_ref_ip then return 'same_network'; end if;
  if exists (select 1 from points_wallets
              where address = v_referee
                and ((season_id <> p_season and rounds_played > 0)
                  or (season_id = p_season and rounds_played >= 5))) then
    return 'not_new';
  end if;

  if v_ip <> '' then
    select count(*) into v_net from referrals
     where season_id = p_season and ip_hash = v_ip and status <> 'capped';
  else
    v_net := 0;
  end if;

  insert into referrals (season_id, code, referrer, referee, ip_hash, status, reason)
    values (p_season, upper(p_code), v_referrer, v_referee, v_ip,
            case when v_net >= 3 then 'capped' else 'pending' end,
            case when v_net >= 3 then '3 referred wallets on this network already' end);
  return case when v_net >= 3 then 'capped' else 'bound' end;
end; $$;

-- Scorer step, run before points_recompute. p_active: referrers whose ticket is
-- Active right now (read on chain by the keeper).
create or replace function public.referrals_apply(p_season bigint, p_active text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_active text[] := array(select lower(a) from unnest(coalesce(p_active, '{}'::text[])) a);
  v_expired integer; v_rejected integer; v_qualified integer; v_held integer;
begin
  perform pg_advisory_xact_lock(hashtext('timbswap_referrals_' || p_season::text));

  -- Waiting rows of finished seasons expire.
  update referrals set status = 'expired', reason = 'season ended'
   where status in ('pending', 'held')
     and season_id in (select id from seasons where status = 'ended');
  get diagnostics v_expired = row_count;

  -- A flagged referee never credits.
  update referrals r set status = 'rejected', reason = 'referee flagged'
    from points_wallets pw
   where r.season_id = p_season and r.status in ('pending', 'held')
     and pw.season_id = r.season_id and pw.address = r.referee and pw.sybil_flag is not null;
  get diagnostics v_rejected = row_count;

  -- Referee has played 5 rounds: credit if the referrer is on the board with an
  -- Active ticket, otherwise hold until they are.
  with ready as (
    select r.id,
           exists (select 1 from points_wallets me
                    where me.season_id = p_season and me.address = r.referrer
                      and me.sybil_flag is null and me.display_tp > 0)
           and r.referrer = any(v_active) as can_credit
      from referrals r
      join points_wallets pw on pw.season_id = r.season_id and pw.address = r.referee
     where r.season_id = p_season and r.status in ('pending', 'held')
       and pw.sybil_flag is null and pw.rounds_played >= 5
  )
  update referrals r
     set status       = case when ready.can_credit then 'qualified' else 'held' end,
         qualified_at = case when ready.can_credit then now() end,
         reason       = case when ready.can_credit then null else 'referrer off the board or ticket not active' end
    from ready
   where r.id = ready.id;

  select count(*) filter (where status = 'qualified'), count(*) filter (where status = 'held')
    into v_qualified, v_held
    from referrals where season_id = p_season;

  -- Feed the counter the board and points read (capped at S).
  update points_wallets pw
     set referrals = least(coalesce(q.n, 0), 180)
    from (select w.address,
                 (select count(*) from referrals r
                   where r.season_id = p_season and r.referrer = w.address and r.status = 'qualified') as n
            from points_wallets w where w.season_id = p_season) q
   where pw.season_id = p_season and pw.address = q.address
     and pw.referrals is distinct from least(coalesce(q.n, 0), 180);

  return jsonb_build_object('expired', v_expired, 'rejected', v_rejected,
                            'qualified_total', v_qualified, 'held_total', v_held);
end; $$;

-- points_recompute, unchanged from 20261018000000 except for the referral tier
-- bonus (seasons.weights.referral_tier_tp, e.g. {"D":50,"C":150,...}; unset = 0).
create or replace function points_recompute(p_season bigint)
returns integer language plpgsql security definer set search_path = public as $$
declare w jsonb; v_min integer; c integer;
begin
  select weights, min_rounds into w, v_min from seasons where id = p_season;
  update points_wallets pw set
    diversity = ((case when pw.swap_count > 0 then 1 else 0 end) + (case when pw.rounds_played >= 1 then 1 else 0 end) + (case when pw.did_stake then 1 else 0 end) + (case when pw.did_lp then 1 else 0 end) + (case when pw.did_lock then 1 else 0 end)) >= 3,
    display_tp = case
      when pw.sybil_flag is not null then 0
      when pw.rounds_played < coalesce(v_min, 0) then 0
      else round((
          pw.meter_tp
        + greatest(pw.rounds_played - pw.tickets_activated, 0)
                                * coalesce((w->>'round_played')::numeric,  250)
        + pw.tickets_activated * coalesce((w->>'ticket_active')::numeric, 200)
        + pw.farm_claims       * coalesce((w->>'farm_claim')::numeric,     50)
        + pw.stake_claims      * coalesce((w->>'stake_claim')::numeric,    25)
        + pw.faucet_claims     * coalesce((w->>'faucet_claim')::numeric,    1)
        + pw.wins              * coalesce((w->>'win')::numeric,             0)
        + coalesce((w->'referral_tier_tp'->>referral_tier(least(pw.referrals, 180)))::numeric, 0)
      )::numeric, 2)
    end,
    updated_at = now()
  where pw.season_id = p_season;
  get diagnostics c = row_count;
  return c;
end; $$;

revoke execute on function public.referral_issue_code(bigint, text, text, text) from public, anon, authenticated;
revoke execute on function public.referral_bind(bigint, text, text, text)       from public, anon, authenticated;
revoke execute on function public.referrals_apply(bigint, text[])                from public, anon, authenticated;
