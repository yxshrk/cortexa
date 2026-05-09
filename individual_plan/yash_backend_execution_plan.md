# Yash Implementation Plan: Backend, Hyperspell, Categorizer, Executors

## Summary

Build the FastAPI orchestration backend for Project Brain. You own everything from "raw inputs are sitting in Supabase" to "a real Linear ticket exists and a Devin session is running." Hyperspell is your ingestion source for project context (Slack/Drive/Notion/Gmail) and codebase context (per-item GitHub search at categorization time). Claude Sonnet 4.6 is your synthesizer + categorizer + action drafter. pgvector RPC plus a best-effort Hyperspell live call is your retrieval layer for `/context/query`. Linear, GitHub, and Devin APIs are your executors. APScheduler keeps Hyperspell project-context fresh on a 5-minute cron.

You also own the seed corpus content and the demo-day fallback fixtures (paired with Yudong on the content).

## Key Changes

- Stand up FastAPI with six routes:
  - `POST /rt/token` — proxy to `https://api.openai.com/v1/realtime/client_secrets`. Return `{ value, expires_at }` flat. Public.
  - `GET /context/briefing?projectId=X` — assemble briefing from last 7 days of `meeting_notes` + `project_context`, plus fresh Hyperspell latest design docs / active files. Cache per `(projectId, day)`. Public.
  - `POST /context/query` — sub-1s. Stage 1: pgvector cosine over `meeting_notes` + `project_context` via Supabase RPC `search_context`. Stage 2: Hyperspell live with 500ms timeout, merged best-effort. 60s same-query cache. Public.
  - `POST /ingest/hyperspell` — Hyperspell search across Slack/Drive/Notion/Gmail, embed each item with `text-embedding-3-small`, UPSERT `project_context` (dedup on `(project_id, source, external_id)` or `content_hash`). Auth-gated.
  - `POST /plan/generate` — the linear pipeline. Synthesize → categorize → per-item Hyperspell GitHub → action drafts. Wrapped in `generation_runs` with `(project_id, week_start, idempotency_key)` unique key. REPLACE `plan_items` for the doc on rerun (cascades to `generated_actions`). Auth-gated.
  - `POST /actions/{id}/execute` — dispatch to Linear / GitHub / Devin. UPDATE `external_url` + `status`. Auth-gated.
- Build `get_code_refs(query)` with Hyperspell GitHub primary and `seed_code_refs.json` fixture fallback.
- APScheduler in-process: `/ingest/hyperspell` every 5 minutes for every project, idempotent. Pause job at 5:55pm so the cron doesn't fire mid-demo.
- Auth dependency `require_demo_token` on all mutating endpoints. Read endpoints stay public so Yudong's voice agent (no secret holder) can call them.
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

```python
async def ingest_hyperspell(project_id: str):
    inserted, updated, skipped = 0, 0, 0
    for source in ["slack", "drive", "notion", "gmail"]:
        items = await hyperspell.memories.search(
            project_id=project_id, sources=[source], k=20
        )
        for item in items:
            content_hash = sha256(item.full_text.encode()).hexdigest()
            embedding = await embed(item.full_text)
            row = {
                "project_id": project_id,
                "source": source,
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
            res = sb.table("project_context").upsert(
                row, on_conflict="project_id,source,external_id"
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

    q_emb = await embed(query)
    # Stage 1: pgvector RPC
    local = sb.rpc("search_context", {
        "p_project_id": project_id, "q_emb": q_emb, "p_limit": k,
    }).execute().data or []

    # Stage 2: best-effort Hyperspell live
    hs = []
    try:
        hs = await asyncio.wait_for(
            hyperspell.memories.search(project_id=project_id, query=query, k=k // 2),
            timeout=0.5,
        )
    except asyncio.TimeoutError:
        pass

    merged = dedupe_by_ref_url(local + hs)
    out = sorted(merged, key=lambda x: x["score"], reverse=True)[:k]
    cache[cache_key] = (now(), out)
    return out
```

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
  - `scheduler.pause_job("hs_ingest")` — verify next 5 min interval does not fire.
- Hyperspell GitHub fallback test:
  - Set `HYPERSPELL_GITHUB_AVAILABLE = False`; verify `get_code_refs` returns fixture matches.

## Assumptions

- Jin has Supabase v2 schema deployed (per technical plan §6 + migration in `supabase/migration_to_v2.sql`), Realtime publication enabled on the 7 reactive tables, RLS policies applied, and the `search_context` RPC granted to `anon`.
- Jin has handed over `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` via 1Password.
- Yudong's `VoiceAgent` calls `/rt/token`, `/context/briefing`, and `/context/query` exactly as defined in §5.
- Yudong INSERTs into `meeting_notes` directly (anon key) — Yash never sees individual transcript chunks via `/voice/append` (that endpoint does not exist in v2).
- Hyperspell GitHub beta access is **TBD** — verified tonight; if denied, `seed_code_refs.json` fixtures become primary and Hyperspell GitHub becomes the bonus.
- ngrok or equivalent is providing a stable public URL for FastAPI (ngrok subdomain reserved tonight).
- Linear sandbox project + GitHub demo repo + pushed feature branch + Devin account are all set up tonight.
- The `DEMO_TOKEN` is generated tonight, shared via 1Password, and set in Vercel env as `NEXT_PUBLIC_DEMO_TOKEN` for Jin's frontend.
