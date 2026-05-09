"""POST /rt/token — mint an ephemeral OpenAI Realtime client secret.

Public endpoint. The voice agent (Yudong's <VoiceAgent />) calls this from the
browser to get a short-lived bearer it can use as the WebRTC token to OpenAI's
realtime API. Our OpenAI key never leaves the backend.

Frozen response shape: ``{ value: string, expires_at: number }``.
"""
from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from settings import get_settings

router = APIRouter(prefix="/rt", tags=["realtime"])
log = logging.getLogger(__name__)

OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime/client_secrets"
DEFAULT_MODEL = "gpt-realtime"


class RtTokenResponse(BaseModel):
    value: str
    expires_at: int


@router.post("/token", response_model=RtTokenResponse)
async def mint_token() -> RtTokenResponse:
    settings = get_settings()
    if not settings.openai_key:
        raise HTTPException(503, "OPENAI_KEY not configured on backend")

    payload = {"session": {"type": "realtime", "model": DEFAULT_MODEL}}
    try:
        async with httpx.AsyncClient(timeout=10.0) as cx:
            r = await cx.post(
                OPENAI_REALTIME_URL,
                headers={
                    "Authorization": f"Bearer {settings.openai_key}",
                    "Content-Type": "application/json",
                },
                json=payload,
            )
    except httpx.HTTPError as e:
        log.warning("OpenAI realtime token request failed: %s", e)
        raise HTTPException(502, f"openai realtime unreachable: {e}")

    if r.status_code >= 400:
        log.warning("OpenAI realtime token %s: %s", r.status_code, r.text[:300])
        raise HTTPException(r.status_code, f"openai realtime: {r.text[:300]}")

    body = r.json()
    # OpenAI returns nested {value, expires_at, ...}; surface the two fields the
    # frontend needs and ignore the rest.
    value = body.get("value")
    expires_at = body.get("expires_at")
    if not value or not isinstance(expires_at, int):
        raise HTTPException(
            502,
            f"openai realtime returned unexpected shape: keys={sorted(body)}",
        )
    return RtTokenResponse(value=value, expires_at=expires_at)
