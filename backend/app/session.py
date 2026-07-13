"""Session watchdog — the worker-side kill-switch.

Kaggle's public API cannot stop a running kernel, so the worker terminates
*itself*. It watches for client heartbeats and hard-exits when:
  - an explicit shutdown is requested (the orchestrator's "off" button), or
  - no heartbeat arrives for `idle_timeout` seconds (tab closed / network gone),
    after an initial `startup_grace` (model download can take a while), or
  - `max_lifetime` is exceeded (protects the GPU quota).

The watchdog runs on a daemon thread, not asyncio: synchronous llama.cpp
inference blocks the event loop, and the tab often closes mid-generation —
exactly when an asyncio-only watchdog would never fire.

Only enabled on the Kaggle worker (EDGERUNNER_WATCHDOG=1); it never runs on the
local orchestrator, which must not self-terminate.
"""

from __future__ import annotations

import os
import sys
import threading
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
    idle_timeout: float = field(
        default_factory=lambda: _env_float("EDGERUNNER_IDLE_TIMEOUT", 120.0)
    )
    max_lifetime: float = field(
        default_factory=lambda: _env_float("EDGERUNNER_MAX_LIFETIME", 3600.0)
    )
    startup_grace: float = field(
        default_factory=lambda: _env_float("EDGERUNNER_STARTUP_GRACE", 600.0)
    )
    check_interval: float = 3.0

    started_at: float = field(default_factory=time.time)
    last_heartbeat_at: Optional[float] = None
    shutdown_requested: bool = False
    shutdown_reason: str = ""

    _thread: Optional[threading.Thread] = field(default=None, repr=False)
    _stop: threading.Event = field(default_factory=threading.Event, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    # --- client-facing operations ------------------------------------------

    def heartbeat(self) -> dict:
        with self._lock:
            self.last_heartbeat_at = time.time()
        return self.status()

    def request_shutdown(self, reason: str = "client_requested") -> dict:
        with self._lock:
            self.shutdown_requested = True
            self.shutdown_reason = reason
        status = self.status()
        # Exit on a short delay so the HTTP response can flush first.
        self._force_exit_soon(reason, delay=0.15)
        return status

    # --- decision logic (pure, unit-tested) --------------------------------

    def due_reason(self, now: Optional[float] = None) -> Optional[str]:
        """Return why the worker should exit now, or None to keep running."""
        now = time.time() if now is None else now
        with self._lock:
            if self.shutdown_requested:
                return self.shutdown_reason or "client_requested"
            if now - self.started_at > self.max_lifetime:
                return "max_lifetime_exceeded"
            grace_over = now - self.started_at > self.startup_grace
            if self.last_heartbeat_at is None:
                # Never heard from a client — die once grace elapses so an
                # orphaned kernel (no tab ever attached) doesn't linger.
                return "no_heartbeat" if grace_over else None
            if now - self.last_heartbeat_at > self.idle_timeout:
                return "idle_timeout"
            return None

    def status(self) -> dict:
        with self._lock:
            now = time.time()
            since_hb = (
                None
                if self.last_heartbeat_at is None
                else round(now - self.last_heartbeat_at, 1)
            )
            return {
                "uptime_seconds": round(now - self.started_at, 1),
                "seconds_since_heartbeat": since_hb,
                "idle_timeout": self.idle_timeout,
                "max_lifetime": self.max_lifetime,
                "startup_grace": self.startup_grace,
                "shutdown_requested": self.shutdown_requested,
            }

    # --- thread / exit -----------------------------------------------------

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._run, name="edgerunner-watchdog", daemon=True
        )
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(self.check_interval):
            reason = self.due_reason()
            if reason:
                self._force_exit_soon(reason, delay=0.0)
                return

    def _force_exit_soon(self, reason: str, delay: float = 0.15) -> None:
        def _die() -> None:
            if delay:
                time.sleep(delay)
            print(f"\nEdgeRunner worker exiting: {reason}", flush=True)
            sys.stdout.flush()
            sys.stderr.flush()
            # Hard exit: Kaggle only frees the quota when the process dies.
            os._exit(0)

        threading.Thread(target=_die, name="edgerunner-exit", daemon=True).start()


# Module-level singleton used by the session router.
watchdog = SessionWatchdog()
