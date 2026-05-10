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
from datetime import datetime, timezone
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
                ref_url = h.ref_url
                raw_score = _normalize_score(h.score)
                hs_rows.append(
                    {
                        "origin": "hyperspell",
                        "source": _normalize_source(h.source or ""),
                        "id": h.resource_id or "",
                        "title": h.title,
                        "snippet": h.title,
                        "ref_url": ref_url,
                        "ts": None,
                        "score": raw_score,
                        "_raw_score": raw_score,
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
                "source": _normalize_source(str(row.get("source") or "")),
                "id": str(row.get("id") or ""),
                "title": row.get("title"),
                "snippet": row.get("snippet"),
                "ref_url": row.get("ref_url"),
                "ts": _iso(row.get("ts")),
                "score": _normalize_score(row.get("score")),
                "_raw_score": _normalize_score(row.get("score")),
            }
        )

    enriched_local = await asyncio.to_thread(_enrich_meeting_rows, sb, normalized_local)
    reranked = _hybrid_rerank(enriched_local + hs_rows, body.query)
    merged = _dedupe_and_sort(reranked, body.k)
    public_rows = [_public_context_row(row) for row in merged]
    _query_cache[cache_key] = (now, public_rows)
    return [ContextItem(**row) for row in public_rows]


def _local_search(
    sb: Client, project_id: str, q_vec: list[float], k: int
) -> list[dict[str, Any]]:
    r = sb.rpc(
        "search_context",
        {"p_project_id": project_id, "q_emb": q_vec, "p_limit": k},
    ).execute()
    return r.data or []


def _dedupe_and_sort(rows: list[dict[str, Any]], k: int) -> list[dict[str, Any]]:
    """Dedupe by ref_url (when set) else by id; sort by rank score."""
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    # First sort so the highest-ranked duplicate wins.
    rows = sorted(
        rows,
        key=lambda r: (
            r.get("_rank_score") is None and r.get("score") is None,
            -((r.get("_rank_score") if r.get("_rank_score") is not None else r.get("score")) or 0.0),
        ),
    )
    for row in rows:
        key = row.get("ref_url") or f"{row.get('origin')}:{row.get('id')}"
        if key in seen:
            continue
        seen.add(key)
        out.append(row)
        if len(out) >= k:
            break
    return out


def _normalize_source(source: str) -> str:
    source = (source or "").strip().lower()
    return {
        "google_drive": "drive",
        "google_mail": "gmail",
    }.get(source, source)


def _normalize_score(score: Any) -> float | None:
    if score is None:
        return None
    try:
        v = float(score)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, v))


def _hybrid_rerank(rows: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
    """Blend semantic score + lexical overlap + recency + source/type priors."""
    terms = [t for t in query.lower().split() if len(t) >= 2]
    for row in rows:
        haystack = f"{row.get('title') or ''} {row.get('snippet') or ''}".lower()
        semantic = row.get("_raw_score")
        if semantic is None:
            semantic = row.get("score") or 0.0
        lexical_hits = sum(1 for t in terms if t in haystack) if terms else 0
        lexical = (lexical_hits / max(1, len(terms))) if terms else 0.0
        recency = _recency_signal(row.get("ts"))
        source_prior = _source_prior(row.get("source") or "", row.get("origin") or "")
        meeting_type_bonus = _meeting_type_prior(row.get("_meeting_type"))
        final = (
            (0.65 * semantic)
            + (0.22 * lexical)
            + (0.08 * recency)
            + source_prior
            + meeting_type_bonus
        )
        # Preserve public `score` as raw semantic similarity for compatibility;
        # use blended score only for ranking.
        row["_rank_score"] = _normalize_score(final)
    rows.sort(
        key=lambda r: (
            r.get("_rank_score") is None and r.get("score") is None,
            -((r.get("_rank_score") if r.get("_rank_score") is not None else r.get("score")) or 0.0),
        ),
    )
    return rows


def _public_context_row(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if not k.startswith("_")}


def _enrich_meeting_rows(sb: Client, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    meeting_ids = [r.get("id") for r in rows if r.get("source") == "meeting" and r.get("id")]
    if not meeting_ids:
        return rows
    # PostgREST encodes .in_(...) into a URL query param (`id=in.(uuid,uuid,…)`)
    # which has an implicit length cap (~2KB across most Supabase proxies). 36-char
    # UUIDs at ~40B encoded each blow past that around ~50 ids. Chunk to be safe.
    type_by_id: dict[str, Any] = {}
    BATCH = 50
    try:
        for i in range(0, len(meeting_ids), BATCH):
            batch = meeting_ids[i : i + BATCH]
            r = (
                sb.table("meeting_notes")
                .select("id,type")
                .in_("id", batch)
                .execute()
            )
            for x in r.data or []:
                type_by_id[str(x.get("id"))] = x.get("type")
    except Exception as e:  # noqa: BLE001
        log.warning("/context/query: meeting enrichment failed: %s", e)
        return rows

    for row in rows:
        if row.get("source") != "meeting":
            continue
        meeting_type = type_by_id.get(str(row.get("id")))
        if not meeting_type:
            continue
        row["_meeting_type"] = meeting_type
        if meeting_type == "decision":
            row["title"] = row.get("title") or "Decision"
        elif meeting_type == "blocker":
            row["title"] = row.get("title") or "Blocker"
    return rows


def _source_prior(source: str, origin: str) -> float:
    if source == "meeting":
        return 0.04
    if source in {"drive", "notion"}:
        return 0.02
    if source == "slack":
        return 0.015
    if origin == "hyperspell":
        return 0.0
    return 0.01


def _meeting_type_prior(meeting_type: Any) -> float:
    if meeting_type == "decision":
        return 0.06
    if meeting_type == "blocker":
        return 0.05
    if meeting_type == "action_item":
        return 0.03
    return 0.0


def _recency_signal(ts: Any) -> float:
    if not ts:
        return 0.0
    try:
        dt = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    age_h = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0)
    if age_h <= 24:
        return 1.0
    if age_h <= 72:
        return 0.7
    if age_h <= 24 * 7:
        return 0.4
    return 0.15


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
