"""Claude #1: synthesize a week's notes + project_context into a knowledge_document.

Output shape matches the ``knowledge_documents`` table columns we fill in
``/plan/generate``: summary, themes[], decisions[], blockers[], open_questions[],
plus the source_*_ids arrays so we can show provenance later.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from services import llm

log = logging.getLogger(__name__)

SYSTEM = """You are a senior PM synthesizing a project's last 7 days of meeting notes and external context (Slack, Drive, Notion, Gmail) into a structured weekly knowledge document.

Be concrete: name the actual feature, bug, or decision. Avoid generic phrasing like "the team discussed X". Keep arrays short (≤ 8 entries each); only include items clearly grounded in the input. If you have nothing for a field, return an empty list."""

TOOL_NAME = "emit_knowledge_document"

TOOL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": "2–4 sentence narrative of the week. Concrete and specific.",
        },
        "themes": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Top recurring themes/initiatives. Short noun phrases.",
        },
        "decisions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Decisions that were made (not just discussed).",
        },
        "blockers": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Things explicitly blocking progress.",
        },
        "open_questions": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Things that still need an answer or owner.",
        },
    },
    "required": ["summary", "themes", "decisions", "blockers", "open_questions"],
}


def _truncate(text: str, n: int = 1200) -> str:
    text = (text or "").strip()
    return text if len(text) <= n else text[: n - 1] + "…"


def _format_inputs(notes: list[dict[str, Any]], context: list[dict[str, Any]]) -> str:
    note_lines = [
        f"- [{n.get('type', 'fyi')}] {_truncate(str(n.get('text', '')), 600)}"
        for n in notes[:80]
    ]
    ctx_lines = [
        (
            f"- [{c.get('source')}] "
            f"{_truncate(str(c.get('title') or c.get('snippet') or ''), 400)}"
            + (f" ({c.get('author')})" if c.get('author') else "")
        )
        for c in context[:80]
    ]
    parts = []
    if note_lines:
        parts.append("MEETING NOTES (last 7 days):\n" + "\n".join(note_lines))
    if ctx_lines:
        parts.append("PROJECT CONTEXT (last 7 days):\n" + "\n".join(ctx_lines))
    if not parts:
        parts.append("(no recent inputs)")
    return "\n\n".join(parts)


async def synthesize(
    *,
    notes: list[dict[str, Any]],
    context: list[dict[str, Any]],
    emit: llm.EmitFn | None = None,
) -> dict[str, Any]:
    """Return a partial ``knowledge_documents`` row.

    Caller fills in project_id, week_start, week_end, source_*_ids, status.
    """
    user_msg = _format_inputs(notes, context)
    try:
        out = await llm.call_with_tool(
            system=SYSTEM,
            user=user_msg,
            tool_name=TOOL_NAME,
            tool_description="Emit a structured weekly knowledge document.",
            tool_schema=TOOL_SCHEMA,
            emit=emit,
            emit_phase="synthesize",
        )
    except Exception as e:
        log.warning("synthesizer LLM call failed, using empty doc: %s", e)
        return _empty()

    return {
        "summary": str(out.get("summary") or ""),
        "themes": _as_jsonable_list(out.get("themes")),
        "decisions": _as_jsonable_list(out.get("decisions")),
        "blockers": _as_jsonable_list(out.get("blockers")),
        "open_questions": _as_jsonable_list(out.get("open_questions")),
    }


def _as_jsonable_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    # Defensive: if Claude returned a JSON-encoded string, parse it.
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
    return [value]


def _empty() -> dict[str, Any]:
    return {
        "summary": "",
        "themes": [],
        "decisions": [],
        "blockers": [],
        "open_questions": [],
    }
