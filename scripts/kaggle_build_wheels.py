#!/usr/bin/env python3
"""
One-shot wheel builder for Kaggle (CPU or GPU session).

Run as a Kaggle script/notebook. Outputs .whl files under /kaggle/working/wheels/
that you upload to the EdgeRunner GitHub release tag `wheels-v1`.

  GPU session → CUDA-enabled llama-cpp-python
  CPU session → plain CPU wheel
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

OUT = Path("/kaggle/working/wheels")
LLAMA_VER = os.environ.get("EDGERUNNER_LLAMA_VER", "0.3.33")
WANT_GPU = os.environ.get("EDGERUNNER_BUILD_GPU", "").lower() in ("1", "true", "yes")
# Auto-detect GPU if not forced
if not os.environ.get("EDGERUNNER_BUILD_GPU"):
    WANT_GPU = Path("/usr/local/cuda").exists() or bool(
        shutil.which("nvidia-smi")
    )


def log(msg: str) -> None:
    print(msg, flush=True)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    py = f"cp{sys.version_info.major}{sys.version_info.minor}"
    log(f"Python {sys.version}")
    log(f"Platform {platform.platform()}")
    log(f"Tag {py}  GPU={WANT_GPU}")

    env = os.environ.copy()
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    if WANT_GPU:
        # CUDA 12.x on modern Kaggle images
        env["CMAKE_ARGS"] = "-DGGML_CUDA=on"
        env["FORCE_CMAKE"] = "1"
        suffix = "gpu"
    else:
        env["CMAKE_ARGS"] = "-DGGML_NATIVE=OFF"
        env["FORCE_CMAKE"] = "1"
        suffix = "cpu"

    log(f"Building llama-cpp-python=={LLAMA_VER} ({suffix})…")
    # Clean any prior install artifacts
    subprocess.check_call(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            f"llama-cpp-python=={LLAMA_VER}",
            "-w",
            str(OUT),
            "--no-deps",
            "--no-cache-dir",
        ],
        env=env,
    )

    # Also wheel pure/binary deps so offline install is snappy
    extra = [
        "fastapi",
        "uvicorn[standard]",
        "pydantic",
        "langchain",
        "langchain-community",
        "langgraph",
        "huggingface-hub",
        "psutil",
        "httpx",
    ]
    log("Wheeling remaining runtime deps…")
    subprocess.check_call(
        [
            sys.executable,
            "-m",
            "pip",
            "wheel",
            *extra,
            "-w",
            str(OUT),
            "--no-cache-dir",
        ],
        env=env,
    )

    wheels = sorted(OUT.glob("*.whl"))
    log(f"\nBuilt {len(wheels)} wheels in {OUT}:")
    for w in wheels:
        log(f"  {w.name}  ({w.stat().st_size // 1024} KiB)")

    # Write a small manifest for the publisher
    (OUT / "BUILD_INFO.txt").write_text(
        f"python={sys.version}\n"
        f"tag={py}\n"
        f"accel={suffix}\n"
        f"llama={LLAMA_VER}\n"
        f"platform={platform.platform()}\n",
        encoding="utf-8",
    )
    log(
        "\nNext: download this folder and run:\n"
        "  ./scripts/publish_wheels.sh /path/to/wheels\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
