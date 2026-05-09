"""FastAPI dependencies: auth gate, shared Supabase client."""
from __future__ import annotations

from functools import lru_cache

from fastapi import Header, HTTPException, status
from supabase import Client, create_client

from settings import get_settings


def require_demo_token(authorization: str | None = Header(default=None)) -> None:
    """Bearer-token auth gate for mutating endpoints.

    Reads + voice-agent endpoints stay open (Yudong's component cannot safely
    hold a server secret). For demo only — not real auth.
    """
    settings = get_settings()
    expected = f"Bearer {settings.demo_token}"
    if authorization != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="bad or missing demo token",
        )


@lru_cache(maxsize=1)
def get_supabase() -> Client:
    """Service-role Supabase client. Bypasses RLS."""
    settings = get_settings()
    return create_client(
        settings.supabase_url,
        settings.supabase_service_role_key,
    )
