"""EdgeRunner FastAPI application.

Runs on the GPU node (e.g. Kaggle) and is reached by the frontend over a
tunnelled URL. CORS is wide-open by default because the tunnel origin is not
known ahead of time; tighten via ALLOWED_ORIGINS in production.
"""

from __future__ import annotations

import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.routers import catalog, chat

app = FastAPI(title="EdgeRunner", version=__version__)

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


@app.get("/api/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__}
