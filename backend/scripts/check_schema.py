"""
One-shot schema sanity check.

Reads SUPABASE_URL + SUPABASE_KEY (or SUPABASE_SERVICE_ROLE_KEY) from .env,
introspects PostgREST, prints per-table column sets, and diffs against
the expected schema from supabase/migration_to_v2.sql.

Run:    cd backend && python3 scripts/check_schema.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx


# ─── load .env without pydantic (no deps required) ────────────────────────────
def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip('"').strip("'")
    return out


here = Path(__file__).resolve().parent.parent
env = {**load_env(here / ".env"), **os.environ}

url = env.get("SUPABASE_URL")
# Accept any of the common names. Whatever's set, it MUST be the secret/service_role.
key = (
    env.get("SUPABASE_SERVICE_ROLE_KEY")
    or env.get("SUPABASE_SECRET_KEY")
    or env.get("SUPABASE_KEY")
)

if not url or not key:
    sys.exit("missing SUPABASE_URL or one of "
             "SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY / SUPABASE_KEY in backend/.env")

# Quick sanity: bail loudly if the user pasted the publishable key.
if key.startswith("sb_publishable_"):
    sys.exit("That's the PUBLISHABLE key (frontend). Backend needs the SECRET key (sb_secret_*).")


# ─── expected schema (from supabase/migration_to_v2.sql) ──────────────────────
EXPECTED: dict[str, set[str]] = {
    "projects": {"id", "name", "repo_url", "hyperspell_user_id", "created_at"},
    "meetings": {"id", "project_id", "title", "started_at", "ended_at", "status"},
    "meeting_notes": {
        "id", "project_id", "meeting_id", "type", "text", "refs_to",
        "embedding", "ts",
    },
    "meeting_transcript_chunks": {
        "id", "meeting_id", "speaker", "start_ms", "end_ms", "text", "ts",
    },
    "project_context": {
        "id", "project_id", "source", "external_id", "title", "snippet",
        "full_text", "content_hash", "author", "ref_url", "source_created_at",
        "source_updated_at", "embedding", "ingested_at", "ts",
    },
    "knowledge_documents": {
        "id", "project_id", "week_start", "week_end", "status", "summary",
        "themes", "decisions", "blockers", "open_questions",
        "source_meeting_note_ids", "source_project_context_ids", "generated_at",
    },
    "generation_runs": {
        "id", "project_id", "week_start", "idempotency_key", "status",
        "error", "retry_count", "started_at", "finished_at", "created_at",
    },
    "plan_items": {
        "id", "knowledge_document_id", "project_id", "generation_run_id",
        "category", "title", "description", "source_refs", "code_refs",
        "next_step", "confidence", "generated_at",
    },
    "generated_actions": {
        "id", "plan_item_id", "project_id", "generation_run_id",
        "action_type", "payload", "status", "external_url", "created_at",
    },
}

# ─── pull PostgREST OpenAPI schema ────────────────────────────────────────────
headers = {"apikey": key, "Authorization": f"Bearer {key}"}
r = httpx.get(f"{url.rstrip('/')}/rest/v1/", headers=headers, timeout=10)
print(f"GET {url}/rest/v1/  →  {r.status_code}")
if r.status_code != 200:
    print(r.text[:500])
    sys.exit(1)

schema = r.json()
defs = schema.get("definitions") or schema.get("components", {}).get("schemas", {})
present_tables = sorted(defs.keys())

print("\n── Tables present in Supabase ──")
for t in present_tables:
    print(f"  {t}")

# ─── diff ─────────────────────────────────────────────────────────────────────
print("\n── Diff vs expected (migration_to_v2.sql) ──")
ok = True
for table, expected_cols in EXPECTED.items():
    if table not in defs:
        print(f"  ❌ MISSING TABLE: {table}")
        ok = False
        continue
    actual_cols = set((defs[table].get("properties") or {}).keys())
    missing = expected_cols - actual_cols
    extra = actual_cols - expected_cols
    if not missing and not extra:
        print(f"  ✅ {table:30s}  ({len(actual_cols)} cols)")
    else:
        ok = False
        print(f"  ⚠️  {table}")
        if missing: print(f"      missing: {sorted(missing)}")
        if extra:   print(f"      extra:   {sorted(extra)}")

stale_tables = set(present_tables) - set(EXPECTED.keys())
if stale_tables:
    print(f"\n  🗑  v1 tables still present (drop them): {sorted(stale_tables)}")
    ok = False

# ─── RPC: search_context ──────────────────────────────────────────────────────
rpc_url = f"{url.rstrip('/')}/rest/v1/rpc/search_context"
zero_vec = [0.0] * 1536
rpc_r = httpx.post(
    rpc_url,
    headers={**headers, "Content-Type": "application/json"},
    json={
        "p_project_id": "00000000-0000-0000-0000-000000000000",
        "q_emb": zero_vec,
        "p_limit": 1,
    },
    timeout=10,
)
print(f"\nPOST /rpc/search_context  →  {rpc_r.status_code}")
if rpc_r.status_code == 200:
    print(f"  ✅ RPC reachable (returned {len(rpc_r.json())} rows)")
else:
    ok = False
    print(f"  ❌ {rpc_r.text[:300]}")

# ─── Realtime publication ─────────────────────────────────────────────────────
# Can't introspect via REST without a pg func; just print a hint.
print("\nℹ️  Verify Realtime publication manually in Supabase Studio:")
print("   Database → Replication → supabase_realtime → 7 tables enabled.")

print("\n────────────────────────────────────────")
print("✅ schema MATCHES migration_to_v2.sql" if ok else "⚠️  schema DRIFT — see above")
sys.exit(0 if ok else 2)
