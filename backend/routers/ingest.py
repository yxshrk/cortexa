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
    upserted: int
    by_source: dict[str, int]
    errors: dict[str, str] = {}  # {db_source: error_message} for sources that failed


# A neutral query that surfaces project planning content. Hyperspell ranks against
# the user's connected sources without us having to invent specific queries.
#
# NOTE: this is the "ranking-supplement" mirror path. The durable mirror (using
# memories.list per source) is planned in the next PR — see Codex review notes
# in individual_plan/yash_backend_execution_plan.md §3 ("Make ingestion mirror-first").
DEFAULT_QUERY = (
    "latest project planning context, decisions, blockers, design docs, "
    "discussions, tasks, bug reports"
)
PER_SOURCE_K = 20

# Sources we mirror into project_context. Derived from the canonical
# Hyperspell↔DB mapping so we never iterate sources Hyperspell doesn't expose.
# Currently: ('drive', 'notion', 'slack'). Gmail is in our DB enum but not
# in Hyperspell's integration list; github is code_refs-only, not mirrored.
DB_SOURCES: tuple[str, ...] = tuple(sorted(hyperspell.HS_TO_DB_SOURCE.values()))


@router.post(
    "/hyperspell",
    response_model=IngestResponse,
    dependencies=[Depends(require_demo_token)],
)
async def ingest_hyperspell(
    body: IngestBody,
    sb: Client = Depends(get_supabase),
) -> IngestResponse:
    """Search Hyperspell PER SOURCE and UPSERT into project_context.

    Iterating per source (rather than one merged search across all four)
    prevents Hyperspell's ranker from biasing the result set toward whichever
    source happens to dominate — without it, a Slack-heavy account could see
    Drive items disappear from the mirror.

    Embeds each item with text-embedding-3-small. Idempotent via the unique
    indexes on (project_id, source, external_id) and (project_id, source, content_hash).
    """
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    user_id = project.get("hyperspell_user_id") or f"pri-{body.projectId}"
    if not project.get("hyperspell_user_id"):
        supabase_writer.set_hyperspell_user_id(sb, body.projectId, user_id)

    # 1) Per-source pulls in parallel. Each one can fail independently.
    async def _pull(db_src: str) -> tuple[str, list[Any], str | None]:
        try:
            items = await hyperspell.search(
                hyperspell_user_id=user_id,
                query=DEFAULT_QUERY,
                db_sources=[db_src],
                k=PER_SOURCE_K,
            )
            return db_src, items, None
        except RuntimeError as e:
            return db_src, [], f"sdk/key: {e}"
        except Exception as e:
            log.warning("ingest pull failed for %s: %s", db_src, e)
            return db_src, [], f"{type(e).__name__}: {e}"

    pulls = await asyncio.gather(*[_pull(s) for s in DB_SOURCES])

    all_items: list[Any] = []
    by_source: dict[str, int] = {}
    errors: dict[str, str] = {}
    for db_src, items, err in pulls:
        if err:
            errors[db_src] = err
        if items:
            by_source[db_src] = len(items)
            all_items.extend(items)

    if not all_items:
        return IngestResponse(upserted=0, by_source={}, errors=errors)

    # 2) Embed in parallel (single batched call)
    texts = [it.full_text for it in all_items]
    try:
        vectors = await embeddings.embed_many(texts)
    except Exception as e:
        log.exception("embedding failed")
        raise HTTPException(503, f"embedding failed: {e}")

    # 3) Build rows with content_hash for dedup
    rows: list[dict[str, Any]] = []
    for it, vec in zip(all_items, vectors):
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

    # 4) UPSERT
    counts = supabase_writer.upsert_project_context(sb, rows)

    return IngestResponse(
        upserted=counts["with_external"] + counts["with_hash"],
        by_source=by_source,
        errors=errors,
    )
