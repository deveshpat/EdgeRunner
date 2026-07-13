"""EdgeRunner FastAPI application.

Runs on the GPU node (e.g. Kaggle) and is reached by the frontend over a
tunnelled URL. CORS is wide-open by default because the tunnel origin is not
known ahead of time; tighten via ALLOWED_ORIGINS in production.
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.routers import catalog, chat, passthrough, session


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in ("1", "true", "yes", "on")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Only the Kaggle worker self-terminates; never the local orchestrator.
    if _truthy(os.getenv("EDGERUNNER_WATCHDOG")):
        from app.session import watchdog

        watchdog.start()
    yield


app = FastAPI(title="EdgeRunner", version=__version__, lifespan=lifespan)

_origins = os.getenv("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _origins],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(catalog.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(session.router, prefix="/api")  # worker: heartbeat/shutdown
app.include_router(passthrough.router)  # /v1/* -> local llama-server


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}
