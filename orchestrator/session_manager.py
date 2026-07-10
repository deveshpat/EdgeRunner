"""In-memory session tracking + background log scraping for tunnel URLs."""

from __future__ import annotations

import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional

from kaggle_client import (
    KaggleCredentials,
    kernel_logs,
    kernel_logs_live,
    kernel_status,
    push_kernel,
)
from packer import write_kernel_bundle


URL_RE = re.compile(
    r"(?:EDGERUNNER_URL|KAGGLE_PILOT_URL)=((?:https?://)[^\s]+)|"
    r"(https://[a-zA-Z0-9-]+\.trycloudflare\.com)|"
    r"(https://[a-zA-Z0-9-]+\.loca\.lt)|"
    r"(https://[a-zA-Z0-9-]+\.localtunnel\.me)|"
    r"(https?://bore\.pub:\d+)"
)




def _sanitize_text(s: str, limit: int = 8000) -> str:
    """Strip lone surrogates / control noise so JSON responses stay valid."""
    if not s:
        return ""
    cleaned = s.encode("utf-8", errors="replace").decode("utf-8", errors="replace")
    # Drop C0 controls except tab/newline
    cleaned = "".join(
        ch if (ch in "\n\t\r" or ord(ch) >= 32) else " " for ch in cleaned
    )
    return cleaned[-limit:]


def normalize_kernel_logs(raw: str) -> str:
    """Kaggle often returns a JSON-ish list of {stream_name,time,data} events."""
    if not raw:
        return ""
    text = raw.strip()
    # Try to parse as JSON list of log events
    try:
        import json

        # Kaggle sometimes returns a Python-repr-ish list; normalize trailing commas
        candidate = text
        if candidate.startswith("["):
            # Fix common non-strict forms: `}\n,{` is fine for json; `\n,` after `}` ok
            data = json.loads(candidate)
            if isinstance(data, list):
                lines = []
                for ev in data:
                    if isinstance(ev, dict) and "data" in ev:
                        stream = ev.get("stream_name", "")
                        prefix = "ERR " if stream == "stderr" else ""
                        lines.append(prefix + str(ev.get("data", "")).rstrip("\n"))
                    else:
                        lines.append(str(ev))
                return "\n".join(lines)
    except Exception:
        pass
    return text



class SessionState(str, Enum):
    PENDING = "pending"
    PUSHING = "pushing"
    PROVISIONING = "provisioning"  # kernel running, waiting for URL
    ONLINE = "online"
    FAILED = "failed"
    STOPPED = "stopped"


@dataclass
class Session:
    id: str
    username: str
    kernel_ref: str
    accelerator: str
    state: SessionState = SessionState.PENDING
    public_url: Optional[str] = None
    error: Optional[str] = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    kernel_status: Optional[str] = None
    logs_tail: str = ""
    idle_timeout: int = 90
    max_lifetime: int = 3600
    # credentials kept only in memory for this process lifetime
    _creds: Optional[KaggleCredentials] = field(default=None, repr=False)

    def touch(self) -> None:
        self.updated_at = time.time()

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "username": self.username,
            "kernel_ref": self.kernel_ref,
            "accelerator": self.accelerator,
            "state": self.state.value,
            "public_url": self.public_url,
            "error": _sanitize_text(self.error or "", 500) or None,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "kernel_status": _sanitize_text(self.kernel_status or "", 500) or None,
            "logs_tail": _sanitize_text(self.logs_tail, 4000),
            "idle_timeout": self.idle_timeout,
            "max_lifetime": self.max_lifetime,
            "age_seconds": round(time.time() - self.created_at, 1),
        }



class SessionManager:
    def __init__(self, work_root: Path):
        self.work_root = work_root
        self.work_root.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def get(self, session_id: str) -> Optional[Session]:
        with self._lock:
            return self._sessions.get(session_id)

    def list_sessions(self) -> list[dict[str, Any]]:
        with self._lock:
            return [s.to_public() for s in self._sessions.values()]

    def start(
        self,
        creds: KaggleCredentials,
        accelerator: str = "cpu",
        idle_timeout: int = 90,
        max_lifetime: int = 3600,
        startup_grace: int = 600,
        session_timeout_seconds: Optional[int] = None,
    ) -> Session:
        session_id = uuid.uuid4().hex
        slug = f"edgerunner-{session_id[:8]}"
        kernel_ref = f"{creds.username}/{slug}"

        session = Session(
            id=session_id,
            username=creds.username,
            kernel_ref=kernel_ref,
            accelerator=accelerator,
            idle_timeout=idle_timeout,
            max_lifetime=max_lifetime,
            _creds=creds,
        )
        with self._lock:
            self._sessions[session_id] = session

        t = threading.Thread(
            target=self._provision,
            kwargs=dict(
                session=session,
                creds=creds,
                accelerator=accelerator,
                idle_timeout=idle_timeout,
                max_lifetime=max_lifetime,
                startup_grace=startup_grace,
                session_timeout_seconds=session_timeout_seconds or max_lifetime,
            ),
            daemon=True,
        )
        t.start()
        return session

    def _provision(
        self,
        session: Session,
        creds: KaggleCredentials,
        accelerator: str,
        idle_timeout: int,
        max_lifetime: int,
        startup_grace: int,
        session_timeout_seconds: int,
    ) -> None:
        try:
            session.state = SessionState.PUSHING
            session.touch()

            out_dir = self.work_root / session.id
            write_kernel_bundle(
                out_dir=out_dir,
                username=creds.username,
                session_id=session.id,
                accelerator=accelerator,
                idle_timeout=idle_timeout,
                max_lifetime=max_lifetime,
                startup_grace=startup_grace,
                kernel_slug=session.kernel_ref.split("/", 1)[1],
            )

            # Prefer enable_gpu via metadata; accelerator flag for newer CLI
            acc_flag = None
            if accelerator.lower() in ("gpu", "nvidia"):
                acc_flag = None  # metadata enable_gpu is enough; shapes vary by account

            result = push_kernel(
                creds,
                out_dir,
                timeout_seconds=session_timeout_seconds,
                accelerator=acc_flag,
            )
            session.logs_tail += f"\npush_result={result!r}\n"
            session.state = SessionState.PROVISIONING
            session.touch()

            self._poll_until_url(session, creds)
        except Exception as e:
            session.state = SessionState.FAILED
            session.error = str(e)
            session.touch()

    def _poll_until_url(
        self,
        session: Session,
        creds: KaggleCredentials,
        timeout: float = 900.0,
        interval: float = 8.0,
    ) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if session.state in (SessionState.STOPPED, SessionState.FAILED):
                return
            try:
                status = kernel_status(creds, session.kernel_ref)
                session.kernel_status = str(
                    status.get("status")
                    or status.get("failureMessage")
                    or status.get("repr")
                    or status
                )
            except Exception as e:
                session.kernel_status = f"status_error: {e}"

            try:
                # While RUNNING, persisted logs are often empty — use live stream.
                logs_raw = ""
                try:
                    logs_raw = kernel_logs_live(creds, session.kernel_ref, max_events=800)
                except Exception:
                    logs_raw = kernel_logs(creds, session.kernel_ref) or ""
                if not logs_raw:
                    logs_raw = kernel_logs(creds, session.kernel_ref) or ""
                if logs_raw:
                    logs = normalize_kernel_logs(logs_raw)
                    session.logs_tail = logs[-8000:]
                    url = self._extract_url(logs) or self._extract_url(logs_raw)
                    if url:
                        session.public_url = url.rstrip(")'\".,;")
                        session.state = SessionState.ONLINE
                        session.touch()
                        return
            except Exception as e:
                session.logs_tail += f"\nlogs_error: {e}\n"


            # Detect hard failures
            ks = (session.kernel_status or "").lower()
            if any(x in ks for x in ("error", "failed", "cancelled", "complete")):
                # "complete" without URL means worker exited before publishing
                if "complete" in ks and not session.public_url:
                    session.state = SessionState.FAILED
                    session.error = (
                        f"Kernel finished without publishing a URL. "
                        f"status={session.kernel_status}"
                    )
                    session.touch()
                    return
                if any(x in ks for x in ("error", "failed", "cancelled")):
                    # Include last log lines so the UI shows the real traceback
                    tail = (session.logs_tail or "")[-500:]
                    session.state = SessionState.FAILED
                    session.error = f"{session.kernel_status}: {tail}" if tail else session.kernel_status
                    session.touch()
                    return


            session.touch()
            time.sleep(interval)

        session.state = SessionState.FAILED
        session.error = "Timed out waiting for public tunnel URL in Kaggle logs"
        session.touch()

    @staticmethod
    def _extract_url(logs: str) -> Optional[str]:
        for line in logs.splitlines():
            m = URL_RE.search(line)
            if m:
                return next(g for g in m.groups() if g)
        m = URL_RE.search(logs)
        if m:
            return next(g for g in m.groups() if g)
        return None

    def mark_stopped(self, session_id: str, reason: str = "user") -> Optional[Session]:
        session = self.get(session_id)
        if not session:
            return None
        session.state = SessionState.STOPPED
        session.error = reason
        session.touch()
        return session

    def refresh(self, session_id: str) -> Optional[Session]:
        session = self.get(session_id)
        if not session or not session._creds:
            return session
        try:
            status = kernel_status(session._creds, session.kernel_ref)
            session.kernel_status = str(status.get("status") or status)
            logs_raw = ""
            try:
                logs_raw = kernel_logs_live(
                    session._creds, session.kernel_ref, max_events=400
                )
            except Exception:
                logs_raw = kernel_logs(session._creds, session.kernel_ref) or ""
            if logs_raw:
                logs = normalize_kernel_logs(logs_raw)
                session.logs_tail = logs[-8000:]
                if not session.public_url:
                    url = self._extract_url(logs) or self._extract_url(logs_raw)
                    if url:
                        session.public_url = url.rstrip(")'\".,;")
                        session.state = SessionState.ONLINE
            session.touch()


        except Exception as e:
            session.logs_tail += f"\nrefresh_error: {e}\n"
        return session
