"""Workspace sandbox manager.

Manages the shared `./workspace` directory where both the user (via the
integrated terminal and file explorer) and the model (via the terminal
omnitool) run commands and manipulate files.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

# Default workspace directory located relative to the backend app root
# or configured via EDGERUNNER_WORKSPACE environment variable.
_ENV_WORKSPACE = os.getenv("EDGERUNNER_WORKSPACE")
if _ENV_WORKSPACE:
    WORKSPACE_ROOT = Path(_ENV_WORKSPACE).resolve()
else:
    WORKSPACE_ROOT = (Path(__file__).resolve().parent.parent / "workspace").resolve()


def ensure_workspace() -> Path:
    """Ensure the workspace directory exists and return its resolved Path."""
    WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
    return WORKSPACE_ROOT


def resolve_safe_path(rel_path: str) -> Path:
    """Resolve a relative path against WORKSPACE_ROOT with traversal protection.

    Raises:
        ValueError: If the path attempts to escape WORKSPACE_ROOT.
    """
    root = ensure_workspace().resolve()
    clean = rel_path.strip().lstrip("/").replace("\\", "/")
    parts = [p for p in clean.split("/") if p and p != "."]
    if ".." in parts:
        raise ValueError(f"Access denied: path {rel_path!r} contains parent traversal.")

    target = (root / Path(*parts)).resolve()
    try:
        target.relative_to(root)
    except ValueError:
        raise ValueError(f"Access denied: path {rel_path!r} escapes the workspace sandbox.")
    return target


def get_file_tree(dir_path: Path | None = None, max_depth: int = 4, current_depth: int = 0) -> list[dict[str, Any]]:
    """Return a recursive file tree structure of the workspace."""
    root = ensure_workspace()
    target = dir_path or root

    if not target.exists() or not target.is_dir() or current_depth > max_depth:
        return []

    items: list[dict[str, Any]] = []
    try:
        entries = sorted(target.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
    except PermissionError:
        return []

    for entry in entries:
        # Ignore hidden git/pycache directories
        if entry.name.startswith(".") and entry.name != ".env":
            continue
        if entry.name == "__pycache__":
            continue

        rel = str(entry.relative_to(root))
        if entry.is_dir():
            items.append({
                "name": entry.name,
                "path": rel,
                "type": "directory",
                "children": get_file_tree(entry, max_depth, current_depth + 1),
            })
        else:
            try:
                size = entry.stat().st_size
                mtime = int(entry.stat().st_mtime)
            except OSError:
                size = 0
                mtime = 0
            items.append({
                "name": entry.name,
                "path": rel,
                "type": "file",
                "size": size,
                "mtime": mtime,
            })

    return items


def read_file_content(rel_path: str, max_bytes: int = 500_000) -> dict[str, Any]:
    """Read a file from the workspace."""
    target = resolve_safe_path(rel_path)
    if not target.exists():
        raise FileNotFoundError(f"File not found: {rel_path}")
    if target.is_dir():
        raise IsADirectoryError(f"Path is a directory: {rel_path}")

    size = target.stat().st_size
    try:
        with open(target, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(max_bytes)
        truncated = size > max_bytes
    except Exception as exc:
        raise OSError(f"Could not read {rel_path}: {exc}") from exc

    return {
        "path": rel_path,
        "name": target.name,
        "content": content,
        "size": size,
        "truncated": truncated,
    }


def write_file_content(rel_path: str, content: str) -> dict[str, Any]:
    """Write or overwrite a file in the workspace."""
    target = resolve_safe_path(rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)

    with open(target, "w", encoding="utf-8") as f:
        f.write(content)

    return {
        "path": rel_path,
        "name": target.name,
        "size": target.stat().st_size,
    }


def delete_file_or_dir(rel_path: str) -> bool:
    """Delete a file or directory inside the workspace."""
    target = resolve_safe_path(rel_path)
    root = ensure_workspace()

    if target == root:
        raise ValueError("Cannot delete the workspace root directory.")

    if not target.exists():
        return False

    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return True
