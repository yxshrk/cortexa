"""Seed the Project Brain Supabase project with demo data.

Reads each table's JSON file under data/ and UPSERTs the rows in
foreign-key-safe order using the Supabase service-role client.

Run:
    cd backend && source .venv/bin/activate
    cd ../data
    SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python seed.py

The backend's .env is auto-loaded if present (../backend/.env), so you can
also just run:
    cd data && python seed.py

Env required:
    SUPABASE_URL                  e.g. https://walgjemfqjxhrixqtaey.supabase.co
    SUPABASE_SERVICE_ROLE_KEY     service-role key (bypasses RLS)

Optional:
    DATA_DIR                      defaults to the dir this file lives in
    WIPE_FIRST=1                  delete all rows in the seeded tables before inserting

Idempotent: each table is UPSERTed on its primary key. Re-running replaces
the same rows in place. With WIPE_FIRST=1 the tables are emptied first
(child tables before parents) so removed rows don't linger.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None  # type: ignore

from supabase import Client, create_client


HERE = Path(__file__).resolve().parent
DEFAULT_DATA_DIR = HERE
BACKEND_ENV = HERE.parent / "backend" / ".env"

# Insert order respects FK dependencies.
INSERT_ORDER: list[tuple[str, str]] = [
    ("projects",                  "projects.json"),
    ("meetings",                  "meetings.json"),
    ("meeting_transcript_chunks", "meeting_transcript_chunks.json"),
    ("meeting_notes",             "meeting_notes.json"),
    ("project_context",           "project_context.json"),
    ("generation_runs",           "generation_runs.json"),
    ("knowledge_documents",       "knowledge_documents.json"),
    ("plan_items",                "plan_items.json"),
    ("generated_actions",         "generated_actions.json"),
]

# Reverse of INSERT_ORDER, used when WIPE_FIRST=1.
WIPE_ORDER = [t for t, _ in reversed(INSERT_ORDER)]


def _load_env() -> None:
    if load_dotenv and BACKEND_ENV.exists():
        load_dotenv(BACKEND_ENV)


def _client() -> Client:
    url = os.environ.get("SUPABASE_URL")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_SECRET_KEY")
        or os.environ.get("SUPABASE_KEY")
    )
    if not url or not key:
        sys.exit(
            "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set "
            "(via env or backend/.env)."
        )
    return create_client(url, key)


def _read(file_name: str, data_dir: Path) -> list[dict]:
    path = data_dir / file_name
    if not path.exists():
        print(f"  ! skipping {file_name} (not found)")
        return []
    with path.open() as f:
        rows = json.load(f)
    if not isinstance(rows, list):
        sys.exit(f"{file_name} must be a JSON array")
    return rows


def _wipe(sb: Client) -> None:
    print("Wiping tables (WIPE_FIRST=1)…")
    for table in WIPE_ORDER:
        # delete-all requires a where clause in PostgREST; this matches every row.
        sb.table(table).delete().neq("id", "00000000-0000-0000-0000-000000000000").execute()
        print(f"  - wiped {table}")


def main() -> None:
    _load_env()
    sb = _client()

    data_dir = Path(os.environ.get("DATA_DIR", DEFAULT_DATA_DIR))
    if os.environ.get("WIPE_FIRST") == "1":
        _wipe(sb)

    print(f"Seeding from {data_dir}/")
    for table, file_name in INSERT_ORDER:
        rows = _read(file_name, data_dir)
        if not rows:
            continue
        sb.table(table).upsert(rows, on_conflict="id").execute()
        print(f"  + {table}: {len(rows)} rows upserted")

    print("\nDone. Open the frontend → /projects to see them.")


if __name__ == "__main__":
    main()
