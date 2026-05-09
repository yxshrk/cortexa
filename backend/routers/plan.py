"""POST /plan/generate — synthesize → categorize → draft actions.

Asynchronous: the request returns ``{runId, week_start, status:"running"}`` as
soon as the generation_runs row is written. The pipeline runs in a FastAPI
background task and persists structured progress events onto
``generation_runs.progress`` (jsonb array) at every phase. Frontend subscribes
via Supabase realtime and renders a live trace.

Idempotent via the ``generation_runs_one_active_uniq`` partial unique index:
at most one row with status in ('queued','running') per (project_id, week_start).
A second concurrent /plan/generate for the same week trips the index → 409.

On success the run flips to ``ready``; on failure it flips to ``error`` with
``error`` populated. Re-running for the same week REPLACES the plan_items for
the doc (ON DELETE CASCADE wipes their generated_actions).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from supabase import Client

from dependencies import get_supabase, require_demo_token
from services import (
    action_drafter,
    categorizer,
    code_refs,
    progress,
    supabase_writer,
    synthesizer,
)

router = APIRouter(prefix="/plan", tags=["plan"])
log = logging.getLogger(__name__)

LOOKBACK_DAYS = 7

# Coarse phase weights so the percent advances smoothly across the run.
# These are rough estimates; the categorize/draft phases scale with item count.
PCT_LOAD = 5
PCT_AFTER_LOAD = 10
PCT_AFTER_SYNTH = 35
PCT_AFTER_CATEGORIZE = 50
PCT_BEFORE_FINALIZE = 95
PCT_DONE = 100


# ─── request / response ───────────────────────────────────────────────────────
class GenerateBody(BaseModel):
    projectId: str
    idempotency_key: str | None = Field(
        default=None,
        description=(
            "Optional client-supplied idempotency key. Two requests with the "
            "same (project, week, key) reuse the same run row instead of 409ing."
        ),
    )


class GenerateResponse(BaseModel):
    runId: str
    week_start: str
    status: str
    knowledgeDocumentId: str | None = None


# ─── helpers ──────────────────────────────────────────────────────────────────
def _current_iso_week_bounds() -> tuple[date, date]:
    today_utc = datetime.now(timezone.utc).date()
    monday = today_utc - timedelta(days=today_utc.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday


def _is_unique_violation(err: Exception) -> bool:
    text = repr(err).lower()
    return "23505" in text or "duplicate key" in text or "unique constraint" in text


def _select_active_run(
    sb: Client, project_id: str, week_start: date
) -> dict[str, Any] | None:
    r = (
        sb.table("generation_runs")
        .select("*")
        .eq("project_id", project_id)
        .eq("week_start", week_start.isoformat())
        .in_("status", ["queued", "running"])
        .limit(1)
        .execute()
    )
    rows = r.data or []
    return rows[0] if rows else None


def _select_existing_run_by_idem(
    sb: Client, project_id: str, week_start: date, idem_key: str
) -> dict[str, Any] | None:
    r = (
        sb.table("generation_runs")
        .select("*")
        .eq("project_id", project_id)
        .eq("week_start", week_start.isoformat())
        .eq("idempotency_key", idem_key)
        .limit(1)
        .execute()
    )
    rows = r.data or []
    return rows[0] if rows else None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ─── endpoint ─────────────────────────────────────────────────────────────────
@router.post(
    "/generate",
    response_model=GenerateResponse,
    dependencies=[Depends(require_demo_token)],
)
async def generate_plan(
    body: GenerateBody,
    bg: BackgroundTasks,
    sb: Client = Depends(get_supabase),
) -> GenerateResponse:
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    week_start, week_end = _current_iso_week_bounds()
    idem_key = body.idempotency_key or str(uuid4())

    # Idempotency: short-circuit if the same key was used for this week.
    if body.idempotency_key:
        prior = _select_existing_run_by_idem(sb, body.projectId, week_start, idem_key)
        if prior:
            doc_id = _lookup_existing_doc_id(sb, body.projectId, week_start)
            return GenerateResponse(
                runId=str(prior["id"]),
                week_start=week_start.isoformat(),
                status=str(prior["status"]),
                knowledgeDocumentId=doc_id,
            )

    # Insert the run row. Concurrent calls for the same week trip the partial
    # unique index `generation_runs_one_active_uniq` → 23505.
    try:
        run = (
            sb.table("generation_runs")
            .insert(
                {
                    "project_id": body.projectId,
                    "week_start": week_start.isoformat(),
                    "idempotency_key": idem_key,
                    "status": "running",
                    "started_at": _now_iso(),
                }
            )
            .execute()
        )
        run_row = (run.data or [{}])[0]
        run_id = run_row.get("id")
        if not run_id:
            raise HTTPException(500, "generation_runs insert returned no id")
    except Exception as e:
        if _is_unique_violation(e):
            existing = _select_active_run(sb, body.projectId, week_start)
            raise HTTPException(
                status_code=409,
                detail={
                    "runId": existing.get("id") if existing else None,
                    "status": existing.get("status") if existing else "running",
                    "message": "another plan generation is already in flight for this week",
                },
            )
        log.exception("generation_runs insert failed")
        raise HTTPException(500, f"generation_runs insert failed: {e}")

    # Schedule the pipeline. We hand the BackgroundTask its own Client because
    # request-scoped dependencies don't survive past response send.
    bg.add_task(
        _run_pipeline_safe,
        project_id=body.projectId,
        run_id=str(run_id),
        week_start=week_start,
        week_end=week_end,
        hyperspell_user_id=project.get("hyperspell_user_id"),
    )

    return GenerateResponse(
        runId=str(run_id),
        week_start=week_start.isoformat(),
        status="running",
        knowledgeDocumentId=None,
    )


# ─── pipeline (background) ────────────────────────────────────────────────────
async def _run_pipeline_safe(
    *,
    project_id: str,
    run_id: str,
    week_start: date,
    week_end: date,
    hyperspell_user_id: str | None,
) -> None:
    """Top-level wrapper that always finalizes the run row, even on crash.

    Builds its own Supabase client because the FastAPI dependency-scoped one
    is gone by the time this runs.
    """
    # `get_supabase()` is lru_cache'd to a singleton, so calling it from the
    # background task hands back the same client the request used.
    sb = get_supabase()

    async def emit(event: dict[str, Any]) -> None:
        progress.append_event(sb, run_id, event)

    try:
        await emit(
            {
                "phase": "load",
                "kind": "start",
                "message": "Plan generation started",
                "percent": 0,
            }
        )
        await _run_pipeline(
            sb=sb,
            project_id=project_id,
            run_id=run_id,
            week_start=week_start,
            week_end=week_end,
            hyperspell_user_id=hyperspell_user_id,
            emit=emit,
        )
    except Exception as e:
        log.exception("plan/generate pipeline failed")
        try:
            progress.append_event(
                sb,
                run_id,
                {
                    "phase": "finalize",
                    "kind": "error",
                    "message": f"Pipeline failed: {e}",
                },
            )
        finally:
            _mark_run_error(sb, run_id, str(e))


async def _run_pipeline(
    *,
    sb: Client,
    project_id: str,
    run_id: str,
    week_start: date,
    week_end: date,
    hyperspell_user_id: str | None,
    emit,
) -> None:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)).isoformat()

    # ── load ─────────────────────────────────────────────────────────────
    notes = await asyncio.to_thread(_select_notes, sb, project_id, cutoff)
    context = await asyncio.to_thread(_select_context, sb, project_id, cutoff)
    await emit(
        {
            "phase": "load",
            "kind": "end",
            "message": f"Loaded {len(notes)} meeting note{_s(notes)} and {len(context)} project_context row{_s(context)}",
            "percent": PCT_AFTER_LOAD,
            "extra": {"notes": len(notes), "context": len(context)},
        }
    )

    # ── synthesize ───────────────────────────────────────────────────────
    await emit(
        {
            "phase": "synthesize",
            "kind": "start",
            "message": "Synthesizing weekly summary, themes, decisions, blockers, open questions",
            "percent": PCT_AFTER_LOAD,
        }
    )
    doc_payload = await synthesizer.synthesize(notes=notes, context=context, emit=emit)

    doc_id = await asyncio.to_thread(
        _upsert_knowledge_document,
        sb,
        project_id,
        week_start,
        week_end,
        doc_payload,
        [n["id"] for n in notes],
        [c["id"] for c in context],
    )
    await emit(
        {
            "phase": "synthesize",
            "kind": "end",
            "message": (
                f"Synthesis ready: "
                f"{len(doc_payload.get('themes') or [])} theme{_s_n(len(doc_payload.get('themes') or []))}, "
                f"{len(doc_payload.get('decisions') or [])} decision{_s_n(len(doc_payload.get('decisions') or []))}, "
                f"{len(doc_payload.get('blockers') or [])} blocker{_s_n(len(doc_payload.get('blockers') or []))}, "
                f"{len(doc_payload.get('open_questions') or [])} open question{_s_n(len(doc_payload.get('open_questions') or []))}"
            ),
            "percent": PCT_AFTER_SYNTH,
            "extra": {"knowledge_document_id": doc_id},
        }
    )

    # ── categorize ───────────────────────────────────────────────────────
    await asyncio.to_thread(_delete_plan_items_for_doc, sb, doc_id)
    await emit(
        {
            "phase": "categorize",
            "kind": "start",
            "message": "Categorizing into bug fixes / new features / maintenance",
            "percent": PCT_AFTER_SYNTH,
        }
    )
    items = await categorizer.categorize(doc_payload, emit=emit)
    await emit(
        {
            "phase": "categorize",
            "kind": "end",
            "message": f"{len(items)} plan item{_s_n(len(items))} drafted",
            "percent": PCT_AFTER_CATEGORIZE,
            "extra": {"items": len(items)},
        }
    )

    # ── per-item: code refs + action drafts ──────────────────────────────
    inserted_actions = 0
    for idx, item in enumerate(items):
        item_pct = PCT_AFTER_CATEGORIZE + int(
            (PCT_BEFORE_FINALIZE - PCT_AFTER_CATEGORIZE) * (idx / max(len(items), 1))
        )
        await emit(
            {
                "phase": "draft_actions",
                "kind": "progress",
                "message": f"Drafting actions for: {item.get('title') or '(untitled)'}",
                "percent": item_pct,
                "extra": {"index": idx, "total": len(items)},
            }
        )

        refs = await code_refs.get_code_refs(
            query=item.get("code_query", ""),
            hyperspell_user_id=hyperspell_user_id,
        )
        plan_row = {
            "knowledge_document_id": doc_id,
            "project_id": project_id,
            "generation_run_id": run_id,
            "category": item["category"],
            "title": item["title"],
            "description": item.get("description"),
            "source_refs": item.get("source_refs") or [],
            "code_refs": refs,
            "next_step": item.get("next_step"),
            "confidence": item.get("confidence"),
        }
        try:
            r = sb.table("plan_items").insert(plan_row).execute()
            plan_item_id = (r.data or [{}])[0].get("id")
        except Exception as e:  # noqa: BLE001
            log.warning("plan_items insert failed: %s", e)
            await emit(
                {
                    "phase": "draft_actions",
                    "kind": "error",
                    "message": f"plan_items insert failed: {e}",
                }
            )
            continue
        if not plan_item_id:
            continue

        drafts = await action_drafter.draft_actions(
            item=item, code_refs=refs, emit=emit
        )
        for draft in drafts:
            try:
                sb.table("generated_actions").insert(
                    {
                        "plan_item_id": plan_item_id,
                        "project_id": project_id,
                        "generation_run_id": run_id,
                        "action_type": draft["action_type"],
                        "payload": draft["payload"],
                        "status": "draft",
                    }
                ).execute()
                inserted_actions += 1
            except Exception as e:  # noqa: BLE001
                log.warning("generated_actions insert failed: %s", e)

    # ── finalize ─────────────────────────────────────────────────────────
    await asyncio.to_thread(_finish_doc, sb, doc_id)
    await asyncio.to_thread(_finish_run, sb, run_id)
    await progress.append_event_async(
        sb,
        run_id,
        {
            "phase": "finalize",
            "kind": "end",
            "message": f"Done. {len(items)} plan item{_s_n(len(items))}, {inserted_actions} action draft{_s_n(inserted_actions)}.",
            "percent": PCT_DONE,
            "extra": {
                "items": len(items),
                "actions": inserted_actions,
                "knowledge_document_id": doc_id,
            },
        },
    )


# ─── DB helpers (sync; called via to_thread) ──────────────────────────────────
def _select_notes(sb: Client, project_id: str, cutoff_iso: str) -> list[dict[str, Any]]:
    r = (
        sb.table("meeting_notes")
        .select("id,type,text,ts")
        .eq("project_id", project_id)
        .gte("ts", cutoff_iso)
        .order("ts", desc=True)
        .limit(200)
        .execute()
    )
    return r.data or []


def _select_context(sb: Client, project_id: str, cutoff_iso: str) -> list[dict[str, Any]]:
    r = (
        sb.table("project_context")
        .select("id,source,title,snippet,author,ref_url,ts")
        .eq("project_id", project_id)
        .gte("ts", cutoff_iso)
        .order("ts", desc=True)
        .limit(200)
        .execute()
    )
    return r.data or []


def _upsert_knowledge_document(
    sb: Client,
    project_id: str,
    week_start: date,
    week_end: date,
    doc_payload: dict[str, Any],
    note_ids: list[str],
    context_ids: list[str],
) -> str:
    row = {
        "project_id": project_id,
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "status": "generating",
        "summary": doc_payload.get("summary") or "",
        "themes": doc_payload.get("themes") or [],
        "decisions": doc_payload.get("decisions") or [],
        "blockers": doc_payload.get("blockers") or [],
        "open_questions": doc_payload.get("open_questions") or [],
        "source_meeting_note_ids": note_ids,
        "source_project_context_ids": context_ids,
    }
    r = (
        sb.table("knowledge_documents")
        .upsert(row, on_conflict="project_id,week_start")
        .execute()
    )
    rows = r.data or []
    if not rows:
        r2 = (
            sb.table("knowledge_documents")
            .select("id")
            .eq("project_id", project_id)
            .eq("week_start", week_start.isoformat())
            .limit(1)
            .execute()
        )
        rows = r2.data or []
    if not rows:
        raise RuntimeError("knowledge_documents upsert returned no row")
    return rows[0]["id"]


def _delete_plan_items_for_doc(sb: Client, doc_id: str) -> None:
    sb.table("plan_items").delete().eq("knowledge_document_id", doc_id).execute()


def _finish_doc(sb: Client, doc_id: str) -> None:
    sb.table("knowledge_documents").update({"status": "ready"}).eq("id", doc_id).execute()


def _finish_run(sb: Client, run_id: str) -> None:
    sb.table("generation_runs").update(
        {"status": "ready", "finished_at": _now_iso()}
    ).eq("id", run_id).execute()


def _mark_run_error(sb: Client, run_id: str | UUID, msg: str) -> None:
    try:
        sb.table("generation_runs").update(
            {"status": "error", "error": msg[:1000], "finished_at": _now_iso()}
        ).eq("id", str(run_id)).execute()
    except Exception as e:  # noqa: BLE001
        log.warning("failed to mark generation_runs.error: %s", e)


def _lookup_existing_doc_id(
    sb: Client, project_id: str, week_start: date
) -> str | None:
    r = (
        sb.table("knowledge_documents")
        .select("id")
        .eq("project_id", project_id)
        .eq("week_start", week_start.isoformat())
        .limit(1)
        .execute()
    )
    rows = r.data or []
    return rows[0]["id"] if rows else None


def _s(arr: list[Any]) -> str:
    return "" if len(arr) == 1 else "s"


def _s_n(n: int) -> str:
    return "" if n == 1 else "s"
