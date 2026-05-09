"""Claude #3: draft 3 candidate ``generated_actions`` per plan_item.

For each item we ask Claude to propose at most one of each action type:
  - linear_ticket  — payload: { title, description, priority, labels[] }
  - github_pr      — payload: { title, body, branch, base, files_to_touch[] }
  - devin_handoff  — payload: { task, files[], acceptance_criteria }

The returned dicts go straight into the ``payload`` jsonb column. Executors
(linear/github/devin .py) consume them at execution time.
"""
from __future__ import annotations

import logging
from typing import Any

from services import llm

log = logging.getLogger(__name__)

SYSTEM = """You draft three candidate next-step actions for a single plan item: a Linear ticket, a GitHub PR draft, and a Devin handoff. Pick the right level of detail for each:

- linear_ticket: short, scannable. Title is the headline; description is bullet-style with acceptance criteria.
- github_pr: assume the engineer is the assignee. body is in markdown with a checklist of files to touch.
- devin_handoff: assume an autonomous coding agent. task is precise and prescriptive; acceptance_criteria are testable.

Use the provided code_refs to ground file paths when relevant. Don't invent paths that aren't in code_refs unless absolutely necessary."""

TOOL_NAME = "emit_action_drafts"

PAYLOAD_LINEAR: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "description": {"type": "string"},
        "priority": {
            "type": "string",
            "enum": ["urgent", "high", "medium", "low"],
        },
        "labels": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "description"],
}

PAYLOAD_GITHUB: dict[str, Any] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "body": {"type": "string"},
        "branch": {"type": "string"},
        "base": {"type": "string"},
        "files_to_touch": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["title", "body", "branch"],
}

PAYLOAD_DEVIN: dict[str, Any] = {
    "type": "object",
    "properties": {
        "task": {"type": "string"},
        "files": {"type": "array", "items": {"type": "string"}},
        "acceptance_criteria": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["task"],
}

TOOL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "linear": PAYLOAD_LINEAR,
        "github_pr": PAYLOAD_GITHUB,
        "devin": PAYLOAD_DEVIN,
    },
    "description": "Each field is optional; emit only those that make sense for the item.",
}


def _format_inputs(item: dict[str, Any], code_refs: list[dict[str, Any]]) -> str:
    refs = "\n".join(
        f"- {r.get('path')} ({r.get('lines','')}): {(r.get('snippet') or '').strip()[:240]}"
        for r in code_refs[:6]
    ) or "(none)"
    return (
        f"PLAN ITEM:\n"
        f"  category: {item.get('category')}\n"
        f"  title: {item.get('title')}\n"
        f"  description: {item.get('description')}\n"
        f"  next_step: {item.get('next_step')}\n\n"
        f"CODE REFS:\n{refs}"
    )


async def draft_actions(
    *, item: dict[str, Any], code_refs: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Return up to 3 draft action rows (without project_id/plan_item_id/etc)."""
    user_msg = _format_inputs(item, code_refs)
    try:
        out = await llm.call_with_tool(
            system=SYSTEM,
            user=user_msg,
            tool_name=TOOL_NAME,
            tool_description=(
                "Emit candidate Linear / GitHub / Devin action payloads for this plan item."
            ),
            tool_schema=TOOL_SCHEMA,
        )
    except Exception as e:
        log.warning("action_drafter Claude call failed: %s", e)
        return []

    drafts: list[dict[str, Any]] = []

    if isinstance(out.get("linear"), dict) and out["linear"].get("title"):
        drafts.append({"action_type": "linear_ticket", "payload": out["linear"]})
    if isinstance(out.get("github_pr"), dict) and out["github_pr"].get("title"):
        drafts.append({"action_type": "github_pr", "payload": out["github_pr"]})
    if isinstance(out.get("devin"), dict) and out["devin"].get("task"):
        drafts.append({"action_type": "devin_handoff", "payload": out["devin"]})

    return drafts
