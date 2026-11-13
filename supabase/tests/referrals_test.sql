-- Scenario tests for 20261116000000_referrals.sql. Run against a scratch database
-- that has every migration applied (runs in a transaction and rolls back):
--   psql -d <scratch> -tA -f supabase/tests/referrals_test.sql   → "referral SQL: all N passed"
\set ON_ERROR_STOP 1
begin;
create temp table t_results (name text, got text, want text);
create or replace function pg_temp.chk(n text, g text, w text) returns void language sql as $$ insert into t_results values (n, g, w) $$;
-- addresses: R referrer, Q second referrer, E1..E6 referees, OLD veteran
insert into seasons (slug, name, status, start_round, min_rounds, weights) values
  ('old-s', 'Old', 'ended', 1, 2, '{}'), ('cur-s', 'Current', 'active', 1, 2,
  '{"round_played":250,"ticket_active":200,"referral_tier_tp":{"D":10,"C":40,"B":150,"A":700,"S":4000}}');
create temp table ids as select (select id from seasons where slug='old-s') old_id, (select id from seasons where slug='cur-s') cur_id;
-- referrer R on the board (3 rounds), Q on board, veteran played last season
insert into points_wallets (season_id, address, rounds_played) select cur_id, '0x'||repeat('a',40), 3 from ids;
insert into points_wallets (season_id, address, rounds_played) select cur_id, '0x'||repeat('b',40), 3 from ids;
insert into points_wallets (season_id, address, rounds_played) select old_id, '0x'||repeat('9',40), 4 from ids;
select points_recompute((select cur_id from ids));
select pg_temp.chk('R on board', (select (display_tp > 0)::text from points_wallets where address='0x'||repeat('a',40)), 'true');
-- codes
select pg_temp.chk('issue R', referral_issue_code((select cur_id from ids), '0x'||repeat('A',40), 'K7M2QX4', 'netR'), 'K7M2QX4');
select pg_temp.chk('reissue keeps code', referral_issue_code((select cur_id from ids), '0x'||repeat('a',40), 'ZZZZZZZ', 'netR2'), 'K7M2QX4');
select pg_temp.chk('reissue updates ip', (select ip_hash from referral_codes where address='0x'||repeat('a',40)), 'netR2');
select pg_temp.chk('issue Q', referral_issue_code((select cur_id from ids), '0x'||repeat('b',40), 'QQQQQQQ', 'netQ'), 'QQQQQQQ');
do $$ begin perform referral_issue_code((select cur_id from ids), '0x'||repeat('c',40), 'K7M2QX4', ''); raise exception 'no collision error'; exception when unique_violation then null; end $$;
-- binds
select pg_temp.chk('unknown code', referral_bind((select cur_id from ids), 'NOPE123', '0x'||repeat('1',40), 'n1'), 'unknown_code');
select pg_temp.chk('self', referral_bind((select cur_id from ids), 'k7m2qx4', '0x'||repeat('a',40), 'n1'), 'self');
select pg_temp.chk('same network as referrer', referral_bind((select cur_id from ids), 'K7M2QX4', '0x'||repeat('1',40), 'netR2'), 'same_network');
select pg_temp.chk('veteran not new', referral_bind((select cur_id from ids), 'K7M2QX4', '0x'||repeat('9',40), 'n9'), 'not_new');
select pg_temp.chk('E1 bound', referral_bind((select cur_id from ids), 'K7M2QX4', '0x'||repeat('1',40), 'shared'), 'bound');
select pg_temp.chk('E1 again (other code)', referral_bind((select cur_id from ids), 'QQQQQQQ', '0x'||repeat('1',40), 'shared'), 'already_bound');
select pg_temp.chk('E2 bound', referral_bind((select cur_id from ids), 'K7M2QX4', '0x'||repeat('2',40), 'shared'), 'bound');
select pg_temp.chk('E3 bound (to Q, same net)', referral_bind((select cur_id from ids), 'QQQQQQQ', '0x'||repeat('3',40), 'shared'), 'bound');
select pg_temp.chk('E4 capped (4th on net)', referral_bind((select cur_id from ids), 'K7M2QX4', '0x'||repeat('4',40), 'shared'), 'capped');
select pg_temp.chk('E5 bound (own net)', referral_bind((select cur_id from ids), 'K7M2QX4', '0x'||repeat('5',40), 'n5'), 'bound');
-- E6 already has 5 rounds this season → not new
insert into points_wallets (season_id, address, rounds_played) select cur_id, '0x'||repeat('6',40), 5 from ids;
select pg_temp.chk('E6 not new (5 rounds)', referral_bind((select cur_id from ids), 'K7M2QX4', '0x'||repeat('6',40), 'n6'), 'not_new');
-- play: E1 5 rounds, E2 4 rounds, E4 (capped) 5, E5 5 rounds
insert into points_wallets (season_id, address, rounds_played) select cur_id, '0x'||repeat(x,40), r from ids, (values ('1',5),('2',4),('4',5),('5',5)) v(x,r);
-- run 1: R NOT active → E1,E5 held; E2 still pending; E4 capped untouched
select referrals_apply((select cur_id from ids), array[]::text[]);
select pg_temp.chk('E1 held when R inactive', (select status from referrals where referee='0x'||repeat('1',40)), 'held');
select pg_temp.chk('E2 pending (<5)', (select status from referrals where referee='0x'||repeat('2',40)), 'pending');
select pg_temp.chk('E4 stays capped', (select status from referrals where referee='0x'||repeat('4',40)), 'capped');
select pg_temp.chk('R referrals 0 while held', (select referrals::text from points_wallets where address='0x'||repeat('a',40) and season_id=(select cur_id from ids)), '0');
-- run 2: R active (mixed case) → held become qualified
select referrals_apply((select cur_id from ids), array['0x'||repeat('A',40)]);
select pg_temp.chk('E1 qualified', (select status from referrals where referee='0x'||repeat('1',40)), 'qualified');
select pg_temp.chk('E5 qualified', (select status from referrals where referee='0x'||repeat('5',40)), 'qualified');
select pg_temp.chk('R referrals 2', (select referrals::text from points_wallets where address='0x'||repeat('a',40) and season_id=(select cur_id from ids)), '2');
select pg_temp.chk('tier at 2 = D', referral_tier(2), 'D');
select points_recompute((select cur_id from ids));
select pg_temp.chk('R tp = 3*250 + D bonus 10', (select display_tp::text from points_wallets where address='0x'||repeat('a',40) and season_id=(select cur_id from ids)), '760.00');
-- flagged referee is rejected
update points_wallets set sybil_flag='manual' where address='0x'||repeat('2',40);
select referrals_apply((select cur_id from ids), array['0x'||repeat('a',40)]);
select pg_temp.chk('flagged E2 rejected', (select status from referrals where referee='0x'||repeat('2',40)), 'rejected');
-- tier ladder
select pg_temp.chk('tiers', (select string_agg(coalesce(referral_tier(n),'-'), ',' order by n) from unnest(array[0,1,2,3,8,9,35,36,179,180,500]) n), '-,D,D,C,C,B,B,A,A,S,S');
-- off board referrer: Q's referee E3 reaches 5 while Q has display_tp 0 (flagged) → held
insert into points_wallets (season_id, address, rounds_played) select cur_id, '0x'||repeat('3',40), 5 from ids;
update points_wallets set sybil_flag='manual' where address='0x'||repeat('b',40);
select points_recompute((select cur_id from ids));
select referrals_apply((select cur_id from ids), array['0x'||repeat('b',40)]);
select pg_temp.chk('Q off board → held', (select status from referrals where referee='0x'||repeat('3',40)), 'held');
-- season ends → held expires, qualified kept
update seasons set status='ended' where slug='cur-s';
select referrals_apply((select cur_id from ids), array[]::text[]);
select pg_temp.chk('held expires at season end', (select status from referrals where referee='0x'||repeat('3',40)), 'expired');
select pg_temp.chk('qualified kept at season end', (select status from referrals where referee='0x'||repeat('1',40)), 'qualified');
select coalesce(string_agg(format('FAIL %s: got %s want %s', name, got, want), E'\n'), format('referral SQL: all %s passed', (select count(*) from t_results))) from t_results where got is distinct from want;
rollback;
