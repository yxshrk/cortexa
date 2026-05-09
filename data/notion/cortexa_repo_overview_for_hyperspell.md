# Cortexa Repo Overview for Hyperspell Connection Test

## What This Page Is For

This page is seed documentation for the Cortexa repository. Upload or paste it into Notion, connect Notion to Hyperspell, then use Project Brain to verify that Hyperspell can retrieve this project context.

This page intentionally includes searchable phrases, file paths, owners, routes, tables, and expected test queries.

Do not store secrets here. This document should be safe to index in Notion and Hyperspell.

## Project Summary

Cortexa is building Project Brain, a per-project engineering context system for the Nozomio Hackathon on May 9, 2026.

Project Brain collects:

- meeting notes from a voice agent,
- project context from Hyperspell connectors,
- code references from GitHub or fixtures,
- generated execution plans,
- one-click action drafts for Linear, GitHub, and Devin.

The core product idea is:

```text
project context + meeting notes + codebase references
        -> weekly knowledge document
        -> categorized plan items
        -> generated executable actions
```

The goal is not just summarization. The goal is to turn scattered engineering context into execution-ready work.

## Team Ownership

| Person | Area |
|---|---|
| Yash | Backend, Hyperspell integration, ingestion, planning pipeline, executors |
| Jin | Supabase schema, frontend project page, tabs, realtime data rendering |
| Yudong | Voice agent, Google Meet audio capture, realtime transcription, live context board |

Ownership boundaries matter. Yash should avoid editing Yudong-owned voice-agent files unless there is an explicit handoff. Yash can add backend fallbacks when the voice path is incomplete.

## Repo Layout

```text
cortexa/
  backend/
    main.py
    dependencies.py
    settings.py
    routers/
      connect.py
      ingest.py
    services/
      hyperspell.py
      embeddings.py
      supabase_writer.py
    scripts/
      check_schema.py
    fixtures/
      seed_code_refs.json

  frontend/
    app/
      page.tsx
      projects/[id]/page.tsx
      projects/[id]/_tabs/ConnectorsTab.tsx
      projects/[id]/_tabs/InputsTab.tsx
      projects/[id]/_tabs/KnowledgeDocTab.tsx
      projects/[id]/_tabs/ActionsTab.tsx
    lib/
      supabase.ts

  supabase/
    migration_to_v2.sql
    migrations/
    DATABASE.md

  docs/
    hyperspell.md
    project_brain_prd_and_execution_plan.md
    project_brain_technical_execution_plan.md

  individual_plan/
    yash_backend_execution_plan.md
    jin_prd_execution_plan.md
    yudong_meet_listener_execution_plan.md

  data/
    notion/
      hyperspell_project_brain.md
      cortexa_repo_overview_for_hyperspell.md
```

## Current Architecture

The frontend is a Next.js app. It reads from Supabase with a publishable key and calls the FastAPI backend for protected actions.

The backend is a FastAPI app. It uses the Supabase secret/service-role key to write protected tables. It owns all Hyperspell calls.

Supabase stores the operational state:

- raw meeting notes,
- raw transcript chunks,
- Hyperspell-ingested project context,
- weekly knowledge documents,
- plan items,
- generated actions,
- generation run status.

Hyperspell is used as the external company-memory connector layer.

## Supabase Tables

The v2 schema has nine main tables:

| Table | Purpose |
|---|---|
| `projects` | Project metadata, including `hyperspell_user_id` |
| `meetings` | Meeting records |
| `meeting_notes` | Structured notes from the voice agent |
| `meeting_transcript_chunks` | Raw transcript audit trail |
| `project_context` | Slack, Drive, Notion, and Gmail items ingested from Hyperspell |
| `knowledge_documents` | Weekly synthesis output |
| `generation_runs` | Idempotency and status tracking for `/plan/generate` |
| `plan_items` | Categorized execution items |
| `generated_actions` | Linear, GitHub, or Devin action drafts |

Important schema detail: `meeting_notes.embedding` and `project_context.embedding` are `vector(1536)` columns for pgvector search.

## Hyperspell Integration

Hyperspell connects external sources and exposes search over indexed company memory.

Cortexa uses Hyperspell in three places:

1. `/connect/start` starts source authorization.
2. `/ingest/hyperspell` pulls Slack, Drive, Notion, and Gmail context into Supabase.
3. `/plan/generate` later asks Hyperspell GitHub for code references per plan item.

The backend normalizes Hyperspell source names into database source names.

| Hyperspell source | Database source |
|---|---|
| `slack` | `slack` |
| `google_drive` | `drive` |
| `notion` | `notion` |
| `google_mail` or `gmail` | `gmail` |
| `github` | used for `code_refs`, not stored in `project_context` |

## Backend Routes

### `POST /connect/start`

Starts a Hyperspell connector flow.

Request:

```json
{
  "projectId": "<uuid>",
  "source": "slack"
}
```

Security:

- Requires `Authorization: Bearer <DEMO_TOKEN>`.
- Mutates `projects.hyperspell_user_id` if missing.

Expected behavior:

- Loads the project.
- Creates a `hyperspell_user_id` if needed.
- Returns a Hyperspell connect URL.

### `GET /connect/status`

Reports source connection status for a project.

Example:

```http
GET /connect/status?projectId=<uuid>
```

Expected response shape:

```json
{
  "slack": "connected",
  "drive": "not_connected",
  "notion": "connected",
  "gmail": "not_connected",
  "github": "beta"
}
```

If the Hyperspell SDK does not expose connection status, the backend falls back to a heuristic: if a source has any `project_context` rows, it is treated as connected.

### `POST /ingest/hyperspell`

Pulls context from Hyperspell into Supabase.

Request:

```json
{
  "projectId": "<uuid>"
}
```

Security:

- Requires `Authorization: Bearer <DEMO_TOKEN>`.
- Writes to `project_context`.

Expected behavior:

- Searches Hyperspell across Slack, Drive, Notion, and Gmail.
- Embeds each result with OpenAI `text-embedding-3-small`.
- Computes a SHA-256 content hash.
- Upserts into `project_context`.

Deduplication:

- Use `(project_id, source, external_id)` when `external_id` exists.
- Use `(project_id, source, content_hash)` when `external_id` is missing.

### Planned `POST /context/query`

This route is for live context retrieval during meetings.

Expected behavior:

- Embed the query.
- Search `meeting_notes` and `project_context` using pgvector.
- Optionally merge a short-timeout Hyperspell live search.
- Return context items to Yudong's voice agent.

### Planned `POST /plan/generate`

This route generates the weekly knowledge document and plan items.

Expected pipeline:

1. read `meeting_notes` and `project_context`,
2. synthesize `knowledge_documents`,
3. categorize `plan_items`,
4. enrich each item with `code_refs`,
5. draft `generated_actions`.

## Frontend Surface

The Next.js frontend has:

- `/` project list page,
- `/projects/[id]` project page,
- Inputs tab,
- Connectors tab,
- Knowledge Doc tab,
- Actions tab.

The Connectors tab is the main Hyperspell test surface.

Connectors tab responsibilities:

- show Slack, Drive, Notion, Gmail, and GitHub beta connectors,
- call `/connect/status`,
- call `/connect/start`,
- call `/ingest/hyperspell`,
- subscribe to `project_context`,
- show ingested documents grouped by source,
- show full text and metadata for selected context rows.

## Environment Rules

Frontend `.env.local` must use the Supabase publishable key:

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
NEXT_PUBLIC_FASTAPI_URL=http://localhost:8000
NEXT_PUBLIC_DEMO_TOKEN=<demo-token>
```

Backend `.env` must use the Supabase secret key:

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
DEMO_TOKEN=<demo-token>
HYPERSPELL_KEY=<hyperspell-key>
OPENAI_KEY=<openai-key>
```

Never expose `SUPABASE_SECRET_KEY` or any service-role key to the browser.

## Security Model

The frontend uses Supabase RLS with a publishable key.

Frontend is allowed to:

- select demo tables,
- insert `meeting_notes`,
- insert `meeting_transcript_chunks`.

Frontend is not allowed to:

- insert `project_context`,
- insert `plan_items`,
- insert `generated_actions`,
- mutate project configuration directly.

The backend uses the Supabase secret key and can write protected tables.

Auth-gated backend routes:

- `POST /connect/start`
- `POST /ingest/hyperspell`
- planned `POST /plan/generate`
- planned `POST /actions/{id}/execute`

## Current Implementation Notes

Current backend files implemented for the first Hyperspell phase:

- `backend/main.py`
- `backend/dependencies.py`
- `backend/settings.py`
- `backend/routers/connect.py`
- `backend/routers/ingest.py`
- `backend/services/hyperspell.py`
- `backend/services/embeddings.py`
- `backend/services/supabase_writer.py`
- `backend/scripts/check_schema.py`

Current frontend files implemented for the first Hyperspell phase:

- `frontend/app/page.tsx`
- `frontend/app/projects/[id]/page.tsx`
- `frontend/app/projects/[id]/_tabs/ConnectorsTab.tsx`
- `frontend/lib/supabase.ts`

## Known Risks and Fixes

### Popup blocker risk

The Connectors tab should open the OAuth popup synchronously on click. If the app waits for `/connect/start` before calling `window.open`, the browser may block the popup.

Expected fix:

1. create a blank popup immediately,
2. fetch `/connect/start`,
3. assign the returned URL to `popup.location.href`.

### Stale documentation links

Some docs were moved into `docs/`. Any links that still point to root-level `project_brain_technical_execution_plan.md` or `project_brain_prd_and_execution_plan.md` should be updated.

### GitHub beta behavior

GitHub is not part of normal `project_context` ingestion. GitHub is used for `code_refs` during planning. If Hyperspell GitHub is unavailable, use `backend/fixtures/seed_code_refs.json`.

## Hyperspell Connection Test Queries

After uploading this page to Notion and connecting Notion through Hyperspell, ask Project Brain or Hyperspell queries like these.

### Query 1

```text
What backend route starts the Hyperspell connector flow?
```

Expected answer:

```text
POST /connect/start starts the Hyperspell connector flow.
It requires Authorization: Bearer <DEMO_TOKEN>.
```

### Query 2

```text
Which table stores Hyperspell-ingested project context?
```

Expected answer:

```text
project_context stores Slack, Drive, Notion, and Gmail items ingested from Hyperspell.
```

### Query 3

```text
What is the source mapping for Google Drive?
```

Expected answer:

```text
Hyperspell uses google_drive, and Cortexa stores it as drive in project_context.source.
```

### Query 4

```text
Which key should the frontend use for Supabase?
```

Expected answer:

```text
The frontend should use NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, never the secret service-role key.
```

### Query 5

```text
What are the first phase backend files for Hyperspell?
```

Expected answer:

```text
backend/routers/connect.py, backend/routers/ingest.py, backend/services/hyperspell.py, backend/services/embeddings.py, backend/services/supabase_writer.py, backend/settings.py, backend/dependencies.py, and backend/main.py.
```

### Query 6

```text
How does /ingest/hyperspell deduplicate records?
```

Expected answer:

```text
It upserts by project_id, source, and external_id when external_id exists; otherwise it uses project_id, source, and content_hash.
```

### Query 7

```text
Why is GitHub treated differently from Slack and Notion?
```

Expected answer:

```text
GitHub is beta and is used for code_refs during planning, not stored as normal project_context.
```

### Query 8

```text
Who owns the Hyperspell backend integration?
```

Expected answer:

```text
Yash owns the backend, Hyperspell integration, ingestion, planning pipeline, and executors.
```

## Minimal Demo Script for Notion Retrieval

Use this script to verify the Notion-Hyperspell path:

1. Upload this page to Notion.
2. Connect Notion through the Cortexa Connectors tab.
3. Click refresh or run `/ingest/hyperspell`.
4. Confirm a `project_context` row appears with source `notion`.
5. Ask: "Which route starts Hyperspell connector auth?"
6. Ask: "What table stores Hyperspell project context?"
7. Ask: "What key should the frontend use for Supabase?"

If those answers come back from this page, the Notion connector is working.

## One-Line Project Description

Cortexa Project Brain is a per-project engineering memory and execution system that combines meeting notes, Hyperspell-ingested project context, Supabase vector search, and LLM planning to produce actionable engineering tasks.

