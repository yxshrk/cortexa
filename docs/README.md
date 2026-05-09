# docs/

Knowledge dumps for the team and other agents to verify and build on. **Not** the same as the canonical plans (`project_brain_*.md`) — these are research notes for specific external systems.

| File | Topic |
|---|---|
| [`hyperspell.md`](./hyperspell.md) | What we know about Hyperspell's connectors, SDKs, API surface, source enum mapping. |

## Conventions

- Cite the upstream URL for every claim.
- Tag unverified claims with `[VERIFY]` so other agents can pick them up.
- When you verify or contradict something, **edit the doc** and commit — don't silently override.
- Keep these summarized, not raw transcripts. Agents need signal density.

## When to add a new doc here

- A new external API/SDK enters the build (e.g. add `linear.md`, `devin.md` if scope grows).
- An integration has tribal knowledge worth preserving (auth gotchas, rate-limit quirks, undocumented behavior).
- A teammate's research output that should outlive the conversation it came from.

## When NOT to use this folder

- For our own architecture / contracts → those live in `project_brain_technical_execution_plan.md`.
- For per-person tasks → `individual_plan/<name>_*.md`.
- For runnable migrations / fixtures → `supabase/`, `backend/fixtures/`.
