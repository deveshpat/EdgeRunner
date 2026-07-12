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
        nvcc = shutil.which("nvcc")
        if not nvcc:
            for cand in sorted(Path("/usr/local").glob("cuda*/bin/nvcc")):
                nvcc = str(cand)
                break
        log(f"nvcc: {nvcc or 'MISSING'}")
        subprocess.call(["bash", "-lc", "ls /usr/local/ | head; cmake --version | head -1"])
        if nvcc and str(Path(nvcc).parent) not in env.get("PATH", ""):
            env["PATH"] = f"{Path(nvcc).parent}:{env.get('PATH','')}"
        # CUDA 12.x on modern Kaggle images; 75 = T4, 60 = P100
        cuda_args = "-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=60;75"
        if nvcc:
            cuda_args += f" -DCMAKE_CUDA_COMPILER={nvcc}"
        # Kaggle lacks the libcuda.so linker symlink → CMake can't resolve
        # CUDA::cuda_driver. Point it at the stub (or the real driver lib).
        import glob

        driver = None
        for pat in (
            "/usr/local/cuda/lib64/stubs/libcuda.so",
            "/usr/lib/x86_64-linux-gnu/libcuda.so",
            "/usr/lib/x86_64-linux-gnu/libcuda.so.1",
        ):
            hits = sorted(glob.glob(pat))
            if hits:
                driver = hits[0]
                break
        log(f"libcuda for linking: {driver or 'MISSING'}")
        if driver:
            cuda_args += f" -DCUDA_cuda_driver_LIBRARY={driver}"
        cuda_args += " -DCMAKE_LIBRARY_PATH=/usr/local/cuda/lib64/stubs"
        env["CMAKE_ARGS"] = cuda_args
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
            "-v",
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
    # Tar the wheelhouse in the exact name bootstrap.py looks for:
    #   edgerunner-wheels-{tag}-{cpu|gpu}.tar.gz
    tarball = OUT.parent / f"edgerunner-wheels-{py}-{suffix}.tar.gz"
    subprocess.check_call(
        ["tar", "-czf", str(tarball), "-C", str(OUT.parent), OUT.name]
    )
    log(f"\nTarball: {tarball} ({tarball.stat().st_size // 1_000_000}MB)")
    log(
        "\nNext: download this folder and run:\n"
        "  ./scripts/publish_wheels.sh /path/to/wheels\n"
        f"or upload the tarball directly:\n"
        f"  gh release upload wheels-v1 {tarball.name}\n"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
