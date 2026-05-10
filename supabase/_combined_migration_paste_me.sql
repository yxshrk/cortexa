-- ============================================================
-- 1/3: migration_to_v2.sql
-- ============================================================
-- ============================================================================
-- Project Brain — Schema v2 migration
-- Run this once in the Supabase SQL Editor (default service-role role).
-- Idempotent: safe to re-run if the previous attempt half-failed.
-- ============================================================================

-- 1) Extensions ---------------------------------------------------------------

create extension if not exists "uuid-ossp";
create extension if not exists vector;

-- 2) Drop old tables and enums ------------------------------------------------
-- order matters: child tables first

drop table if exists generated_actions cascade;
drop table if exists categorized_items cascade;
drop table if exists knowledge_entries cascade;

drop type if exists action_status;
drop type if exists action_type;
drop type if exists item_category;
drop type if exists entry_source;

-- 3) New types ----------------------------------------------------------------

do $$ begin
  create type meeting_note_type   as enum ('decision','action_item','blocker','mention','fyi');
exception when duplicate_object then null; end $$;

do $$ begin
  create type context_source      as enum ('slack','drive','notion','gmail');
exception when duplicate_object then null; end $$;

do $$ begin
  create type kdoc_status          as enum ('generating','ready','error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type plan_item_category   as enum ('bug_fix','new_feature','maintenance');
exception when duplicate_object then null; end $$;

do $$ begin
  create type run_status           as enum ('queued','running','ready','error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type action_type          as enum ('linear_ticket','github_pr','devin_handoff');
exception when duplicate_object then null; end $$;

do $$ begin
  create type action_status        as enum ('draft','executing','executed','failed');
exception when duplicate_object then null; end $$;

-- meetings_status already exists from your previous schema; if not:
do $$ begin
  create type meeting_status       as enum ('live','ended');
exception when duplicate_object then null; end $$;

-- 4) Verify projects + meetings exist (kept from v1) --------------------------

create table if not exists projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  repo_url text,
  hyperspell_user_id text,
  created_at timestamptz default now()
);

create table if not exists meetings (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  title text,
  started_at timestamptz default now(),
  ended_at timestamptz,
  status meeting_status default 'live'
);

-- 5) RAW INPUT 1: meeting_notes (Yudong, anon INSERT) -------------------------

create table meeting_notes (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  meeting_id uuid references meetings(id) on delete cascade,
  type meeting_note_type not null,
  text text not null,
  refs_to jsonb default '[]',
  embedding vector(1536),
  ts timestamptz default now()
);
create index meeting_notes_project_ts_idx on meeting_notes (project_id, ts desc);
create index meeting_notes_meeting_id_idx on meeting_notes (meeting_id);
create index meeting_notes_embedding_idx  on meeting_notes using hnsw (embedding vector_cosine_ops);

-- 6) RAW INPUT 1b: meeting_transcript_chunks (audit trail) --------------------

create table meeting_transcript_chunks (
  id uuid primary key default uuid_generate_v4(),
  meeting_id uuid references meetings(id) on delete cascade,
  speaker text,
  start_ms int,
  end_ms int,
  text text not null,
  ts timestamptz default now()
);
create index transcript_chunks_meeting_ts_idx on meeting_transcript_chunks (meeting_id, ts);

-- 7) RAW INPUT 2: project_context (Yash via /ingest/hyperspell) ---------------

create table project_context (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  source context_source not null,
  external_id text,
  title text,
  snippet text,
  full_text text,
  content_hash text,
  author text,
  ref_url text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  embedding vector(1536),
  ingested_at timestamptz default now(),
  ts timestamptz default now()
);
create unique index project_context_external_uniq on project_context (project_id, source, external_id) where external_id is not null;
create unique index project_context_hash_uniq     on project_context (project_id, source, content_hash) where content_hash is not null;
create index        project_context_project_ts_idx on project_context (project_id, source, ts desc);
create index        project_context_embedding_idx  on project_context using hnsw (embedding vector_cosine_ops);

-- 8) SYNTHESIS: knowledge_documents (the missing table) -----------------------

create table knowledge_documents (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  week_start date not null,
  week_end date not null,
  status kdoc_status default 'generating',
  summary text,
  themes jsonb default '[]',
  decisions jsonb default '[]',
  blockers jsonb default '[]',
  open_questions jsonb default '[]',
  source_meeting_note_ids uuid[] default '{}',
  source_project_context_ids uuid[] default '{}',
  generated_at timestamptz default now()
);
create unique index knowledge_documents_week_uniq on knowledge_documents (project_id, week_start);
create index knowledge_documents_project_idx on knowledge_documents (project_id, week_start desc);

-- 9) TRACEABILITY: generation_runs --------------------------------------------

create table generation_runs (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  week_start date not null,
  idempotency_key text,
  status run_status default 'queued',
  error text,
  retry_count int default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz default now()
);
create unique index generation_runs_idem_uniq on generation_runs (project_id, week_start, idempotency_key) where idempotency_key is not null;
create index        generation_runs_project_idx on generation_runs (project_id, created_at desc);
-- Hard idempotency: only ONE active run per (project_id, week_start) at a time.
-- Concurrent /plan/generate calls trip this index and the second one gets 409.
create unique index generation_runs_one_active_uniq on generation_runs (project_id, week_start)
  where status in ('queued','running');

-- 10) CATEGORIZED: plan_items (replaces categorized_items) --------------------

create table plan_items (
  id uuid primary key default uuid_generate_v4(),
  knowledge_document_id uuid references knowledge_documents(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  generation_run_id uuid references generation_runs(id),
  category plan_item_category not null,
  title text not null,
  description text,
  source_refs jsonb default '[]',
  code_refs jsonb default '[]',
  next_step text,
  confidence numeric,
  generated_at timestamptz default now()
);
create index plan_items_project_idx on plan_items (project_id, generated_at desc);
create index plan_items_doc_idx     on plan_items (knowledge_document_id);
create index plan_items_generation_run_id_idx on plan_items (generation_run_id);

-- 11) EXECUTION: generated_actions (now with denormalized project_id) ---------

create table generated_actions (
  id uuid primary key default uuid_generate_v4(),
  plan_item_id uuid references plan_items(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  generation_run_id uuid references generation_runs(id),
  action_type action_type not null,
  payload jsonb,
  status action_status default 'draft',
  external_url text,
  created_at timestamptz default now()
);
create index generated_actions_project_idx on generated_actions (project_id, created_at desc);
create index generated_actions_item_idx    on generated_actions (plan_item_id);
create index generated_actions_generation_run_id_idx on generated_actions (generation_run_id);

-- 12) Vector search RPC (used by /context/query) ------------------------------

create or replace function search_context(
  p_project_id uuid,
  q_emb vector(1536),
  p_limit int default 6
)
returns table (
  source text,
  id uuid,
  title text,
  snippet text,
  ref_url text,
  ts timestamptz,
  score float
)
language sql stable
set search_path = public, extensions
as $$
  with mn as (
    select
      'meeting'::text as source,
      mn.id,
      null::text as title,
      mn.text as snippet,
      null::text as ref_url,
      mn.ts,
      1 - (mn.embedding <=> q_emb) as score
    from meeting_notes mn
    where mn.project_id = p_project_id and mn.embedding is not null
  ),
  pc as (
    select
      pc.source::text,
      pc.id,
      pc.title,
      pc.snippet,
      pc.ref_url,
      pc.ts,
      1 - (pc.embedding <=> q_emb) as score
    from project_context pc
    where pc.project_id = p_project_id and pc.embedding is not null
  )
  select * from (select * from mn union all select * from pc) u
  order by score desc
  limit p_limit;
$$;

-- 13) Realtime publication ----------------------------------------------------

alter publication supabase_realtime add table meeting_notes;
alter publication supabase_realtime add table meeting_transcript_chunks;
alter publication supabase_realtime add table project_context;
alter publication supabase_realtime add table knowledge_documents;
alter publication supabase_realtime add table plan_items;
alter publication supabase_realtime add table generated_actions;
alter publication supabase_realtime add table generation_runs;

-- 14) RLS ---------------------------------------------------------------------

alter table meeting_notes              enable row level security;
alter table meeting_transcript_chunks  enable row level security;
alter table project_context            enable row level security;
alter table knowledge_documents        enable row level security;
alter table plan_items                 enable row level security;
alter table generated_actions          enable row level security;
alter table generation_runs            enable row level security;
alter table projects                   enable row level security;
alter table meetings                   enable row level security;

-- anon may SELECT everything (Jin's realtime subscriptions)
do $$ begin create policy anon_read_mn  on meeting_notes              for select to anon using (true); exception when duplicate_object then null; end $$;
do $$ begin create policy anon_read_tc  on meeting_transcript_chunks  for select to anon using (true); exception when duplicate_object then null; end $$;
do $$ begin create policy anon_read_pc  on project_context            for select to anon using (true); exception when duplicate_object then null; end $$;
do $$ begin create policy anon_read_kd  on knowledge_documents        for select to anon using (true); exception when duplicate_object then null; end $$;
do $$ begin create policy anon_read_pi  on plan_items                 for select to anon using (true); exception when duplicate_object then null; end $$;
do $$ begin create policy anon_read_ga  on generated_actions          for select to anon using (true); exception when duplicate_object then null; end $$;
do $$ begin create policy anon_read_gr  on generation_runs            for select to anon using (true); exception when duplicate_object then null; end $$;
do $$ begin create policy anon_read_p   on projects                   for select to anon using (true); exception when duplicate_object then null; end $$;
do $$ begin create policy anon_read_m   on meetings                   for select to anon using (true); exception when duplicate_object then null; end $$;

-- anon may INSERT only into meeting_notes and meeting_transcript_chunks
do $$ begin create policy anon_insert_mn on meeting_notes
  for insert to anon with check (true);
exception when duplicate_object then null; end $$;

do $$ begin create policy anon_insert_tc on meeting_transcript_chunks
  for insert to anon with check (true);
exception when duplicate_object then null; end $$;

-- service role bypasses RLS automatically (Yash's backend)

-- 15) Table privileges --------------------------------------------------------
-- RLS policies are checked AFTER base privileges. Postgres requires anon to
-- have SELECT/INSERT granted on the table before policies even run.
-- (Supabase's own Realtime + RLS guide does this explicitly.)

revoke all on meeting_notes, meeting_transcript_chunks, project_context,
              knowledge_documents, plan_items, generated_actions,
              generation_runs, projects, meetings from anon, authenticated;

grant select on meeting_notes              to anon;
grant select on meeting_transcript_chunks  to anon;
grant select on project_context            to anon;
grant select on knowledge_documents        to anon;
grant select on plan_items                 to anon;
grant select on generated_actions          to anon;
grant select on generation_runs            to anon;
grant select on projects                   to anon;
grant select on meetings                   to anon;

-- Anon may INSERT only on the two voice-agent tables (RLS policy further restricts via WITH CHECK).
grant insert on meeting_notes              to anon;
grant insert on meeting_transcript_chunks  to anon;

-- Same grants for authenticated role so signed-in users would still work post-hackathon.
grant select on meeting_notes, meeting_transcript_chunks, project_context,
                knowledge_documents, plan_items, generated_actions,
                generation_runs, projects, meetings to authenticated;
grant insert on meeting_notes, meeting_transcript_chunks to authenticated;

-- 16) RPC execute -------------------------------------------------------------

grant execute on function search_context(uuid, vector, int) to anon, authenticated;

-- ============================================================================
-- Done. Verify with the queries in JIN_SCHEMA_MIGRATION.md Step 2.
-- ============================================================================

-- ============================================================
-- 2/3: 20260509203000_finalize_v2_schema.sql
-- ============================================================
create unique index if not exists generation_runs_one_active_uniq
  on generation_runs (project_id, week_start)
  where status in ('queued', 'running');

revoke all on meeting_notes, meeting_transcript_chunks, project_context,
              knowledge_documents, plan_items, generated_actions,
              generation_runs, projects, meetings from anon, authenticated;

grant select on meeting_notes              to anon;
grant select on meeting_transcript_chunks  to anon;
grant select on project_context            to anon;
grant select on knowledge_documents        to anon;
grant select on plan_items                 to anon;
grant select on generated_actions          to anon;
grant select on generation_runs            to anon;
grant select on projects                   to anon;
grant select on meetings                   to anon;

grant insert on meeting_notes              to anon;
grant insert on meeting_transcript_chunks  to anon;

grant select on meeting_notes, meeting_transcript_chunks, project_context,
                knowledge_documents, plan_items, generated_actions,
                generation_runs, projects, meetings to authenticated;
grant insert on meeting_notes, meeting_transcript_chunks to authenticated;

-- ============================================================
-- 3/3: 20260510120000_add_generation_run_progress.sql
-- ============================================================
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
