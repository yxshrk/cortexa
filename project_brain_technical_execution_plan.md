# Project Brain — Technical Execution Plan

> Nozomio Hackathon · May 9, 2026 · Entrepreneurs First, SF
> Track: **🧠 The Company Brain** (Hyperspell-led)
> Team: Yash · Jin · Yudong
> Submissions close 6:00pm · in-person judging 6:10pm (3 min each)

---

## 0. The Big Idea (30-second mental model)

The product centers on **one artifact**: a per-project, **timestamped weekly knowledge document**. Three things write to it. One thing reads from it.

```
                        WRITE → ─┐
   ┌─────────────────────────┐   │
   │ Voice agent joins        │   │
   │ meetings → notes         │   │      ┌────────────────────────────┐
   └─────────────────────────┘   ├────► │  WEEKLY KNOWLEDGE DOC      │
                                 │      │  (timestamped log,         │
   ┌─────────────────────────┐   │      │   one per project)         │
   │ Hyperspell pulls Slack/  │   │      │                            │
   │ Drive/Notion/GitHub     │  ─┤      └──────────────┬─────────────┘
   └─────────────────────────┘                         │
                                                       │ READ
                                                       ▼
                                       ┌────────────────────────────┐
                                       │  Categorizer (Claude)      │
                                       │  → bugs / features /       │
                                       │    improvements            │
                                       │  → executable drafts       │
                                       │    (Linear / PR / Devin)   │
                                       └────────────────────────────┘
```

That is the entire system. Everything below is how each of us builds our slice.

---

## 1. Stack

| Layer | Tech | Sponsor | Owner |
|---|---|---|---|
| Static + code context | **Hyperspell** (Slack / Drive / Notion / GitHub) | ✅ track | Yash |
| Live meeting capture | **OpenAI Realtime API** (WebRTC) | ✅ | Yudong |
| Database + realtime | **Supabase** (Postgres + Realtime + Auth) | — | Jin (with Yash) |
| Frontend | **Next.js (App Router)** on **Vercel** | ✅ | Jin |
| Backend orchestration | **FastAPI** (Python) | — | Yash |
| Categorizer LLM | **Claude Sonnet 4.6** (Anthropic) | — | Yash |
| Executors | Linear · GitHub · **Devin** | ✅ Devin | Yash |

**Sponsors visible in the demo**: Hyperspell · OpenAI · Vercel · Devin = 4 (Supabase is not a sponsor — chosen for velocity over Convex).

---

## 2. Architecture (with role ownership)

```
┌────────────────────────── BROWSER (Vercel) ──────────────────────────┐
│                                                                       │
│   ┌────────────────────────┐   ┌──────────────────────────────────┐  │
│   │  Voice Agent component │   │  3-panel project page            │  │
│   │  (mic, WebRTC client)  │   │  • Weekly Knowledge Doc (left)   │  │
│   │     ─── YUDONG ───      │   │  • Categorized Plan (middle)     │  │
│   └──────────┬─────────────┘   │  • Generated Actions (right)     │  │
│              │                 │     ─── JIN ───                  │  │
│              │                 └──────────────────┬───────────────┘  │
└──────────────┼────────────────────────────────────┼──────────────────┘
               │ WebRTC (audio + DC)                │ Supabase realtime
               ▼                                    ▼
   ┌──────────────────────┐                 ┌─────────────────────────┐
   │   OpenAI Realtime    │                 │   Supabase              │
   │   gpt-realtime-      │                 │   • knowledge_entries   │
   │   whisper            │                 │   • categorized_items   │
   │     ─── YUDONG ───    │                 │   • generated_actions   │
   └──────────────────────┘                 │      ─── JIN (+Yash) ───  │
               │                            └─────────────▲───────────┘
               │ transcript deltas                        │
               ▼                                          │
   ┌─────────────────────────────────────────────────────┴──────────┐
   │                FastAPI ─── YASH ───                             │
   │                                                                 │
   │   POST /voice/append          ◄── Yudong (per chunk)            │
   │       └─► insert knowledge_entries (source='voice')             │
   │                                                                 │
   │   POST /ingest/hyperspell     ◄── Jin button or scheduled       │
   │       └─► hyperspell.search → insert knowledge_entries          │
   │                                                                 │
   │   POST /categorize            ◄── Jin button                    │
   │       └─► Claude over weekly doc → insert categorized_items     │
   │              and generated_actions                              │
   │                                                                 │
   │   POST /actions/{id}/execute  ◄── Jin button                    │
   │       └─► Linear / GitHub / Devin → update external_url         │
   │                                                                 │
   │   POST /rt/token              ◄── Yudong's voice agent          │
   │       └─► mint OpenAI ephemeral token                           │
   └─────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼─────────────────┐
              ▼               ▼                 ▼
     ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐
     │  Hyperspell  │  │   Claude     │  │  Linear API     │
     │  Slack/Drive │  │  Sonnet 4.6  │  │  GitHub API     │
     │  Notion/GH   │  │              │  │  Devin API      │
     └──────────────┘  └──────────────┘  └─────────────────┘
```

The dotted boundaries are role ownership. Anything inside a person's box is theirs. Anything across a boundary is a contract (§5).

---

## 3. The Three Roles

### 🎙️ Yudong — Voice Agent

**Your slice of the flow**

```
   Meeting audio                         Project briefing
   (tab + mic mixed)                     (last week + latest docs)
        │                                       │
        ▼                                       ▼
   ┌──────────────────────────────┐    GET /context/briefing
   │  VoiceAgent.tsx              │◄────── (Yash's endpoint)
   │  • captures audio            │
   │  • shows briefing on screen  │
   │  • opens WebRTC to Realtime  │
   └──────────────┬───────────────┘
                  │ WebRTC
                  ▼
         OpenAI Realtime (gpt-realtime-whisper)
                  │ transcript deltas
                  ▼
         buffer ~20s → POST /voice/append { ..., briefing_id }
                  │
                  ▼ (Yash's summarizer uses briefing as system prompt)
         knowledge_entries (source='voice', structured)
                  │
                  ▼
         Jin's UI lights up
```

**Two things to nail**

A. **The agent has to *join* the meeting** — not just listen to a single mic.
B. **The agent has to be grounded in the project** — so notes come out structured and project-aware, not generic.

#### A. How the agent joins meetings

Three patterns, easiest first. Pick A1 for the demo; A2 is your fallback.

**A1 — Tab audio + mic mix (recommended).** Browser captures the audio of any open meeting tab (Zoom Web, Google Meet, Teams Web) plus the local mic, mixes them, and pipes one combined stream into the WebRTC peer connection. No external dependencies. Demo-legible: "I have a Meet tab open, the agent is in the call."

```ts
// frontend/lib/meetingAudio.ts
export async function captureMeetingAudio(): Promise<MediaStream> {
  // 1) capture the meeting tab's audio (Zoom Web / Google Meet / Teams Web)
  //    browser prompts user to pick a tab + tick "Share tab audio"
  const tab = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: false,
  });
  // 2) capture local mic
  const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
  // 3) mix both into one stream via Web Audio
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  ctx.createMediaStreamSource(tab).connect(dest);
  ctx.createMediaStreamSource(mic).connect(dest);
  return dest.stream; // pipe into RTCPeerConnection.addTrack()
}
```

UI flow: button reads **🎙️ Join meeting** → click triggers the OS share-screen prompt → user picks their Meet/Zoom tab and ticks *"Share tab audio"* → the agent is now hearing both sides of the call.

**A2 — Mic only (fallback).** Just `getUserMedia({ audio: true })`. Works if the meeting is in person, on speakerphone, or if A1's permissions get weird on event Wi-Fi.

**A3 — Recall.ai bot (skip for today).** A real meeting bot that joins Zoom/Meet/Teams as a participant via Recall's API. ~30 min wiring; only worth it if A1 and A2 both fail. Not a Nozomio sponsor — adds dependency without prize value.

**Demo-day fallback**: pre-recorded standup audio played through laptop speakers; agent runs A2 against the local mic.

#### B. Pulling project context (the briefing pattern)

The Realtime API itself just transcribes — it doesn't know your project. To produce a *structured, project-aware document* from the meeting, the agent fetches a **briefing** before the meeting starts and passes the briefing's id with every transcript chunk so Yash's summarizer uses it as the system prompt.

```
on mount:
   GET /context/briefing?projectId=X   ── Yash assembles this from:
                                         • last 7 days of knowledge_entries
                                         • Hyperspell: latest 3 design docs
                                         • Hyperspell: latest 5 GitHub commits
                                         • cached 1-paragraph project summary

   response: {
     id, project_summary,
     recent_decisions[], open_threads[],
     latest_docs[], active_files[], people[]
   }

every chunk:
   POST /voice/append { projectId, meetingId, raw_transcript,
                        briefing_id, ts }
   └─► Yash's summarizer uses briefing_id as system prompt
       → returns structured notes:
         { type: "decision|action_item|blocker|mention|fyi",
           text, refs_to: [files|people|threads from briefing] }
       → inserted into knowledge_entries
```

What you render in the agent's left rail during the meeting (proves to judges that the agent is grounded):

```
📋 Briefing loaded — 14 sources

Last week's themes
  • Safari login regression
  • CSV export v2 design review
  • Rate-limit middleware refactor

Open threads
  • Slack #bugs · 6 messages
  • Notion: Q2 plan — 3 overdue items

Active files (last 7d)
  • src/auth/redirect.ts
  • src/middleware/rateLimit.ts

People
  • yash, jin, yudong
```

**Why this is the right shape**: the briefing is generated server-side from sources Yash already has wired (Hyperspell + knowledge_entries). You don't have to do any retrieval yourself. You just GET the briefing and pass its id along — the smarts live in Yash's prompt.

**Optional: bias the Realtime session itself.** If you have time, send a `session.update` event over the WebRTC data channel after connect, with `instructions` set to a short version of the briefing. This makes the Realtime model's transcription bias toward project terms (e.g. recognize *"rate-limit middleware"* as one phrase, your filenames spelled correctly). Code:
```ts
dc.send(JSON.stringify({
  type: "session.update",
  session: {
    instructions: `You are transcribing a standup for project ${name}.
    Recent themes: ${themes.join(", ")}. Active files: ${files.join(", ")}.`,
    input_audio_transcription: { model: "gpt-realtime-whisper" },
  },
}));
```

#### What you build (final task list)

1. **`frontend/lib/meetingAudio.ts`** — the tab+mic mixer (A1).
2. **`frontend/lib/realtime.ts`** — WebRTC handshake helper.
3. **`frontend/components/VoiceAgent.tsx`** — the agent UI:
   - On mount: `GET /context/briefing?projectId=X` → renders briefing panel.
   - On **🎙️ Join meeting** click: `captureMeetingAudio()` → opens WebRTC with `/rt/token` → optionally sends `session.update` with briefing themes.
   - Buffers transcript deltas; every 20s POSTs `/voice/append` with `{ projectId, meetingId, raw_transcript, briefing_id, ts }`.
   - On **■ End meeting**: flush buffer, close peer connection.
4. **`frontend/components/BriefingPanel.tsx`** — small component rendering the briefing.
5. **`demo/standup_script.md`** — the 60-second standup script.
6. **(Bonus, only if done by 4pm)** `frontend/components/MeetingCanvas.tsx` — extract entities from each note, render as nodes on a canvas. Skip if time-constrained.

#### Milestones

- 11:00am — VoiceAgent skeleton: `/rt/token` + mic-only WebRTC. Deltas in console.
- 12:30pm — Tab-audio capture working (`getDisplayMedia` + mic mixed via Web Audio).
- 1:30pm — `/context/briefing` integrated; briefing panel renders real items from Yash's endpoint.
- 2:30pm — Chunks flushing to `/voice/append` with `briefing_id`; structured voice notes appear in Jin's Weekly Doc panel.
- 4:00pm — Optional `session.update` bias landed (or skipped).
- 5:00pm — Demo timed at ≤90s, run cleanly twice.

#### Files you own

- `frontend/lib/meetingAudio.ts`, `frontend/lib/realtime.ts`
- `frontend/components/VoiceAgent.tsx`, `frontend/components/BriefingPanel.tsx`
- `demo/standup_script.md`

---

### 🗄️ Jin — Database & Frontend

**Your slice of the flow**

```
Yash's FastAPI ──supabase-py──► Supabase Postgres ──realtime──► Next.js UI
                                       ▲                              │
                                       │ Yudong's voice agent         │
                                       │ (via Yash's /voice/append)   │
                                       └──────────────────────────────┘
                                                                      │
                                                                      ▼
                                                       Three reactive panels
```

**What you build**

1. **Supabase project** (§7 has the SQL). Create the project, run schema, enable Realtime on the three reactive tables, disable RLS for the day. Hand keys out:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` → goes in Vercel env + your `.env.local`.
   - `SUPABASE_SERVICE_ROLE_KEY` → hand to Yash only (his backend bypasses RLS with this).

2. **Next.js page at `/project/[id]`** with three panels:

   | Panel | Subscribes to | Renders |
   |---|---|---|
   | Left — **Weekly Doc** | `knowledge_entries` for project, last 7 days, ordered asc | Source chip · author · timestamp · content. Auto-scrolls. New entries fade in. |
   | Middle — **Categorized Plan** | `categorized_items` for project | Three sub-sections (Bugs / Features / Improvements). Each card: title, description, source chips, code chips, "next step", confidence pill. |
   | Right — **Generated Actions** | `generated_actions` joined to `categorized_items` | Tabs for Linear / PR / Devin. Each card has an "Execute" button → calls `POST /actions/{id}/execute`. On success, status flips to `executed` and an external link appears. |

3. **Header buttons**:
   - 🎙️ **Voice agent** → mounts Yudong's `VoiceAgent` component.
   - 🔄 **Pull from Hyperspell** → `fetch(FASTAPI/ingest/hyperspell, ...)` (Yash's endpoint).
   - ✨ **Generate plan** → `fetch(FASTAPI/categorize, ...)`.

4. **Vercel deploy** with all env vars. Public URL is mandatory — judging rules disqualify localhost links.

**Yash will help you with**: the Supabase schema design (§7), wiring the service role key into his FastAPI, and debugging any Postgres weirdness. Pair on schema setup tonight.

**Milestones**
- 10:30am — Supabase schema deployed; teammates have keys.
- 11:30am — Page renders dummy rows from Supabase via realtime channels.
- 1:00pm — Left panel shows live transcript entries from Yudong's component.
- 3:00pm — Middle + right panels render data Yash's pipeline writes.
- 5:30pm — Vercel-deployed URL works cleanly on a laptop AND a phone.

**Files you own**
- `supabase/schema.sql` (collaborative with Yash)
- `frontend/app/project/[id]/page.tsx`
- `frontend/components/{WeeklyDocPanel,PlanPanel,ActionsPanel}.tsx`
- `frontend/lib/supabase.ts`

---

### 🧠 Yash — Backend, Hyperspell, Categorizer, Executors

The heaviest role. You own everything that turns inputs into actionable output.

**Your slice of the flow**

```
                           ┌─── Yudong's voice ────┐
                           │                       │
                           ▼                       │
   Hyperspell ──┐    POST /voice/append            │
                ├─► insert into knowledge_entries  │
   Manual pull ─┘    (source='voice'/'slack'/...)  │
   (POST /ingest/                                  │
    hyperspell)                                    │
                                                   │
                ┌──────────────────────────────────┘
                │
                ▼
         Weekly Doc (knowledge_entries, last 7d, per project)
                │
                │  POST /categorize
                ▼
         Claude → CategorizedPlan(bugs, features, improvements)
                │
                ├─► insert categorized_items
                │
                ├─► for each item, draft 3 actions (Linear/PR/Devin)
                │   insert generated_actions (status='draft')
                │
                ▼
         (Jin's UI lights up)

                ┌─── Jin's "Execute" click ─┐
                │                            │
                ▼                            │
         POST /actions/{id}/execute          │
                │                            │
                ▼                            │
         Linear / GitHub / Devin API         │
                │                            │
                ▼                            │
         update generated_actions.external_url, status='executed'
```

**What you build**

1. **FastAPI app** at `backend/`:
   ```
   backend/
     main.py                       # FastAPI app + CORS + router includes
     routers/
       realtime.py                 # POST /rt/token
       voice.py                    # POST /voice/append
       ingest.py                   # POST /ingest/hyperspell
       context.py                  # GET  /context/briefing
       categorize.py               # POST /categorize
       actions.py                  # POST /actions/{id}/execute
     services/
       hyperspell.py               # search wrapper
       briefing_builder.py         # builds the project briefing for Yudong
       voice_summarizer.py         # uses briefing as system prompt
                                   # → structured note from chunk
       categorizer.py              # Claude Sonnet 4.6 over weekly doc
       action_drafts.py            # ticket / PR / Devin draft generators
       executors/{linear,github,devin}.py
       supabase_writer.py          # supabase-py wrappers
     schemas.py                    # Pydantic models matching §6
     settings.py                   # env vars
   ```

2. **`POST /rt/token`** — proxy to OpenAI (uses your master key, returns ephemeral):
   ```python
   r = await httpx.post(
       "https://api.openai.com/v1/realtime/sessions",
       headers={"Authorization": f"Bearer {OPENAI_KEY}"},
       json={"model": "gpt-realtime-whisper", "modalities": ["text"]},
   )
   return r.json()
   ```

3. **`POST /voice/append`** — `{projectId, meetingId, raw_transcript, briefing_id, ts}` →
   - Look up briefing by `briefing_id` (in-memory cache).
   - Call `voice_summarizer.summarize(raw_transcript, briefing)` → returns 1–3 structured notes typed as `decision | action_item | blocker | mention | fyi`, each cross-referencing entities from the briefing where possible.
   - Insert each note into `knowledge_entries` with `source='voice'`, `author='voice_agent'`.
   - Return 200.

3a. **`GET /context/briefing?projectId=X`** — assembles a briefing for Yudong's voice agent →
   - Pull last 7 days of `knowledge_entries` for the project (the running weekly doc).
   - Pull from Hyperspell: latest 3 design docs, latest 5 GitHub commits/PRs, top open Slack threads.
   - Generate a 1-paragraph project summary (cache per project; regenerate at most 1×/hour).
   - Cache the assembled briefing in memory keyed by `(projectId, day)` — return same `id` on re-fetch the same day.
   - Return the schema in §5.7.

4. **`POST /ingest/hyperspell`** — `{projectId}` →
   - Call `hyperspell.memories.search(query=<project_query>, sources=["slack","google_drive","notion","github"], options={"max_results": 20})`.
   - For each hit, insert into `knowledge_entries` with the right `source` (and `code_path`/`code_lines` if it's a GitHub code hit).
   - Dedupe by `ref_url` so re-running doesn't double-insert.
   - Return 200 with count inserted.

5. **`POST /categorize`** — `{projectId}` →
   - Read `knowledge_entries` for project, last 7 days, ordered by `ts asc`.
   - Build a working window prompt (instructions + the entries as a numbered list).
   - Call Claude with Anthropic tool-use schema — guaranteed valid JSON matching §6.
   - For each item in the response:
     - Insert `categorized_items` row.
     - Generate three drafts (Linear ticket, GitHub PR description, Devin handoff payload) via `action_drafts.for_item(item)` — each is a small prompt.
     - Insert three `generated_actions` rows with `status='draft'`.
   - Return 202 + the count of items generated.

6. **`POST /actions/{id}/execute`** — read action from Supabase, dispatch to right executor, write back `external_url` + `status='executed'`, return URL.

7. **Pair with Jin tonight** on the Supabase schema (§7) and the realtime tables.

**Milestones**
- Night before: Hyperspell connectors live + corpus ingested + verified search returns the expected items.
- 11:00am: FastAPI running, `/rt/token` returns ephemeral, schema + Pydantic models compile.
- 12:30pm: `/context/briefing` returns a real briefing assembled from Hyperspell + recent entries.
- 1:00pm: `/voice/append` (briefing-aware) writes structured notes from Yudong's chunks; Jin's left panel sees them.
- 2:30pm: `/ingest/hyperspell` works end-to-end against the real Hyperspell project.
- 3:30pm: `/categorize` returns valid Claude output; entries appear in Jin's middle/right panels.
- 5:00pm: `/actions/{id}/execute` actually creates real Linear tickets.

**Files you own**
- everything under `backend/`
- collaborate on `supabase/schema.sql` with Jin

---

## 4. Build Order (one-day timeline)

```
8:00 AM   Doors. Breakfast.
          NIGHT-BEFORE WORK MUST BE DONE:
            • Yash:   Hyperspell connectors live + corpus ingested
            • Yudong: standup script v1 + corpus content drafted
            • Jin:    Supabase project + schema deployed + Vercel project linked

9:15 AM   Hacking starts.
          [ALL] 30-min sync. Whiteboard the contracts (§5). Distribute keys.

9:45 AM   PARALLEL ─────────────────────────────────────────────────────
          Yash:   FastAPI scaffold; /rt/token; supabase-py wired.
                  Stub /voice/append and /categorize that return 200 + dummy.
          Yudong: VoiceAgent skeleton — gets ephemeral token, opens session.
          Jin:    Next.js scaffold; supabase-js wired; 3 panels render
                  dummy rows live from Supabase.

11:00 AM  CHECKPOINT
          • Voice agent shows transcript deltas in console.
          • Page renders dummy rows reactively from Supabase.
          • Yash can call hyperspell.memories.search and get real items.

11:00 AM  PARALLEL ─────────────────────────────────────────────────────
          Yash:   real /voice/append (with summarizer) + real /ingest/hyperspell.
          Yudong: WebRTC chunk-flush every 20s → Yash's endpoint.
          Jin:    Weekly Doc panel polished. Add the three header buttons.

12:00 PM  Hyperspell speaker session — Yash attends.
12:30 PM  Lunch.

1:30 PM   CHECKPOINT
          • Live transcript flows mic → Yudong → Yash → Supabase → Jin's UI.
          • /ingest/hyperspell button populates the doc with Slack/Drive items.

1:30 PM   PARALLEL ─────────────────────────────────────────────────────
          Yash:   /categorize end-to-end. Action draft generators.
                  Executors hitting real Linear/GitHub/Devin in sandbox.
          Yudong: rehearse the voice script; tune the summarizer prompt
                  with Yash so notes come out clean.
          Jin:    middle + right panels reactive. Animations, skeletons,
                  "ticket created ✓" toast, error states.

3:00 PM   Speaker session — Yudong attends; Yash + Jin keep building.

3:30 PM   CHECKPOINT — END-TO-END WORKING. Lock no new features.

3:30 PM   POLISH
          Yash:   prompt tuning so the plan reads like a senior eng wrote it.
          Yudong: rehearsal lead.
          Jin:    visual polish, mobile-safe, deploy to Vercel.

4:30 PM   FULL REHEARSAL #1 — fix everything that surfaces.
5:30 PM   FULL REHEARSAL #2 — record a backup video.
6:00 PM   SUBMIT.
6:10 PM   Judging.
```

---

## 5. Interface Contracts (frozen at 9:30am)

### 5.1 `/voice/append` (Yudong → Yash)

```http
POST {FASTAPI_URL}/voice/append
Content-Type: application/json

{ "projectId": "<uuid>", "meetingId": "<uuid>",
  "raw_transcript": "string",
  "briefing_id":   "<uuid>",            // from /context/briefing
  "ts": 1715275200000 }

→ 200 OK   { "inserted": 2 }
```

### 5.2 `/ingest/hyperspell` (Jin → Yash)

```http
POST {FASTAPI_URL}/ingest/hyperspell    { "projectId": "<uuid>" }
→ 200 OK   { "inserted": 14 }
```

### 5.3 `/categorize` (Jin → Yash)

```http
POST {FASTAPI_URL}/categorize    { "projectId": "<uuid>" }
→ 202 Accepted   { "items": 5 }   // pipeline runs async; UI sees rows appear
```

### 5.4 `/actions/{id}/execute` (Jin → Yash)

```http
POST {FASTAPI_URL}/actions/{actionId}/execute
→ 200 OK   { "externalUrl": "https://linear.app/.../ABC-42" }
```

### 5.5 `/rt/token` (Yudong → Yash)

```http
POST {FASTAPI_URL}/rt/token
→ 200 OK   { "client_secret": { "value": "ek_..." }, ... }
```

### 5.6 `/context/briefing` (Yudong → Yash)

```http
GET {FASTAPI_URL}/context/briefing?projectId=<uuid>

→ 200 OK
{
  "id": "<briefing_uuid>",                // pass back in /voice/append
  "project_summary": "string",
  "recent_decisions": [{ "summary": "...", "ts": "...", "ref_url": "..." }],
  "open_threads":     [{ "source": "slack|notion", "label": "...", "count": 6 }],
  "latest_docs":      [{ "title": "...", "url": "...", "ts": "..." }],
  "active_files":     [{ "path": "...", "last_touched": "..." }],
  "people":           ["yash", "jin", "yudong"]
}
```

Cached server-side keyed by `(projectId, day)`. Yudong renders the briefing in the agent's left rail and references the `id` in every `/voice/append` call.

### 5.7 Supabase schema (Jin owns; Yash writes; Yudong's component writes via Yash only)

See §7. Frozen at 9:30am.

---

## 6. Categorizer Output Schema (frozen)

```json
{
  "bugFixes":     [Item],
  "newFeatures":  [Item],
  "improvements": [Item]
}

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

Used as the Claude tool-use schema (guarantees valid JSON). Frontend renders directly.

---

## 7. Supabase Schema

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
  ref_url text,                 -- dedupe key for ingestion
  code_path text,               -- only when source='github' and is code
  code_lines text,              -- "12-34"
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

**Realtime publication** — enable `supabase_realtime` for: `knowledge_entries`, `categorized_items`, `generated_actions`.

**RLS** — disable for the hackathon:
```sql
alter table knowledge_entries  disable row level security;
alter table categorized_items  disable row level security;
alter table generated_actions  disable row level security;
alter table meetings           disable row level security;
alter table projects           disable row level security;
```

**Frontend subscription pattern** (Jin):
```ts
supabase
  .channel(`doc:${projectId}`)
  .on("postgres_changes",
    { event: "INSERT", schema: "public", table: "knowledge_entries",
      filter: `project_id=eq.${projectId}` },
    p => append(p.new))
  .subscribe();
```

**Backend write pattern** (Yash):
```python
from supabase import create_client
sb = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
sb.table("knowledge_entries").insert({...}).execute()
```

---

## 8. Demo Script (90 seconds)

> **Yash (10s):** *"This is Project Brain. Engineering teams already have all the context they need — it's just scattered. Slack, docs, meetings, code. We turn that into an executable plan, live."*

> **(Page open. Weekly Doc on the left already shows ~5 entries from Hyperspell — Slack threads, the design doc, a stale GitHub PR.)*

> **Yudong (5s) — clicks 🎙️ Voice agent:** *"Watch — I'll just join a standup."*

> **Yudong (15s) — speaks into mic:** *"Quick standup. The login flow is broken on Safari, we caught it in #bugs yesterday. Yash's design doc has us shipping CSV export this sprint, but the rate-limit middleware needs cleanup before we touch that. That's it."*

> **(While speaking, voice notes appear in the Weekly Doc with the 🎙️ icon.)*

> **Yash (5s) — clicks ✨ Generate plan:** *"Now we run Claude over the whole weekly doc."*

> **(~5s pause. Three categorized cards animate into the middle panel: Safari bug, CSV export feature, rate-limit cleanup. Action cards animate into the right panel.)*

> **Jin (20s):** *"One bug, one feature, one improvement — every one with the source it came from and the file it touches. Watch — "* (clicks **Create in Linear**) *"that ticket just hit our real Linear board."* (clicks **Send to Devin**) *"And Devin gets the full context bundle to start working on it autonomously."*

> **Yash (10s):** *"Four sponsors stitched into one product — Hyperspell, OpenAI Realtime, Vercel, Devin — solving a problem every engineering team here has. Questions?"*

---

## 9. Risk Register & Fallbacks

| Risk | Mitigation |
|---|---|
| OpenAI Realtime flaky on event Wi-Fi | Phone hotspot. Final fallback: prerecorded transcript replay script that inserts entries with `source='voice'` at the right cadence. |
| Hyperspell sync incomplete by 9am | **Why we ingest the night before.** If still incomplete, `/ingest/hyperspell` falls back to a hardcoded fixture file that inserts realistic entries. Same demo. |
| Hyperspell GitHub doesn't return code-level snippets | Pre-stage 3 code-snippet fixtures keyed to the demo signals; merge them into `/ingest/hyperspell` output. |
| Claude returns malformed JSON | Anthropic tool-use schema. Pydantic-validate; one retry on failure. |
| Supabase realtime drops a row | Each panel does an initial `select` on mount, then layers realtime inserts. Refresh fixes any miss. |
| Linear / GitHub action fails live | Pre-create projects + tokens validated at 4pm. If still failing, skip live execution — show the perfect draft (judges score draft quality, not the API call). |
| Demo over 3 minutes | Yudong is the timer. Cut intro, not demo. |
| FastAPI not reachable from Vercel | ngrok stable URL, baked into `NEXT_PUBLIC_FASTAPI_URL`. Test from Vercel preview at 5:00pm. |

---

## 10. Sponsor Coverage

Visible in the 3-min pitch and named in the README:

- [x] **Hyperspell** — sole context layer. Track sponsor → $1k cash + 6mo unlimited + founders deploy session.
- [x] **OpenAI** — Realtime API for the voice agent. Mention `gpt-realtime-whisper`.
- [x] **Vercel** — public deploy URL.
- [x] **Devin** — "Send to Devin" button visible in actions panel.
- [ ] *Stretch:* **Tensorlake** — only if Phase 6 finishes early; nightly background brain refresh.

---

## 11. Pre-Hackathon Checklist (tonight)

**Yash**
- [ ] Hyperspell account; OAuth Slack, Drive, Notion, GitHub.
- [ ] Ingest Yudong's seed corpus.
- [ ] Verify `client.memories.search` returns expected items.
- [ ] Anthropic + OpenAI keys ready.
- [ ] Linear sandbox project + API token.
- [ ] GitHub PAT scoped to demo repo.
- [ ] Devin form filled.
- [ ] ngrok installed; reserve subdomain if possible.
- [ ] Pair with Jin on `supabase/schema.sql` (§7).

**Yudong**
- [ ] Standup script v1 (≤60s, hits 3 signals: bug + feature + improvement).
- [ ] Seed corpus content drafted (Slack messages, design doc, bug report, Notion plan, GitHub issues).
- [ ] Hand corpus to Yash.

**Jin**
- [ ] Supabase project created.
- [ ] Schema applied (§7) — pair with Yash.
- [ ] Realtime enabled on the 3 reactive tables; RLS disabled.
- [ ] Hand keys: anon → frontend `.env`, service role → Yash only.
- [ ] Vercel project linked to GitHub repo; verify deploy works.

**Shared**
- [ ] 1Password vault with all keys.
- [ ] Yudong prints the demo script + brings phone hotspot.

---

## 12. One-line summary for the judges

> *Project Brain keeps a per-project weekly knowledge document. A voice agent listens to your meetings, Hyperspell pulls in your Slack/docs/code, and Claude turns the doc into bug fixes, features, and improvements you can ship straight to Linear, GitHub, or Devin.*
