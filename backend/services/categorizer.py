"""Claude #2: turn a knowledge document into categorized plan_items.

Categories are constrained to ``plan_item_category`` enum:
  - bug_fix     — concrete defect with reproducible behavior
  - new_feature — net-new capability or significant enhancement
  - maintenance — refactor, infra, follow-up, cleanup

Each item also carries a short ``code_query`` string the executor will hand
to ``services.code_refs.get_code_refs`` to pull related code snippets.
"""
from __future__ import annotations

import logging
from typing import Any

from services import llm

log = logging.getLogger(__name__)

SYSTEM = """You are a tech lead converting a synthesized weekly knowledge doc into a small set of concrete, actionable plan items.

Rules:
- Choose exactly one category per item: 'bug_fix', 'new_feature', or 'maintenance'.
- Items must be specific enough that an engineer can pick one up: name the feature, the bug, or the system.
- Cap at 8 items total; favor higher-confidence items over filler.
- 'next_step' should be the single most useful next move (≤ 1 sentence).
- 'code_query' is a search string used to look up relevant code (≤ 8 words). Keep it specific."""

TOOL_NAME = "emit_plan_items"

ITEM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "category": {"type": "string", "enum": ["bug_fix", "new_feature", "maintenance"]},
        "title": {"type": "string"},
        "description": {"type": "string"},
        "next_step": {"type": "string"},
        "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": "How sure you are this is a real item (not a hallucination). 0–1.",
        },
        "code_query": {
            "type": "string",
            "description": "Search query to find related code (≤ 8 words).",
        },
        "source_refs": {
            "type": "array",
            "description": "Free-form references back to the inputs (themes, doc titles, note IDs). Optional.",
            "items": {"type": "string"},
        },
    },
    "required": ["category", "title", "description", "next_step", "confidence", "code_query"],
}

TOOL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "minItems": 0,
            "maxItems": 8,
            "items": ITEM_SCHEMA,
        }
    },
    "required": ["items"],
}


def _format_doc(doc: dict[str, Any]) -> str:
    def _bul(label: str, items: list[Any]) -> str:
        if not items:
            return f"{label}: (none)"
        body = "\n".join(f"  - {x}" for x in items[:12])
        return f"{label}:\n{body}"

    summary = (doc.get("summary") or "").strip() or "(no summary)"
    return "\n\n".join(
        [
            "WEEKLY SUMMARY:\n" + summary,
            _bul("THEMES", doc.get("themes") or []),
            _bul("DECISIONS", doc.get("decisions") or []),
            _bul("BLOCKERS", doc.get("blockers") or []),
            _bul("OPEN QUESTIONS", doc.get("open_questions") or []),
        ]
    )


async def categorize(doc: dict[str, Any]) -> list[dict[str, Any]]:
    """Return a list of partial ``plan_items`` rows.

    Caller fills knowledge_document_id, project_id, generation_run_id, code_refs.
    """
    user_msg = _format_doc(doc)
    try:
        out = await llm.call_with_tool(
            system=SYSTEM,
            user=user_msg,
            tool_name=TOOL_NAME,
            tool_description="Emit a list of concrete, categorized plan items.",
            tool_schema=TOOL_SCHEMA,
        )
    except Exception as e:
        log.warning("categorizer Claude call failed, returning empty list: %s", e)
        return []

    raw_items = out.get("items") or []
    if not isinstance(raw_items, list):
        return []

    cleaned: list[dict[str, Any]] = []
    for it in raw_items:
        if not isinstance(it, dict):
            continue
        category = it.get("category")
        if category not in ("bug_fix", "new_feature", "maintenance"):
            continue
        cleaned.append(
            {
                "category": category,
                "title": str(it.get("title") or "").strip() or "(untitled)",
                "description": str(it.get("description") or "").strip(),
                "next_step": str(it.get("next_step") or "").strip(),
                "confidence": _coerce_confidence(it.get("confidence")),
                "code_query": str(it.get("code_query") or "").strip(),
                "source_refs": it.get("source_refs") or [],
            }
        )
    return cleaned


def _coerce_confidence(value: Any) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.5
    if n < 0:
        return 0.0
    if n > 1:
        return 1.0
    return n
