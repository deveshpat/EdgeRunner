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


def _wheels_base() -> str:
    index = _load_wheels_index()
    return (
        os.environ.get("EDGERUNNER_WHEELS_BASE", "").strip()
        or (index.get("base_url") if index else None)
        or "https://github.com/deveshpat/EdgeRunner/releases/download/wheels-v1"
    ).rstrip("/")


# Pure packages we need (llama-cpp-python handled separately as prebuilt .so wheel).
_PURE_PKGS = [
    "fastapi",
    "uvicorn",
    "pydantic",
    "langchain",
    "langchain-community",

    "huggingface-hub",
    "psutil",
    "httpx",
    # llama-cpp-python pure deps (wheel is installed --no-deps)
    "typing-extensions",
    "numpy",
    "diskcache",
    "jinja2",
]


def _req_without_llama() -> Path:
    """requirements.txt minus llama-cpp-python (installed separately as prebuilt)."""
    src = WORK / "backend" / "requirements.txt"
    out = WORK / "requirements-nollama.txt"
    lines: list[str] = []
    for line in src.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            lines.append(line)
            continue
        pkg = (
            stripped.split("==")[0]
            .split(">=")[0]
            .split("<")[0]
            .split("[")[0]
            .strip()
            .lower()
        )
        if pkg in ("llama-cpp-python", "llama_cpp_python"):
            lines.append(f"# stripped (prebuilt wheel): {line}")
            continue
        lines.append(line)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return out


def _req_loose_nollama() -> Path:
    """Unpinned package names — for offline find-links (avoids upper-bound fights)."""
    out = WORK / "requirements-loose.txt"
    out.write_text("\n".join(_PURE_PKGS) + "\n", encoding="utf-8")
    return out


def _verify_import(mod: str, env: dict | None = None) -> tuple[bool, str]:
    e = env if env is not None else os.environ.copy()
    r = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import importlib, traceback\n"
                f"try:\n"
                f"  m = importlib.import_module({mod!r})\n"
                f"  print(getattr(m, '__version__', 'ok'))\n"
                f"except Exception:\n"
                f"  traceback.print_exc()\n"
                f"  raise SystemExit(1)\n"
            ),
        ],
        capture_output=True,
        text=True,
        timeout=90,
        env=e,
    )
    if r.returncode == 0:
        return True, (r.stdout or "").strip()
    err = ((r.stderr or "") + "\n" + (r.stdout or "")).strip()
    return False, err[-1200:]


def _verify_llama_import(env: dict | None = None) -> tuple[bool, str]:
    """Import llama_cpp with LD_LIBRARY_PATH pointing at package lib/ if present."""
    e = (env or os.environ).copy()
    try:
        r2 = subprocess.run(
            [
                sys.executable,
                "-c",
                "import site, pathlib\n"
                "paths=[]\n"
                "for s in list(site.getsitepackages()) + [site.getusersitepackages()]:\n"
                "  p=pathlib.Path(s)/'llama_cpp'/'lib'\n"
                "  if p.is_dir(): paths.append(str(p))\n"
                "print(':'.join(paths))\n",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            env=e,
        )
        libdirs = (r2.stdout or "").strip()
        if libdirs:
            old = e.get("LD_LIBRARY_PATH", "")
            e["LD_LIBRARY_PATH"] = libdirs + (":" + old if old else "")
    except Exception:
        pass
    return _verify_import("llama_cpp", env=e)


def _deps_already_ok() -> bool:
    """Skip reinstall when prior install still imports."""
    for mod in ("fastapi", "uvicorn", "langchain", "numpy", "llama_cpp"):
        ok, detail = (
            _verify_import(mod) if mod != "llama_cpp" else _verify_llama_import()
        )
        if not ok:
            log(f"  reuse miss: {mod} ({detail[:160].replace(chr(10), ' ')})")
            return False
        log(f"  reuse ok: {mod}={detail.splitlines()[0] if detail else 'ok'}")
    return True


def _pip_base_env() -> dict:
    env = os.environ.copy()
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    env["PIP_DEFAULT_TIMEOUT"] = "120"
    env["PIP_PREFER_BINARY"] = "1"
    cache = WORK / "pip-cache"
    cache.mkdir(parents=True, exist_ok=True)
    env["PIP_CACHE_DIR"] = str(cache)
    return env


def _install_wheelhouse_direct(links: Path, env: dict) -> bool:
    """Install every non-llama .whl with --no-deps (fully offline, no resolver fights)."""
    whls = sorted(
        p
        for p in links.glob("*.whl")
        if "llama_cpp" not in p.name.lower() and "llama-cpp" not in p.name.lower()
    )
    if len(whls) < 5:
        log(f"  wheelhouse too small ({len(whls)} pure wheels)")
        return False
    log(f"  offline install {len(whls)} pure wheels (--no-deps)…")
    try:
        t0 = time.time()
        batch: list[str] = []
        for w in whls:
            batch.append(str(w))
            if len(batch) >= 40:
                subprocess.check_call(
                    [
                        sys.executable,
                        "-m",
                        "pip",
                        "install",
                        "-q",
                        "--no-deps",
                        "--no-index",
                        *batch,
                    ],
                    env=env,
                )
                batch = []
        if batch:
            subprocess.check_call(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "-q",
                    "--no-deps",
                    "--no-index",
                    *batch,
                ],
                env=env,
            )
        log(f"  ✅ wheelhouse pure deps in {time.time() - t0:.1f}s")
        return True
    except subprocess.CalledProcessError as e:
        log(f"  wheelhouse direct install failed: {e}")
        return False


def _pip_install_find_links(
    links: Path, env: dict, *, no_index: bool, loose: bool
) -> bool:
    req = _req_loose_nollama() if loose else _req_without_llama()
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "-q",
        "--prefer-binary",
        "--upgrade-strategy",
        "only-if-needed",
        f"--find-links={links}",
        "-r",
        str(req),
    ]
    if no_index:
        cmd.insert(5, "--no-index")
    try:
        t0 = time.time()
        subprocess.check_call(cmd, env=env)
        log(
            f"  ✅ pure deps via find-links in {time.time() - t0:.1f}s "
            f"(no_index={no_index} loose={loose})"
        )
        return True
    except subprocess.CalledProcessError as e:
        log(f"  find-links install failed (no_index={no_index} loose={loose}): {e}")
        return False


def _stage_bundle(env: dict) -> Path | None:
    """Download+extract wheels tarball; return wheelhouse dir or None."""
    base = _wheels_base()
    tag = _py_tag()
    assets = _list_release_assets("wheels-v1")
    by_name = {n: u for n, u in assets}

    name = f"edgerunner-wheels-{tag}-cpu.tar.gz"
    url = by_name.get(name) or f"{base}/{name}"
    dest = WORK / "cache" / name
    dest.parent.mkdir(parents=True, exist_ok=True)

    if dest.exists() and dest.stat().st_size > 1_000_000:
        log(f"  reusing cached bundle {name} ({dest.stat().st_size // 1_000_000}MB)")
    else:
        log(f"  downloading wheels bundle {name}…")
        t0 = time.time()
        if not _fetch_url(url, dest, timeout=240):
            log(f"  bundle download failed: {name}")
            return None
        log(
            f"  downloaded bundle in {time.time() - t0:.1f}s "
            f"({dest.stat().st_size // 1_000_000}MB)"
        )

    extract = WORK / "wheels_bundle"
    if extract.exists():
        import shutil

        shutil.rmtree(extract, ignore_errors=True)
    extract.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.check_call(["tar", "-xzf", str(dest), "-C", str(extract)])
    except subprocess.CalledProcessError as e:
        log(f"  tar extract failed: {e}")
        return None

    whls = list(extract.rglob("*.whl"))
    if not whls:
        log("  bundle has no .whl files")
        return None
    links = whls[0].parent

    for w in whls:
        n = w.name.lower()
        if "llama_cpp_python" not in n:
            continue
        if "manylinux" not in n:
            continue
        if _py_tag() not in n and "py3-none" not in n:
            continue
        try:
            target = WORK / "wheels" / w.name
            target.parent.mkdir(parents=True, exist_ok=True)
            import shutil

            shutil.copy2(w, target)
            log(f"  staged llama wheel from bundle: {w.name}")
        except Exception as ex:
            log(f"  stage llama skip: {ex}")

    return links


def _install_from_bundle(env: dict) -> bool:
    """One tarball download → offline pure deps (no version-pin fights)."""
    links = _stage_bundle(env)
    if links is None:
        return False

    if _install_wheelhouse_direct(links, env):
        return True
    if _pip_install_find_links(links, env, no_index=True, loose=True):
        return True
    log("  offline incomplete — PyPI fill-in for pure deps only…")
    if _pip_install_find_links(links, env, no_index=False, loose=True):
        return True
    return _pip_install_find_links(links, env, no_index=False, loose=False)


def _llama_candidate_urls() -> list[str]:
    """manylinux_2_28 only — never try bare linux_x86_64 host builds."""
    base = _wheels_base()
    tag = _py_tag()
    preferred = [
        f"{base}/llama_cpp_python-0.3.33-{tag}-{tag}-manylinux_2_28_x86_64.whl",
    ]
    assets = _list_release_assets("wheels-v1")
    extras: list[str] = []
    for name, url in assets:
        n = name.lower()
        if "llama_cpp_python" not in n or not n.endswith(".whl"):
            continue
        if "manylinux" not in n:
            continue
        if any(x in n for x in ("cu11", "cu12", "cuda", "+cu")):
            continue
        if tag not in n and "py3-none" not in n:
            continue
        extras.append(url)

    ordered: list[str] = []
    for u in preferred + extras:
        if u not in ordered:
            ordered.append(u)
    return ordered


def _ensure_llama_pure_deps(env: dict) -> None:
    """typing_extensions/numpy/etc. required even when llama wheel uses --no-deps."""
    checks = [
        ("typing_extensions", "typing-extensions"),
        ("numpy", "numpy"),
        ("diskcache", "diskcache"),
        ("jinja2", "jinja2"),
    ]
    missing: list[str] = []
    for mod, pip_name in checks:
        ok, _ = _verify_import(mod)
        if not ok:
            missing.append(pip_name)
    if not missing:
        return
    log(f"  installing llama pure deps: {missing}")
    try:
        subprocess.check_call(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "-q",
                "--prefer-binary",
                *missing,
            ],
            env=env,
        )
    except subprocess.CalledProcessError as e:
        log(f"  llama pure deps pip failed: {e}")


def _install_local_llama_wheel(path: Path, env: dict) -> bool:
    if not path.is_file() or path.stat().st_size < 1000:
        return False
    log(f"  installing local llama wheel: {path.name}")
    _ensure_llama_pure_deps(env)
    try:
        subprocess.check_call(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "-q",
                "--force-reinstall",
                "--no-deps",
                str(path),
            ],
            env=env,
        )
    except subprocess.CalledProcessError as e:
        log(f"  local llama pip failed: {e}")
        return False
    ok, detail = _verify_llama_import(env)
    if ok:
        log(f"  ✅ llama_cpp works ({detail}) via {path.name}")
        return True
    log(f"  import failed for {path.name}:")
    for line in detail.splitlines()[-12:]:
        log(f"    {line}")
    return False


def _is_gpu_session() -> bool:
    return str(ACCELERATOR).lower() in ("gpu", "nvidia", "cuda")


def _llama_gpu_ok(env: dict | None = None) -> bool:
    """True when the installed llama_cpp build can offload to CUDA."""
    e = (env or os.environ).copy()
    try:
        r = subprocess.run(
            [
                sys.executable,
                "-c",
                "import llama_cpp\n"
                "print(bool(llama_cpp.llama_supports_gpu_offload()))\n",
            ],
            capture_output=True,
            text=True,
            timeout=60,
            env=e,
        )
        return r.returncode == 0 and "True" in (r.stdout or "")
    except Exception:
        return False


def _stage_gpu_llama(env: dict) -> list[Path]:
    """
    Download the Kaggle-built CUDA wheels tarball (edgerunner-wheels-{tag}-gpu.tar.gz)
    and stage its llama wheel(s). Kaggle-built wheels may carry a bare
    linux_x86_64 tag — that is fine, they were built on this exact image.
    """
    tag = _py_tag()
    name = f"edgerunner-wheels-{tag}-gpu.tar.gz"
    assets = _list_release_assets("wheels-v1")
    by_name = {n: u for n, u in assets}
    url = by_name.get(name) or f"{_wheels_base()}/{name}"

    dest = WORK / "cache" / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not (dest.exists() and dest.stat().st_size > 1_000_000):
        log(f"  downloading GPU wheels bundle {name}…")
        if not _fetch_url(url, dest, timeout=300):
            log(f"  no GPU wheels bundle in release ({name}) — will fall back")
            return []

    extract = WORK / "wheels_gpu_bundle"
    if extract.exists():
        import shutil

        shutil.rmtree(extract, ignore_errors=True)
    extract.mkdir(parents=True, exist_ok=True)
    try:
        subprocess.check_call(["tar", "-xzf", str(dest), "-C", str(extract)])
    except subprocess.CalledProcessError as e:
        log(f"  gpu bundle tar extract failed: {e}")
        return []

    staged: list[Path] = []
    gpu_wheels_dir = WORK / "wheels_gpu"
    gpu_wheels_dir.mkdir(parents=True, exist_ok=True)
    for w in extract.rglob("llama_cpp_python-*.whl"):
        n = w.name
        if _py_tag() not in n and "py3-none" not in n:
            continue
        try:
            import shutil

            target = gpu_wheels_dir / n
            shutil.copy2(w, target)
            staged.append(target)
            log(f"  staged CUDA llama wheel: {n}")
        except Exception as ex:
            log(f"  stage gpu llama skip: {ex}")
    return staged


def _install_working_llama(env: dict) -> bool:
    """CUDA wheel first on GPU sessions; manylinux CPU prebuilt otherwise."""
    gpu = _is_gpu_session()
    ok, detail = _verify_llama_import(env)
    if ok and (not gpu or _llama_gpu_ok(env)):
        log(f"  ✅ llama_cpp already ok ({detail})")
        return True
    if ok and gpu:
        log("  llama_cpp imports but cannot offload to CUDA — trying GPU wheel…")

    wheels_dir = WORK / "wheels"
    wheels_dir.mkdir(parents=True, exist_ok=True)

    if gpu:
        # Previously staged (persisted output) or freshly downloaded CUDA wheels
        gpu_candidates = sorted((WORK / "wheels_gpu").glob("llama_cpp_python-*.whl"))
        if not gpu_candidates:
            gpu_candidates = _stage_gpu_llama(env)
        for w in gpu_candidates:
            if _install_local_llama_wheel(w, env):
                if _llama_gpu_ok(env):
                    log(f"  ✅ CUDA llama wheel active: {w.name}")
                    return True
                log(f"  {w.name} installed but reports no CUDA — continuing")
        if not gpu_candidates:
            log("  ⚠️ no CUDA wheel available — CPU fallback (slow inference)")

    for w in sorted(wheels_dir.glob("llama_cpp_python-*.whl")):
        if "manylinux" in w.name.lower() and (
            _py_tag() in w.name or "py3-none" in w.name
        ):
            if _install_local_llama_wheel(w, env):
                return True

    log("  installing llama-cpp-python (manylinux_2_28 prebuilt only)…")
    for url in _llama_candidate_urls():
        wheel_name = url.rsplit("/", 1)[-1]
        dest = wheels_dir / wheel_name
        if not (dest.exists() and dest.stat().st_size > 1_000_000):
            log(f"  downloading {wheel_name}…")
            t0 = time.time()
            if not _fetch_url(url, dest, timeout=180):
                log(f"  download failed: {wheel_name}")
                continue
            log(f"  downloaded in {time.time() - t0:.1f}s")
        if _install_local_llama_wheel(dest, env):
            return True

    log("  ⚠️ all prebuilt llama wheels failed — compiling on Kaggle (SLOW)…")
    return _compile_llama_from_source(env)


def _compile_llama_from_source(env: dict) -> bool:
    """Build llama-cpp-python on this machine (Kaggle) — correct glibc. Slow."""
    e = env.copy()
    if _is_gpu_session():
        # 60 = P100, 75 = T4 — restricting arches roughly halves compile time
        e["CMAKE_ARGS"] = "-DGGML_CUDA=on -DCMAKE_CUDA_ARCHITECTURES=60;75"
        e["FORCE_CMAKE"] = "1"
        log("  compiling llama-cpp-python from source (CUDA)…")
    else:
        e["CMAKE_ARGS"] = "-DGGML_NATIVE=OFF"
        e["FORCE_CMAKE"] = "1"
        log("  compiling llama-cpp-python from source (CPU, several minutes)…")
    try:
        t0 = time.time()
        subprocess.check_call(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "-q",
                "--force-reinstall",
                "--no-binary=llama-cpp-python",
                "llama-cpp-python==0.3.33",
            ],
            env=e,
        )
        ok, detail = _verify_llama_import(e)
        if ok:
            log(f"  ✅ source-built llama in {time.time() - t0:.0f}s ({detail})")
            return True
        log(f"  source build import still failed: {detail[:400]}")
        return False
    except subprocess.CalledProcessError as ex:
        log(f"  source build failed: {ex}")
        return False


def _install_pypi_nollama(env: dict) -> bool:
    """Last resort pure deps — never include llama-cpp-python on the cmdline."""
    req = _req_loose_nollama()
    try:
        t0 = time.time()
        subprocess.check_call(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "-q",
                "--prefer-binary",
                "--upgrade-strategy",
                "only-if-needed",
                "-r",
                str(req),
            ],
            env=env,
        )
        log(f"  ✅ PyPI pure deps in {time.time() - t0:.1f}s")
        return True
    except subprocess.CalledProcessError as e:
        log(f"  PyPI pure deps failed: {e}")
        req2 = _req_without_llama()
        try:
            subprocess.check_call(
                [
                    sys.executable,
                    "-m",
                    "pip",
                    "install",
                    "-q",
                    "--prefer-binary",
                    "-r",
                    str(req2),
                ],
                env=env,
            )
            log("  ✅ PyPI pure deps (pinned req) ok")
            return True
        except subprocess.CalledProcessError as e2:
            log(f"  PyPI pinned also failed: {e2}")
            return False


def pip_install() -> None:
    """Fast Kaggle install: reuse → wheels tarball → manylinux llama.

    Never let `pip install -r` see llama-cpp-python (that path compiles on Kaggle).
    """
    env = _pip_base_env()
    t_all = time.time()
    log("📦 Installing Python dependencies (prebuilt only, no llama compile)…")
    log(f"  python={sys.version.split()[0]} tag={_py_tag()} accel={ACCELERATOR}")

    if _deps_already_ok():
        log(f"✅ deps already installed — skipped pip ({time.time() - t_all:.1f}s)")
        return

    pure_ok = _install_from_bundle(env)
    if not pure_ok:
        log("  bundle path failed — falling back to PyPI for pure deps only…")
        pure_ok = _install_pypi_nollama(env)
    if not pure_ok:
        raise RuntimeError("Could not install pure Python dependencies")

    if not _install_working_llama(env):
        raise RuntimeError(
            "Could not install a working llama-cpp-python "
            "(prebuilt manylinux failed; source build failed)"
        )

    for mod in ("fastapi", "llama_cpp"):
        ok, detail = (
            _verify_import(mod) if mod != "llama_cpp" else _verify_llama_import(env)
        )
        if not ok:
            raise RuntimeError(f"{mod} unusable after install: {detail[:300]}")

    log(f"✅ pip install complete in {time.time() - t_all:.1f}s")


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
            # GGUFs under working; default to a small model for fast cold starts
            "EDGERUNNER_MODEL_DIR": str(models_dir),
            "EDGERUNNER_USE_TRENDING": os.environ.get("EDGERUNNER_USE_TRENDING", "0"),
            "EDGERUNNER_MAX_MODEL_GB": os.environ.get("EDGERUNNER_MAX_MODEL_GB", "3.5"),
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


def _log_gpu_info() -> None:
    """Print GPU model early so the launcher can confirm T4 vs P100 from logs."""
    try:
        r = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,memory.total",
                "--format=csv,noheader",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        out = (r.stdout or r.stderr or "").strip()
        if out:
            log(f"  nvidia-smi  = {out.replace(chr(10), ' | ')}")
        else:
            log("  nvidia-smi  = (no output)")
    except FileNotFoundError:
        log("  nvidia-smi  = not found (CPU or no driver)")
    except Exception as e:
        log(f"  nvidia-smi  = error: {e}")


def main() -> None:
    log("=" * 60)
    log("EdgeRunner Kaggle worker boot")
    log(f"  session     = {SESSION_ID}")
    log(f"  accelerator = {ACCELERATOR}")
    log(f"  idle_timeout= {IDLE_TIMEOUT}s")
    log(f"  max_lifetime= {MAX_LIFETIME}s")
    _log_gpu_info()
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
