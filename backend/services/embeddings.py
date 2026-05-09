"""OpenAI text-embedding-3-small wrapper."""
from __future__ import annotations

from openai import AsyncOpenAI

from settings import get_settings

EMBED_MODEL = "text-embedding-3-small"
EMBED_DIM = 1536


_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        s = get_settings()
        if not s.openai_key:
            raise RuntimeError("OPENAI_KEY not set; cannot embed.")
        _client = AsyncOpenAI(api_key=s.openai_key)
    return _client


async def embed_one(text: str) -> list[float]:
    if not text or not text.strip():
        return [0.0] * EMBED_DIM
    r = await _get_client().embeddings.create(model=EMBED_MODEL, input=text[:8000])
    return r.data[0].embedding


async def embed_many(texts: list[str]) -> list[list[float]]:
    if not texts:
        return []
    clipped = [t[:8000] if t else "" for t in texts]
    r = await _get_client().embeddings.create(model=EMBED_MODEL, input=clipped)
    return [d.embedding for d in r.data]
