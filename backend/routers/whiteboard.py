"""WebSocket endpoint that owns the live whiteboard for a meeting.

Architecture (Phase 1 of the autopreso integration):

    Frontend Realtime ASR  ──transcript.completed──▶  /ws/whiteboard/{meeting_id}
                                                              │
                                                              ▼
                                                       TranscriptTurnQueue
                                                              │
                                                              ▼
                                              context retrieval (pgvector + Hyperspell)
                                                              │
                                                              ▼
                                                  GPT-4.1 diagram planner
                                                              │
                                                              ▼
                                            broadcast {type: "whiteboard.update", plan}
                                                              │
                                                              ▼
                                                  All connected clients

The OpenAI Realtime model is intentionally NOT involved in reasoning anymore —
it just transcribes. All planning happens here, behind a debounced turn queue,
on a stronger reasoning model.
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from openai import AsyncOpenAI
from supabase import Client

from dependencies import get_supabase
from routers.context import QueryBody, context_query
from services import supabase_writer
from services.transcript_turn_queue import TranscriptTurnQueue
from services.whiteboard_planner import plan_whiteboard
from settings import get_settings

router = APIRouter(prefix="/ws", tags=["whiteboard"])
log = logging.getLogger(__name__)

# Per-meeting session registry. Multiple clients viewing the same meeting share
# one queue + one last-plan cache so a late joiner sees the current state.
_sessions: dict[str, "WhiteboardSession"] = {}


class WhiteboardSession:
    """Owns the per-meeting turn queue, planner state, and connected clients."""

    def __init__(
        self,
        *,
        meeting_id: str,
        project_id: str,
        sb: Client,
        openai_client: AsyncOpenAI,
    ) -> None:
        self.meeting_id = meeting_id
        self.project_id = project_id
        self.sb = sb
        self.openai = openai_client
        self.connections: set[WebSocket] = set()
        self.queue = TranscriptTurnQueue(run_turn=self._run_turn, debounce_ms=600)
        self.last_plan: dict[str, Any] | None = None
        self.last_context_items: list[dict[str, Any]] = []

    async def add_connection(self, ws: WebSocket) -> None:
        self.connections.add(ws)
        if self.last_plan:
            await ws.send_json(
                {
                    "type": "whiteboard.update",
                    "plan": self.last_plan,
                    "context": self.last_context_items[:10],
                }
            )

    def remove_connection(self, ws: WebSocket) -> None:
        self.connections.discard(ws)

    def enqueue_transcript(self, text: str) -> None:
        self.queue.enqueue(text)

    async def reset(self) -> None:
        self.last_plan = None
        self.last_context_items = []
        await self._broadcast({"type": "whiteboard.reset"})

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for ws in list(self.connections):
            try:
                await ws.send_json(payload)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.connections.discard(ws)

    async def _run_turn(self, transcript: str) -> None:
        await self._broadcast({"type": "planner.status", "state": "planning"})
        try:
            # Use the most recent transcript window as the retrieval query. The
            # vector search RPC normalizes via embeddings, so passing raw text
            # works fine.
            query = transcript[-1500:].strip()
            if not query:
                await self._broadcast({"type": "planner.status", "state": "idle"})
                return

            body = QueryBody(projectId=self.project_id, query=query, k=8)
            try:
                items_models = await context_query(body=body, sb=self.sb)
            except Exception:  # noqa: BLE001
                log.exception("whiteboard turn: context retrieval failed")
                items_models = []
            context_items = [item.model_dump() for item in items_models]

            plan = await plan_whiteboard(
                openai_client=self.openai,
                topic=transcript[-300:].strip(),
                transcript_window=transcript,
                context_items=context_items,
            )
            if plan is None:
                # Empty input or planner failure — leave whatever was last there.
                await self._broadcast(
                    {
                        "type": "planner.status",
                        "state": "ready",
                        "message": "no plan emitted (no context yet?)",
                    }
                )
                return

            self.last_plan = plan
            self.last_context_items = context_items
            await self._broadcast(
                {
                    "type": "whiteboard.update",
                    "plan": plan,
                    "context": context_items[:10],
                    "transcript_window": transcript[-300:],
                }
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("whiteboard turn failed")
            await self._broadcast(
                {"type": "planner.status", "state": "error", "message": str(exc)}
            )


@router.websocket("/whiteboard/{meeting_id}")
async def whiteboard_ws(
    ws: WebSocket,
    meeting_id: str,
    projectId: str = Query(..., description="Project id this meeting belongs to."),
    sb: Client = Depends(get_supabase),
) -> None:
    await ws.accept()

    settings = get_settings()
    if not settings.openai_key:
        await ws.send_json(
            {"type": "error", "message": "OPENAI_API_KEY not configured"}
        )
        await ws.close()
        return

    project = supabase_writer.get_project(sb, projectId)
    if not project:
        await ws.send_json(
            {"type": "error", "message": f"project {projectId} not found"}
        )
        await ws.close()
        return

    session = _sessions.get(meeting_id)
    if not session:
        session = WhiteboardSession(
            meeting_id=meeting_id,
            project_id=projectId,
            sb=sb,
            openai_client=AsyncOpenAI(api_key=settings.openai_key),
        )
        _sessions[meeting_id] = session

    await session.add_connection(ws)
    log.info(
        "whiteboard ws connected meeting=%s project=%s connections=%d",
        meeting_id,
        projectId,
        len(session.connections),
    )

    try:
        while True:
            msg = await ws.receive_json()
            mtype = msg.get("type")
            if mtype == "transcript.completed":
                text = (msg.get("text") or "").strip()
                if text:
                    session.enqueue_transcript(text)
            elif mtype == "session.reset":
                await session.reset()
            elif mtype == "ping":
                await ws.send_json({"type": "pong"})
            # transcript.delta events are ignored — turn boundaries come from
            # the ASR's `completed` events upstream.
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        log.exception("whiteboard ws unexpected error meeting=%s", meeting_id)
    finally:
        session.remove_connection(ws)
        log.info(
            "whiteboard ws disconnected meeting=%s remaining=%d",
            meeting_id,
            len(session.connections),
        )
        if not session.connections:
            _sessions.pop(meeting_id, None)
