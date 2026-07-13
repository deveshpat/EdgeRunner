"""Tests for the worker kill-switch decision logic."""

from __future__ import annotations

from app.session import SessionWatchdog


def _wd(**kw) -> SessionWatchdog:
    return SessionWatchdog(
        idle_timeout=100, max_lifetime=1000, startup_grace=300, **kw
    )


def test_within_startup_grace_no_heartbeat_keeps_running():
    wd = _wd()
    wd.started_at = 0.0
    assert wd.due_reason(now=200) is None  # 200 < grace(300)


def test_no_heartbeat_past_grace_exits():
    wd = _wd()
    wd.started_at = 0.0
    assert wd.due_reason(now=400) == "no_heartbeat"  # past grace, never pinged


def test_recent_heartbeat_keeps_running():
    wd = _wd()
    wd.started_at = 0.0
    wd.last_heartbeat_at = 390.0
    assert wd.due_reason(now=400) is None  # 10s since hb < idle(100)


def test_stale_heartbeat_triggers_idle_timeout():
    wd = _wd()
    wd.started_at = 0.0
    wd.last_heartbeat_at = 250.0
    assert wd.due_reason(now=400) == "idle_timeout"  # 150s since hb > idle(100)


def test_max_lifetime_exceeded():
    wd = _wd()
    wd.started_at = 0.0
    wd.last_heartbeat_at = 1050.0  # recent
    assert wd.due_reason(now=1100) == "max_lifetime_exceeded"


def test_explicit_shutdown_wins():
    wd = _wd()
    wd.started_at = 0.0
    wd.last_heartbeat_at = 1099.0
    wd.shutdown_requested = True
    wd.shutdown_reason = "client_requested"
    assert wd.due_reason(now=1100) == "client_requested"


def test_heartbeat_updates_status():
    wd = _wd()
    status = wd.heartbeat()
    assert status["seconds_since_heartbeat"] is not None
