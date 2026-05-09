"""Thin wrappers for the small handful of Supabase writes the backend does."""
from __future__ import annotations

import logging
from typing import Any, Iterable

from supabase import Client

log = logging.getLogger(__name__)


def upsert_project_context(
    sb: Client,
    rows: Iterable[dict[str, Any]],
) -> dict[str, int]:
    """Idempotent upsert into project_context.

    The schema has TWO partial unique indexes:
        (project_id, source, external_id) WHERE external_id IS NOT NULL
        (project_id, source, content_hash) WHERE content_hash IS NOT NULL

    PostgREST/Supabase ``upsert(on_conflict=...)`` cannot reliably target a
    partial unique index by column list — and even when it can, a row that
    carries BOTH an external_id and a content_hash can still collide on the
    second index when the sender retries with the same body. We therefore
    do explicit select-then-update-or-insert per row:

        1. If external_id is set, look up by (project_id, source, external_id).
           Found → UPDATE that row's content fields.
        2. Else look up by (project_id, source, content_hash).
           Found → UPDATE that row.
        3. Otherwise INSERT.

    Returns counts: ``{"inserted", "updated", "errors"}``.
    """
    rows = list(rows)
    counts = {"inserted": 0, "updated": 0, "errors": 0}
    if not rows:
        return counts

    for row in rows:
        try:
            existing_id = _find_existing_id(sb, row)
            if existing_id:
                update_payload = {k: v for k, v in row.items() if k != "project_id"}
                sb.table("project_context").update(update_payload).eq(
                    "id", existing_id
                ).execute()
                counts["updated"] += 1
            else:
                sb.table("project_context").insert(row).execute()
                counts["inserted"] += 1
        except Exception as e:  # noqa: BLE001 — best-effort per-row, keep batch alive
            counts["errors"] += 1
            log.warning(
                "project_context upsert row failed (project=%s source=%s ext=%s): %s",
                row.get("project_id"),
                row.get("source"),
                row.get("external_id"),
                e,
            )

    return counts


def _find_existing_id(sb: Client, row: dict[str, Any]) -> str | None:
    """Look up a matching project_context row id, preferring external_id."""
    project_id = row["project_id"]
    source = row["source"]
    external_id = row.get("external_id")
    content_hash = row.get("content_hash")

    if external_id:
        r = (
            sb.table("project_context")
            .select("id")
            .eq("project_id", project_id)
            .eq("source", source)
            .eq("external_id", external_id)
            .limit(1)
            .execute()
        )
        if r.data:
            return r.data[0]["id"]

    if content_hash:
        r = (
            sb.table("project_context")
            .select("id")
            .eq("project_id", project_id)
            .eq("source", source)
            .eq("content_hash", content_hash)
            .limit(1)
            .execute()
        )
        if r.data:
            return r.data[0]["id"]

    return None


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
