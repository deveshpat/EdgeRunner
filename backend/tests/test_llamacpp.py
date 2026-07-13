"""Tests for the llama.cpp harness and live-model catalog fallback."""

from __future__ import annotations

import json

import pytest

from app.catalog import get_models
from app.harnesses.llamacpp import LlamaCppHarness, _extract_delta
from app.schemas import ChatRequest


def test_extract_delta_parses_openai_chunk():
    chunk = {
        "choices": [{"delta": {"content": "hi"}, "index": 0}],
    }
    assert _extract_delta(json.dumps(chunk)) == "hi"


def test_extract_delta_handles_empty_and_malformed():
    assert _extract_delta("not json") == ""
    assert _extract_delta(json.dumps({"choices": []})) == ""
    assert _extract_delta(json.dumps({"choices": [{"delta": {}}]})) == ""


def test_payload_uses_request_and_defaults():
    h = LlamaCppHarness()
    req = ChatRequest(
        model="m",
        harness="llamacpp",
        messages=[{"role": "user", "content": "hi"}],
        temperature=0.1,
    )
    payload = h._payload(req)
    assert payload["stream"] is True
    assert payload["temperature"] == 0.1  # from request
    assert payload["max_tokens"] > 0  # default applied
    assert payload["messages"] == [{"role": "user", "content": "hi"}]


@pytest.mark.asyncio
async def test_run_yields_error_when_server_unreachable():
    # Nothing is listening on the default llama-server port during tests.
    h = LlamaCppHarness()
    req = ChatRequest(
        model="m", harness="llamacpp", messages=[{"role": "user", "content": "hi"}]
    )
    events = [ev async for ev in h.run(req)]
    assert len(events) == 1
    assert events[0].type == "error"
    assert "llama-server" in events[0].data


@pytest.mark.asyncio
async def test_catalog_falls_back_to_static_when_no_server():
    models = await get_models()
    assert len(models) > 0
    # Static placeholders are used when no llama-server answers.
    assert any(m.id == "qwen2.5-3b-instruct" for m in models)
