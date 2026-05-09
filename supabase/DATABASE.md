# Project Brain Supabase Database

This is the v2 database contract for the hackathon demo. The hosted project is:

- Project ref: `walgjemfqjxhrixqtaey`
- URL: `https://walgjemfqjxhrixqtaey.supabase.co`
- Source of truth SQL: `supabase/migration_to_v2.sql`

## ERD

```mermaid
erDiagram
  PROJECTS ||--o{ MEETINGS : has
  PROJECTS ||--o{ MEETING_NOTES : filters
  PROJECTS ||--o{ PROJECT_CONTEXT : ingests
  PROJECTS ||--o{ KNOWLEDGE_DOCUMENTS : synthesizes
  PROJECTS ||--o{ GENERATION_RUNS : tracks
  PROJECTS ||--o{ PLAN_ITEMS : filters
  PROJECTS ||--o{ GENERATED_ACTIONS : filters

  MEETINGS ||--o{ MEETING_NOTES : groups
  MEETINGS ||--o{ MEETING_TRANSCRIPT_CHUNKS : audits

  KNOWLEDGE_DOCUMENTS ||--o{ PLAN_ITEMS : contains
  GENERATION_RUNS ||--o{ PLAN_ITEMS : produced
  GENERATION_RUNS ||--o{ GENERATED_ACTIONS : produced
  PLAN_ITEMS ||--o{ GENERATED_ACTIONS : drafts
```

`meetingId` in the frontend is `meetings.id`. It is an internal Supabase UUID, not a Google Meet ID. For the demo, Jin should select the latest `meetings` row with `status = 'live'` for the project, or use a pre-seeded row titled `Demo Standup`.

## Tables

| Table | Purpose | Writer | Frontend use |
|---|---|---|---|
| `projects` | Project records | Seed/admin | Project list and header |
| `meetings` | Internal meeting sessions | Seed/Jin/Yudong setup | Provides `meetingId` for `VoiceAgent` |
| `meeting_notes` | Structured voice-agent notes with optional `embedding vector(1536)` | Yudong with anon key | Inputs tab and vector search |
| `meeting_transcript_chunks` | Raw transcript audit chunks | Yudong with anon key | Optional/debug trail |
| `project_context` | Hyperspell context from Slack, Drive, Notion, Gmail with optional `embedding vector(1536)` | Yash service role | Inputs tab and vector search |
| `knowledge_documents` | Weekly synthesis: summary, themes, decisions, blockers, open questions | Yash service role | Knowledge Doc tab |
| `generation_runs` | `/plan/generate` status and idempotency | Yash service role | Header status pill |
| `plan_items` | Categorized work items: `bug_fix`, `new_feature`, `maintenance` | Yash service role | Knowledge Doc tab |
| `generated_actions` | Linear, GitHub PR, and Devin action drafts | Yash service role | Actions tab |

## Supabase ↔ Hyperspell role split

Hyperspell is now wired in. To avoid the question "which one is the source of truth?" creeping back in, here's the explicit split. **No tables are removed** — they all still earn their keep. But for each table you can answer "if Hyperspell is down, what still works?".

| Table | Source of truth | Hyperspell involvement |
|---|---|---|
| `projects` | Supabase | Stores `hyperspell_user_id` (e.g. `pri-<projectId>`) linking the project to its Hyperspell vault. Otherwise app-only. |
| `meetings` | Supabase | None — internal meeting orchestration. |
| `meeting_notes` | Supabase | **Local pgvector first** for sub-100ms live search. Optionally push to Hyperspell via `sessions.add(history=...)` so global "ask anything" search includes meetings. |
| `meeting_transcript_chunks` | Supabase | None — audit/debug trail. |
| `project_context` | **Hyperspell** (mirrored locally) | Populated by `POST /ingest/hyperspell`: `memories.search` → `memories.get` → embed → UPSERT here. Hyperspell is upstream; this table is a cache. |
| `knowledge_documents` | Supabase (Claude-generated) | None directly. Optionally call `memories.add(text=summary)` after generation so next week's synthesis can search prior knowledge docs. |
| `generation_runs` | Supabase | None — internal orchestration state. |
| `plan_items` | Supabase (Claude-generated) | None — our generated artifact. |
| `generated_actions` | Supabase (Claude-generated) | None directly. `actions.send_message` (Slack/Gmail) is invoked at *execute* time but no Hyperspell row is read. |

### Why we mirror `project_context` instead of always hitting Hyperspell

1. **Realtime fan-out** — Supabase publishes INSERTs on `project_context`; the Connectors tab updates without polling. Hyperspell has no comparable push.
2. **Sub-100ms vector search** for live meeting context via `search_context` RPC. Hyperspell over the network is hundreds of ms.
3. **Resilience** — if Hyperspell is slow or rate-limited, pgvector still answers `/context/query`.
4. **Ranking control** — the `search_context` SQL merges meeting + connector chunks with weights *we* set; Hyperspell's ranker is a black box.

### Data flow at a glance

```
Hyperspell connectors (Slack, Drive, Notion, Gmail, …)
          │
          ▼  POST /ingest/hyperspell  (search → get → embed → upsert)
   project_context (mirror, with vector(1536))
          │
          ▼  search_context RPC
   /context/query  ──→  /plan/generate  ──→  knowledge_documents, plan_items, generated_actions
          ▲                                          │
          │                                          │ optional: memories.add(text=summary)
   meeting_notes (also mirrored, optionally pushed   │   feeds future synthesis
   to Hyperspell via sessions.add)                   ▼
                                              Hyperspell vault
```

## Important Design Choices

- `generated_actions.project_id` is intentionally denormalized so Supabase Realtime can filter directly with `project_id=eq.<projectId>`.
- `plan_items.project_id` is also denormalized for simple frontend queries.
- `meeting_notes.project_id` supports project-level Realtime subscriptions, while `meeting_notes.meeting_id` groups notes under a specific internal meeting.
- `knowledge_documents` is unique by `(project_id, week_start)` so the current weekly synthesis has one canonical row.
- `meeting_notes.embedding` and `project_context.embedding` are both `vector(1536)` for OpenAI `text-embedding-3-small`.

## Realtime

Subscribe with `project_id=eq.<projectId>` where the table has `project_id`:

| Table | UI target |
|---|---|
| `meeting_notes` | Inputs -> Meetings |
| `project_context` | Inputs -> Project Context |
| `knowledge_documents` | Knowledge Doc |
| `plan_items` | Knowledge Doc plan items |
| `generated_actions` | Actions |
| `generation_runs` | Header status |

`meeting_transcript_chunks` is also in the Realtime publication for audit/debug flows, but the main UI does not need to subscribe to it.

## RLS And Privileges

RLS is enabled on all v2 app tables.

Demo policy:

- `anon` can `SELECT` all demo tables.
- `anon` can `INSERT` only into `meeting_notes` and `meeting_transcript_chunks`.
- Browser code should not update rows directly.
- FastAPI uses `SUPABASE_SERVICE_ROLE_KEY` for backend-owned writes and updates.

Update flows should go through FastAPI:

- `/ingest/hyperspell` writes `project_context`.
- `/plan/generate` writes `generation_runs`, `knowledge_documents`, `plan_items`, and `generated_actions`.
- `/actions/{id}/execute` updates `generated_actions`.

## Environment

Frontend:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://walgjemfqjxhrixqtaey.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_bXSjd0SPih0685J6YaG1hA_SEoSi_kq
```

Backend:

```bash
SUPABASE_URL=https://walgjemfqjxhrixqtaey.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<from Supabase dashboard>
```

Never commit `.env` or expose `SUPABASE_SERVICE_ROLE_KEY` to frontend code.
