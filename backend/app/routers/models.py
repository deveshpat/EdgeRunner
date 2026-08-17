"""Model management and Hugging Face GGUF model explorer router."""

from __future__ import annotations

import logging
import re
import time
from typing import Any

import httpx
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel

from app.config import settings
from app.model_manager import model_manager

router = APIRouter(prefix="/models", tags=["models"])
logger = logging.getLogger(__name__)

# In-memory cache for HF explore requests: key -> (timestamp, data)
_EXPLORE_CACHE: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_CACHE_TTL = 300  # 5 minutes


class LoadModelRequest(BaseModel):
    repo: str
    file: str
    model_id: str | None = None
    gpu: bool | None = None
    n_ctx: int = 8192
    hf_token: str | None = None


@router.get("/status")
@router.get("/status/")
async def get_model_status():
    """Return live status of the currently loaded model and hardware info."""
    return model_manager.get_status().to_dict()


@router.post("/load")
@router.post("/load/")
async def load_model(req: LoadModelRequest, background_tasks: BackgroundTasks):
    """Initiate loading or switching to a specified GGUF model."""
    # If the model is already ready, return immediately
    if (
        model_manager.status == "ready"
        and model_manager.file == req.file
        and model_manager._is_server_alive()
    ):
        return {
            "status": "ready",
            "message": f"Model {req.file} is already loaded and ready.",
            **model_manager.get_status().to_dict(),
        }

    # If already downloading or loading this exact model, return in-progress status
    if (
        model_manager.status in ("downloading", "loading")
        and model_manager.file == req.file
    ):
        return {
            "status": model_manager.status,
            "message": f"Model {req.file} is currently being loaded.",
            **model_manager.get_status().to_dict(),
        }

    # Start the switch in background
    background_tasks.add_task(
        model_manager.switch_model,
        repo=req.repo,
        file=req.file,
        model_id=req.model_id,
        gpu=req.gpu,
        n_ctx=req.n_ctx,
        hf_token=req.hf_token,
    )

    return {
        **model_manager.get_status().to_dict(),
        "status": "starting",
        "message": f"Started loading model {req.repo}/{req.file} in background.",
    }


def _extract_param_size(model_id: str, tags: list[str]) -> str | None:
    text = f"{model_id} {' '.join(tags)}".lower()
    m = re.search(r"\b(\d+(?:\.\d+)?)\s*b\b", text)
    if m:
        return f"{m.group(1).upper()}B"
    return None


def _classify_model(model_id: str, tags: list[str]) -> list[str]:
    categories = []
    text = f"{model_id} {' '.join(tags)}".lower()
    if any(k in text for k in ("r1", "reason", "deepseek-r1", "think", "v4", "kimi", "glm", "qwq")):
        categories.append("Reasoning")
    if any(k in text for k in ("code", "coder", "starcoder", "dev", "codestral")):
        categories.append("Coding")
    if any(k in text for k in ("instruct", "chat", "conversation", "qwen3", "minimax")):
        categories.append("General / Chat")
    if any(k in text for k in ("vision", "vl", "multimodal", "image", "pixtral")):
        categories.append("Vision")
    if any(k in text for k in ("uncensored", "abliterated", "heretic")):
        categories.append("Uncensored")
    return categories or ["General"]


@router.get("/explore")
@router.get("/explore/")
async def explore_models(
    sort: str = Query("trending", pattern="^(trending|downloads|likes)$"),
    search: str | None = Query(None),
    limit: int = Query(25, ge=1, le=100),
):
    """Fetch top compatible GGUF models from Hugging Face Hub."""
    cache_key = f"{sort}_{search}_{limit}"
    now = time.time()
    if cache_key in _EXPLORE_CACHE:
        ts, data = _EXPLORE_CACHE[cache_key]
        if now - ts < _CACHE_TTL:
            return {"models": data, "cached": True}

    sort_map = {
        "trending": "trendingScore",
        "downloads": "downloads",
        "likes": "likes",
    }
    hf_sort = sort_map.get(sort, "trendingScore")

    params: dict[str, Any] = {
        "filter": "gguf",
        "sort": hf_sort,
        "direction": "-1",
        "limit": limit,
        "full": "false",
    }
    if search:
        params["search"] = search

    headers = {"User-Agent": "EdgeRunner/0.1.0"}
    if settings.hf_token:
        headers["Authorization"] = f"Bearer {settings.hf_token}"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://huggingface.co/api/models", params=params, headers=headers
            )
            resp.raise_for_status()
            raw_models = resp.json()
    except Exception as e:
        logger.warning(f"Error querying Hugging Face API: {e}")
        from app.catalog import CURATED_MODELS

        return {
            "models": [
                {
                    "id": m.id,
                    "name": m.name,
                    "repo": "Qwen/Qwen2.5-3B-Instruct-GGUF",
                    "file": f"{m.id}.gguf",
                    "downloads": 50000,
                    "likes": 1200,
                    "param_size": "3B",
                    "categories": ["General / Chat"],
                    "note": m.description,
                    "recommended_file": f"{m.id}.gguf",
                    "fits_hardware": True,
                    "tier_label": "FAST DEFAULT CORE",
                }
                for m in CURATED_MODELS
            ],
            "cached": False,
        }

    hw = model_manager.get_hardware()
    models_out: list[dict[str, Any]] = []

    for item in raw_models:
        repo_id = item.get("id") or item.get("modelId")
        if not repo_id:
            continue

        tags = item.get("tags", [])
        downloads = item.get("downloads", 0)
        likes = item.get("likes", 0)
        param_size = _extract_param_size(repo_id, tags)
        categories = _classify_model(repo_id, tags)

        fits_hardware = True
        tier_label = "⚡ GPU Offload"
        if param_size:
            try:
                num = float(param_size.rstrip("B"))
                if not hw.gpu:
                    if num <= 8.0:
                        tier_label = "⚡ CPU"
                    elif num <= 32.0:
                        tier_label = "⚡ CPU RAM"
                    elif num <= 72.0:
                        tier_label = "🧠 Multi-Tier CPU"
                    else:
                        fits_hardware = False
                        tier_label = "⚠ Giant Model"
                else:
                    if num <= 14.0:
                        tier_label = "⚡ GPU Offload"
                    elif num <= 35.0:
                        tier_label = "⚡ Hybrid GPU+RAM"
                    elif num <= 72.0:
                        tier_label = "🧠 Multi-Tier SOTA"
                    else:
                        fits_hardware = False
                        tier_label = "⚠ Giant Model (>72B)"
            except Exception:
                pass

        clean_repo_name = repo_id.split("/")[-1]
        default_file = f"{clean_repo_name.lower()}-q4_k_m.gguf"
        if "gguf" in clean_repo_name.lower():
            default_file = f"{clean_repo_name.lower().replace('-gguf', '')}-q4_k_m.gguf"

        models_out.append(
            {
                "id": repo_id,
                "name": clean_repo_name,
                "repo": repo_id,
                "downloads": downloads,
                "likes": likes,
                "param_size": param_size or "GGUF",
                "categories": categories,
                "recommended_file": default_file,
                "fits_hardware": fits_hardware,
                "tier_label": tier_label,
            }
        )

    _EXPLORE_CACHE[cache_key] = (now, models_out)
    return {"models": models_out, "cached": False}


@router.get("/tree")
@router.get("/tree/")
async def get_model_tree(repo: str = Query(..., description="Hugging Face repo ID")):
    """Get list of .gguf files available in a Hugging Face repository."""
    headers = {"User-Agent": "EdgeRunner/0.1.0"}
    if settings.hf_token:
        headers["Authorization"] = f"Bearer {settings.hf_token}"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"https://huggingface.co/api/models/{repo}/tree/main", headers=headers
            )
            resp.raise_for_status()
            files = resp.json()

        gguf_files = []
        for f in files:
            path = f.get("path", "")
            if path.endswith(".gguf"):
                size_bytes = f.get("size", 0)
                size_mb = round(size_bytes / (1024 * 1024), 1)
                size_gb = round(size_bytes / (1024**3), 2)
                gguf_files.append(
                    {
                        "path": path,
                        "size_bytes": size_bytes,
                        "size_mb": size_mb,
                        "size_gb": size_gb,
                        "recommended": "q4_k_m" in path.lower()
                        or "q4_0" in path.lower(),
                    }
                )

        # Sort so recommended and standard Q4/Q5 files come first
        gguf_files.sort(key=lambda x: (not x["recommended"], x["size_bytes"]))
        return {"repo": repo, "files": gguf_files}
    except Exception as e:
        logger.error(f"Failed to fetch files for repo {repo}: {e}")
        raise HTTPException(
            status_code=502, detail=f"Failed to fetch model tree from Hugging Face: {e}"
        )
