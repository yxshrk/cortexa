# demo/

Demo content + rehearsal artifacts. Owned by **Yudong** (paired with Yash on the seed corpus side).

## What lives here

| File | Purpose |
|---|---|
| `standup_script.md` | The 60-second standup script Yudong reads into the mic at 6:10pm. |
| `seed_corpus/` | The text content Yash ingests into Hyperspell tonight (Slack messages, design doc, bug report, Notion page, GitHub issues). |
| `backup_video.mp4` | Recorded backup demo from 5:30pm rehearsal — submitted as fallback if live demo dies. |

## Demo signals (must hit all three in the script)

1. **Bug**: a Safari-specific login failure surfaced in `#bugs` — points at `auth/redirect.ts`.
2. **New feature**: a CSV export v2 design doc — references the rate-limit middleware as a dependency.
3. **Maintenance**: rate-limit middleware cleanup mentioned in a Notion plan, with stale PR #42 in the demo repo.

These three are also keyed in [`../backend/fixtures/seed_code_refs.json`](../backend/fixtures/seed_code_refs.json) for when Hyperspell GitHub beta is unavailable.

## Source of truth

[`../project_brain_technical_execution_plan.md`](../project_brain_technical_execution_plan.md) §10 (Demo Script).
