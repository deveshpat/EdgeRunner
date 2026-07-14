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
llama_base = None
if MODEL_FILE:
    import glob
    import threading

    os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"  # avoid the 0-byte stall
    from huggingface_hub import hf_hub_download

    log(f"downloading model {MODEL_REPO}/{MODEL_FILE} "
        f"(unauthenticated HF can be slow on CPU sessions) …")

    # Live progress: log the size of the largest file in the HF cache every 5s
    # so the download is visibly moving (hf_hub_download itself is quiet here).
    cache = os.path.expanduser("~/.cache/huggingface")
    stop = threading.Event()

    def watch():
        while not stop.wait(5):
            try:
                sizes = [os.path.getsize(p) for p in
                         glob.glob(f"{cache}/**/*", recursive=True)
                         if os.path.isfile(p)]
                mb = (max(sizes) if sizes else 0) // (1024 * 1024)
                log(f"  …model download in progress: {mb} MB")
            except Exception:
                pass

    threading.Thread(target=watch, daemon=True).start()
    t = time.time()
    model_path = hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE)
    stop.set()
    log(f"model downloaded in {int(time.time() - t)}s: {model_path}")

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
