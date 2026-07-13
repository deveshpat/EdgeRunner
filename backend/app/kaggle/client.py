"""Thin wrapper around the official Kaggle API, scoped to per-request creds.

The `kaggle` package authenticates from KAGGLE_USERNAME / KAGGLE_KEY env vars,
so each call temporarily sets them for the given credentials. Credentials are
held only in memory by the controller and never written to disk.
"""

from __future__ import annotations

import os
import re
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Generator, Optional

# Tunnel URL patterns the worker prints to its logs.
URL_RE = re.compile(
    r"(?:EDGERUNNER_URL=)(https?://[^\s]+)"
    r"|(https://[a-z0-9-]+\.trycloudflare\.com)"
    r"|(https://[a-z0-9-]+\.loca\.lt)"
)


class KaggleError(RuntimeError):
    """Raised for auth / API failures, with a user-facing message."""


@dataclass
class KaggleCredentials:
    username: str
    key: str

    def validate(self) -> None:
        if not self.username or not self.username.strip():
            raise ValueError("Kaggle username is required")
        if not self.key or not self.key.strip():
            raise ValueError("Kaggle API key is required")


def extract_url(text: str) -> Optional[str]:
    """Return the first tunnel URL found in worker logs, if any."""
    if not text:
        return None
    m = URL_RE.search(text)
    if not m:
        return None
    url = next(g for g in m.groups() if g)
    return url.rstrip(")'\".,;")


@contextmanager
def _kaggle_env(creds: KaggleCredentials) -> Generator[None, None, None]:
    prev = {k: os.environ.get(k) for k in ("KAGGLE_USERNAME", "KAGGLE_KEY")}
    try:
        os.environ["KAGGLE_USERNAME"] = creds.username.strip()
        os.environ["KAGGLE_KEY"] = creds.key.strip()
        yield
    finally:
        for k, v in prev.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _api(creds: KaggleCredentials):
    """Authenticate and return a KaggleApi instance (lazy import)."""
    creds.validate()
    with _kaggle_env(creds):
        try:
            from kaggle.api.kaggle_api_extended import KaggleApi
        except Exception as exc:  # package missing / import error
            raise KaggleError(
                "The 'kaggle' package is not installed on the orchestrator. "
                "Install it with: pip install kaggle"
            ) from exc
        api = KaggleApi()
        try:
            api.authenticate()
        except Exception as exc:
            raise KaggleError(f"Kaggle authentication failed: {exc}") from exc
        return api


def validate_credentials(creds: KaggleCredentials) -> None:
    """Cheap auth check — raises KaggleError if the creds are bad."""
    _api(creds)


def push_kernel(creds: KaggleCredentials, folder: Path, accelerator: Optional[str]) -> dict:
    api = _api(creds)
    with _kaggle_env(creds):
        try:
            result = api.kernels_push(str(folder))
        except Exception as exc:
            raise KaggleError(f"Failed to push kernel: {exc}") from exc
    return _to_dict(result)


def kernel_status(creds: KaggleCredentials, kernel_ref: str) -> str:
    api = _api(creds)
    with _kaggle_env(creds):
        try:
            result = api.kernels_status(kernel_ref)
        except Exception as exc:
            raise KaggleError(f"Failed to get kernel status: {exc}") from exc
    d = _to_dict(result)
    return str(d.get("status") or d.get("failureMessage") or d)


def kernel_logs(creds: KaggleCredentials, kernel_ref: str) -> str:
    """Best-effort log fetch. Live-streaming APIs vary by kaggle version."""
    api = _api(creds)
    with _kaggle_env(creds):
        for meth in ("kernels_output", "kernels_logs"):
            fn = getattr(api, meth, None)
            if not fn:
                continue
            try:
                out = fn(kernel_ref)
                return _normalize_logs(out)
            except Exception:
                continue
    return ""


def _normalize_logs(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    if isinstance(raw, (list, tuple)):
        parts: list[str] = []
        for ev in raw:
            if isinstance(ev, dict) and "data" in ev:
                parts.append(str(ev["data"]))
            else:
                parts.append(str(ev))
        return "\n".join(parts)
    return str(raw)


def _to_dict(obj: Any) -> dict:
    if obj is None:
        return {}
    if isinstance(obj, dict):
        return obj
    # Kaggle response objects expose attributes; grab the simple ones.
    out: dict[str, Any] = {}
    for attr in dir(obj):
        if attr.startswith("_"):
            continue
        try:
            val = getattr(obj, attr)
        except Exception:
            continue
        if isinstance(val, (str, int, float, bool)) or val is None:
            out[attr] = val
    return out or {"repr": repr(obj)}
