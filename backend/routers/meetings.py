"""Meeting CRUD: start a new live meeting + end an existing one.

Browser anon role can SELECT from `meetings` (Jin's RLS policy) but cannot
INSERT — so the voice agent's frontend can't create a meeting on its own.
This router exposes a thin auth-gated wrapper that uses the service-role
client to create + end meetings, so the Meeting Notes UI can offer a
"+ New" button.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from supabase import Client

from dependencies import get_supabase, require_demo_token
from services import supabase_writer

router = APIRouter(prefix="/meetings", tags=["meetings"])
log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class StartMeetingBody(BaseModel):
    projectId: str
    title: str | None = None


class MeetingResponse(BaseModel):
    id: str
    project_id: str
    title: str | None
    status: str
    started_at: str | None
    ended_at: str | None


@router.post(
    "/start",
    response_model=MeetingResponse,
    dependencies=[Depends(require_demo_token)],
)
def start_meeting(
    body: StartMeetingBody,
    sb: Client = Depends(get_supabase),
) -> MeetingResponse:
    """Insert a new `meetings` row in `live` status. The voice agent will
    write `meeting_notes` and `meeting_transcript_chunks` against this id."""
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    title = (body.title or _default_title()).strip() or _default_title()
    row = {
        "project_id": body.projectId,
        "title": title,
        "started_at": _now_iso(),
        "status": "live",
    }
    try:
        r = sb.table("meetings").insert(row).execute()
    except Exception as e:  # noqa: BLE001
        log.exception("meetings insert failed")
        raise HTTPException(500, f"meetings insert failed: {e}")

    rows = r.data or []
    if not rows:
        raise HTTPException(500, "meetings insert returned no row")
    return _to_response(rows[0])


@router.post(
    "/{meeting_id}/end",
    response_model=MeetingResponse,
    dependencies=[Depends(require_demo_token)],
)
def end_meeting(
    meeting_id: str,
    sb: Client = Depends(get_supabase),
) -> MeetingResponse:
    """Flip a meeting to `ended` and stamp `ended_at`. Idempotent."""
    existing = (
        sb.table("meetings").select("*").eq("id", meeting_id).limit(1).execute()
    )
    rows = existing.data or []
    if not rows:
        raise HTTPException(404, f"meeting {meeting_id} not found")
    current = rows[0]

    if current.get("status") == "ended":
        return _to_response(current)

    r = (
        sb.table("meetings")
        .update({"status": "ended", "ended_at": _now_iso()})
        .eq("id", meeting_id)
        .execute()
    )
    updated = (r.data or [{}])[0]
    return _to_response(updated or current)


def _default_title() -> str:
    return f"Meeting · {datetime.now(timezone.utc).strftime('%a %b %d %H:%M UTC')}"


def _to_response(row: dict[str, Any]) -> MeetingResponse:
    return MeetingResponse(
        id=str(row.get("id") or ""),
        project_id=str(row.get("project_id") or ""),
        title=row.get("title"),
        status=str(row.get("status") or "live"),
        started_at=_iso(row.get("started_at")),
        ended_at=_iso(row.get("ended_at")),
    )


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)
