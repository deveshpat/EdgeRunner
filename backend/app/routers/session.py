"""Session control endpoints, served by the Kaggle worker.

The frontend pings /heartbeat while a tab is open and calls /shutdown when the
user turns the backend off. See app/session.py for the watchdog.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.session import watchdog

router = APIRouter(tags=["session"])


@router.post("/session/heartbeat")
async def heartbeat() -> dict:
    return watchdog.heartbeat()


@router.post("/session/shutdown")
async def shutdown() -> dict:
    return watchdog.request_shutdown("client_requested")


@router.get("/session/status")
async def session_status() -> dict:
    return watchdog.status()
