"""Tests for the Kaggle orchestrator (client/packer/controller/endpoints).

The live push/run against Kaggle can't be exercised here — those calls are
mocked. We cover credential validation, URL scraping, packing, and the control
endpoints' wiring.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.kaggle import client as kclient
from app.kaggle.client import KaggleCredentials, extract_url
from app.kaggle.controller import KaggleController
from app.kaggle.packer import collect_backend_files, render_worker
from app.main import app


# --- credentials -----------------------------------------------------------


def test_credentials_validation():
    with pytest.raises(ValueError):
        KaggleCredentials(username="", key="k").validate()
    with pytest.raises(ValueError):
        KaggleCredentials(username="u", key="").validate()
    KaggleCredentials(username="u", key="k").validate()  # ok


# --- URL scraping ----------------------------------------------------------


def test_extract_url_variants():
    assert (
        extract_url("noise\nEDGERUNNER_URL=https://x.trycloudflare.com\nmore")
        == "https://x.trycloudflare.com"
    )
    assert (
        extract_url("2026 Requesting tunnel https://calm-sky-42.trycloudflare.com ok")
        == "https://calm-sky-42.trycloudflare.com"
    )
    assert extract_url("nothing here") is None
    assert extract_url("") is None


# --- packer ----------------------------------------------------------------


def test_packer_collects_and_renders():
    files = collect_backend_files()
    assert "app/main.py" in files
    worker = render_worker({"model_repo": "r", "model_file": "f", "gpu": True}, files)
    assert "__FILES__" not in worker and "__CONFIG__" not in worker
    assert "def main()" in worker


# --- controller ------------------------------------------------------------


def test_start_without_credentials_raises():
    from app.kaggle.client import KaggleError

    ctrl = KaggleController()
    with pytest.raises(KaggleError):
        ctrl.start()


def test_configure_validates_via_client(monkeypatch):
    calls = {}

    def fake_validate(creds):
        calls["creds"] = creds

    monkeypatch.setattr(kclient, "validate_credentials", fake_validate)
    ctrl = KaggleController()
    ctrl.configure("alice", "secret")
    assert ctrl.configured
    assert calls["creds"].username == "alice"


# --- endpoints -------------------------------------------------------------

api = TestClient(app)


def test_kaggle_status_endpoint_idle():
    resp = api.get("/api/kaggle/status")
    assert resp.status_code == 200
    body = resp.json()
    assert "configured" in body and "session" in body
    assert body["session"]["state"] in ("idle", "stopped", "failed")


def test_session_heartbeat_endpoint():
    resp = api.post("/api/session/heartbeat")
    assert resp.status_code == 200
    assert resp.json()["seconds_since_heartbeat"] is not None


def test_session_shutdown_endpoint_does_not_exit_in_test(monkeypatch):
    # Prevent the real os._exit scheduling from killing the test process.
    from app.session import watchdog

    monkeypatch.setattr(watchdog, "_force_exit_soon", lambda *a, **k: None)
    resp = api.post("/api/session/shutdown")
    assert resp.status_code == 200
    assert resp.json()["shutdown_requested"] is True
