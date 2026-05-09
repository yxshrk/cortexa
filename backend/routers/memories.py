"""Hyperspell memory operations exposed to the frontend.

Five endpoints, all scoped to a project (resolved → hyperspell_user_id):

  POST   /memories/add        — push arbitrary text to the user's vault
  POST   /memories/upload     — multipart file upload to the vault
  GET    /memories/status     — per-provider indexing progress
  POST   /memories/web-crawl  — index a website (source = web_crawler)
  POST   /memories/session    — store a transcript / agent trace

These are thin wrappers over the SDK. They do **not** mirror into Supabase —
that's `/ingest/hyperspell`'s job. Run that to pull-and-embed after you've
added new memories you want in `project_context`.
"""
from __future__ import annotations

import json
import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from supabase import Client

from dependencies import get_supabase, require_demo_token
from services import hyperspell, supabase_writer

router = APIRouter(prefix="/memories", tags=["memories"])
log = logging.getLogger(__name__)


def _resolve_user_id(sb: Client, project_id: str) -> str:
    """Resolve project → hyperspell_user_id, lazily provisioning if absent."""
    project = supabase_writer.get_project(sb, project_id)
    if not project:
        raise HTTPException(404, f"project {project_id} not found")
    user_id = project.get("hyperspell_user_id")
    if not user_id:
        user_id = f"pri-{project_id}"
        supabase_writer.set_hyperspell_user_id(sb, project_id, user_id)
    return user_id


# ─── POST /memories/add ───────────────────────────────────────────────────────
class AddBody(BaseModel):
    projectId: str
    text: str = Field(..., min_length=1)
    title: str | None = None
    collection: str | None = None
    metadata: dict[str, Any] | None = None


@router.post(
    "/add",
    dependencies=[Depends(require_demo_token)],
    summary="Push arbitrary text into the project's Hyperspell vault",
)
async def add_memory(body: AddBody, sb: Client = Depends(get_supabase)) -> dict[str, Any]:
    user_id = _resolve_user_id(sb, body.projectId)
    try:
        return await hyperspell.memory_add(
            hyperspell_user_id=user_id,
            text=body.text,
            title=body.title,
            collection=body.collection,
            metadata=body.metadata,
        )
    except Exception as e:
        log.exception("memories.add failed")
        raise HTTPException(502, f"hyperspell add failed: {e}")


# ─── POST /memories/upload ────────────────────────────────────────────────────
@router.post(
    "/upload",
    dependencies=[Depends(require_demo_token)],
    summary="Upload a file to the project's Hyperspell vault",
)
async def upload_memory(
    projectId: str = Form(...),
    file: UploadFile = File(...),
    collection: str | None = Form(default=None),
    metadata: str | None = Form(
        default=None,
        description="Optional JSON-encoded metadata string (Hyperspell expects a string here).",
    ),
    sb: Client = Depends(get_supabase),
) -> dict[str, Any]:
    user_id = _resolve_user_id(sb, projectId)
    content = await file.read()
    if not content:
        raise HTTPException(400, "uploaded file is empty")
    if metadata is not None:
        # Validate it's parseable so we fail fast rather than letting Hyperspell reject.
        try:
            json.loads(metadata)
        except json.JSONDecodeError as e:
            raise HTTPException(400, f"metadata must be a JSON string: {e}")
    try:
        return await hyperspell.memory_upload(
            hyperspell_user_id=user_id,
            filename=file.filename or "upload.bin",
            content=content,
            content_type=file.content_type,
            collection=collection,
            metadata=metadata,
        )
    except Exception as e:
        log.exception("memories.upload failed")
        raise HTTPException(502, f"hyperspell upload failed: {e}")


# ─── GET /memories/status ─────────────────────────────────────────────────────
@router.get(
    "/status",
    summary="Per-provider indexing progress for the project",
)
async def status(projectId: str, sb: Client = Depends(get_supabase)) -> dict[str, Any]:
    user_id = _resolve_user_id(sb, projectId)
    try:
        return await hyperspell.memory_status(user_id)
    except Exception as e:
        log.warning("memories.status failed: %s", e)
        raise HTTPException(502, f"hyperspell status failed: {e}")


# ─── POST /memories/web-crawl ─────────────────────────────────────────────────
class WebCrawlBody(BaseModel):
    projectId: str
    url: str
    limit: int | None = Field(default=None, ge=1, le=500)
    max_depth: int | None = Field(default=None, ge=1, le=5)


@router.post(
    "/web-crawl",
    dependencies=[Depends(require_demo_token)],
    summary="Recursively crawl a URL into Hyperspell (source = web_crawler)",
)
async def web_crawl(
    body: WebCrawlBody, sb: Client = Depends(get_supabase)
) -> dict[str, Any]:
    user_id = _resolve_user_id(sb, body.projectId)
    try:
        return await hyperspell.web_crawl(
            hyperspell_user_id=user_id,
            url=body.url,
            limit=body.limit,
            max_depth=body.max_depth,
        )
    except Exception as e:
        log.exception("web_crawler.index failed")
        raise HTTPException(502, f"hyperspell crawl failed: {e}")


# ─── POST /memories/session ───────────────────────────────────────────────────
ExtractMode = Literal["procedure", "memory", "mood"]
SessionFormat = Literal["vercel", "hyperdoc", "openclaw"]


class SessionBody(BaseModel):
    projectId: str
    # Either a list of {role, content} dicts (we'll JSON-encode for you) or an
    # already-JSON-encoded string. Plain text is NOT accepted — Hyperspell rejects.
    history: str | list[dict[str, Any]] = Field(...)
    format: SessionFormat = Field(
        default="vercel",
        description="Transcript shape. Default 'vercel' = [{role, content}, ...].",
    )
    title: str | None = None
    extract: list[ExtractMode] | None = Field(
        default=None,
        description="Hyperspell-side extraction. Subset of {procedure, memory, mood}.",
    )
    session_id: str | None = None
    metadata: dict[str, Any] | None = None


@router.post(
    "/session",
    dependencies=[Depends(require_demo_token)],
    summary="Store a meeting transcript / agent trace in Hyperspell",
)
async def add_session(
    body: SessionBody, sb: Client = Depends(get_supabase)
) -> dict[str, Any]:
    user_id = _resolve_user_id(sb, body.projectId)
    try:
        return await hyperspell.session_add(
            hyperspell_user_id=user_id,
            history=body.history,
            format=body.format,
            title=body.title,
            extract=body.extract,
            session_id=body.session_id,
            metadata=body.metadata,
        )
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        log.exception("sessions.add failed")
        raise HTTPException(502, f"hyperspell session failed: {e}")
