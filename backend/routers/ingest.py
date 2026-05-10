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
from datetime import date, datetime, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from supabase import Client

from dependencies import get_supabase, require_demo_token
from services import embeddings, hyperspell, progress, supabase_writer

router = APIRouter(prefix="/ingest", tags=["ingest"])
log = logging.getLogger(__name__)

# Coarse phase weights so the bar advances smoothly during a run. The chunking
# itself is CPU-cheap; the slow bits are network (Hyperspell pulls + OpenAI
# embed + Supabase upsert), so phase-based percent tracks user-perceived time.
PCT_LOAD_START = 5
PCT_LOAD_END = 55
PCT_EMBED_START = 60
PCT_EMBED_END = 80
PCT_UPSERT_END = 95
PCT_DONE = 100


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _is_unique_violation(err: Exception) -> bool:
    text = repr(err).lower()
    return "23505" in text or "duplicate key" in text or "unique constraint" in text


class IngestBody(BaseModel):
    projectId: str


class IngestStartResponse(BaseModel):
    runId: str
    status: str
    started_at: str


class DeleteDocumentResponse(BaseModel):
    deleted: bool
    id: str


@router.delete(
    "/document/{document_id}",
    response_model=DeleteDocumentResponse,
    dependencies=[Depends(require_demo_token)],
)
def delete_project_context_document(
    document_id: str,
    sb: Client = Depends(get_supabase),
) -> DeleteDocumentResponse:
    """Delete a single project_context row.

    Service-role only so RLS doesn't block, and we can confirm the row
    existed before reporting success. Re-running ingest will re-pull it
    from Hyperspell, which is the intended escape hatch.
    """
    existing = sb.table("project_context").select("id").eq("id", document_id).limit(1).execute()
    if not (existing.data or []):
        raise HTTPException(404, f"document {document_id} not found")
    sb.table("project_context").delete().eq("id", document_id).execute()
    return DeleteDocumentResponse(deleted=True, id=document_id)


class IngestResponse(BaseModel):
    upserted: int
    inserted: int
    updated: int
    by_source: dict[str, int]
    errors: dict[str, str] = {}  # {db_source: error_message} for sources that failed
    write_errors: int = 0  # per-row failures during the supabase write step
    metrics: dict[str, Any] = {}


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

    async def _pull(db_src: str) -> tuple[str, list[Any], str | None, dict[str, int]]:
        try:
            mirror_task = asyncio.create_task(_mirror(db_src))
            supp_task = asyncio.create_task(_supplement(db_src))
            mirror_items, supp_items = await asyncio.gather(
                mirror_task, supp_task, return_exceptions=False
            )
        except RuntimeError as e:
            return db_src, [], f"sdk/key: {e}", {
                "mirror_count": 0,
                "supplement_count": 0,
                "deduped_within_source": 0,
            }
        except Exception as e:
            log.warning("ingest pull failed for %s: %s", db_src, e)
            return db_src, [], f"{type(e).__name__}: {e}", {
                "mirror_count": 0,
                "supplement_count": 0,
                "deduped_within_source": 0,
            }

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
        return db_src, merged, None, {
            "mirror_count": len(mirror_items),
            "supplement_count": len(supp_items),
            "deduped_within_source": (len(mirror_items) + len(supp_items)) - len(merged),
        }

    pulls = await asyncio.gather(*[_pull(s) for s in DB_SOURCES])

    all_items: list[Any] = []
    by_source: dict[str, int] = {}
    errors: dict[str, str] = {}
    source_pull_stats: dict[str, dict[str, int]] = {}
    for db_src, items, err, pull_stats in pulls:
        source_pull_stats[db_src] = pull_stats
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
            metrics={
                "documents_total": 0,
                "sources_attempted": len(DB_SOURCES),
                "sources_with_errors": len(errors),
                "by_source_pull": source_pull_stats,
            },
        )

    # Embed in one batched call using chunk-aware representations for long docs.
    texts = [hyperspell.build_embedding_text(it.full_text) for it in all_items]
    try:
        vectors = await embeddings.embed_many(texts)
    except Exception as e:
        log.exception("embedding failed")
        raise HTTPException(503, f"embedding failed: {e}")

    rows: list[dict[str, Any]] = []
    row_text_stats: list[dict[str, Any]] = []
    for it, vec, emb_text in zip(all_items, vectors, texts):
        content_hash = hashlib.sha256(it.full_text.encode("utf-8")).hexdigest()
        rows.append(
            {
                "project_id": body.projectId,
                "source": it.source,
                "external_id": it.external_id,
                "title": it.title,
                "snippet": hyperspell.build_snippet(it.snippet or it.full_text) or None,
                "full_text": it.full_text,
                "content_hash": content_hash,
                "author": it.author,
                "ref_url": it.ref_url,
                "source_created_at": it.source_created_at,
                "source_updated_at": it.source_updated_at,
                "embedding": vec,
            }
        )
        stats = hyperspell.chunking_stats(it.full_text, emb_text)
        stats["source"] = it.source
        stats["snippet_chars"] = len((it.snippet or "")[:500])
        row_text_stats.append(stats)

    counts = supabase_writer.upsert_project_context(sb, rows)
    metrics = _build_ingest_metrics(row_text_stats, source_pull_stats, errors)

    return IngestResponse(
        upserted=counts["inserted"] + counts["updated"],
        inserted=counts["inserted"],
        updated=counts["updated"],
        by_source=by_source,
        errors=errors,
        write_errors=counts["errors"],
        metrics=metrics,
    )


def _build_ingest_metrics(
    row_text_stats: list[dict[str, Any]],
    source_pull_stats: dict[str, dict[str, int]],
    errors: dict[str, str],
) -> dict[str, Any]:
    if not row_text_stats:
        return {
            "documents_total": 0,
            "sources_with_errors": len(errors),
            "by_source_pull": source_pull_stats,
        }

    full_total = sum(int(r["full_chars"]) for r in row_text_stats)
    emb_total = sum(int(r["embedding_chars"]) for r in row_text_stats)
    truncated = sum(1 for r in row_text_stats if bool(r["truncated_for_embedding"]))
    short_rows = sum(1 for r in row_text_stats if int(r["full_chars"]) < 120)
    total_chunks = sum(int(r["chunk_count_total"]) for r in row_text_stats)
    selected_chunks = sum(int(r["chunk_count_selected"]) for r in row_text_stats)

    by_source: dict[str, dict[str, Any]] = {}
    for src in sorted({str(r["source"]) for r in row_text_stats}):
        src_rows = [r for r in row_text_stats if r["source"] == src]
        src_full = sum(int(r["full_chars"]) for r in src_rows)
        src_emb = sum(int(r["embedding_chars"]) for r in src_rows)
        src_trunc = sum(1 for r in src_rows if bool(r["truncated_for_embedding"]))
        src_chunks_total = sum(int(r["chunk_count_total"]) for r in src_rows)
        src_chunks_selected = sum(int(r["chunk_count_selected"]) for r in src_rows)
        by_source[src] = {
            "rows": len(src_rows),
            "avg_full_chars": round(src_full / len(src_rows), 1),
            "avg_embedding_chars": round(src_emb / len(src_rows), 1),
            "avg_chunks_total": round(src_chunks_total / len(src_rows), 2),
            "avg_chunks_selected": round(src_chunks_selected / len(src_rows), 2),
            "truncated_rows": src_trunc,
            "short_rows": sum(1 for r in src_rows if int(r["full_chars"]) < 120),
        }

    return {
        "documents_total": len(row_text_stats),
        "embedding_chars_total": emb_total,
        "embedding_chars_avg": round(emb_total / len(row_text_stats), 1),
        "full_text_chars_avg": round(full_total / len(row_text_stats), 1),
        "chunks_total": total_chunks,
        "chunks_selected_total": selected_chunks,
        "chunks_selected_ratio": round(selected_chunks / max(1, total_chunks), 3),
        "truncated_for_embedding_rows": truncated,
        "short_rows_under_120_chars": short_rows,
        "sources_with_errors": len(errors),
        "by_source_pull": source_pull_stats,
        "by_source_text": by_source,
    }
