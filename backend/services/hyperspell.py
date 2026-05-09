"""Hyperspell wrapper.

Locked against `hyperspell` SDK 0.37.x. The SDK surface we use:

  client = Hyperspell(api_key=..., user_id=...)
  client.integrations.connect(integration_id, redirect_url=...)  -> {url, expires_at}
  client.integrations.list()                                      -> {integrations: [...]}
  client.integrations.web_crawler.index(url=..., limit=, ...)     -> WebCrawlerIndexResponse
  client.connections.list()                                       -> {connections: [{provider, ...}]}
  client.connections.revoke(connection_id)                        -> {...}
  client.memories.search(query=..., sources=[...], max_results=K, answer=bool) -> QueryResult
  client.memories.get(resource_id, source=...)                    -> Memory{type, data, memories, ...}
  client.memories.add(text=..., title=..., metadata=...)          -> MemoryStatus
  client.memories.upload(file=..., metadata=str)                  -> MemoryStatus
  client.memories.status()                                        -> MemoryStatusResponse
  client.sessions.add(history=..., extract=[...])                 -> MemoryStatus

Source-name normalization (Hyperspell ↔ our DB enum):
  - Hyperspell:  slack | google_drive | notion | google_mail | github | vault | web_crawler
  - Our DB enum: slack | drive        | notion | gmail       | (github → code_refs only)
"""
from __future__ import annotations

import asyncio
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
}
DB_TO_HS_SOURCE: dict[str, str] = {
    "slack": "slack",
    "drive": "google_drive",
    "notion": "notion",
    "gmail": "google_mail",
    "github": "github",
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
    s = get_settings()
    if not s.hyperspell_key:
        raise RuntimeError("HYPERSPELL_KEY not set.")
    from hyperspell import Hyperspell  # imported lazily so unit tests can run without the SDK
    return Hyperspell(api_key=s.hyperspell_key, user_id=hyperspell_user_id)


# ─── integrations directory (provider name → integration UUID) ───────────────
# Hyperspell's integrations.connect() takes the integration UUID, not the
# provider string. Live-tested 2026-05-09:
#   integrations.connect("slack", ...)        → 500 Internal Server Error
#   integrations.connect("019e0e9d-...", ...) → ✅ returns the OAuth URL
# So we resolve provider → UUID once per process and cache.
_provider_uuid_cache: dict[str, str] = {}
_provider_uuid_cache_loaded_for: str | None = None


def _resolve_integration_uuid(client, provider: str) -> str:
    """Look up the Hyperspell integration UUID for a provider name (e.g. 'slack')."""
    global _provider_uuid_cache_loaded_for
    if provider in _provider_uuid_cache:
        return _provider_uuid_cache[provider]

    # Cache for THIS client's user_id; if user_id changes, re-load (integration
    # IDs are global but our get_client() builds per-user clients).
    if _provider_uuid_cache_loaded_for != client.user_id:
        _provider_uuid_cache.clear()
        for integ in (client.integrations.list().integrations or []):
            _provider_uuid_cache[integ.provider] = integ.id
        _provider_uuid_cache_loaded_for = client.user_id

    if provider not in _provider_uuid_cache:
        raise RuntimeError(
            f"Hyperspell has no integration for provider {provider!r}. "
            f"Available: {sorted(_provider_uuid_cache.keys())}"
        )
    return _provider_uuid_cache[provider]


# ─── connect URL ──────────────────────────────────────────────────────────────
def connect_url(
    hyperspell_user_id: str,
    db_source: str,
    *,
    redirect_url: str | None = None,
) -> str:
    """Mint a Hyperspell-hosted OAuth URL for `(user, source)`.

    Translates our DB source enum → Hyperspell provider → integration UUID,
    then calls `client.integrations.connect(uuid, redirect_url=...)` which
    returns `{url, expires_at}`. We hand the URL back; the frontend opens it.
    """
    provider = DB_TO_HS_SOURCE.get(db_source, db_source)
    client = get_client(hyperspell_user_id)
    integration_uuid = _resolve_integration_uuid(client, provider)

    kwargs: dict[str, Any] = {}
    if redirect_url:
        kwargs["redirect_url"] = redirect_url
    resp = client.integrations.connect(integration_uuid, **kwargs)
    return resp.url


# ─── connection status ────────────────────────────────────────────────────────
def list_connections(hyperspell_user_id: str) -> dict[str, str]:
    """Per-source connection status: {db_source: 'connected'|'not_connected'}.

    Presence in Hyperspell's `connections.list()` ⇒ connected; revoked ones drop
    out of the list. We don't fail the request if Hyperspell errors — caller
    layers a heuristic on top.
    """
    try:
        client = get_client(hyperspell_user_id)
        resp = client.connections.list()
    except Exception as e:
        log.warning("hyperspell.connections.list failed: %s", e)
        return {}

    connected_db: set[str] = set()
    for conn in (resp.connections or []):
        db_src = HS_TO_DB_SOURCE.get(conn.provider)
        if db_src:
            connected_db.add(db_src)

    out: dict[str, str] = {}
    for db_src in HS_TO_DB_SOURCE.values():
        out[db_src] = "connected" if db_src in connected_db else "not_connected"
    return out


# ─── search + fetch full text ─────────────────────────────────────────────────
async def search(
    *,
    hyperspell_user_id: str,
    query: str,
    db_sources: Iterable[str] | None = None,
    k: int = 20,
) -> list[HyperspellItem]:
    """Search across the requested sources, then fetch full text per hit.

    `memories.search` returns metadata only (title + ID). We fan out
    `memories.get` calls in parallel to populate `full_text`.
    """
    hs_sources: list[str] = []
    for db_src in (db_sources or []):
        hs = DB_TO_HS_SOURCE.get(db_src)
        if hs and hs in HS_TO_DB_SOURCE:  # exclude 'github' (handled by code_refs)
            hs_sources.append(hs)

    client = get_client(hyperspell_user_id)

    def _do_search() -> list[Any]:
        kwargs: dict[str, Any] = {"query": query, "max_results": k}
        if hs_sources:
            kwargs["sources"] = hs_sources
        result = client.memories.search(**kwargs)
        return list(result.documents or [])

    docs = await asyncio.to_thread(_do_search)
    if not docs:
        return []

    # Fan out body fetches in parallel — `memories.get` is sync, so use a
    # thread pool. 20 concurrent fetches is fine for a demo.
    async def _fetch(doc: Any) -> HyperspellItem | None:
        try:
            mem = await asyncio.to_thread(
                client.memories.get,
                doc.resource_id,
                source=doc.source,
            )
        except Exception as e:
            log.warning("memories.get failed for %s: %s", doc.resource_id, e)
            return None
        return _normalize(doc, mem)

    items = await asyncio.gather(*[_fetch(d) for d in docs])
    return [it for it in items if it is not None and it.full_text]


# ─── normalization ────────────────────────────────────────────────────────────
def _normalize(doc: Any, mem: Any) -> HyperspellItem | None:
    """Combine a search Resource (`doc`) with a fetched Memory (`mem`)."""
    db_source = HS_TO_DB_SOURCE.get(getattr(doc, "source", "") or "")
    if not db_source:
        return None

    full_text = _extract_text(mem)
    if not full_text:
        return None

    title = getattr(mem, "title", None) or getattr(doc, "title", None)
    md = getattr(mem, "metadata", None) or getattr(doc, "metadata", None)
    ref_url = getattr(md, "url", None) if md else None
    created = getattr(md, "created_at", None) if md else None
    updated = getattr(md, "last_modified", None) if md else None

    snippet = full_text[:500]
    return HyperspellItem(
        source=db_source,  # type: ignore[arg-type]
        external_id=getattr(doc, "resource_id", None),
        title=title,
        snippet=snippet,
        full_text=full_text,
        author=None,  # Hyperspell doesn't surface a uniform author field on Memory
        ref_url=ref_url,
        source_created_at=created.isoformat() if hasattr(created, "isoformat") else created,
        source_updated_at=updated.isoformat() if hasattr(updated, "isoformat") else updated,
    )


def _extract_text(mem: Any) -> str:
    """Pull a textual representation out of a Memory.

    `Memory.memories: List[str]` is the chunked text view; `Memory.data` is the
    structured payload (varies by source — message lists, file content, etc.).
    Concatenate `memories` first; fall back to `data` stringified.
    """
    parts: list[str] = []
    memories = getattr(mem, "memories", None) or []
    for m in memories:
        if isinstance(m, str) and m.strip():
            parts.append(m.strip())
    if parts:
        return "\n\n".join(parts)

    data = getattr(mem, "data", None) or []
    for d in data:
        if isinstance(d, str) and d.strip():
            parts.append(d.strip())
        elif isinstance(d, dict):
            # Best-effort: pull common text fields out of dict-shaped data.
            for key in ("text", "content", "body", "message", "value"):
                v = d.get(key)
                if isinstance(v, str) and v.strip():
                    parts.append(v.strip())
                    break
    return "\n\n".join(parts)


# ─── search-with-answer (richer return for /search) ───────────────────────────
@dataclass
class SearchHit:
    source: str            # raw Hyperspell source name (e.g. "google_drive", "vault")
    resource_id: str
    title: str | None
    score: float | None
    ref_url: str | None


@dataclass
class SearchResult:
    answer: str | None
    query_id: str | None
    hits: list[SearchHit]


async def search_with_answer(
    *,
    hyperspell_user_id: str,
    query: str,
    hs_sources: list[str] | None = None,
    answer: bool = False,
    max_results: int = 10,
) -> SearchResult:
    """Thin wrapper over `memories.search` that preserves answer + score + URL.

    Unlike `search()` above, this does NOT fan out `memories.get` per hit. It's
    for the live `/search` endpoint where we want ranking + (optionally) an
    LLM-synthesized answer, not full chunk text.
    """
    client = get_client(hyperspell_user_id)

    def _do() -> Any:
        kwargs: dict[str, Any] = {"query": query, "max_results": max_results}
        if hs_sources:
            kwargs["sources"] = hs_sources
        if answer:
            kwargs["answer"] = True
        return client.memories.search(**kwargs)

    res = await asyncio.to_thread(_do)
    hits: list[SearchHit] = []
    for d in (res.documents or []):
        md = getattr(d, "metadata", None)
        hits.append(
            SearchHit(
                source=getattr(d, "source", "") or "",
                resource_id=getattr(d, "resource_id", "") or "",
                title=getattr(d, "title", None),
                score=getattr(d, "score", None),
                ref_url=getattr(md, "url", None) if md else None,
            )
        )
    return SearchResult(
        answer=getattr(res, "answer", None),
        query_id=getattr(res, "query_id", None),
        hits=hits,
    )


# ─── memories.add / upload / status ───────────────────────────────────────────
async def memory_add(
    *,
    hyperspell_user_id: str,
    text: str,
    title: str | None = None,
    collection: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Push arbitrary text into Hyperspell vault. Returns {resource_id, source, status}."""
    client = get_client(hyperspell_user_id)

    def _do() -> Any:
        kwargs: dict[str, Any] = {"text": text}
        if title:
            kwargs["title"] = title
        if collection:
            kwargs["collection"] = collection
        if metadata:
            kwargs["metadata"] = metadata
        return client.memories.add(**kwargs)

    status = await asyncio.to_thread(_do)
    return _serialize_status(status)


async def memory_upload(
    *,
    hyperspell_user_id: str,
    filename: str,
    content: bytes,
    content_type: str | None = None,
    collection: str | None = None,
    metadata: str | None = None,
) -> dict[str, Any]:
    """Upload a file to Hyperspell. `metadata` must be a JSON-encoded string per SDK."""
    client = get_client(hyperspell_user_id)
    file_tuple = (filename, content, content_type or "application/octet-stream")

    def _do() -> Any:
        kwargs: dict[str, Any] = {"file": file_tuple}
        if collection:
            kwargs["collection"] = collection
        if metadata:
            kwargs["metadata"] = metadata
        return client.memories.upload(**kwargs)

    status = await asyncio.to_thread(_do)
    return _serialize_status(status)


async def memory_status(hyperspell_user_id: str) -> dict[str, Any]:
    """Per-provider indexing progress."""
    client = get_client(hyperspell_user_id)
    res = await asyncio.to_thread(client.memories.status)
    return res.model_dump() if hasattr(res, "model_dump") else dict(res)


# ─── web crawler ──────────────────────────────────────────────────────────────
async def web_crawl(
    *,
    hyperspell_user_id: str,
    url: str,
    limit: int | None = None,
    max_depth: int | None = None,
) -> dict[str, Any]:
    """Kick off a recursive crawl of `url`. Pages become searchable under source=web_crawler."""
    client = get_client(hyperspell_user_id)

    def _do() -> Any:
        kwargs: dict[str, Any] = {"url": url}
        if limit is not None:
            kwargs["limit"] = limit
        if max_depth is not None:
            kwargs["max_depth"] = max_depth
        return client.integrations.web_crawler.index(**kwargs)

    res = await asyncio.to_thread(_do)
    return res.model_dump() if hasattr(res, "model_dump") else dict(res)


# ─── sessions (agent traces / meeting transcripts) ────────────────────────────
import json as _json


async def session_add(
    *,
    hyperspell_user_id: str,
    history: str | list[dict[str, Any]],
    format: str = "vercel",
    title: str | None = None,
    extract: list[str] | None = None,
    session_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Push a conversation transcript to Hyperspell.

    `history` is a JSON-encoded transcript. We accept either:
      - a list of message dicts (we JSON-encode for you), or
      - a JSON-encoded string you've already prepared.

    `format` is one of {'vercel', 'hyperdoc', 'openclaw'}. Live-tested 2026-05-09:
    'vercel' accepts `[{"role": "user|assistant", "content": "..."}, ...]` shape;
    'openclaw' returned 500; 'hyperdoc' has its own discriminated-union shape.
    Default is 'vercel' since it's the simplest and only one we've verified.

    `extract` ∈ subset of {'procedure', 'memory', 'mood'}.
    """
    client = get_client(hyperspell_user_id)

    if isinstance(history, list):
        history_str = _json.dumps(history)
    else:
        # Validate it's parseable JSON so the SDK doesn't 422 with an opaque error.
        try:
            _json.loads(history)
        except _json.JSONDecodeError as e:
            raise ValueError(f"session history must be JSON; got: {e}") from e
        history_str = history

    def _do() -> Any:
        kwargs: dict[str, Any] = {"history": history_str, "format": format}
        if title:
            kwargs["title"] = title
        if extract:
            kwargs["extract"] = extract
        if session_id:
            kwargs["session_id"] = session_id
        if metadata:
            kwargs["metadata"] = metadata
        return client.sessions.add(**kwargs)

    status = await asyncio.to_thread(_do)
    return _serialize_status(status)


# ─── integrations + connections (admin) ───────────────────────────────────────
async def list_integrations(hyperspell_user_id: str) -> dict[str, Any]:
    """All integrations Hyperspell exposes for this user (connected and not)."""
    client = get_client(hyperspell_user_id)
    res = await asyncio.to_thread(client.integrations.list)
    return res.model_dump() if hasattr(res, "model_dump") else dict(res)


async def revoke_connection(*, hyperspell_user_id: str, connection_id: str) -> dict[str, Any]:
    """Revoke a connection by its Hyperspell ID. Deletes credentials + indexed data."""
    client = get_client(hyperspell_user_id)
    res = await asyncio.to_thread(client.connections.revoke, connection_id)
    return res.model_dump() if hasattr(res, "model_dump") else dict(res)


async def find_connection_id_for_provider(
    *, hyperspell_user_id: str, hs_provider: str
) -> str | None:
    """Look up the connection_id for a provider so callers can revoke by source name."""
    client = get_client(hyperspell_user_id)
    res = await asyncio.to_thread(client.connections.list)
    for conn in (res.connections or []):
        if conn.provider == hs_provider:
            return conn.id
    return None


# ─── helpers ──────────────────────────────────────────────────────────────────
def _serialize_status(status: Any) -> dict[str, Any]:
    """MemoryStatus → JSON-safe dict."""
    if hasattr(status, "model_dump"):
        return status.model_dump(mode="json")
    return dict(status)
