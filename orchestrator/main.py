"""
EdgeRunner Kaggle Orchestrator
------------------------------
Local control plane that:
  - accepts the user's Kaggle credentials (never written to disk)
  - packs + pushes a headless worker kernel
  - scrapes Kaggle logs for the public HTTPS tunnel URL
  - exposes session status to the frontend

The worker self-terminates on idle / tab-close heartbeats, so this process
does not need a Kaggle "kill session" API (which does not exist publicly).
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from kaggle_client import KaggleCredentials
from session_manager import SessionManager

WORK_ROOT = Path(os.environ.get("KP_WORK_ROOT", Path.home() / ".edgerunner" / "sessions"))
manager = SessionManager(work_root=WORK_ROOT)

app = FastAPI(
    title="EdgeRunner Kaggle Orchestrator",
    description="Spin up EdgeRunner backends on Kaggle CPU/GPU and tunnel them over HTTPS.",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class StartSessionRequest(BaseModel):
    username: str = Field(..., description="Kaggle username")
    key: Optional[str] = Field(None, description="Legacy Kaggle API key")
    api_token: Optional[str] = Field(
        None, description="Modern Kaggle API token (settings → API)"
    )
    accelerator: str = Field("cpu", description="'cpu' or 'gpu'")
    idle_timeout: int = Field(90, ge=30, le=3600, description="Seconds without heartbeat before worker exits")
    max_lifetime: int = Field(
        3600,
        ge=300,
        le=43200,
        description="Hard cap on session length (protects monthly GPU quota)",
    )
    startup_grace: int = Field(
        600,
        ge=60,
        le=3600,
        description="Seconds allowed for model download before first heartbeat is required",
    )


class StopSessionRequest(BaseModel):
    # Optional: if the public_url is known, frontend also sendBeacons the worker directly.
    reason: str = "user_stop"


@app.get("/")
def root():
    return {
        "service": "EdgeRunner Kaggle Orchestrator",
        "docs": "/docs",
        "sessions": "/sessions",
    }


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/sessions")
def list_sessions():
    return {"sessions": manager.list_sessions()}


@app.post("/sessions/start")
def start_session(body: StartSessionRequest):
    if body.accelerator.lower() not in ("cpu", "gpu"):
        raise HTTPException(400, "accelerator must be 'cpu' or 'gpu'")
    try:
        creds = KaggleCredentials(
            username=body.username.strip(),
            key=(body.key or None),
            api_token=(body.api_token or None),
        )
        creds.validate()
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    session = manager.start(
        creds=creds,
        accelerator=body.accelerator.lower(),
        idle_timeout=body.idle_timeout,
        max_lifetime=body.max_lifetime,
        startup_grace=body.startup_grace,
        session_timeout_seconds=body.max_lifetime,
    )
    return session.to_public()


@app.get("/sessions/{session_id}")
def get_session(session_id: str, refresh: bool = True):
    session = manager.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    if refresh:
        manager.refresh(session_id)
        session = manager.get(session_id)
    return session.to_public()  # type: ignore[union-attr]


@app.post("/sessions/{session_id}/stop")
def stop_session(session_id: str, body: StopSessionRequest = StopSessionRequest()):
    """
    Mark session stopped in the orchestrator.

    Actual compute teardown happens on the worker via:
      POST {public_url}/session/shutdown
    which the frontend should call (sendBeacon) when possible.
    Without a public kill API on Kaggle, self-exit is the reliable path.
    """
    session = manager.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    # Best-effort remote shutdown if we have the tunnel URL
    if session.public_url:
        try:
            import urllib.request

            req = urllib.request.Request(
                f"{session.public_url.rstrip('/')}/session/shutdown",
                data=b'{"reason":"orchestrator_stop"}',
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=10)
        except Exception as e:
            session.logs_tail += f"\nremote_shutdown_error: {e}\n"

    manager.mark_stopped(session_id, reason=body.reason)
    return session.to_public()


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("ORCHESTRATOR_PORT", "9000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
