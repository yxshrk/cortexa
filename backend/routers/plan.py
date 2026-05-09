"""POST /plan/generate — synthesize → categorize → draft actions.

Idempotent via the ``generation_runs_one_active_uniq`` partial unique index:
at most one row with status in ('queued','running') per (project_id, week_start).
A second concurrent /plan/generate for the same week trips the index → 409.

On success the run flips to 'ready'; on failure it flips to 'error' and the
exception bubbles. Re-running for the same week REPLACES the plan_items for
the doc (ON DELETE CASCADE wipes their generated_actions).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from supabase import Client

from dependencies import get_supabase, require_demo_token
from services import (
    action_drafter,
    categorizer,
    code_refs,
    supabase_writer,
    synthesizer,
)

router = APIRouter(prefix="/plan", tags=["plan"])
log = logging.getLogger(__name__)

LOOKBACK_DAYS = 7


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
    knowledgeDocumentId: str
    week_start: str
    items: int
    actions: int


# ─── helpers ──────────────────────────────────────────────────────────────────
def _current_iso_week_bounds() -> tuple[date, date]:
    """Monday-of-this-week + Sunday-of-this-week (UTC, ISO 8601)."""
    today_utc = datetime.now(timezone.utc).date()
    monday = today_utc - timedelta(days=today_utc.weekday())
    sunday = monday + timedelta(days=6)
    return monday, sunday


def _is_unique_violation(err: Exception) -> bool:
    text = repr(err).lower()
    # Postgres SQLSTATE for unique_violation is 23505; PostgREST also surfaces
    # the human string. Match either to keep this resilient across SDK versions.
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


# ─── endpoint ─────────────────────────────────────────────────────────────────
@router.post(
    "/generate",
    response_model=GenerateResponse,
    dependencies=[Depends(require_demo_token)],
)
async def generate_plan(
    body: GenerateBody, sb: Client = Depends(get_supabase)
) -> GenerateResponse:
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    week_start, week_end = _current_iso_week_bounds()
    idem_key = body.idempotency_key or str(uuid4())

    # Idempotency: if the same key was used before for this week, return the
    # finished or in-flight run rather than creating a duplicate.
    if body.idempotency_key:
        prior = _select_existing_run_by_idem(sb, body.projectId, week_start, idem_key)
        if prior:
            return _response_for_existing_run(sb, prior, week_start)

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

    try:
        return await _run_pipeline(
            sb=sb,
            project_id=body.projectId,
            run_id=str(run_id),
            week_start=week_start,
            week_end=week_end,
            hyperspell_user_id=project.get("hyperspell_user_id"),
        )
    except HTTPException:
        _mark_run_error(sb, run_id, "HTTPException")
        raise
    except Exception as e:
        log.exception("plan/generate pipeline failed")
        _mark_run_error(sb, run_id, str(e))
        raise HTTPException(500, f"plan generation failed: {e}")


# ─── pipeline ─────────────────────────────────────────────────────────────────
async def _run_pipeline(
    *,
    sb: Client,
    project_id: str,
    run_id: str,
    week_start: date,
    week_end: date,
    hyperspell_user_id: str | None,
) -> GenerateResponse:
    cutoff = (
        datetime.now(timezone.utc) - timedelta(days=LOOKBACK_DAYS)
    ).isoformat()

    notes = await asyncio.to_thread(_select_notes, sb, project_id, cutoff)
    context = await asyncio.to_thread(_select_context, sb, project_id, cutoff)

    # Step 1: synthesis
    doc_payload = await synthesizer.synthesize(notes=notes, context=context)
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

    # Step 2: clear prior plan_items for the doc (CASCADE drops their actions),
    # then categorize. REPLACE semantics so reruns don't accumulate stale items.
    await asyncio.to_thread(_delete_plan_items_for_doc, sb, doc_id)

    items = await categorizer.categorize(doc_payload)

    inserted_items = 0
    inserted_actions = 0
    for item in items:
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
            continue
        if not plan_item_id:
            continue
        inserted_items += 1

        # Step 3: drafts (Claude #3) → generated_actions
        drafts = await action_drafter.draft_actions(item=item, code_refs=refs)
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

    # Mark doc + run ready
    await asyncio.to_thread(_finish_doc, sb, doc_id)
    await asyncio.to_thread(_finish_run, sb, run_id)

    return GenerateResponse(
        runId=str(run_id),
        knowledgeDocumentId=str(doc_id),
        week_start=week_start.isoformat(),
        items=inserted_items,
        actions=inserted_actions,
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
    """Upsert by (project_id, week_start) → ``knowledge_documents_week_uniq``.

    PostgREST CAN target this index by columns since it's a TOTAL unique index
    (no partial predicate). Returns the doc id.
    """
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
        # Defensive: fetch by (project, week_start) if the upsert didn't return.
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


def _response_for_existing_run(
    sb: Client, run: dict[str, Any], week_start: date
) -> GenerateResponse:
    """Build a 200 response for a prior idempotent run (don't redo the work)."""
    project_id = run["project_id"]
    r = (
        sb.table("knowledge_documents")
        .select("id")
        .eq("project_id", project_id)
        .eq("week_start", week_start.isoformat())
        .limit(1)
        .execute()
    )
    rows = r.data or []
    doc_id = rows[0]["id"] if rows else ""

    # Counts straight off the run.
    pi = (
        sb.table("plan_items")
        .select("id", count="exact")
        .eq("generation_run_id", run["id"])
        .execute()
    )
    ga = (
        sb.table("generated_actions")
        .select("id", count="exact")
        .eq("generation_run_id", run["id"])
        .execute()
    )
    return GenerateResponse(
        runId=str(run["id"]),
        knowledgeDocumentId=str(doc_id),
        week_start=week_start.isoformat(),
        items=int(pi.count or 0),
        actions=int(ga.count or 0),
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
