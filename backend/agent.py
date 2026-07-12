"""
EdgeRunner agent: model lifecycle + message routing.

Coding loop lives in `harness/` (SOTA-inspired plan→test→implement→sandbox→reflect).
"""

from __future__ import annotations

import gc
import threading
from typing import Optional

from harness.llm_bridge import register_llm_getter
from harness.pipeline import run_coding_harness, set_harness_progress  # noqa: E402
from harness.routing import (  # noqa: E402
    looks_like_coding_task,
    set_routing_progress,
    should_use_harness,
    simple_chat,
)

# Lazy-loaded LLM so FastAPI can boot and report /health before the model is ready.
_local_llm = None
_model_meta: dict = {"ready": False, "loading": False}
_load_lock = threading.Lock()


def is_model_ready() -> bool:
    return _local_llm is not None


def get_model_meta() -> dict:
    meta = dict(_model_meta)
    try:
        from model_manager import get_load_status

        st = get_load_status()
        meta.setdefault("loading", st.get("loading", False))
        if st.get("phase"):
            meta["phase"] = st["phase"]
        if st.get("detail"):
            meta["detail"] = st["detail"]
    except Exception:
        pass
    meta["ready"] = _local_llm is not None
    return meta


def _release_llama_cpp(obj) -> None:
    """Best-effort free of native llama.cpp weights (avoid OOM on switch)."""
    if obj is None:
        return
    try:
        client = getattr(obj, "client", None) or getattr(obj, "llm", None)
        if client is not None:
            close = getattr(client, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
            for attr in ("model", "_model", "ctx", "_ctx"):
                if hasattr(client, attr):
                    try:
                        setattr(client, attr, None)
                    except Exception:
                        pass
            del client
    except Exception:
        pass
    try:
        del obj
    except Exception:
        pass


def unload_model(reason: str = "switch") -> dict:
    """Drop the in-RAM model and force GC so a new load won't OOM."""
    global _local_llm, _model_meta
    with _load_lock:
        print(f"♻️ Unloading model ({reason})…", flush=True)
        old = _local_llm
        _local_llm = None
        _release_llama_cpp(old)
        for _ in range(3):
            gc.collect()
        try:
            import ctypes

            libc = ctypes.CDLL("libc.so.6")
            libc.malloc_trim(0)
        except Exception:
            pass
        _model_meta = {
            "ready": False,
            "loading": False,
            "phase": "unloaded",
            "detail": reason,
        }
        try:
            from model_manager import _set_status

            _set_status("unloaded", reason, loading=False)
        except Exception:
            pass
        print("♻️ Model unloaded + GC", flush=True)
        return dict(_model_meta)


def load_model(
    repo_id: Optional[str] = None,
    filename: Optional[str] = None,
    *,
    force_reload: bool = False,
) -> dict:
    """Download / load a GGUF. Thread-safe. force_reload unloads first."""
    global _local_llm, _model_meta

    with _load_lock:
        if _local_llm is not None and not force_reload and not (repo_id and filename):
            return _model_meta

        if _local_llm is not None and (force_reload or (repo_id and filename)):
            old = _local_llm
            _local_llm = None
            _release_llama_cpp(old)
            for _ in range(3):
                gc.collect()
            try:
                import ctypes

                ctypes.CDLL("libc.so.6").malloc_trim(0)
            except Exception:
                pass

        from langchain_community.chat_models import ChatLlamaCpp
        from model_manager import get_or_download_model, _set_status

        _model_meta = {"ready": False, "loading": True, "phase": "download"}
        try:
            model_config = get_or_download_model(repo_id=repo_id, filename=filename)
            print("\nLoading model into memory...", flush=True)
            _set_status("load", f"Loading {model_config.get('name', '')} into RAM…")
            n_ctx = int(model_config.get("n_ctx") or 4096)
            _local_llm = ChatLlamaCpp(
                model_path=model_config["path"],
                temperature=0.2,
                n_ctx=n_ctx,
                max_tokens=1500,
                n_gpu_layers=-1,
                verbose=False,
            )
            _model_meta = {
                "name": model_config.get("name", "local"),
                "path": model_config["path"],
                "n_ctx": n_ctx,
                "repo_id": model_config.get("repo_id"),
                "filename": model_config.get("filename"),
                "ready": True,
                "loading": False,
                "phase": "ready",
            }
            _set_status("ready", _model_meta["name"], loading=False)
            print("✅ SOTA Engine Loaded!", flush=True)
            try:
                import os
                from llama_cpp import llama_supports_gpu_offload

                gpu_ok = bool(llama_supports_gpu_offload())
                accel = os.environ.get("KP_ACCELERATOR", "cpu")
                _model_meta["gpu_offload"] = gpu_ok
                print(f"llama.cpp gpu_offload={gpu_ok} accel={accel}", flush=True)
                if not gpu_ok and accel != "cpu":
                    print(
                        "⚠️ GPU session but this llama.cpp wheel has no CUDA — "
                        "inference will run on CPU and be very slow.",
                        flush=True,
                    )
            except Exception:
                pass
        except Exception as e:
            _local_llm = None
            _model_meta = {
                "ready": False,
                "loading": False,
                "phase": "error",
                "error": str(e),
            }
            _set_status("error", str(e), loading=False)
            for _ in range(3):
                gc.collect()
            raise
        return _model_meta


def switch_model(repo_id: str, filename: str) -> dict:
    """Unload current model (GC) then load the chosen GGUF."""
    return load_model(repo_id=repo_id, filename=filename, force_reload=True)


def _llm():
    if _local_llm is None:
        load_model()
    return _local_llm


# Register for harness modules
register_llm_getter(_llm)


# Optional progress callback set by /chat for streaming keepalives.
_progress_cb = None


def set_progress_callback(cb) -> None:
    """cb(message: str) — called from worker threads during long runs."""
    global _progress_cb
    _progress_cb = cb
    set_harness_progress(cb)
    set_routing_progress(cb)


def run_user_message(
    user_text: str, history: Optional[list] = None, force_harness: bool = False
) -> dict:
    """Route casual chat vs coding harness (history-aware for 'continue…')."""
    use, task = should_use_harness(user_text, history=history, force=force_harness)
    if use:
        return run_coding_harness(task)
    return simple_chat(user_text, history=history)


# Re-exports for tests / external callers
__all__ = [
    "is_model_ready",
    "get_model_meta",
    "load_model",
    "unload_model",
    "switch_model",
    "set_progress_callback",
    "run_user_message",
    "run_coding_harness",
    "looks_like_coding_task",
    "simple_chat",
]
