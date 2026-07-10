"""Thin wrapper around the official Kaggle API using per-session credentials."""

from __future__ import annotations

import json
import os
import re
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Generator, Optional



@dataclass
class KaggleCredentials:
    username: str
    # Supports both legacy (username+key) and modern access tokens.
    key: Optional[str] = None
    api_token: Optional[str] = None

    def validate(self) -> None:
        if not self.username:
            raise ValueError("Kaggle username is required")
        if not self.key and not self.api_token:
            raise ValueError("Provide either Kaggle API key or API token")


@contextmanager
def kaggle_env(creds: KaggleCredentials) -> Generator[None, None, None]:
    """Temporarily set env vars so the kaggle package authenticates as this user."""
    creds.validate()
    old = {
        "KAGGLE_USERNAME": os.environ.get("KAGGLE_USERNAME"),
        "KAGGLE_KEY": os.environ.get("KAGGLE_KEY"),
        "KAGGLE_API_TOKEN": os.environ.get("KAGGLE_API_TOKEN"),
    }
    try:
        os.environ["KAGGLE_USERNAME"] = creds.username
        if creds.api_token:
            os.environ["KAGGLE_API_TOKEN"] = creds.api_token
            # Prefer token; clear key to avoid mixed auth
            os.environ.pop("KAGGLE_KEY", None)
        if creds.key:
            os.environ["KAGGLE_KEY"] = creds.key
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def get_api(creds: KaggleCredentials):
    with kaggle_env(creds):
        from kaggle.api.kaggle_api_extended import KaggleApi

        api = KaggleApi()
        api.authenticate()
        return api


def push_kernel(
    creds: KaggleCredentials,
    folder: Path,
    timeout_seconds: Optional[int] = None,
    accelerator: Optional[str] = None,
) -> dict[str, Any]:
    """Push + run a kernel. accelerator e.g. None, 'gpu', or machine shape string."""
    with kaggle_env(creds):
        from kaggle.api.kaggle_api_extended import KaggleApi

        api = KaggleApi()
        api.authenticate()
        timeout = str(timeout_seconds) if timeout_seconds else None
        # CLI uses --accelerator; pass through when provided
        result = api.kernels_push(str(folder), timeout=timeout, acc=accelerator)
        # ApiSaveKernelResponse -> dict-ish
        return _to_dict(result)


def kernel_status(creds: KaggleCredentials, kernel_ref: str) -> dict[str, Any]:
    with kaggle_env(creds):
        from kaggle.api.kaggle_api_extended import KaggleApi

        api = KaggleApi()
        api.authenticate()
        result = api.kernels_status(kernel_ref)
        return _to_dict(result)


def kernel_logs(creds: KaggleCredentials, kernel_ref: str) -> str:
    """Fetch persisted logs (often empty while session is still RUNNING)."""
    with kaggle_env(creds):
        from kaggle.api.kaggle_api_extended import KaggleApi

        api = KaggleApi()
        api.authenticate()
        return api.kernels_logs(kernel_ref) or ""


def kernel_logs_live(
    creds: KaggleCredentials,
    kernel_ref: str,
    max_events: int = 500,
    timeout_seconds: float = 30.0,
) -> str:
    """Pull live SSE log stream (works while status=RUNNING).

    Kaggle replays history then blocks for new lines. We collect in a thread
    and return after timeout_seconds (or earlier on URL / max_events).
    """
    import threading

    lines: list[str] = []
    errors: list[BaseException] = []
    stop = threading.Event()

    def _consume() -> None:
        try:
            with kaggle_env(creds):
                from kaggle.api.kaggle_api_extended import KaggleApi

                api = KaggleApi()
                api.authenticate()
                for i, ev in enumerate(api.kernels_logs_stream(kernel_ref)):
                    if stop.is_set():
                        break
                    if isinstance(ev, dict):
                        data = str(ev.get("data", ""))
                        stream = ev.get("stream_name", "")
                        prefix = "ERR " if stream == "stderr" else ""
                        lines.append(prefix + data.rstrip("\n"))
                    else:
                        lines.append(str(ev))
                    joined = "\n".join(lines)
                    if "KAGGLE_PILOT_URL=" in joined or "EDGERUNNER_URL=" in joined:
                        break

                    # Real tunnel hostnames only (not the "Requesting new quick Tunnel on trycloudflare.com" line)
                    if re.search(
                        r"https://[a-zA-Z0-9-]+\.trycloudflare\.com|"
                        r"https://[a-zA-Z0-9-]+\.loca\.lt|"
                        r"https?://bore\.pub:\d+",
                        joined,
                    ):
                        break
                    if i + 1 >= max_events:
                        break

        except BaseException as e:  # noqa: BLE001 — surface to caller via list
            errors.append(e)

    t = threading.Thread(target=_consume, daemon=True)
    t.start()
    t.join(timeout=timeout_seconds)
    stop.set()
    if not lines and errors:
        raise errors[0]
    if errors and lines:
        lines.append(f"[stream_error] {errors[0]}")
    return "\n".join(lines)




def delete_kernel(creds: KaggleCredentials, kernel_ref: str) -> None:
    """Best-effort cleanup. Does not stop a running session mid-flight."""
    with kaggle_env(creds):
        from kaggle.api.kaggle_api_extended import KaggleApi

        api = KaggleApi()
        api.authenticate()
        try:
            api.kernels_delete(kernel_ref, no_confirm=True)
        except TypeError:
            # older signatures
            api.kernels_delete(kernel_ref)
        except Exception:
            pass


def quota(creds: KaggleCredentials) -> Any:
    with kaggle_env(creds):
        from kaggle.api.kaggle_api_extended import KaggleApi

        api = KaggleApi()
        api.authenticate()
        if hasattr(api, "quota"):
            return api.quota()
        return None


def _to_dict(obj: Any) -> dict[str, Any]:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    for attr in ("to_dict", "to_str"):
        if hasattr(obj, attr):
            try:
                val = getattr(obj, attr)()
                if isinstance(val, dict):
                    return val
                if isinstance(val, str):
                    try:
                        return json.loads(val)
                    except Exception:
                        return {"raw": val}
            except Exception:
                pass
    out: dict[str, Any] = {}
    for k in dir(obj):
        if k.startswith("_"):
            continue
        try:
            v = getattr(obj, k)
        except Exception:
            continue
        if callable(v):
            continue
        out[k] = v
    return out or {"repr": repr(obj)}
