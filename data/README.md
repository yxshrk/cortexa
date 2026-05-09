# `data/` — demo seed data

Hand-curated demo data for the Project Brain Supabase schema. Loading this
populates every table the frontend renders so you can see the full pipeline
without running `/ingest/hyperspell` or `/plan/generate`.

## TL;DR

```bash
# from the repo root
cd backend && source .venv/bin/activate && cd ..
cd data
python seed.py
```

`seed.py` reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `backend/.env`
(auto-loaded). Re-runs are idempotent — rows UPSERT on `id`. To wipe and
re-seed cleanly: `WIPE_FIRST=1 python seed.py`.

## What gets seeded

Two projects:

| Project | UUID | Why |
|---|---|---|
| **Cortex Web** | `11111111-…` | The rich one. Every table populated. Three demo signals (Safari login, CSV export v2, rate-limit middleware) baked into Slack/Drive/Notion/Gmail and meeting notes — these are the same three signals keyed in `backend/fixtures/seed_code_refs.json`, so the `code_refs` on `plan_items` line up with the Hyperspell-GitHub-fallback path. |
| **Telemetry Pipeline** | `22222222-…` | A sparse second project (one meeting, one note, two `project_context` rows). It's there so the `/projects` landing page has a list — not for demoing the pipeline. |

## The storyline (Cortex Web)

A week of activity from **Mon 2026-05-04** to **Sat 2026-05-09** that converges
on one execution chain:

```
Safari login bug ─►  rate-limit refactor ─►  CSV export v2
   (shipped Fri)       (Marco owns, opens Mon)    (lands behind flag this wk,
                                                   external launch first half of June)
```

The seeded data shows:
- **6 meetings** with 25 transcript chunks and 18 structured notes capturing decisions, action items, and blockers across the week.
- **18 `project_context` rows** spread across slack/drive/notion/gmail: bug reports, design specs, RFCs, customer escalations, vendor alerts, stale-PR bot pings.
- **1 `knowledge_document`** (week of 2026-05-04) with 5 themes, 6 decisions, 3 blockers, 4 open questions, and full traceability arrays back to the source meeting notes and context rows.
- **3 `plan_items`** — one per category (`bug_fix` / `new_feature` / `maintenance`) — each with `code_refs` matching `backend/fixtures/seed_code_refs.json`.
- **9 `generated_actions`** — Linear ticket + GitHub PR + Devin handoff for each plan item (3 × 3). The Safari Linear ticket is `status="executed"` with a real-looking `external_url`; the rest are `status="draft"`.
- **1 `generation_run`** (`status="ready"`) so the Knowledge Doc tab's header pill renders correctly.

## Files

| File | Table | Rows |
|---|---|---|
| `projects.json` | `projects` | 2 |
| `meetings.json` | `meetings` | 7 (6 Cortex Web + 1 Telemetry) |
| `meeting_transcript_chunks.json` | `meeting_transcript_chunks` | 26 |
| `meeting_notes.json` | `meeting_notes` | 19 (18 Cortex Web + 1 Telemetry) |
| `project_context.json` | `project_context` | 20 (18 Cortex Web + 2 Telemetry) |
| `generation_runs.json` | `generation_runs` | 1 |
| `knowledge_documents.json` | `knowledge_documents` | 1 |
| `plan_items.json` | `plan_items` | 3 |
| `generated_actions.json` | `generated_actions` | 9 |
| `seed.py` | — | loader script |

## Design choices, called out

- **UUIDs are hand-picked and stable** (e.g. `aaaa0001-0001-…` for meetings, `nnnn…` for notes, `cccc…` for context, `kkkk…` for knowledge docs, `pppp…` for plan items, `gggg…` for generated actions, `rrrr…` for generation runs). This makes cross-table FKs readable and re-runs idempotent.
- **`embedding vector(1536)` columns are `null`** in every seed row. Inlining 1536-float arrays for ~40 rows would bloat these files for no demo benefit. The backend's `/ingest/hyperspell` and `/context/query` flows backfill embeddings on the fly, and the frontend's `✓ embedded` badge will light up on rows the backend has touched. If you specifically want some rows to look "embedded" before the backend runs, swap in any 1536-element array of small floats — Supabase pgvector accepts JSON arrays directly.
- **The 3 `plan_items` correspond exactly to the 3 keys in `backend/fixtures/seed_code_refs.json`** (`Safari login`, `CSV export`, `rate-limit middleware`). This means the Hyperspell-GitHub-unavailable fallback path returns the same `code_refs` the seed already shows, so a live `/plan/generate` run won't contradict what the seed says.
- **`generation_runs.status = 'ready'`** so the header status pill on the Knowledge Doc tab settles to "ready" instead of spinning.
- **`generated_actions[0]` is `executed`** with a fake Linear URL, so the Actions tab shows at least one card in the executed state — useful for a demo that wants to show before/after on action execution.

## Re-seeding while developing the frontend

```bash
WIPE_FIRST=1 python seed.py
```

Wipes child tables first (in reverse FK order) and re-inserts everything. Use
this when you've changed the seed JSONs and want a clean slate, or when the
app schema has been re-migrated.

## Caveats

- `seed.py` uses the **service-role** key, which bypasses RLS. Never run it
  from the browser or commit the key.
- `meetings.id` field on the live row (`aaaa0001-0001-…-000000000006`,
  `status='live'`) is what `<VoiceAgent meetingId={…} />` should mount against
  during the demo.
- The seed assumes the v2 schema from `supabase/migration_to_v2.sql` is
  already applied. If you see FK or enum errors, run that migration first.
