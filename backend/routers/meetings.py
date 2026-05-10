"""POST /meetings — create a meeting row.

Public endpoint (no demo-token gate) because the frontend "+ New" button can't
safely hold a server secret. Uses the service-role Supabase client to bypass
the meetings-table RLS, which only grants anon SELECT.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from supabase import Client

from dependencies import get_supabase
from services import supabase_writer

router = APIRouter(prefix="/meetings", tags=["meetings"])
log = logging.getLogger(__name__)


class CreateMeetingBody(BaseModel):
    projectId: str
    title: str = Field(default="Live meeting")


class MeetingRow(BaseModel):
    id: str
    project_id: str
    title: str | None
    status: str | None
    started_at: str | None


@router.post("", response_model=MeetingRow)
def create_meeting(
    body: CreateMeetingBody, sb: Client = Depends(get_supabase)
) -> MeetingRow:
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    payload = {
        "project_id": body.projectId,
        "title": body.title or "Live meeting",
        "status": "live",
        "started_at": datetime.now(timezone.utc).isoformat(),
    }
    result = sb.table("meetings").insert(payload).execute()
    if not result.data:
        raise HTTPException(500, "failed to create meeting")

    row = result.data[0]
    return MeetingRow(
        id=str(row["id"]),
        project_id=str(row["project_id"]),
        title=row.get("title"),
        status=row.get("status"),
        started_at=_iso(row.get("started_at")),
    )


def _iso(value: object) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()  # type: ignore[no-any-return]
    return str(value)
