# frontend/

Next.js (App Router) on Vercel. Two owners with strict file boundaries.

## Owners

| Path | Owner |
|---|---|
| `app/projects/**` (page, layout, tabs) | **Jin** |
| `components/{WeeklyDoc,MeetingsList,ProjectContextList,SynthesisCards,PlanItemCards,ActionCard,GenerationStatusPill}.tsx` | **Jin** |
| `lib/supabase.ts`, `lib/database.types.ts`, `app/globals.css`, Tailwind config | **Jin** |
| `components/{VoiceAgent,BriefingPanel,MeetingContextBoard,LiveContextDiagram}.tsx` | **Yudong** |
| `lib/{realtime,meetingAudio,voiceNoteSchema}.ts` | **Yudong** |
| `app/api/voice/summarize/route.ts` | **Yudong** |

See [`../individual_plan/`](../individual_plan/) for each person's detailed plan.

## What lives here

```
frontend/
  app/
    projects/
      page.tsx                  project list
      [id]/
        page.tsx                tab shell
        _tabs/
          InputsTab.tsx
          KnowledgeDocTab.tsx
          ActionsTab.tsx
    api/
      voice/
        summarize/
          route.ts              Yudong's summarizer Route Handler
  components/
    (Jin's panels + Yudong's voice components)
  lib/
    supabase.ts                 typed Supabase client (Jin)
    database.types.ts           generated from schema (Jin)
    realtime.ts                 WebRTC handshake helper (Yudong)
    meetingAudio.ts             tab+mic mixer (Yudong)
    voiceNoteSchema.ts          shared JSON schema (Yudong)
```

## Bootstrap (Jin does this tonight)

```bash
cd frontend
pnpm create next-app . --ts --app --tailwind --eslint
pnpm add @supabase/supabase-js openai @xyflow/react
pnpm add -D @supabase/cli
```

`.env.local`:
```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
NEXT_PUBLIC_FASTAPI_URL=https://<yash-ngrok>.ngrok.app
NEXT_PUBLIC_DEMO_TOKEN=...
OPENAI_API_KEY=...   (server-only, used by /api/voice/summarize)
```

Generate types from Supabase:
```bash
npx supabase gen types typescript --project-id <ref> > lib/database.types.ts
```

Deploy to Vercel; bake the same env vars in Vercel project settings.

## Source of truth

[`../project_brain_technical_execution_plan.md`](../project_brain_technical_execution_plan.md) §3 (Jin + Yudong), §3.5 (file ownership), §5 (contracts), §6.5 (Jin's migration).
