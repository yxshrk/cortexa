# Hyperspell — verified API surface for Project Brain

> Locked against `hyperspell` SDK **0.37.0** (Python). Auto-generated from
> `https://app.stainlessapi.com/api/spec/documented/hyperspell.yaml` — every
> endpoint at `https://docs.hyperspell.com/api-reference/` has a corresponding
> SDK method.
>
> **For agents:** if you need a method that isn't here, do
> `python3 -c "from hyperspell import Hyperspell; c=Hyperspell(api_key='x'); print([m for m in dir(c.<resource>) if not m.startswith('_')])"`
> rather than guessing. Docs URL = source of truth, SDK = mechanical mapping.

---

## What it is

Hyperspell is "the company brain for AI agents." It connects to a team's data
sources (Slack, Gmail, Google Drive, Notion, GitHub, etc.), continuously
indexes them, and exposes a unified search API.

- Track sponsor at the Nozomio hackathon. Cash prize: **$1k + 6 months unlimited + founders deploy session + amplification** for the best Hyperspell-using submission.
- Docs root: <https://docs.hyperspell.com/>
- API reference: <https://docs.hyperspell.com/api-reference/>
- llms.txt index: <https://docs.hyperspell.com/llms.txt>

---

## Where Hyperspell sits relative to Supabase

Short version: **Hyperspell is the upstream source for connector data;
Supabase is the local mirror + everything else.** Full per-table breakdown
lives in `supabase/DATABASE.md` ("Supabase ↔ Hyperspell role split"). Don't
duplicate that table here — keep one source of truth.

What this means in practice:
- `project_context` rows are a **cache** of Hyperspell hits, embedded locally for pgvector search and Realtime UI fan-out. If Hyperspell is down, pgvector still answers.
- `meeting_notes`, `knowledge_documents`, `plan_items`, `generated_actions` are **Supabase-authoritative**. Hyperspell never owns these. We optionally *push* meeting transcripts and finished knowledge docs *to* Hyperspell so the unified "ask anything" search includes them, but the local row is canonical.
- Generation orchestration (`generation_runs`, `meetings`, `meeting_transcript_chunks`) is Supabase-only — Hyperspell has no concept of these.

---

## Source enum (canonical)

Hyperspell's full source enum is:

```
reddit | notion | slack | google_calendar | google_mail | box | dropbox |
github | google_drive | vault | web_crawler | trace | microsoft_teams | gmail_actions
```

Our DB enum (`context_source`) is the smaller subset:

| Hyperspell source | Our DB enum (`context_source`) |
|---|---|
| `slack` | `slack` |
| `notion` | `notion` |
| `google_drive` | `drive` |
| `google_mail` | `gmail` |
| `github` | (not stored in `project_context`; used directly via `code_refs`) |
| `vault` | (not currently stored; vault items reachable via `/search` only) |
| `web_crawler` | (not currently stored; crawled pages reachable via `/search` only) |

Mapping lives in `backend/services/hyperspell.py` (`HS_TO_DB_SOURCE` /
`DB_TO_HS_SOURCE`).

---

## SDK construction

```python
from hyperspell import Hyperspell
client = Hyperspell(api_key=settings.hyperspell_key, user_id="pri-<projectId>")
```

`user_id` is `projects.hyperspell_user_id` — lazily provisioned by
`/connect/start` on first call per project.

The SDK is sync; wrap calls in `asyncio.to_thread(...)` from async routes.

---

## Endpoints we expose

All under `http://localhost:8000` in dev. Mutating endpoints require
`Authorization: Bearer ${DEMO_TOKEN}`.

### Connect / connections

| Method + path | Wraps SDK call | Purpose |
|---|---|---|
| `POST /connect/start` | `client.integrations.connect(integration_id, redirect_url=...)` | Mint OAuth URL for `(projectId, source)`. Returns `{url, hyperspell_user_id}`. |
| `GET  /connect/status` | `client.connections.list()` + heuristic | Per-source connection map: `{slack: connected, drive: not_connected, ...}`. 30s in-memory cache. |
| `GET  /connect/integrations` | `client.integrations.list()` | Hyperspell's full integration catalog. Use to render new connectors as Hyperspell adds them. |
| `POST /connect/revoke` | `client.connections.revoke(connection_id)` | Body `{projectId, source}`. Resolves `source` → connection_id internally, then revokes. Busts the status cache. |

### Memories (vault / files / status)

| Method + path | Wraps SDK call | Purpose |
|---|---|---|
| `POST /memories/add` | `client.memories.add(text, title?, collection?, metadata?)` | Push arbitrary text to the project's vault. Returns `{resource_id, source, status}`. |
| `POST /memories/upload` | `client.memories.upload(file, metadata?)` | Multipart file upload (PDF/doc/etc.). `metadata` is a JSON-encoded **string** (Hyperspell's quirk — we validate before sending). |
| `GET  /memories/status` | `client.memories.status()` | Per-provider indexing progress. Useful for UI: "Slack: 87% indexed". |
| `POST /memories/web-crawl` | `client.integrations.web_crawler.index(url, limit?, max_depth?)` | Recursively crawl a URL. Pages become searchable under `source=web_crawler`. |
| `POST /memories/session` | `client.sessions.add(history, extract?, title?, session_id?, metadata?)` | Store a transcript / agent trace. `extract` ∈ `{procedure, memory, mood}`. |

### Ingest (Hyperspell → Supabase mirror)

| Method + path | Wraps SDK calls | Purpose |
|---|---|---|
| `POST /ingest/hyperspell` | `memories.search` + `memories.get` (parallel fan-out) → embed → upsert `project_context` | Pulls connector items into the local mirror. Idempotent on `(project_id, source, external_id)` then `(project_id, source, content_hash)`. Auto-fired after OAuth completes. |

### Unified search

| Method + path | Wraps SDK call | Purpose |
|---|---|---|
| `POST /search` | `client.memories.search(query, sources?, max_results, answer?)` **+** Supabase `search_context` RPC | Two parallel calls, merged in the response. Hyperspell can `answer=true` for an LLM-synthesized answer; local pgvector backstops latency / outage. Returns `{answer, query_id, hits[], hyperspell_ok, local_ok}`. 5s timeout on Hyperspell. |

---

## SDK reference (resources we use, locked to 0.37.0)

| Resource | Methods | Notes |
|---|---|---|
| `client.auth` | `me()`, `user_token(user_id, expires_in?, origin?)`, `delete_user()` | `user_token` is for handing a per-user token to the frontend. We currently mint connect URLs server-side via `integrations.connect` instead, so `user_token` is unused. |
| `client.memories` | `add`, `add_bulk` (≤100, ≤10MB), `upload`, `get`, `list`, `search`, `update`, `delete`, `status` | `search` returns `QueryResult{documents: [Resource], answer?, query_id?, score?}`. `Resource` has metadata only — no body. Use `get(resource_id, source=...)` per hit for full text (`Memory.memories: List[str]`). |
| `client.integrations` | `connect(integration_id, redirect_url?)`, `list()`, `slack.list(...)`, `google_calendar.list()`, `web_crawler.index(url, limit?, max_depth?)` | `connect` returns `{url, expires_at}` ready to redirect to. |
| `client.connections` | `list()`, `revoke(connection_id)` | `Connection{id, integration_id, label?, provider}`. Presence in the list ⇒ connected. |
| `client.sessions` | `add(history, extract?, format?, title?, session_id?, metadata?)` | `extract` subset of `{procedure, memory, mood}`. Returns a `MemoryStatus`. |
| `client.actions` | `send_message(provider, text, channel?, parent?)`, `add_reaction(...)` | Lets agents post back to Slack/Gmail. We don't expose this yet — wire up when the Actions tab needs a "post to Slack" affordance. |
| `client.evaluate` | `score_query(query_id, score)`, `score_highlight(highlight_id, ...)`, `get_query(query_id)` | Feedback loop for the search ranker. Worth wiring when we have a thumbs-up/down UI. |
| `client.folders` | `list(connection_id, parent_id?)`, `set_policies(connection_id, ...)`, `list_policies(...)`, `delete_policy(...)` | Per-folder sync control (e.g. "only sync /Engineering in Drive, skip /HR"). Power-user feature; not exposed yet. |
| `client.vaults` | `list(cursor?, size?)` | List collections. We use the default collection for now. |

### Search options (`memory_search_params.Options`)

```python
options = {
    "after":       "2026-01-01T00:00:00Z",   # ISO8601 lower bound
    "before":      "2026-12-31T23:59:59Z",   # ISO8601 upper bound
    "answer_model": "deepseek-r1",           # llama-3.1 (default) | gemma2 | qwen-qwq
                                              # | mistral-saba | llama-4-scout | deepseek-r1
                                              # | gpt-oss-20b | gpt-oss-120b
    "memory_types": ["procedure", "memory", "mood"],
    "resource_ids": ["..."],                 # restrict to specific docs
    "filter":       {...},                   # custom metadata filter
    "max_results":  20,
    # Per-source nested options:
    "slack":        {...}, "notion":       {...}, "google_drive": {...},
    "google_mail":  {...}, "google_calendar": {...},
    "vault":        {...}, "web_crawler":  {...}, "box":          {...},
    "reddit":       {...},
}
```

Top-level `max_results`, `sources`, `answer`, `effort` are also accepted as
direct kwargs to `client.memories.search()` — that's what we use.

---

## OAuth connect flow (verified)

1. Frontend `ConnectorsTab.startConnect(source)` opens a popup synchronously
   (no `noopener`, so we can poll `popup.closed`).
2. Frontend POSTs `/connect/start` with `{projectId, source, redirectUrl}`.
   `redirectUrl` points back to our `/connect/return` page.
3. Backend resolves `projectId` → `hyperspell_user_id`, calls
   `client.integrations.connect(integration_id, redirect_url=redirectUrl)`,
   returns `{url, hyperspell_user_id}`.
4. Frontend navigates the popup to `url`. Hyperspell hosts OAuth, then
   redirects the popup to our `/connect/return`.
5. `/connect/return` either closes itself (popup case) or fires
   `/ingest/hyperspell` itself (same-tab fallback).
6. Opener tab's `watchPopupAndIngest` polls `popup.closed` and fires
   `/ingest/hyperspell` once after close. A `useRef` guard prevents
   double-fire if both paths trigger.

End result: from the user's perspective, click → authorize → data appears
live in the UI via Supabase Realtime on `project_context`.

---

## MCP — not used in our backend

Hyperspell ships an [MCP server](https://www.npmjs.com/package/@hyperspell/hyperspell-mcp) that exposes ~7 tools (search, add_memory, get_memory, upload_file, list_integrations, connect_integration, user_info). **We don't consume it from FastAPI** — the SDK gives us 40+ endpoints (sessions, folders, evaluate, actions) plus determinism, typing, and lower latency.

MCP is still useful as a **side-feature** for power users: a developer can
add the Hyperspell MCP server to their `~/Library/Application Support/Claude/claude_desktop_config.json`
to ask Claude Desktop questions about their Project Brain vault directly. See
the upstream MCP doc page for the JSON snippet. This is a docs note, not
something the app itself needs to wire.

---

## Pricing & limits

- Free tier exists. Hackathon: 6 months unlimited as the track prize.
- Bulk add: ≤100 items per request, ≤10 MB total.
- Search: no documented hard rate limit — handle `RateLimitError` if it surfaces.

---

## SDK exception classes (catch these)

From `hyperspell` top-level: `AuthenticationError`, `BadRequestError`,
`NotFoundError`, `ConflictError`, `RateLimitError`, `APITimeoutError`,
`APIConnectionError`, `APIStatusError`, `PermissionDeniedError`,
`UnprocessableEntityError`, `InternalServerError`, `APIResponseValidationError`,
`HyperspellError` (base).

Our routers catch broadly with `except Exception` and surface as 502; tighten
to specific classes if/when we want different status codes.
