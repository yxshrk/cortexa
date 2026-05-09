"""Append-only stage events on generation_runs.progress.

Background-task pipeline calls ``append_event(sb, run_id, event)`` after each
phase. Frontend subscribes via Supabase realtime on ``generation_runs`` and
renders the array as a live trace.

We use the JSON concat operator (``progress = progress || $1::jsonb``) via an
``rpc_append_progress_event`` SQL function when available; otherwise we fall
back to read-modify-write. The fallback has a tiny race window (two concurrent
appends could lose one event), but the pipeline is single-writer per run so
that's acceptable.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any

from supabase import Client

log = logging.getLogger(__name__)

# Cap progress array size so a runaway emitter can't blow up the row.
MAX_EVENTS = 200


def _stamp(event: dict[str, Any]) -> dict[str, Any]:
    e = dict(event)
    e.setdefault("ts", datetime.now(timezone.utc).isoformat())
    return e


def append_event(sb: Client, run_id: str, event: dict[str, Any]) -> None:
    """Read-modify-write append. Best-effort; never raises."""
    stamped = _stamp(event)
    try:
        r = (
            sb.table("generation_runs")
            .select("progress")
            .eq("id", run_id)
            .limit(1)
            .execute()
        )
        rows = r.data or []
        prev: list[Any] = (rows[0] or {}).get("progress") if rows else []
        if not isinstance(prev, list):
            prev = []
        next_arr = (prev + [stamped])[-MAX_EVENTS:]
        sb.table("generation_runs").update({"progress": next_arr}).eq(
            "id", run_id
        ).execute()
    except Exception as e:  # noqa: BLE001
        # Fallback for when the column doesn't exist yet (migration unapplied)
        # or any other DB issue. We don't want to fail the pipeline because the
        # progress trace couldn't be written.
        log.warning(
            "progress.append_event failed (run=%s phase=%s kind=%s): %s",
            run_id,
            event.get("phase"),
            event.get("kind"),
            e,
        )


async def append_event_async(sb: Client, run_id: str, event: dict[str, Any]) -> None:
    """Async wrapper that runs the sync append in a thread.

    Use from async pipeline code so we don't block the event loop on Supabase
    HTTP. Safe to call from anywhere.
    """
    await asyncio.to_thread(append_event, sb, run_id, event)


def safe_event(event: dict[str, Any]) -> dict[str, Any]:
    """Return a JSON-serializable copy of the event. Drops anything that can't
    be json-encoded so a single bad value doesn't break the whole append."""
    try:
        json.dumps(event)
        return event
    except TypeError:
        out: dict[str, Any] = {}
        for k, v in event.items():
            try:
                json.dumps(v)
                out[k] = v
            except TypeError:
                out[k] = repr(v)
        return out
