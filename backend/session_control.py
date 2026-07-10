"""Session lifecycle control for Kaggle-hosted workers.

Self-terminates the process when:
  - client stops sending heartbeats (tab closed / network drop)
  - explicit /session/shutdown is called
  - max session lifetime is exceeded (protects GPU quota)
"""

from __future__ import annotations

import asyncio
import os
import signal
import sys
import time
from dataclasses import dataclass, field
from typing import Optional


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


@dataclass
class SessionWatchdog:
    """Tracks client heartbeats and enforces idle / max lifetime limits."""

    # Grace period after boot before idle timeout applies (model download etc.)
    startup_grace_seconds: float = field(
        default_factory=lambda: _env_float("KP_STARTUP_GRACE_SECONDS", 600.0)
    )
    # Kill if no heartbeat for this long once the first heartbeat arrived
    # (or after startup grace if never heartbeated).
    idle_timeout_seconds: float = field(
        default_factory=lambda: _env_float("KP_IDLE_TIMEOUT_SECONDS", 90.0)
    )
    # Hard cap on session length (seconds). 0 = disabled.
    max_lifetime_seconds: float = field(
        default_factory=lambda: _env_float("KP_MAX_LIFETIME_SECONDS", 3600.0)
    )
    check_interval_seconds: float = 5.0

    started_at: float = field(default_factory=time.time)
    last_heartbeat_at: Optional[float] = None
    first_heartbeat_at: Optional[float] = None
    shutdown_requested: bool = False
    shutdown_reason: str = ""
    _task: Optional[asyncio.Task] = None

    def heartbeat(self) -> dict:
        now = time.time()
        self.last_heartbeat_at = now
        if self.first_heartbeat_at is None:
            self.first_heartbeat_at = now
        return self.status()

    def request_shutdown(self, reason: str = "client_requested") -> dict:
        self.shutdown_requested = True
        self.shutdown_reason = reason
        return self.status()

    def status(self) -> dict:
        now = time.time()
        age = now - self.started_at
        since_hb = None if self.last_heartbeat_at is None else now - self.last_heartbeat_at
        return {
            "started_at": self.started_at,
            "uptime_seconds": round(age, 1),
            "last_heartbeat_at": self.last_heartbeat_at,
            "seconds_since_heartbeat": None if since_hb is None else round(since_hb, 1),
            "first_heartbeat_at": self.first_heartbeat_at,
            "idle_timeout_seconds": self.idle_timeout_seconds,
            "startup_grace_seconds": self.startup_grace_seconds,
            "max_lifetime_seconds": self.max_lifetime_seconds,
            "shutdown_requested": self.shutdown_requested,
            "shutdown_reason": self.shutdown_reason,
        }

    def should_die(self) -> Optional[str]:
        if self.shutdown_requested:
            return self.shutdown_reason or "client_requested"

        now = time.time()
        age = now - self.started_at

        if self.max_lifetime_seconds > 0 and age >= self.max_lifetime_seconds:
            return "max_lifetime_exceeded"

        # Before first heartbeat: only enforce after startup grace
        if self.first_heartbeat_at is None:
            if age >= self.startup_grace_seconds:
                return "no_client_connected"
            return None

        # After first heartbeat: enforce idle timeout
        assert self.last_heartbeat_at is not None
        if (now - self.last_heartbeat_at) >= self.idle_timeout_seconds:
            return "idle_timeout"

        return None

    async def run(self) -> None:
        while True:
            reason = self.should_die()
            if reason:
                self.shutdown_reason = reason
                print(f"\nEdgeRunner session shutting down: {reason}", flush=True)
                # Flush logs then hard-exit so the Kaggle kernel ends immediately
                # (frees CPU/GPU quota).
                sys.stdout.flush()
                sys.stderr.flush()
                os._exit(0)
            await asyncio.sleep(self.check_interval_seconds)

    def start_background(self) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        if self._task is None or self._task.done():
            self._task = loop.create_task(self.run())


# Process-wide singleton used by the FastAPI app
watchdog = SessionWatchdog()
