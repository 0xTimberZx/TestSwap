-- Supabase RLS hardening — project ipyfodnidwsdvwqrcjrl
-- ─────────────────────────────────────────────────────────────────────────────
-- ✅ APPLIED 2026-07-17 as migration `enable_rls_readonly_anon_data_tables`.
-- Verified: critical `rls_disabled` advisory cleared; all 10 tables RLS-on
-- (8 with anon read-only SELECT, backtest_results + schema_migrations locked
-- to owner/service only). Pre-flight confirmed SAFE: the data pipeline
-- connects as the postgres OWNER via a direct DB connection (it runs its own
-- `CREATE TABLE schema_migrations` DDL — visible in the Postgres logs — which
-- anon/PostgREST cannot do), so it BYPASSES RLS and is unaffected. The repo's
-- only anon-key writer is debughub_events (already had correct RLS). This file
-- is kept as the record + rollback reference.
-- ─────────────────────────────────────────────────────────────────────────────
-- DRAFT — review before running (Supabase Studio → SQL editor, or ask the
-- keeper to apply it as a migration).
--
-- Context: the security advisor flags 10 tables with RLS disabled — anyone
-- holding the publishable (anon) key, which ships in every DebugHub dashboard
-- page, can read AND WRITE every row of them. `debughub_events` is already
-- correct (RLS on: anon may INSERT app-whitelisted telemetry + SELECT) and is
-- untouched here.
--
-- Model applied below, mirroring the debughub naming convention:
--   * RLS ON for all 10 tables.
--   * anon gets read-only SELECT — dashboards/pages keep working.
--   * NO anon INSERT/UPDATE/DELETE policies — with RLS on and no policy,
--     writes with the anon key are denied.
--   * Server-side jobs using the service_role key BYPASS RLS entirely, so
--     backend writers keep working unchanged.
--
-- ⚠ PRE-FLIGHT: confirm no page/script WRITES these tables with the anon
-- key. Nothing in the TimbSwap repo does (only debughub_events is written,
-- and its policy already covers that). If some other frontend of yours
-- writes e.g. ort_scores with the anon key, that write breaks the moment
-- this runs — move that writer to service_role (server-side) first.
-- ─────────────────────────────────────────────────────────────────────────────

-- assets
alter table public.assets enable row level security;
create policy assets_anon_select on public.assets
  for select to anon using (true);

-- asset_price_history
alter table public.asset_price_history enable row level security;
create policy asset_price_history_anon_select on public.asset_price_history
  for select to anon using (true);

-- pairs
alter table public.pairs enable row level security;
create policy pairs_anon_select on public.pairs
  for select to anon using (true);

-- pair_metrics
alter table public.pair_metrics enable row level security;
create policy pair_metrics_anon_select on public.pair_metrics
  for select to anon using (true);

-- ort_scores
alter table public.ort_scores enable row level security;
create policy ort_scores_anon_select on public.ort_scores
  for select to anon using (true);

-- ort_score_history
alter table public.ort_score_history enable row level security;
create policy ort_score_history_anon_select on public.ort_score_history
  for select to anon using (true);

-- pools
alter table public.pools enable row level security;
create policy pools_anon_select on public.pools
  for select to anon using (true);

-- pool_history
alter table public.pool_history enable row level security;
create policy pool_history_anon_select on public.pool_history
  for select to anon using (true);

-- backtest_results (0 rows — likely internal; anon can't read OR write)
alter table public.backtest_results enable row level security;
-- no anon policy at all: service_role only. Add a *_anon_select policy like
-- the others if a dashboard ever needs to read it.

-- schema_migrations (internal bookkeeping; service_role only)
alter table public.schema_migrations enable row level security;
-- no anon policy — nothing client-side should touch migration history.

-- ─────────────────────────────────────────────────────────────────────────────
-- Rollback (if something breaks and you need the old behavior back fast):
--   alter table public.<table> disable row level security;
-- Policies can stay in place while disabled; re-enable when the writer is
-- moved to service_role.
