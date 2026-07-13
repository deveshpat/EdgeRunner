"""Kaggle control endpoints, served by the local orchestrator.

The frontend calls these to configure credentials and switch the Kaggle
backend on/off. Credentials live in memory for the process lifetime only.
"""

from __future__ import annotations

from dataclasses import asdict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.kaggle.client import KaggleError
from app.kaggle.controller import (
    DEFAULT_MODEL_FILE,
    DEFAULT_MODEL_REPO,
    controller,
)

router = APIRouter(tags=["kaggle"])


class ConfigRequest(BaseModel):
    username: str
    key: str


class StartRequest(BaseModel):
    accelerator: str = Field("cpu", description="'cpu' or 'gpu'")
    model_repo: str = DEFAULT_MODEL_REPO
    model_file: str = DEFAULT_MODEL_FILE
    idle_timeout: int = Field(120, ge=30, le=3600)
    max_lifetime: int = Field(3600, ge=300, le=43200)


def _payload() -> dict:
    return {"configured": controller.configured, "session": asdict(controller.status())}


@router.get("/kaggle/status")
async def status() -> dict:
    return _payload()


@router.post("/kaggle/config")
async def configure(body: ConfigRequest) -> dict:
    try:
        controller.configure(body.username, body.key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KaggleError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    return _payload()


@router.post("/kaggle/start")
async def start(body: StartRequest) -> dict:
    if body.accelerator.lower() not in ("cpu", "gpu"):
        raise HTTPException(status_code=400, detail="accelerator must be 'cpu' or 'gpu'")
    try:
        controller.start(
            accelerator=body.accelerator.lower(),
            model_repo=body.model_repo,
            model_file=body.model_file,
            idle_timeout=body.idle_timeout,
            max_lifetime=body.max_lifetime,
        )
    except KaggleError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _payload()


@router.post("/kaggle/stop")
async def stop() -> dict:
    controller.stop()
    return _payload()
