"""Centralized env-var loading. See backend/.env.example for the full list."""
from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Always resolve .env relative to backend/, regardless of which dir we're run from.
_BACKEND_DIR = Path(__file__).resolve().parent
_ENV_PATH = _BACKEND_DIR / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=str(_ENV_PATH), extra="ignore")

    # Supabase (service-role on the backend; bypasses RLS).
    # Accept either SUPABASE_SERVICE_ROLE_KEY (canonical) or SUPABASE_KEY
    # for ergonomics — but it MUST be the secret / service_role key.
    # The publishable / anon key will fail RLS-protected writes.
    supabase_url: str = Field(alias="SUPABASE_URL")
    supabase_service_role_key: str = Field(
        validation_alias=AliasChoices(
            "SUPABASE_SERVICE_ROLE_KEY",
            "SUPABASE_SECRET_KEY",
            "SUPABASE_KEY",
        ),
    )

    # Auth gate for mutating endpoints. REQUIRED — no default — so a
    # misconfigured deploy can't silently expose a known bearer.
    demo_token: str = Field(alias="DEMO_TOKEN")

    # External APIs (some may be unset early; routes that need them will fail loudly)
    openai_key: str | None = Field(default=None, alias="OPENAI_KEY")
    anthropic_key: str | None = Field(default=None, alias="ANTHROPIC_KEY")
    hyperspell_key: str | None = Field(default=None, alias="HYPERSPELL_KEY")
    linear_token: str | None = Field(default=None, alias="LINEAR_TOKEN")
    linear_team_id: str | None = Field(default=None, alias="LINEAR_TEAM_ID")
    github_token: str | None = Field(default=None, alias="GITHUB_TOKEN")
    github_owner: str | None = Field(default=None, alias="GITHUB_OWNER")
    github_repo: str | None = Field(default=None, alias="GITHUB_REPO")
    github_base_branch: str = Field(default="main", alias="GITHUB_BASE_BRANCH")
    devin_token: str | None = Field(default=None, alias="DEVIN_TOKEN")

    # App
    env: str = Field(default="dev", alias="ENV")
    port: int = Field(default=8000, alias="PORT")
    cors_origins: str = Field(
        default="http://localhost:3000",
        alias="CORS_ORIGINS",
    )

    # Hyperspell GitHub beta toggle (drives the fixture fallback in code_refs.py)
    hyperspell_github_available: bool = Field(
        default=False, alias="HYPERSPELL_GITHUB_AVAILABLE"
    )

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
