"""Thin wrappers for the small handful of Supabase writes the backend does."""
from __future__ import annotations

from typing import Any, Iterable

from supabase import Client


def upsert_project_context(
    sb: Client,
    rows: Iterable[dict[str, Any]],
    *,
    on_conflict: str = "project_id,source,external_id",
) -> dict[str, int]:
    """Bulk UPSERT into project_context. Idempotent on the conflict target.

    Returns counts. Splits rows by available conflict key when external_id is null.
    """
    rows = list(rows)
    if not rows:
        return {"with_external": 0, "with_hash": 0}

    with_ext = [r for r in rows if r.get("external_id")]
    no_ext = [r for r in rows if not r.get("external_id")]

    if with_ext:
        sb.table("project_context").upsert(
            with_ext, on_conflict="project_id,source,external_id"
        ).execute()
    if no_ext:
        # rows lacking external_id dedupe via content_hash
        sb.table("project_context").upsert(
            no_ext, on_conflict="project_id,source,content_hash"
        ).execute()

    return {"with_external": len(with_ext), "with_hash": len(no_ext)}


def get_project(sb: Client, project_id: str) -> dict[str, Any] | None:
    # Avoid .maybe_single() — supabase-py returns None instead of a response
    # when no rows match (rather than an empty .data list), which crashes downstream.
    r = sb.table("projects").select("*").eq("id", project_id).limit(1).execute()
    rows = r.data or []
    return rows[0] if rows else None


def set_hyperspell_user_id(sb: Client, project_id: str, hyperspell_user_id: str) -> None:
    sb.table("projects").update({"hyperspell_user_id": hyperspell_user_id}).eq(
        "id", project_id
    ).execute()


def project_context_sources_present(sb: Client, project_id: str) -> set[str]:
    """Heuristic for /connect/status when Hyperspell SDK doesn't expose it."""
    r = (
        sb.table("project_context")
        .select("source")
        .eq("project_id", project_id)
        .execute()
    )
    return {row["source"] for row in (r.data or [])}
