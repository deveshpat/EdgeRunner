"""Pack the backend into a single Kaggle worker script + kernel-metadata.json.

A Kaggle *script* kernel is one file, so we base64-embed the backend tree into
`worker.py`. At runtime the worker materialises those files, installs deps,
serves a GGUF via llama-cpp-python's OpenAI-compatible server, starts our
FastAPI app (worker role, watchdog on), opens a cloudflared tunnel, and prints
`EDGERUNNER_URL=<url>` for the orchestrator to scrape.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[2]  # .../backend
APP_DIR = BACKEND_DIR / "app"


def collect_backend_files() -> dict[str, str]:
    """Map 'app/...py' -> base64(bytes) for the whole app package."""
    files: dict[str, str] = {}
    for path in sorted(APP_DIR.rglob("*.py")):
        if "__pycache__" in path.parts:
            continue
        rel = path.relative_to(BACKEND_DIR).as_posix()
        files[rel] = base64.b64encode(path.read_bytes()).decode("ascii")
    if "app/main.py" not in files:
        raise FileNotFoundError("app/main.py missing from backend package")
    return files


def render_worker(config: dict, files: dict[str, str] | None = None) -> str:
    files = files or collect_backend_files()
    return _WORKER_TEMPLATE.replace(
        "__FILES__", json.dumps(files, ensure_ascii=True)
    ).replace("__CONFIG__", json.dumps(config, ensure_ascii=True))


def write_bundle(out_dir: Path, username: str, config: dict) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "worker.py").write_text(render_worker(config), encoding="utf-8")

    slug = "edgerunner"
    metadata = {
        "id": f"{username}/{slug}",
        "title": "EdgeRunner",
        "code_file": "worker.py",
        "language": "python",
        "kernel_type": "script",
        "is_private": True,
        "enable_gpu": bool(config.get("gpu", False)),
        "enable_internet": True,
    }
    (out_dir / "kernel-metadata.json").write_text(
        json.dumps(metadata, indent=2), encoding="utf-8"
    )
    return out_dir


# The worker runs headless on Kaggle. Kept deliberately simple; heavy GPU wheel
# handling is out of scope (see deploy/README.md notes).
_WORKER_TEMPLATE = r'''"""EdgeRunner Kaggle worker (generated — do not edit)."""
import base64, os, subprocess, sys, time, re, pathlib, urllib.request

FILES = __FILES__
CONFIG = __CONFIG__
ROOT = pathlib.Path("/kaggle/working/edgerunner")


def log(m): print(f"[edgerunner] {m}", flush=True)


def materialize():
    for rel, b64 in FILES.items():
        p = ROOT / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(base64.b64decode(b64))
    log(f"materialized {len(FILES)} files")


def pip(*args):
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", *args])


def install_deps():
    pip("fastapi", "uvicorn[standard]", "httpx", "pydantic", "huggingface_hub")
    if CONFIG.get("gpu"):
        # Prebuilt CUDA wheels — no on-Kaggle compile. Index hosts cuXXX builds.
        cuda = CONFIG.get("cuda", "cu124")
        idx = f"https://abetlen.github.io/llama-cpp-python/whl/{cuda}"
        log(f"installing CUDA llama-cpp-python ({cuda}) from prebuilt wheels")
        pip("llama-cpp-python[server]", "--extra-index-url", idx, "--prefer-binary")
    else:
        pip("llama-cpp-python[server]")
    log("python deps installed")


def download_model():
    from huggingface_hub import hf_hub_download
    path = hf_hub_download(repo_id=CONFIG["model_repo"], filename=CONFIG["model_file"])
    log(f"model at {path}")
    return path


def start_llama(model_path):
    env = dict(os.environ)
    proc = subprocess.Popen(
        [sys.executable, "-m", "llama_cpp.server",
         "--model", model_path, "--host", "127.0.0.1", "--port", "8080",
         "--n_gpu_layers", "-1" if CONFIG.get("gpu") else "0"],
        env=env)
    for _ in range(120):
        try:
            urllib.request.urlopen("http://127.0.0.1:8080/v1/models", timeout=2)
            log("llama server up"); return proc
        except Exception:
            time.sleep(2)
    raise RuntimeError("llama server failed to start")


def start_api():
    env = dict(os.environ)
    env.update({
        "LLAMACPP_BASE_URL": "http://127.0.0.1:8080",
        "EDGERUNNER_WATCHDOG": "1",
        "EDGERUNNER_IDLE_TIMEOUT": str(CONFIG.get("idle_timeout", 120)),
        "EDGERUNNER_MAX_LIFETIME": str(CONFIG.get("max_lifetime", 3600)),
        "EDGERUNNER_STARTUP_GRACE": str(CONFIG.get("startup_grace", 600)),
        "PYTHONPATH": str(ROOT),
    })
    return subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app",
         "--host", "0.0.0.0", "--port", "8000"],
        cwd=str(ROOT), env=env)


def start_tunnel():
    bin_path = ROOT / "cloudflared"
    if not bin_path.exists():
        urllib.request.urlretrieve(
            "https://github.com/cloudflare/cloudflared/releases/latest/download/"
            "cloudflared-linux-amd64", bin_path)
        bin_path.chmod(0o755)
    log_path = ROOT / "tunnel.log"
    proc = subprocess.Popen(
        [str(bin_path), "tunnel", "--no-autoupdate", "--url", "http://localhost:8000"],
        stdout=open(log_path, "w"), stderr=subprocess.STDOUT)
    for _ in range(40):
        time.sleep(1)
        try:
            txt = log_path.read_text()
        except Exception:
            txt = ""
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", txt)
        if m:
            log(f"EDGERUNNER_URL={m.group(0)}")
            return proc
    raise RuntimeError("cloudflared did not produce a URL")


def main():
    materialize(); install_deps()
    model = download_model()
    start_llama(model); start_api()
    tunnel = start_tunnel()
    # Block forever; the FastAPI watchdog hard-exits the whole kernel when the
    # client stops sending heartbeats or requests shutdown.
    tunnel.wait()


if __name__ == "__main__":
    main()
'''
