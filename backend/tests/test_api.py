"""Smoke tests for the EdgeRunner API."""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"


def test_catalog_has_models_and_harnesses():
    resp = client.get("/api/catalog")
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["models"]) > 0
    assert any(h["id"] == "echo" for h in body["harnesses"])


def test_chat_streams_tokens_then_done():
    req = {
        "model": "qwen2.5-3b-instruct",
        "harness": "echo",
        "messages": [{"role": "user", "content": "hello"}],
    }
    with client.stream("POST", "/api/chat", json=req) as resp:
        assert resp.status_code == 200
        events = []
        for line in resp.iter_lines():
            if line.startswith("data: "):
                events.append(json.loads(line[len("data: "):]))
    assert any(e["type"] == "token" for e in events)
    assert events[-1]["type"] == "done"
    # the echoed user message should appear in the streamed tokens
    streamed = "".join(e["data"] for e in events if e["type"] == "token")
    assert "hello" in streamed


def test_chat_unknown_harness_404():
    req = {"model": "x", "harness": "nope", "messages": []}
    resp = client.post("/api/chat", json=req)
    assert resp.status_code == 404
