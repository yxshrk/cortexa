"""POST /actions/{id}/execute — dispatch a generated_action to its executor.

Stubbed Linear / GitHub / Devin executors return fake URLs (see services/executors.py).
The router writes ``status='executing'`` before dispatch, then ``executed``+``external_url``
on success or ``failed`` on error. Idempotent only insofar as: re-executing a row that's
already executed returns the existing external_url instead of re-running.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from supabase import Client

from dependencies import get_supabase, require_demo_token
from services import executors

router = APIRouter(prefix="/actions", tags=["actions"])
log = logging.getLogger(__name__)


class ExecuteResponse(BaseModel):
    externalUrl: str
    status: str


def _get_action(sb: Client, action_id: str) -> dict[str, Any]:
    r = (
        sb.table("generated_actions")
        .select("*")
        .eq("id", action_id)
        .limit(1)
        .execute()
    )
    rows = r.data or []
    if not rows:
        raise HTTPException(404, f"action {action_id} not found")
    return rows[0]


@router.post(
    "/{action_id}/execute",
    response_model=ExecuteResponse,
    dependencies=[Depends(require_demo_token)],
)
async def execute_action(
    action_id: str, sb: Client = Depends(get_supabase)
) -> ExecuteResponse:
    action = _get_action(sb, action_id)
    action_type = action.get("action_type")
    payload = action.get("payload") or {}

    # Idempotent short-circuit: already executed → return the URL we wrote.
    if action.get("status") == "executed" and action.get("external_url"):
        return ExecuteResponse(externalUrl=action["external_url"], status="executed")

    handler = executors.DISPATCH.get(action_type)
    if handler is None:
        raise HTTPException(400, f"unknown action_type: {action_type!r}")

    sb.table("generated_actions").update({"status": "executing"}).eq(
        "id", action_id
    ).execute()

    try:
        url = await handler(payload)
    except Exception as e:
        log.exception("action %s execution failed", action_id)
        sb.table("generated_actions").update({"status": "failed"}).eq(
            "id", action_id
        ).execute()
        raise HTTPException(500, f"executor failed: {e}")

    sb.table("generated_actions").update(
        {"status": "executed", "external_url": url}
    ).eq("id", action_id).execute()

    return ExecuteResponse(externalUrl=url, status="executed")
