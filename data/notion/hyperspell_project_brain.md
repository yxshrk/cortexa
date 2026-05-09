# Hyperspell Integration for Project Brain

## Purpose

Project Brain uses Hyperspell as the external company-memory layer for project context. Hyperspell connects to team sources like Slack, Google Drive, Gmail, Notion, and optionally GitHub, then exposes that indexed context through a search API.

In this product, Hyperspell is not the planner. It is the retrieval layer that gives the planner relevant project memory.

Project Brain combines:

- meeting notes captured by the voice agent,
- project context retrieved from Hyperspell,
- code references from Hyperspell GitHub or fallback fixtures,
- a planning pipeline that turns context into execution-ready actions.

## Where Hyperspell Fits

Project Brain has one linear flow:

```text
meeting_notes + project_context
        -> knowledge_documents
        -> plan_items
        -> generated_actions
```

Hyperspell feeds the `project_context` table and helps enrich plan items with code references.

The backend owns all Hyperspell calls. The frontend never talks to Hyperspell directly.

## Core Use Cases

### 1. Connector authorization

The frontend shows connector cards for:

- Slack
- Google Drive
- Notion
- Gmail
- GitHub, beta / code-reference only

When a user clicks connect, the frontend calls:

```http
POST /connect/start
Authorization: Bearer <DEMO_TOKEN>
Content-Type: application/json

{ "projectId": "<uuid>", "source": "slack|drive|notion|gmail" }
```

The backend:

1. loads the project from Supabase,
2. ensures `projects.hyperspell_user_id` exists,
3. asks Hyperspell for a hosted connect URL,
4. returns `{ "url": "..." }` to the frontend.

The frontend opens that URL so the user can authorize the connector.

### 2. Project-context ingestion

After sources are connected, the backend pulls project context from Hyperspell:

```http
POST /ingest/hyperspell
Authorization: Bearer <DEMO_TOKEN>
Content-Type: application/json

{ "projectId": "<uuid>" }
```

The backend:

1. searches Hyperspell across Slack, Drive, Notion, and Gmail,
2. normalizes Hyperspell source names into our database enum,
3. embeds each item with `text-embedding-3-small`,
4. computes a content hash,
5. upserts rows into `project_context`.

`/ingest/hyperspell` is idempotent. It deduplicates using either:

- `(project_id, source, external_id)`, when Hyperspell gives a stable external id,
- `(project_id, source, content_hash)`, when no external id exists.

### 3. Live meeting context

During a meeting, the voice agent can ask the backend for context:

```http
POST /context/query
Content-Type: application/json

{ "projectId": "<uuid>", "query": "Safari login bug", "k": 6 }
```

The backend should:

1. embed the query,
2. search local Supabase context with pgvector,
3. optionally run a short-timeout Hyperspell live search,
4. merge and deduplicate results,
5. return context to the voice agent.

This makes the live meeting assistant useful even before the weekly plan is generated.

### 4. Code references during planning

When `/plan/generate` categorizes plan items, each item can include a `code_query`.

For each `code_query`, the backend should try:

```python
client.memories.search(
    query=item.code_query,
    sources=["github"],
    options={"max_results": 3},
)
```

If Hyperspell GitHub beta access is unavailable, the backend falls back to:

```text
backend/fixtures/seed_code_refs.json
```

This keeps the demo working even if GitHub indexing is not available.

## Source Mapping

Hyperspell source names and our database enum names are not identical.

| Hyperspell source | Project Brain DB source |
|---|---|
| `slack` | `slack` |
| `notion` | `notion` |
| `google_drive` | `drive` |
| `google_mail` or `gmail` | `gmail` |
| `github` | not stored in `project_context`; used for `code_refs` |

The backend owns this mapping in `backend/services/hyperspell.py`.

The frontend should use database source names only:

```text
slack, drive, notion, gmail, github
```

GitHub is displayed as a beta connector, but GitHub documents are not inserted into `project_context` for the MVP.

## Supabase Tables Affected

### `projects`

Stores one Hyperspell user id per Project Brain project:

```text
projects.hyperspell_user_id
```

The backend lazily provisions this value, usually as:

```text
pri-<projectId>
```

### `project_context`

Stores context retrieved from Hyperspell.

Important fields:

| Column | Purpose |
|---|---|
| `project_id` | Project Brain project id |
| `source` | `slack`, `drive`, `notion`, or `gmail` |
| `external_id` | Stable Hyperspell/source id when available |
| `title` | Display title |
| `snippet` | Short UI preview |
| `full_text` | Full text used for synthesis and embedding |
| `content_hash` | Dedup fallback |
| `ref_url` | Link back to source |
| `embedding` | `text-embedding-3-small` vector |
| `source_created_at` | Original source creation time |
| `source_updated_at` | Original source update time |

## Backend Files

| File | Responsibility |
|---|---|
| `backend/routers/connect.py` | `/connect/start` and `/connect/status` |
| `backend/routers/ingest.py` | `/ingest/hyperspell` |
| `backend/services/hyperspell.py` | Hyperspell SDK wrapper and source mapping |
| `backend/services/embeddings.py` | OpenAI embedding wrapper |
| `backend/services/supabase_writer.py` | Supabase reads/writes used by backend routes |
| `backend/scripts/check_schema.py` | Schema and RPC sanity check |

## Frontend Files

| File | Responsibility |
|---|---|
| `frontend/app/projects/[id]/_tabs/ConnectorsTab.tsx` | Connector UI, project context list, manual ingest |
| `frontend/lib/supabase.ts` | Browser Supabase client and frontend env helpers |
| `frontend/.env.local.example` | Safe frontend env template |

## Environment Variables

### Frontend

The frontend must use the Supabase publishable key only.

```env
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
NEXT_PUBLIC_FASTAPI_URL=http://localhost:8000
NEXT_PUBLIC_DEMO_TOKEN=<demo token>
```

Never put the Supabase secret/service-role key in a `NEXT_PUBLIC_` variable.

### Backend

The backend uses the Supabase secret/service-role key because it writes protected tables.

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
DEMO_TOKEN=<demo token>
HYPERSPELL_KEY=<hyperspell api key>
OPENAI_KEY=<openai api key>
```

Supported backend aliases for the Supabase secret key:

- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_SECRET_KEY`
- `SUPABASE_KEY`

The preferred names are `SUPABASE_SERVICE_ROLE_KEY` or `SUPABASE_SECRET_KEY`.

## Security Rules

- The frontend uses the publishable Supabase key only.
- The backend uses the secret Supabase key only.
- `POST /connect/start` is auth-gated because it mutates `projects.hyperspell_user_id`.
- `POST /ingest/hyperspell` is auth-gated because it writes `project_context`.
- `.env` files are ignored by git.
- `.env.local.example` is safe to commit because it contains placeholders only.

## Demo Flow

1. Open the Project Brain frontend.
2. Go to a project page.
3. Open the Connectors tab.
4. Connect Slack, Drive, Notion, or Gmail through Hyperspell.
5. Click refresh / ingest.
6. Backend pulls context from Hyperspell into `project_context`.
7. Frontend shows ingested documents grouped by connector.
8. Later, `/plan/generate` uses this context to create the weekly knowledge document, plan items, and actions.

## Current Known Gaps

- Exact Hyperspell connect URL SDK method still needs verification against the current SDK.
- Exact connection-status SDK method still needs verification.
- GitHub connector is treated as beta and should not block the demo.
- `/context/query` and `/plan/generate` are planned backend phases after connector ingestion.

## Acceptance Checklist

- `backend/scripts/check_schema.py` passes.
- `frontend/.env.local` contains a publishable Supabase key, not a secret key.
- `backend/.env` contains a Supabase secret key, not a publishable key.
- `POST /connect/start` rejects missing or wrong `DEMO_TOKEN`.
- `POST /ingest/hyperspell` rejects missing or wrong `DEMO_TOKEN`.
- Supabase RLS allows frontend inserts only into `meeting_notes` and `meeting_transcript_chunks`.
- Frontend can read `project_context` rows after ingestion.

