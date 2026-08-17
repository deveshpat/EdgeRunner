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
    assert any(h["id"] in ("chat", "llamacpp") for h in body["harnesses"])
    assert any(h["id"] == "agent" for h in body["harnesses"])


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


def test_v1_models_fallback():
    resp = client.get("/v1/models")
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("object") == "list"
    assert len(data.get("data", [])) > 0


def test_v1_chat_completions_streaming_fallback():
    req = {
        "model": "qwen2.5-3b-instruct",
        "messages": [{"role": "user", "content": "hello v1"}],
        "stream": True,
    }
    with client.stream("POST", "/v1/chat/completions", json=req) as resp:
        assert resp.status_code == 200
        events = []
        for line in resp.iter_lines():
            if line.startswith("data: ") and line != "data: [DONE]":
                events.append(json.loads(line[len("data: "):]))
        assert len(events) > 0
        full_text = "".join(e.get("choices", [{}])[0].get("delta", {}).get("content", "") for e in events)
        assert "hello v1" in full_text


def test_v1_chat_completions_non_streaming_fallback():
    req = {
        "model": "qwen2.5-3b-instruct",
        "messages": [{"role": "user", "content": "hello v1 json"}],
        "stream": False,
    }
    resp = client.post("/v1/chat/completions", json=req)
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("object") == "chat.completion"
    assert "hello v1 json" in data["choices"][0]["message"]["content"]


def test_models_status():
    resp = client.get("/api/models/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "status" in data
    assert "hardware" in data
    assert "gpu" in data["hardware"]


def test_models_explore():
    resp = client.get("/api/models/explore?limit=5")
    assert resp.status_code == 200
    data = resp.json()
    assert "models" in data
    assert len(data["models"]) > 0
    first = data["models"][0]
    assert "repo" in first
    assert "name" in first
    assert "fits_hardware" in first


