#!/usr/bin/env python3
"""
EdgeRunner Kaggle worker bootstrap — single script pushed to Kaggle.

It:
  1. Materializes the embedded backend source files
  2. Installs Python deps + cloudflared (HTTPS tunnel)
  3. Starts FastAPI on :8000
  4. Prints EDGERUNNER_URL=... so the orchestrator can scrape logs
  5. Blocks until the session self-kills (idle / shutdown / max lifetime)

NOTE: The orchestrator rewrites the FILES dict and SESSION header before push.
"""


from __future__ import annotations

import base64
import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


# ─── Injected by orchestrator at push time ───────────────────────────────────
SESSION_ID = "__SESSION_ID__"
ACCELERATOR = "__ACCELERATOR__"  # cpu | gpu
IDLE_TIMEOUT = "__IDLE_TIMEOUT__"
MAX_LIFETIME = "__MAX_LIFETIME__"
STARTUP_GRACE = "__STARTUP_GRACE__"

# backend files: path -> content (replaced by packer)
FILES: dict[str, str] = {}
# ─── End injection zone ──────────────────────────────────────────────────────

WORK = Path("/kaggle/working/edgerunner")
PORT = 8000
URL_MARKER = "EDGERUNNER_URL="



def log(msg: str) -> None:
    print(msg, flush=True)


def materialize_files() -> None:
    if not FILES:
        raise RuntimeError(
            "No embedded FILES. Push via the EdgeRunner orchestrator so the "
            "backend is packed into this script."
        )
    for rel, payload in FILES.items():
        path = WORK / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        # Payloads are base64(utf-8) from the packer (emoji-safe).
        try:
            data = base64.b64decode(payload.encode("ascii"), validate=False)
        except Exception:
            # Backward-compat: plain text embeds
            data = payload.encode("utf-8", errors="surrogatepass")
            data = data.decode("utf-8", errors="replace").encode("utf-8")
        path.write_bytes(data)
        log(f"  wrote {path} ({len(data)} bytes)")



def _py_tag() -> str:
    return f"cp{sys.version_info.major}{sys.version_info.minor}"


def _fetch_url(url: str, dest: Path, timeout: int = 120) -> bool:
    """Download url → dest. Returns True on success."""
    try:
        subprocess.check_call(
            ["curl", "-fsSL", "--connect-timeout", "15", "-m", str(timeout), "-o", str(dest), url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return dest.exists() and dest.stat().st_size > 0
    except Exception:
        try:
            subprocess.check_call(
                ["wget", "-q", "-O", str(dest), url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            return dest.exists() and dest.stat().st_size > 0
        except Exception:
            return False


def _load_wheels_index() -> dict:
    """Fetch wheels/index.json from GitHub (raw → release mirror)."""
    import json
    import urllib.request

    urls = [
        os.environ.get("EDGERUNNER_WHEELS_INDEX", "").strip(),
        "https://raw.githubusercontent.com/deveshpat/EdgeRunner/main/wheels/index.json",
        "https://cdn.jsdelivr.net/gh/deveshpat/EdgeRunner@main/wheels/index.json",
    ]
    for url in urls:
        if not url:
            continue
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            log(f"  wheels index miss ({url.split('/')[2] if '//' in url else url}): {e}")
    return {}


def _install_prebuilt_llama(env: dict) -> bool:
    """Try to install llama-cpp-python from our GitHub release wheels (seconds)."""
    index = _load_wheels_index()
    if not index:
        return False

    base = (
        os.environ.get("EDGERUNNER_WHEELS_BASE", "").strip()
        or index.get("base_url")
        or "https://github.com/deveshpat/EdgeRunner/releases/download/wheels-v1"
    )
    pkg = (index.get("packages") or {}).get("llama-cpp-python") or {}
    wheels = pkg.get("wheels") or {}
    tag = _py_tag()
    accel = "gpu" if str(ACCELERATOR).lower() in ("gpu", "nvidia", "cuda") else "cpu"
    # Prefer exact accel, then cpu fallback for gpu miss
    keys = [f"{tag}-{accel}"]
    if accel == "gpu":
        keys.append(f"{tag}-cpu")

    wheel_name = None
    for k in keys:
        if k in wheels:
            wheel_name = wheels[k]
            break
    if not wheel_name:
        log(f"  no prebuilt llama wheel key for {keys} in index")
        return False

    url = f"{base.rstrip('/')}/{wheel_name}"
    dest = WORK / "wheels" / wheel_name
    dest.parent.mkdir(parents=True, exist_ok=True)
    log(f"  downloading prebuilt wheel: {wheel_name}")
    if not _fetch_url(url, dest, timeout=180):
        log(f"  wheel download failed: {url}")
        return False

    try:
        subprocess.check_call(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "-q",
                "--no-cache-dir",
                str(dest),
            ],
            env=env,
        )
        log(f"  ✅ prebuilt llama-cpp-python installed ({accel})")
        return True
    except subprocess.CalledProcessError as e:
        log(f"  prebuilt wheel install failed: {e}")
        return False


def _install_prebuilt_bundle(env: dict) -> bool:
    """Optional: full wheels tarball for offline-ish install of all deps."""
    base = os.environ.get(
        "EDGERUNNER_WHEELS_BASE",
        "https://github.com/deveshpat/EdgeRunner/releases/download/wheels-v1",
    ).rstrip("/")
    tag = _py_tag()
    accel = "gpu" if str(ACCELERATOR).lower() in ("gpu", "nvidia", "cuda") else "cpu"
    for name in (f"edgerunner-wheels-{tag}-{accel}.tar.gz", f"edgerunner-wheels-{tag}-cpu.tar.gz"):
        url = f"{base}/{name}"
        dest = WORK / name
        log(f"  trying wheels bundle {name}…")
        if not _fetch_url(url, dest, timeout=180):
            continue
        extract = WORK / "wheels_bundle"
        extract.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.check_call(["tar", "-xzf", str(dest), "-C", str(extract)])
            subprocess.check_call(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "-q",
                    "--no-cache-dir",
                    "--no-index",
                    f"--find-links={extract}",
                    "-r",
                    str(WORK / "backend" / "requirements.txt"),
                ],
                env=env,
            )
            log("  ✅ installed all deps from wheels bundle")
            return True
        except Exception as e:
            log(f"  bundle install failed: {e}")
    return False


def pip_install() -> None:
    """Fast path: prebuilt wheels from GitHub. Slow path: compile llama-cpp."""
    req = WORK / "backend" / "requirements.txt"
    env = os.environ.copy()
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    env["PIP_DEFAULT_TIMEOUT"] = "120"
    # Avoid accidental source builds when a wheel exists on PyPI
    env["PIP_PREFER_BINARY"] = "1"

    log("📦 Installing Python dependencies (prefer prebuilt wheels)…")

    # 1) Full offline-ish bundle if published
    if _install_prebuilt_bundle(env):
        log("✅ pip install complete (bundle)")
        return

    # 2) Prebuilt llama-cpp-python (the expensive compile) + binary PyPI rest
    llama_ok = _install_prebuilt_llama(env)
    if not llama_ok:
        log("  ⚠️ no prebuilt llama wheel — will compile (slow). "
            "Publish wheels via scripts/kaggle_build_wheels.py + publish_wheels.sh")
        if str(ACCELERATOR).lower() in ("gpu", "nvidia", "cuda"):
            env["CMAKE_ARGS"] = "-DGGML_CUDA=on"
            env["FORCE_CMAKE"] = "1"
        else:
            env["CMAKE_ARGS"] = "-DGGML_NATIVE=OFF"
            env["FORCE_CMAKE"] = "1"

    # Install remaining requirements. If llama already installed, pip skips rebuild.
    # --prefer-binary keeps pure/manylinux wheels snappy.
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "-q",
        "--no-cache-dir",
        "--prefer-binary",
        "-r",
        str(req),
    ]
    if llama_ok:
        # Don't let pip try to upgrade llama from sdist
        cmd.extend(["--upgrade-strategy", "only-if-needed"])

    subprocess.check_call(cmd, env=env)
    log("✅ pip install complete")


def install_cloudflared() -> Path:
    bin_path = WORK / "cloudflared"
    if bin_path.exists():
        return bin_path
    log("Downloading cloudflared...")
    url = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
    try:
        subprocess.check_call(["wget", "-q", "-O", str(bin_path), url])
    except (FileNotFoundError, subprocess.CalledProcessError):
        subprocess.check_call(["curl", "-fsSL", "-o", str(bin_path), url])
    bin_path.chmod(0o755)
    return bin_path


def _read_until_url(
    proc: subprocess.Popen,
    patterns: list[re.Pattern],
    label: str,
    timeout: float = 45.0,
) -> str | None:
    """Read process stdout with a hard timeout (avoids blocking forever on readline)."""
    assert proc.stdout is not None
    lines: list[str] = []
    done = threading.Event()

    def _reader() -> None:
        try:
            for line in proc.stdout:
                line = line.rstrip("\n")
                log(f"[{label}] {line}")
                lines.append(line)
                for pat in patterns:
                    m = pat.search(line)
                    if m:
                        # store match on list for outer scope
                        lines.append(f"__URL__{m.group(0)}")
                        done.set()
                        return
                if done.is_set():
                    return
        except Exception as e:
            log(f"[{label}] reader error: {e}")
        finally:
            done.set()

    t = threading.Thread(target=_reader, daemon=True)
    t.start()
    done.wait(timeout=timeout)
    for line in lines:
        if line.startswith("__URL__"):
            return line[len("__URL__") :]
    # process may still be running; leave it for drain/kill by caller
    return None


def _drain_async(proc: subprocess.Popen, label: str) -> None:
    def _run() -> None:
        try:
            if proc.stdout is None:
                return
            for line in proc.stdout:
                log(f"[{label}] {line.rstrip()}")
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True).start()


def start_cloudflared(cloudflared: Path) -> tuple[subprocess.Popen | None, str | None]:
    log("Starting Cloudflare quick tunnel...")
    proc = subprocess.Popen(
        [
            str(cloudflared),
            "tunnel",
            "--url",
            f"http://127.0.0.1:{PORT}",
            "--no-autoupdate",
            "--protocol",
            "http2",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    patterns = [
        re.compile(r"(https://[a-zA-Z0-9-]+\.trycloudflare\.com)"),
    ]
    url = _read_until_url(proc, patterns, "cloudflared", timeout=40.0)
    if url:
        _drain_async(proc, "cloudflared")
        return proc, url
    log("cloudflared did not yield a URL in time; killing and trying fallbacks")
    try:
        proc.kill()
    except Exception:
        pass
    return None, None


def start_localtunnel() -> tuple[subprocess.Popen | None, str | None]:
    log("Trying localtunnel fallback...")
    try:
        subprocess.check_call(
            ["npm", "install", "-g", "localtunnel"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        log(f"localtunnel install failed: {e}")
        return None, None

    proc = subprocess.Popen(
        ["lt", "--port", str(PORT)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    patterns = [
        re.compile(r"(https://[a-zA-Z0-9-]+\.loca\.lt)"),
        re.compile(r"your url is:\s*(https://\S+)"),
        re.compile(r"(https://\S+\.localtunnel\.me)"),
    ]
    url = _read_until_url(proc, patterns, "localtunnel", timeout=45.0)
    if url:
        _drain_async(proc, "localtunnel")
        return proc, url
    try:
        proc.kill()
    except Exception:
        pass
    return None, None


def start_bore() -> tuple[subprocess.Popen | None, str | None]:
    """Try bore.pub (static binary) as another fallback."""
    log("Trying bore.pub fallback...")
    bore = WORK / "bore"
    if not bore.exists():
        url = "https://github.com/ekzhang/bore/releases/download/v0.5.1/bore-v0.5.1-x86_64-unknown-linux-musl.tar.gz"
        tar = WORK / "bore.tgz"
        try:
            subprocess.check_call(["curl", "-fsSL", "-o", str(tar), url])
            subprocess.check_call(["tar", "-xzf", str(tar), "-C", str(WORK)])
            # binary may be nested
            if not bore.exists():
                for p in WORK.rglob("bore"):
                    if p.is_file():
                        p.rename(bore)
                        break
            bore.chmod(0o755)
        except Exception as e:
            log(f"bore download failed: {e}")
            return None, None

    proc = subprocess.Popen(
        [str(bore), "local", str(PORT), "--to", "bore.pub"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    patterns = [
        re.compile(r"(https?://bore\.pub:\d+)"),
        re.compile(r"listening at\s+(\S+)"),
        re.compile(r"(bore\.pub:\d+)"),
    ]
    url = _read_until_url(proc, patterns, "bore", timeout=40.0)
    if url:
        if url.startswith("bore.pub"):
            url = "http://" + url
        _drain_async(proc, "bore")
        return proc, url
    try:
        proc.kill()
    except Exception:
        pass
    return None, None


def start_tunnel(cloudflared: Path) -> tuple[subprocess.Popen, str]:
    """Try cloudflared → localtunnel → bore until one yields a public URL."""
    for starter in (
        lambda: start_cloudflared(cloudflared),
        start_localtunnel,
        start_bore,
    ):
        try:
            proc, url = starter()
            if proc is not None and url:
                return proc, url
        except Exception as e:
            log(f"tunnel starter failed: {e}")
    raise RuntimeError("Failed to establish a public tunnel (cloudflared/localtunnel/bore)")



def start_api(public_url: str) -> subprocess.Popen:
    env = os.environ.copy()
    env.update(
        {
            "EDGERUNNER_AUTO": "1",
            "KP_PUBLIC_URL": public_url,
            "KP_SESSION_ID": SESSION_ID,
            "KP_ACCELERATOR": ACCELERATOR,
            "KP_IDLE_TIMEOUT_SECONDS": str(IDLE_TIMEOUT),
            "KP_MAX_LIFETIME_SECONDS": str(MAX_LIFETIME),
            "KP_STARTUP_GRACE_SECONDS": str(STARTUP_GRACE),
            "PORT": str(PORT),
            "PYTHONUNBUFFERED": "1",
        }
    )
    log("🚀 Starting FastAPI backend...")
    return subprocess.Popen(
        [sys.executable, str(WORK / "backend" / "main.py")],
        cwd=str(WORK / "backend"),
        env=env,
    )


def wait_healthy(timeout: float = 120.0) -> bool:
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=3) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(2)
    return False


def main() -> None:
    log("=" * 60)
    log("EdgeRunner Kaggle worker boot")
    log(f"  session     = {SESSION_ID}")
    log(f"  accelerator = {ACCELERATOR}")
    log(f"  idle_timeout= {IDLE_TIMEOUT}s")
    log(f"  max_lifetime= {MAX_LIFETIME}s")
    log("=" * 60)

    WORK.mkdir(parents=True, exist_ok=True)
    os.chdir(WORK)

    materialize_files()
    pip_install()
    cloudflared = install_cloudflared()

    # Start a tiny placeholder HTTP server so tunnels that probe upstream succeed,
    # then swap to the real API. (Some tunnels hang if nothing listens.)
    placeholder = subprocess.Popen(
        [
            sys.executable,
            "-c",
            (
                "from http.server import BaseHTTPRequestHandler, HTTPServer\n"
                f"class H(BaseHTTPRequestHandler):\n"
                f"  def do_GET(self):\n"
                f"    self.send_response(200); self.end_headers(); self.wfile.write(b'booting')\n"
                f"  def log_message(self, *a): pass\n"
                f"HTTPServer(('0.0.0.0', {PORT}), H).serve_forever()\n"
            ),
        ]
    )
    time.sleep(1)

    try:
        tunnel_proc, public_url = start_tunnel(cloudflared)
    finally:
        try:
            placeholder.kill()
            placeholder.wait(timeout=5)
        except Exception:
            pass

    log(f"\n{URL_MARKER}{public_url}")
    log(f"YOUR PUBLIC BACKEND URL: {public_url}\n")

    api_proc = start_api(public_url)


    if wait_healthy(180):
        log("✅ Backend health check passed")
        # Re-print URL so late log scrapers always catch it near "healthy"
        log(f"{URL_MARKER}{public_url}")
    else:
        log("⚠️ Backend health check timed out; continuing anyway")

    # Block until API exits (watchdog os._exit or crash)
    try:
        code = api_proc.wait()
        log(f"API process exited with code {code}")
    except KeyboardInterrupt:
        log("Interrupted")
    finally:
        for p in (api_proc, tunnel_proc):
            try:
                p.send_signal(signal.SIGTERM)
            except Exception:
                pass
        time.sleep(1)
        for p in (api_proc, tunnel_proc):
            try:
                if p.poll() is None:
                    p.kill()
            except Exception:
                pass
    log("Worker finished — Kaggle session will end.")


if __name__ == "__main__":
    main()
