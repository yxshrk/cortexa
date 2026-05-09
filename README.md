# Cortexa — Project Brain

> Per-project engineering brain for the Nozomio Hackathon (May 9, 2026).
> Track: 🧠 The Company Brain (Hyperspell-led).
> Team: Yash · Jin · Yudong.

A voice agent listens to your meetings, Hyperspell pulls in your Slack/Drive/Notion/Gmail, and Claude turns it into bug fixes, features, and maintenance items you can ship straight to Linear, GitHub, or Devin.

## Where to start

| If you are… | Read first |
|---|---|
| **Anyone** wanting the big picture | [`project_brain_prd_and_execution_plan.md`](./project_brain_prd_and_execution_plan.md) (the PRD) |
| **Anyone** wanting the technical plan | [`project_brain_technical_execution_plan.md`](./project_brain_technical_execution_plan.md) (the runbook) |
| **Yash** | [`individual_plan/yash_backend_execution_plan.md`](./individual_plan/yash_backend_execution_plan.md) → [`backend/README.md`](./backend/README.md) |
| **Jin** | technical plan §3 (Jin) + §6.5 (migration playbook) → run [`supabase/migration_to_v2.sql`](./supabase/migration_to_v2.sql) → [`frontend/README.md`](./frontend/README.md) |
| **Yudong** | [`individual_plan/yudong_meet_listener_execution_plan.md`](./individual_plan/yudong_meet_listener_execution_plan.md) → [`frontend/README.md`](./frontend/README.md) |
| **A reviewer** | technical plan §0 (big idea) → §2 (architecture) → §5 (contracts) |

## Repo layout

```
cortexa/
├── README.md                                       this file
├── project_brain_prd_and_execution_plan.md         the PRD
├── project_brain_technical_execution_plan.md       the technical runbook (canonical)
├── individual_plan/
│   ├── yash_backend_execution_plan.md
│   └── yudong_meet_listener_execution_plan.md
│   (Jin: see technical plan §3 and §6.5)
├── backend/                                        Yash's FastAPI app
│   ├── README.md
│   └── fixtures/seed_code_refs.json                Hyperspell GitHub fallback
├── frontend/                                       Jin's Next.js + Yudong's voice agent
│   ├── README.md
│   ├── package.json, tsconfig.json, etc.
│   ├── app/                                         pages + API routes
│   ├── lib/supabase.ts
│   └── .env.local.example
├── supabase/
│   └── migration_to_v2.sql                         paste-and-run schema migration
└── docs/                                            external-system knowledge dumps
    ├── README.md
    └── hyperspell.md                                connectors, SDKs, source enum mapping
```

## Source of truth

- **Architecture, contracts, schema, role boundaries** → `project_brain_technical_execution_plan.md`.
- **Schema migration** → `supabase/migration_to_v2.sql`. Paste into Supabase SQL Editor, click Run.
- **Per-person tasks** → `individual_plan/<name>_*.md`.

## Stack

Hyperspell · OpenAI Realtime + Embeddings · Anthropic Claude Sonnet 4.6 · Supabase (Postgres + Realtime + RLS + pgvector) · Next.js on Vercel · FastAPI · Linear / GitHub / Devin executors.
