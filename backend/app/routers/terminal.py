"""Terminal execution router.

Provides endpoints for the web frontend to execute shell commands in the shared
workspace sandbox, used by both the interactive terminal console and the
one-click [▶ Run] code block buttons.
"""

from __future__ import annotations

import time
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.tools import run_command
from app.workspace import ensure_workspace

router = APIRouter(prefix="/terminal", tags=["terminal"])


class ExecRequest(BaseModel):
    command: str = Field(..., description="Shell command to run in the workspace.")
    timeout: int = Field(30, ge=1, le=120, description="Max execution time in seconds.")


class ExecResponse(BaseModel):
    output: str
    exit_code: int
    duration_ms: int
    cwd: str


@router.post("/exec", response_model=ExecResponse)
async def execute_command(req: ExecRequest) -> ExecResponse:
    cmd = req.command.strip()
    if not cmd:
        raise HTTPException(status_code=400, detail="Command cannot be empty.")

    start = time.perf_counter()
    workspace = ensure_workspace()
    output, exit_code = run_command(cmd, timeout=req.timeout)
    duration_ms = int((time.perf_counter() - start) * 1000)

    return ExecResponse(
        output=output,
        exit_code=exit_code,
        duration_ms=duration_ms,
        cwd=str(workspace),
    )
