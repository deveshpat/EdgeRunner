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

BACKEND_FILES = [
    "main.py",
    "agent.py",
    "model_manager.py",
    "schemas.py",
    "session_control.py",
    "requirements.txt",
]


def main() -> int:
    if not BOOTSTRAP.exists():
        print(f"missing bootstrap: {BOOTSTRAP}", file=sys.stderr)
        return 1

    files: dict[str, str] = {}
    for name in BACKEND_FILES:
        path = BACKEND / name
        if not path.exists():
            print(f"missing backend file: {path}", file=sys.stderr)
            return 1
        files[f"backend/{name}"] = base64.b64encode(path.read_bytes()).decode("ascii")

    bundle = {
        "version": 1,
        "bootstrap": BOOTSTRAP.read_text(encoding="utf-8"),
        "files": files,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(bundle), encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(files)} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
