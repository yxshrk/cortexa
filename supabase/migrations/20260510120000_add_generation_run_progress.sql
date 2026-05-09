-- ============================================================================
-- generation_runs.progress: jsonb array of stage events emitted by /plan/generate
-- so the frontend can render a live progress feed via realtime.
--
-- Each event looks roughly like:
--   { ts: "2026-05-09T22:13:00Z",
--     phase: "synthesize" | "categorize" | "draft_actions" | "ingest" | "load" | "finalize",
--     kind: "start" | "progress" | "end" | "info" | "reasoning" | "error",
--     message: "Synthesized 5 themes from 80 notes",
--     percent: 35,                   -- 0..100; nullable
--     extra: { ... }                 -- free-form
--   }
--
-- We use a default of '[]' so legacy rows are still queryable and so
-- updates can use a json concat to append (`progress = progress || $1::jsonb`).
-- ============================================================================

alter table generation_runs
  add column if not exists progress jsonb not null default '[]'::jsonb;

-- Realtime publication already includes generation_runs from the v2 migration,
-- so no extra ALTER PUBLICATION is needed. Anon already has SELECT on this
-- table so the frontend can read progress without changes.
