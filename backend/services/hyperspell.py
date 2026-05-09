"""Hyperspell wrapper.

Intentionally thin and resilient — Hyperspell SDK details are documented but
some method names are flagged [VERIFY] in `docs/hyperspell.md`. This module
hides those uncertainties behind a stable internal API.

Source-name normalization:
  - Hyperspell:  slack | google_drive | notion | google_mail | github
  - Our DB enum: slack | drive        | notion | gmail       | (github → code_refs only)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Iterable, Literal

from settings import get_settings

log = logging.getLogger(__name__)


# ─── source-name mapping ──────────────────────────────────────────────────────
HS_TO_DB_SOURCE: dict[str, str] = {
    "slack": "slack",
    "google_drive": "drive",
    "notion": "notion",
    "google_mail": "gmail",
    "gmail": "gmail",  # tolerate either upstream spelling
}
DB_TO_HS_SOURCE: dict[str, list[str]] = {
    "slack": ["slack"],
    "drive": ["google_drive"],
    "notion": ["notion"],
    "gmail": ["google_mail"],
}

DBSource = Literal["slack", "drive", "notion", "gmail"]


@dataclass
class HyperspellItem:
    """Normalized item we ingest into project_context."""
    source: DBSource
    external_id: str | None
    title: str | None
    snippet: str | None
    full_text: str
    author: str | None
    ref_url: str | None
    source_created_at: str | None
    source_updated_at: str | None


# ─── client construction ──────────────────────────────────────────────────────
def get_client(hyperspell_user_id: str):
    """Construct a Hyperspell SDK client scoped to a project user.

    The SDK is `pip install hyperspell` (see docs/hyperspell.md). If it's not
    installed yet, callers should expect ImportError and fall back to fixtures.
    """
    s = get_settings()
    if not s.hyperspell_key:
        raise RuntimeError("HYPERSPELL_KEY not set.")
    try:
        from hyperspell import Hyperspell  # type: ignore
    except ImportError as e:  # pragma: no cover
        raise RuntimeError(
            "hyperspell SDK not installed. `pip install hyperspell` and pin in requirements.txt."
        ) from e
    return Hyperspell(api_key=s.hyperspell_key, user_id=hyperspell_user_id)


# ─── core operations ──────────────────────────────────────────────────────────
async def search(
    *,
    hyperspell_user_id: str,
    query: str,
    db_sources: Iterable[DBSource] | None = None,
    k: int = 20,
) -> list[HyperspellItem]:
    """Search Hyperspell for a project. Translates DB source names ↔ Hyperspell names.

    Returns a list of normalized `HyperspellItem`s safe to UPSERT into project_context.
    Embedding is computed elsewhere (services/embeddings.py).
    """
    hs_sources: list[str] = []
    for db_src in (db_sources or []):
        hs_sources.extend(DB_TO_HS_SOURCE.get(db_src, []))

    client = get_client(hyperspell_user_id)
    # NB: SDK returns a synchronous result. If the SDK exposes async methods,
    # swap this for `await client.memories.search(...)`.
    raw = client.memories.search(
        query=query,
        sources=hs_sources or None,
        options={"max_results": k},
    )
    return [_normalize(r) for r in _iter_results(raw) if _normalize(r) is not None]  # type: ignore[misc]


def list_connections(hyperspell_user_id: str) -> dict[str, str]:
    """Return per-source connection status: {db_source: 'connected'|'not_connected'}.

    [VERIFY] Method name on the Hyperspell SDK. Falls back to the empty result
    if the SDK doesn't expose this — caller should layer a heuristic on top.
    """
    try:
        client = get_client(hyperspell_user_id)
        raw = getattr(client, "connections", None)
        if raw is None:
            return {}
        items = list(raw.list())
    except Exception as e:
        log.warning("hyperspell.list_connections failed: %s", e)
        return {}
    out: dict[str, str] = {}
    for it in items:
        hs_src = getattr(it, "source", None) or (it.get("source") if isinstance(it, dict) else None)
        connected = bool(getattr(it, "connected", None) or (it.get("connected") if isinstance(it, dict) else False))
        db_src = HS_TO_DB_SOURCE.get(hs_src or "")
        if db_src:
            out[db_src] = "connected" if connected else "not_connected"
    return out


def connect_url(hyperspell_user_id: str, db_source: DBSource, *, redirect_url: str | None = None) -> str:
    """Mint a Hyperspell-hosted OAuth URL the user opens to authorize a source.

    [VERIFY] exact SDK / REST method name (`docs.hyperspell.com/usage/connect`).
    Until verified, returns a generic dashboard link as a passable fallback —
    the user can finish the connect from there.
    """
    hs_sources = DB_TO_HS_SOURCE.get(db_source, [db_source])
    try:
        client = get_client(hyperspell_user_id)
        # Try a few plausible SDK shapes
        for candidate in ("connect_url", "connections.create", "memories.connect_url"):
            obj: Any = client
            ok = True
            for part in candidate.split("."):
                obj = getattr(obj, part, None)
                if obj is None:
                    ok = False
                    break
            if ok and callable(obj):
                kwargs = {"source": hs_sources[0]}
                if redirect_url:
                    kwargs["redirect_url"] = redirect_url
                url = obj(**kwargs)
                if isinstance(url, str):
                    return url
                if isinstance(url, dict) and "url" in url:
                    return url["url"]
    except Exception as e:
        log.warning("hyperspell.connect_url SDK path failed: %s", e)

    # Fallback: send the user to the Hyperspell dashboard. They can complete
    # the connect manually and our heuristic in /connect/status will pick it up.
    return f"https://app.hyperspell.com/connect?source={hs_sources[0]}&user_id={hyperspell_user_id}"


# ─── normalization helpers ────────────────────────────────────────────────────
def _iter_results(raw: Any) -> Iterable[Any]:
    if raw is None:
        return []
    if hasattr(raw, "results"):
        return raw.results or []
    if isinstance(raw, dict) and "results" in raw:
        return raw["results"] or []
    if isinstance(raw, list):
        return raw
    return []


def _normalize(item: Any) -> HyperspellItem | None:
    """Best-effort normalization — handles SDK objects or dicts."""
    def get(obj: Any, *keys: str, default: Any = None) -> Any:
        for k in keys:
            if isinstance(obj, dict) and k in obj:
                return obj[k]
            v = getattr(obj, k, None)
            if v is not None:
                return v
        return default

    hs_src = get(item, "source", "connector", default="")
    db_source = HS_TO_DB_SOURCE.get(hs_src)
    if not db_source:
        return None  # skip GitHub or unknown sources here; code_refs handles those

    full_text: str = get(item, "text", "content", "body", default="") or ""
    if not full_text:
        return None

    return HyperspellItem(
        source=db_source,  # type: ignore[arg-type]
        external_id=get(item, "id", "external_id", "resource_id"),
        title=get(item, "title", "subject", "name"),
        snippet=(get(item, "snippet") or full_text[:500]),
        full_text=full_text,
        author=get(item, "author", "from", "user"),
        ref_url=get(item, "url", "href", "ref_url"),
        source_created_at=get(item, "created_at", "createdAt"),
        source_updated_at=get(item, "updated_at", "updatedAt"),
    )
