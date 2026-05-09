# Hyperspell — what we know

> Source-of-truth dump for agents (Codex, Claude in Cursor, etc.) building Project Brain integrations.
> Compiled from `https://docs.hyperspell.com/`, `https://www.hyperspell.com/`, and the Nozomio hackathon attendee doc on May 9, 2026.
> **Agents: cite the upstream URL when you copy something into code.** Mark anything not verified here as `[VERIFY]`.

---

## What it is

Hyperspell is "the company brain for AI agents." It connects to a team's data sources (Slack, Gmail, Google Drive, Notion, GitHub, etc.), continuously indexes them, and exposes a unified search API agents can call to retrieve relevant memories.

- Backed by Y Combinator. SOC 2 certified.
- Track sponsor at the Nozomio hackathon. Cash prize: **$1k + 6 months unlimited + founders deploy session + amplification** for the best Hyperspell-using submission.
- Docs root: <https://docs.hyperspell.com/>
- Connect-flow docs: <https://docs.hyperspell.com/usage/connect>
- Manual integration: <https://docs.hyperspell.com/core/integration>

---

## Sources / connectors

Confirmed (per company description + integration docs):

- **slack**
- **gmail** *(Hyperspell may name it `google_mail` in source enums — verify)*
- **google_drive** (Docs / Sheets / Slides)
- **google_calendar**
- **box**
- **notion**
- **github** — *beta, not available to all users* (per `https://docs.hyperspell.com/integrations/all/github`)

Our DB enum (`context_source`) uses shorter names: `slack`, `drive`, `notion`, `gmail`. **The backend normalizes** between Hyperspell's names and ours (see `backend/services/hyperspell.py` per Yash's plan).

---

## SDKs

| Language | Install |
|---|---|
| Python     | `pip install hyperspell` |
| TypeScript | `npm install hyperspell` |

Auth: API key from `https://app.hyperspell.com/`. Construct a per-user client:
```python
from hyperspell import Hyperspell
client = Hyperspell(api_key="API_KEY", user_id="YOUR_USER_ID")
```

For Project Brain: `user_id` is `projects.hyperspell_user_id` (e.g. `pri-<projectId>`). Lazily provisioned by Yash's `/connect/start` on first call per project.

---

## API surface (what we use)

### Add memories

Single:
```python
client.memories.add(text="...", metadata={...})  # returns resource_id
```

Bulk:
```python
client.memories.add_bulk([...])  # up to 100 items, 10 MB total
```

If validation fails on any item, the **whole batch is rejected** with a detailed error. Pre-validate.

### Search memories

```python
client.memories.search(
    query="natural language",
    sources=["slack", "google_drive"],   # use Hyperspell source names
    options={
        "filter": {...},                 # [VERIFY] schema
        "resource_ids": ["..."],         # restrict to specific docs
        "max_results": 20,
        "weight": {                      # per-source weights
            "slack": 1.0,
            "google_drive": 0.5,
        },
    },
    answer=False,                        # set True to get an LLM-generated answer
    answer_model="deepseek-r1",          # default fine-tuned Llama-3.1-Instruct-8B; alts: deepseek-r1, mistral-saba, qwen-qwq
)
```

Multi-source returns are **merged** by Hyperspell.

### Connect flow (OAuth)

`https://docs.hyperspell.com/usage/connect`. The flow we expect:

1. Backend calls Hyperspell to mint a connect URL for a `(user_id, source)` pair, optionally with a `redirect_url`.
2. Frontend redirects (or opens new tab to) the connect URL.
3. User authorizes the source via Hyperspell's hosted OAuth page.
4. Hyperspell redirects back to our `redirect_url` (or just returns to its own page).
5. Backend can query connection status (e.g. via `client.connections.list()` `[VERIFY]`).

`[VERIFY]` exact method names — the docs page is the source of truth. If the SDK doesn't expose `connections.list()`, fall back to a heuristic: presence of any `project_context` row from a source ⇒ that source is connected for that user.

### What we do NOT use

- `client.memories.add()` directly (we let Hyperspell ingest from connectors, not us pushing).
- The `answer=True` LLM-generated answer mode (we use Claude as our planner).

---

## How Project Brain uses Hyperspell

Three distinct call sites in `backend/services/hyperspell.py`:

1. **`/ingest/hyperspell` (cron + manual button)** — pulls Slack / Drive / Notion / Gmail every 5 min, embeds locally with `text-embedding-3-small`, UPSERTs into `project_context`. Dedup on `(project_id, source, external_id)` then `(project_id, source, content_hash)`.
2. **`/context/query` Stage 2 (live during meetings)** — best-effort live Hyperspell search merged with pgvector results. 500ms timeout — pgvector alone is sufficient if Hyperspell is slow.
3. **`/plan/generate` per-item code refs** — for each plan item the categorizer emits, runs `client.memories.search(item.code_query, sources=["github"], k=3)`. **Falls back to `backend/fixtures/seed_code_refs.json` if GitHub beta access is denied.**

---

## Pricing & limits

Free tier exists. Hackathon credits via `https://www.hyperspell.com/` — 6 months of unlimited usage as the track prize.

- Bulk add: ≤100 items per request, ≤10 MB total.
- Search: no documented rate limits we've seen — `[VERIFY]` if it becomes a problem.

---

## Source enum mapping (canonical)

| Hyperspell source | Our DB enum (`context_source`) |
|---|---|
| `slack` | `slack` |
| `notion` | `notion` |
| `google_drive` | `drive` |
| `google_mail` *(or `gmail`)* | `gmail` |
| `github` *(beta)* | *(not stored in `project_context`; used directly via `code_refs`)* |

Yash's `backend/services/hyperspell.py` owns this mapping. `[VERIFY]` the exact Hyperspell strings against the SDK before shipping.

---

## What's verified vs `[VERIFY]`

| Claim | Status |
|---|---|
| Has Slack, Gmail, Drive, Notion, Box, Calendar connectors | ✅ verified (company description + integration docs) |
| GitHub connector is beta, not GA | ✅ verified (integration docs) |
| Python + TypeScript SDKs exist | ✅ verified |
| `client.memories.add` / `.add_bulk` / `.search` exist | ✅ verified |
| Bulk limit: 100 items, 10 MB | ✅ verified |
| `answer_model` accepts `deepseek-r1`, `mistral-saba`, `qwen-qwq` | ✅ verified |
| Default answer model: Llama-3.1-Instruct-8B (fine-tuned) | ✅ verified |
| Exact connect URL pattern (whether SDK or REST) | `[VERIFY]` against `https://docs.hyperspell.com/usage/connect` |
| `client.connections.list()` method name | `[VERIFY]` |
| Source enum literal strings (especially `gmail` vs `google_mail`) | `[VERIFY]` |
| Filter / metadata / collection schema in `options.filter` | `[VERIFY]` |
| Per-`user_id` isolation guarantees | `[VERIFY]` — assumed but not yet stress-tested |
| Free-tier rate limits | `[VERIFY]` |

When you verify any of these, **delete the `[VERIFY]`** and replace with a citation + commit.

---

## How to extend this doc

When you discover something new about Hyperspell while implementing:

1. Add it under the right section above.
2. Tag with a source URL. If it's from the SDK source code, add the file path.
3. If you find a contradiction with what's here, **change the doc and flag it in Slack** — don't silently override.
4. Don't dump raw transcripts. Summarize.
