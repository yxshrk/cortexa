"""Service-role backfill: re-embed meeting_notes rows whose embedding column is NULL.

Yudong's voice path is supposed to insert ``embedding`` directly. This is a
compatibility layer: if his pipeline misses one (or the row was inserted by a
seed script before embeddings were computed), the backend repairs it before
``/context/query`` runs the pgvector RPC.

Caller pattern:

    await backfill_missing_meeting_note_embeddings(sb, project_id, limit=25)

Single-flight per project_id is the caller's responsibility. /context/query
caps it at 25 rows to keep the latency budget < ~300ms total.
"""
from __future__ import annotations

import logging
from typing import Any

from supabase import Client

from services import embeddings

log = logging.getLogger(__name__)


async def backfill_missing_meeting_note_embeddings(
    sb: Client, project_id: str, *, limit: int = 25
) -> dict[str, int]:
    """Find ≤limit meeting_notes rows missing an embedding and fill them in.

    Returns ``{"updated": int}`` so callers can log how much repair work happened.
    Errors during embed are swallowed (logged) — we'd rather serve stale-ish
    /context/query than fail it because backfill couldn't reach OpenAI.
    """
    try:
        r = (
            sb.table("meeting_notes")
            .select("id,text")
            .eq("project_id", project_id)
            .is_("embedding", "null")
            .limit(limit)
            .execute()
        )
    except Exception as e:  # noqa: BLE001
        log.warning("backfill: select missing embeddings failed: %s", e)
        return {"updated": 0}

    rows: list[dict[str, Any]] = r.data or []
    if not rows:
        return {"updated": 0}

    texts = [str(row.get("text") or "") for row in rows]
    try:
        vectors = await embeddings.embed_many(texts)
    except Exception as e:  # noqa: BLE001
        log.warning("backfill: embed_many failed: %s", e)
        return {"updated": 0}

    updated = 0
    for row, vec in zip(rows, vectors):
        try:
            sb.table("meeting_notes").update({"embedding": vec}).eq(
                "id", row["id"]
            ).execute()
            updated += 1
        except Exception as e:  # noqa: BLE001
            log.warning("backfill: update %s failed: %s", row.get("id"), e)
            continue

    if updated:
        log.info("backfill: updated %d/%d meeting_notes embeddings (project=%s)",
                 updated, len(rows), project_id)
    return {"updated": updated}
