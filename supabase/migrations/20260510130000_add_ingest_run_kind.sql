-- ============================================================================
-- generation_runs.kind: distinguish plan-generation runs from ingest runs.
--
-- Lets `/ingest/hyperspell` reuse generation_runs (and its progress jsonb +
-- realtime publication) without colliding with `/plan/generate` runs on the
-- existing `(project_id, week_start)` partial unique index.
--
-- The new partial unique index includes `kind`, so:
--   - Only ONE active plan run per (project, week)
--   - Only ONE active ingest run per (project, week)
--   - A plan run and an ingest run can be active concurrently.
-- ============================================================================

do $$ begin
  create type run_kind as enum ('plan','ingest');
exception when duplicate_object then null; end $$;

alter table generation_runs
  add column if not exists kind run_kind not null default 'plan';

-- Replace the active-run unique index to include kind. The old name is reused
-- so realtime/RLS don't need to be re-touched.
drop index if exists generation_runs_one_active_uniq;
create unique index generation_runs_one_active_uniq
  on generation_runs (project_id, week_start, kind)
  where status in ('queued','running');
