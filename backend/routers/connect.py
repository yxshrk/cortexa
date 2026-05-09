"""Hyperspell connect flow: mint OAuth URLs and report per-source status."""
from __future__ import annotations

import logging
import time
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from supabase import Client

from dependencies import get_supabase, require_demo_token
from services import hyperspell, supabase_writer

router = APIRouter(prefix="/connect", tags=["connect"])
log = logging.getLogger(__name__)

DBSource = Literal["slack", "drive", "notion", "gmail", "github"]


class ConnectStartBody(BaseModel):
    projectId: str
    source: DBSource
    # Optional URL to send the user back to after OAuth completes. The frontend
    # passes its own /connect/return page so we can auto-trigger ingestion.
    redirectUrl: str | None = None


class ConnectStartResponse(BaseModel):
    url: str
    hyperspell_user_id: str


@router.post(
    "/start",
    response_model=ConnectStartResponse,
    # Auth-gated: this mutates projects.hyperspell_user_id via the service-role
    # client. Without the gate, anyone with a project UUID could trigger writes.
    dependencies=[Depends(require_demo_token)],
)
def connect_start(
    body: ConnectStartBody,
    sb: Client = Depends(get_supabase),
) -> ConnectStartResponse:
    """Mint a Hyperspell OAuth URL for `(projectId, source)`.

    Lazily provisions `projects.hyperspell_user_id` (`pri-<projectId>` style)
    on first call per project.
    """
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    user_id = project.get("hyperspell_user_id")
    if not user_id:
        user_id = f"pri-{body.projectId}"
        supabase_writer.set_hyperspell_user_id(sb, body.projectId, user_id)
        log.info("provisioned hyperspell_user_id=%s for project=%s", user_id, body.projectId)

    if body.source == "github":
        # GitHub is a beta connector; we don't surface a connect URL for it in the demo.
        # Code refs come from a fixture or the Hyperspell GitHub search at categorize time.
        raise HTTPException(400, "github is beta — see backend/fixtures/seed_code_refs.json")

    if body.source not in hyperspell.HYPERSPELL_SUPPORTED_DB_SOURCES:
        # Hyperspell exposes only 4 providers (slack/drive/notion/github).
        # Gmail in particular is in our DB enum but NOT a Hyperspell connector.
        raise HTTPException(
            400,
            f"{body.source!r} is not currently supported by Hyperspell. "
            f"Supported: {sorted(hyperspell.HYPERSPELL_SUPPORTED_DB_SOURCES)}",
        )

    try:
        url = hyperspell.connect_url(user_id, body.source, redirect_url=body.redirectUrl)
    except ValueError as e:
        # Programmer error — unsupported source slipped past the guard above.
        raise HTTPException(400, str(e))
    except Exception as e:
        log.exception("connect_url failed")
        raise HTTPException(502, f"hyperspell connect failed: {e}")

    # OAuth completion will (eventually) flip this project's connection state.
    # Bust the 30s cache so /connect/status doesn't lie until it expires.
    _status_cache.pop(body.projectId, None)
    return ConnectStartResponse(url=url, hyperspell_user_id=user_id)


# ─── /connect/status ──────────────────────────────────────────────────────────
_status_cache: dict[str, tuple[float, dict[str, str]]] = {}
_STATUS_TTL_S = 30.0


@router.get("/status")
def connect_status(projectId: str, sb: Client = Depends(get_supabase)) -> dict[str, str]:
    """Per-source connection status for a project. 30s in-memory cache."""
    now = time.time()
    cached = _status_cache.get(projectId)
    if cached and now - cached[0] < _STATUS_TTL_S:
        return cached[1]

    project = supabase_writer.get_project(sb, projectId)
    if not project:
        raise HTTPException(404, f"project {projectId} not found")

    user_id = project.get("hyperspell_user_id")

    # Try the Hyperspell SDK first.
    sdk_status: dict[str, str] = {}
    if user_id:
        try:
            sdk_status = hyperspell.list_connections(user_id)
        except Exception as e:
            log.warning("list_connections failed: %s", e)

    # Heuristic: presence of any project_context row from a source ⇒ connected.
    seen = supabase_writer.project_context_sources_present(sb, projectId)

    out: dict[str, str] = {}
    for src in ("slack", "drive", "notion", "gmail"):
        out[src] = sdk_status.get(src) or ("connected" if src in seen else "not_connected")
    out["github"] = "beta"

    _status_cache[projectId] = (now, out)
    return out


# ─── /connect/integrations ────────────────────────────────────────────────────
@router.get(
    "/integrations",
    summary="All integrations Hyperspell exposes (so the connector list isn't hardcoded)",
)
async def list_integrations(
    projectId: str, sb: Client = Depends(get_supabase)
) -> dict:
    """Wraps `client.integrations.list()`. Returns Hyperspell's full catalog
    so the frontend can surface new connectors as Hyperspell adds them."""
    project = supabase_writer.get_project(sb, projectId)
    if not project:
        raise HTTPException(404, f"project {projectId} not found")
    user_id = project.get("hyperspell_user_id") or f"pri-{projectId}"
    try:
        return await hyperspell.list_integrations(user_id)
    except Exception as e:
        log.warning("integrations.list failed: %s", e)
        raise HTTPException(502, f"hyperspell integrations.list failed: {e}")


# ─── /connect/revoke ──────────────────────────────────────────────────────────
class RevokeBody(BaseModel):
    projectId: str
    source: DBSource  # we accept our DB enum and translate


@router.post(
    "/revoke",
    dependencies=[Depends(require_demo_token)],
    summary="Revoke a Hyperspell connection by source name",
)
async def revoke_connection(
    body: RevokeBody, sb: Client = Depends(get_supabase)
) -> dict:
    """Resolves source → Hyperspell connection_id → calls `connections.revoke`.

    Also bumps the in-memory status cache so `/connect/status` reflects the change immediately.
    """
    if body.source == "github":
        raise HTTPException(400, "github is beta — nothing to revoke")
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")
    user_id = project.get("hyperspell_user_id")
    if not user_id:
        raise HTTPException(400, "project has no hyperspell_user_id; nothing to revoke")

    hs_provider = hyperspell.DB_TO_HS_SOURCE.get(body.source)
    if not hs_provider:
        raise HTTPException(400, f"unknown source: {body.source}")

    try:
        connection_id = await hyperspell.find_connection_id_for_provider(
            hyperspell_user_id=user_id, hs_provider=hs_provider
        )
    except Exception as e:
        log.warning("connections.list failed during revoke: %s", e)
        raise HTTPException(502, f"hyperspell connections.list failed: {e}")
    if not connection_id:
        raise HTTPException(404, f"no connected {body.source} found")

    try:
        result = await hyperspell.revoke_connection(
            hyperspell_user_id=user_id, connection_id=connection_id
        )
    except Exception as e:
        log.exception("connections.revoke failed")
        raise HTTPException(502, f"hyperspell revoke failed: {e}")

    _status_cache.pop(body.projectId, None)
    return {"revoked": True, "source": body.source, "connection_id": connection_id, "result": result}
