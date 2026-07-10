"""Pack backend sources into a single Kaggle worker script + kernel-metadata.json."""

from __future__ import annotations

import base64
import json
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND_DIR = REPO_ROOT / "backend"
BOOTSTRAP_PATH = REPO_ROOT / "kaggle_worker" / "bootstrap.py"

# Files to embed relative to backend/
BACKEND_FILES = [
    "main.py",
    "agent.py",
    "model_manager.py",
    "schemas.py",
    "session_control.py",
    "requirements.txt",
]


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def collect_backend_files() -> dict[str, str]:
    """Return path -> base64(utf-8 bytes) so embedding survives Kaggle's pipeline.

    Plain JSON unicode (esp. emoji / non-BMP) becomes lone surrogates inside a
    Python source literal and then fails with UnicodeEncodeError on write_text.
    """
    files: dict[str, str] = {}
    for name in BACKEND_FILES:
        src = BACKEND_DIR / name
        if not src.exists():
            raise FileNotFoundError(f"Missing backend file: {src}")
        raw = src.read_bytes()
        files[f"backend/{name}"] = base64.b64encode(raw).decode("ascii")
    return files


def render_worker(
    session_id: str,
    accelerator: str = "cpu",
    idle_timeout: int = 90,
    max_lifetime: int = 3600,
    startup_grace: int = 600,
    files: dict[str, str] | None = None,
) -> str:
    """Return a complete worker.py source string ready to push to Kaggle."""
    files = files or collect_backend_files()
    bootstrap = _read(BOOTSTRAP_PATH)

    # Inject session config
    bootstrap = bootstrap.replace('"__SESSION_ID__"', json.dumps(session_id))
    bootstrap = bootstrap.replace('"__ACCELERATOR__"', json.dumps(accelerator))
    bootstrap = bootstrap.replace('"__IDLE_TIMEOUT__"', json.dumps(str(idle_timeout)))
    bootstrap = bootstrap.replace('"__MAX_LIFETIME__"', json.dumps(str(max_lifetime)))
    bootstrap = bootstrap.replace('"__STARTUP_GRACE__"', json.dumps(str(startup_grace)))

    # Also handle non-quoted placeholders if bootstrap uses bare tokens
    bootstrap = bootstrap.replace("__SESSION_ID__", session_id)
    bootstrap = bootstrap.replace("__ACCELERATOR__", accelerator)
    bootstrap = bootstrap.replace("__IDLE_TIMEOUT__", str(idle_timeout))
    bootstrap = bootstrap.replace("__MAX_LIFETIME__", str(max_lifetime))
    bootstrap = bootstrap.replace("__STARTUP_GRACE__", str(startup_grace))

    # ASCII-only base64 payloads — safe inside a Python source literal
    files_literal = json.dumps(files, indent=2, ensure_ascii=True)
    needle = "FILES: dict[str, str] = {}"
    if needle not in bootstrap:
        for alt in ("FILES = {}", "FILES: dict = {}"):
            if alt in bootstrap:
                needle = alt
                break
        else:
            raise RuntimeError("Could not find FILES placeholder in bootstrap.py")

    bootstrap = bootstrap.replace(
        needle, f"FILES: dict[str, str] = {files_literal}", 1
    )
    return bootstrap



def write_kernel_bundle(
    out_dir: Path,
    username: str,
    session_id: str,
    accelerator: str = "cpu",
    idle_timeout: int = 90,
    max_lifetime: int = 3600,
    startup_grace: int = 600,
    kernel_slug: str | None = None,
    is_private: bool = True,
) -> Path:
    """
    Write kernel-metadata.json + worker.py into out_dir.
    Returns path to out_dir.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    # One stable notebook per user (re-pushed each launch) — avoids notebook spam.
    slug = kernel_slug or "edgerunner"
    slug = slug.lower().replace("_", "-")
    title = "EdgeRunner"

    enable_gpu = accelerator.lower() in ("gpu", "nvidia", "t4", "p100", "true", "1")

    worker_src = render_worker(
        session_id=session_id,
        accelerator="gpu" if enable_gpu else "cpu",
        idle_timeout=idle_timeout,
        max_lifetime=max_lifetime,
        startup_grace=startup_grace,
    )
    (out_dir / "worker.py").write_text(worker_src, encoding="utf-8")

    kernel_id = f"{username}/{slug}"
    metadata = {
        "id": kernel_id,
        "title": title,
        "code_file": "worker.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": is_private,
        "enable_gpu": enable_gpu,
        "enable_tpu": False,
        "enable_internet": True,
        "dataset_sources": [],
        "competition_sources": [],
        # Prior run's /kaggle/working is mounted under /kaggle/input/ — model cache
        "kernel_sources": [kernel_id],
        "model_sources": [],
        "keywords": [],
    }

    (out_dir / "kernel-metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    return out_dir
