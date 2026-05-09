"""Look up code references for a plan_item.

Two paths:

  1. Hyperspell GitHub search (when ``HYPERSPELL_GITHUB_AVAILABLE=true`` AND the
     project has a hyperspell_user_id with a GitHub connection). 2s timeout.
  2. Static fixture in ``backend/fixtures/seed_code_refs.json``. Substring-match
     the ``code_query`` against the fixture keys; return the matching list.

The static fallback is the demo-day safety net: if Hyperspell GitHub beta is
unavailable or unconnected, we still produce believable file/line references
for the canned demo signals (rate-limit, Safari login, CSV export).
"""
from __future__ import annotations

import asyncio
import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any

from settings import get_settings

log = logging.getLogger(__name__)

FIXTURE_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "seed_code_refs.json"
HYPERSPELL_GITHUB_TIMEOUT_S = 2.0
MAX_REFS = 3


@lru_cache(maxsize=1)
def _load_fixture() -> dict[str, list[dict[str, Any]]]:
    try:
        raw = json.loads(FIXTURE_PATH.read_text())
    except FileNotFoundError:
        log.warning("seed_code_refs.json not found at %s", FIXTURE_PATH)
        return {}
    except json.JSONDecodeError as e:
        log.warning("seed_code_refs.json invalid JSON: %s", e)
        return {}
    return {k: v for k, v in raw.items() if not k.startswith("_") and isinstance(v, list)}


def _fixture_match(query: str) -> list[dict[str, Any]]:
    """Substring-match the query against fixture keys."""
    if not query:
        return []
    fixture = _load_fixture()
    q_lower = query.lower()
    # Score = length of the longest matching key substring; pick top match.
    best_key: str | None = None
    best_score = 0
    for key in fixture:
        kl = key.lower()
        if kl in q_lower or q_lower in kl:
            score = len(set(kl.split()) & set(q_lower.split())) or len(kl)
            if score > best_score:
                best_score = score
                best_key = key
    if not best_key:
        return []
    return list(fixture[best_key][:MAX_REFS])


async def get_code_refs(
    *, query: str, hyperspell_user_id: str | None = None
) -> list[dict[str, Any]]:
    """Return ≤3 code references for a plan_item's ``code_query``.

    Each reference is ``{"path": str, "lines": str, "snippet": str}``.
    """
    settings = get_settings()
    if settings.hyperspell_github_available and hyperspell_user_id:
        try:
            refs = await asyncio.wait_for(
                _hyperspell_github_search(query=query, hyperspell_user_id=hyperspell_user_id),
                timeout=HYPERSPELL_GITHUB_TIMEOUT_S,
            )
            if refs:
                return refs
        except asyncio.TimeoutError:
            log.info("Hyperspell GitHub search timed out for %r", query)
        except Exception as e:  # noqa: BLE001
            log.warning("Hyperspell GitHub search failed: %s", e)
    return _fixture_match(query)


async def _hyperspell_github_search(
    *, query: str, hyperspell_user_id: str
) -> list[dict[str, Any]]:
    # Imported here so unit tests / non-Hyperspell paths don't pay the cost.
    from services import hyperspell

    res = await hyperspell.search_with_answer(
        hyperspell_user_id=hyperspell_user_id,
        query=query,
        hs_sources=["github"],
        answer=False,
        max_results=MAX_REFS,
    )
    out: list[dict[str, Any]] = []
    for hit in res.hits:
        # Hyperspell search hits don't carry line ranges; surface what we can.
        out.append(
            {
                "path": hit.title or hit.resource_id or "",
                "lines": "",
                "snippet": "",
                "ref_url": hit.ref_url,
            }
        )
    return out
