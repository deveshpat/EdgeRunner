"""In-memory Kaggle session controller (orchestrator side).

Holds the user's credentials for this process only, launches the worker kernel
in the background, scrapes its logs for the tunnel URL, and stops it by asking
the worker to shut itself down (Kaggle has no stop-kernel API).
"""

from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Optional

import httpx

from app.kaggle import client
from app.kaggle.client import KaggleCredentials, KaggleError
from app.kaggle.packer import write_bundle

WORK_DIR = Path.home() / ".edgerunner" / "kernel"

# state: idle -> pushing -> provisioning -> online -> stopped/failed
DEFAULT_MODEL_REPO = "Qwen/Qwen2.5-3B-Instruct-GGUF"
DEFAULT_MODEL_FILE = "qwen2.5-3b-instruct-q4_k_m.gguf"


@dataclass
class SessionInfo:
    state: str = "idle"
    kernel_ref: Optional[str] = None
    public_url: Optional[str] = None
    error: Optional[str] = None
    logs_tail: str = ""
    accelerator: str = "cpu"
    started_at: Optional[float] = None
    updated_at: Optional[float] = None


class KaggleController:
    def __init__(self) -> None:
        self._creds: Optional[KaggleCredentials] = None
        self._session = SessionInfo()
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None

    # --- config ------------------------------------------------------------

    def configure(self, username: str, key: str) -> None:
        creds = KaggleCredentials(username=username, key=key)
        creds.validate()
        client.validate_credentials(creds)  # raises KaggleError on bad auth
        with self._lock:
            self._creds = creds

    @property
    def configured(self) -> bool:
        return self._creds is not None

    @property
    def username(self) -> Optional[str]:
        return self._creds.username if self._creds else None

    # --- lifecycle ---------------------------------------------------------

    def start(
        self,
        accelerator: str = "cpu",
        model_repo: str = DEFAULT_MODEL_REPO,
        model_file: str = DEFAULT_MODEL_FILE,
        idle_timeout: int = 120,
        max_lifetime: int = 3600,
    ) -> SessionInfo:
        with self._lock:
            if self._creds is None:
                raise KaggleError("Configure Kaggle credentials first.")
            if self._session.state in ("pushing", "provisioning", "online"):
                return self._session
            creds = self._creds
            self._session = SessionInfo(
                state="pushing",
                accelerator=accelerator,
                started_at=time.time(),
                updated_at=time.time(),
                kernel_ref=f"{creds.username}/edgerunner",
            )

        config = {
            "gpu": accelerator.lower() in ("gpu", "nvidia", "t4", "p100"),
            "cuda": "cu124",  # prebuilt-wheel CUDA tag for GPU sessions
            "model_repo": model_repo,
            "model_file": model_file,
            "idle_timeout": idle_timeout,
            "max_lifetime": max_lifetime,
            "startup_grace": 900,
        }
        self._thread = threading.Thread(
            target=self._provision, args=(creds, config), daemon=True
        )
        self._thread.start()
        return self.status()

    def _provision(self, creds: KaggleCredentials, config: dict) -> None:
        try:
            out_dir = WORK_DIR
            write_bundle(out_dir, creds.username, config)
            client.push_kernel(creds, out_dir, "gpu" if config["gpu"] else None)
            self._set(state="provisioning")
            self._poll_for_url(creds)
        except KaggleError as exc:
            self._set(state="failed", error=str(exc))
        except Exception as exc:  # unexpected — still surface it
            self._set(state="failed", error=f"{type(exc).__name__}: {exc}")

    def _poll_for_url(
        self, creds: KaggleCredentials, timeout: float = 900.0, interval: float = 8.0
    ) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self._lock:
                if self._session.state in ("stopped", "failed"):
                    return
                kernel_ref = self._session.kernel_ref or ""
            try:
                status = client.kernel_status(creds, kernel_ref)
                logs = client.kernel_logs(creds, kernel_ref)
            except KaggleError as exc:
                self._set(logs_tail=f"poll error: {exc}")
                time.sleep(interval)
                continue

            url = client.extract_url(logs)
            if logs:
                self._set(logs_tail=logs[-4000:])
            if url:
                self._set(state="online", public_url=url)
                return
            low = status.lower()
            if any(x in low for x in ("error", "failed", "cancel")):
                self._set(state="failed", error=f"kernel status: {status}")
                return
            time.sleep(interval)
        self._set(state="failed", error="Timed out waiting for tunnel URL.")

    def stop(self) -> SessionInfo:
        with self._lock:
            url = self._session.public_url
            state = self._session.state
        if state in ("idle", "stopped"):
            return self.status()
        # Ask the worker to self-terminate (best-effort); it also dies on idle.
        if url:
            try:
                httpx.post(f"{url.rstrip('/')}/api/session/shutdown", timeout=10)
            except Exception:
                pass
        self._set(state="stopped", public_url=None)
        return self.status()

    # --- helpers -----------------------------------------------------------

    def status(self) -> SessionInfo:
        with self._lock:
            # return a copy so callers can't mutate internal state
            return SessionInfo(**asdict(self._session))

    def _set(self, **fields) -> None:
        with self._lock:
            for k, v in fields.items():
                setattr(self._session, k, v)
            self._session.updated_at = time.time()


controller = KaggleController()
