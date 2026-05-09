"""POST /ingest/hyperspell — pull Slack/Drive/Notion/Gmail items, embed, upsert."""
from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from supabase import Client

from dependencies import get_supabase, require_demo_token
from services import embeddings, hyperspell, supabase_writer

router = APIRouter(prefix="/ingest", tags=["ingest"])
log = logging.getLogger(__name__)


class IngestBody(BaseModel):
    projectId: str


class IngestResponse(BaseModel):
    inserted: int
    skipped_dupes: int
    by_source: dict[str, int]


# A neutral query that surfaces project planning content. Hyperspell ranks against
# the user's connected sources without us having to invent specific queries.
DEFAULT_QUERY = (
    "latest project planning context, decisions, blockers, design docs, "
    "discussions, tasks, bug reports"
)


@router.post(
    "/hyperspell",
    response_model=IngestResponse,
    dependencies=[Depends(require_demo_token)],
)
async def ingest_hyperspell(
    body: IngestBody,
    sb: Client = Depends(get_supabase),
) -> IngestResponse:
    """Search Hyperspell across Slack/Drive/Notion/Gmail and UPSERT into project_context.

    Embeds each item with text-embedding-3-small. Idempotent via the unique
    indexes on (project_id, source, external_id) and (project_id, source, content_hash).
    """
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    user_id = project.get("hyperspell_user_id") or f"pri-{body.projectId}"
    if not project.get("hyperspell_user_id"):
        supabase_writer.set_hyperspell_user_id(sb, body.projectId, user_id)

    # 1) Pull items from Hyperspell
    try:
        items = await hyperspell.search(
            hyperspell_user_id=user_id,
            query=DEFAULT_QUERY,
            db_sources=["slack", "drive", "notion", "gmail"],
            k=20,
        )
    except RuntimeError as e:
        # SDK / key not configured — surface clearly so it's debuggable.
        raise HTTPException(503, f"hyperspell not available: {e}")

    if not items:
        return IngestResponse(inserted=0, skipped_dupes=0, by_source={})

    # 2) Embed in parallel
    texts = [it.full_text for it in items]
    try:
        vectors = await embeddings.embed_many(texts)
    except Exception as e:
        log.exception("embedding failed")
        raise HTTPException(503, f"embedding failed: {e}")

    # 3) Build rows with content_hash for dedup
    rows: list[dict[str, Any]] = []
    by_source: dict[str, int] = {}
    for it, vec in zip(items, vectors):
        content_hash = hashlib.sha256(it.full_text.encode("utf-8")).hexdigest()
        rows.append(
            {
                "project_id": body.projectId,
                "source": it.source,
                "external_id": it.external_id,
                "title": it.title,
                "snippet": (it.snippet or "")[:500] or None,
                "full_text": it.full_text,
                "content_hash": content_hash,
                "author": it.author,
                "ref_url": it.ref_url,
                "source_created_at": it.source_created_at,
                "source_updated_at": it.source_updated_at,
                "embedding": vec,
            }
        )
        by_source[it.source] = by_source.get(it.source, 0) + 1

    # 4) UPSERT
    counts = supabase_writer.upsert_project_context(sb, rows)

    return IngestResponse(
        inserted=counts["with_external"] + counts["with_hash"],
        skipped_dupes=0,  # PostgREST doesn't tell us; treat all as upserts
        by_source=by_source,
    )
