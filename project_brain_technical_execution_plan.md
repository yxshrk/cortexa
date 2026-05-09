# Project Brain — Technical Execution Plan

> Nozomio Hackathon · May 9, 2026 · Entrepreneurs First, SF
> Track: **🧠 The Company Brain** (Hyperspell-led)
> Team: Yash · Jin · Yudong
> Submissions close 6:00pm · in-person judging 6:10pm (3 min each)

---

## 0. The Big Idea (30-second mental model)

The product centers on **one artifact per project**: a timestamped **weekly knowledge document**. Three writers append to it. One reader runs over it.

```
  WRITERS ─────────────────────────────────────►  ONE DOC ─►  READER
  ────────                                        ────────    ──────
  • Voice Agent (live meetings)            ┌──────────────┐
  • Hyperspell ingestion (Slack/Drive/    │  knowledge_  │   Claude
    Notion/GitHub) — manual + cron         │  entries     │   ──►
  • (optional: manual notes)               │  per project │   bugs /
                                           │  per week    │   features /
                                           └──────────────┘   improvements
                                                              │
                                                              ▼
                                                    Linear / PR / Devin drafts
```

That's the entire system.

---

## 1. Stack

| Layer | Tech | Sponsor | Owner |
|---|---|---|---|
| Static + code context | **Hyperspell** (Slack/Drive/Notion/GitHub) | ✅ track | Yash |
| Live meeting capture | **OpenAI Realtime API** (WebRTC) | ✅ | Yudong |
| Database + realtime | **Supabase** (Postgres + Realtime + RLS) | — | Jin (with Yash) |
| Frontend | **Next.js** (App Router) on **Vercel** | ✅ | Jin (page) + Yudong (voice agent) |
| Backend orchestration | **FastAPI** (Python) + APScheduler | — | Yash |
| Categorizer LLM | **Claude Sonnet 4.6** (Anthropic) | — | Yash |
| Voice summarizer | **GPT-4.1** (Next.js route handler) | — | Yudong |
| Executors | Linear · GitHub · **Devin** | ✅ Devin | Yash |

**Sponsors visible**: Hyperspell · OpenAI · Vercel · Devin = 4. *(Stretch: swap APScheduler → Tensorlake to add a 5th.)*

---

## 2. Architecture (one diagram, with role ownership)

```
┌─── BROWSER (Next.js on Vercel) ─────────────────────────────────────────┐
│                                                                          │
│   /projects ──► /projects/[id]                                           │
│                                                                          │
│   ┌─ Project page ────────────────────────────────────────────────────┐  │
│   │   Tabs:   📚 Knowledge  |  💡 Insights  |  ⚡ Actions               │  │
│   │   ──────────────────────────────────────────────────────────────  │  │
│   │                                                                    │  │
│   │   📚 Knowledge tab                                                 │  │
│   │     ┌─── <VoiceAgent /> ── YUDONG ─────────────────────────┐      │  │
│   │     │ • Briefing panel (from Yash's /context/briefing)     │      │  │
│   │     │ • mic + tab-audio mixer (getDisplayMedia + mic)      │      │  │
│   │     │ • WebRTC ◄────────► OpenAI Realtime                  │──────┼──► OpenAI
│   │     │ • POST /api/voice/summarize (Yudong's Next route)    │      │  │  Realtime
│   │     │ • INSERT knowledge_entries via supabase-js (anon)    │      │  │
│   │     └──────────────────────────────────────────────────────┘      │  │
│   │     <WeeklyDoc /> ── JIN ── auto-updates via realtime            │  │
│   │                                                                    │  │
│   │   💡 Insights tab  ── JIN ── cards from categorized_items         │  │
│   │   ⚡ Actions tab   ── JIN ── cards from generated_actions          │  │
│   │                                  + Execute button per card        │  │
│   └────────────────────────────────────────────────────────────────────┘  │
└──────────┬────────────────────────────────────────────┬──────────────────┘
           │ supabase-js (anon key)                     │ fetch HTTP
           │ • Jin: realtime SELECT subscriptions       │ • Yudong → /context/briefing,
           │   on knowledge_entries / categorized_items │              /rt/token
           │   / generated_actions                      │ • Jin    → /ingest/hyperspell,
           │ • Yudong: INSERT knowledge_entries         │              /categorize,
           │   (only)                                   │              /actions/{id}/execute
           ▼                                            ▼
┌──── SUPABASE ── JIN ─────┐         ┌──── FASTAPI ── YASH ─────────────────┐
│                          │         │                                       │
│  projects                │         │  GET  /context/briefing               │
│  meetings                │         │  POST /rt/token                       │
│  knowledge_entries       │◄────────┤  POST /ingest/hyperspell              │
│  categorized_items       │  py     │  POST /categorize                     │
│  generated_actions       │  client │  POST /actions/{id}/execute           │
│                          │ (svc)   │                                       │
│  realtime publication +  │         │  APScheduler:                         │
│  RLS policies (§6)       │         │    /ingest/hyperspell every 5min      │
│                          │         │                                       │
│                          │         │  External: Hyperspell · OpenAI ·      │
│                          │         │            Anthropic · Linear ·       │
│                          │         │            GitHub · Devin             │
└──────────────────────────┘         └───────────────────────────────────────┘
```

**Read this top to bottom**: browser at the top, two backends at the bottom (Supabase for state, FastAPI for orchestration). Two write paths into Supabase: Yudong from the browser via anon key (only on `knowledge_entries`); Yash from FastAPI via service-role key (any table). Reads are all realtime subscriptions from Jin's panels.

### 2.1 Dynamic context (live RAG during the meeting)

The briefing is fetched once at meeting start. While the meeting runs, the model itself can pull *more* context whenever it hears a topic worth looking up — using OpenAI Realtime's tool-calling.

```
   while meeting is running…

   transcript: "...rate-limit middleware needs cleanup..."
                            │
                            ▼
   OpenAI Realtime decides to use a tool
                            │
                            ▼
   data channel: response.function_call_arguments.done
       { name: "search_project_context",
         arguments: { query: "rate-limit middleware" } }
                            │
                            ▼
   Yudong's tool handler:
       POST {FASTAPI}/context/query
            { projectId, query, k: 6 }
                            │
                            ▼
   Yash's endpoint:
       • Postgres ILIKE on knowledge_entries (last 30d)
       • Hyperspell live search (all sources)
       • merge + dedupe + rank → top k
                            │
                            ▼
   Yudong returns to Realtime via conversation.item.create:
       { type: "function_call_output",
         output: <ContextItem[] serialized> }
                            │
                            ▼
   model resumes with grounded context. Yudong's summarizer
   downstream produces a sharper note like:
   "PR #42 is a half-done refactor of rate-limit middleware —
    overlaps with this discussion."
```

The model degrades gracefully: if `/context/query` fails or tool calling misbehaves, the agent still produces notes from the static briefing. The dynamic layer is additive.

---

## 3. The Three Roles

### 🎙️ Yudong — Voice Agent (fully self-contained)

You own the **entire** voice path. No round-trips to Yash's backend for writes. Yash's only contribution to your slice is `/rt/token` (mints OpenAI ephemeral tokens) and `/context/briefing` (assembles your briefing from sources he already has wired). Everything else lives in your frontend.

**Your slice**

```
On meeting start:
   GET  /context/briefing?projectId=X     ──► render Briefing panel
   POST /rt/token                          ──► WebRTC handshake with OpenAI Realtime
   captureMeetingAudio()                   ──► tab + mic mixed stream

While running:
   transcript deltas from Realtime data channel
       │
       ▼ (every ~20s, on speaker pause)
   POST /api/voice/summarize  (your own Next.js route handler)
       body: { transcript_chunk, briefing }
       → returns: [{ type, text, refs_to }]
       │
       ▼
   for each note:
     supabase.from("knowledge_entries").insert({...})  ─── anon key
       │
       ▼
   Supabase realtime broadcasts INSERT
       │
       ▼
   Jin's Knowledge tab re-renders with the new note (~200ms)
```

#### A. Joining meetings (3 patterns)

**A1 — Tab + mic mix (recommended).** `getDisplayMedia({audio:true})` captures any open Zoom/Meet/Teams tab; `getUserMedia({audio:true})` captures local mic; mix via Web Audio.

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

UI: button **🎙️ Join meeting** → OS share-screen prompt → user picks the meeting tab and ticks "Share tab audio" → agent is in the call.

**A2 — Mic only.** `getUserMedia` only. Use if A1 has permission issues on event Wi-Fi.

**A3 — Recall.ai bot.** Skip for today.

**Demo fallback**: pre-recorded standup audio played through laptop speakers + A2.

#### B. The briefing pattern (project context for the agent)

Before the meeting, fetch a briefing from Yash. Render it in the agent's left rail (proves grounding to judges). Pass it to your summarizer route as the system prompt.

```ts
// inside VoiceAgent.tsx
const briefing = await fetch(`${FASTAPI}/context/briefing?projectId=${pid}`).then(r=>r.json());
// renders as: themes, open threads, latest docs, active files, people
```

**Optional bias**: send `session.update` to Realtime so it transcribes project-specific terms accurately (filenames, acronyms):
```ts
dc.send(JSON.stringify({
  type: "session.update",
  session: {
    instructions: `Transcribing standup for ${name}. Themes: ${themes.join(", ")}. Files: ${files.join(", ")}.`,
    input_audio_transcription: { model: "gpt-realtime-whisper" },
  },
}));
```

#### C-bis. Live tool-calling (dynamic RAG, see §2.1)

The briefing alone is not enough — the agent should pull more context *as it hears things*. Configure the Realtime session with one tool:

```ts
const TOOLS = [{
  type: "function",
  name: "search_project_context",
  description: "Search this project's knowledge base for files, decisions, or threads relevant to a topic the team is discussing right now. Use whenever you hear a filename, person, feature, bug, or technical decision worth grounding.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "the topic, file, or person to look up" }
    },
    required: ["query"]
  }
}];

dc.send(JSON.stringify({
  type: "session.update",
  session: { instructions: BRIEFING_PROMPT, tools: TOOLS, tool_choice: "auto" }
}));
```

Tool handler in your component (one event listener on the data channel):

```ts
dc.addEventListener("message", async (e) => {
  const ev = JSON.parse(e.data);
  if (ev.type === "response.function_call_arguments.done"
      && ev.name === "search_project_context") {
    const { query } = JSON.parse(ev.arguments);

    const items = await fetch(`${FASTAPI}/context/query`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, query, k: 6 }),
    }).then(r => r.json()).catch(() => []);  // fail soft

    dc.send(JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: ev.call_id,
        output: JSON.stringify(items),
      },
    }));
    dc.send(JSON.stringify({ type: "response.create" }));
  }
});
```

The model will use the returned items in its next transcript output, which then flows to your summarizer with richer references. The summarizer prompt should mention: *"if the transcript references items you previously looked up, cite them in `refs_to`."*

This is the "agent searching your codebase as people talk" moment in the demo.

#### C. The summarizer route (Yudong owns this entirely)

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
      { role: "system", content: `You take meeting transcript chunks and emit 1-3 structured notes.
        Project context: ${briefing.project_summary}
        Recent themes: ${briefing.themes.join(", ")}
        Active files: ${briefing.active_files.map(f=>f.path).join(", ")}
        Each note: { type: "decision|action_item|blocker|mention|fyi", text, refs_to: [...] }` },
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
for (const note of notes) {
  await supabase.from("knowledge_entries").insert({
    project_id: pid, meeting_id: mid, source: "voice",
    author: "voice_agent", content: note.text, metadata: note,
  });
}
```

#### What you build

| File | Purpose |
|---|---|
| `frontend/lib/meetingAudio.ts` | tab + mic mixer |
| `frontend/lib/realtime.ts` | WebRTC handshake helper |
| `frontend/lib/voiceNoteSchema.ts` | shared JSON schema for the route |
| `frontend/app/api/voice/summarize/route.ts` | the summarizer endpoint |
| `frontend/components/VoiceAgent.tsx` | the component Jin mounts |
| `frontend/components/BriefingPanel.tsx` | the briefing display |
| `demo/standup_script.md` | 60-second standup script |

#### Milestones

- 11:00am — VoiceAgent skeleton: `/rt/token` + mic-only WebRTC; deltas in console.
- 12:30pm — Tab+mic mixer working; `/api/voice/summarize` route returns structured notes from a hardcoded chunk.
- 1:30pm — Briefing fetched and rendered; passed to summarizer.
- 2:30pm — Notes flowing end-to-end: mic → Realtime → summarizer → Supabase → Jin's Knowledge tab.
- 3:00pm — Live tool-calling working: model invokes `search_project_context`, your handler fetches Yash's `/context/query`, returns to model, summarizer note cites the fetched item.
- 5:00pm — Demo timed at ≤90s, run cleanly twice.

---

### 🗄️ Jin — Database & Frontend

Two artifacts: the Supabase schema/realtime config, and a tabbed Next.js app.

**Information architecture**

```
/projects                            (project list)
   │ click
   ▼
/projects/[id]                       (project page with tabs)
   │
   ├─ 📚 Knowledge tab
   │     • <VoiceAgent />  (mounted from Yudong's component)
   │     • <WeeklyDoc /> — list of knowledge_entries (last 7d, asc)
   │       grouped by day, with source-icon chips (🎙️ 💬 📄 🐙)
   │
   ├─ 💡 Insights tab
   │     Three sub-sections: Bugs / Features / Improvements
   │     Each card: title · description · source chips · code chips · next step
   │
   └─ ⚡ Actions tab
         Tabs within tabs (or filters): Linear / PR / Devin
         Each card has an "Execute" button → POST /actions/{id}/execute
         On success, status flips to executed and external link appears
```

**How updates propagate** (the demo magic)

Every write to Supabase triggers a `postgres_changes` event. Each tab subscribes to its own slice:

| Tab | Subscribes to | Triggered by |
|---|---|---|
| 📚 Knowledge | `knowledge_entries` (filter `project_id`) | Yudong's voice notes (anon INSERT), Yash's `/ingest/hyperspell` (svc INSERT, manual + 5min cron) |
| 💡 Insights | `categorized_items` | Yash's `/categorize` |
| ⚡ Actions   | `generated_actions` | Yash's `/categorize` (creates drafts) and `/actions/{id}/execute` (status update) |

You write zero polling code. Set up the channels once; React state flows from there.

**What you build**

| File | Purpose |
|---|---|
| `supabase/schema.sql` | source of truth; pre-day pair work with Yash |
| `supabase/migrations/*.sql` | mid-day diffs (Yash adds, you apply) |
| `frontend/app/projects/page.tsx` | project list |
| `frontend/app/projects/[id]/page.tsx` | tab shell (uses React state or `searchParams` for active tab) |
| `frontend/app/projects/[id]/_tabs/KnowledgeTab.tsx` | mounts `<VoiceAgent>` + `<WeeklyDoc>` |
| `frontend/app/projects/[id]/_tabs/InsightsTab.tsx` | reads `categorized_items` via realtime |
| `frontend/app/projects/[id]/_tabs/ActionsTab.tsx` | reads `generated_actions`, Execute button |
| `frontend/components/{WeeklyDoc, BugCard, FeatureCard, ImprovementCard, ActionCard}.tsx` | render primitives |
| `frontend/lib/supabase.ts` | client + helper subscriptions |
| `frontend/app/globals.css`, Tailwind config | styling |

**Header buttons** (live in the page header, present on all tabs):
- 🔄 **Refresh from Hyperspell** → `fetch(FASTAPI/ingest/hyperspell)` (Yash's endpoint)
- ✨ **Generate plan** → `fetch(FASTAPI/categorize)` (Yash's endpoint)

(The 🎙️ voice agent button lives **inside** the Knowledge tab, owned by Yudong's component.)

**Milestones**
- 10:30am — Supabase schema deployed; teammates have keys.
- 11:30am — `/projects` and `/projects/[id]` skeleton; tab switcher works; dummy rows render.
- 1:00pm — Knowledge tab shows live entries from realtime channel (Yudong's writes light it up).
- 3:00pm — Insights and Actions tabs render real data Yash's pipeline writes.
- 5:30pm — Polished, deployed Vercel URL works on laptop + phone.

---

### 🧠 Yash — Backend, Hyperspell, Categorizer, Executors

Heaviest role. Owns FastAPI surface, Hyperspell, Claude categorizer, executors, and the cron.

**Endpoints** (all in `backend/`)

| Method | Path | Caller | Purpose |
|---|---|---|---|
| POST | `/rt/token` | Yudong | mint OpenAI Realtime ephemeral token |
| GET  | `/context/briefing?projectId=X` | Yudong (once on meeting start) | assemble briefing from Hyperspell + last 7d entries |
| POST | `/context/query` | Yudong's tool handler (live during meeting) | merged Hyperspell + DB search; sub-1s latency |
| POST | `/ingest/hyperspell` | Jin button + 5min cron | search Hyperspell, INSERT into `knowledge_entries` (dedup by `ref_url`) |
| POST | `/categorize` | Jin button (also auto on meeting end) | Claude over weekly doc → INSERT `categorized_items` + `generated_actions` |
| POST | `/actions/{id}/execute` | Jin button | dispatch to Linear/GitHub/Devin, UPDATE `external_url`, `status` |

**Key implementation notes**

1. **`/context/briefing`** caches per `(projectId, day)` in process memory. Builds from:
   - last 7d of `knowledge_entries` for the project
   - latest 3 design docs from Hyperspell (filter `source=drive`)
   - latest 5 GitHub commits/PRs from Hyperspell (filter `source=github`)
   - cached 1-paragraph project summary (regenerated at most 1×/hour)

2. **`/ingest/hyperspell`** — the **dedupe key is `(project_id, source, ref_url)`** (unique index in §6). Re-running is safe.

3. **`/categorize`** — reads `knowledge_entries` for the project where `ts > now() - 7 days`. Builds working window prompt. Calls Claude with Anthropic tool-use schema. Inserts `categorized_items` + 3 `generated_actions` per item (Linear / PR / Devin drafts).

4. **APScheduler cron** in FastAPI startup:
   ```python
   from apscheduler.schedulers.asyncio import AsyncIOScheduler
   sched = AsyncIOScheduler()
   sched.add_job(lambda: ingest_all_projects(), "interval", minutes=5)
   sched.start()
   ```
   *(Stretch: replace this with a Tensorlake job to add Tensorlake as a 5th sponsor.)*

5. **No `/voice/append`** — Yudong writes voice notes directly to Supabase via the anon key. Yash never sees individual transcript chunks. Less coupling, fewer endpoints.

6. **`/context/query` (live RAG, called from Yudong's tool handler during the meeting)** —
   - Input: `{projectId, query, k?=6}`.
   - Postgres `ILIKE` search on `knowledge_entries.content` (last 30d, project-scoped) → top `k/2`.
   - Live `hyperspell.memories.search(query, sources=all, k=k/2)`.
   - Merge + dedupe by `ref_url`. Score-sort. Return as `ContextItem[]` (same shape as briefing items).
   - **Sub-1s latency target** — this fires during meetings; > 2s and the model gives up.
   - Cache same-query repeats for 60s in process memory to avoid hammering Hyperspell.

**Files**

```
backend/
  main.py                       # FastAPI app, CORS, scheduler startup
  routers/
    realtime.py                 # /rt/token
    context.py                  # /context/briefing
    ingest.py                   # /ingest/hyperspell
    categorize.py               # /categorize
    actions.py                  # /actions/{id}/execute
  services/
    hyperspell.py               # search wrapper
    briefing_builder.py         # cached briefing assembly
    categorizer.py              # Claude over weekly doc
    action_drafts.py            # ticket / PR / Devin draft generators
    executors/{linear,github,devin}.py
    supabase_writer.py          # supabase-py wrappers
  jobs/
    ingest_cron.py              # APScheduler job
  schemas.py                    # Pydantic models
  settings.py                   # env vars
```

**Milestones**
- Night before: Hyperspell connectors live + corpus ingested + verified search returns expected items.
- 11:00am: FastAPI running, `/rt/token` + `/context/briefing` return real data.
- 1:00pm: `/ingest/hyperspell` works; Jin's Knowledge tab populates.
- 2:00pm: `/context/query` returns merged results in <1s — test with curl using a few sample queries.
- 3:00pm: `/categorize` returns valid Claude output; Insights + Actions tabs populate.
- 4:00pm: APScheduler cron live; verify `/ingest/hyperspell` re-runs every 5 min.
- 5:00pm: `/actions/{id}/execute` creates real Linear tickets.

---

## 3.5 Conflict Map & Ownership Rules

### Hard "never touches"

| Person | Never touches |
|---|---|
| **Yash**   | Frontend code. The schema SQL file directly (submits migrations only). |
| **Jin**    | Backend Python. Voice agent components or its helpers. |
| **Yudong** | Backend Python. Schema SQL. Page chrome, global styling, the three tabs. |

### File ownership (one path → one owner)

| Path | Owner |
|---|---|
| `backend/**` | Yash |
| `frontend/app/{projects,layout}**`, `frontend/app/projects/[id]/_tabs/**` | Jin |
| `frontend/components/{WeeklyDoc,BugCard,FeatureCard,ImprovementCard,ActionCard}.tsx`, `frontend/lib/supabase.ts`, Tailwind config, `globals.css` | Jin |
| `frontend/components/{VoiceAgent,BriefingPanel}.tsx`, `frontend/lib/{realtime,meetingAudio,voiceNoteSchema}.ts`, `frontend/app/api/voice/**` | Yudong |
| `supabase/schema.sql` | Jin (canonical) |
| `supabase/migrations/*.sql` | Yash adds, Jin reviews + applies |
| `demo/**` | Yudong |

### Schema change workflow

1. Pre-day: Yash + Jin pair on `supabase/schema.sql`. Apply it. **Frozen at 9:30am sync.**
2. Mid-day: Yash needs a new column → writes `supabase/migrations/000N_<thing>.sql` → pings Jin → Jin applies via Supabase SQL editor.
3. **No silent edits** to `schema.sql` after 9:30am.

### Component contract (Jin ↔ Yudong)

```tsx
// frontend/components/VoiceAgent.tsx — Yudong owns
export function VoiceAgent({ projectId, meetingId }: { projectId: string; meetingId: string }) {...}
```

Jin mounts it once inside the Knowledge tab. **No callbacks back into the page** — agent communicates by writing to Supabase; Jin's tab sees changes via realtime.

### Supabase write rules

- **Anon key** (frontend): `INSERT` allowed on `knowledge_entries` only (Yudong). `SELECT` allowed on all reactive tables (Jin's subscriptions). Everything else denied. RLS policies in §6.
- **Service role key** (Yash's backend): full access. Bypasses RLS.
- Frontend never uses the service key. Backend never uses the anon key.

### Realtime subscription rule

**Only Jin subscribes to Supabase.** Yudong's component never opens a channel — he relies on the response of his own `INSERT` for confirmation.

### Communication triggers

| Trigger | Who pings whom |
|---|---|
| Schema change needed | Yash → Jin |
| Briefing schema needs a new field | Yudong → Yash |
| `/context/query` response shape needs adjustment | Yudong → Yash |
| `/context/query` is slower than 1s | Yash → Yudong (decide: lower `k`, drop a source, or cache more aggressively) |
| Hyperspell isn't returning expected items | Yash → Yudong (corpus may need adjustment) |
| Voice notes come out generic | Yudong tunes his summarizer prompt; loops Yash in only if it's a briefing data issue |
| Vercel env var missing | Jin → Yash |
| FastAPI URL changes (ngrok restart) | Yash → Jin (update Vercel env) |

Anything else: don't interrupt; Slack message; keep building.

---

## 4. Build Order

```
8:00 AM   Doors. Breakfast.
          NIGHT-BEFORE WORK MUST BE DONE:
            • Yash: Hyperspell connectors live + corpus ingested
            • Yudong: standup script v1 + corpus content drafted
            • Jin: Supabase project + schema deployed + Vercel project linked

9:15 AM   Hacking starts.
          [ALL] 30-min sync. Whiteboard the contracts (§5). Distribute keys.

9:45 AM   PARALLEL ─────────────────────────────────────────────────────
          Yash:   FastAPI scaffold; /rt/token + /context/briefing.
          Yudong: VoiceAgent skeleton — gets ephemeral token, mic-only.
                  Stub /api/voice/summarize returning fake notes.
          Jin:    Next.js scaffold; supabase-js wired; /projects list +
                  /projects/[id] tab shell rendering dummy rows.

11:00 AM  CHECKPOINT
          • Yudong: WebRTC session opens, deltas in console.
          • Jin:    tabs switch, all three render dummy data.
          • Yash:   /context/briefing returns a real briefing.

11:00 AM  PARALLEL ─────────────────────────────────────────────────────
          Yash:   /ingest/hyperspell against real Hyperspell.
          Yudong: tab+mic mixer; real /api/voice/summarize using briefing.
          Jin:    Knowledge tab subscribes to realtime; live transcript flows.

12:00     Hyperspell speaker session — Yash attends.
12:30     Lunch.

1:30 PM   CHECKPOINT
          • Voice notes: mic → summarizer → Supabase → Knowledge tab. ✓
          • Hyperspell ingestion populates Knowledge tab on button click. ✓

1:30 PM   PARALLEL ─────────────────────────────────────────────────────
          Yash:   /categorize end-to-end. Action drafts. Executors.
                  APScheduler cron added.
          Yudong: rehearse standup; tune summarizer prompt.
          Jin:    Insights + Actions tabs reactive. Animations, toasts,
                  error states.

3:00 PM   Speaker session — Yudong attends.
3:30 PM   CHECKPOINT — END-TO-END WORKING. Lock no new features.

3:30 PM   POLISH
          Yash:   prompt tuning; verify cron isn't spamming Slack;
                  optional Tensorlake swap.
          Yudong: rehearsal lead.
          Jin:    visual polish; mobile-safe; deploy to Vercel.

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
→ 200 OK   { "client_secret": { "value": "ek_..." }, ... }
```

### 5.2 `/context/briefing` (Yudong → Yash)

```http
GET {FASTAPI}/context/briefing?projectId=<uuid>
→ 200 OK
{
  "id": "<briefing_uuid>",
  "project_summary": "string",
  "themes":         ["string"],
  "recent_decisions": [{ "summary": "...", "ts": "...", "ref_url": "..." }],
  "open_threads":     [{ "source": "slack|notion", "label": "...", "count": 6 }],
  "latest_docs":      [{ "title": "...", "url": "...", "ts": "..." }],
  "active_files":     [{ "path": "...", "last_touched": "..." }],
  "people":           ["yash", "jin", "yudong"]
}
```

### 5.3 `/api/voice/summarize` (Yudong's own route)

```http
POST /api/voice/summarize
{ "transcript_chunk": "string", "briefing": <briefing-object> }
→ 200 OK   [
  { "type": "decision|action_item|blocker|mention|fyi",
    "text": "string ≤300 chars",
    "refs_to": ["string"] }
]
```

### 5.4 Supabase writes (Yudong)

```ts
await supabase.from("knowledge_entries").insert({
  project_id, meeting_id, source: "voice", author: "voice_agent",
  content: note.text, metadata: note,
});
```

### 5.5 `/ingest/hyperspell` (Jin button + cron → Yash)

```http
POST {FASTAPI}/ingest/hyperspell    { "projectId": "<uuid>" }
→ 200 OK   { "inserted": 14, "skipped_dupes": 22 }
```

### 5.6 `/categorize` (Jin → Yash)

```http
POST {FASTAPI}/categorize    { "projectId": "<uuid>" }
→ 202 Accepted   { "items": 5 }
```

### 5.7 `/actions/{id}/execute` (Jin → Yash)

```http
POST {FASTAPI}/actions/{actionId}/execute
→ 200 OK   { "externalUrl": "https://linear.app/.../ABC-42" }
```

### 5.8 `/context/query` (Yudong's Realtime tool handler → Yash)

Called **during** the meeting, on demand from the model. Sub-1s latency required.

```http
POST {FASTAPI}/context/query
{ "projectId": "<uuid>", "query": "string", "k": 6 }

→ 200 OK
[
  {
    "source": "voice|slack|drive|notion|github|gmail",
    "title": "string",
    "snippet": "string ≤200",
    "url": "string|null",
    "ts": "string|null",
    "score": 0.0,
    "code_path": "string|null",
    "code_lines": "string|null"
  }
]
```

Yudong's handler returns this array as a `function_call_output` to OpenAI Realtime via the data channel. The model uses it in subsequent transcript output.

---

## 6. Supabase Schema + RLS

### Schema

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

create type entry_source as enum ('voice','slack','drive','notion','github','gmail');
create table knowledge_entries (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  meeting_id uuid references meetings(id) on delete set null,
  source entry_source not null,
  author text,
  content text not null,
  ref_url text,
  code_path text,
  code_lines text,
  metadata jsonb,
  ts timestamptz default now()
);
create unique index on knowledge_entries (project_id, source, ref_url) where ref_url is not null;
create index on knowledge_entries (project_id, ts desc);

create type item_category as enum ('bug','feature','improvement');
create table categorized_items (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  category item_category not null,
  title text not null,
  description text,
  source_refs jsonb default '[]',
  code_refs jsonb default '[]',
  next_step text,
  confidence numeric,
  generated_at timestamptz default now()
);
create index on categorized_items (project_id, generated_at desc);

create type action_type   as enum ('linear_ticket','github_pr','devin_handoff');
create type action_status as enum ('draft','executing','executed','failed');
create table generated_actions (
  id uuid primary key default uuid_generate_v4(),
  categorized_item_id uuid references categorized_items(id) on delete cascade,
  action_type action_type not null,
  payload jsonb,
  status action_status default 'draft',
  external_url text,
  created_at timestamptz default now()
);
create index on generated_actions (categorized_item_id);
```

### Realtime publication

Enable `supabase_realtime` for: `knowledge_entries`, `categorized_items`, `generated_actions`.

### RLS policies (locked-down anon, full service)

```sql
alter table knowledge_entries enable row level security;
alter table categorized_items enable row level security;
alter table generated_actions enable row level security;
alter table projects          enable row level security;
alter table meetings          enable row level security;

-- anon can read everything (for Jin's subscriptions)
create policy anon_read_all_kn on knowledge_entries  for select to anon using (true);
create policy anon_read_all_ci on categorized_items  for select to anon using (true);
create policy anon_read_all_ga on generated_actions  for select to anon using (true);
create policy anon_read_all_p  on projects           for select to anon using (true);
create policy anon_read_all_m  on meetings           for select to anon using (true);

-- anon can INSERT only into knowledge_entries with source='voice' (Yudong's voice agent)
create policy anon_insert_voice on knowledge_entries
  for insert to anon
  with check (source = 'voice');

-- service role bypasses RLS automatically (Yash's backend)
```

### Frontend subscription (Jin)

```ts
supabase.channel(`kn:${projectId}`)
  .on("postgres_changes",
    { event: "INSERT", schema: "public", table: "knowledge_entries",
      filter: `project_id=eq.${projectId}` },
    (p) => append(p.new))
  .subscribe();
```

### Backend write (Yash)

```python
sb.table("categorized_items").insert({...}).execute()  # service role; bypasses RLS
```

### Frontend INSERT (Yudong)

```ts
await supabase.from("knowledge_entries").insert({
  project_id, meeting_id, source: "voice", author: "voice_agent", content, metadata,
});
```

---

## 7. Categorizer Output Schema (frozen)

```json
{ "bugFixes": [Item], "newFeatures": [Item], "improvements": [Item] }

Item = {
  "title": "string ≤80 chars",
  "description": "string ≤400 chars",
  "sourceRefs": [{ "source": "voice|slack|drive|notion|github|gmail",
                   "url": "string|null", "snippet": "string ≤200" }],
  "codeRefs":   [{ "path": "string", "lines": "string", "snippet": "string ≤200" }],
  "nextStep": "string ≤200",
  "confidence": 0.0
}
```

Used as Claude's tool-use schema. Frontend renders directly.

---

## 8. Realtime Update Flow (the demo magic, end-to-end)

```
                    INSERT or UPDATE on Supabase
                              │
                              ▼
              Postgres logical replication captures it
                              │
                              ▼
              Supabase Realtime broadcasts postgres_changes
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
  Jin's Knowledge       Jin's Insights        Jin's Actions
  tab subscription      tab subscription      tab subscription
        │                     │                     │
        ▼                     ▼                     ▼
  React state              React state           React state
  updates → re-render        updates               updates
```

**Concrete examples**

- Yudong inserts a voice note: ~200ms later it appears in Knowledge tab.
- Yash's cron runs `/ingest/hyperspell`: new Slack/Drive entries appear in Knowledge tab silently every 5 min.
- Jin clicks ✨ Generate plan → Yash's `/categorize` writes → Insights tab populates with cards animating in; Actions tab simultaneously populates with Linear/PR/Devin drafts.
- Jin clicks Execute on a Linear card → Yash's executor creates the ticket and updates the row → Actions tab swaps the button for the external link.

No polling anywhere. No manual refresh. Subscribe once on tab mount, unsubscribe on unmount.

---

## 9. Hyperspell Reprocessing (cron)

**Why**: connector data drifts (new Slack messages, edited docs). The weekly doc has to stay fresh without human intervention.

**Implementation** (in FastAPI startup):

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

```python
# backend/jobs/ingest_cron.py
async def ingest_all_projects():
    projects = await sb.table("projects").select("*").execute()
    for p in projects.data:
        try:
            await ingest_hyperspell(p["id"])  # same path as the manual button
        except Exception as e:
            log.exception(f"hs_ingest failed for {p['id']}: {e}")
```

Idempotent because `/ingest/hyperspell` dedups on `(project_id, source, ref_url)` — re-running is safe and cheap.

**Stretch (5th sponsor)**: replace the APScheduler block with a Tensorlake job. Same function body, different scheduler. The Tensorlake docs walk through this in ~20 min. Worth doing only after 4pm — it's a sponsor logo, not a feature.

---

## 10. Demo Script (90 seconds)

> **Yash (10s):** *"This is Project Brain. Engineering teams already have all the context they need — it's just scattered. Slack, docs, meetings, code. We turn that into an executable plan, live."*

> **(Page open. Knowledge tab. Weekly doc already shows ~5 entries from Hyperspell.)*

> **Yudong (5s) — clicks 🎙️ Join meeting:** *"Watch — I'll join a standup."*

> **Yudong (15s) — speaks into mic:** *"Quick standup. The login flow is broken on Safari, we caught it in #bugs yesterday. Yash's design doc has us shipping CSV export this sprint, but the rate-limit middleware needs cleanup before we touch that."*

> **(Voice notes appear in Knowledge tab with 🎙️ icon as he speaks.)*

> **Yash (5s) — switches to Insights tab, clicks ✨ Generate plan:** *"Now we run Claude over the whole weekly doc."*

> **(~5s. Cards animate into Insights tab: Safari bug, CSV export, rate-limit cleanup.)*

> **Jin (20s) — switches to Actions tab:** *"One bug, one feature, one improvement — every one with the source it came from and the file it touches. Watch — "* (clicks **Create in Linear**) *"that ticket just hit our real Linear board."* (clicks **Send to Devin**) *"Devin gets the full context bundle to start working on it autonomously."*

> **Yash (10s):** *"Four sponsors stitched into one product — Hyperspell, OpenAI Realtime, Vercel, Devin — solving a problem every engineering team here has. Questions?"*

---

## 11. Risk Register & Fallbacks

| Risk | Mitigation |
|---|---|
| OpenAI Realtime flaky on event Wi-Fi | Phone hotspot. Final fallback: prerecorded transcript replay script. |
| Hyperspell sync incomplete by 9am | Ingested night before; fallback fixture file feeds `/ingest/hyperspell`. |
| Hyperspell GitHub doesn't return code-level snippets | Pre-stage 3 code-snippet fixtures keyed to demo signals. |
| Claude returns malformed JSON | Anthropic tool-use schema; Pydantic-validate; one retry. |
| Supabase realtime drops a row | Each tab does initial `select` on mount, then layers inserts. Refresh fixes any miss. |
| Linear / GitHub action fails live | Pre-create projects + tokens validated at 4pm. Skip live execution → show the polished draft. |
| Anon-key INSERT denied by RLS | Test from a clean browser at 11:30am. The `anon_insert_voice` policy must be applied. |
| Cron job fires during demo and creates noise | Disable `hs_ingest` job at 5:55pm: `scheduler.pause_job("hs_ingest")`. |
| Realtime tool calling misbehaves (model never calls; or call hangs) | Static briefing alone still produces good notes. If tools are clearly broken at 4pm, set `tool_choice: "none"` and ship without dynamic RAG. The plan still demos cleanly. |
| `/context/query` > 1s | Cache same-query for 60s; reduce `k`; drop the Hyperspell call and rely on Postgres-only as a 200ms fallback. |
| Demo over 3 minutes | Yudong is the timer. Cut intro, not demo. |
| FastAPI not reachable from Vercel | ngrok stable URL baked into `NEXT_PUBLIC_FASTAPI_URL`. Test from Vercel preview at 5:00pm. |

---

## 12. Sponsor Coverage

- [x] **Hyperspell** — sole context layer. Track sponsor → $1k cash + 6mo unlimited + founders deploy session.
- [x] **OpenAI** — Realtime API for the voice agent. Mention `gpt-realtime-whisper`.
- [x] **Vercel** — public deploy URL.
- [x] **Devin** — "Send to Devin" button visible in Actions tab.
- [ ] *Stretch:* **Tensorlake** — replace APScheduler with a Tensorlake job (5th sponsor).

---

## 13. Pre-Hackathon Checklist (tonight)

**Yash**
- [ ] Hyperspell account; OAuth Slack, Drive, Notion, GitHub.
- [ ] Ingest Yudong's seed corpus.
- [ ] Verify search returns expected items.
- [ ] Anthropic + OpenAI keys ready.
- [ ] Linear sandbox project + API token.
- [ ] GitHub PAT scoped to demo repo.
- [ ] Devin form filled.
- [ ] ngrok installed; reserve subdomain if possible.
- [ ] Pair with Jin on `supabase/schema.sql` (§6) **including the RLS policies**.

**Yudong**
- [ ] Standup script v1 (≤60s, hits 3 signals: bug + feature + improvement).
- [ ] Seed corpus content drafted; handed to Yash.
- [ ] Test `getDisplayMedia + getUserMedia` in your browser (Chrome/Edge required for tab audio).

**Jin**
- [ ] Supabase project created.
- [ ] Schema + RLS applied (§6); pair with Yash.
- [ ] Realtime publication enabled on the 3 reactive tables.
- [ ] Anon key → frontend `.env`. Service role key → Yash only.
- [ ] Vercel project linked to GitHub; deploy works.
- [ ] Confirm RLS policy `anon_insert_voice` lets a browser INSERT a voice entry.

**Shared**
- [ ] 1Password vault with all keys.
- [ ] Yudong prints the demo script + brings phone hotspot.

---

## 14. One-line summary for the judges

> *Project Brain keeps a per-project weekly knowledge document. A voice agent listens to your meetings — and pulls relevant Hyperspell context live as people talk — while a 5-minute cron keeps Slack/docs/code in sync. Claude turns the doc into bug fixes, features, and improvements you can ship straight to Linear, GitHub, or Devin.*
