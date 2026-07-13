"""Tests for the built-in tools and the streaming agentic harness loop."""

from __future__ import annotations

import json

import httpx
import pytest

from app import tools
from app.harnesses import agent as agent_mod
from app.harnesses.agent import AgentHarness
from app.schemas import ChatRequest


# --- tools -----------------------------------------------------------------


def test_calculator_basic():
    assert tools.execute("calculator", json.dumps({"expression": "3 * (4 + 5)"})) == "27"


def test_calculator_functions_and_constants():
    assert tools.execute("calculator", json.dumps({"expression": "sqrt(16)"})) == "4"
    assert tools.execute("calculator", json.dumps({"expression": "max(2, 9, 5)"})) == "9"
    assert tools.execute("calculator", json.dumps({"expression": "factorial(5)"})) == "120"


def test_calculator_rejects_code():
    out = tools.execute("calculator", json.dumps({"expression": "__import__('os')"}))
    assert out.startswith("error")
    # A non-whitelisted function must be rejected too.
    assert tools.execute("calculator", json.dumps({"expression": "eval('1')"})).startswith(
        "error"
    )


def test_calculator_bad_arguments():
    assert tools.execute("calculator", "not json").startswith("error")


def test_random_number_in_range():
    for _ in range(20):
        out = int(tools.execute("random_number", json.dumps({"min": 1, "max": 6})))
        assert 1 <= out <= 6


def test_text_stats():
    out = json.loads(
        tools.execute("text_stats", json.dumps({"text": "hello world\nbye"}))
    )
    assert out == {"characters": 15, "words": 3, "lines": 2}


def test_hash_text_sha256():
    out = tools.execute("hash_text", json.dumps({"text": "abc", "algorithm": "sha256"}))
    assert out == (
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )


def test_hash_text_bad_algo():
    assert tools.execute("hash_text", json.dumps({"text": "x", "algorithm": "nope"})).startswith(
        "error"
    )


def test_unknown_tool():
    assert tools.execute("nope", "{}").startswith("error: unknown tool")


def test_specs_shape():
    specs = tools.specs()
    names = {s["function"]["name"] for s in specs}
    assert {"calculator", "current_time", "random_number", "text_stats", "hash_text"} <= names
    assert all(s["type"] == "function" for s in specs)


# --- streaming agent loop --------------------------------------------------


def _sse(*chunks: dict) -> str:
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks)
    return body + "data: [DONE]\n\n"


class _MockTransport(httpx.AsyncBaseTransport):
    """Streams a tool call (split across chunks) then a streamed answer."""

    def __init__(self):
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls == 1:
            body = _sse(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_1",
                                        "type": "function",
                                        "function": {"name": "calculator", "arguments": ""},
                                    }
                                ],
                            },
                            "finish_reason": None,
                        }
                    ]
                },
                # arguments arrive fragmented across two chunks
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {"index": 0, "function": {"arguments": '{"expr'}}
                                ]
                            },
                            "finish_reason": None,
                        }
                    ]
                },
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "function": {"arguments": 'ession": "21 * 2"}'},
                                    }
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                },
            )
        else:
            body = _sse(
                {"choices": [{"index": 0, "delta": {"content": "The "}}]},
                {"choices": [{"index": 0, "delta": {"content": "answer "}}]},
                {
                    "choices": [
                        {"index": 0, "delta": {"content": "is 42."}, "finish_reason": "stop"}
                    ]
                },
            )
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/event-stream"}
        )


@pytest.mark.asyncio
async def test_agent_streams_tool_then_answer(monkeypatch):
    transport = _MockTransport()
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=transport)

    monkeypatch.setattr(agent_mod.httpx, "AsyncClient", fake_client)

    harness = AgentHarness()
    req = ChatRequest(
        model="m",
        harness="agent",
        messages=[{"role": "user", "content": "what is 21 * 2?"}],
    )
    events = [ev async for ev in harness.run(req)]
    types = [e.type for e in events]

    assert "tool_call" in types
    assert "tool_result" in types
    assert types[-1] == "done"
    assert transport.calls == 2

    # Fragmented arguments were reassembled and the calculator produced 42.
    call_ev = next(e for e in events if e.type == "tool_call")
    assert json.loads(call_ev.data)["arguments"] == '{"expression": "21 * 2"}'
    result_ev = next(e for e in events if e.type == "tool_result")
    assert json.loads(result_ev.data)["result"] == "42"

    # The final answer was streamed as tokens.
    answer = "".join(e.data for e in events if e.type == "token")
    assert "42" in answer
