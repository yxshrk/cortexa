"""Action executors. Stubbed for the demo; swap in real API calls when ready.

Each executor takes the row's ``payload`` jsonb and returns an external URL.
The router writes ``status='executed'`` + ``external_url`` on success, or
``status='failed'`` on any exception.

Stubs return plausibly-shaped fake URLs so the frontend can render them. They
also log what they would have sent so it's easy to verify correctness during
the demo.
"""
from __future__ import annotations

import logging
import re
import time
from typing import Any
from uuid import uuid4

log = logging.getLogger(__name__)


def _slugify(text: str, *, max_len: int = 48) -> str:
    s = re.sub(r"[^a-zA-Z0-9]+", "-", (text or "").strip().lower())
    s = s.strip("-") or "task"
    return s[:max_len]


async def execute_linear_ticket(payload: dict[str, Any]) -> str:
    """Stub: pretend to create a Linear issue, return a fake URL.

    Real impl would POST GraphQL mutation ``issueCreate`` to api.linear.app.
    """
    title = payload.get("title", "Untitled")
    log.info(
        "STUB linear.create_issue title=%r priority=%s labels=%s",
        title,
        payload.get("priority"),
        payload.get("labels"),
    )
    issue_key = f"ENG-{int(time.time()) % 10000:04d}"
    return f"https://linear.app/demo/issue/{issue_key}/{_slugify(title)}"


async def execute_github_pr(payload: dict[str, Any]) -> str:
    """Stub: pretend to open a draft PR, return a fake URL.

    Real impl would create-or-checkout the branch, push, then call
    ``POST /repos/{owner}/{repo}/pulls`` with ``draft=true``.
    """
    title = payload.get("title", "Untitled")
    branch = payload.get("branch") or f"feat/{_slugify(title)}"
    log.info(
        "STUB github.create_pr_draft title=%r branch=%s files=%s",
        title,
        branch,
        payload.get("files_to_touch"),
    )
    pr_number = int(time.time()) % 9000 + 100
    return f"https://github.com/demo-org/demo-repo/pull/{pr_number}"


async def execute_devin_handoff(payload: dict[str, Any]) -> str:
    """Stub: pretend to start a Devin session, return a fake URL."""
    task = payload.get("task", "")
    log.info(
        "STUB devin.send task=%r files=%s",
        task[:120],
        payload.get("files"),
    )
    session_id = uuid4().hex[:12]
    return f"https://devin.ai/sessions/{session_id}"


# Dispatch table — referenced by routers/actions.py
DISPATCH = {
    "linear_ticket": execute_linear_ticket,
    "github_pr": execute_github_pr,
    "devin_handoff": execute_devin_handoff,
}
