import os
import re
import subprocess
import sys
from pathlib import Path

import psutil
from huggingface_hub import HfApi, hf_hub_download

# Prefer persistent Kaggle working dir; overridden by env.
_DEFAULT_MODEL_DIR = os.environ.get(
    "EDGERUNNER_MODEL_DIR",
    "/kaggle/working/edgerunner/models"
    if Path("/kaggle/working").exists()
    else "./models",
)
MODEL_DIR = _DEFAULT_MODEL_DIR
api = HfApi()

# Non-interactive by default on Kaggle / when EDGERUNNER_AUTO=1
AUTO_SELECT = os.environ.get("EDGERUNNER_AUTO", "1").strip() not in (
    "0",
    "false",
    "False",
)

# Module-level load progress for /health
_load_status: dict = {"loading": False, "phase": "idle", "detail": ""}

# Multi-part GGUF: name-00001-of-00004.gguf
_SHARD_RE = re.compile(r"-(\d{5})-of-(\d{5})\.gguf$", re.IGNORECASE)


def get_load_status() -> dict:
    return dict(_load_status)


def _set_status(phase: str, detail: str = "", loading: bool = True) -> None:
    _load_status["loading"] = loading
    _load_status["phase"] = phase
    _load_status["detail"] = detail


def _macos_metal_gpu():
    if sys.platform != "darwin":
        return None
    try:
        r = subprocess.run(
            ["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5
        )
        total_mb = int(r.stdout.strip()) // (1024 * 1024)
        vm = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5)
        page_size, free_pages = 4096, 0
        for line in vm.stdout.splitlines():
            if "page size of" in line:
                m = re.search(r"page size of (\d+)", line)
                if m:
                    page_size = int(m.group(1))
            elif any(
                x in line
                for x in ["Pages free:", "Pages inactive:", "Pages speculative:"]
            ):
                free_pages += int(line.split(":")[1].strip().rstrip("."))
        free_mb = (free_pages * page_size) // (1024 * 1024)
        return {
            "type": "Apple Metal (Unified)",
            "total_gb": total_mb / 1024,
            "free_gb": free_mb / 1024,
        }
    except Exception:
        return None


def _nvidia_gpu():
    try:
        out = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.free,memory.total",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode == 0:
            free_gb, total_gb = 0.0, 0.0
            for line in out.stdout.strip().splitlines():
                free, total = line.split(",")
                free_gb += int(free.strip()) / 1024
                total_gb += int(total.strip()) / 1024
            if total_gb > 0:
                return {"type": "NVIDIA GPU", "total_gb": total_gb, "free_gb": free_gb}
    except FileNotFoundError:
        pass
    return None


def get_system_hardware():
    hw = _nvidia_gpu()
    if hw:
        return hw
    hw = _macos_metal_gpu()
    if hw:
        return hw
    sys_ram = psutil.virtual_memory()
    return {
        "type": "CPU (No GPU detected)",
        "total_gb": sys_ram.total / (1024**3),
        "free_gb": sys_ram.available / (1024**3),
    }


def hydrate_model_cache_from_inputs() -> None:
    """Link (never copy) GGUFs from /kaggle/input if a prior output was mounted."""
    input_root = Path("/kaggle/input")
    if not input_root.exists():
        print(
            "  (no /kaggle/input — kernel output not attached; OK)",
            flush=True,
        )
        return

    dest_models = Path(MODEL_DIR)
    dest_models.mkdir(parents=True, exist_ok=True)
    linked = 0
    for gguf in input_root.rglob("*.gguf"):
        try:
            target = dest_models / gguf.name
            if target.exists() or target.is_symlink():
                continue
            target.symlink_to(gguf.resolve())
            print(f"  ♻️ Linked cached model {gguf.name} → {gguf}", flush=True)
            linked += 1
        except Exception as e:
            print(f"  cache link skip {gguf.name}: {e}", flush=True)

    if linked:
        print(f"✅ Linked {linked} GGUF(s) in-place", flush=True)
    else:
        print("  (no linkable GGUF under /kaggle/input)", flush=True)


def find_existing_gguf(filename: str) -> str | None:
    """Locate a GGUF by basename under model dir / working / input mounts."""
    base = Path(filename).name
    candidates = [
        Path(MODEL_DIR) / base,
        Path(MODEL_DIR) / filename,  # may include subdir from HF
        Path("/kaggle/working/edgerunner/models") / base,
        Path("/kaggle/working/models") / base,
    ]
    for c in candidates:
        if c.is_file() and c.stat().st_size > 0:
            return str(c.resolve())
    # Nested under MODEL_DIR (hf_hub_download layout)
    root = Path(MODEL_DIR)
    if root.exists():
        for p in root.rglob(base):
            if p.is_file() and p.stat().st_size > 0:
                return str(p.resolve())
    input_root = Path("/kaggle/input")
    if input_root.exists():
        for p in input_root.rglob(base):
            if p.is_file() and p.stat().st_size > 0:
                return str(p.resolve())
    return None


def _is_sharded(name: str) -> bool:
    return bool(_SHARD_RE.search(name))


def _shard_prefix(name: str) -> str | None:
    m = _SHARD_RE.search(name)
    if not m:
        return None
    return name[: m.start()]


def _quant_rank(filename: str) -> int:
    """Lower is better preferred quant for general chat/coding."""
    u = filename.upper()
    # Prefer solid single-file quants
    order = [
        "Q4_K_M",
        "Q4_K_S",
        "Q5_K_M",
        "Q4_0",
        "Q5_0",
        "Q3_K_M",
        "Q6_K",
        "Q8_0",
        "IQ4_XS",
        "IQ4_NL",
        "IQ3",
        "Q2_K",
    ]
    for i, q in enumerate(order):
        if q in u:
            return i
    if "Q4" in u:
        return 20
    return 50


def _pick_gguf_from_siblings(siblings) -> dict | None:
    """Choose a loadable GGUF: prefer single-file Q4_K_M; avoid half-downloaded shards.

    Returns dict with keys: filename, size_bytes, sharded, shard_files (list of names).
    """
    ggufs = [f for f in siblings if (f.rfilename or "").endswith(".gguf")]
    if not ggufs:
        return None

    # Group sharded sets
    singles = []
    shards_by_prefix: dict[str, list] = {}
    for f in ggufs:
        name = f.rfilename
        if _is_sharded(name):
            pref = _shard_prefix(name) or name
            shards_by_prefix.setdefault(pref, []).append(f)
        else:
            singles.append(f)

    candidates: list[dict] = []

    for f in singles:
        size = int(f.size or 0)
        candidates.append(
            {
                "filename": f.rfilename,
                "size_bytes": size,
                "sharded": False,
                "shard_files": [f.rfilename],
                "quant_rank": _quant_rank(f.rfilename),
            }
        )

    for pref, parts in shards_by_prefix.items():
        # Only accept complete sets
        total = 0
        names = []
        expected = None
        for p in parts:
            m = _SHARD_RE.search(p.rfilename)
            if m:
                expected = int(m.group(2))
            total += int(p.size or 0)
            names.append(p.rfilename)
        if expected is not None and len(parts) < expected:
            # incomplete listing — skip (can't load)
            continue
        names.sort()
        # Load path is first shard (…-00001-of-0000N.gguf)
        first = next(
            (n for n in names if re.search(r"-00001-of-\d{5}\.gguf$", n, re.I)),
            names[0],
        )
        candidates.append(
            {
                "filename": first,
                "size_bytes": total,
                "sharded": True,
                "shard_files": names,
                "quant_rank": _quant_rank(first) + 5,  # slight preference for single-file
            }
        )

    if not candidates:
        return None

    # Prefer single-file, better quant, reasonable size
    candidates.sort(
        key=lambda c: (
            0 if not c["sharded"] else 1,
            c["quant_rank"],
            c["size_bytes"],
        )
    )
    return candidates[0]


def fetch_trending_models(hw_total_gb, limit=12):
    print("\n🌐 Fetching live trending GGUF models from Hugging Face...", flush=True)
    try:
        trending_repos = api.list_models(
            filter="gguf", sort="trendingScore", limit=limit
        )
    except Exception as e:
        print(f"⚠️ HF list_models failed: {e}", flush=True)
        return []

    candidate_models = []
    for i, repo in enumerate(trending_repos):
        try:
            info = api.model_info(repo.modelId, files_metadata=True)
            pick = _pick_gguf_from_siblings(info.siblings or [])
            if not pick:
                continue

            file_size_gb = pick["size_bytes"] / (1024**3)
            # Runtime overhead beyond file size (KV cache, llama.cpp)
            required_ram = file_size_gb * 1.15 + 1.5
            capability = 100 - (i * 4)

            headroom = hw_total_gb - required_ram
            safe_ctx = 8192 if headroom > 6 else (4096 if headroom > 3 else 2048)

            candidate_models.append(
                {
                    "repo_id": repo.modelId,
                    "name": repo.modelId.split("/")[-1],
                    "filename": pick["filename"],
                    "shard_files": pick["shard_files"],
                    "sharded": pick["sharded"],
                    "file_size_gb": file_size_gb,
                    "required_ram_gb": required_ram,
                    "capability_score": capability,
                    "safe_ctx": safe_ctx,
                    "quant_rank": pick["quant_rank"],
                }
            )
        except Exception as e:
            print(f"  skip {getattr(repo, 'modelId', '?')}: {e}", flush=True)
            continue
    return candidate_models


def scan_hardware_and_score():
    hw = get_system_hardware()
    print(
        f"\n🔍 HARDWARE SCAN: Detected {hw['type']} with {hw['total_gb']:.1f} GB Total\n",
        flush=True,
    )
    dynamic_models = fetch_trending_models(hw_total_gb=hw["total_gb"])
    scored_models = []
    for model in dynamic_models:
        if model["required_ram_gb"] > hw["total_gb"]:
            fit_score, fit_status = 0, "❌ INCOMP"
        else:
            headroom = hw["total_gb"] - model["required_ram_gb"]
            fit_score, fit_status = (
                (50, "⚠️ TIGHT") if headroom < 1.5 else (100, "✅ FIT")
            )
        # Prefer better fit + trending; slightly prefer non-sharded / good quant
        model["total_score"] = (
            0
            if fit_score == 0
            else (model["capability_score"] * 0.55)
            + (fit_score * 0.35)
            + (10 if not model.get("sharded") else 0)
            + max(0, 10 - model.get("quant_rank", 10))
        )
        model["fit_status"] = fit_status
        scored_models.append(model)
    scored_models.sort(key=lambda x: x["total_score"], reverse=True)
    return scored_models, hw


def _fallback_model(hw_total_gb: float = 16.0) -> dict:
    """Solid single-file defaults — download size is fine; pick what fits RAM."""
    # Ordered largest-first among known good single-file instruct GGUFs
    catalog = [
        {
            "repo_id": "Qwen/Qwen2.5-7B-Instruct-GGUF",
            "name": "Qwen2.5-7B-Instruct-GGUF",
            "filename": "qwen2.5-7b-instruct-q4_k_m.gguf",
            "file_size_gb": 4.7,
            "required_ram_gb": 7.0,
            "safe_ctx": 4096,
        },
        {
            "repo_id": "Qwen/Qwen2.5-3B-Instruct-GGUF",
            "name": "Qwen2.5-3B-Instruct-GGUF",
            "filename": "qwen2.5-3b-instruct-q4_k_m.gguf",
            "file_size_gb": 2.0,
            "required_ram_gb": 3.5,
            "safe_ctx": 4096,
        },
        {
            "repo_id": "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
            "name": "Qwen2.5-1.5B-Instruct-GGUF",
            "filename": "qwen2.5-1.5b-instruct-q4_k_m.gguf",
            "file_size_gb": 1.0,
            "required_ram_gb": 2.0,
            "safe_ctx": 2048,
        },
    ]
    forced_repo = os.environ.get("EDGERUNNER_FALLBACK_REPO")
    forced_file = os.environ.get("EDGERUNNER_FALLBACK_FILE")
    if forced_repo and forced_file:
        return {
            "repo_id": forced_repo,
            "name": forced_repo.split("/")[-1],
            "filename": forced_file,
            "shard_files": [forced_file],
            "sharded": _is_sharded(forced_file),
            "safe_ctx": int(os.environ.get("EDGERUNNER_N_CTX", "4096")),
            "total_score": 1,
            "fit_status": "✅ FALLBACK",
            "required_ram_gb": 0,
            "file_size_gb": 0,
        }

    for m in catalog:
        if m["required_ram_gb"] <= hw_total_gb:
            return {
                **m,
                "shard_files": [m["filename"]],
                "sharded": False,
                "total_score": 1,
                "fit_status": "✅ FALLBACK",
            }
    m = catalog[-1]
    return {
        **m,
        "shard_files": [m["filename"]],
        "sharded": False,
        "total_score": 1,
        "fit_status": "✅ FALLBACK",
    }


def _download_gguf(repo_id: str, files: list[str], primary: str) -> str:
    """Download one or many GGUF files; return absolute path to the loadable primary."""
    os.makedirs(MODEL_DIR, exist_ok=True)
    # HF may already have partial cache under working
    if Path("/kaggle/working").exists():
        hf_home = Path("/kaggle/working/hf_cache")
        hf_home.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(hf_home))
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(hf_home / "hub"))

    files = list(dict.fromkeys(files))  # dedupe, preserve order
    print(
        f"\n⬇️ Downloading {len(files)} file(s) from {repo_id} "
        f"(HF download is fine — not a bottleneck)…",
        flush=True,
    )
    for i, fn in enumerate(files, 1):
        print(f"  [{i}/{len(files)}] {fn}", flush=True)
        hf_hub_download(repo_id=repo_id, filename=fn, local_dir=MODEL_DIR)

    path = find_existing_gguf(primary)
    if path:
        # For sharded models, ensure siblings sit next to primary
        if _is_sharded(primary):
            parent = Path(path).parent
            missing = []
            for fn in files:
                if not (parent / Path(fn).name).is_file() and not find_existing_gguf(fn):
                    missing.append(fn)
            if missing:
                print(f"  re-fetching missing shards: {missing}", flush=True)
                for fn in missing:
                    hf_hub_download(repo_id=repo_id, filename=fn, local_dir=str(parent))
        print(f"✅ Download complete → {path}\n", flush=True)
        return path

    # Last resort: search whole MODEL_DIR
    base = Path(primary).name
    for p in Path(MODEL_DIR).rglob(base):
        if p.is_file():
            print(f"✅ Download complete → {p}\n", flush=True)
            return str(p.resolve())

    raise FileNotFoundError(
        f"Downloaded GGUF but cannot locate {primary} under {MODEL_DIR}"
    )


def get_or_download_model():
    _set_status("hydrate", "Restoring cache from prior Kaggle output…")
    hydrate_model_cache_from_inputs()

    os.makedirs(MODEL_DIR, exist_ok=True)
    if Path("/kaggle/working").exists():
        hf_home = Path("/kaggle/working/hf_cache")
        hf_home.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(hf_home))
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(hf_home / "hub"))

    _set_status("select", "Selecting model…")
    scored_models, hw = scan_hardware_and_score()

    print("🏆 EDGERUNNER COOKBOOK (Live Trending Models)", flush=True)
    print("-" * 88, flush=True)
    print(
        f"{'#':<3} | {'Model Name':<36} | {'Disk':<8} | {'RAM need':<10} | {'Status'}",
        flush=True,
    )
    print("-" * 88, flush=True)
    for i, m in enumerate(scored_models):
        display_name = m["name"][:33] + ".." if len(m["name"]) > 36 else m["name"]
        disk = m.get("file_size_gb", m.get("required_ram_gb", 0))
        print(
            f"{i+1:<3} | {display_name:<36} | {disk:>5.1f} GB | "
            f"{m['required_ram_gb']:>5.1f} GB  | {m['fit_status']}"
            f"{'  (sharded)' if m.get('sharded') else ''}",
            flush=True,
        )
    print("-" * 88, flush=True)

    # Optional hard cap by RAM/disk — NOT for "fast download". Default: hardware fit.
    max_gb_env = os.environ.get("EDGERUNNER_MAX_MODEL_GB", "").strip()
    max_gb = float(max_gb_env) if max_gb_env else None

    forced_repo = os.environ.get("EDGERUNNER_MODEL_REPO")
    forced_file = os.environ.get("EDGERUNNER_MODEL_FILE")

    if forced_repo and forced_file:
        selected_model = {
            "repo_id": forced_repo,
            "name": forced_repo.split("/")[-1],
            "filename": forced_file,
            "shard_files": [forced_file],
            "sharded": _is_sharded(forced_file),
            "safe_ctx": int(os.environ.get("EDGERUNNER_N_CTX", "4096")),
            "required_ram_gb": 0,
            "file_size_gb": 0,
        }
        # If forced file is a shard, try to discover siblings via API
        if selected_model["sharded"]:
            try:
                info = api.model_info(forced_repo, files_metadata=True)
                pref = _shard_prefix(forced_file)
                sibs = [
                    f.rfilename
                    for f in (info.siblings or [])
                    if f.rfilename.endswith(".gguf")
                    and pref
                    and f.rfilename.startswith(pref)
                ]
                if sibs:
                    selected_model["shard_files"] = sorted(sibs)
            except Exception:
                pass
        print(f"\n🤖 Using forced model from env: {selected_model['name']}", flush=True)
    else:
        # Default: best-scoring model that FITs RAM (and optional max cap).
        # Download time is not a selection criterion.
        fitting = [m for m in scored_models if m.get("total_score", 0) > 0]
        if max_gb is not None:
            fitting = [
                m
                for m in fitting
                if m.get("file_size_gb", m.get("required_ram_gb", 99)) <= max_gb
            ]
        selected_model = fitting[0] if fitting else _fallback_model(hw["total_gb"])
        print(
            f"\n🤖 Selected model: {selected_model['name']} "
            f"(~{selected_model.get('file_size_gb', selected_model.get('required_ram_gb', '?'))} GB on disk, "
            f"~{selected_model.get('required_ram_gb', '?')} GB RAM) "
            f"— pick is hardware-fit, not download-speed limited",
            flush=True,
        )
        if selected_model.get("sharded"):
            print(
                f"   multi-shard: {len(selected_model.get('shard_files') or [])} parts "
                f"(will download all)",
                flush=True,
            )

    filename = selected_model["filename"]
    base_name = Path(filename).name
    shard_files = selected_model.get("shard_files") or [filename]
    model_path = find_existing_gguf(base_name)

    # For sharded: require all parts present
    if model_path and selected_model.get("sharded"):
        parent = Path(model_path).parent
        if not all(
            (parent / Path(fn).name).is_file() or find_existing_gguf(fn)
            for fn in shard_files
        ):
            model_path = None

    if model_path:
        print(f"\n✅ Using model in-place at {model_path}\n", flush=True)
    else:
        _set_status("download", f"Downloading {selected_model['name']}…")
        model_path = _download_gguf(
            selected_model["repo_id"], shard_files, primary=filename
        )

    if not Path(model_path).is_file():
        raise FileNotFoundError(f"Model file missing after download: {model_path}")

    _set_status("downloaded", selected_model.get("name", ""), loading=True)
    return {
        "path": model_path,
        "n_ctx": selected_model.get("safe_ctx", 4096),
        "name": selected_model.get("name", "unknown"),
    }
