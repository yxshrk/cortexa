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
    response_model=IngestStartResponse,
    dependencies=[Depends(require_demo_token)],
)
async def ingest_hyperspell(
    body: IngestBody,
    bg: BackgroundTasks,
    sb: Client = Depends(get_supabase),
) -> IngestStartResponse:
    """Kick off a Hyperspell ingest. Returns ``runId`` immediately; the pipeline
    runs in a background task and emits live phase events onto
    ``generation_runs.progress`` (kind='ingest') so the frontend can render a
    real-time progress card via Supabase realtime.

    Idempotent via the partial unique index ``generation_runs_one_active_uniq``
    on ``(project_id, week_start, kind)`` for ``status in ('queued','running')``.
    """
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    user_id = project.get("hyperspell_user_id") or f"pri-{body.projectId}"
    if not project.get("hyperspell_user_id"):
        supabase_writer.set_hyperspell_user_id(sb, body.projectId, user_id)

    started_at = _now_iso()
    today = datetime.now(timezone.utc).date()

    try:
        run = (
            sb.table("generation_runs")
            .insert(
                {
                    "project_id": body.projectId,
                    "kind": "ingest",
                    "week_start": today.isoformat(),
                    "idempotency_key": str(uuid4()),
                    "status": "running",
                    "started_at": started_at,
                }
            )
            .execute()
        )
        run_row = (run.data or [{}])[0]
        run_id = run_row.get("id")
        if not run_id:
            raise HTTPException(500, "generation_runs insert returned no id")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        if _is_unique_violation(e):
            existing = (
                sb.table("generation_runs")
                .select("id,status")
                .eq("project_id", body.projectId)
                .eq("kind", "ingest")
                .in_("status", ["queued", "running"])
                .limit(1)
                .execute()
            )
            row = (existing.data or [{}])[0]
            raise HTTPException(
                status_code=409,
                detail={
                    "runId": row.get("id"),
                    "status": row.get("status") or "running",
                    "message": "another ingest is already in flight for this project",
                },
            )
        log.exception("generation_runs insert (kind=ingest) failed")
        raise HTTPException(500, f"generation_runs insert failed: {e}")

    bg.add_task(
        _run_ingest_pipeline_safe,
        project_id=body.projectId,
        run_id=str(run_id),
        hyperspell_user_id=user_id,
    )

    return IngestStartResponse(runId=str(run_id), status="running", started_at=started_at)


# ─── pipeline (background) ────────────────────────────────────────────────────
async def _run_ingest_pipeline_safe(
    *,
    project_id: str,
    run_id: str,
    hyperspell_user_id: str,
) -> None:
    """Top-level wrapper that always finalizes the run row, even on crash."""
    sb = get_supabase()

    async def emit(event: dict[str, Any]) -> None:
        await progress.append_event_async(sb, run_id, progress.safe_event(event))

    try:
        await emit(
            {
                "phase": "load",
                "kind": "start",
                "message": "Ingest starting",
                "percent": PCT_LOAD_START,
            }
        )
        await _run_ingest_pipeline(
            sb=sb,
            project_id=project_id,
            run_id=run_id,
            hyperspell_user_id=hyperspell_user_id,
            emit=emit,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("ingest pipeline failed")
        try:
            await emit(
                {
                    "phase": "finalize",
                    "kind": "error",
                    "message": f"Ingest failed: {e}",
                }
            )
        finally:
            await asyncio.to_thread(_mark_run_error, sb, run_id, str(e))


async def _run_ingest_pipeline(
    *,
    sb: Client,
    project_id: str,
    run_id: str,
    hyperspell_user_id: str,
    emit,
) -> None:
    async def _mirror(db_src: str) -> list[Any]:
        return await hyperspell.list_and_fetch(
            hyperspell_user_id=hyperspell_user_id,
            db_source=db_src,
            max_items=PER_SOURCE_MIRROR_CAP,
        )

    async def _supplement(db_src: str) -> list[Any]:
        if PER_SOURCE_RANKED_SUPPLEMENT_K <= 0:
            return []
        return await hyperspell.search(
            hyperspell_user_id=hyperspell_user_id,
            query=RANKED_SUPPLEMENT_QUERY,
            db_sources=[db_src],
            k=PER_SOURCE_RANKED_SUPPLEMENT_K,
        )

    async def _pull(db_src: str) -> tuple[str, list[Any], str | None, dict[str, int]]:
        try:
            mirror_items, supp_items = await asyncio.gather(
                _mirror(db_src), _supplement(db_src), return_exceptions=False
            )
        except RuntimeError as e:
            return db_src, [], f"sdk/key: {e}", {
                "mirror_count": 0, "supplement_count": 0, "deduped_within_source": 0,
            }
        except Exception as e:  # noqa: BLE001
            log.warning("ingest pull failed for %s: %s", db_src, e)
            return db_src, [], f"{type(e).__name__}: {e}", {
                "mirror_count": 0, "supplement_count": 0, "deduped_within_source": 0,
            }

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

    # ── load (parallel pull, emit per-source as they finish) ────────────────
    pull_tasks = {asyncio.create_task(_pull(s)): s for s in DB_SOURCES}
    completed = 0
    total_sources = len(DB_SOURCES)
    all_items: list[Any] = []
    by_source: dict[str, int] = {}
    errors: dict[str, str] = {}
    source_pull_stats: dict[str, dict[str, int]] = {}

    pull_span = max(1, PCT_LOAD_END - PCT_LOAD_START)
    for fut in asyncio.as_completed(list(pull_tasks.keys())):
        db_src, items, err, pull_stats = await fut
        completed += 1
        source_pull_stats[db_src] = pull_stats
        if err:
            errors[db_src] = err
        if items:
            by_source[db_src] = len(items)
            all_items.extend(items)
        pct = PCT_LOAD_START + int(pull_span * (completed / total_sources))
        await emit(
            {
                "phase": "load",
                "kind": "progress",
                "message": (
                    f"Pulled {db_src}: {len(items)} item{'' if len(items) == 1 else 's'}"
                    + (f" — {err}" if err else "")
                ),
                "percent": pct,
                "extra": {
                    "source": db_src,
                    "items": len(items),
                    "completed_sources": completed,
                    "total_sources": total_sources,
                    "running_total": len(all_items),
                },
            }
        )

    await emit(
        {
            "phase": "load",
            "kind": "end",
            "message": f"Loaded {len(all_items)} document{'' if len(all_items) == 1 else 's'} across {len(by_source)} source{'' if len(by_source) == 1 else 's'}",
            "percent": PCT_LOAD_END,
            "extra": {"documents": len(all_items), "by_source": by_source, "errors": errors},
        }
    )

    if not all_items:
        await asyncio.to_thread(
            _finish_run,
            sb,
            run_id,
            metrics={
                "documents_total": 0,
                "sources_attempted": len(DB_SOURCES),
                "sources_with_errors": len(errors),
                "by_source_pull": source_pull_stats,
            },
        )
        await emit(
            {
                "phase": "finalize",
                "kind": "end",
                "message": "Nothing to embed — connect a source and try again.",
                "percent": PCT_DONE,
                "extra": {"errors": errors},
            }
        )
        return

    # ── embed (single batched call; chunk-aware representations) ────────────
    await emit(
        {
            "phase": "embed",
            "kind": "start",
            "message": f"Chunking + embedding {len(all_items)} document{'' if len(all_items) == 1 else 's'}",
            "percent": PCT_EMBED_START,
        }
    )
    texts = [hyperspell.build_embedding_text(it.full_text) for it in all_items]
    try:
        vectors = await embeddings.embed_many(texts)
    except Exception as e:  # noqa: BLE001
        await emit({"phase": "embed", "kind": "error", "message": f"Embedding failed: {e}"})
        raise

    # Build chunking stats while the embedding response is still warm.
    row_text_stats: list[dict[str, Any]] = []
    for it, emb_text in zip(all_items, texts):
        stats = hyperspell.chunking_stats(it.full_text, emb_text)
        stats["source"] = it.source
        stats["snippet_chars"] = len((it.snippet or "")[:500])
        row_text_stats.append(stats)

    chunks_total = sum(int(r["chunk_count_total"]) for r in row_text_stats)
    chunks_selected = sum(int(r["chunk_count_selected"]) for r in row_text_stats)
    chunks_selected_ratio = round(chunks_selected / max(1, chunks_total), 3)

    await emit(
        {
            "phase": "embed",
            "kind": "end",
            "message": (
                f"Embedded {len(all_items)} doc{'' if len(all_items) == 1 else 's'} · "
                f"{chunks_selected}/{chunks_total} chunks selected ({int(chunks_selected_ratio * 100)}%)"
            ),
            "percent": PCT_EMBED_END,
            "extra": {
                "documents": len(all_items),
                "chunks_total": chunks_total,
                "chunks_selected_total": chunks_selected,
                "chunks_selected_ratio": chunks_selected_ratio,
            },
        }
    )

    # ── upsert ───────────────────────────────────────────────────────────────
    rows: list[dict[str, Any]] = []
    for it, vec in zip(all_items, vectors):
        content_hash = hashlib.sha256(it.full_text.encode("utf-8")).hexdigest()
        rows.append(
            {
                "project_id": project_id,
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

    await emit(
        {
            "phase": "upsert",
            "kind": "start",
            "message": f"Writing {len(rows)} row{'' if len(rows) == 1 else 's'} to project_context",
            "percent": PCT_EMBED_END,
        }
    )
    counts = await asyncio.to_thread(supabase_writer.upsert_project_context, sb, rows)
    await emit(
        {
            "phase": "upsert",
            "kind": "end",
            "message": (
                f"Wrote {counts['inserted']} new + {counts['updated']} updated"
                + (f" · {counts['errors']} errors" if counts.get("errors") else "")
            ),
            "percent": PCT_UPSERT_END,
            "extra": counts,
        }
    )

    # ── finalize ─────────────────────────────────────────────────────────────
    metrics = _build_ingest_metrics(row_text_stats, source_pull_stats, errors)
    await asyncio.to_thread(_finish_run, sb, run_id, metrics=metrics)
    await emit(
        {
            "phase": "finalize",
            "kind": "end",
            "message": (
                f"Done. {counts['inserted'] + counts['updated']} synced "
                f"({counts['inserted']} new, {counts['updated']} updated)"
            ),
            "percent": PCT_DONE,
            "extra": {
                "by_source": by_source,
                "metrics": metrics,
                "counts": counts,
            },
        }
    )


def _finish_run(sb: Client, run_id: str, *, metrics: dict[str, Any]) -> None:
    sb.table("generation_runs").update(
        {"status": "ready", "finished_at": _now_iso()}
    ).eq("id", run_id).execute()


def _mark_run_error(sb: Client, run_id: str, msg: str) -> None:
    try:
        sb.table("generation_runs").update(
            {"status": "error", "error": msg[:1000], "finished_at": _now_iso()}
        ).eq("id", run_id).execute()
    except Exception as e:  # noqa: BLE001
        log.warning("failed to mark generation_runs.error: %s", e)


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
