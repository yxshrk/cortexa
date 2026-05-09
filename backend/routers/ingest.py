"""POST /ingest/hyperspell — mirror Slack/Drive/Notion items, embed, upsert.

Mirror-first: for each connected source we page ``memories.list(source=...,
status="completed")`` and then ``memories.get`` each item to extract full text.
This is the durable mirror — every completed resource Hyperspell knows about
ends up in ``project_context`` (modulo the per-source page cap).

We also fold in a small ranked supplement via ``memories.search`` so any items
the ranker considers especially relevant to "latest planning context" are
prioritized for re-embedding even if the list page would have missed them.
Items that show up in both pulls collapse on (project_id, source, external_id).
"""
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
    inserted: int
    updated: int
    by_source: dict[str, int]
    errors: dict[str, str] = {}  # {db_source: error_message} for sources that failed
    write_errors: int = 0  # per-row failures during the supabase write step


# Mirror cap: at most this many resources per source per ingest run. Keeps
# memories.get fan-out bounded and avoids embedding multi-thousand-row dumps
# on a single demo machine.
PER_SOURCE_MIRROR_CAP = 100

# Optional ranked supplement: a small ranking-biased pull that runs alongside
# the mirror. Set to 0 to disable; small enough that mirror dedup absorbs it.
PER_SOURCE_RANKED_SUPPLEMENT_K = 8
RANKED_SUPPLEMENT_QUERY = (
    "latest project planning context, decisions, blockers, design docs, "
    "discussions, tasks, bug reports"
)

# Sources we mirror into project_context. Derived from the canonical
# Hyperspell↔DB mapping so we never iterate sources Hyperspell doesn't expose.
# Currently: ('drive', 'notion', 'slack'). Gmail is in our DB enum but not
# in Hyperspell's integration list; github is code_refs-only, not mirrored.
DB_SOURCES: tuple[str, ...] = tuple(sorted(hyperspell.HS_TO_DB_SOURCE.values()))


def _item_dedup_key(it: Any) -> tuple[str, str]:
    """Within a single ingest run, prefer external_id; fall back to content hash."""
    if it.external_id:
        return (it.source, f"ext:{it.external_id}")
    return (it.source, "hash:" + hashlib.sha256(it.full_text.encode("utf-8")).hexdigest())


@router.post(
    "/hyperspell",
    response_model=IngestResponse,
    dependencies=[Depends(require_demo_token)],
)
async def ingest_hyperspell(
    body: IngestBody,
    sb: Client = Depends(get_supabase),
) -> IngestResponse:
    """Mirror Hyperspell PER SOURCE into project_context.

    For each supported source we run two pulls in parallel:
      * ``hyperspell.list_and_fetch`` — durable mirror (memories.list + get).
      * ``hyperspell.search``        — small ranked supplement so freshly-relevant
                                       items still re-embed even if the mirror
                                       page didn't reach them.

    Items are deduped by (source, external_id|content_hash) within the run, then
    embedded in one batched call and UPSERTed into ``project_context``. Idempotent
    across runs via the unique indexes on
    ``(project_id, source, external_id)`` and ``(project_id, source, content_hash)``.
    """
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    user_id = project.get("hyperspell_user_id") or f"pri-{body.projectId}"
    if not project.get("hyperspell_user_id"):
        supabase_writer.set_hyperspell_user_id(sb, body.projectId, user_id)

    async def _mirror(db_src: str) -> list[Any]:
        return await hyperspell.list_and_fetch(
            hyperspell_user_id=user_id,
            db_source=db_src,
            max_items=PER_SOURCE_MIRROR_CAP,
        )

    async def _supplement(db_src: str) -> list[Any]:
        if PER_SOURCE_RANKED_SUPPLEMENT_K <= 0:
            return []
        return await hyperspell.search(
            hyperspell_user_id=user_id,
            query=RANKED_SUPPLEMENT_QUERY,
            db_sources=[db_src],
            k=PER_SOURCE_RANKED_SUPPLEMENT_K,
        )

    async def _pull(db_src: str) -> tuple[str, list[Any], str | None]:
        try:
            mirror_task = asyncio.create_task(_mirror(db_src))
            supp_task = asyncio.create_task(_supplement(db_src))
            mirror_items, supp_items = await asyncio.gather(
                mirror_task, supp_task, return_exceptions=False
            )
        except RuntimeError as e:
            return db_src, [], f"sdk/key: {e}"
        except Exception as e:
            log.warning("ingest pull failed for %s: %s", db_src, e)
            return db_src, [], f"{type(e).__name__}: {e}"

        # Merge with the mirror as the canonical body; supplement only adds items
        # the mirror page didn't reach.
        seen: set[tuple[str, str]] = set()
        merged: list[Any] = []
        for it in mirror_items + supp_items:
            key = _item_dedup_key(it)
            if key in seen:
                continue
            seen.add(key)
            merged.append(it)
        return db_src, merged, None

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
        return IngestResponse(
            upserted=0,
            inserted=0,
            updated=0,
            by_source={},
            errors=errors,
        )

    # Embed in one batched call.
    texts = [it.full_text for it in all_items]
    try:
        vectors = await embeddings.embed_many(texts)
    except Exception as e:
        log.exception("embedding failed")
        raise HTTPException(503, f"embedding failed: {e}")

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

    counts = supabase_writer.upsert_project_context(sb, rows)

    return IngestResponse(
        upserted=counts["inserted"] + counts["updated"],
        inserted=counts["inserted"],
        updated=counts["updated"],
        by_source=by_source,
        errors=errors,
        write_errors=counts["errors"],
    )
