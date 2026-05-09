"""Assemble the briefing JSON returned by GET /context/briefing.

Cheap heuristics over the last 7 days of ``meeting_notes`` and
``project_context``:

  * ``themes``        — most-mentioned content_hashes / titles, top N
  * ``decisions``     — meeting_notes where ``type='decision'``
  * ``blockers``      — meeting_notes where ``type='blocker'``
  * ``active_files``  — distinct ``project_context`` rows from drive/notion,
                        sorted by source_updated_at desc
  * ``people``        — distinct authors across both sources

Everything is best-effort; missing inputs return empty arrays rather than 500.
The caller wraps this in a per-(project, day) cache so we don't recompute
constantly.
"""
from __future__ import annotations

import logging
from collections import Counter
from datetime import datetime, timedelta, timezone
from typing import Any

from supabase import Client

log = logging.getLogger(__name__)

LOOKBACK_DAYS = 7
MAX_THEMES = 8
MAX_ACTIVE_FILES = 12
MAX_PEOPLE = 12


def _iso_n_days_ago(n: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()


def build_briefing(sb: Client, project_id: str) -> dict[str, Any]:
    cutoff = _iso_n_days_ago(LOOKBACK_DAYS)

    notes = _safe_select(
        sb,
        sb.table("meeting_notes")
        .select("id,type,text,ts")
        .eq("project_id", project_id)
        .gte("ts", cutoff)
        .order("ts", desc=True)
        .limit(200),
    )
    context = _safe_select(
        sb,
        sb.table("project_context")
        .select(
            "id,source,title,snippet,author,ref_url,"
            "source_created_at,source_updated_at,ts"
        )
        .eq("project_id", project_id)
        .gte("ts", cutoff)
        .order("ts", desc=True)
        .limit(200),
    )

    decisions = [
        {"id": n["id"], "text": n.get("text"), "ts": n.get("ts")}
        for n in notes
        if n.get("type") == "decision"
    ]
    blockers = [
        {"id": n["id"], "text": n.get("text"), "ts": n.get("ts")}
        for n in notes
        if n.get("type") == "blocker"
    ]

    # Themes: title-frequency from project_context + first sentence of notes
    title_counter: Counter[str] = Counter()
    for row in context:
        t = (row.get("title") or "").strip()
        if t:
            title_counter[t] += 1
    theme_pairs = list(title_counter.most_common(MAX_THEMES))
    theme_labels = [label for label, _ in theme_pairs]

    active_files = [
        {
            "path": row.get("title") or row.get("ref_url"),
            "last_touched": row.get("source_updated_at") or row.get("ts"),
            # Backward-compatible aliases for older consumers.
            "id": row.get("id"),
            "source": row.get("source"),
            "title": row.get("title"),
            "ref_url": row.get("ref_url"),
            "updated_at": row.get("source_updated_at") or row.get("ts"),
        }
        for row in sorted(
            (r for r in context if r.get("source") in ("drive", "notion")),
            key=lambda r: r.get("source_updated_at") or r.get("ts") or "",
            reverse=True,
        )[:MAX_ACTIVE_FILES]
    ]

    people_counter: Counter[str] = Counter()
    for row in context:
        a = (row.get("author") or "").strip()
        if a:
            people_counter[a] += 1
    people_pairs = list(people_counter.most_common(MAX_PEOPLE))
    people = [name for name, _ in people_pairs]

    project_summary = _build_project_summary(
        themes=theme_labels,
        decisions=decisions,
        blockers=blockers,
        meeting_note_count=len(notes),
        context_count=len(context),
    )

    return {
        "id": project_id,
        "project_id": project_id,
        "project_summary": project_summary,
        "lookback_days": LOOKBACK_DAYS,
        # Keep legacy shape for backward compatibility.
        "themes": [{"label": label, "count": count} for label, count in theme_pairs],
        # Newer UIs can use this directly as string[].
        "theme_labels": theme_labels,
        "recent_decisions": [{"summary": d.get("text") or ""} for d in decisions[:8]],
        "open_threads": [{"label": b.get("text") or "", "source": "meeting", "count": 1} for b in blockers[:8]],
        "latest_docs": [
            {"title": row.get("title"), "url": row.get("ref_url")}
            for row in sorted(
                (r for r in context if r.get("source") in ("drive", "notion")),
                key=lambda r: r.get("source_updated_at") or r.get("ts") or "",
                reverse=True,
            )[:8]
        ],
        "active_files": active_files,
        "people": people,
        # Keep rich fields for backend consumers that already expect them.
        "theme_counts": [{"label": label, "count": count} for label, count in theme_pairs],
        "decisions": decisions[:20],
        "blockers": blockers[:20],
        "people_counts": [{"name": name, "mentions": n} for name, n in people_pairs],
        "counts": {
            "meeting_notes": len(notes),
            "project_context": len(context),
        },
    }


def _safe_select(sb: Client, query: Any) -> list[dict[str, Any]]:
    try:
        r = query.execute()
        return r.data or []
    except Exception as e:  # noqa: BLE001
        log.warning("briefing select failed: %s", e)
        return []


def _build_project_summary(
    *,
    themes: list[str],
    decisions: list[dict[str, Any]],
    blockers: list[dict[str, Any]],
    meeting_note_count: int,
    context_count: int,
) -> str:
    top_themes = ", ".join(themes[:3]) or "general engineering updates"
    return (
        f"Recent focus: {top_themes}. "
        f"Captured {meeting_note_count} meeting notes and {context_count} context docs in the last {LOOKBACK_DAYS} days, "
        f"with {len(decisions)} decisions and {len(blockers)} active blockers."
    )
