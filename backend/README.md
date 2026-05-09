# backend/

Yash's territory. FastAPI orchestration backend for Project Brain.

## Owner

**Yash** — see [`individual_plan/yash_backend_execution_plan.md`](../individual_plan/yash_backend_execution_plan.md).

## What lives here

```
backend/
  main.py                       FastAPI app + CORS + scheduler startup
  dependencies.py               require_demo_token (Bearer auth dep)
  routers/
    realtime.py                 POST /rt/token
    context.py                  GET /context/briefing, POST /context/query
    ingest.py                   POST /ingest/hyperspell
    plan.py                     POST /plan/generate
    actions.py                  POST /actions/{id}/execute
  services/
    hyperspell.py               search wrapper (project_context + GitHub)
    embeddings.py               OpenAI text-embedding-3-small
    briefing_builder.py         cached briefing assembly
    synthesizer.py              Claude #1 → knowledge_documents
    categorizer.py              Claude #2 + per-item Hyperspell GitHub
    action_drafter.py           Claude #3 → generated_actions
    code_refs.py                get_code_refs() with fixture fallback
    executors/{linear,github,devin}.py
    supabase_writer.py
  fixtures/
    seed_code_refs.json         demo-day fallback code refs
  jobs/
    ingest_cron.py              APScheduler 5-min Hyperspell pull
  schemas.py                    Pydantic models matching §7
  settings.py                   env vars
```

## Bootstrap (do tonight)

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install fastapi uvicorn httpx pydantic supabase \
            apscheduler anthropic openai python-dotenv
```

Then create `.env` with: `OPENAI_KEY`, `ANTHROPIC_KEY`, `HYPERSPELL_KEY`, `LINEAR_TOKEN`, `GITHUB_TOKEN`, `DEVIN_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DEMO_TOKEN`.

Run: `uvicorn main:app --reload`.

Expose publicly via ngrok: `ngrok http 8000` → bake the URL into Vercel as `NEXT_PUBLIC_FASTAPI_URL`.

## Source of truth

For endpoint contracts, output schemas, and behavior: [`../project_brain_technical_execution_plan.md`](../project_brain_technical_execution_plan.md) §3 (Yash) and §5 (contracts).
