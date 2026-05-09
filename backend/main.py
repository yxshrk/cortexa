"""FastAPI app entrypoint.

Run:    cd backend && uvicorn main:app --reload --port 8000
"""
from __future__ import annotations

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import connect, ingest
from settings import get_settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("cortexa")

app = FastAPI(title="Project Brain — backend", version="0.1.0")

settings = get_settings()
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(connect.router)
app.include_router(ingest.router)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "env": settings.env}


@app.on_event("startup")
async def _startup() -> None:
    log.info("Cortexa backend starting (env=%s, port=%s)", settings.env, settings.port)
    log.info("Configured: openai=%s anthropic=%s hyperspell=%s",
             bool(settings.openai_key),
             bool(settings.anthropic_key),
             bool(settings.hyperspell_key))
