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


def _fetch_url(url: str, dest: Path, timeout: int = 180) -> bool:
    """Download url → dest. Follows redirects. Returns True on success."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    # curl: fail on HTTP errors, follow redirects, show errors to log via capture
    try:
        r = subprocess.run(
            [
                "curl",
                "-fL",
                "--connect-timeout",
                "20",
                "-m",
                str(timeout),
                "-o",
                str(dest),
                url,
            ],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0 and dest.exists() and dest.stat().st_size > 64:
            return True
        err = (r.stderr or r.stdout or "")[-200:]
        log(f"  curl failed ({r.returncode}) for {url.rsplit('/', 1)[-1]}: {err}")
    except FileNotFoundError:
        pass
    except Exception as e:
        log(f"  curl exception: {e}")
    try:
        r = subprocess.run(
            ["wget", "-q", "-O", str(dest), url],
            capture_output=True,
            text=True,
        )
        if r.returncode == 0 and dest.exists() and dest.stat().st_size > 64:
            return True
    except Exception:
        pass
    try:
        dest.unlink(missing_ok=True)
    except Exception:
        pass
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


_RELEASE_ASSETS_CACHE: dict[str, list[tuple[str, str]]] = {}


def _list_release_assets(tag: str = "wheels-v1") -> list[tuple[str, str]]:
    """Return (name, browser_download_url) for release assets (cached)."""
    import json
    import urllib.request

    if tag in _RELEASE_ASSETS_CACHE:
        return _RELEASE_ASSETS_CACHE[tag]

    api = f"https://api.github.com/repos/deveshpat/EdgeRunner/releases/tags/{tag}"
    try:
        req = urllib.request.Request(
            api,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "EdgeRunner-worker",
            },
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read().decode("utf-8"))
        out: list[tuple[str, str]] = []
        for a in data.get("assets") or []:
            name = a.get("name") or ""
            url = a.get("browser_download_url") or ""
            if name and url:
                out.append((name, url))
        log(f"  release {tag}: {len(out)} assets")
        _RELEASE_ASSETS_CACHE[tag] = out
        return out
    except Exception as e:
        log(f"  release asset list failed: {e}")
        _RELEASE_ASSETS_CACHE[tag] = []
        return []


def _llama_wheel_score(name: str, py_tag: str, want_gpu: bool) -> int | None:
    """Lower is better. None = not a usable llama wheel for this env."""
    n = name.lower()
    if "llama_cpp_python" not in n and "llama-cpp-python" not in n:
        return None
    if not n.endswith(".whl"):
        return None
    gpuish = any(x in n for x in ("cu11", "cu12", "cuda", "+cu"))
    if want_gpu and not gpuish:
        # cpu wheel still usable as fallback (scored worse)
        base = 100
    elif not want_gpu and gpuish:
        return None  # don't install CUDA wheel on CPU session
    else:
        base = 0
    # Prefer exact CPython tag, then generic py3-none linux
    if py_tag in n:
        base += 0
    elif "py3-none" in n and "linux" in n:
        base += 5  # CI currently publishes this shape for any CPython
    elif "manylinux" in n and "linux" in n:
        base += 10
    else:
        base += 50
    if "x86_64" in n or "amd64" in n:
        base += 0
    else:
        base += 20
    return base


def _rank_llama_urls(
    assets: list[tuple[str, str]], py_tag: str, want_gpu: bool
) -> list[str]:
    scored: list[tuple[int, str]] = []
    for name, url in assets:
        s = _llama_wheel_score(name, py_tag, want_gpu)
        if s is not None:
            scored.append((s, url))
    scored.sort(key=lambda x: x[0])
    # de-dupe preserving order
    seen: set[str] = set()
    out: list[str] = []
    for _, u in scored:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def _install_prebuilt_llama(env: dict) -> bool:
    """Install llama-cpp-python from GitHub release wheels (seconds, not minutes)."""
    index = _load_wheels_index()
    base = (
        os.environ.get("EDGERUNNER_WHEELS_BASE", "").strip()
        or (index.get("base_url") if index else None)
        or "https://github.com/deveshpat/EdgeRunner/releases/download/wheels-v1"
    ).rstrip("/")
    release_tag = (index.get("release_tag") if index else None) or "wheels-v1"
    tag = _py_tag()
    want_gpu = str(ACCELERATOR).lower() in ("gpu", "nvidia", "cuda")
    accel = "gpu" if want_gpu else "cpu"

    # Prefer LIVE release assets (correct filenames) over stale index.json names
    assets = _list_release_assets(str(release_tag))
    candidates = _rank_llama_urls(assets, tag, want_gpu)
    if want_gpu:
        # also allow cpu fallbacks
        candidates += [u for u in _rank_llama_urls(assets, tag, want_gpu=False) if u not in candidates]

    # Known good aliases (updated when CI renames wheels)
    for alias in (
        f"llama_cpp_python-0.3.33-{tag}-{tag}-linux_x86_64.whl",
        f"llama_cpp_python-0.3.33-{tag}-{tag}-manylinux2014_x86_64.whl",
        "llama_cpp_python-0.3.33-py3-none-linux_x86_64.whl",
        "llama_cpp_python-0.3.33-py3-none-manylinux2014_x86_64.whl",
    ):
        url = f"{base}/{alias}"
        if url not in candidates:
            candidates.append(url)

    # Stale index names last (often 404)
    if index:
        pkg = (index.get("packages") or {}).get("llama-cpp-python") or {}
        wheels = pkg.get("wheels") or {}
        for k in (f"{tag}-{accel}", f"{tag}-cpu", "any-cpu", "py3-cpu"):
            name = wheels.get(k)
            if name:
                url = f"{base}/{name}"
                if url not in candidates:
                    candidates.append(url)

    if not candidates:
        log(f"  no prebuilt llama candidates for {tag}/{accel}")
        return False

    log(f"  trying {len(candidates)} prebuilt llama wheel candidate(s)…")
    wheels_dir = WORK / "wheels"
    wheels_dir.mkdir(parents=True, exist_ok=True)

    for picked in candidates:
        wheel_name = picked.rsplit("/", 1)[-1]
        dest = wheels_dir / wheel_name
        log(f"  downloading: {wheel_name}")
        if not _fetch_url(picked, dest, timeout=180):
            log(f"  skip (download failed): {wheel_name}")
            continue
        try:
            subprocess.check_call(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "-q",
                    "--no-cache-dir",
                    "--force-reinstall",
                    "--no-deps",
                    str(dest),
                ],
                env=env,
            )
            log(f"  ✅ prebuilt llama-cpp-python installed ({wheel_name})")
            return True
        except subprocess.CalledProcessError as e:
            log(f"  pip install failed for {wheel_name}: {e}")
            continue

    log("  all prebuilt llama candidates failed")
    return False


def _install_from_release_find_links(env: dict) -> bool:
    """Download many release wheels into a folder and pip install -r with --find-links.

    Much faster than hitting PyPI for every package when release is populated.
    """
    assets = _list_release_assets("wheels-v1")
    if len(assets) < 5:
        return False
    tag = _py_tag()
    wheels_dir = WORK / "wheels_all"
    wheels_dir.mkdir(parents=True, exist_ok=True)

    # Prefer pure py3 + matching cp tag + py3-none linux
    wanted = 0
    for name, url in assets:
        n = name.lower()
        if not n.endswith(".whl"):
            continue
        if any(x in n for x in ("cu11", "cu12", "+cu")) and str(ACCELERATOR).lower() == "cpu":
            continue
        keep = (
            "py3-none-any" in n
            or f"{tag}-{tag}" in n
            or (tag in n and "manylinux" in n)
            or ("py3-none" in n and "linux" in n)
            or "llama_cpp" in n
        )
        if not keep:
            continue
        dest = wheels_dir / name
        if dest.exists() and dest.stat().st_size > 64:
            wanted += 1
            continue
        if _fetch_url(url, dest, timeout=120):
            wanted += 1
        if wanted >= 80:  # enough for our dependency tree
            break

    if wanted < 3:
        return False

    log(f"  find-links install from {wanted} local wheels…")
    try:
        subprocess.check_call(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "-q",
                "--no-cache-dir",
                "--prefer-binary",
                f"--find-links={wheels_dir}",
                "-r",
                str(WORK / "backend" / "requirements.txt"),
            ],
            env=env,
        )
        log("  ✅ deps installed via release find-links")
        return True
    except subprocess.CalledProcessError as e:
        log(f"  find-links install failed: {e}")
        return False


def _install_prebuilt_bundle(env: dict) -> bool:
    """Optional: full wheels tarball for offline-ish install of all deps."""
    base = os.environ.get(
        "EDGERUNNER_WHEELS_BASE",
        "https://github.com/deveshpat/EdgeRunner/releases/download/wheels-v1",
    ).rstrip("/")
    tag = _py_tag()
    accel = "gpu" if str(ACCELERATOR).lower() in ("gpu", "nvidia", "cuda") else "cpu"
    assets = _list_release_assets("wheels-v1")
    by_name = {n: u for n, u in assets}

    candidates: list[tuple[str, str]] = []
    for name in (
        f"edgerunner-wheels-{tag}-{accel}.tar.gz",
        f"edgerunner-wheels-{tag}-cpu.tar.gz",
    ):
        if name in by_name:
            candidates.append((name, by_name[name]))
        else:
            candidates.append((name, f"{base}/{name}"))
    for aname, aurl in assets:
        if aname.endswith(".tar.gz") and "edgerunner-wheels" in aname.lower():
            if tag in aname or "py3" in aname:
                if all(aname != c[0] for c in candidates):
                    candidates.append((aname, aurl))

    for name, url in candidates:
        dest = WORK / name
        log(f"  trying wheels bundle {name}…")
        if not _fetch_url(url, dest, timeout=180):
            continue
        extract = WORK / "wheels_bundle"
        if extract.exists():
            import shutil

            shutil.rmtree(extract, ignore_errors=True)
        extract.mkdir(parents=True, exist_ok=True)
        try:
            subprocess.check_call(["tar", "-xzf", str(dest), "-C", str(extract)])
            whls = list(extract.rglob("*.whl"))
            if not whls:
                log(f"  bundle {name} has no .whl files")
                continue
            links = whls[0].parent
            subprocess.check_call(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "-q",
                    "--no-cache-dir",
                    "--prefer-binary",
                    f"--find-links={links}",
                    "-r",
                    str(WORK / "backend" / "requirements.txt"),
                ],
                env=env,
            )
            log("  ✅ installed deps from wheels bundle")
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
    env["PIP_PREFER_BINARY"] = "1"
    # Never compile if a wheel is available somewhere
    env["PIP_ONLY_BINARY"] = ""  # allow sdists only as last resort below

    log("📦 Installing Python dependencies (prefer prebuilt wheels)…")

    # 1) Full tarball bundle if published
    if _install_prebuilt_bundle(env):
        log("✅ pip install complete (bundle)")
        return

    # 2) Install the expensive native package from our release first
    llama_ok = _install_prebuilt_llama(env)
    if not llama_ok:
        log(
            "  ⚠️ no prebuilt llama wheel — compile fallback (SLOW). "
            "Check https://github.com/deveshpat/EdgeRunner/releases/tag/wheels-v1"
        )
        if str(ACCELERATOR).lower() in ("gpu", "nvidia", "cuda"):
            env["CMAKE_ARGS"] = "-DGGML_CUDA=on"
            env["FORCE_CMAKE"] = "1"
        else:
            env["CMAKE_ARGS"] = "-DGGML_NATIVE=OFF"
            env["FORCE_CMAKE"] = "1"

    # 3) Prefer release find-links for the rest (or full tree if llama already in)
    if _install_from_release_find_links(env):
        log("✅ pip install complete (release find-links)")
        return

    # 4) PyPI for remaining deps
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
        # Don't let pip replace our wheel with an sdist compile
        cmd.extend(["--upgrade-strategy", "only-if-needed"])
        # Pin installed llama so pip doesn't rebuild
        cmd.extend(["llama-cpp-python==0.3.33"])

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
    hb_file = WORK / ".heartbeat"
    models_dir = WORK / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    hf_home = Path("/kaggle/working/hf_cache")
    try:
        hf_home.mkdir(parents=True, exist_ok=True)
    except Exception:
        hf_home = WORK / "hf_cache"
        hf_home.mkdir(parents=True, exist_ok=True)

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
            "KP_WORK_DIR": str(WORK),
            "KP_HEARTBEAT_FILE": str(hb_file),
            # Persist GGUFs under /kaggle/working so next run can remount them
            "EDGERUNNER_MODEL_DIR": str(models_dir),
            "HF_HOME": str(hf_home),
            "HUGGINGFACE_HUB_CACHE": str(hf_home / "hub"),
            "PORT": str(PORT),
            "PYTHONUNBUFFERED": "1",
        }
    )
    # Seed heartbeat so parent monitor doesn't kill during model download
    try:
        hb_file.write_text(str(time.time()), encoding="utf-8")
    except Exception:
        pass
    log("🚀 Starting FastAPI backend...")
    return subprocess.Popen(
        [sys.executable, str(WORK / "backend" / "main.py")],
        cwd=str(WORK / "backend"),
        env=env,
    )


def _kill_proc(p: subprocess.Popen | None, label: str) -> None:
    if p is None:
        return
    try:
        p.send_signal(signal.SIGTERM)
    except Exception:
        pass
    try:
        p.wait(timeout=3)
    except Exception:
        try:
            p.kill()
        except Exception:
            pass
    log(f"  killed {label}")


def supervise_api(
    api_proc: subprocess.Popen,
    tunnel_proc: subprocess.Popen | None,
) -> int:
    """Wait on API; also kill if heartbeat file goes stale (belt-and-suspenders).

    The API process has its own thread watchdog. This parent monitor catches
    cases where uvicorn hangs on a blocked worker and never exits.
    """
    hb_file = WORK / ".heartbeat"
    try:
        idle = float(IDLE_TIMEOUT)
    except (TypeError, ValueError):
        idle = 90.0
    try:
        grace = float(STARTUP_GRACE)
    except (TypeError, ValueError):
        grace = 600.0
    try:
        max_life = float(MAX_LIFETIME)
    except (TypeError, ValueError):
        max_life = 3600.0

    started = time.time()
    # Parent is slightly more lenient than the API idle timeout
    stale_limit = max(idle + 30.0, 120.0)

    log(
        f"Supervisor active | stale_heartbeat>{stale_limit:.0f}s "
        f"grace={grace:.0f}s max={max_life:.0f}s"
    )

    while True:
        code = api_proc.poll()
        if code is not None:
            return code

        now = time.time()
        age = now - started
        if max_life > 0 and age >= max_life + 15:
            log(f"Supervisor: max lifetime exceeded ({age:.0f}s) — killing")
            _kill_proc(api_proc, "api")
            _kill_proc(tunnel_proc, "tunnel")
            return 1

        if hb_file.exists():
            try:
                mtime = hb_file.stat().st_mtime
                # Also read embedded timestamp if present
                try:
                    ts = float(hb_file.read_text(encoding="utf-8").strip())
                    mtime = max(mtime, ts)
                except Exception:
                    pass
                stale = now - mtime
                # During startup grace, allow longer silence (model download)
                limit = stale_limit if age > grace else max(stale_limit, grace)
                if stale > limit:
                    log(
                        f"Supervisor: heartbeat stale {stale:.0f}s "
                        f"(limit {limit:.0f}s) — killing session"
                    )
                    _kill_proc(api_proc, "api")
                    _kill_proc(tunnel_proc, "tunnel")
                    return 1
            except Exception as e:
                log(f"Supervisor heartbeat check error: {e}")
        elif age > grace:
            log("Supervisor: no heartbeat file after grace — killing")
            _kill_proc(api_proc, "api")
            _kill_proc(tunnel_proc, "tunnel")
            return 1

        time.sleep(5.0)


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
        log(f"{URL_MARKER}{public_url}")
    else:
        log("⚠️ Backend health check timed out; continuing anyway")

    # Supervise until API dies (self-kill on shutdown/idle) or heartbeat goes stale
    try:
        code = supervise_api(api_proc, tunnel_proc)
        log(f"API process exited with code {code}")
    except KeyboardInterrupt:
        log("Interrupted")
        _kill_proc(api_proc, "api")
        _kill_proc(tunnel_proc, "tunnel")
    finally:
        _kill_proc(api_proc, "api")
        _kill_proc(tunnel_proc, "tunnel")
    log("Worker finished — Kaggle session will end.")


if __name__ == "__main__":
    main()
