"""Asyncio port of autopreso's transcript-turn-queue.

Buffers transcript chunks, debounces bursts, gates on an `is_ready` predicate,
and runs at most one turn at a time. Chunks arriving during a turn are buffered
and concatenated into the next turn so the planner always sees the most recent
burst of speech in a single shot.

Filler-only utterances ("uh", "okay", etc.) are filtered upstream via the
default `is_ready` predicate so they don't trigger turns on their own.
"""
from __future__ import annotations

import asyncio
import logging
import re
from typing import Awaitable, Callable

log = logging.getLogger(__name__)

RunTurn = Callable[[str], Awaitable[None]]
IsReady = Callable[[str], bool]

_FILLER_PATTERN = re.compile(
    r"^(uh+|um+|hmm+|mhm+|okay\.?|ok\.?|yeah\.?|yep\.?|right\.?|alright\.?|so\.?|like|you know|i mean)$",
    re.IGNORECASE,
)
_PUNCT_STRIP = re.compile(r"[^\w\s]")


def is_trivial_transcript(text: str) -> bool:
    s = (text or "").strip()
    if not s:
        return True
    cleaned = _PUNCT_STRIP.sub("", s).strip()
    if not cleaned:
        return True
    words = cleaned.split()
    if len(words) <= 3 and all(_FILLER_PATTERN.match(w) for w in words):
        return True
    return False


def default_is_ready(text: str) -> bool:
    """Require ≥4 non-filler words before letting a turn fire."""
    if is_trivial_transcript(text):
        return False
    cleaned = _PUNCT_STRIP.sub("", text).split()
    return len(cleaned) >= 4


class TranscriptTurnQueue:
    """Single-flight turn queue with debounce + readiness gating.

    Usage:
        queue = TranscriptTurnQueue(run_turn=async_handler)
        queue.enqueue("first burst")
        queue.enqueue("second burst")  # coalesced via debounce

    Implementation note: relies on asyncio's single-threaded loop semantics —
    no locks needed as long as no `await` occurs between operations on shared
    state.
    """

    def __init__(
        self,
        *,
        run_turn: RunTurn,
        debounce_ms: int = 600,
        is_ready: IsReady | None = None,
    ) -> None:
        self._run_turn = run_turn
        self._debounce_s = debounce_ms / 1000.0
        self._is_ready = is_ready or default_is_ready
        self._pending: list[str] = []
        self._buffered: list[str] = []
        self._running = False
        self._debounce_task: asyncio.Task[None] | None = None

    def enqueue(self, text: str) -> None:
        chunk = (text or "").strip()
        if not chunk:
            return
        self._pending.append(chunk)
        if self._debounce_task and not self._debounce_task.done():
            self._debounce_task.cancel()
        if self._debounce_s <= 0:
            self._flush()
        else:
            self._debounce_task = asyncio.create_task(self._debounce_then_flush())

    async def _debounce_then_flush(self) -> None:
        try:
            await asyncio.sleep(self._debounce_s)
        except asyncio.CancelledError:
            return
        self._flush()

    def _flush(self, *, force: bool = False) -> None:
        if not self._pending:
            return
        text = "\n".join(self._pending)
        if not force and not self._is_ready(text):
            # Keep accumulating; next enqueue restarts the debounce timer.
            return
        self._pending.clear()
        if self._running:
            self._buffered.append(text)
            return
        self._running = True
        asyncio.create_task(self._drain(text))

    async def _drain(self, text: str) -> None:
        try:
            await self._run_turn(text)
        except Exception:  # noqa: BLE001
            log.exception("transcript turn handler failed")
        finally:
            if self._buffered:
                next_text = "\n".join(self._buffered)
                self._buffered.clear()
                asyncio.create_task(self._drain(next_text))
            else:
                self._running = False
                if self._pending:
                    if self._debounce_task and not self._debounce_task.done():
                        self._debounce_task.cancel()
                    self._flush()

    async def idle(self) -> None:
        """Force-flush pending content and wait until no work is in flight."""
        while self._pending or self._running or (self._debounce_task and not self._debounce_task.done()):
            if self._debounce_task and not self._debounce_task.done():
                self._debounce_task.cancel()
            if self._pending:
                self._flush(force=True)
            await asyncio.sleep(0.05)
