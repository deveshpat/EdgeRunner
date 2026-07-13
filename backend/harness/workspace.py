"""Single persistent workspace directory shared by both engines.

Hermes and the native EdgeRunner engine must see the same files across a
session — switching /engine mid-conversation shouldn't lose file state.
Both openai_shim.py (Hermes' tool loop) and agent_loop.py (native engine)
import this instead of each creating their own tempdir.
"""

from __future__ import annotations

from pathlib import Path


def shared_workspace_dir() -> Path:
    base = (
        Path("/kaggle/working/edgerunner/workspace")
        if Path("/kaggle/working").is_dir()
        else Path.home() / ".edgerunner" / "workspace"
    )
    base.mkdir(parents=True, exist_ok=True)
    return base