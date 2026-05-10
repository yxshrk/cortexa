"""Free-form whiteboard planner (Phase 2).

The planner picks a layout (flow / comparison / hierarchy / timeline / kanban /
cluster / matrix) per moment and emits raw whiteboard elements with x/y/w/h —
not a fixed-group node graph. The frontend renders them directly through
Excalidraw without any layout engine in between.

Output schema mirrors ``frontend/lib/whiteboardElements.ts``. Both must move
together.
"""
from __future__ import annotations

import json
import logging
from typing import Any

from openai import AsyncOpenAI

log = logging.getLogger(__name__)


# ── JSON schema for OpenAI structured output ─────────────────────────────────
# OpenAI strict-mode constraints:
#   - additionalProperties: false at every object level
#   - every property listed must be in `required` (use `["string", "null"]` for
#     optional behavior)
#   - anyOf is supported and is the right tool for the discriminated element
#     union (rect/ellipse/diamond vs arrow vs text)
_SHAPE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "enum": ["rect", "ellipse", "diamond"]},
        "id": {"type": "string"},
        "x": {"type": "number"},
        "y": {"type": "number"},
        "width": {"type": "number"},
        "height": {"type": "number"},
        "label": {"type": ["string", "null"]},
        "backgroundColor": {"type": ["string", "null"]},
        "strokeColor": {"type": ["string", "null"]},
    },
    "required": [
        "kind",
        "id",
        "x",
        "y",
        "width",
        "height",
        "label",
        "backgroundColor",
        "strokeColor",
    ],
}

_ARROW_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "enum": ["arrow"]},
        "id": {"type": "string"},
        "from": {"type": "string"},
        "to": {"type": "string"},
        "label": {"type": ["string", "null"]},
    },
    "required": ["kind", "id", "from", "to", "label"],
}

_TEXT_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "kind": {"type": "string", "enum": ["text"]},
        "id": {"type": "string"},
        "x": {"type": "number"},
        "y": {"type": "number"},
        "text": {"type": "string"},
        "fontSize": {"type": ["integer", "null"]},
    },
    "required": ["kind", "id", "x", "y", "text", "fontSize"],
}


WHITEBOARD_PLAN_JSON_SCHEMA: dict[str, Any] = {
    "name": "whiteboard_plan",
    "schema": {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "topic": {
                "type": "string",
                "description": "One-line summary of what the speaker is discussing right now.",
            },
            "layout": {
                "type": "string",
                "enum": [
                    "flow",
                    "comparison",
                    "hierarchy",
                    "timeline",
                    "kanban",
                    "cluster",
                    "matrix",
                    "freeform",
                ],
                "description": "The visual form best suited to the current moment.",
            },
            "rationale": {
                "type": "string",
                "description": "One short sentence on why this layout fits.",
            },
            "elements": {
                "type": "array",
                "minItems": 1,
                "maxItems": 24,
                "items": {
                    "anyOf": [_SHAPE_SCHEMA, _ARROW_SCHEMA, _TEXT_SCHEMA],
                },
            },
        },
        "required": ["topic", "layout", "rationale", "elements"],
    },
    "strict": True,
}


# ── System prompt ────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are a real-time whiteboarding agent for an engineering meeting.

You receive: (a) the most recent transcript window, and (b) a set of retrieved project context items (files, Slack/Notion/Drive/Gmail, code refs).

You emit: a compact whiteboard scene that helps the audience understand the current moment. The scene is rendered on Excalidraw via raw shapes (rect, ellipse, diamond, arrow, text) with x/y/width/height in canvas coordinates.

PICK THE RIGHT LAYOUT
- "flow": process / data path / sequence of steps. Place left→right.
- "comparison": option A vs option B vs … . Two or three vertical columns.
- "hierarchy": tree / parent→children. Root on top.
- "timeline": phases on an x-axis. Left=earlier, right=later.
- "kanban": problems / decided / open. Three vertical columns of cards.
- "cluster": related concepts grouped by proximity, no strict structure.
- "matrix": 2x2 grid (e.g. impact vs effort).
- "freeform": when none of the above fit naturally.
Choose what the speaker is *actually* expressing right now, not the most general option.

CANVAS CONVENTIONS
- Treat the canvas as roughly 0–1600 x 0–900. Use the full width when helpful.
- Default node size: rect 240x80, ellipse 200x80, diamond 200x100. You may go larger for emphasis.
- Default font size: 18 for shape labels, 14 for arrow labels, 22 for the title (a standalone text element placed near the top).
- Leave at least 24px between adjacent shapes; arrows need a small gap (≈8px) at each endpoint.

ELEMENT BUDGET
- Aim for 6–12 elements. Hard cap 24. Density is the enemy of comprehension.
- Each shape should communicate one thing. Don't pair a labeled shape with a separate caption text — fold the caption into the label.

LABELS
- Always use the shape's `label` field for text inside a shape. Never place a standalone `text` element on top of a shape — Excalidraw won't center it.
- Standalone `text` elements are reserved for: the canvas title (one per scene), section headers placed clearly OUTSIDE shapes, and axis labels for timelines/matrices.
- Keep shape labels short (3–7 words). If something needs more, the shape is the wrong granularity.

ARROWS
- Connect two visually adjacent shapes only. The straight segment must not cross any other shape.
- Prefer horizontal/vertical alignment. Avoid long diagonal arrows.
- Label only when the relationship is non-obvious. 1–2 words.
- `from` and `to` must reference shape `id`s that exist in the same `elements` array.

COLOR DISCIPLINE (autopreso rule)
- Use at most 2–3 background colors total. Color must encode meaning (e.g. all problems pink, all decisions yellow). If you can't articulate what a color means, don't use it.
- Safe default: one neutral fill (#f8f9fa or #e7f5ff) for most shapes, one accent (#ffe066 / #ffa8a8 / #b2f2bb) for the single most important node. When in doubt, use one color for everything.
- Never assign a different color to each shape just to differentiate them. Position and label already differentiate.

GROUNDING
- Use the provided context items as ground truth for file names, decisions, and ownership. Do not invent files, APIs, tables, or people that aren't mentioned.
- If the moment is too thin to whiteboard meaningfully (filler, small talk, nothing concrete), still emit a single title text element naming the topic so the audience sees the system is alive — but keep it minimal.

IDS
- Use stable short ids: lowercase, words separated by hyphens (e.g. "auth-svc", "user-db", "decide-1").
- Arrow ids must be unique and distinct from shape ids.

Output the schema literally; do not wrap in extra fields.
"""


def _summarize_context_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "source": item.get("source"),
        "title": item.get("title"),
        "snippet": item.get("snippet"),
        "code_path": item.get("code_path"),
        "code_lines": item.get("code_lines"),
        "score": item.get("score"),
    }


def _normalize_element(element: dict[str, Any]) -> dict[str, Any] | None:
    """Strip nulls, validate cross-refs are at least syntactically present."""
    kind = element.get("kind")
    if kind in {"rect", "ellipse", "diamond"}:
        out = {
            "kind": kind,
            "id": str(element.get("id") or "").strip(),
            "x": float(element.get("x") or 0),
            "y": float(element.get("y") or 0),
            "width": float(element.get("width") or 200),
            "height": float(element.get("height") or 80),
        }
        if not out["id"]:
            return None
        for key in ("label", "backgroundColor", "strokeColor"):
            value = element.get(key)
            if value:
                out[key] = value
        return out

    if kind == "arrow":
        from_id = str(element.get("from") or "").strip()
        to_id = str(element.get("to") or "").strip()
        eid = str(element.get("id") or "").strip()
        if not from_id or not to_id or not eid:
            return None
        out = {"kind": "arrow", "id": eid, "from": from_id, "to": to_id}
        label = element.get("label")
        if label:
            out["label"] = label
        return out

    if kind == "text":
        eid = str(element.get("id") or "").strip()
        text_value = (element.get("text") or "").strip()
        if not eid or not text_value:
            return None
        out = {
            "kind": "text",
            "id": eid,
            "x": float(element.get("x") or 0),
            "y": float(element.get("y") or 0),
            "text": text_value,
        }
        font_size = element.get("fontSize")
        if font_size:
            out["fontSize"] = int(font_size)
        return out

    return None


def normalize_plan(plan: dict[str, Any]) -> dict[str, Any]:
    """Drop nulls, drop arrows that reference non-existent shapes."""
    raw_elements = plan.get("elements") or []
    cleaned: list[dict[str, Any]] = []
    for element in raw_elements:
        if not isinstance(element, dict):
            continue
        normalized = _normalize_element(element)
        if normalized:
            cleaned.append(normalized)

    shape_ids = {e["id"] for e in cleaned if e["kind"] in {"rect", "ellipse", "diamond"}}
    final = [
        e
        for e in cleaned
        if e["kind"] != "arrow" or (e.get("from") in shape_ids and e.get("to") in shape_ids)
    ]
    return {
        "topic": plan.get("topic") or "",
        "layout": plan.get("layout") or "freeform",
        "rationale": plan.get("rationale") or "",
        "elements": final,
    }


async def plan_whiteboard(
    *,
    openai_client: AsyncOpenAI,
    topic: str,
    transcript_window: str | None,
    context_items: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """Returns ``{topic, layout, rationale, elements}`` or ``None`` on failure."""
    items = context_items[:10]

    user_payload = {
        "topic": topic,
        "transcript_window": (transcript_window or "")[-1500:],
        "contextItems": [_summarize_context_item(item) for item in items],
    }

    try:
        completion = await openai_client.chat.completions.create(
            model="gpt-5.5-2026-04-23",
            response_format={
                "type": "json_schema",
                "json_schema": WHITEBOARD_PLAN_JSON_SCHEMA,
            },
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(user_payload)},
            ],
        )
    except Exception:  # noqa: BLE001
        log.exception("whiteboard planner: OpenAI call failed")
        return None

    content = completion.choices[0].message.content if completion.choices else None
    if not content:
        return None
    try:
        raw = json.loads(content)
    except json.JSONDecodeError:
        log.warning("whiteboard planner: failed to parse JSON")
        return None

    return normalize_plan(raw)
