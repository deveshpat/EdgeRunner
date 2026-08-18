"""Workspace file explorer router.

Provides endpoints to list, inspect, read, create, update, and delete files
within the sandboxed `./workspace` directory.
"""

from __future__ import annotations

from typing import Any
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app import workspace

router = APIRouter(prefix="/files", tags=["files"])


class WriteFileRequest(BaseModel):
    path: str = Field(..., description="Relative path in the workspace.")
    content: str = Field(..., description="UTF-8 file text content.")


class FileTreeResponse(BaseModel):
    root: str
    items: list[dict[str, Any]]


class FileContentResponse(BaseModel):
    path: str
    name: str
    content: str
    size: int
    truncated: bool


@router.get("/tree", response_model=FileTreeResponse)
async def get_tree() -> FileTreeResponse:
    root = workspace.ensure_workspace()
    items = workspace.get_file_tree()
    return FileTreeResponse(root=str(root), items=items)


@router.get("/read", response_model=FileContentResponse)
async def read_file(path: str = Query(..., description="Relative path in workspace")) -> FileContentResponse:
    try:
        data = workspace.read_file_content(path)
        return FileContentResponse(**data)
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=f"File not found: {path}")
    except ValueError as val_err:
        raise HTTPException(status_code=403, detail=str(val_err))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/write")
async def write_file(req: WriteFileRequest) -> dict[str, Any]:
    try:
        res = workspace.write_file_content(req.path, req.content)
        return {"status": "ok", **res}
    except ValueError as val_err:
        raise HTTPException(status_code=403, detail=str(val_err))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.delete("/delete")
async def delete_file(path: str = Query(..., description="Relative path in workspace")) -> dict[str, Any]:
    try:
        ok = workspace.delete_file_or_dir(path)
        if not ok:
            raise HTTPException(status_code=404, detail=f"Target does not exist: {path}")
        return {"status": "ok", "deleted": path}
    except ValueError as val_err:
        raise HTTPException(status_code=403, detail=str(val_err))
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
