"""Public voice-agent endpoints.

  GET  /context/briefing?projectId=X
  POST /context/query    { projectId, query, k? }

Both are PUBLIC (no demo token) because Yudong's <VoiceAgent /> runs in the
browser and can't safely hold a server secret. They are read-only modulo the
meeting_note embedding backfill, which is a service-role compatibility hack
that doesn't change the agent contract.

Frozen response shapes
----------------------

`/context/query` returns ``ContextItem[]`` directly (no wrapping object) so the
voice agent can splat it into RAG context without a layer of unwrapping:

    [{
        origin: "local" | "hyperspell",
        source: "meeting" | "slack" | "drive" | "notion" | "gmail" | ...,
        id: string,
        title: string | null,
        snippet: string | null,
        ref_url: string | null,
        ts: string | null,
        score: number | null,
    }, ...]
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from supabase import Client

from dependencies import get_supabase
from services import (
    briefing_builder,
    embeddings,
    hyperspell,
    meeting_note_embeddings,
    supabase_writer,
)

router = APIRouter(prefix="/context", tags=["context"])
log = logging.getLogger(__name__)

# Latency budget: pgvector first, then Hyperspell with a tight timeout.
HYPERSPELL_TIMEOUT_S = 0.5
QUERY_CACHE_TTL_S = 60.0
BRIEFING_CACHE_TTL_S = 60 * 60 * 6  # 6h — briefing is intentionally cheap
DEFAULT_K = 6
MAX_K = 24
BACKFILL_LIMIT_PER_QUERY = 25


# ─── /context/query ───────────────────────────────────────────────────────────
class QueryBody(BaseModel):
    projectId: str
    query: str = Field(..., min_length=1)
    k: int = Field(default=DEFAULT_K, ge=1, le=MAX_K)


class ContextItem(BaseModel):
    origin: Literal["local", "hyperspell"]
    source: str
    id: str
    title: str | None
    snippet: str | None
    ref_url: str | None
    ts: str | None
    score: float | None


# (project_id, query) → (timestamp, list[ContextItem])
_query_cache: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}


@router.post("/query", response_model=list[ContextItem])
async def context_query(
    body: QueryBody, sb: Client = Depends(get_supabase)
) -> list[ContextItem]:
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    cache_key = (body.projectId, body.query.strip().lower())
    now = time.time()
    cached = _query_cache.get(cache_key)
    if cached and now - cached[0] < QUERY_CACHE_TTL_S:
        return [ContextItem(**row) for row in cached[1]]

    # Best-effort embedding repair so meeting_notes that arrived without
    # embeddings show up in the pgvector RPC. Bounded by limit; failures are
    # swallowed inside the helper.
    try:
        await meeting_note_embeddings.backfill_missing_meeting_note_embeddings(
            sb, body.projectId, limit=BACKFILL_LIMIT_PER_QUERY
        )
    except Exception as e:  # noqa: BLE001
        log.warning("/context/query: backfill failed: %s", e)

    # Stage 1: local pgvector via the search_context RPC.
    local_rows: list[dict[str, Any]] = []
    try:
        q_vec = await embeddings.embed_one(body.query)
        local_rows = await asyncio.to_thread(_local_search, sb, body.projectId, q_vec, body.k)
    except Exception as e:  # noqa: BLE001
        log.warning("/context/query: local search failed: %s", e)

    # Stage 2: best-effort Hyperspell live with tight timeout.
    hs_rows: list[dict[str, Any]] = []
    user_id = project.get("hyperspell_user_id")
    if user_id:
        try:
            hs_res = await asyncio.wait_for(
                hyperspell.search_with_answer(
                    hyperspell_user_id=user_id,
                    query=body.query,
                    hs_sources=None,
                    answer=False,
                    max_results=max(1, body.k // 2),
                ),
                timeout=HYPERSPELL_TIMEOUT_S,
            )
            for h in hs_res.hits:
                hs_rows.append(
                    {
                        "origin": "hyperspell",
                        "source": h.source or "",
                        "id": h.resource_id or "",
                        "title": h.title,
                        "snippet": None,
                        "ref_url": h.ref_url,
                        "ts": None,
                        "score": h.score,
                    }
                )
        except asyncio.TimeoutError:
            log.info("/context/query: hyperspell timeout (%.2fs)", HYPERSPELL_TIMEOUT_S)
        except Exception as e:  # noqa: BLE001
            log.warning("/context/query: hyperspell failed: %s", e)

    # Normalize local rows into the same shape.
    normalized_local: list[dict[str, Any]] = []
    for row in local_rows:
        normalized_local.append(
            {
                "origin": "local",
                "source": str(row.get("source") or ""),
                "id": str(row.get("id") or ""),
                "title": row.get("title"),
                "snippet": row.get("snippet"),
                "ref_url": row.get("ref_url"),
                "ts": _iso(row.get("ts")),
                "score": float(row["score"]) if row.get("score") is not None else None,
            }
        )

    merged = _dedupe_and_sort(normalized_local + hs_rows, body.k)
    _query_cache[cache_key] = (now, merged)
    return [ContextItem(**row) for row in merged]


def _local_search(
    sb: Client, project_id: str, q_vec: list[float], k: int
) -> list[dict[str, Any]]:
    r = sb.rpc(
        "search_context",
        {"p_project_id": project_id, "q_emb": q_vec, "p_limit": k},
    ).execute()
    return r.data or []


def _dedupe_and_sort(rows: list[dict[str, Any]], k: int) -> list[dict[str, Any]]:
    """Dedupe by ref_url (when set) else by id; sort by score desc, None last."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    # First sort so the highest-scoring duplicate wins.
    rows = sorted(rows, key=lambda r: (r.get("score") is None, -(r.get("score") or 0.0)))
    for row in rows:
        key = row.get("ref_url") or f"{row.get('origin')}:{row.get('id')}"
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
        if len(out) >= k:
            break
    return out


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


# ─── /context/briefing ────────────────────────────────────────────────────────
# Cache per (project_id, YYYY-MM-DD) — briefing should be stable within a day.
_briefing_cache: dict[tuple[str, str], tuple[float, dict[str, Any]]] = {}


@router.get("/briefing")
async def context_briefing(
    projectId: str, sb: Client = Depends(get_supabase)
) -> dict[str, Any]:
    project = supabase_writer.get_project(sb, projectId)
    if not project:
        raise HTTPException(404, f"project {projectId} not found")

    from datetime import datetime, timezone

    day_key = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    cache_key = (projectId, day_key)
    now = time.time()
    cached = _briefing_cache.get(cache_key)
    if cached and now - cached[0] < BRIEFING_CACHE_TTL_S:
        return cached[1]

    briefing = await asyncio.to_thread(briefing_builder.build_briefing, sb, projectId)
    _briefing_cache[cache_key] = (now, briefing)
    return briefing
