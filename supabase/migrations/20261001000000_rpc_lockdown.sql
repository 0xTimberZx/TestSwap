-- Lock every SECURITY DEFINER RPC to the service role.
--
-- Postgres grants EXECUTE on new functions to PUBLIC by default, and PostgREST
-- exposes every public-schema function at /rest/v1/rpc/<name>. Only the airdrop
-- migration revoked that default; the faucet, waitlist and points RPCs could be
-- called by anyone holding the publishable key, bypassing the Worker, Turnstile
-- and the edge functions' checks (points inflation, cooldown burning, waitlist
-- overwrite). Every legitimate caller (edge functions, keepers) uses the
-- service role, so nothing legitimate loses access.
--
-- `create or replace` keeps privileges; `drop` + `create` resets them. Re-apply
-- this block whenever one of these functions is dropped and recreated.

revoke execute on function
  public.reserve_faucet_claim(text, numeric, numeric),
  public.expire_stale_reservations(),
  public.add_to_waitlist(text,text,text,text,text,text,text,text,text,text,text),
  public.points_apply_round(bigint, bigint, text[]),
  public.points_apply_swaps(bigint, jsonb),
  public.points_apply_wins(bigint, jsonb),
  public.points_apply_flags(bigint, jsonb),
  public.points_apply_activity(bigint, jsonb),
  public.points_fold_faucet(bigint, timestamptz),
  public.points_recompute(bigint),
  public.points_wallet_rank(bigint, text)
from public, anon, authenticated;

grant execute on function
  public.reserve_faucet_claim(text, numeric, numeric),
  public.expire_stale_reservations(),
  public.add_to_waitlist(text,text,text,text,text,text,text,text,text,text,text),
  public.points_apply_round(bigint, bigint, text[]),
  public.points_apply_swaps(bigint, jsonb),
  public.points_apply_wins(bigint, jsonb),
  public.points_apply_flags(bigint, jsonb),
  public.points_apply_activity(bigint, jsonb),
  public.points_fold_faucet(bigint, timestamptz),
  public.points_recompute(bigint),
  public.points_wallet_rank(bigint, text)
to service_role;

-- Future functions in public default to no anon/authenticated execute.
alter default privileges in schema public
  revoke execute on functions from public, anon, authenticated;
