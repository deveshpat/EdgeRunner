"""Run the EdgeRunner backend on Kaggle and expose it via a cloudflared tunnel.

HOW TO USE
----------
1. Open a new Kaggle Notebook. In the sidebar: Internet = ON (required),
   Accelerator = None (CPU) or GPU T4 if you want speed.
2. Paste this whole file into a single cell and run it.
3. It prints a line like:

       EDGERUNNER_URL=https://something.trycloudflare.com

4. Copy that URL into the EdgeRunner web app: ⚙ settings → paste it → connect.

That's the whole contract: this script serves the backend + a public URL; the
web app just points at the URL. No Kaggle API keys, no auto-launch.

To only TEST the connection (no model), set MODEL_FILE = None below — the app
connects and the Echo (mock) harness works; llama.cpp chat needs a model.
"""
import os, re, subprocess, sys, tarfile, time, urllib.request

# --- config ---------------------------------------------------------------
REPO = "https://github.com/deveshpat/EdgeRunner"
MODEL_REPO = "Qwen/Qwen2.5-1.5B-Instruct-GGUF"
MODEL_FILE = "qwen2.5-1.5b-instruct-q4_k_m.gguf"  # set to None to skip the model
GPU = False  # set True on a GPU T4 session
ROOT = "/kaggle/working/EdgeRunner"

# Hugging Face access token (https://huggingface.co/settings/tokens, "read").
# STRONGLY RECOMMENDED: anonymous GGUF downloads from Kaggle IPs are rate-limited
# to a 403, while an authenticated direct download streams the full file in
# seconds. Paste your token here (it stays in your private Kaggle session).
HF_TOKEN = os.environ.get("HF_TOKEN", "")

# Prebuilt wheels live in this repo's release, so we never hit PyPI's slow
# llama-cpp-python sdist (which compiles for minutes) or the flaky abetlen wheel
# index. Each edgerunner-wheels-<pyver>-<accel>.tar.gz is a flat wheelhouse with
# the whole closure (llama-cpp-python, numpy, fastapi, uvicorn, huggingface_hub…)
# except two tiny pure-python server deps (sse-starlette, starlette-context)
# that pip fills from PyPI.
WHEELS_RELEASE = "https://github.com/deveshpat/EdgeRunner/releases/download/wheels-v1"
WHEELHOUSE = "/kaggle/working/wheels"
LLAMA_VERSION = "0.3.33"


_T0 = time.time()


def log(msg):
    print(f"[edgerunner +{int(time.time() - _T0)}s] {msg}", flush=True)


def sh(cmd):
    log(f"$ {cmd}")
    subprocess.check_call(cmd, shell=True)


def wait(url, tries, delay):
    for _ in range(tries):
        try:
            urllib.request.urlopen(url, timeout=2)
            return True
        except Exception:
            time.sleep(delay)
    return False


def fetch_wheelhouse():
    """Download + extract the wheelhouse matching this Python + accelerator.

    Returns the accelerator actually obtained ('gpu'/'cpu'), or None if no
    matching wheelhouse exists for this Python version.
    """
    pyver = f"cp{sys.version_info.major}{sys.version_info.minor}"
    os.makedirs(WHEELHOUSE, exist_ok=True)
    # Prefer GPU when asked, but fall back to the CPU wheelhouse (the GPU build
    # is cp312 only) so a mismatched Python still gets a working install.
    for accel in (["gpu", "cpu"] if GPU else ["cpu"]):
        name = f"edgerunner-wheels-{pyver}-{accel}.tar.gz"
        tgz = f"/kaggle/working/{name}"
        try:
            print(f"fetching wheelhouse {name} …", flush=True)
            urllib.request.urlretrieve(f"{WHEELS_RELEASE}/{name}", tgz)
            with tarfile.open(tgz) as t:
                t.extractall(WHEELHOUSE)
            print(f"wheelhouse ready ({accel})", flush=True)
            return accel
        except Exception as e:
            print(f"  {name} unavailable ({e})", flush=True)
    return None


# --- 1. deps ---------------------------------------------------------------
accel = fetch_wheelhouse()
pkgs = ["fastapi", "uvicorn[standard]", "httpx", "pydantic", "huggingface_hub"]
if MODEL_FILE:
    pkgs.insert(0, f"llama-cpp-python[server]=={LLAMA_VERSION}")

if accel:
    # Install from the wheelhouse first (offline for everything it has), letting
    # pip reach PyPI only for the two small pure-python server deps. Never build
    # llama-cpp-python from source.
    log("installing deps from wheelhouse (this is offline + fast) …")
    sh(f"{sys.executable} -m pip install --find-links {WHEELHOUSE} "
       f"--only-binary llama-cpp-python " + " ".join(f"'{p}'" for p in pkgs))
    GPU = GPU and accel == "gpu"  # if we fell back to CPU wheels, run on CPU
else:
    # No wheelhouse for this Python — fall back to PyPI + the abetlen wheel index.
    log("no prebuilt wheelhouse for this Python; falling back to PyPI")
    sh(f"{sys.executable} -m pip install fastapi 'uvicorn[standard]' httpx pydantic huggingface_hub")
    if MODEL_FILE:
        variant = "cu124" if GPU else "cpu"
        sh(f"{sys.executable} -m pip install 'llama-cpp-python[server]' "
           f"--extra-index-url https://abetlen.github.io/llama-cpp-python/whl/{variant} "
           f"--only-binary llama-cpp-python")
log("deps installed")

# --- 2. backend code -------------------------------------------------------
if not os.path.exists(ROOT):
    log("cloning backend code …")
    sh(f"git clone --depth 1 {REPO} {ROOT}")
backend = f"{ROOT}/backend"

# --- 3. model + llama-server (optional) ------------------------------------
# Download the GGUF with a plain HTTPS GET of the HF resolve URL, NOT
# huggingface_hub: on Kaggle, hf_hub_download's Xet transfer fails
# ("SignatureError: invalid key pair id") and stalls at 0 bytes, while a direct
# GET follows the redirect to the CDN and streams the full file in seconds.
_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def download_gguf(repo, fname, dest):
    url = f"https://huggingface.co/{repo}/resolve/main/{fname}?download=true"
    for attempt in range(1, 5):
        have = os.path.getsize(dest) if os.path.exists(dest) else 0
        headers = {"User-Agent": _UA, "Accept": "*/*"}
        if HF_TOKEN:
            headers["Authorization"] = f"Bearer {HF_TOKEN}"  # beats the anon 403
        if have:
            headers["Range"] = f"bytes={have}-"  # resume
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=30) as r:
                total = have + int(r.headers.get("Content-Length", 0) or 0)
                mode = "ab" if have and r.status == 206 else "wb"
                if mode == "wb":
                    have = 0
                last = time.time()
                with open(dest, mode) as f:
                    while True:
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        have += len(chunk)
                        if time.time() - last >= 5:
                            pct = f" ({have * 100 // total}%)" if total else ""
                            log(f"  …downloaded {have // (1024 * 1024)} MB{pct}")
                            last = time.time()
            if os.path.getsize(dest) > 0 and (not total or os.path.getsize(dest) >= total):
                return dest
            log(f"download incomplete on attempt {attempt}; retrying")
        except Exception as e:
            log(f"download attempt {attempt} failed ({e}); retrying")
        time.sleep(3)
    raise RuntimeError("model download failed")


llama_base = None
if MODEL_FILE:
    log(f"downloading model {MODEL_REPO}/{MODEL_FILE} …")
    t = time.time()
    model_path = f"{ROOT}/{MODEL_FILE}"
    download_gguf(MODEL_REPO, MODEL_FILE, model_path)
    log(f"model downloaded in {int(time.time() - t)}s: {model_path} "
        f"({os.path.getsize(model_path) // (1024 * 1024)} MB)")

    alias = MODEL_FILE.rsplit(".", 1)[0]
    log("starting llama-server …")
    subprocess.Popen(
        [sys.executable, "-m", "llama_cpp.server", "--model", model_path,
         "--model_alias", alias, "--host", "127.0.0.1", "--port", "8080",
         "--n_ctx", "8192", "--n_batch", "512",
         "--n_gpu_layers", "-1" if GPU else "0"])
    if wait("http://127.0.0.1:8080/v1/models", 180, 2):
        log("llama server up — chat is live")
        llama_base = "http://127.0.0.1:8080"
    else:
        log("llama server did not start; continuing without a model")

# --- 4. EdgeRunner FastAPI (uvicorn) ---------------------------------------
log("starting FastAPI (uvicorn) …")
env = dict(os.environ, PYTHONPATH=backend)
if llama_base:
    env["LLAMACPP_BASE_URL"] = llama_base
subprocess.Popen(
    [sys.executable, "-m", "uvicorn", "app.main:app",
     "--host", "0.0.0.0", "--port", "8000"], cwd=backend, env=env)
if not wait("http://127.0.0.1:8000/api/health", 60, 1):
    raise SystemExit("FastAPI failed to start (check the cell output above)")
log("api up")

# --- 5. cloudflared tunnel -------------------------------------------------
log("starting cloudflared tunnel …")
CF = "/kaggle/working/cloudflared"
if not os.path.exists(CF):
    sh(f"wget -q -O {CF} https://github.com/cloudflare/cloudflared/releases/latest/"
       f"download/cloudflared-linux-amd64 && chmod +x {CF}")
tun_log = "/kaggle/working/tunnel.log"
subprocess.Popen([CF, "tunnel", "--no-autoupdate", "--url", "http://localhost:8000"],
                 stdout=open(tun_log, "w"), stderr=subprocess.STDOUT)
url = None
for _ in range(40):
    time.sleep(1)
    try:
        m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", open(tun_log).read())
    except Exception:
        m = None
    if m:
        url = m.group(0)
        break
if not url:
    raise SystemExit("cloudflared did not produce a URL (check Internet is ON)")

print("\n" + "=" * 60)
print(f"EDGERUNNER_URL={url}")
print("Paste this URL into the EdgeRunner app (settings → connect).")
print("=" * 60 + "\n", flush=True)

# Keep the cell (and the tunnel) alive; re-print the URL periodically.
while True:
    time.sleep(30)
    print(f"EDGERUNNER_URL={url}", flush=True)
