# Jin PRD Execution Plan: Supabase Data Layer + Project Brain Frontend

## Summary

Jin owns the Project Brain control room: the Supabase schema, realtime data path, and tabbed Next.js frontend that makes the full system visible during the demo.

The product promise for this slice is simple: when Yudong's voice agent writes meeting notes and Yash's backend writes project context, synthesis, plan items, and generated actions, Jin's UI updates live and gives the team an execution-ready view of the project.

This is not a generic dashboard. It is the main demo surface for Project Brain. The UI must prove the pipeline works from raw inputs to knowledge synthesis to executable actions.

## Problem Statement

Engineering project context is scattered across meetings, docs, Slack, Drive, Notion, Gmail, and code. Even if Yudong captures meeting notes and Yash generates action plans, the product fails unless users can see those signals come together in one coherent project workspace.

Jin's work solves the visibility and coordination problem. The database gives every teammate a stable contract for writing and reading project intelligence. The frontend turns those rows into a useful workflow: inspect inputs, review the synthesized knowledge doc, and act on generated execution drafts.

## Goals

- Make the demo data path observable end to end: raw meeting/context inputs appear live, synthesis appears after generation, and generated actions can be inspected from the Actions tab.
- Provide a schema that supports the current technical plan: timestamped raw inputs, pgvector retrieval, weekly knowledge documents, categorized plan items, generated actions, generation run status, and realtime subscriptions.
- Give Yudong and Yash stable interfaces so they can build independently without blocking on frontend internals.
- Ship a polished, fast project page that works on the demo laptop and phone by 5:30pm.
- Keep v1 narrow enough to finish: one strong project workspace, one real pipeline, clear action drafts.

## Non-Goals

- Multi-tenant enterprise auth is out of scope. The hackathon demo can use permissive read policies and demo-token-gated backend writes.
- Cross-project analytics are out of scope. The MVP only needs one or a small set of project pages.
- Fully autonomous action execution UI is out of scope for Jin. Jin displays action drafts and calls Yash's execution endpoint; Yash owns real Linear, GitHub, and Devin dispatch.
- Transcript editing is out of scope. Yudong owns meeting capture and transcript handling; Jin displays structured notes.
- Advanced knowledge graph editing is out of scope. The frontend should show relationships clearly, but the live React Flow board is Yudong-owned inside `VoiceAgent`.

## Primary Users

- **Demo operator**: needs a reliable surface to show inputs flowing in, synthesis appearing, and actions becoming available.
- **Engineer reviewing project context**: needs to understand what changed, why it matters, and what work is ready to execute.
- **Teammates building integrations**: need stable table names, column names, realtime filters, and endpoint calls.

## User Stories

- As a demo operator, I want to open a project page and see the latest meetings, context items, knowledge document, plan items, and actions so that I can show the whole Project Brain pipeline in under three minutes.
- As Yudong, I want to insert structured notes into `meeting_notes` with an anon Supabase client so that the voice agent can write live meeting intelligence without backend coupling.
- As Yash, I want to insert `project_context`, `knowledge_documents`, `plan_items`, `generated_actions`, and `generation_runs` with service role credentials so that the backend can own ingestion, synthesis, categorization, and executors.
- As an engineer, I want generated plan items grouped by category and backed by source/code refs so that I can trust where the proposed work came from.
- As a reviewer, I want action cards for Linear, PR, and Devin drafts so that I can choose the execution path that matches the item.
- As a user on a slow or partially broken demo path, I want useful empty, loading, and error states so that the product still explains what is happening instead of looking broken.

## Scope

### P0 Must-Haves

1. **Supabase schema v2 is applied and verified**
   - Tables exist: `projects`, `meetings`, `meeting_notes`, `meeting_transcript_chunks`, `project_context`, `knowledge_documents`, `generation_runs`, `plan_items`, `generated_actions`.
   - `meeting_notes.embedding` and `project_context.embedding` are `vector(1536)`.
   - HNSW indexes exist for vector search.
   - `search_context(project_id, q_emb, p_limit)` returns merged results from `meeting_notes` and `project_context`.
   - Realtime publication includes every table the UI subscribes to.

2. **RLS and write contracts support the demo**
   - `anon` can select from all demo tables.
   - `anon` can insert into `meeting_notes` and `meeting_transcript_chunks`.
   - Yash's service role writes backend-owned tables.
   - No frontend component requires a service role key.

3. **Project routes exist**
   - `/projects` lists available projects.
   - `/projects/[id]` renders the main project workspace.
   - The project page has three top-level tabs: Inputs, Knowledge Doc, Actions.

4. **Inputs tab renders live raw context**
   - Meetings section renders `VoiceAgent` mount point and `meeting_notes`.
   - Project Context section renders `project_context` grouped by source.
   - Realtime subscriptions update rows where `project_id=eq.<pid>`.

5. **Knowledge Doc tab renders synthesis**
   - Shows latest `knowledge_documents` row by `week_start`.
   - Shows summary, themes, decisions, blockers, and open questions.
   - Shows `plan_items` grouped by `bug_fix`, `new_feature`, and `maintenance`.
   - Plan items include title, description, next step, source refs, code refs, and confidence when present.

6. **Actions tab renders generated execution drafts**
   - Shows `generated_actions` filtered by `project_id`.
   - Groups or labels actions by `linear_ticket`, `github_pr`, and `devin_handoff`.
   - Each action card shows status, payload summary, external URL if present, and an Execute button.
   - Execute calls `POST {FASTAPI}/actions/{id}/execute` with the demo bearer token.

7. **Generation controls and status are visible**
   - Header shows the latest `generation_runs` status for the project.
   - A Generate Plan button calls `POST {FASTAPI}/plan/generate`.
   - While a run is `queued` or `running`, the UI shows a non-blocking generating state.
   - If a run errors, show the error message in a compact status surface.

### P1 Nice-to-Haves

- Add source filter chips for Slack, Drive, Notion, Gmail, and meeting notes.
- Add a compact "latest activity" strip in the project header.
- Add copy buttons for generated Linear ticket text and Devin handoff text.
- Add seeded demo data loader for dry runs if Yudong or Yash endpoints are unavailable.
- Add skeleton loading states for each tab instead of generic spinners.

### P2 Future Considerations

- Real user/team auth with project membership and proper per-project RLS.
- Historical knowledge document browser by week.
- Action execution audit timeline.
- Cross-project company brain overview.
- Rich source preview modals for docs, Slack threads, and PRs.

## Data Contract

### Tables Jin Must Support

| Table | Purpose | Main Writer | Frontend Usage |
|---|---|---|---|
| `projects` | Project records | Seed/admin | `/projects`, page header |
| `meetings` | Meeting sessions | Yudong/Jin seed | Inputs meeting grouping |
| `meeting_notes` | Structured notes from voice agent | Yudong anon insert | Inputs, vector search |
| `meeting_transcript_chunks` | Raw transcript audit trail | Yudong anon insert | Optional/debug |
| `project_context` | Hyperspell Slack/Drive/Notion/Gmail context | Yash service role | Inputs, vector search |
| `knowledge_documents` | Weekly synthesis | Yash service role | Knowledge Doc |
| `generation_runs` | Plan generation status/idempotency | Yash service role | Header status |
| `plan_items` | Categorized work items | Yash service role | Knowledge Doc |
| `generated_actions` | Linear/PR/Devin drafts | Yash service role | Actions |

### Critical Column Decisions

- `generated_actions.project_id` is required even though `plan_item_id` exists. Supabase realtime filters cannot join through `plan_items`, so the denormalized `project_id` enables `project_id=eq.<pid>`.
- `meeting_notes.embedding` and `project_context.embedding` must use the same OpenAI embedding model, `text-embedding-3-small`, with 1536 dimensions.
- `knowledge_documents` is unique by `(project_id, week_start)` so a new generation replaces the weekly synthesis instead of creating confusing duplicates.
- `plan_items` must carry `project_id` as well as `knowledge_document_id` to keep frontend queries simple and fast.

## Frontend Information Architecture

### `/projects`

Purpose: fast entry point into the demo.

Required behavior:
- Query `projects` ordered by `created_at desc`.
- Render project name, repo URL if available, and created date.
- Clicking a project navigates to `/projects/[id]`.
- If no projects exist, show a clear empty state and a seed/demo instruction.

### `/projects/[id]`

Project header:
- Project name and repo URL.
- Latest run status from `generation_runs`.
- Buttons: Ingest Context, Generate Plan.
- Optional small counters: meeting notes, context items, plan items, action drafts.

Tabs:
- Inputs
- Knowledge Doc
- Actions

## Tab Requirements

### Inputs Tab

Sections:
- Meetings
- Project Context

Meeting requirements:
- `meetingId` is an internal Supabase `meetings.id`, not a Google Meet ID.
- For the demo, select the latest `status = 'live'` meeting for the current project, or use a pre-seeded row titled "Demo Standup".
- If no live meeting exists, show a setup empty state instead of mounting `VoiceAgent` with an undefined id.
- Mount Yudong's component as:
  ```tsx
  <VoiceAgent projectId={projectId} meetingId={meetingId} />
  ```
- Render recent `meeting_notes` ordered by `ts desc`.
- Show note type badges: decision, action item, blocker, mention, fyi.
- Show `refs_to` when present.
- Empty state: "Start the listener to capture meeting notes."

Project context requirements:
- Render `project_context` grouped by `source`.
- Show title, snippet, author, ref URL, and timestamp when present.
- Empty state: "Run Hyperspell ingest to pull project context."

### Knowledge Doc Tab

Synthesis requirements:
- Render latest `knowledge_documents` row.
- Show summary first.
- Render themes, decisions, blockers, and open questions as scannable lists.
- If `status = generating`, keep showing the previous ready doc if available and show a generating indicator.
- If no doc exists, show a call to action to generate a plan.

Plan item requirements:
- Query `plan_items` by `project_id`.
- Group by category:
  - Bug fixes
  - New features
  - Maintenance
- Each card shows title, description, next step, source refs, code refs, confidence.
- Source refs and code refs can be JSON; render defensively so malformed or partial payloads do not crash the page.

### Actions Tab

Requirements:
- Query `generated_actions` by `project_id`.
- Join client-side to loaded `plan_items` when useful for display.
- Each action card shows:
  - action type
  - status
  - related plan item title if available
  - payload summary
  - external URL if executed
  - Execute button when `status = draft`
- Disable Execute while status is `executing`.
- After execute returns, update the local card and rely on realtime for final status.

## API Contract

Jin calls Yash:

| Method | Path | Trigger | Expected Result |
|---|---|---|---|
| `POST` | `/ingest/hyperspell` | Ingest Context button | New/updated `project_context` rows |
| `POST` | `/plan/generate` | Generate Plan button | `generation_runs`, `knowledge_documents`, `plan_items`, `generated_actions` update |
| `POST` | `/actions/{id}/execute` | Execute button | Action status changes and optional `external_url` |

Frontend headers for protected demo endpoints:

```ts
{
  "Authorization": `Bearer ${process.env.NEXT_PUBLIC_DEMO_TOKEN}`,
  "Content-Type": "application/json"
}
```

## Realtime Subscription Plan

Subscribe by project:

- `meeting_notes`: `project_id=eq.${projectId}`
- `project_context`: `project_id=eq.${projectId}`
- `knowledge_documents`: `project_id=eq.${projectId}`
- `plan_items`: `project_id=eq.${projectId}`
- `generated_actions`: `project_id=eq.${projectId}`
- `generation_runs`: `project_id=eq.${projectId}`

Acceptance criteria:
- When Yudong inserts a note, it appears in Inputs without refresh.
- When Yash ingests context, it appears in Project Context without refresh.
- When Yash runs generation, status changes appear in the header without refresh.
- When generated actions are inserted or updated, the Actions tab reflects them without refresh.

## Component Ownership

Jin owns:

```text
frontend/app/projects/page.tsx
frontend/app/projects/[id]/page.tsx
frontend/app/projects/[id]/_tabs/InputsTab.tsx
frontend/app/projects/[id]/_tabs/KnowledgeDocTab.tsx
frontend/app/projects/[id]/_tabs/ActionsTab.tsx
frontend/components/MeetingsList.tsx
frontend/components/ProjectContextList.tsx
frontend/components/SynthesisCards.tsx
frontend/components/PlanItemCards.tsx
frontend/components/ActionCard.tsx
frontend/lib/supabase.ts
frontend/app/globals.css
tailwind config
supabase/migration_to_v2.sql
supabase/migrations/*.sql
```

Yudong owns but Jin mounts:

```text
frontend/components/VoiceAgent.tsx
frontend/components/BriefingPanel.tsx
frontend/components/MeetingContextBoard.tsx
frontend/components/LiveContextDiagram.tsx
frontend/app/api/voice/summarize/route.ts
```

Yash owns but Jin calls:

```text
POST /ingest/hyperspell
POST /plan/generate
POST /actions/{id}/execute
```

## Execution Milestones

### 10:30am — Schema Ready

Deliverables:
- Apply `supabase/migration_to_v2.sql`.
- Verify `vector` extension exists.
- Verify all v2 tables exist.
- Verify realtime publication includes all v2 tables.
- Share Supabase URL and anon key with Yudong.
- Share table contract with Yash.

Definition of done:
- Manual insert into `meeting_notes` succeeds with anon key.
- Manual select from every table succeeds with anon key.
- `search_context` function exists and grants execute to anon/authenticated.

### 11:30am — Frontend Skeleton

Deliverables:
- `/projects` route.
- `/projects/[id]` route.
- Header and three tabs.
- Dummy cards render for each tab if real data is not ready.

Definition of done:
- Demo operator can navigate to a project page.
- Layout does not shift when tabs switch.
- Empty states are present.

### 1:00pm — Meeting Notes Live

Deliverables:
- Supabase client configured.
- `meeting_notes` query and realtime subscription wired.
- `VoiceAgent` mounted behind a stable component boundary.

Definition of done:
- A test insert into `meeting_notes` appears in the Inputs tab without refresh.
- Note type badges render correctly.

### 2:00pm — Project Context Live

Deliverables:
- Ingest Context button calls Yash's endpoint.
- `project_context` list renders grouped by source.
- Realtime subscription updates the list.

Definition of done:
- A test or real ingest produces context rows visible in the UI.
- Slack/Drive/Notion/Gmail source labels are distinguishable.

### 3:30pm — Knowledge + Actions Real Data

Deliverables:
- Generate Plan button calls `/plan/generate`.
- Header listens to `generation_runs`.
- Knowledge Doc tab renders latest `knowledge_documents`.
- Plan item cards render from `plan_items`.
- Actions tab renders `generated_actions`.

Definition of done:
- One generation run produces at least one knowledge doc, one plan item, and three action drafts.
- UI updates without manual refresh.

### 5:30pm — Demo Polish

Deliverables:
- Responsive layout works on laptop and phone.
- Loading, empty, and error states are clear.
- Buttons have disabled states.
- Demo project is seeded or real pipeline is ready.
- Vercel deployment URL works.

Definition of done:
- Three-minute demo path can be completed twice in a row.
- If live ingestion fails, seeded data still shows the intended Project Brain workflow.

## Test Plan

### Schema Tests

- Confirm all v2 tables exist:
  ```sql
  select table_name
  from information_schema.tables
  where table_schema = 'public'
  order by table_name;
  ```
- Confirm vector columns:
  ```sql
  select table_name, column_name, udt_name
  from information_schema.columns
  where column_name = 'embedding';
  ```
- Confirm realtime tables:
  ```sql
  select c.relname
  from pg_publication p
  join pg_publication_rel pr on pr.prpubid = p.oid
  join pg_class c on c.oid = pr.prrelid
  where p.pubname = 'supabase_realtime'
  order by c.relname;
  ```

### Frontend Smoke Tests

- Load `/projects`; projects render.
- Load `/projects/[id]`; all tabs render.
- Insert a meeting note manually; Inputs updates.
- Insert a project context row manually; Inputs updates.
- Insert a generation run manually; header updates.
- Insert a knowledge document and plan item manually; Knowledge Doc updates.
- Insert generated actions manually; Actions updates.

### Integration Tests

- Start Yudong listener, speak a demo note, confirm it appears in Inputs.
- Run Yash ingest endpoint, confirm context appears.
- Run Yash plan endpoint, confirm Knowledge Doc and Actions populate.
- Execute one action draft, confirm status and external URL update.

## Demo Script For Jin's Surface

1. Open `/projects/[id]`.
2. Show Inputs tab with meetings and project context.
3. Start or point to the live meeting notes flowing in from Yudong.
4. Click Ingest Context or show recently ingested Hyperspell items.
5. Click Generate Plan.
6. Move to Knowledge Doc and show the summary, decisions, blockers, and plan items.
7. Move to Actions and show Linear, PR, and Devin drafts for a plan item.
8. Execute one low-risk action or show a previously executed action with `external_url`.

## Fallback Plan

If Yudong's live audio path fails:
- Use a manual/seeded insert into `meeting_notes`.
- Continue demo from Inputs tab as if notes just arrived.

If Yash's Hyperspell ingest fails:
- Seed `project_context` rows with Slack/Drive/Notion/Gmail-looking examples.
- Keep the Ingest button visible but do not rely on it.

If `/plan/generate` fails:
- Seed one `knowledge_documents` row, three `plan_items`, and nine `generated_actions`.
- Show the run error in the header only if it helps explain the fallback.

If action execution fails:
- Keep draft payloads visible.
- Show disabled/error status and explain that executors are the final integration layer.

## Open Questions

- **Resolved: Jin/Yash** — `supabase/migration_to_v2.sql` is the demo schema source of truth.
- **Resolved: Jin/Yudong** — `meetingId` comes from an internal Supabase `meetings` row. For demo, Jin selects the latest live meeting or uses a pre-seeded row before mounting `VoiceAgent`.
- **Resolved: Jin/Yash** — `/plan/generate` expects JSON body `{ projectId }` with `Authorization: Bearer ${NEXT_PUBLIC_DEMO_TOKEN}`.
- **Resolved: Jin/Yash** — `/actions/{id}/execute` returns `{ externalUrl }`; frontend should update local UI optimistically and rely on realtime for final status.
- **Non-blocking: Team** — What is the final demo project name and seeded project ID?

## Done Criteria

Jin's part is done when the project page can receive live inputs, display the latest synthesized project brain, and present generated execution actions without refresh. The team should be able to run the demo even if one upstream service is degraded, because the frontend and schema make the intended pipeline visible and credible.
