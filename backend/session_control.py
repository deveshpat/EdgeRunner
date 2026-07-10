"""Session lifecycle control for Kaggle-hosted workers.

Self-terminates the process when:
  - client stops sending heartbeats (tab closed / network drop)
  - explicit /session/shutdown is called
  - max session lifetime is exceeded (protects GPU quota)

IMPORTANT: Watchdog runs on a **daemon thread** (not only asyncio).
Sync LLM inference blocks the event loop; an asyncio-only watchdog
would never fire while a long /chat is running — which is exactly when
users often close the tab.
"""

from __future__ import annotations

import os
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


def _heartbeat_path() -> Path:
    raw = os.environ.get("KP_HEARTBEAT_FILE", "").strip()
    if raw:
        return Path(raw)
    # Default under work dir when on Kaggle, else /tmp
    base = Path(os.environ.get("KP_WORK_DIR", "/tmp/edgerunner"))
    base.mkdir(parents=True, exist_ok=True)
    return base / ".heartbeat"


@dataclass
class SessionWatchdog:
    """Tracks client heartbeats and enforces idle / max lifetime limits."""

    startup_grace_seconds: float = field(
        default_factory=lambda: _env_float("KP_STARTUP_GRACE_SECONDS", 600.0)
    )
    idle_timeout_seconds: float = field(
        default_factory=lambda: _env_float("KP_IDLE_TIMEOUT_SECONDS", 90.0)
    )
    max_lifetime_seconds: float = field(
        default_factory=lambda: _env_float("KP_MAX_LIFETIME_SECONDS", 3600.0)
    )
    check_interval_seconds: float = 3.0

    started_at: float = field(default_factory=time.time)
    last_heartbeat_at: Optional[float] = None
    first_heartbeat_at: Optional[float] = None
    shutdown_requested: bool = False
    shutdown_reason: str = ""
    _thread: Optional[threading.Thread] = None
    _stop: threading.Event = field(default_factory=threading.Event)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _exit_scheduled: bool = False

    def _touch_heartbeat_file(self) -> None:
        """Parent bootstrap watches this file so it can kill even if uvicorn hangs."""
        try:
            path = _heartbeat_path()
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(str(time.time()), encoding="utf-8")
        except Exception:
            pass

    def heartbeat(self) -> dict:
        with self._lock:
            now = time.time()
            self.last_heartbeat_at = now
            if self.first_heartbeat_at is None:
                self.first_heartbeat_at = now
        self._touch_heartbeat_file()
        return self.status()

    def request_shutdown(self, reason: str = "client_requested") -> dict:
        """Mark shutdown and hard-exit ASAP (does not wait for asyncio)."""
        with self._lock:
            self.shutdown_requested = True
            self.shutdown_reason = reason
        status = self.status()
        # Immediate hard kill on a short timer so HTTP response can flush
        self.force_exit_soon(reason, delay=0.15)
        return status

    def force_exit_soon(self, reason: str, delay: float = 0.15) -> None:
        with self._lock:
            if self._exit_scheduled:
                return
            self._exit_scheduled = True
            self.shutdown_reason = reason
            self.shutdown_requested = True

        def _die() -> None:
            time.sleep(max(0.0, delay))
            print(f"\nEdgeRunner session shutting down: {reason}", flush=True)
            sys.stdout.flush()
            sys.stderr.flush()
            # Hard exit: Kaggle only frees quota when the kernel process dies.
            # os._exit skips graceful cleanup on purpose.
            os._exit(0)

        threading.Thread(target=_die, name="edgerunner-force-exit", daemon=True).start()

    def status(self) -> dict:
        with self._lock:
            now = time.time()
            age = now - self.started_at
            since_hb = (
                None
                if self.last_heartbeat_at is None
                else now - self.last_heartbeat_at
            )
            return {
                "started_at": self.started_at,
                "uptime_seconds": round(age, 1),
                "last_heartbeat_at": self.last_heartbeat_at,
                "seconds_since_heartbeat": None
                if since_hb is None
                else round(since_hb, 1),
                "first_heartbeat_at": self.first_heartbeat_at,
                "idle_timeout_seconds": self.idle_timeout_seconds,
                "startup_grace_seconds": self.startup_grace_seconds,
                "max_lifetime_seconds": self.max_lifetime_seconds,
                "shutdown_requested": self.shutdown_requested,
                "shutdown_reason": self.shutdown_reason,
            }

    def should_die(self) -> Optional[str]:
        with self._lock:
            if self.shutdown_requested:
                return self.shutdown_reason or "client_requested"

            now = time.time()
            age = now - self.started_at

            if self.max_lifetime_seconds > 0 and age >= self.max_lifetime_seconds:
                return "max_lifetime_exceeded"

            if self.first_heartbeat_at is None:
                if age >= self.startup_grace_seconds:
                    return "no_client_connected"
                return None

            assert self.last_heartbeat_at is not None
            if (now - self.last_heartbeat_at) >= self.idle_timeout_seconds:
                return "idle_timeout"

            return None

    def _thread_loop(self) -> None:
        # Seed file so parent bootstrap knows worker is alive during boot
        self._touch_heartbeat_file()
        while not self._stop.is_set():
            reason = self.should_die()
            if reason:
                self.force_exit_soon(reason, delay=0.0)
                return
            self._stop.wait(self.check_interval_seconds)

    def start_background(self) -> None:
        """Start the thread watchdog (safe to call multiple times)."""
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._thread_loop,
            name="edgerunner-watchdog",
            daemon=True,
        )
        self._thread.start()
        print(
            f"Watchdog started | idle={self.idle_timeout_seconds}s "
            f"grace={self.startup_grace_seconds}s max={self.max_lifetime_seconds}s",
            flush=True,
        )


# Process-wide singleton used by the FastAPI app
watchdog = SessionWatchdog()
