# Yash Implementation Plan: Backend, Hyperspell, Categorizer, Executors

## Summary

Build the FastAPI orchestration backend for Project Brain. You own everything from "raw inputs are sitting in Supabase" to "a real Linear ticket exists and a Devin session is running." Hyperspell is your ingestion source for project context (Slack/Drive/Notion/Gmail) and codebase context (per-item GitHub search at categorization time). Claude Sonnet 4.6 is your synthesizer + categorizer + action drafter. pgvector RPC plus a best-effort Hyperspell live call is your retrieval layer for `/context/query`. Linear, GitHub, and Devin APIs are your executors. APScheduler keeps Hyperspell project-context fresh on a 5-minute cron.

You also own the seed corpus content and the demo-day fallback fixtures (paired with Yudong on the content).

## 2026-05-09 Hyperspell SDK-First Refinement

### Review verdict

The current Hyperspell direction is correct, but the implementation has outrun the original plan in one area and is still behind it in the critical demo path.

What is aligned:

- Backend now uses the Python SDK directly instead of guessed REST shapes.
- Every Hyperspell call is scoped by `projects.hyperspell_user_id`.
- Source normalization is centralized in `backend/services/hyperspell.py`.
- Connector OAuth, connection status, revoke, vault add/upload, web crawl, session ingestion, and answer-capable search are exposed as backend wrappers.
- Frontend connector UX now opens the Hyperspell OAuth flow, redirects back to `/connect/return`, and triggers `/ingest/hyperspell` so `project_context` rows can appear via Supabase Realtime.

What is not yet aligned:

- The original Yudong contract still requires `POST /rt/token`, `GET /context/briefing`, and `POST /context/query`. The current `POST /search` is useful, but it is not a drop-in replacement because it is auth-gated, has a different response shape, and allows Hyperspell to wait up to 5s.
- The original Jin contract still requires `POST /plan/generate` and `POST /actions/{id}/execute`. Those are not implemented yet.
- APScheduler ingest and meeting-note embedding backfill are still plan-only.
- `/ingest/hyperspell` currently uses one neutral semantic query for all connector sources. That is fine for a demo smoke path, but it is not a complete mirror. Use `memories.list(source=..., status="completed", size=...)` plus `memories.get(...)` as the durable mirror path, and use `memories.search(...)` as a ranking supplement.
- `/memories/status` is a GET endpoint but lazily provisions `projects.hyperspell_user_id`. Either make it auth-gated or split user provisioning into an explicit mutating helper. Read endpoints should not write.

### Refined execution order

1. Stabilize the current Hyperspell wrapper.
   - Keep `docs/hyperspell.md` and `backend/services/hyperspell.py` as the SDK source of truth for agents.
   - Keep provider-to-integration UUID resolution for `integrations.connect(...)`; `connect` expects the integration ID, not our DB source string.
   - Add `python-multipart` to requirements because `/memories/upload` otherwise prevents `backend/main.py` from importing.
   - Log `QueryResult.errors` from `memories.search(...)` so missing connections are visible during demo setup.

2. Restore frozen demo contracts before adding more Hyperspell features.
   - Implement `routers/realtime.py` with `POST /rt/token`.
   - Implement `routers/context.py` with `GET /context/briefing` and `POST /context/query`.
   - Keep `/context/query` public, local pgvector first, Hyperspell second with a 500ms timeout, and return the `ContextItem[]` shape Yudong expects.
   - Treat `POST /search` as an internal/power search endpoint, not the voice-agent contract.

3. Make ingestion mirror-first and SDK-native.
   - For each source in `slack`, `google_drive`, `notion`, `google_mail`, call `client.memories.list(source=hs_source, status="completed", size=100)`.
   - Fan out `client.memories.get(resource_id, source=hs_source)` to extract `memories[]` / `data[]` text.
   - Upsert to `project_context` by `(project_id, source, external_id)` and fallback `(project_id, source, content_hash)`.
   - Return response fields as `upserted`, `by_source`, and optional `errors`; do not claim `skipped_dupes` unless you pre-check existing rows.
   - Keep the current neutral `memories.search(...)` query as a bonus "latest planning context" pull if the list path returns too much noise.

4. Push our own high-value artifacts back into Hyperspell.
   - After a meeting ends, call `/memories/session` or the underlying `client.sessions.add(history=..., extract=["procedure","memory"])` with stable metadata `{project_id, meeting_id}`.
   - After `/plan/generate` creates the weekly knowledge document, call `client.memories.add(text=summary_blob, resource_id=f"kdoc:{doc_id}", title=..., metadata={project_id, week_start, kind:"knowledge_document"})`.
   - Use `add_bulk` for seed/demo corpus imports; keep chunks below Hyperspell's 100-item / 10MB batch limit.
   - Supabase remains canonical for `meeting_notes`, `knowledge_documents`, `plan_items`, and `generated_actions`; Hyperspell is an extra recall layer.

5. Finish the product path.
   - Implement `/plan/generate`: synthesize, categorize, attach code refs, draft actions, and update `generation_runs`.
   - Implement `get_code_refs(query)` with Hyperspell GitHub first and `backend/fixtures/seed_code_refs.json` fallback.
   - Implement `/actions/{id}/execute` for Linear, GitHub PR draft, and Devin handoff.
   - Start APScheduler only after manual route smoke tests pass; keep the pause-at-demo-time control.

### Agent alignment contracts

- Jin should keep calling `POST /connect/start`, `GET /connect/status`, `POST /ingest/hyperspell`, `POST /plan/generate`, and `POST /actions/{id}/execute` with `Authorization: Bearer ${NEXT_PUBLIC_DEMO_TOKEN}` for mutating routes.
- Yudong should call only `POST /rt/token`, `GET /context/briefing`, and `POST /context/query`; no demo token should be required for those voice-agent reads.
- No other agent should call Hyperspell directly from the browser. All Hyperspell API key usage stays in Yash's FastAPI backend.
- If vault uploads, web crawls, or manual text memories need to appear in the Inputs UI, expand the DB enum intentionally; until then they are searchable through `/search` but are not mirrored into `project_context`.

## Key Changes

- Stand up FastAPI with the core product routes plus Hyperspell utility routes:
  - `POST /rt/token` — proxy to `https://api.openai.com/v1/realtime/client_secrets`. Return `{ value, expires_at }` flat. Public.
  - `GET /context/briefing?projectId=X` — assemble briefing from last 7 days of `meeting_notes` + `project_context`, plus fresh Hyperspell latest design docs / active files. Cache per `(projectId, day)`. Public.
  - `POST /context/query` — sub-1s. Stage 1: pgvector cosine over `meeting_notes` + `project_context` via Supabase RPC `search_context`. Stage 2: Hyperspell live with 500ms timeout, merged best-effort. 60s same-query cache. Public.
  - `POST /connect/start` — `{ projectId, source, redirectUrl? }` → Hyperspell connect URL for OAuth. Frontend opens it in a new tab. Lazily provisions `projects.hyperspell_user_id` (e.g. `pri-<projectId>`) on first call. Auth-gated because it writes the project row.
  - `GET /connect/status?projectId=X` — `{ slack, drive, notion, gmail, github: "connected"|"not_connected"|"beta" }`. Computed from Hyperspell `connections.list()` if available; falls back to a heuristic over `project_context` (presence of any row from a source ⇒ connected). 30s in-memory cache. Public.
  - `POST /ingest/hyperspell` — Hyperspell list/search across Slack/Drive/Notion/Gmail, fetch full memory bodies, embed each item with `text-embedding-3-small`, UPSERT `project_context` (dedup on `(project_id, source, external_id)` or `content_hash`). Auth-gated.
  - `POST /plan/generate` — the linear pipeline. Synthesize → categorize → per-item Hyperspell GitHub → action drafts. Wrapped in `generation_runs` with `(project_id, week_start, idempotency_key)` unique key. REPLACE `plan_items` for the doc on rerun (cascades to `generated_actions`). Auth-gated.
  - `POST /actions/{id}/execute` — dispatch to Linear / GitHub / Devin. UPDATE `external_url` + `status`. Auth-gated.
  - `POST /search` — auth-gated unified/power search: Hyperspell `memories.search(answer?)` plus local `search_context`. This is not Yudong's `/context/query` contract.
  - `POST /memories/add`, `POST /memories/upload`, `GET /memories/status`, `POST /memories/web-crawl`, `POST /memories/session` — SDK-backed utility routes for manual memories, files, indexing status, web crawl, and transcript/agent-trace ingestion.
- Build `get_code_refs(query)` with Hyperspell GitHub primary and `seed_code_refs.json` fixture fallback.
- Normalize Hyperspell sources at the backend boundary. Hyperspell source names are `slack`, `notion`, `google_drive`, `google_mail`, and `github`; `project_context.source` stays the shorter DB enum (`slack`, `notion`, `drive`, `gmail`) for Jin's UI.
- Scope Hyperspell calls with `projects.hyperspell_user_id` by constructing the Hyperspell client/request for that user. Do not assume Hyperspell accepts our Supabase `project_id` as a search parameter unless you add it as metadata/collection filtering.
- Own a backend compatibility path for Yudong gaps: if `meeting_notes` rows arrive without `embedding`, FastAPI backfills them with `text-embedding-3-small` using the service-role key before `/context/query` relies on pgvector. This keeps live context search working without requiring frontend changes.
- Own an auth-gated demo seed fallback: a script or backend-only helper can insert the three demo signals as `meeting_notes` + `project_context` rows with embeddings if the voice listener is behind schedule. Normal path still uses Yudong's inserts.
- APScheduler in-process: `/ingest/hyperspell` every 5 minutes for every project, idempotent. Pause job at 5:55pm so the cron doesn't fire mid-demo.
- Auth dependency `require_demo_token` on all mutating endpoints. Read endpoints stay public only when they do not write; Yudong's `/rt/token`, `/context/briefing`, and `/context/query` stay public so the voice agent does not need a server secret.
- All Supabase writes go through `supabase-py` with the service-role key (bypasses RLS). Never use anon key from backend.

## Implementation Details

### FastAPI scaffold

Layout (matches §3 Yash files in `project_brain_technical_execution_plan.md`):

```
backend/
  main.py                       FastAPI app, CORS, scheduler startup
  dependencies.py               require_demo_token
  routers/
    realtime.py                 POST /rt/token
    context.py                  GET /context/briefing, POST /context/query
    ingest.py                   POST /ingest/hyperspell
    plan.py                     POST /plan/generate
    actions.py                  POST /actions/{id}/execute
  services/
    hyperspell.py               search wrapper for project_context + GitHub
    embeddings.py               openai text-embedding-3-small
    meeting_note_embeddings.py   service-role backfill for notes missing embeddings
    briefing_builder.py         cached briefing assembly
    synthesizer.py              Claude #1 → knowledge_documents row
    categorizer.py              Claude #2 → plan_items + per-item code_refs
    action_drafter.py           Claude #3 → generated_actions (×3 per item)
    code_refs.py                get_code_refs() — Hyperspell GitHub or fixture
    executors/
      linear.py                 create_linear_issue()
      github.py                 create_github_pr_draft()
      devin.py                  send_to_devin()
    supabase_writer.py          supabase-py wrappers (service role)
  fixtures/
    seed_code_refs.json         demo-day fallback if Hyperspell GitHub beta unavailable
  jobs/
    ingest_cron.py              APScheduler job
    backfill_meeting_notes.py    periodic null-embedding repair
  scripts/
    seed_demo_data.py            auth/local-only fallback corpus seeder
  schemas.py                    Pydantic models matching §7 of technical plan
  settings.py                   env vars
```

### `/rt/token`

```python
@router.post("/rt/token")
async def mint_token():
    async with httpx.AsyncClient(timeout=10) as cx:
        r = await cx.post(
            "https://api.openai.com/v1/realtime/client_secrets",
            headers={"Authorization": f"Bearer {OPENAI_KEY}"},
            json={"session": {"type": "realtime", "model": "gpt-realtime"}},
        )
        r.raise_for_status()
    return r.json()  # { "value": "ek_...", "expires_at": 1715275500, ... }
```

Frozen response shape: `{ value: string, expires_at: number }`. Frontend (Yudong) uses `body.value` directly as the WebRTC bearer token.

### `/ingest/hyperspell`

Updated rule: the durable mirror should use `memories.list(...)` per source,
then `memories.get(...)` for bodies. `memories.search(...)` is a relevance
booster, not the only mirror path.

```python
HYPERSPELL_SOURCE_TO_DB_SOURCE = {
    "slack": "slack",
    "notion": "notion",
    "google_drive": "drive",
    "google_mail": "gmail",
}

async def ingest_hyperspell(project_id: str):
    project = sb.table("projects").select("hyperspell_user_id").eq(
        "id", project_id
    ).single().execute().data
    hs = hyperspell_for_user(project["hyperspell_user_id"])

    inserted, updated, skipped = 0, 0, 0
    for hs_source, db_source in HYPERSPELL_SOURCE_TO_DB_SOURCE.items():
        resources = await hs.memories.list(
            source=hs_source,
            status="completed",
            size=100,
        )
        for resource in resources:
            item = await hs.memories.get(resource.resource_id, source=resource.source)
            content_hash = sha256(item.full_text.encode()).hexdigest()
            embedding = await embed(item.full_text)
            row = {
                "project_id": project_id,
                "source": db_source,
                "external_id": item.external_id,
                "title": item.title,
                "snippet": item.snippet[:500],
                "full_text": item.full_text,
                "content_hash": content_hash,
                "author": item.author,
                "ref_url": item.ref_url,
                "source_created_at": item.created_at,
                "source_updated_at": item.updated_at,
                "embedding": embedding,
            }
            conflict = (
                "project_id,source,external_id"
                if item.external_id else
                "project_id,source,content_hash"
            )
            res = sb.table("project_context").upsert(
                row, on_conflict=conflict
            ).execute()
            inserted += 1 if res.is_new else 0
    return {"inserted": inserted, "updated": updated, "skipped_dupes": skipped}
```

### `/context/query`

```python
async def context_query(project_id: str, query: str, k: int = 6):
    cache_key = (project_id, query)
    if cache_key in cache and not stale(cache_key, ttl=60):
        return cache[cache_key]

    # Repair Yudong-owned rows if his first pass inserted notes without embeddings.
    # Service-role backend owns this compatibility layer; no frontend contract change.
    await backfill_missing_meeting_note_embeddings(project_id, limit=25)

    q_emb = await embed(query)
    # Stage 1: pgvector RPC
    local = sb.rpc("search_context", {
        "p_project_id": project_id, "q_emb": q_emb, "p_limit": k,
    }).execute().data or []

    # Stage 2: best-effort Hyperspell live
    hs = []
    try:
        project = sb.table("projects").select("hyperspell_user_id").eq(
            "id", project_id
        ).single().execute().data
        hs_client = hyperspell_for_user(project["hyperspell_user_id"])
        hs = await asyncio.wait_for(
            hs_client.memories.search(query=query, k=k // 2),
            timeout=0.5,
        )
    except asyncio.TimeoutError:
        pass

    merged = dedupe_by_ref_url(local + hs)
    out = sorted(merged, key=lambda x: x["score"], reverse=True)[:k]
    cache[cache_key] = (now(), out)
    return out
```

### Meeting note embedding backfill

Yudong's correct contract is still `/api/voice/summarize` returns `embedding` and the frontend inserts it into `meeting_notes`. If that slips, Yash can cover it from the backend without touching Yudong's files.

```python
async def backfill_missing_meeting_note_embeddings(project_id: str, limit: int = 50):
    rows = sb.table("meeting_notes").select("id,text").eq(
        "project_id", project_id
    ).is_("embedding", "null").limit(limit).execute().data or []

    if not rows:
        return {"updated": 0}

    vectors = await embed_many([r["text"] for r in rows])
    for row, vector in zip(rows, vectors):
        sb.table("meeting_notes").update({
            "embedding": vector,
        }).eq("id", row["id"]).execute()

    return {"updated": len(rows)}
```

Run this in two places:

- At the start of `/context/query`, capped to 25 rows, so live RAG improves as soon as notes exist.
- As an APScheduler job every 60 seconds for all active projects, so old rows are repaired even if nobody calls `/context/query`.

This is a compatibility layer only. Do not ask Yudong to change ownership boundaries during the hack unless his insert fails entirely.

### Demo seed fallback

If the voice path is not ready by the 1:30pm checkpoint, run a backend-only seed helper that inserts the three scripted demo signals with embeddings:

```bash
cd backend
python scripts/seed_demo_data.py --project-id <uuid>
```

The seed should create:

- one Safari login bug note,
- one CSV export v2 feature note,
- one rate-limit maintenance note,
- matching `project_context` rows from the demo corpus,
- embeddings for every inserted row.

Keep this behind local execution or `DEMO_TOKEN`. It is a demo safety net, not the main product path.

### `/plan/generate`

The heart of the product. Idempotent + job-backed.

```python
async def generate_plan(project_id: str, idem_key: str | None = None):
    wk_start, wk_end = current_iso_week()

    # 1) Reserve a run row.
    # The partial unique index `generation_runs_one_active_uniq` enforces
    # at most ONE row with status in ('queued','running') per (project_id, week_start).
    # Concurrent calls trip the index → second one gets 409.
    try:
        run = sb.table("generation_runs").insert({
            "project_id": project_id,
            "week_start": wk_start,
            "idempotency_key": idem_key or str(uuid4()),
            "status": "running",
            "started_at": "now()",
        }).execute().data[0]
    except IntegrityError:
        existing = sb.table("generation_runs").select("*").eq(
            "project_id", project_id
        ).eq("week_start", wk_start).in_("status", ["queued", "running"]).execute().data[0]
        raise HTTPException(409, {"runId": existing["id"], "status": existing["status"]})

    try:
        notes   = sb.table("meeting_notes").select("*").eq("project_id", project_id).gte("ts", wk_start).execute().data
        context = sb.table("project_context").select("*").eq("project_id", project_id).gte("ts", wk_start).execute().data

        # Step 1: synthesis (Claude #1)
        doc = await synthesizer.run(notes, context)
        doc_id = sb.table("knowledge_documents").upsert({
            "project_id": project_id, "week_start": wk_start, "week_end": wk_end,
            "status": "generating", **doc,
        }, on_conflict="project_id,week_start").execute().data[0]["id"]

        # Step 2: REPLACE plan_items (cascades to generated_actions)
        sb.table("plan_items").delete().eq("knowledge_document_id", doc_id).execute()

        items = await categorizer.run(doc)
        for item in items:
            code_refs = await get_code_refs(item.code_query)
            pi = sb.table("plan_items").insert({
                "knowledge_document_id": doc_id,
                "project_id": project_id,
                "generation_run_id": run["id"],
                "category": item.category,
                "title": item.title,
                "description": item.description,
                "source_refs": item.source_refs,
                "code_refs": code_refs,
                "next_step": item.next_step,
                "confidence": item.confidence,
            }).execute().data[0]

            # Step 3: action drafts (Claude #3)
            for draft in await action_drafter.run(item, code_refs):
                sb.table("generated_actions").insert({
                    "plan_item_id": pi["id"],
                    "project_id": project_id,        # denormalized for realtime
                    "generation_run_id": run["id"],
                    **draft,
                }).execute()

        sb.table("knowledge_documents").update({"status": "ready"}).eq("id", doc_id).execute()
        sb.table("generation_runs").update({
            "status": "ready", "finished_at": "now()"
        }).eq("id", run["id"]).execute()
        return {"runId": run["id"], "knowledgeDocumentId": doc_id}
    except Exception as e:
        sb.table("generation_runs").update({
            "status": "error", "error": str(e), "finished_at": "now()"
        }).eq("id", run["id"]).execute()
        raise
```

### `get_code_refs`

```python
async def get_code_refs(query: str) -> list[CodeRef]:
    if HYPERSPELL_GITHUB_AVAILABLE:
        try:
            hits = await asyncio.wait_for(
                hyperspell.memories.search(query=query, sources=["github"], k=3),
                timeout=2.0,
            )
            if hits:
                return [{"path": h.path, "lines": h.lines, "snippet": h.snippet[:200]} for h in hits]
        except Exception as e:
            log.warning(f"Hyperspell GitHub failed: {e}; using fixture")
    return fixture_code_refs(query)  # keyword-match against seed_code_refs.json
```

### `/actions/{id}/execute`

```python
async def execute_action(action_id: str):
    a = sb.table("generated_actions").select("*").eq("id", action_id).single().execute().data
    sb.table("generated_actions").update({"status": "executing"}).eq("id", action_id).execute()
    try:
        if a["action_type"] == "linear_ticket":
            url = await executors.linear.create(a["payload"])
        elif a["action_type"] == "github_pr":
            url = await executors.github.create_pr_draft(a["payload"])
        elif a["action_type"] == "devin_handoff":
            url = await executors.devin.send(a["payload"])
        sb.table("generated_actions").update({
            "status": "executed", "external_url": url
        }).eq("id", action_id).execute()
        return {"externalUrl": url}
    except Exception as e:
        sb.table("generated_actions").update({
            "status": "failed"
        }).eq("id", action_id).execute()
        raise HTTPException(500, str(e))
```

### Auth dependency

```python
# backend/dependencies.py
from fastapi import Header, HTTPException
import os

async def require_demo_token(authorization: str = Header(None)):
    expected = f"Bearer {os.environ['DEMO_TOKEN']}"
    if authorization != expected:
        raise HTTPException(401, "bad token")
```

Apply via `Depends(require_demo_token)` on `/ingest/hyperspell`, `/plan/generate`, `/actions/{id}/execute`. Read endpoints (briefing, query, rt/token) stay public.

### APScheduler cron

```python
# backend/main.py
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from jobs.ingest_cron import ingest_all_projects

scheduler = AsyncIOScheduler()

@app.on_event("startup")
async def start_scheduler():
    scheduler.add_job(ingest_all_projects, "interval", minutes=5, id="hs_ingest")
    scheduler.start()
```

Pause at 5:55pm: `scheduler.pause_job("hs_ingest")`.

## Interfaces

### Yash exposes (HTTP)

- `POST {FASTAPI}/rt/token` → `{ value, expires_at }`
- `GET {FASTAPI}/context/briefing?projectId=<uuid>` → briefing JSON
- `POST {FASTAPI}/context/query` `{ projectId, query, k }` → `ContextItem[]`
- `POST {FASTAPI}/ingest/hyperspell` (Bearer DEMO_TOKEN) `{ projectId }` → counts
- `POST {FASTAPI}/plan/generate` (Bearer DEMO_TOKEN) `{ projectId }` → `{ runId, knowledgeDocumentId }` or 409
- `POST {FASTAPI}/actions/{id}/execute` (Bearer DEMO_TOKEN) → `{ externalUrl }`

Full request/response shapes frozen in §5 of `project_brain_technical_execution_plan.md`.

### Yash calls (external)

- OpenAI Realtime client_secrets endpoint — for ephemeral tokens.
- OpenAI Embeddings — `text-embedding-3-small` for `project_context.embedding` and `/context/query`.
- Anthropic Messages API — Claude Sonnet 4.6, tool-use schemas for synthesize/categorize/action-draft.
- Hyperspell `memories.search` — for project_context (Slack/Drive/Notion/Gmail) and codebase (GitHub).
- Linear API — `issueCreate` mutation.
- GitHub API — `pulls.create` (requires existing pushed branch).
- Devin API — `sessions` endpoint for handoff.
- Supabase via `supabase-py` with service-role key — all DB writes.

### Yash owns

- Everything under `backend/**`.
- `backend/fixtures/seed_code_refs.json` (paired with Yudong on content).
- All Anthropic, OpenAI, Hyperspell, Linear, GitHub, Devin API keys (none ever leak to frontend).
- The `DEMO_TOKEN` rotation.

## Test Plan

- `/rt/token` smoke test:
  - `curl -X POST $FASTAPI/rt/token` returns `{value: "ek_...", expires_at: <int>}` within 1s.
- `/context/briefing` smoke test:
  - Returns valid JSON with `themes`, `active_files`, `people` arrays populated when project has corpus.
  - Cache hit on 2nd call same day (verify via log line).
- `/ingest/hyperspell` smoke test:
  - Run twice; second run reports `skipped_dupes` > 0 (no duplicate inserts).
  - Inserted rows have non-null `embedding` and `content_hash`.
- `/context/query` performance test:
  - 10 calls with diverse queries — p95 < 1s.
  - Stage 2 timeout verified by simulating Hyperspell slowness (still returns p1 results).
  - Insert a `meeting_notes` row with `embedding = null`; call `/context/query`; verify the row receives an embedding and can appear in RPC results.
- `/plan/generate` idempotency test:
  - Fire two concurrent `curl`s with no idempotency key — first returns 202, second returns 409.
  - Re-run with same week — no duplicate `plan_items` (verify `count(*) = items_per_run`).
  - Inject failure mid-run — `generation_runs.status` flips to `error` with text; partial rows cleaned up.
- `/actions/{id}/execute` test:
  - Linear: real ticket appears in sandbox project.
  - GitHub PR: draft created against pre-pushed branch.
  - Devin: session URL returned.
  - On failure, status flips to `failed`, no partial state.
- Auth gate test:
  - `curl /plan/generate` without token → 401.
  - With wrong token → 401.
  - With correct token → 202.
- APScheduler test:
  - Wait 5 minutes from boot, verify `/ingest/hyperspell` ran via Supabase row count or log line.
  - Insert three note rows without embeddings; verify the 60s backfill job updates them.
  - `scheduler.pause_job("hs_ingest")` — verify next 5 min interval does not fire.
- Hyperspell GitHub fallback test:
  - Set `HYPERSPELL_GITHUB_AVAILABLE = False`; verify `get_code_refs` returns fixture matches.
- Demo seed fallback test:
  - Run `scripts/seed_demo_data.py --project-id <uuid>`; verify the three demo signals appear in `meeting_notes`, `project_context`, `/context/query`, and `/plan/generate`.

## Assumptions

- Jin has Supabase v2 schema deployed (per technical plan §6 + migration in `supabase/migration_to_v2.sql`), Realtime publication enabled on the 7 reactive tables, RLS policies applied, and the `search_context` RPC granted to `anon`.
- Jin has handed over `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` via 1Password.
- Yudong's `VoiceAgent` calls `/rt/token`, `/context/briefing`, and `/context/query` exactly as defined in §5.
- Yudong INSERTs into `meeting_notes` directly (anon key) — Yash never sees individual transcript chunks via `/voice/append` (that endpoint does not exist in v2). If those rows miss embeddings, Yash's backend repairs them asynchronously.
- Hyperspell GitHub beta access is **TBD** — verified tonight; if denied, `seed_code_refs.json` fixtures become primary and Hyperspell GitHub becomes the bonus.
- ngrok or equivalent is providing a stable public URL for FastAPI (ngrok subdomain reserved tonight).
- Linear sandbox project + GitHub demo repo + pushed feature branch + Devin account are all set up tonight.
- The `DEMO_TOKEN` is generated tonight, shared via 1Password, and set in Vercel env as `NEXT_PUBLIC_DEMO_TOKEN` for Jin's frontend.
