"""POST /search — unified search across Hyperspell + local pgvector.

Two parallel calls, merged in the response:

  1. Hyperspell `memories.search` over the user's connected sources.
     Optionally `answer=true` for an LLM-synthesized answer.
  2. Supabase `search_context(p_project_id, q_emb, p_limit)` RPC over the local
     pgvector mirror of `meeting_notes` + `project_context`.

Why both? See `supabase/DATABASE.md` ("Supabase ↔ Hyperspell role split"):
local pgvector is sub-100ms and resilient if Hyperspell is slow; Hyperspell
ranks across raw connector data we may not have mirrored yet.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from supabase import Client

from dependencies import get_supabase, require_demo_token
from services import embeddings, hyperspell, supabase_writer

router = APIRouter(prefix="/search", tags=["search"])
log = logging.getLogger(__name__)

# How long we wait on Hyperspell before giving up and returning local-only.
# Local pgvector is the floor; Hyperspell is the upgrade.
HYPERSPELL_TIMEOUT_S = 5.0

DBSource = Literal["slack", "drive", "notion", "gmail"]


class SearchBody(BaseModel):
    projectId: str
    query: str
    sources: list[DBSource] | None = Field(
        default=None,
        description="Restrict Hyperspell search to these sources. None = all connected.",
    )
    answer: bool = False
    max_results: int = 10
    include_local: bool = Field(
        default=True,
        description="Also run the local pgvector search_context RPC and merge.",
    )


class SearchHitOut(BaseModel):
    origin: Literal["hyperspell", "local"]
    source: str
    id: str
    title: str | None
    snippet: str | None
    ref_url: str | None
    score: float | None


class SearchResponse(BaseModel):
    answer: str | None
    query_id: str | None
    hits: list[SearchHitOut]
    hyperspell_ok: bool
    local_ok: bool


@router.post(
    "",
    response_model=SearchResponse,
    dependencies=[Depends(require_demo_token)],
)
async def search(body: SearchBody, sb: Client = Depends(get_supabase)) -> SearchResponse:
    project = supabase_writer.get_project(sb, body.projectId)
    if not project:
        raise HTTPException(404, f"project {body.projectId} not found")

    user_id = project.get("hyperspell_user_id") or f"pri-{body.projectId}"

    hs_sources: list[str] = []
    for db_src in (body.sources or []):
        hs = hyperspell.DB_TO_HS_SOURCE.get(db_src)
        if hs and hs in hyperspell.HS_TO_DB_SOURCE:
            hs_sources.append(hs)

    # Run both in parallel; either can fail without sinking the request.
    hs_task = asyncio.create_task(
        asyncio.wait_for(
            hyperspell.search_with_answer(
                hyperspell_user_id=user_id,
                query=body.query,
                hs_sources=hs_sources or None,
                answer=body.answer,
                max_results=body.max_results,
            ),
            timeout=HYPERSPELL_TIMEOUT_S,
        )
    )
    local_task = asyncio.create_task(
        _local_search(sb, body.projectId, body.query, body.max_results)
    ) if body.include_local else None

    hyperspell_ok = True
    local_ok = True
    hits_out: list[SearchHitOut] = []
    answer_text: str | None = None
    query_id: str | None = None

    try:
        hs_res = await hs_task
        answer_text = hs_res.answer
        query_id = hs_res.query_id
        for h in hs_res.hits:
            hits_out.append(
                SearchHitOut(
                    origin="hyperspell",
                    source=h.source,
                    id=h.resource_id,
                    title=h.title,
                    snippet=None,
                    ref_url=h.ref_url,
                    score=h.score,
                )
            )
    except asyncio.TimeoutError:
        hyperspell_ok = False
        log.warning("hyperspell.search timed out after %ss", HYPERSPELL_TIMEOUT_S)
    except Exception as e:
        hyperspell_ok = False
        log.warning("hyperspell.search failed: %s", e)

    if local_task is not None:
        try:
            local_rows = await local_task
            for r in local_rows:
                hits_out.append(
                    SearchHitOut(
                        origin="local",
                        source=str(r.get("source") or ""),
                        id=str(r.get("id") or ""),
                        title=r.get("title"),
                        snippet=r.get("snippet"),
                        ref_url=r.get("ref_url"),
                        score=float(r["score"]) if r.get("score") is not None else None,
                    )
                )
        except Exception as e:
            local_ok = False
            log.warning("local search_context failed: %s", e)

    # Sort: hits with scores first (descending), then unscored.
    hits_out.sort(key=lambda h: (h.score is None, -(h.score or 0.0)))

    return SearchResponse(
        answer=answer_text,
        query_id=query_id,
        hits=hits_out[: body.max_results * 2],  # allow room for both halves
        hyperspell_ok=hyperspell_ok,
        local_ok=local_ok,
    )


async def _local_search(
    sb: Client, project_id: str, query: str, k: int
) -> list[dict[str, Any]]:
    """Embed the query and call the search_context RPC."""
    q_vec = await embeddings.embed_one(query)
    # Supabase Python client is sync — wrap in to_thread to keep this coroutine cheap.
    def _do() -> Any:
        r = sb.rpc(
            "search_context",
            {"p_project_id": project_id, "q_emb": q_vec, "p_limit": k},
        ).execute()
        return r.data or []

    return await asyncio.to_thread(_do)
