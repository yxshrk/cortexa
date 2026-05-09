# Supabase Setup

This directory contains the Project Brain Supabase schema.

## Files

- `DATABASE.md`: plain-English schema guide and ERD.
- `migration_to_v2.sql`: current team-authored v2 schema from `main`.
- `migrations/`: incremental hosted-project migrations used after v2 was first applied.

## Deploy

Use a Supabase project that the team can access, then paste `migration_to_v2.sql` into the Supabase SQL editor.

## Required Environment

Frontend:

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
```

FastAPI/backend:

```bash
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

Do not expose `SUPABASE_SERVICE_ROLE_KEY` to browser code.

## Realtime

The v2 schema adds these tables to `supabase_realtime`:

- `meeting_notes`
- `meeting_transcript_chunks`
- `project_context`
- `knowledge_documents`
- `plan_items`
- `generated_actions`
- `generation_runs`

## RLS

The v2 schema enables RLS. It allows anonymous reads for the demo UI and anonymous inserts only into `meeting_notes` and `meeting_transcript_chunks`.

`meetingId` in frontend code means the internal Supabase `meetings.id`, not a Google Meet identifier.
