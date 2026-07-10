import os
import shutil
import sys
import re
import subprocess
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
    """Link (never copy) GGUFs from /kaggle/input if a prior output was mounted.

    Copying multi‑GB files from attached kernel output made cold starts worse
    than re-downloading a small model. We only create cheap symlinks.
    """
    input_root = Path("/kaggle/input")
    if not input_root.exists():
        print("  (no /kaggle/input — kernel output not attached; OK for fast start)", flush=True)
        return

    dest_models = Path(MODEL_DIR)
    dest_models.mkdir(parents=True, exist_ok=True)
    linked = 0
    for gguf in input_root.rglob("*.gguf"):
        try:
            target = dest_models / gguf.name
            if target.exists() or target.is_symlink():
                continue
            # Symlink is instant; load will read through to /kaggle/input
            target.symlink_to(gguf.resolve())
            print(f"  ♻️ Linked cached model {gguf.name} → {gguf}", flush=True)
            linked += 1
        except Exception as e:
            print(f"  cache link skip {gguf.name}: {e}", flush=True)

    if linked:
        print(f"✅ Linked {linked} GGUF(s) in-place (no multi-GB copy)", flush=True)
    else:
        print("  (no linkable GGUF under /kaggle/input)", flush=True)


def find_existing_gguf(filename: str) -> str | None:
    """Locate a GGUF by name in model dir, working, or input mounts."""
    candidates = [
        Path(MODEL_DIR) / filename,
        Path("/kaggle/working/edgerunner/models") / filename,
        Path("/kaggle/working/models") / filename,
    ]
    for c in candidates:
        if c.is_file() and c.stat().st_size > 0:
            return str(c)
    input_root = Path("/kaggle/input")
    if input_root.exists():
        for p in input_root.rglob(filename):
            if p.is_file() and p.stat().st_size > 0:
                return str(p)
    return None


def fetch_trending_models(hw_total_gb, limit=8):
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
            gguf_files = [f for f in info.siblings if f.rfilename.endswith(".gguf")]
            if not gguf_files:
                continue

            target_file = next(
                (f for f in gguf_files if "Q4_K_M" in f.rfilename.upper()), None
            )
            if not target_file:
                target_file = next(
                    (f for f in gguf_files if "Q4" in f.rfilename.upper()),
                    gguf_files[0],
                )

            file_size_gb = (target_file.size or 0) / (1024**3)
            required_ram = file_size_gb + 1.5
            capability = 100 - (i * 5)

            headroom = hw_total_gb - required_ram
            safe_ctx = 8192 if headroom > 4 else (4096 if headroom > 2 else 2048)

            candidate_models.append(
                {
                    "repo_id": repo.modelId,
                    "name": repo.modelId.split("/")[-1],
                    "filename": target_file.rfilename,
                    "required_ram_gb": required_ram,
                    "capability_score": capability,
                    "safe_ctx": safe_ctx,
                }
            )
        except Exception:
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
                (50, "⚠️ TIGHT") if headroom < 1.0 else (100, "✅ FIT")
            )
        model["total_score"] = (
            0
            if fit_score == 0
            else (model["capability_score"] * 0.7) + (fit_score * 0.3)
        )
        model["fit_status"] = fit_status
        scored_models.append(model)
    scored_models.sort(key=lambda x: x["total_score"], reverse=True)
    return scored_models


def _fallback_model():
    return {
        "repo_id": os.environ.get(
            "EDGERUNNER_FALLBACK_REPO", "Qwen/Qwen2.5-1.5B-Instruct-GGUF"
        ),
        "name": "Qwen2.5-1.5B-Instruct-GGUF",
        "filename": os.environ.get(
            "EDGERUNNER_FALLBACK_FILE", "qwen2.5-1.5b-instruct-q4_k_m.gguf"
        ),
        "safe_ctx": 2048,
        "total_score": 1,
        "fit_status": "✅ FALLBACK",
        "required_ram_gb": 2.0,
    }


def get_or_download_model():
    _set_status("hydrate", "Restoring cache from prior Kaggle output…")
    hydrate_model_cache_from_inputs()

    os.makedirs(MODEL_DIR, exist_ok=True)
    # Point HF downloads at persistent working cache
    if Path("/kaggle/working").exists():
        hf_home = Path("/kaggle/working/hf_cache")
        hf_home.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("HF_HOME", str(hf_home))
        os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(hf_home / "hub"))

    _set_status("select", "Selecting model…")
    scored_models = scan_hardware_and_score()

    print("🏆 EDGERUNNER COOKBOOK (Live Trending Models)", flush=True)
    print("-" * 80, flush=True)
    print(
        f"{'#':<3} | {'Model Name':<40} | {'RAM Needed':<12} | {'Status'}",
        flush=True,
    )
    print("-" * 80, flush=True)
    for i, m in enumerate(scored_models):
        display_name = m["name"][:37] + ".." if len(m["name"]) > 40 else m["name"]
        print(
            f"{i+1:<3} | {display_name:<40} | {m['required_ram_gb']:>4.1f} GB     | {m['fit_status']}",
            flush=True,
        )
    print("-" * 80, flush=True)

    # Prefer a small default for fast Kaggle boots. Set EDGERUNNER_USE_TRENDING=1
    # to pick the largest fitting trending model instead.
    use_trending = os.environ.get("EDGERUNNER_USE_TRENDING", "0").strip() not in (
        "0",
        "false",
        "False",
        "",
    )
    max_gb = float(os.environ.get("EDGERUNNER_MAX_MODEL_GB", "3.5"))

    forced_repo = os.environ.get("EDGERUNNER_MODEL_REPO")
    forced_file = os.environ.get("EDGERUNNER_MODEL_FILE")
    if forced_repo and forced_file:
        selected_model = {
            "repo_id": forced_repo,
            "name": forced_repo.split("/")[-1],
            "filename": forced_file,
            "safe_ctx": int(os.environ.get("EDGERUNNER_N_CTX", "2048")),
            "required_ram_gb": 0,
        }
        print(f"\n🤖 Using forced model from env: {selected_model['name']}", flush=True)
    elif use_trending:
        best_model = next((m for m in scored_models if m["total_score"] > 0), None)
        selected_model = best_model or _fallback_model()
        print(
            f"\n🤖 Trending pick: {selected_model['name']} "
            f"(~{selected_model.get('required_ram_gb', '?')} GB)",
            flush=True,
        )
    else:
        # Fast path: smallest fitting model under max_gb, else static fallback
        small = [
            m
            for m in scored_models
            if m.get("total_score", 0) > 0
            and m.get("required_ram_gb", 99) <= max_gb
        ]
        small.sort(key=lambda m: m.get("required_ram_gb", 99))
        selected_model = small[0] if small else _fallback_model()
        print(
            f"\n🤖 Fast default model: {selected_model['name']} "
            f"(cap {max_gb} GB; set EDGERUNNER_USE_TRENDING=1 for larger)",
            flush=True,
        )

    filename = selected_model["filename"]
    base_name = Path(filename).name
    # Prefer any already-present file (working dir or input mount) — no copy
    model_path = find_existing_gguf(base_name)

    if model_path:
        print(f"\n✅ Using model in-place at {model_path}\n", flush=True)
    else:
        # Also accept any cached GGUF under MODEL_DIR if name differs slightly
        existing_any = list(Path(MODEL_DIR).glob("*.gguf")) if Path(MODEL_DIR).exists() else []
        if existing_any and not use_trending and not forced_repo:
            model_path = str(existing_any[0])
            print(f"\n✅ Reusing existing GGUF on disk: {model_path}\n", flush=True)
        else:
            model_path = str(Path(MODEL_DIR) / base_name)
            _set_status("download", f"Downloading {selected_model['name']}…")
            print(
                f"\n⬇️ Downloading {selected_model['name']} from HuggingFace...",
                flush=True,
            )
            hf_hub_download(
                repo_id=selected_model["repo_id"],
                filename=selected_model["filename"],
                local_dir=MODEL_DIR,
            )
            # Resolve actual path (HF may nest filename)
            found = find_existing_gguf(base_name)
            if found:
                model_path = found
            print("✅ Download complete!\n", flush=True)

    _set_status("downloaded", selected_model.get("name", ""), loading=True)
    return {
        "path": model_path,
        "n_ctx": selected_model.get("safe_ctx", 2048),
        "name": selected_model.get("name", "unknown"),
    }
