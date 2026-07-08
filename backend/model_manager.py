import os
import sys
import psutil
import subprocess
import re
from huggingface_hub import HfApi, hf_hub_download

MODEL_DIR = "./models"
api = HfApi()

def _macos_metal_gpu():
    if sys.platform != "darwin": return None
    try:
        r = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=5)
        total_mb = int(r.stdout.strip()) // (1024 * 1024)
        vm = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5)
        page_size, free_pages = 4096, 0
        for line in vm.stdout.splitlines():
            if "page size of" in line:
                m = re.search(r"page size of (\d+)", line)
                if m: page_size = int(m.group(1))
            elif any(x in line for x in ["Pages free:", "Pages inactive:", "Pages speculative:"]):
                free_pages += int(line.split(":")[1].strip().rstrip("."))
        free_mb = (free_pages * page_size) // (1024 * 1024)
        return {"type": "Apple Metal (Unified)", "total_gb": total_mb / 1024, "free_gb": free_mb / 1024}
    except Exception: return None

def _nvidia_gpu():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5
        )
        if out.returncode == 0:
            free_gb, total_gb = 0, 0
            for line in out.stdout.strip().splitlines():
                free, total = line.split(",")
                free_gb += int(free.strip()) / 1024
                total_gb += int(total.strip()) / 1024
            if total_gb > 0: return {"type": "NVIDIA GPU", "total_gb": total_gb, "free_gb": free_gb}
    except FileNotFoundError: pass
    return None

def get_system_hardware():
    hw = _nvidia_gpu()
    if hw: return hw
    hw = _macos_metal_gpu()
    if hw: return hw
    sys_ram = psutil.virtual_memory()
    return {"type": "CPU (No GPU detected)", "total_gb": sys_ram.total / (1024**3), "free_gb": sys_ram.available / (1024**3)}

def fetch_trending_models(hw_total_gb, limit=8):
    print(f"\n🌐 Fetching live trending GGUF models from Hugging Face...")
    trending_repos = api.list_models(filter="gguf", sort="trendingScore", limit=limit)
    candidate_models = []
    
    for i, repo in enumerate(trending_repos):
        try:
            info = api.model_info(repo.modelId, files_metadata=True)
            gguf_files = [f for f in info.siblings if f.rfilename.endswith(".gguf")]
            if not gguf_files: continue
            
            target_file = next((f for f in gguf_files if "Q4_K_M" in f.rfilename.upper()), None)
            if not target_file:
                target_file = next((f for f in gguf_files if "Q4" in f.rfilename.upper()), gguf_files[0])
            
            file_size_gb = target_file.size / (1024**3)
            required_ram = file_size_gb + 1.5 
            capability = 100 - (i * 5)
            
            headroom = hw_total_gb - required_ram
            safe_ctx = 8192 if headroom > 4 else (4096 if headroom > 2 else 2048)

            candidate_models.append({
                "repo_id": repo.modelId,
                "name": repo.modelId.split("/")[-1],
                "filename": target_file.rfilename,
                "required_ram_gb": required_ram,
                "capability_score": capability,
                "safe_ctx": safe_ctx
            })
        except Exception: pass
    return candidate_models

def scan_hardware_and_score():
    hw = get_system_hardware()
    print(f"\n🔍 HARDWARE SCAN: Detected {hw['type']} with {hw['total_gb']:.1f} GB Total\n")
    dynamic_models = fetch_trending_models(hw_total_gb=hw['total_gb'])
    scored_models = []
    
    for model in dynamic_models:
        if model["required_ram_gb"] > hw["total_gb"]:
            fit_score, fit_status = 0, "❌ INCOMP"
        else:
            headroom = hw["total_gb"] - model["required_ram_gb"]
            fit_score, fit_status = (50, "⚠️ TIGHT") if headroom < 1.0 else (100, "✅ FIT")
                
        model["total_score"] = 0 if fit_score == 0 else (model["capability_score"] * 0.7) + (fit_score * 0.3)
        model["fit_status"] = fit_status
        scored_models.append(model)
        
    scored_models.sort(key=lambda x: x["total_score"], reverse=True)
    return scored_models

def get_or_download_model():
    os.makedirs(MODEL_DIR, exist_ok=True)
    scored_models = scan_hardware_and_score()
    
    print("🏆 EDGERUNNER COOKBOOK (Live Trending Models)")
    print("-" * 80)
    print(f"{'#':<3} | {'Model Name':<40} | {'RAM Needed':<12} | {'Status'}")
    print("-" * 80)
    for i, m in enumerate(scored_models):
        display_name = m['name'][:37] + ".." if len(m['name']) > 40 else m['name']
        print(f"{i+1:<3} | {display_name:<40} | {m['required_ram_gb']:>4.1f} GB     | {m['fit_status']}")
    print("-" * 80)
    
    best_model = next((m for m in scored_models if m["total_score"] > 0), None)
    if not best_model:
        print("\n❌ CRITICAL: No trending models fit. Falling back to static lightweight model.")
        best_model = {"repo_id": "Qwen/Qwen2.5-1.5B-Instruct-GGUF", "name": "Qwen2.5-1.5B-Instruct-GGUF", "filename": "qwen2.5-1.5b-instruct-q4_k_m.gguf", "safe_ctx": 2048}
        
    print(f"\n🤖 Auto-selecting optimal model: {best_model['name']}")
    choice = input(f"Press [ENTER] to use this model, or type a number (1-{len(scored_models)}) to override: ").strip()
    
    selected_model = scored_models[int(choice)-1] if choice.isdigit() and 1 <= int(choice) <= len(scored_models) else best_model
    model_path = os.path.join(MODEL_DIR, selected_model["filename"])
    
    if not os.path.exists(model_path):
        print(f"\n⬇️ Downloading {selected_model['name']} from HuggingFace...")
        hf_hub_download(repo_id=selected_model["repo_id"], filename=selected_model["filename"], local_dir=MODEL_DIR)
        print("✅ Download complete!\n")
    else:
        print(f"\n✅ Found cached model locally at {model_path}\n")
        
    return {"path": model_path, "n_ctx": selected_model["safe_ctx"]}
