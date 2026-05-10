-- Cortexa: only the bits still missing on production.
-- Safe to re-run; everything is `if not exists` / idempotent.

-- ── Migration 2: hard idempotency for /plan/generate ────────────────────────
create unique index if not exists generation_runs_one_active_uniq
  on generation_runs (project_id, week_start)
  where status in ('queued', 'running');

-- ── Migration 3: progress column for live trace ─────────────────────────────
alter table generation_runs
  add column if not exists progress jsonb not null default '[]'::jsonb;
