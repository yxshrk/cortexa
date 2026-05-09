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

Five tables, one flow. Inputs are continuous (voice agent + 5min Hyperspell cron). Synthesis + categorization run on demand (one button). Codebase context is only consulted when categorizing — to attach `code_refs` to each plan item.

---

## 1. Stack

| Layer | Tech | Sponsor | Owner |
|---|---|---|---|
| Project context (Slack/Drive/Notion/Gmail) ingestion | **Hyperspell** | ✅ track | Yash |
| Codebase context (live RAG, pulled per item) | **Hyperspell GitHub** | ✅ track | Yash |
| Live meeting capture | **OpenAI Realtime API** (WebRTC) | ✅ | Yudong |
| Database + realtime | **Supabase** (Postgres + Realtime + RLS) | — | Jin (with Yash) |
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
│   │                                                                    │  │
│   │     ▸ Project Context    ── grouped by Slack/Drive/Notion/Gmail   │  │
│   │                              auto-refresh every 5 min             │  │
│   │                                                                    │  │
│   │   🧠 Knowledge Doc (this week's synthesis)                         │  │
│   │     ▸ Summary · Themes · Decisions · Blockers · Open questions    │  │
│   │     ▸ Plan items, grouped:                                        │  │
│   │           🐛 Bug fixes   ✨ New features   🔧 Maintenance          │  │
│   │       each item: title, description, source_refs, code_refs       │  │
│   │                                                                    │  │
│   │   ⚡ Actions                                                       │  │
│   │     One row per plan item, three drafts each:                     │  │
│   │           Linear ticket · GitHub PR · Devin handoff               │  │
│   │     Execute button → real ticket / PR / Devin session             │  │
│   └────────────────────────────────────────────────────────────────────┘  │
└──────────┬───────────────────────────────────────────┬───────────────────┘
           │ supabase-js (anon key)                    │ fetch HTTP
           │  • Yudong: INSERT meeting_notes only      │  • Yudong → /rt/token,
           │  • Jin: SELECT (realtime) on all 5 tables │              /context/briefing,
           │                                           │              /context/query
           │                                           │  • Jin → /ingest/hyperspell,
           │                                           │              /plan/generate,
           │                                           │              /actions/{id}/execute
           ▼                                           ▼
┌── SUPABASE ── JIN (schema) ──────────┐   ┌── FASTAPI ── YASH ──────────────────┐
│                                      │   │                                     │
│  RAW INPUTS                          │   │  GET  /context/briefing             │
│   ▸ meeting_notes      (Yudong)      │   │  POST /rt/token                     │
│   ▸ project_context    (Yash cron)   │   │  POST /context/query (live RAG)     │
│                                      │   │                                     │
│  SYNTHESIS                           │   │  POST /ingest/hyperspell            │
│   ▸ knowledge_documents              │◄──┤    └─► writes project_context       │
│                                      │py │                                     │
│  CATEGORIZED                         │svc│  POST /plan/generate                │
│   ▸ plan_items                       │   │    1) read meeting_notes +          │
│      (with code_refs)                │   │       project_context (last 7d)     │
│                                      │   │    2) Claude synthesis →            │
│  EXECUTION                           │   │       knowledge_documents (UPSERT   │
│   ▸ generated_actions                │   │       on (project_id, week_start))  │
│                                      │   │    3) Claude categorize, per item   │
│  realtime publication on             │   │       call Hyperspell GitHub for    │
│  all 5 tables (§6)                   │   │       code_refs → plan_items        │
│                                      │   │    4) draft Linear/PR/Devin per     │
│  RLS policies                        │   │       item → generated_actions      │
│   ▸ anon: SELECT all                 │   │                                     │
│   ▸ anon: INSERT meeting_notes only  │   │  POST /actions/{id}/execute         │
│   ▸ service_role: full               │   │                                     │
│                                      │   │  APScheduler: /ingest/hyperspell    │
│                                      │   │  every 5 min                        │
└──────────────────────────────────────┘   └─────────────────────────────────────┘
```

**Read top-down**: browser → two backends. Two write paths into Supabase: Yudong from the browser via anon key (only on `meeting_notes`); Yash from FastAPI via service-role key (any table). Reads are realtime subscriptions from Jin's tabs.

### 2.1 The linear pipeline (what `/plan/generate` runs)

```
   meeting_notes  ┐                  ┌─► knowledge_documents
   (last 7d)      │                  │   (themes, decisions,
                  ├──► Claude #1 ────┤    blockers, summary,
   project_context│   synthesis      │    open_questions)
   (last 7d)      ┘                  └────────────┬────────────────┐
                                                  │                │
                                                  ▼                │
                              ┌─► Claude #2 categorize             │
                              │   bug_fix / new_feature / maint.   │
                              │                                    │
                              │   per item, query                  │
                              │   Hyperspell GitHub ───────────────┘
                              │   for code_refs
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

**Why codebase is pulled here, not earlier**: project_context (Slack/Jira) tells you *what matters this week*; codebase tells you *which files back it up*. Pulling code at ingest time would flood the doc with irrelevant snippets. Pulling per item ensures every code_ref is tied to an actionable plan item.

### 2.2 Dynamic context (live RAG during the meeting, see §3 Yudong)

Independent of `/plan/generate`. While Yudong's meeting is running, OpenAI Realtime can call a tool that hits `POST /context/query` to pull merged Hyperspell + DB context into the model live. Output flows into Yudong's voice notes. Additive; degrades gracefully.

---

## 3. The Three Roles

### 🎙️ Yudong — Voice Agent

You own the entire voice path. Yash gives you `/rt/token`, `/context/briefing`, and `/context/query`. Everything else is in your frontend.

**Your slice**

```
On meeting start:
   GET /context/briefing?projectId=X    → render Briefing panel
   POST /rt/token                       → WebRTC handshake with OpenAI Realtime
   captureMeetingAudio()                → tab + mic mixed stream

While running:
   transcript deltas via data channel
       │
       ▼ (every ~20s, on speaker pause)
   POST /api/voice/summarize  (your Next route)
       body: { transcript_chunk, briefing }
       → returns: [{ type, text, refs_to }]
       │
       ▼
   for each note:
     supabase.from("meeting_notes").insert({...})    ← anon key
       │
       ▼
   Supabase realtime → Jin's Inputs ▸ Meetings updates (~200ms)

   AND, in parallel:
   model emits function_call (search_project_context)
       │
       ▼
   POST /context/query  → returns ContextItem[]
       │
       ▼
   return as function_call_output → model uses for richer transcript
       │
       ▼
   update React Flow context board inside VoiceAgent
```

#### A. Joining meetings

**A1 — Tab + mic mix (recommended)**: `getDisplayMedia({audio:true})` captures the meeting tab; `getUserMedia` captures local mic; mix via Web Audio.

```ts
// frontend/lib/meetingAudio.ts
export async function captureMeetingAudio(): Promise<MediaStream> {
  const tab = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(tab).connect(dest);
  ctx.createMediaStreamSource(mic).connect(dest);
  return dest.stream;
}
```

**A2 — Mic only** (fallback). **A3 — Recall.ai bot** (skip).

#### B. Briefing (one-time, on meeting start)

```ts
const briefing = await fetch(`${FASTAPI}/context/briefing?projectId=${pid}`).then(r=>r.json());
// renders themes, open threads, latest docs, active files, people
```

Pass the briefing to your summarizer route as system prompt context. Optionally `session.update` Realtime with the briefing text so transcription biases toward project terms.

#### C. Live tool-calling (dynamic RAG, see §2.2)

Configure Realtime with one tool:

```ts
const TOOLS = [{
  type: "function",
  name: "search_project_context",
  description: "Search this project's knowledge base for files, decisions, or threads relevant to a topic the team is discussing right now.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"]
  }
}];
dc.send(JSON.stringify({ type: "session.update",
  session: { instructions: BRIEFING_PROMPT, tools: TOOLS, tool_choice: "auto" }}));
```

Handler on the data channel:

```ts
dc.addEventListener("message", async (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === "response.function_call_arguments.done"
      && ev.name === "search_project_context") {
    const { query } = JSON.parse(ev.arguments);
    const items = await fetch(`${FASTAPI}/context/query`, {
      method: "POST",
      body: JSON.stringify({ projectId, query, k: 6 }),
    }).then(r => r.json()).catch(() => []);
    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: ev.call_id, output: JSON.stringify(items) },
    }));
    dc.send(JSON.stringify({ type: "response.create" }));
  }
});
```

#### D. Summarizer route (your Next.js Route Handler)

```ts
// frontend/app/api/voice/summarize/route.ts
import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function POST(req: Request) {
  const { transcript_chunk, briefing } = await req.json();
  const r = await openai.chat.completions.create({
    model: "gpt-4.1",
    response_format: { type: "json_schema", json_schema: VoiceNoteSchema },
    messages: [
      { role: "system", content: `Project: ${briefing.project_summary}
        Themes: ${briefing.themes.join(", ")}
        Active files: ${briefing.active_files.map(f=>f.path).join(", ")}
        Emit 1-3 notes. Each: { type: "decision|action_item|blocker|mention|fyi", text, refs_to: [...] }` },
      { role: "user", content: transcript_chunk },
    ],
  });
  return Response.json(JSON.parse(r.choices[0].message.content));
}
```

Then in your component:

```ts
const notes = await fetch("/api/voice/summarize", { method: "POST",
  body: JSON.stringify({ transcript_chunk, briefing }) }).then(r=>r.json());
for (const n of notes) {
  await supabase.from("meeting_notes").insert({
    project_id: pid, meeting_id: mid,
    type: n.type, text: n.text, refs_to: n.refs_to,
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
| `frontend/lib/meetingAudio.ts` | tab + mic mixer |
| `frontend/lib/realtime.ts` | WebRTC handshake helper |
| `frontend/lib/voiceNoteSchema.ts` | shared JSON schema |
| `frontend/app/api/voice/summarize/route.ts` | summarizer endpoint |
| `frontend/components/VoiceAgent.tsx` | the component Jin mounts |
| `frontend/components/BriefingPanel.tsx` | briefing display |
| `frontend/components/MeetingContextBoard.tsx` | live context board |
| `frontend/components/LiveContextDiagram.tsx` | React Flow diagram |
| `demo/standup_script.md` | 60-second standup script |

#### Milestones

- 11:00am — VoiceAgent skeleton: `/rt/token` + mic-only WebRTC.
- 12:30pm — Tab+mic mixer; `/api/voice/summarize` returns structured notes.
- 1:30pm — Briefing fetched, rendered, passed to summarizer.
- 2:30pm — Notes flowing: mic → summarizer → `meeting_notes` → Jin's Inputs tab.
- 3:00pm — Live tool-calling: model invokes `search_project_context`, summarizer note cites the fetched item, and the React Flow board updates from the returned context.
- 5:00pm — Demo timed at ≤90s.

---

### 🗄️ Jin — Database & Frontend

Two artifacts: the Supabase schema/realtime/RLS, and a tabbed Next.js app.

**Mental model — five tables, one flow**

| Table | What it stores | Who writes |
|---|---|---|
| `meeting_notes` | structured notes from Yudong's voice agent (one row per note, multiple per meeting) | Yudong (anon INSERT) |
| `project_context` | items ingested from Hyperspell — Slack messages, Drive docs, Notion pages, Gmail threads | Yash (svc INSERT, cron + manual) |
| `knowledge_documents` | the weekly synthesis: summary, themes, decisions, blockers, open questions. **One row per project per week.** | Yash (svc UPSERT on `(project_id, week_start)`) |
| `plan_items` | categorized actionables (bug_fix / new_feature / maintenance), with `code_refs` from Hyperspell GitHub | Yash (svc INSERT) |
| `generated_actions` | Linear / PR / Devin draft per plan item × 3 | Yash (svc INSERT, then UPDATE on execute) |

**UI — three tabs**

```
/projects                            (project list)
   │ click
   ▼
/projects/[id]                       (project page with tabs)
   │
   ├─ 📥 Inputs
   │     ▸ Meetings (collapsible)
   │         <VoiceAgent />  (Yudong's component, top of section)
   │         List of past meetings; click to expand notes by type
   │           (🟢 decision · 🔵 action_item · 🟡 blocker · ⚪ mention · ⚪ fyi)
   │     ▸ Project Context (collapsible)
   │         Tabs within: Slack | Drive | Notion | Gmail
   │         Cards: title, snippet, author, ts, ref_url
   │
   ├─ 🧠 Knowledge Doc
   │     Header: "Week of <Mon date>"  + ✨ Generate plan button
   │     Synthesis section (4 cards):
   │       • Summary (1 paragraph)
   │       • Themes (chips)
   │       • Decisions (list)
   │       • Blockers (list)
   │       • Open questions (list)
   │     Plan items section (3 columns):
   │       🐛 Bug fixes      ✨ New features      🔧 Maintenance
   │       each card: title · description · source_refs chips · code_refs
   │
   └─ ⚡ Actions
         Filter: Linear / GitHub PR / Devin (or All)
         One card per generated_action: title, payload preview, status pill
         Execute button → POST /actions/{id}/execute
         On success: button swaps to "Open in Linear ↗" with external_url
```

**Subscriptions** (one per tab section)

| Subscription | Tab | Triggered by |
|---|---|---|
| `meeting_notes` (filter project_id) | 📥 Inputs ▸ Meetings | Yudong's anon INSERT |
| `project_context` (filter project_id) | 📥 Inputs ▸ Project Context | Yash's `/ingest/hyperspell` (cron + manual) |
| `knowledge_documents` (filter project_id, latest week) | 🧠 Knowledge Doc (synthesis section) | Yash's `/plan/generate` step 2 |
| `plan_items` (filter knowledge_document_id) | 🧠 Knowledge Doc (plan items section) | Yash's `/plan/generate` step 3 |
| `generated_actions` (filter via plan_items) | ⚡ Actions | Yash's `/plan/generate` step 4, and `/actions/{id}/execute` for status updates |

**Header buttons** (visible on all tabs)

- 🔄 **Refresh from Hyperspell** → `fetch(FASTAPI/ingest/hyperspell)` (manual override of the 5min cron)
- ✨ **Generate weekly plan** → `fetch(FASTAPI/plan/generate)`

(The 🎙️ voice agent button lives **inside** the Inputs ▸ Meetings section, owned by Yudong.)

#### Files you own

```
supabase/
  schema.sql                         (canonical, pre-day pair work with Yash)
  migrations/*.sql                   (Yash adds; you apply)
frontend/
  app/projects/page.tsx              (project list)
  app/projects/[id]/page.tsx         (tab shell)
  app/projects/[id]/_tabs/InputsTab.tsx
  app/projects/[id]/_tabs/KnowledgeDocTab.tsx
  app/projects/[id]/_tabs/ActionsTab.tsx
  components/MeetingsList.tsx        (expandable meeting cards with notes)
  components/ProjectContextList.tsx  (Slack/Drive/Notion/Gmail sub-tabs)
  components/SynthesisCards.tsx      (Summary/Themes/Decisions/Blockers/Questions)
  components/PlanItemCards.tsx       (3-column bug/feature/maintenance)
  components/ActionCard.tsx          (with Execute button)
  lib/supabase.ts
  app/globals.css, tailwind config
```

#### Milestones

- 10:30am — Supabase schema deployed; teammates have keys.
- 11:30am — `/projects` and `/projects/[id]` skeleton; tab switching works; dummy data renders in all three tabs.
- 1:00pm — Inputs ▸ Meetings lights up live as Yudong inserts.
- 2:00pm — Inputs ▸ Project Context lights up after Yash's `/ingest/hyperspell` runs.
- 3:30pm — Knowledge Doc tab + Actions tab render real data after `/plan/generate`.
- 5:30pm — Polished + deployed Vercel URL works on laptop and phone.

---

### 🧠 Yash — Backend, Hyperspell, Categorizer, Executors

Heaviest role. Owns FastAPI surface, Hyperspell, Claude pipeline, executors, cron.

**Endpoints**

| Method | Path | Caller | Purpose |
|---|---|---|---|
| POST | `/rt/token` | Yudong | mint OpenAI Realtime ephemeral token |
| GET  | `/context/briefing?projectId=X` | Yudong (once on meeting start) | assemble briefing from Hyperspell + last 7d of inputs |
| POST | `/context/query` | Yudong's tool handler (live during meeting) | merged Hyperspell + DB search; sub-1s |
| POST | `/ingest/hyperspell` | Jin button + 5min cron | search Hyperspell, INSERT `project_context` (dedup on `ref_url`) |
| POST | `/plan/generate` | Jin button | the linear pipeline: synthesis → categorization → action drafts |
| POST | `/actions/{id}/execute` | Jin button | dispatch to Linear/GitHub/Devin; UPDATE status + external_url |

**Key implementation notes**

1. **`/ingest/hyperspell`** — pulls Slack/Drive/Notion/Gmail (NOT GitHub code). Dedup key: `(project_id, source, ref_url)`. Re-running is safe.

2. **`/plan/generate`** — the heart of the product. Three Claude calls:
   ```
   def generate_plan(project_id):
       wk_start, wk_end = current_iso_week()
       notes   = sb.select meeting_notes WHERE project_id=… AND ts >= wk_start
       context = sb.select project_context WHERE project_id=… AND ts >= wk_start

       # Step 1: synthesis
       doc = claude.synthesize(notes, context)
       doc_id = sb.upsert knowledge_documents
                ON (project_id, week_start)
                SET summary, themes, decisions, blockers, open_questions,
                    source_meeting_note_ids, source_project_context_ids

       # Step 2: categorize + per-item codebase pull
       items = claude.categorize(doc)  # returns 3-7 items, each with a "code_query"
       for item in items:
           code_refs = hyperspell.search(
               item.code_query,
               sources=["github"],
               k=3,
           )
           sb.insert plan_items
              SET knowledge_document_id=doc_id, category, title,
                  description, source_refs, code_refs, next_step, confidence

       # Step 3: action drafts
       for item in items:
           drafts = claude.draft_actions(item)  # returns 3 drafts
           for d in drafts:
               sb.insert generated_actions SET plan_item_id, action_type, payload

       sb.update knowledge_documents SET status='ready' WHERE id=doc_id
   ```
   Each step uses Anthropic tool-use schema for guaranteed JSON. Pydantic-validate; one retry on failure.

3. **`/context/briefing`** — cached per `(projectId, day)`. Built from last 7d of `meeting_notes` + `project_context` + a fresh Hyperspell pull of latest 3 design docs.

4. **`/context/query`** — sub-1s. Postgres ILIKE on `meeting_notes.text` ∪ `project_context.snippet` (last 30d) + live Hyperspell search. Merge, dedupe, top-k. 60s same-query cache.

5. **APScheduler cron** — runs `/ingest/hyperspell` every 5 minutes for every project. Idempotent.

6. **`/actions/{id}/execute`** — read action from Supabase, dispatch to Linear/GitHub/Devin, UPDATE row.

#### Files you own

```
backend/
  main.py                       FastAPI app, CORS, scheduler startup
  routers/
    realtime.py                 /rt/token
    context.py                  /context/briefing, /context/query
    ingest.py                   /ingest/hyperspell
    plan.py                     /plan/generate
    actions.py                  /actions/{id}/execute
  services/
    hyperspell.py               search wrapper (project_context + github)
    briefing_builder.py         cached briefing assembly
    synthesizer.py              Claude call #1 → knowledge_documents
    categorizer.py              Claude call #2 + per-item Hyperspell GitHub
    action_drafter.py           Claude call #3 → generated_actions
    executors/{linear,github,devin}.py
    supabase_writer.py          supabase-py wrappers
  jobs/
    ingest_cron.py              APScheduler job
  schemas.py                    Pydantic models matching §7
  settings.py
```

#### Milestones

- Night before: Hyperspell connectors live + corpus ingested + verified search.
- 11:00am: FastAPI running, `/rt/token` + `/context/briefing` return real data.
- 1:00pm: `/ingest/hyperspell` populates `project_context`.
- 2:00pm: `/context/query` <1s.
- 3:00pm: `/plan/generate` runs end-to-end; all 5 tables update; Jin's UI lights up.
- 4:00pm: APScheduler cron live.
- 5:00pm: `/actions/{id}/execute` creates real Linear tickets.

---

## 3.5 Conflict Map & Ownership

### Hard "never touches"

| Person | Never touches |
|---|---|
| Yash | Frontend code. Schema SQL directly (migrations only). |
| Jin | Backend Python. Voice agent components. |
| Yudong | Backend Python. Schema SQL. Page chrome, global styling, the three tabs. |

### File ownership

| Path | Owner |
|---|---|
| `backend/**` | Yash |
| `frontend/app/**` (excluding `api/voice/**`), `_tabs/**`, panels, `lib/supabase.ts`, `globals.css`, Tailwind | Jin |
| `frontend/components/{VoiceAgent,BriefingPanel,MeetingContextBoard,LiveContextDiagram}.tsx`, `frontend/lib/{realtime,meetingAudio,voiceNoteSchema}.ts`, `frontend/app/api/voice/**` | Yudong |
| `supabase/schema.sql` | Jin (canonical) |
| `supabase/migrations/*.sql` | Yash adds, Jin applies |
| `demo/**` | Yudong |

### Schema change workflow

1. Pre-day: Yash + Jin pair on `supabase/schema.sql` (§6). **Frozen at 9:30am sync.**
2. Mid-day: Yash writes `supabase/migrations/000N_*.sql` → pings Jin → Jin applies.
3. No silent edits to `schema.sql` after 9:30am.

### Component contract (Jin ↔ Yudong)

```tsx
// Yudong owns
export function VoiceAgent({ projectId, meetingId }: { projectId: string; meetingId: string }) {...}
```

No callbacks back to the page — agent writes to `meeting_notes`; Jin's tab sees changes via realtime. Any live React Flow context board stays inside `VoiceAgent`.

### Supabase write rules

- **Anon key (frontend)**: `INSERT` only on `meeting_notes`. `SELECT` on all 5 reactive tables.
- **Service key (backend)**: full access; bypasses RLS.
- Frontend never uses service key. Backend never uses anon key.

### Realtime rule

Only Jin subscribes. Yudong relies on the `INSERT` response code; never opens a channel.

### Communication triggers

| Trigger | Who pings whom |
|---|---|
| Schema change needed | Yash → Jin |
| `/context/briefing` or `/context/query` shape needs change | Yudong → Yash |
| `/context/query` > 1s | Yash → Yudong (lower k or drop a source) |
| Hyperspell not returning expected items | Yash → Yudong (corpus may need adjustment) |
| Voice notes generic | Yudong tunes summarizer prompt |
| Vercel env missing / FastAPI URL changed | Jin ↔ Yash |

---

## 4. Build Order

```
8:00 AM   Doors. NIGHT-BEFORE WORK MUST BE DONE:
            • Yash:   Hyperspell connectors + corpus ingested
            • Yudong: standup script v1 + corpus content drafted
            • Jin:    Supabase schema + Vercel project linked

9:15 AM   Hacking starts.
          [ALL] 30-min sync. Whiteboard contracts (§5). Distribute keys.

9:45 AM   PARALLEL ─────────────────────────────────────────────────────
          Yash:   FastAPI scaffold; /rt/token + /context/briefing.
          Yudong: VoiceAgent skeleton; mic-only WebRTC; deltas in console.
          Jin:    Next.js scaffold; supabase-js; /projects + /projects/[id]
                  with 3 tabs rendering dummy rows.

11:00 AM  CHECKPOINT. Move on once green.

11:00 AM  PARALLEL ─────────────────────────────────────────────────────
          Yash:   /ingest/hyperspell against real Hyperspell.
                  /context/query implementation.
          Yudong: tab+mic mixer; real /api/voice/summarize using briefing;
                  meeting_notes inserts visible in Jin's Inputs tab.
          Jin:    Inputs ▸ Meetings + Inputs ▸ Project Context fully live.

12:00     Hyperspell speaker session — Yash attends.
12:30     Lunch.

1:30 PM   CHECKPOINT.

1:30 PM   PARALLEL ─────────────────────────────────────────────────────
          Yash:   /plan/generate end-to-end (synthesis → categorize →
                  per-item Hyperspell GitHub → action drafts).
                  APScheduler cron.
          Yudong: live tool-calling working; React Flow context board updates
                  from /context/query; rehearsal practice.
          Jin:    Knowledge Doc tab + Actions tab fully reactive.
                  Animations, toasts, error states.

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
POST {FASTAPI}/rt/token  →  { "client_secret": { "value": "ek_..." }, ... }
```

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
     "text": "≤300", "refs_to": [...] }]
```

### 5.4 Yudong's INSERT into `meeting_notes`

```ts
await supabase.from("meeting_notes").insert({
  project_id, meeting_id,
  type: n.type, text: n.text, refs_to: n.refs_to,
});
```

### 5.5 `/ingest/hyperspell` (Jin button + cron → Yash)

```http
POST {FASTAPI}/ingest/hyperspell  { "projectId": "<uuid>" }
→ { "inserted": 14, "skipped_dupes": 22 }
```

### 5.6 `/plan/generate` (Jin → Yash)

```http
POST {FASTAPI}/plan/generate  { "projectId": "<uuid>" }
→ 202 Accepted  { "knowledgeDocumentId": "<uuid>", "items": 5, "actions": 15 }
```

Pipeline runs async; Jin's tabs see rows arrive via realtime in this order:
1. `knowledge_documents` row UPSERTed (status='generating').
2. `plan_items` rows inserted one-by-one (each takes ~1-2s as Hyperspell GitHub is queried per item).
3. `generated_actions` rows inserted in bulk.
4. `knowledge_documents.status` flipped to 'ready'.

### 5.7 `/actions/{id}/execute` (Jin → Yash)

```http
POST {FASTAPI}/actions/{actionId}/execute
→ { "externalUrl": "https://linear.app/.../ABC-42" }
```

### 5.8 `/context/query` (Yudong's tool handler → Yash)

```http
POST {FASTAPI}/context/query  { "projectId": "<uuid>", "query": "string", "k": 6 }
→ [{ "source": "meeting|slack|drive|notion|github|gmail",
     "title": "string", "snippet": "≤200", "url": null|"...",
     "ts": null|"...", "score": 0.0,
     "code_path": null|"...", "code_lines": null|"..." }]
```

Sub-1s. Yudong returns this as `function_call_output` to Realtime.

---

## 6. Supabase Schema + RLS

```sql
create extension if not exists "uuid-ossp";

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

-- RAW INPUT 1: meeting notes (written by Yudong, anon INSERT)
create type meeting_note_type as enum ('decision','action_item','blocker','mention','fyi');
create table meeting_notes (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  meeting_id uuid references meetings(id) on delete cascade,
  type meeting_note_type not null,
  text text not null,
  refs_to jsonb default '[]',
  ts timestamptz default now()
);
create index on meeting_notes (project_id, ts desc);
create index on meeting_notes (meeting_id);

-- RAW INPUT 2: project context (written by Yash via /ingest/hyperspell)
create type context_source as enum ('slack','drive','notion','gmail');
create table project_context (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  source context_source not null,
  title text,
  snippet text,
  author text,
  ref_url text,
  ts timestamptz default now()
);
create unique index on project_context (project_id, source, ref_url) where ref_url is not null;
create index on project_context (project_id, source, ts desc);

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

-- CATEGORIZED: plan items (with code_refs from Hyperspell GitHub)
create type plan_item_category as enum ('bug_fix','new_feature','maintenance');
create table plan_items (
  id uuid primary key default uuid_generate_v4(),
  knowledge_document_id uuid references knowledge_documents(id) on delete cascade,
  project_id uuid references projects(id) on delete cascade,
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

-- EXECUTION: action drafts (3 per plan_item, executed via Yash)
create type action_type   as enum ('linear_ticket','github_pr','devin_handoff');
create type action_status as enum ('draft','executing','executed','failed');
create table generated_actions (
  id uuid primary key default uuid_generate_v4(),
  plan_item_id uuid references plan_items(id) on delete cascade,
  action_type action_type not null,
  payload jsonb,
  status action_status default 'draft',
  external_url text,
  created_at timestamptz default now()
);
create index on generated_actions (plan_item_id);
```

### Realtime publication

Enable `supabase_realtime` for: `meeting_notes`, `project_context`, `knowledge_documents`, `plan_items`, `generated_actions`.

### RLS policies

```sql
alter table meeting_notes        enable row level security;
alter table project_context      enable row level security;
alter table knowledge_documents  enable row level security;
alter table plan_items           enable row level security;
alter table generated_actions    enable row level security;
alter table projects             enable row level security;
alter table meetings             enable row level security;

-- anon can read everything (for Jin's subscriptions)
create policy anon_read_all_mn on meeting_notes        for select to anon using (true);
create policy anon_read_all_pc on project_context      for select to anon using (true);
create policy anon_read_all_kd on knowledge_documents  for select to anon using (true);
create policy anon_read_all_pi on plan_items           for select to anon using (true);
create policy anon_read_all_ga on generated_actions    for select to anon using (true);
create policy anon_read_all_p  on projects             for select to anon using (true);
create policy anon_read_all_m  on meetings             for select to anon using (true);

-- anon can INSERT only into meeting_notes (Yudong's voice agent)
create policy anon_insert_meeting_notes on meeting_notes
  for insert to anon with check (true);

-- service role bypasses RLS automatically (Yash's backend)
```

---

## 7. Output Schemas (frozen at 9:30am)

### 7.1 Synthesizer (Claude #1) → `knowledge_documents` row

```json
{
  "summary":         "string ≤500",
  "themes":          ["string"],
  "decisions":       [{ "text": "≤200", "ref_ids": ["mn:<uuid>", "pc:<uuid>"] }],
  "blockers":        [{ "text": "≤200", "ref_ids": [...] }],
  "open_questions":  [{ "text": "≤200", "ref_ids": [...] }]
}
```

`ref_ids` use prefix `mn:` for `meeting_notes`, `pc:` for `project_context`. UI renders these as clickable chips that scroll to the source.

### 7.2 Categorizer (Claude #2) → `plan_items` rows

```json
{
  "items": [
    {
      "category": "bug_fix|new_feature|maintenance",
      "title": "≤80",
      "description": "≤400",
      "source_refs": [{ "ref_id": "mn:<uuid>|pc:<uuid>", "snippet": "≤200" }],
      "code_query": "string — the exact query to run against Hyperspell GitHub for this item",
      "next_step": "≤200",
      "confidence": 0.0
    }
  ]
}
```

Yash runs `hyperspell.search(item.code_query, sources=["github"], k=3)` per item, attaches results as `code_refs` before INSERT.

### 7.3 Action drafter (Claude #3) → `generated_actions` rows

For each plan_item, 3 rows:

```json
[
  { "action_type": "linear_ticket",  "payload": { "title": "...", "description": "...", "labels": [...], "priority": "..." }},
  { "action_type": "github_pr",      "payload": { "branch": "...", "title": "...", "body": "..." }},
  { "action_type": "devin_handoff",  "payload": { "task": "...", "context_bundle": {...} }}
]
```

---

## 8. Realtime Update Flow (the demo magic)

Every INSERT/UPDATE on Supabase triggers `postgres_changes` → tabs subscribed to that table re-render. No polling.

| Event | Who triggered it | Which tab updates |
|---|---|---|
| Yudong's voice note inserted | anon, in-browser | 📥 Inputs ▸ Meetings |
| `/ingest/hyperspell` (cron or manual) inserts project_context | service role | 📥 Inputs ▸ Project Context |
| `/plan/generate` UPSERTs knowledge_documents | service role | 🧠 Knowledge Doc (synthesis section) |
| `/plan/generate` inserts plan_items (one-by-one) | service role | 🧠 Knowledge Doc (plan items section) — cards animate in as Hyperspell GitHub returns |
| `/plan/generate` inserts generated_actions | service role | ⚡ Actions |
| `/actions/{id}/execute` updates external_url + status | service role | ⚡ Actions (button swaps to "Open in Linear ↗") |

Subscribe once on tab mount, unsubscribe on unmount.

---

## 9. Hyperspell Reprocessing (cron)

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

Idempotent because `/ingest/hyperspell` dedups on `(project_id, source, ref_url)`.

**Stretch (5th sponsor)**: replace this block with a Tensorlake job. Same function body, different runner.

---

## 10. Demo Script (90 seconds)

> **Yash (10s):** *"Project Brain. Engineering teams already have all the context they need — it's just scattered. Slack, docs, meetings, code. We turn that into an executable plan, live."*

> **(Page open. Inputs tab. Project Context section already shows Slack/Drive/Notion entries from this morning's Hyperspell ingest.)*

> **Yudong (5s) — clicks 🎙️ Join meeting:** *"Let me join a standup."*

> **Yudong (15s) — speaks:** *"Quick standup. The login flow is broken on Safari, we caught it in #bugs yesterday. Yash's design doc has us shipping CSV export this sprint, but the rate-limit middleware needs cleanup before we touch that."*

> **(Voice notes appear in Inputs ▸ Meetings as he speaks. Each tagged 🟢 decision / 🟡 blocker / 🔵 action_item.)*

> **Yash (5s) — switches to Knowledge Doc tab, clicks ✨ Generate plan:** *"Now we run the weekly plan agent."*

> **(~8s. Synthesis cards appear first — themes, decisions, blockers. Then plan items animate in one-by-one as Hyperspell GitHub is queried per item: Safari bug with `auth/redirect.ts`, CSV export, rate-limit cleanup with `middleware/rateLimit.ts`.)*

> **Jin (20s) — switches to Actions tab:** *"One bug, one feature, one maintenance — every one with the source it came from and the file it touches. Watch — "* (clicks **Execute** on Linear) *"that ticket just hit our real Linear board."* (clicks Devin) *"Devin gets the full context bundle to start working on it autonomously."*

> **Yash (10s):** *"Four sponsors stitched into one product — Hyperspell, OpenAI Realtime, Vercel, Devin — solving a problem every engineering team here has. Questions?"*

---

## 11. Risk Register

| Risk | Mitigation |
|---|---|
| OpenAI Realtime flaky on event Wi-Fi | Phone hotspot. Final fallback: prerecorded transcript replay. |
| Hyperspell sync incomplete by 9am | Ingested night before; fixture file fallback for `/ingest/hyperspell`. |
| Hyperspell GitHub returns shallow code_refs | Pre-stage 3 fixture snippets keyed to demo signals; merged in if Hyperspell returns < 1 hit. |
| Claude returns malformed JSON | Anthropic tool-use schema; Pydantic-validate; one retry. |
| Realtime drops a row | Each tab does initial `select` on mount, then layers inserts. |
| Anon-key INSERT denied by RLS | Test from clean browser at 11:30am. Policy `anon_insert_meeting_notes` must be applied. |
| Cron fires during demo | `scheduler.pause_job("hs_ingest")` at 5:55pm. |
| Realtime tool calling misbehaves | Set `tool_choice: "none"` and ship with static briefing only. Demo still works. |
| `/context/query` > 1s | Drop Hyperspell, use Postgres only (200ms). |
| Linear/GitHub action fails live | Pre-validate at 4pm. If still failing, show the polished draft (judges score draft quality). |
| Demo over 3 minutes | Yudong is the timer. Cut intro, not demo. |
| FastAPI not reachable from Vercel | ngrok stable URL baked into `NEXT_PUBLIC_FASTAPI_URL`. Test from Vercel preview at 5:00pm. |

---

## 12. Sponsor Coverage

- [x] **Hyperspell** — project_context ingestion + per-item codebase RAG. Track sponsor → $1k cash + 6mo unlimited + founders deploy session.
- [x] **OpenAI** — Realtime API for the voice agent.
- [x] **Vercel** — public deploy URL.
- [x] **Devin** — "Send to Devin" button visible in Actions tab.
- [ ] *Stretch:* **Tensorlake** — replace APScheduler with a Tensorlake job (5th sponsor).

---

## 13. Pre-Hackathon Checklist (tonight)

**Yash**
- [ ] Hyperspell account; OAuth Slack, Drive, Notion, Gmail, **and GitHub** (the GitHub connector is what powers per-item code_refs).
- [ ] Ingest seed corpus.
- [ ] Anthropic + OpenAI keys ready.
- [ ] Linear sandbox project + token.
- [ ] GitHub PAT.
- [ ] Devin form filled.
- [ ] ngrok subdomain reserved.
- [ ] Pair with Jin on `supabase/schema.sql` (§6) **including RLS policies**.

**Yudong**
- [ ] Standup script v1 (≤60s, 3 signals: bug + feature + maintenance).
- [ ] Seed corpus content drafted; handed to Yash.
- [ ] Test `getDisplayMedia + getUserMedia` in your browser (Chrome/Edge).

**Jin**
- [ ] Supabase project created.
- [ ] Schema + RLS applied (§6); pair with Yash.
- [ ] Realtime publication enabled on the 5 tables.
- [ ] Anon key → frontend `.env`. Service role key → Yash only.
- [ ] Vercel project linked to GitHub; deploy works.
- [ ] Confirm `anon_insert_meeting_notes` lets a browser INSERT.

**Shared**
- [ ] 1Password vault with all keys.
- [ ] Yudong prints demo script + brings phone hotspot.

---

## 14. One-line summary

> *Project Brain is a per-project pipeline: a voice agent and Hyperspell continuously feed meeting_notes and project_context into a weekly knowledge document, which Claude categorizes into bug fixes, new features, and maintenance — pulling codebase refs per item — and turns into one-click Linear, GitHub, or Devin actions.*
