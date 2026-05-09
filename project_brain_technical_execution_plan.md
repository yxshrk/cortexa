# Project Brain — Technical Execution Plan

> Nozomio Hackathon · May 9, 2026 · Entrepreneurs First, SF
> Track: **🧠 The Company Brain** (Hyperspell-led)
> Team: Yash · Jin · Yudong
> Submissions close 6:00pm · in-person judging 6:10pm (3 min each)

---

## 0. The Big Idea

A linear pipeline, per project:

```
   RAW INPUTS                     SYNTHESIS              CATEGORIZED          EXECUTION
   ──────────                     ─────────              ───────────          ─────────
   meeting_notes ──────┐
   (voice agent)       ├──────►  knowledge_document  ──►  plan_items   ──►  generated_actions
                       │         (themes, decisions,      (bug_fix /         (linear / pr /
   project_context ────┘          blockers, summary)       new_feature /      devin drafts)
   (Slack, Drive,                                          maintenance,
   Notion, Gmail)                                          with code_refs)
                                                           ▲
                                                           │ codebase pulled HERE
                                                           │ (Hyperspell GitHub,
                                                           │  per-item)
```

Five core tables, one flow. Inputs are continuous (voice agent + 5min Hyperspell cron). Synthesis + categorization run on demand. Codebase context is pulled *per item* during categorization.

**Retrieval**: `meeting_notes` and `project_context` are embedded with OpenAI `text-embedding-3-small` and stored as `pgvector(1536)` columns. `/context/query` uses cosine similarity (HNSW index). Codebase still comes from Hyperspell GitHub at categorization time.

---

## 1. Stack

| Layer | Tech | Sponsor | Owner |
|---|---|---|---|
| Project context (Slack/Drive/Notion/Gmail) ingestion | **Hyperspell** | ✅ track | Yash |
| Codebase context (live RAG, per item) | **Hyperspell GitHub** *(beta)* | ✅ track | Yash |
| Live meeting capture | **OpenAI Realtime API** (WebRTC) | ✅ | Yudong |
| Database + realtime + **vector** | **Supabase** (Postgres + Realtime + RLS + **pgvector**) | — | Jin (with Yash) |
| Embedding model | **OpenAI `text-embedding-3-small`** (1536 dim) | ✅ | Yash + Yudong |
| Frontend | **Next.js** (App Router) on **Vercel** | ✅ | Jin (page) + Yudong (voice agent) |
| Live context diagram | **React Flow** (`@xyflow/react`) | — | Yudong |
| Backend orchestration | **FastAPI** (Python) + APScheduler | — | Yash |
| Synthesis + categorization LLM | **Claude Sonnet 4.6** | — | Yash |
| Voice summarizer | **GPT-4.1** (Next.js route handler) | — | Yudong |
| Executors | Linear · GitHub · **Devin** | ✅ Devin | Yash |

**Sponsors visible**: Hyperspell · OpenAI · Vercel · Devin = 4. *(Stretch: APScheduler → Tensorlake = 5th.)*

---

## 2. Architecture

```
┌─── BROWSER (Next.js on Vercel) ─────────────────────────────────────────┐
│                                                                          │
│   /projects ──► /projects/[id]                                           │
│                                                                          │
│   ┌─ Project page ────────────────────────────────────────────────────┐  │
│   │   Tabs:  📥 Inputs  |  🧠 Knowledge Doc  |  ⚡ Actions              │  │
│   │   ──────────────────────────────────────────────────────────────  │  │
│   │                                                                    │  │
│   │   📥 Inputs                                                        │  │
│   │     ▸ Meetings           ── <VoiceAgent /> (Yudong)               │  │
│   │                              + live React Flow context board      │  │
│   │                              + list of past meetings with notes   │  │
│   │     ▸ Project Context    ── grouped by Slack/Drive/Notion/Gmail   │  │
│   │                              auto-refresh every 5 min             │  │
│   │                                                                    │  │
│   │   🧠 Knowledge Doc (this week's synthesis)                         │  │
│   │     ▸ Summary · Themes · Decisions · Blockers · Open questions    │  │
│   │     ▸ Plan items: 🐛 Bug fixes · ✨ New features · 🔧 Maintenance  │  │
│   │       each item: title, description, source_refs, code_refs       │  │
│   │                                                                    │  │
│   │   ⚡ Actions                                                       │  │
│   │     One row per plan item × 3 drafts (Linear / PR / Devin)        │  │
│   │     Execute button → real ticket / PR / Devin session             │  │
│   └────────────────────────────────────────────────────────────────────┘  │
└──────────┬───────────────────────────────────────────┬───────────────────┘
           │ supabase-js (anon key)                    │ fetch HTTP (+Bearer)
           │  • Yudong: INSERT meeting_notes only      │  • Yudong → /rt/token,
           │  • Jin: SELECT (realtime) on all tables   │              /context/briefing,
           │                                           │              /context/query
           │                                           │  • Jin → /ingest/hyperspell,
           │                                           │              /plan/generate,
           │                                           │              /actions/{id}/execute
           ▼                                           ▼
┌── SUPABASE ── JIN (schema) ──────────┐   ┌── FASTAPI ── YASH ──────────────────┐
│                                      │   │                                     │
│  RAW INPUTS  (with vector(1536))     │   │  GET  /context/briefing             │
│   ▸ meeting_notes      (Yudong)      │   │  POST /rt/token                     │
│   ▸ project_context    (Yash cron)   │   │  POST /context/query (pgvector +    │
│   ▸ meeting_transcript_chunks        │   │       Hyperspell merge, <1s)        │
│     (raw audit trail; refs_to)       │   │                                     │
│                                      │   │  POST /ingest/hyperspell  ⓐ        │
│  SYNTHESIS                           │   │    └─► writes project_context       │
│   ▸ knowledge_documents              │◄──┤        + computes embedding         │
│                                      │py │                                     │
│  CATEGORIZED                         │svc│  POST /plan/generate      ⓐ        │
│   ▸ plan_items (with code_refs)      │   │    1) read meeting_notes +          │
│                                      │   │       project_context (last 7d,     │
│  EXECUTION                           │   │       optionally pgvector-ranked)   │
│   ▸ generated_actions (with          │   │    2) Claude synthesis →            │
│     denormalized project_id)         │   │       knowledge_documents (UPSERT)  │
│                                      │   │    3) Claude categorize, per item   │
│  TRACEABILITY                        │   │       call Hyperspell GitHub for    │
│   ▸ generation_runs                  │   │       code_refs → plan_items        │
│     (queued/running/ready/error)     │   │    4) draft Linear/PR/Devin per     │
│                                      │   │       item → generated_actions      │
│  pgvector ext + HNSW index           │   │                                     │
│  realtime publication                │   │  POST /actions/{id}/execute  ⓐ     │
│  RLS policies (§6)                   │   │                                     │
│                                      │   │  APScheduler: ingest every 5min     │
│                                      │   │                                     │
│                                      │   │  ⓐ = requires Bearer DEMO_TOKEN     │
└──────────────────────────────────────┘   └─────────────────────────────────────┘
```

### 2.1 The linear pipeline (what `/plan/generate` runs)

```
   meeting_notes  ┐                  ┌─► knowledge_documents
   (last 7d, opt. │                  │   (themes, decisions,
   pgvector top-K)├──► Claude #1 ────┤    blockers, summary,
                  │   synthesis      │    open_questions)
   project_context│                  └────────────┬────────────────┐
   (last 7d)      ┘                               │                │
                                                  ▼                │
                              ┌─► Claude #2 categorize             │
                              │   bug_fix / new_feature / maint.   │
                              │                                    │
                              │   per item, query                  │
                              │   Hyperspell GitHub ───────────────┘
                              │   (or fixture fallback)
                              │
                              └─► plan_items (with code_refs)
                                            │
                                            ▼
                                  ┌─► Claude #3 action drafts
                                  │   (per item × 3)
                                  │
                                  └─► generated_actions
                                            │
                                            ▼
                                  Jin's UI lights up via realtime
```

**Idempotency**: `/plan/generate` is wrapped in a `generation_runs` row keyed by `(project_id, week_start)`. Concurrent calls return 409 with the running run id. On success, prior `plan_items` for the same `knowledge_document_id` are deleted in a transaction before new ones are inserted (cascades through `generated_actions`).

### 2.2 Dynamic context (live RAG during the meeting)

Independent of `/plan/generate`. While a meeting runs, OpenAI Realtime can call `search_project_context` → Yudong's handler hits `POST /context/query` (pgvector + Hyperspell merge) → returned as `function_call_output`. Additive; degrades gracefully.

---

## 3. The Three Roles

### 🎙️ Yudong — Voice Agent

You own the entire voice path. Yash gives you `/rt/token`, `/context/briefing`, `/context/query`. Everything else lives in your frontend.

**Your slice**

```
On meeting start:
   GET  /context/briefing?projectId=X    → render Briefing panel
   POST /rt/token                        → ephemeral token { value, expires_at }
   captureMeetingAudio()                 → tab-audio + mic, mixed via Web Audio
   open RTCPeerConnection,
     send session.update with transcription config + tools

While running:
   conversation.item.input_audio_transcription.delta     → buffer
   conversation.item.input_audio_transcription.completed → finalize chunk
       │
       ▼ (every ~20s OR on .completed)
   POST /api/voice/summarize  (your Next.js route)
       body: { transcript_chunk, briefing }
       → returns: [{ type, text, refs_to, embedding }]
       │
       ▼
   for each note:
     supabase.from("meeting_notes").insert({
       project_id, meeting_id, type, text, refs_to,
       embedding,                            // vector(1536)
     });   ← anon key

   AND in parallel (live tool-calling):
   response.function_call_arguments.done (search_project_context)
       │
       ▼
   POST /context/query  → ContextItem[]
       │
       ▼
   conversation.item.create (function_call_output) → response.create
       │
       ▼
   model uses richer transcript + React Flow context board updates
   inside VoiceAgent
```

#### A. Joining meetings

**A1 — Tab + mic mix (recommended)**: `getDisplayMedia` requires a video track *by spec* — passing `video: false` throws TypeError. Request video, immediately stop and remove the video track, keep the audio track, then mix with the mic.

```ts
// frontend/lib/meetingAudio.ts
export async function captureMeetingAudio(): Promise<MediaStream> {
  // 1) getDisplayMedia REQUIRES a video track — request it, then drop it.
  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" },
    audio: { echoCancellation: false, noiseSuppression: false },
  });
  display.getVideoTracks().forEach(t => { t.stop(); display.removeTrack(t); });

  // 2) Verify the user actually shared tab audio (the "Share tab audio" checkbox).
  if (display.getAudioTracks().length === 0) {
    throw new Error("TAB_AUDIO_MISSING"); // caller falls back to A2
  }

  // 3) Mix tab audio + mic via Web Audio.
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(display).connect(dest);
  ctx.createMediaStreamSource(mic).connect(dest);
  return dest.stream;
}
```

If `TAB_AUDIO_MISSING` is thrown, surface a toast (*"re-pick and tick **Share tab audio**"*) and fall through to A2.

**A2 — Mic only** (fallback). **A3 — Recall.ai bot** (skip).

#### B. Briefing (one-time, on meeting start)

```ts
const briefing = await fetch(`${FASTAPI}/context/briefing?projectId=${pid}`).then(r=>r.json());
// renders themes, open threads, latest docs, active files, people
```

#### C. Realtime session config (transcription is opt-in!)

OpenAI Realtime does **not** emit transcription events unless you configure `audio.input.transcription` in the session. Send this immediately after the data channel opens:

```ts
dc.send(JSON.stringify({
  type: "session.update",
  session: {
    instructions: BRIEFING_PROMPT,
    audio: {
      input: {
        transcription: { model: "gpt-realtime-whisper" },
        turn_detection: { type: "server_vad", silence_duration_ms: 800 },
      },
    },
    tools: TOOLS,           // see §C-bis
    tool_choice: "auto",
  },
}));
```

Then listen for the documented event names:

```ts
dc.addEventListener("message", async (e) => {
  const ev = JSON.parse(e.data);
  switch (ev.type) {
    case "conversation.item.input_audio_transcription.delta":
      bufferDelta(ev.delta);
      break;
    case "conversation.item.input_audio_transcription.completed":
      onChunkComplete(ev.transcript); // calls your summarizer route
      break;
    case "response.function_call_arguments.done":
      if (ev.name === "search_project_context") await handleToolCall(ev);
      break;
  }
});
```

#### C-bis. Live tool-calling (dynamic RAG)

```ts
const TOOLS = [{
  type: "function",
  name: "search_project_context",
  description: "Search this project's knowledge base for files, decisions, or threads relevant to a topic the team is discussing right now.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
}];
```

Handler:

```ts
async function handleToolCall(ev: any) {
  const { query } = JSON.parse(ev.arguments);
  const items = await fetch(`${FASTAPI}/context/query`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, query, k: 6 }),
  }).then(r => r.json()).catch(() => []);
  dc.send(JSON.stringify({
    type: "conversation.item.create",
    item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(items) },
  }));
  dc.send(JSON.stringify({ type: "response.create" }));
}
```

#### D. Summarizer route (Yudong's Next.js Route Handler)

Embeds the note inline so the frontend INSERT can populate `embedding` directly.

```ts
// frontend/app/api/voice/summarize/route.ts
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  const { transcript_chunk, briefing } = await req.json();

  // 1) Structured note generation
  const r = await openai.chat.completions.create({
    model: "gpt-4.1",
    response_format: { type: "json_schema", json_schema: VoiceNoteSchema },
    messages: [
      { role: "system", content: `Project: ${briefing.project_summary}
        Themes: ${briefing.themes.join(", ")}
        Active files: ${briefing.active_files.map((f:any)=>f.path).join(", ")}
        Emit 1-3 notes. Each: { type: "decision|action_item|blocker|mention|fyi", text, refs_to: [...] }` },
      { role: "user", content: transcript_chunk },
    ],
  });
  const notes = JSON.parse(r.choices[0].message.content!);

  // 2) Embed each note's text (parallel)
  const emb = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: notes.map((n:any) => n.text),
  });
  notes.forEach((n:any, i:number) => { n.embedding = emb.data[i].embedding; });

  return Response.json(notes);
}
```

INSERT in your component:

```ts
const notes = await fetch("/api/voice/summarize", { method: "POST",
  body: JSON.stringify({ transcript_chunk, briefing }) }).then(r=>r.json());
for (const n of notes) {
  await supabase.from("meeting_notes").insert({
    project_id: pid, meeting_id: mid,
    type: n.type, text: n.text, refs_to: n.refs_to,
    embedding: n.embedding,
  });
}
```

#### E. Live React Flow context board (Yudong-owned)

Inside `VoiceAgent`, render a compact live context board fed by the same `/context/query` results used for Realtime tool-calling. This board is a meeting aid, not a persisted pipeline table: it helps the screen-shared UI show what repo/project context the discussion is touching in the moment.

- Use `@xyflow/react`.
- Keep the board inside the `VoiceAgent` component boundary so Jin does not need callbacks or page-level state.
- Convert each `ContextItem` into a source node and connect it to the current query/topic node.
- Preserve the last useful board if `/context/query` fails; do not block meeting note insertion.

#### Files you own

| Path | Purpose |
|---|---|
| `frontend/lib/meetingAudio.ts` | tab + mic mixer (handles `TAB_AUDIO_MISSING`) |
| `frontend/lib/realtime.ts` | WebRTC handshake + session.update helper |
| `frontend/lib/voiceNoteSchema.ts` | shared JSON schema |
| `frontend/app/api/voice/summarize/route.ts` | summarizer + embedding endpoint |
| `frontend/components/VoiceAgent.tsx` | the component Jin mounts |
| `frontend/components/BriefingPanel.tsx` | briefing display |
| `frontend/components/MeetingContextBoard.tsx` | live context board |
| `frontend/components/LiveContextDiagram.tsx` | React Flow diagram |
| `demo/standup_script.md` | 60-second standup script |

#### Milestones

- 11:00am — VoiceAgent skeleton: `/rt/token` returns ephemeral; mic-only WebRTC; transcription deltas in console.
- 12:30pm — Tab+mic mixer; `/api/voice/summarize` returns `{notes[], embedding[]}`.
- 1:30pm — Briefing fetched, rendered, passed to summarizer.
- 2:30pm — Notes flowing: mic → summarizer → `meeting_notes` (with embedding) → Jin's Inputs tab.
- 3:00pm — Live tool-calling: model invokes `search_project_context`; summarizer note cites the fetched item; React Flow board updates from the returned context.
- 5:00pm — Demo timed at ≤90s.

---

### 🗄️ Jin — Database & Frontend

Two artifacts: the Supabase schema/realtime/RLS, and a tabbed Next.js app.

**Mental model — the Supabase tables**

| Table | What it stores | Who writes |
|---|---|---|
| `meeting_notes` | structured notes from voice agent (one row per note) — **with `embedding vector(1536)`** | Yudong (anon INSERT) |
| `meeting_transcript_chunks` | raw transcript chunks for audit (so we can trace a note back to what was said) | Yudong (anon INSERT) |
| `project_context` | items ingested from Hyperspell — Slack/Drive/Notion/Gmail — **with `embedding vector(1536)`** | Yash (svc INSERT) |
| `knowledge_documents` | weekly synthesis: summary, themes, decisions, blockers, open questions. **One row per project per week.** | Yash (svc UPSERT on `(project_id, week_start)`) |
| `plan_items` | categorized actionables (bug_fix / new_feature / maintenance), with `code_refs` from Hyperspell GitHub | Yash (svc INSERT, REPLACE per run) |
| `generated_actions` | Linear / PR / Devin draft per plan item × 3. **Carries denormalized `project_id`** so frontend can filter via Postgres Changes. | Yash (svc INSERT, then UPDATE on execute) |
| `generation_runs` | run status + idempotency key for `/plan/generate` | Yash (svc) |

**UI — three tabs** (same as before; see §2 for the layout)

**Subscriptions**

| Subscription | Tab | Filter |
|---|---|---|
| `meeting_notes` | 📥 Inputs ▸ Meetings | `project_id=eq.<pid>` |
| `project_context` | 📥 Inputs ▸ Project Context | `project_id=eq.<pid>` |
| `knowledge_documents` | 🧠 Knowledge Doc (synthesis) | `project_id=eq.<pid>` (latest by week_start) |
| `plan_items` | 🧠 Knowledge Doc (plan items) | `project_id=eq.<pid>` |
| `generated_actions` | ⚡ Actions | `project_id=eq.<pid>` ← **why we denormalize project_id** |
| `generation_runs` | header (status pill: ✨ Generating…) | `project_id=eq.<pid>` |

> Postgres Changes filters are column-level (`eq`, `in`, etc.), not joins. We denormalize `project_id` onto `generated_actions` to enable a simple equality filter. `in` filters are capped at 100 values.

#### Files you own

```
supabase/
  schema.sql                         (canonical, pre-day pair work with Yash)
  migrations/*.sql                   (Yash adds; you apply)
frontend/
  app/projects/page.tsx
  app/projects/[id]/page.tsx
  app/projects/[id]/_tabs/InputsTab.tsx
  app/projects/[id]/_tabs/KnowledgeDocTab.tsx
  app/projects/[id]/_tabs/ActionsTab.tsx
  components/MeetingsList.tsx
  components/ProjectContextList.tsx
  components/SynthesisCards.tsx
  components/PlanItemCards.tsx
  components/ActionCard.tsx
  lib/supabase.ts
  app/globals.css, tailwind config
```

#### Milestones

- 10:30am — Supabase schema deployed (incl. pgvector + HNSW); teammates have keys.
- 11:30am — `/projects` and `/projects/[id]` skeleton; tabs switch; dummy data renders.
- 1:00pm — Inputs ▸ Meetings live as Yudong inserts.
- 2:00pm — Inputs ▸ Project Context live after Yash's `/ingest/hyperspell`.
- 3:30pm — Knowledge Doc + Actions tabs render real data after `/plan/generate`.
- 5:30pm — Polished + deployed Vercel URL works on laptop and phone.

---

### 🧠 Yash — Backend, Hyperspell, Categorizer, Executors

Heaviest role.

**Endpoints**

| Method | Path | Auth | Caller | Purpose |
|---|---|---|---|---|
| POST | `/rt/token` | none (public) | Yudong | mint OpenAI Realtime ephemeral token via `/v1/realtime/client_secrets` |
| GET  | `/context/briefing?projectId=X` | none | Yudong (once on meeting start) | assemble briefing |
| POST | `/context/query` | none | Yudong's tool handler (live) | pgvector cosine + Hyperspell merge; <1s |
| POST | `/ingest/hyperspell` | **Bearer** | Jin button + 5min cron | search Hyperspell, embed, INSERT `project_context` |
| POST | `/plan/generate` | **Bearer** | Jin button | linear pipeline; idempotent via `generation_runs` |
| POST | `/actions/{id}/execute` | **Bearer** | Jin button | dispatch to Linear/GitHub/Devin |

**Auth**: writes/executes are gated by `Authorization: Bearer ${DEMO_TOKEN}`. Read endpoints stay open so Yudong's component (which can't safely hold a secret) can still fetch briefings/queries. `DEMO_TOKEN` rotates each demo and lives only in the team's 1Password + Vercel env. Frontend reads it via `NEXT_PUBLIC_DEMO_TOKEN` (acceptable leak for the day).

```python
# backend/dependencies.py
async def require_demo_token(authorization: str = Header(None)):
    expected = f"Bearer {os.environ['DEMO_TOKEN']}"
    if authorization != expected:
        raise HTTPException(401, "bad token")
```

#### Key implementation notes

1. **`/rt/token`** — proxies to the **current** OpenAI endpoint. Returns the ephemeral token with a flat shape:
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
   **Frozen response shape**: `{ "value": string, "expires_at": number }`. Frontend uses `body.value` directly. (If OpenAI's response shape evolves, only this proxy adapts.)

2. **`/ingest/hyperspell`** — pulls Slack/Drive/Notion/Gmail (NOT GitHub code). For each item:
   - Compute `content_hash = sha256(full_text)`.
   - Compute `embedding = openai.embeddings.create(input=full_text, model="text-embedding-3-small")`.
   - UPSERT on `(project_id, source, external_id)` (when present) or `(project_id, source, content_hash)`.

3. **`/context/query`** — sub-1s. Two-stage:
   ```python
   # Stage 1 (fast): pgvector cosine on local tables
   q_emb = openai.embeddings.create(input=query, model="text-embedding-3-small").data[0].embedding
   local = sb.rpc("search_context", {
       "p_project_id": project_id, "q_emb": q_emb, "p_limit": k
   }).execute()  # SQL function returns merged top-K from meeting_notes + project_context
   # Stage 2 (best-effort): Hyperspell live, all sources, k/2
   try:
       hs = await asyncio.wait_for(hyperspell.search(query, k=k//2), timeout=0.5)
   except asyncio.TimeoutError:
       hs = []
   # Merge, dedupe by ref_url, return top-k
   ```
   60s same-query cache in process memory.

4. **`/plan/generate`** — idempotent + job-backed:
   ```python
   def generate_plan(project_id, idem_key=None):
       wk_start, wk_end = current_iso_week()

       # 1) Reserve a run row (UNIQUE on (project_id, week_start, idempotency_key))
       run = sb.table("generation_runs").insert({
           "project_id": project_id, "week_start": wk_start,
           "idempotency_key": idem_key or str(uuid4()),
           "status": "running", "started_at": "now()",
       }).execute()
       # If conflict (running run exists), return 409 with existing run_id.

       try:
           notes   = sb.select("meeting_notes",   project_id, ts >= wk_start)
           context = sb.select("project_context", project_id, ts >= wk_start)

           # Step 1: synthesis
           doc = claude.synthesize(notes, context)
           doc_id = sb.table("knowledge_documents").upsert(
               {**doc, "project_id": project_id, "week_start": wk_start, "week_end": wk_end},
               on_conflict="project_id,week_start"
           ).execute().data[0]["id"]

           # Step 2: REPLACE plan_items for this doc (cascades to actions)
           sb.table("plan_items").delete().eq("knowledge_document_id", doc_id).execute()

           items = claude.categorize(doc)  # each has code_query
           for item in items:
               code_refs = await get_code_refs(item.code_query)  # Hyperspell GitHub or fixture
               sb.table("plan_items").insert({
                   "knowledge_document_id": doc_id,
                   "project_id": project_id,
                   "generation_run_id": run.id,
                   ...
                   "code_refs": code_refs,
               }).execute()

           # Step 3: action drafts
           for pi in items:
               for draft in claude.draft_actions(pi):
                   sb.table("generated_actions").insert({
                       "plan_item_id": pi.id,
                       "project_id": project_id,        # denormalized for filtering
                       "generation_run_id": run.id,
                       **draft,
                   }).execute()

           sb.table("generation_runs").update({
               "status": "ready", "finished_at": "now()"
           }).eq("id", run.id).execute()
       except Exception as e:
           sb.table("generation_runs").update({
               "status": "error", "error": str(e), "finished_at": "now()"
           }).eq("id", run.id).execute()
           raise
   ```

5. **`get_code_refs`** — wrapper with fallback:
   ```python
   async def get_code_refs(query: str) -> list[CodeRef]:
       if HYPERSPELL_GITHUB_AVAILABLE:
           try:
               hits = await hyperspell.search(query, sources=["github"], k=3, timeout=2)
               if hits: return hits
           except Exception:
               pass
       # Fallback: keyword-match against fixtures
       return fixture_code_refs(query)  # seed_code_refs.json (Yudong + Yash curate tonight)
   ```
   **Hyperspell GitHub is in beta** — verify access tonight. If unavailable, the fixture fallback is the demo path. Seed `seed_code_refs.json` with realistic snippets for the demo signals (Safari bug, CSV export, rate-limit middleware).

6. **APScheduler cron** — `/ingest/hyperspell` every 5 min, idempotent.

#### Files you own

```
backend/
  main.py                       FastAPI app, CORS, scheduler startup
  dependencies.py               require_demo_token
  routers/
    realtime.py                 /rt/token
    context.py                  /context/briefing, /context/query
    ingest.py                   /ingest/hyperspell
    plan.py                     /plan/generate
    actions.py                  /actions/{id}/execute
  services/
    hyperspell.py               search wrapper (project_context + github)
    embeddings.py               openai text-embedding-3-small
    briefing_builder.py         cached briefing assembly
    synthesizer.py              Claude #1 → knowledge_documents
    categorizer.py              Claude #2 + per-item Hyperspell GitHub / fixture
    action_drafter.py           Claude #3 → generated_actions
    code_refs.py                get_code_refs() with fallback
    executors/{linear,github,devin}.py
    supabase_writer.py
  fixtures/
    seed_code_refs.json         demo-day fallback code refs
  jobs/
    ingest_cron.py
  schemas.py
  settings.py
```

#### Milestones

- Night before: Hyperspell connectors + corpus ingested + **GitHub beta access verified or fixtures finalized**.
- 11:00am: FastAPI running, `/rt/token` returns `{value, expires_at}`, `/context/briefing` real.
- 1:00pm: `/ingest/hyperspell` populates `project_context` with embeddings.
- 2:00pm: `/context/query` <1s (pgvector + Hyperspell merge).
- 3:00pm: `/plan/generate` runs end-to-end, idempotent; all tables update.
- 4:00pm: APScheduler cron live; auth gate on mutating endpoints verified with curl.
- 5:00pm: `/actions/{id}/execute` creates real Linear tickets.

---

## 3.5 Conflict Map & Ownership

Hard "never touches": Yash → no frontend, no schema (migrations only). Jin → no backend, no voice agent. Yudong → no backend, no schema, no page chrome.

| Path | Owner |
|---|---|
| `backend/**` | Yash |
| `frontend/app/**` (excl. `api/voice/**`), `_tabs/**`, panels, `lib/supabase.ts`, `globals.css`, Tailwind | Jin |
| `frontend/components/{VoiceAgent,BriefingPanel,MeetingContextBoard,LiveContextDiagram}.tsx`, `frontend/lib/{realtime,meetingAudio,voiceNoteSchema}.ts`, `frontend/app/api/voice/**` | Yudong |
| `supabase/schema.sql` | Jin (canonical) |
| `supabase/migrations/*.sql` | Yash adds, Jin applies |
| `demo/**` + `backend/fixtures/seed_code_refs.json` | Yudong + Yash (paired tonight) |

**Schema change workflow**: Pre-day pair, frozen at 9:30am sync. Mid-day: `supabase/migrations/000N_*.sql` → Yash writes, Jin applies.

**Component contract**: `<VoiceAgent projectId meetingId />` only. No callbacks. Communicates via Supabase writes; Jin sees changes via realtime.

**Supabase write rules**:
- Anon key: INSERT only on `meeting_notes` and `meeting_transcript_chunks`. SELECT on all reactive tables.
- Service key: full access; bypasses RLS.

**Realtime rule**: only Jin subscribes. Yudong relies on the INSERT response code.

> Yudong's React Flow context board (if added) lives entirely **inside** `VoiceAgent` — it's a render of the model's tool-call results, not a side-channel. Jin's panels remain the only Supabase subscribers.

**Communication triggers**

| Trigger | Who pings whom |
|---|---|
| Schema change needed | Yash → Jin |
| `/context/briefing` or `/context/query` shape change | Yudong → Yash |
| `/context/query` > 1s | Yash → Yudong (lower k or drop Hyperspell stage) |
| Hyperspell GitHub unavailable | Yash → Yudong (finalize fixture code refs) |
| Voice notes generic | Yudong tunes summarizer prompt |
| `DEMO_TOKEN` rotated | Yash → Jin (update Vercel env) |
| FastAPI URL changed (ngrok restart) | Yash → Jin |

---

## 4. Build Order

```
8:00 AM   Doors. NIGHT-BEFORE WORK MUST BE DONE:
            • Yash:   Hyperspell connectors live + corpus ingested
                      + GitHub beta status confirmed (or fixtures ready)
            • Yudong: standup script + corpus content + fixture code refs
            • Jin:    Supabase schema (incl. pgvector + RLS) + Vercel project linked

9:15 AM   Hacking starts.
          [ALL] 30-min sync. Whiteboard contracts (§5). Distribute keys + DEMO_TOKEN.

9:45 AM   PARALLEL ─────────────────────────────────────────────────────
          Yash:   FastAPI scaffold; /rt/token (verify {value, expires_at});
                  auth dep; /context/briefing.
          Yudong: VoiceAgent skeleton; mic-only WebRTC; transcription
                  events firing in console.
          Jin:    Next.js scaffold; supabase-js; /projects + /projects/[id]
                  with 3 tabs; dummy rows.

11:00 AM  CHECKPOINT.

11:00 AM  PARALLEL ─────────────────────────────────────────────────────
          Yash:   /ingest/hyperspell with embedding step; /context/query
                  with pgvector RPC.
          Yudong: tab+mic mixer (handles TAB_AUDIO_MISSING);
                  /api/voice/summarize with embeddings; INSERT into
                  meeting_notes (with embedding column).
          Jin:    Inputs ▸ Meetings + Inputs ▸ Project Context fully live.

12:00     Hyperspell speaker session — Yash attends.
12:30     Lunch.

1:30 PM   CHECKPOINT.

1:30 PM   PARALLEL ─────────────────────────────────────────────────────
          Yash:   /plan/generate end-to-end with generation_runs +
                  REPLACE-on-rerun semantics. APScheduler cron.
          Yudong: live tool-calling working; React Flow context board
                  updates from /context/query; rehearsal practice.
          Jin:    Knowledge Doc tab + Actions tab fully reactive.

3:00 PM   Speaker session — Yudong attends.
3:30 PM   CHECKPOINT — END-TO-END WORKING. Lock no new features.

3:30 PM   POLISH
4:30 PM   FULL REHEARSAL #1.
5:30 PM   FULL REHEARSAL #2 — record backup video.
6:00 PM   SUBMIT.
6:10 PM   Judging.
```

---

## 5. Interface Contracts (frozen at 9:30am)

### 5.1 `/rt/token` (Yudong → Yash)

```http
POST {FASTAPI}/rt/token
→ 200 OK
{ "value": "ek_...", "expires_at": 1715275500 }
```

Frontend uses `body.value` directly as the bearer token in the WebRTC SDP exchange.

### 5.2 `/context/briefing` (Yudong → Yash)

```http
GET {FASTAPI}/context/briefing?projectId=<uuid>
→ { "id", "project_summary", "themes": [], "recent_decisions": [],
    "open_threads": [], "latest_docs": [], "active_files": [], "people": [] }
```

### 5.3 `/api/voice/summarize` (Yudong's own route)

```http
POST /api/voice/summarize
{ "transcript_chunk": "string", "briefing": <briefing> }
→ [{ "type": "decision|action_item|blocker|mention|fyi",
     "text": "≤300", "refs_to": [...], "embedding": [1536 floats] }]
```

### 5.4 Yudong's INSERT

```ts
await supabase.from("meeting_notes").insert({
  project_id, meeting_id, type, text, refs_to, embedding,
});
```

### 5.5 `/ingest/hyperspell` (Jin button + cron → Yash, **auth required**)

```http
POST {FASTAPI}/ingest/hyperspell
Authorization: Bearer ${DEMO_TOKEN}
{ "projectId": "<uuid>" }
→ { "inserted": 14, "updated": 3, "skipped_dupes": 22 }
```

### 5.6 `/plan/generate` (Jin → Yash, **auth required**)

```http
POST {FASTAPI}/plan/generate
Authorization: Bearer ${DEMO_TOKEN}
Idempotency-Key: <client-generated UUID>   (optional but recommended)
{ "projectId": "<uuid>" }

→ 202 Accepted   { "runId": "<uuid>", "knowledgeDocumentId": "<uuid>" }
→ 409 Conflict   { "runId": "<uuid>", "status": "running" }   // a run already exists
```

UI subscribes to `generation_runs` via realtime to show ✨ Generating… → Ready / Error.

### 5.7 `/actions/{id}/execute` (Jin → Yash, **auth required**)

```http
POST {FASTAPI}/actions/{actionId}/execute
Authorization: Bearer ${DEMO_TOKEN}
→ { "externalUrl": "https://linear.app/.../ABC-42" }
```

GitHub PR creation requires an existing branch with the head ref already pushed. For the demo, action drafter outputs a `payload.preview` instead of opening a real PR if no branch exists; the Execute button calls Devin or Linear preferentially.

### 5.8 `/context/query` (Yudong's tool handler → Yash)

```http
POST {FASTAPI}/context/query
{ "projectId": "<uuid>", "query": "string", "k": 6 }
→ [{ "source", "title", "snippet", "url", "ts", "score",
     "code_path", "code_lines" }]
```

Sub-1s. Yudong returns this as `function_call_output` to Realtime.

---

## 6. Supabase Schema + RLS + pgvector

> **Jin** — your current schema (per the diagram you shared) is on v1. The plan needs v2. Skip ahead to **§6.5** for a step-by-step migration keyed to the screenshot you shared, including a one-shot runnable SQL file and frontend Cursor/Claude prompts.

```sql
create extension if not exists "uuid-ossp";
create extension if not exists vector;     -- pgvector

create table projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  repo_url text,
  hyperspell_user_id text,
  created_at timestamptz default now()
);

create type meeting_status as enum ('live','ended');
create table meetings (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  title text,
  started_at timestamptz default now(),
  ended_at timestamptz,
  status meeting_status default 'live'
);

-- RAW INPUT 1: meeting notes (Yudong, anon INSERT)
create type meeting_note_type as enum ('decision','action_item','blocker','mention','fyi');
create table meeting_notes (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  meeting_id uuid references meetings(id) on delete cascade,
  type meeting_note_type not null,
  text text not null,
  refs_to jsonb default '[]',
  embedding vector(1536),
  ts timestamptz default now()
);
create index on meeting_notes (project_id, ts desc);
create index on meeting_notes using hnsw (embedding vector_cosine_ops);

-- RAW INPUT 1b: raw transcript chunks (audit trail)
create table meeting_transcript_chunks (
  id uuid primary key default uuid_generate_v4(),
  meeting_id uuid references meetings(id) on delete cascade,
  speaker text,
  start_ms int,
  end_ms int,
  text text not null,
  ts timestamptz default now()
);
create index on meeting_transcript_chunks (meeting_id, ts);

-- RAW INPUT 2: project context (Yash via /ingest/hyperspell)
create type context_source as enum ('slack','drive','notion','gmail');
create table project_context (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  source context_source not null,
  external_id text,                       -- stable id from Hyperspell
  title text,
  snippet text,                           -- truncated for UI
  full_text text,                         -- full content for embedding/synthesis
  content_hash text,                      -- sha256(full_text) — robust dedup
  author text,
  ref_url text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  embedding vector(1536),
  ingested_at timestamptz default now(),
  ts timestamptz default now()
);
create unique index on project_context (project_id, source, external_id) where external_id is not null;
create unique index on project_context (project_id, source, content_hash) where content_hash is not null;
create index on project_context (project_id, source, ts desc);
create index on project_context using hnsw (embedding vector_cosine_ops);

-- SYNTHESIS: weekly knowledge document (one per project per week)
create type kdoc_status as enum ('generating','ready','error');
create table knowledge_documents (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  week_start date not null,
  week_end date not null,
  status kdoc_status default 'generating',
  summary text,
  themes jsonb default '[]',
  decisions jsonb default '[]',
  blockers jsonb default '[]',
  open_questions jsonb default '[]',
  source_meeting_note_ids uuid[] default '{}',
  source_project_context_ids uuid[] default '{}',
  generated_at timestamptz default now()
);
create unique index on knowledge_documents (project_id, week_start);
create index on knowledge_documents (project_id, week_start desc);

-- TRACEABILITY: each /plan/generate invocation
create type run_status as enum ('queued','running','ready','error');
create table generation_runs (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  week_start date not null,
  idempotency_key text,
  status run_status default 'queued',
  error text,
  retry_count int default 0,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz default now()
);
create unique index on generation_runs (project_id, week_start, idempotency_key) where idempotency_key is not null;
create index on generation_runs (project_id, created_at desc);

-- CATEGORIZED: plan items
create type plan_item_category as enum ('bug_fix','new_feature','maintenance');
create table plan_items (
  id uuid primary key default uuid_generate_v4(),
  knowledge_document_id uuid references knowledge_documents(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
  generation_run_id uuid references generation_runs(id),
  category plan_item_category not null,
  title text not null,
  description text,
  source_refs jsonb default '[]',
  code_refs jsonb default '[]',
  next_step text,
  confidence numeric,
  generated_at timestamptz default now()
);
create index on plan_items (project_id, generated_at desc);
create index on plan_items (knowledge_document_id);

-- EXECUTION: action drafts (denormalized project_id for realtime filter)
create type action_type   as enum ('linear_ticket','github_pr','devin_handoff');
create type action_status as enum ('draft','executing','executed','failed');
create table generated_actions (
  id uuid primary key default uuid_generate_v4(),
  plan_item_id uuid references plan_items(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,   -- denormalized
  generation_run_id uuid references generation_runs(id),
  action_type action_type not null,
  payload jsonb,
  status action_status default 'draft',
  external_url text,
  created_at timestamptz default now()
);
create index on generated_actions (project_id, created_at desc);
create index on generated_actions (plan_item_id);
```

### Vector search RPC (used by `/context/query`)

```sql
create or replace function search_context(
  p_project_id uuid, q_emb vector(1536), p_limit int
) returns table (
  source text, id uuid, title text, snippet text,
  ref_url text, ts timestamptz, score float
) language sql stable as $$
  with mn as (
    select 'meeting' as source, id, null::text as title, text as snippet,
           null::text as ref_url, ts,
           1 - (embedding <=> q_emb) as score
    from meeting_notes
    where project_id = p_project_id and embedding is not null
  ),
  pc as (
    select source::text, id, title, snippet,
           ref_url, ts,
           1 - (embedding <=> q_emb) as score
    from project_context
    where project_id = p_project_id and embedding is not null
  )
  select * from (select * from mn union all select * from pc) u
  order by score desc
  limit p_limit;
$$;
```

### Realtime publication

Enable `supabase_realtime` for: `meeting_notes`, `project_context`, `knowledge_documents`, `plan_items`, `generated_actions`, `generation_runs`.

### RLS policies

```sql
alter table meeting_notes              enable row level security;
alter table meeting_transcript_chunks  enable row level security;
alter table project_context            enable row level security;
alter table knowledge_documents        enable row level security;
alter table plan_items                 enable row level security;
alter table generated_actions          enable row level security;
alter table generation_runs            enable row level security;
alter table projects                   enable row level security;
alter table meetings                   enable row level security;

-- Anon may SELECT everything (Jin's subscriptions)
create policy anon_read_all_mn on meeting_notes              for select to anon using (true);
create policy anon_read_all_tc on meeting_transcript_chunks  for select to anon using (true);
create policy anon_read_all_pc on project_context            for select to anon using (true);
create policy anon_read_all_kd on knowledge_documents        for select to anon using (true);
create policy anon_read_all_pi on plan_items                 for select to anon using (true);
create policy anon_read_all_ga on generated_actions          for select to anon using (true);
create policy anon_read_all_gr on generation_runs            for select to anon using (true);
create policy anon_read_all_p  on projects                   for select to anon using (true);
create policy anon_read_all_m  on meetings                   for select to anon using (true);

-- Anon may INSERT only into meeting_notes and meeting_transcript_chunks
create policy anon_insert_mn on meeting_notes
  for insert to anon with check (true);
create policy anon_insert_tc on meeting_transcript_chunks
  for insert to anon with check (true);

-- Service role bypasses RLS automatically.

-- Required grants for anon to use the RPC:
grant execute on function search_context(uuid, vector, int) to anon, authenticated;
```

---

## 6.5 Jin's Migration Playbook (v1 → v2)

You currently have 5 tables (`projects`, `meetings`, `knowledge_entries`, `categorized_items`, `generated_actions`) per the diagram you shared. The plan needs **9 tables** with **pgvector** enabled. The conspicuous missing one is **`knowledge_documents`** — the entire weekly-synthesis layer doesn't exist in v1.

You can paste this entire section into Cursor/Claude as context — every step is concrete.

### Diff: v1 → v2

| Action | Table | Why |
|---|---|---|
| ✅ Keep | `projects` | unchanged |
| ✅ Keep | `meetings` | unchanged |
| ❌ **Drop** | `knowledge_entries` | replaced by 3 narrower tables |
| 🆕 **Add** | `meeting_notes` | structured notes from Yudong's voice agent (one row per note) — has `embedding vector(1536)` |
| 🆕 **Add** | `meeting_transcript_chunks` | raw transcript audit trail |
| 🆕 **Add** | `project_context` | Hyperspell-ingested Slack/Drive/Notion/Gmail items — has `embedding vector(1536)` |
| 🆕 **Add** ⚠️ **(the missing table)** | `knowledge_documents` | weekly synthesis: summary/themes/decisions/blockers/open_questions. **One row per project per week.** This is the artifact `/plan/generate` writes first; without it the rest of the pipeline has no parent record. |
| 🔁 **Rename + change** | `categorized_items` → **`plan_items`** | new category enum (`bug_fix\|new_feature\|maintenance`), adds FKs to `knowledge_documents` and `generation_runs` |
| 🆕 **Add** | `generation_runs` | idempotency / job tracking for `/plan/generate` |
| 🔁 **Modify** | `generated_actions` | adds **denormalized `project_id`** (so frontend Realtime can filter by project) and `generation_run_id` |

Plus: enable `pgvector`, add HNSW indexes on the embedding columns, enable Realtime publication on the 7 reactive tables, apply RLS policies, create the `search_context` RPC.

### Step 1 — Run the migration script

Open Supabase → SQL Editor → New query → paste the contents of [`supabase/migration_to_v2.sql`](./supabase/migration_to_v2.sql) → click **Run**. Idempotent; expected runtime ~2s.

### Step 2 — Verify

```sql
-- 1) Should list 9 tables
select table_name from information_schema.tables
where table_schema='public' order by 1;
-- Expected: generated_actions, generation_runs, knowledge_documents,
--   meeting_notes, meeting_transcript_chunks, meetings,
--   plan_items, project_context, projects

-- 2) Should list 7 new enums
select typname from pg_type
where typtype='e' and typname in (
  'meeting_note_type','context_source','kdoc_status',
  'plan_item_category','run_status','action_type','action_status'
) order by 1;

-- 3) Should be 2 HNSW indexes
select indexname from pg_indexes where indexdef ilike '%hnsw%';

-- 4) Should list 7 reactive tables
select tablename from pg_publication_tables
where pubname='supabase_realtime' order by 1;

-- 5) Smoke-test the RPC (returns no rows but should not error)
select * from search_context(
  '00000000-0000-0000-0000-000000000000'::uuid,
  array_fill(0.0, ARRAY[1536])::vector(1536),
  3
);
```

### Step 3 — Smoke-test the anon INSERT policy

Toggle role to `anon` in the SQL editor:

```sql
-- Should succeed
insert into meeting_notes (project_id, meeting_id, type, text)
values (
  (select id from projects limit 1),
  (select id from meetings limit 1),
  'fyi', 'smoke test from anon'
);

-- Should fail with "new row violates row-level security policy"
insert into plan_items (project_id, knowledge_document_id, category, title)
values ('00000000-0000-0000-0000-000000000000',
        '00000000-0000-0000-0000-000000000000', 'bug_fix', 'should fail');
```

Clean up: `delete from meeting_notes where text = 'smoke test from anon';`

### Step 4 — Frontend prompts (paste these into your Claude/Cursor)

**Prompt A — regenerate types**

> Regenerate Supabase TypeScript types from the deployed schema and save to `frontend/lib/database.types.ts`. Update `frontend/lib/supabase.ts` to import these types and export a typed client. Then update every import in the codebase that references the old `knowledge_entries` or `categorized_items` types — those tables no longer exist.

CLI:
```bash
npx supabase gen types typescript --project-id <your-project-ref> > frontend/lib/database.types.ts
```

**Prompt B — restructure tabs**

> I'm restructuring the project page from a single panel layout to three tabs. Build these files:
> - `frontend/app/projects/[id]/page.tsx` — tab shell with three tabs: 📥 Inputs, 🧠 Knowledge Doc, ⚡ Actions. Use `searchParams` for the active tab so it survives reloads.
> - `frontend/app/projects/[id]/_tabs/InputsTab.tsx` — two collapsible sub-sections. Meetings: mounts `<VoiceAgent projectId meetingId />` (component owned by Yudong, treat as a black box) and below it renders `<MeetingsList />`. Project Context: renders `<ProjectContextList />`.
> - `frontend/app/projects/[id]/_tabs/KnowledgeDocTab.tsx` — header with current week + ✨ Generate plan button (POSTs to `${FASTAPI_URL}/plan/generate` with `Authorization: Bearer ${NEXT_PUBLIC_DEMO_TOKEN}`). Below: `<SynthesisCards />` for the latest `knowledge_documents` row, then `<PlanItemCards />` for `plan_items` filtered by that document.
> - `frontend/app/projects/[id]/_tabs/ActionsTab.tsx` — filter chips (Linear / GitHub PR / Devin / All), then a list of `<ActionCard />` for `generated_actions` filtered by `project_id`.

**Prompt C — build the components**

> Build the following components in `frontend/components/`. Each subscribes to its own Supabase Realtime channel filtered by `project_id=eq.<projectId>`. On mount, fetch initial data via `select`; layer realtime `INSERT` and `UPDATE` events on top.
>
> 1. `MeetingsList.tsx` — subscribes to `meeting_notes`. Groups by `meeting_id`. Each group: collapsible card titled by meeting `started_at`; inside, notes with type-specific chips (🟢 decision, 🔵 action_item, 🟡 blocker, ⚪ mention, ⚪ fyi).
> 2. `ProjectContextList.tsx` — subscribes to `project_context`. Sub-tabs across the top: Slack / Drive / Notion / Gmail (filter by `source`). Cards: title, snippet, author, ts, ref_url.
> 3. `SynthesisCards.tsx` — props: `knowledgeDoc` (latest row from `knowledge_documents` for the project, current week). Renders 5 cards: Summary, Themes (chips), Decisions (numbered list), Blockers, Open Questions. List items have `ref_ids` like `mn:<uuid>` or `pc:<uuid>` — render as small clickable chips.
> 4. `PlanItemCards.tsx` — subscribes to `plan_items` filtered by `knowledge_document_id`. Three columns: 🐛 Bug fixes, ✨ New features, 🔧 Maintenance (filter by `category`). Each card: title, description, source_refs as chips, code_refs as `path:lines` chips, next_step as a footer line, confidence as a percentage pill.
> 5. `ActionCard.tsx` — props: one `generated_actions` row. Shows action_type icon, payload preview (truncated JSON), status pill (draft / executing / executed / failed). Execute button: `POST {FASTAPI_URL}/actions/${id}/execute` with `Authorization: Bearer ${NEXT_PUBLIC_DEMO_TOKEN}`. On success, status flips and an external link replaces the button.
> 6. `GenerationStatusPill.tsx` — header pill. Subscribes to `generation_runs` filtered by `project_id`, latest by `created_at`. Renders ✨ Generating… / ✅ Ready / ❌ Error: `<text>` based on `status`.

**Prompt D — header buttons**

> Add a sticky header to `frontend/app/projects/[id]/page.tsx` with: project name (from `projects` table), `<GenerationStatusPill />`, and two buttons: 🔄 Refresh from Hyperspell (POST `/ingest/hyperspell`) and ✨ Generate plan (POST `/plan/generate`). Both include `Authorization: Bearer ${NEXT_PUBLIC_DEMO_TOKEN}`. Show a toast on success/failure.

**Prompt E — env vars**

> Update `.env.local` and Vercel env to include: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_FASTAPI_URL` (Yash's ngrok URL), `NEXT_PUBLIC_DEMO_TOKEN` (rotates demo day).

### Step 5 — Hand off

Once Steps 1–4 are green, ping Yash + Yudong:

> "Schema is on v2. New tables: meeting_notes (Yudong writes), project_context (Yash writes), knowledge_documents, plan_items, generation_runs, meeting_transcript_chunks. generated_actions now has project_id. Anon INSERT works on meeting_notes + meeting_transcript_chunks. RPC search_context callable by anon. DEMO_TOKEN in 1Password."

That unblocks Yash to start writing back from FastAPI and Yudong to start writing voice notes.

---

## 7. Output Schemas (frozen at 9:30am)

### 7.1 Synthesizer (Claude #1) → `knowledge_documents` row

```json
{
  "summary":         "string ≤500",
  "themes":          ["string"],
  "decisions":       [{ "text": "≤200", "ref_ids": ["mn:<uuid>","pc:<uuid>"] }],
  "blockers":        [{ "text": "≤200", "ref_ids": [...] }],
  "open_questions":  [{ "text": "≤200", "ref_ids": [...] }]
}
```

### 7.2 Categorizer (Claude #2) → `plan_items` rows

```json
{
  "items": [
    {
      "category": "bug_fix|new_feature|maintenance",
      "title": "≤80",
      "description": "≤400",
      "source_refs": [{ "ref_id": "mn:<uuid>|pc:<uuid>", "snippet": "≤200" }],
      "code_query": "string — exact query for Hyperspell GitHub or fixture",
      "next_step": "≤200",
      "confidence": 0.0
    }
  ]
}
```

Yash runs `get_code_refs(item.code_query)` (Hyperspell GitHub or fixture) and attaches results as `code_refs` before INSERT.

### 7.3 Action drafter (Claude #3) → `generated_actions` rows

For each plan_item, 3 rows:

```json
[
  { "action_type": "linear_ticket",  "payload": { "title": "...", "description": "...", "labels": [...], "priority": "..." }},
  { "action_type": "github_pr",      "payload": { "branch": "...", "title": "...", "body": "...", "preview": "..." }},
  { "action_type": "devin_handoff",  "payload": { "task": "...", "context_bundle": {...} }}
]
```

---

## 8. Realtime Update Flow

| Event | Triggered by | Tab updates |
|---|---|---|
| meeting_note insert | Yudong (anon) | 📥 Inputs ▸ Meetings |
| project_context insert | Yash cron/manual | 📥 Inputs ▸ Project Context |
| generation_runs insert/update | Yash | header status pill |
| knowledge_documents UPSERT | Yash | 🧠 Knowledge Doc (synthesis) |
| plan_items insert | Yash (one-by-one as Hyperspell GitHub returns) | 🧠 Knowledge Doc (plan items) |
| generated_actions insert | Yash | ⚡ Actions |
| generated_actions update | Yash (on execute) | ⚡ Actions (button → external link) |

Subscribe once on tab mount, unsubscribe on unmount. All filters are `project_id=eq.<uuid>` (which is why `generated_actions` carries denormalized `project_id`).

---

## 9. Hyperspell Reprocessing (cron)

```python
# backend/main.py
from apscheduler.schedulers.asyncio import AsyncIOScheduler
scheduler = AsyncIOScheduler()

@app.on_event("startup")
async def start_scheduler():
    scheduler.add_job(ingest_all_projects, "interval", minutes=5, id="hs_ingest")
    scheduler.start()
```

Idempotent because `/ingest/hyperspell` UPSERTs on `(project_id, source, external_id)` or `(project_id, source, content_hash)`.

**Pause during demo**: `scheduler.pause_job("hs_ingest")` at 5:55pm so the cron doesn't add noise mid-presentation.

**Stretch (5th sponsor)**: replace this block with a Tensorlake job.

---

## 10. Demo Script (90 seconds)

> **Yash (10s):** *"Project Brain. Engineering teams already have all the context they need — it's just scattered. Slack, docs, meetings, code. We turn that into an executable plan, live."*

> **(Page open. Inputs tab. Project Context already shows Slack/Drive/Notion entries from this morning.)*

> **Yudong (5s) — clicks 🎙️ Join meeting:** *"Let me join a standup."*

> **Yudong (15s) — speaks:** *"Quick standup. The login flow is broken on Safari, we caught it in #bugs yesterday. Yash's design doc has us shipping CSV export this sprint, but the rate-limit middleware needs cleanup before we touch that."*

> **(Voice notes appear in Inputs ▸ Meetings as he speaks. 🟢 decision / 🟡 blocker / 🔵 action_item.)*

> **Yash (5s) — switches to Knowledge Doc, clicks ✨ Generate plan:** *"Now we run the weekly plan agent."*

> **(~8s. Synthesis cards first. Then plan items animate in one-by-one as Hyperspell GitHub returns code refs per item: Safari bug with `auth/redirect.ts`, CSV export, rate-limit cleanup with `middleware/rateLimit.ts`.)*

> **Jin (20s) — switches to Actions:** *"One bug, one feature, one maintenance — every one with the source it came from and the file it touches. Watch — "* (clicks **Execute** on Linear) *"that ticket just hit our real Linear board."* (clicks Devin) *"Devin gets the full context bundle to start working on it autonomously."*

> **Yash (10s):** *"Four sponsors stitched into one product — Hyperspell, OpenAI Realtime, Vercel, Devin — solving a problem every engineering team here has. Questions?"*

---

## 11. Risk Register

| Risk | Mitigation |
|---|---|
| `getDisplayMedia({video:false})` throws TypeError | Code in §3.A1 requests video, drops the track. Caller catches `TAB_AUDIO_MISSING` and falls back to mic-only. |
| OpenAI Realtime endpoint shape changes | Only `/rt/token` adapts. Frozen contract: `{ value, expires_at }`. |
| No transcription events fired | `session.update` includes `audio.input.transcription` (§3.C). Verified against console trace at 11am. |
| OpenAI Realtime flaky on event Wi-Fi | Phone hotspot. Final fallback: prerecorded transcript replay. |
| Hyperspell GitHub beta access denied | `get_code_refs` falls back to `fixtures/seed_code_refs.json`. Demo path is identical. **Verify access tonight.** |
| Hyperspell sync incomplete by 9am | Fixture file fallback for `/ingest/hyperspell`. |
| pgvector extension not enabled | Test `select 1::vector(3)` at 10:30am. Without it, fall back to ILIKE in `/context/query`. |
| Claude returns malformed JSON | Anthropic tool-use schema; Pydantic-validate; one retry. |
| Realtime drops a row | Each tab does initial `select` on mount, then layers inserts. |
| Anon-key INSERT denied by RLS | Test from clean browser at 11:30am. Policies `anon_insert_mn` and `anon_insert_tc` must be applied. |
| Postgres Changes filter doesn't fire on `generated_actions` | `project_id` is denormalized on the table — direct equality filter works. Verified at 1pm. |
| `/plan/generate` runs concurrently → duplicate items | `generation_runs` unique on `(project_id, week_start, idempotency_key)`. Conflict returns 409. Plan items DELETE+INSERT in one transaction. |
| `/plan/generate` dies mid-run | `generation_runs.status` flips to `error` with text. UI shows ❌ Generation failed. Retry button reuses idempotency key. |
| Cron fires during demo | `scheduler.pause_job("hs_ingest")` at 5:55pm. |
| Realtime tool calling misbehaves | `tool_choice: "none"` and ship with static briefing only. |
| `/context/query` > 1s | Drop Hyperspell stage (timeout=500ms); pgvector-only is ~50ms. |
| Linear/GitHub/Devin action fails live | Pre-validate at 4pm. Show polished draft if API fails. GitHub PR needs an existing pushed branch — for demo, prefer Linear or Devin Execute. |
| Mutating endpoints exposed publicly | `Bearer ${DEMO_TOKEN}` required on `/ingest`, `/plan/generate`, `/actions/.../execute`. Token rotated demo-day. |
| Demo over 3 minutes | Yudong is the timer. Cut intro, not demo. |
| FastAPI not reachable from Vercel | ngrok stable URL baked into `NEXT_PUBLIC_FASTAPI_URL`. Test from Vercel preview at 5:00pm. |

---

## 12. Sponsor Coverage

- [x] **Hyperspell** — project_context ingestion + per-item codebase RAG. Track sponsor → $1k cash + 6mo unlimited + founders deploy session.
- [x] **OpenAI** — Realtime API (voice agent) + `text-embedding-3-small` (vector search) + GPT-4.1 (summarizer) + Claude isn't OpenAI but Anthropic; OpenAI's three-fold use is real.
- [x] **Vercel** — public deploy URL.
- [x] **Devin** — "Send to Devin" button visible in Actions tab.
- [ ] *Stretch:* **Tensorlake** — replace APScheduler with a Tensorlake job (5th sponsor).

---

## 13. Pre-Hackathon Checklist (tonight)

**Yash**
- [ ] Hyperspell account; OAuth Slack, Drive, Notion, Gmail.
- [ ] **Verify Hyperspell GitHub beta access** (this is the single highest-risk dependency).
- [ ] Ingest seed corpus.
- [ ] Anthropic + OpenAI keys ready (OpenAI used 3 ways: Realtime, embeddings, GPT-4.1).
- [ ] Linear sandbox project + token.
- [ ] GitHub PAT scoped to demo repo + a feature branch already pushed (so PR creation is possible).
- [ ] Devin form filled.
- [ ] ngrok subdomain reserved.
- [ ] `DEMO_TOKEN` generated; shared via 1Password.
- [ ] Pair with Jin on `supabase/schema.sql` (§6) **including pgvector + RLS + grants**.
- [ ] Pair with Yudong on `seed_code_refs.json` fixtures.

**Yudong**
- [ ] Standup script v1 (≤60s, 3 signals: bug + feature + maintenance).
- [ ] Seed corpus content drafted; handed to Yash.
- [ ] Test `getDisplayMedia + getUserMedia` in Chrome/Edge.
- [ ] Confirm browser fires `conversation.item.input_audio_transcription.delta` events with the §3.C session config (run a 30-second console test).

**Jin**
- [ ] Supabase project created.
- [ ] `vector` extension enabled.
- [ ] Schema + HNSW indexes + RLS + grants applied (§6); pair with Yash.
- [ ] Realtime publication enabled on the 7 reactive tables.
- [ ] Anon key → frontend `.env`. Service role key → Yash only.
- [ ] Vercel project linked to GitHub; deploy works.
- [ ] Confirm `anon_insert_mn` lets a browser INSERT a `meeting_notes` row.
- [ ] Confirm `search_context` RPC is callable by anon (or move to backend-only).

**Shared**
- [ ] 1Password vault with all keys, including `DEMO_TOKEN`.
- [ ] Yudong prints demo script + brings phone hotspot.

---

## 14. One-line summary

> *Project Brain is a per-project pipeline: a voice agent and Hyperspell continuously feed embedded `meeting_notes` and `project_context` into Supabase, where a weekly Claude pipeline synthesizes a knowledge document, categorizes plan items with codebase refs from Hyperspell GitHub, and turns each into one-click Linear, GitHub, or Devin actions.*
