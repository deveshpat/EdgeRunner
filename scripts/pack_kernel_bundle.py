#!/usr/bin/env python3
"""Pack backend sources into frontend/public/kernel-bundle.json for browser launches.

Run from repo root (also invoked by the GitHub Pages build workflow):
  python3 scripts/pack_kernel_bundle.py
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
BOOTSTRAP = ROOT / "kaggle_worker" / "bootstrap.py"
OUT = ROOT / "frontend" / "public" / "kernel-bundle.json"

_SKIP_DIRS = {"__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache"}
_SKIP_SUFFIXES = {".pyc", ".pyo", ".so", ".dylib"}


def collect_backend_files() -> dict[str, str]:
    """Pack entire backend tree including harness/ (required for agent imports)."""
    files: dict[str, str] = {}
    if not BACKEND.is_dir():
        raise FileNotFoundError(f"missing backend: {BACKEND}")
    for path in sorted(BACKEND.rglob("*")):
        if not path.is_file():
            continue
        rel_parts = path.relative_to(BACKEND).parts
        if any(p in _SKIP_DIRS for p in rel_parts):
            continue
        if path.suffix in _SKIP_SUFFIXES:
            continue
        if path.name in (".env", "mcp_config.json"):
            continue
        rel = f"backend/{path.relative_to(BACKEND).as_posix()}"
        files[rel] = base64.b64encode(path.read_bytes()).decode("ascii")
    return files


def main() -> int:
    if not BOOTSTRAP.exists():
        print(f"missing bootstrap: {BOOTSTRAP}", file=sys.stderr)
        return 1

    try:
        files = collect_backend_files()
    except Exception as e:
        print(f"pack failed: {e}", file=sys.stderr)
        return 1

    if "backend/main.py" not in files or "backend/agent.py" not in files:
        print("missing critical backend entrypoints", file=sys.stderr)
        return 1

    harness_count = sum(1 for k in files if k.startswith("backend/harness/"))
    if harness_count < 5:
        print(
            f"warning: only {harness_count} harness files packed — agent may fail on Kaggle",
            file=sys.stderr,
        )

    bundle = {
        "version": 2,
        "bootstrap": BOOTSTRAP.read_text(encoding="utf-8"),
        "files": files,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(bundle), encoding="utf-8")
    print(
        f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(files)} files, "
        f"{harness_count} harness)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
