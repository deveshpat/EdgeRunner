"""Tests for the unified terminal omnitool, alias resolver, and dual-mode streaming agent harness."""

from __future__ import annotations

import json

import httpx
import pytest

from app import tools
from app.harnesses import agent as agent_mod
from app.harnesses.agent import AgentHarness
from app.schemas import ChatRequest


# --- tools & aliases --------------------------------------------------------


def test_terminal_basic():
    out = tools.execute("terminal", json.dumps({"command": "echo 'hello terminal'"}))
    assert "hello terminal" in out


def test_terminal_alias_bash_and_sh():
    out = tools.execute("bash", json.dumps({"command": "echo 'from bash'"}))
    assert "from bash" in out
    out2 = tools.execute("sh", json.dumps({"cmd": "echo 'from sh'"}))
    assert "from sh" in out2


def test_terminal_alias_python():
    out = tools.execute("python", json.dumps({"code": "print(21 * 2)"}))
    assert "42" in out.strip()


def test_terminal_alias_calculator():
    out = tools.execute("calculator", json.dumps({"expression": "print(10 + 5)"}))
    assert "15" in out.strip()


def test_terminal_fuzzy_args():
    # Model sends 'cmd' instead of 'command'
    out = tools.execute("terminal", json.dumps({"cmd": "echo 'fuzzy cmd'"}))
    assert "fuzzy cmd" in out
    # Model sends raw text instead of JSON
    out_raw = tools.execute("terminal", "echo 'raw text'")
    assert "raw text" in out_raw


def test_terminal_specs():
    specs = tools.specs()
    assert len(specs) == 1
    assert specs[0]["function"]["name"] == "terminal"
    assert "command" in specs[0]["function"]["parameters"]["properties"]


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
                                        "function": {"name": "terminal", "arguments": ""},
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
                                    {"index": 0, "function": {"arguments": '{"command": "python3 -c \\"print(21'}}
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
                                        "function": {"arguments": ' * 2)\\""}'},
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

    # Fragmented arguments were reassembled and execution produced 42.
    call_ev = next(e for e in events if e.type == "tool_call")
    assert "21 * 2" in json.loads(call_ev.data)["arguments"]
    result_ev = next(e for e in events if e.type == "tool_result")
    assert "42" in json.loads(result_ev.data)["result"]

    # The final answer was streamed as tokens.
    answer = "".join(e.data for e in events if e.type == "token")
    assert "42" in answer


class _MockMarkdownFallbackTransport(httpx.AsyncBaseTransport):
    """Simulates a small model writing a python markdown block instead of a tool call."""

    def __init__(self):
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls == 1:
            body = _sse(
                {"choices": [{"index": 0, "delta": {"content": "Let me compute:\n```python\nprint(100 + 44)\n```"}}]}
            )
        else:
            body = _sse(
                {"choices": [{"index": 0, "delta": {"content": "The result is 144."}, "finish_reason": "stop"}]}
            )
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/event-stream"}
        )


@pytest.mark.asyncio
async def test_agent_markdown_fallback(monkeypatch):
    transport = _MockMarkdownFallbackTransport()
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=transport)

    monkeypatch.setattr(agent_mod.httpx, "AsyncClient", fake_client)

    harness = AgentHarness()
    req = ChatRequest(
        model="m",
        harness="agent",
        messages=[{"role": "user", "content": "compute 100+44"}],
    )
    events = [ev async for ev in harness.run(req)]
    types = [e.type for e in events]

    assert "tool_call" in types
    assert "tool_result" in types
    assert types[-1] == "done"
    assert transport.calls == 2

    result_ev = next(e for e in events if e.type == "tool_result")
    assert "144" in json.loads(result_ev.data)["result"]


class _MockXmlToolCallTransport(httpx.AsyncBaseTransport):
    """Simulates model emitting raw XML <tool_call><function=terminal><parameter=command>..."""

    def __init__(self):
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls == 1:
            xml_output = """I'll teach you C++ in a structured way! Let's start with a practical example in the terminal.

<tool_call>
<function=terminal>
<parameter=command>
cat > hello_test.cpp << 'EOF'
#include <iostream>
using namespace std;

int main() {
    cout << "Hello, C++ Testing!" << endl;
    return 0;
}
EOF
</parameter>
</function>
</tool_call>"""
            body = _sse({"choices": [{"index": 0, "delta": {"content": xml_output}}]})
        else:
            body = _sse(
                {"choices": [{"index": 0, "delta": {"content": "File hello_test.cpp created successfully."}, "finish_reason": "stop"}]}
            )
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/event-stream"}
        )


@pytest.mark.asyncio
async def test_agent_xml_tool_call_cpp(monkeypatch):
    transport = _MockXmlToolCallTransport()
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=transport)

    monkeypatch.setattr(agent_mod.httpx, "AsyncClient", fake_client)

    harness = AgentHarness()
    req = ChatRequest(
        model="m",
        harness="agent",
        messages=[{"role": "user", "content": "teach me C++"}],
    )
    events = [ev async for ev in harness.run(req)]
    types = [e.type for e in events]

    assert "tool_call" in types
    assert "tool_result" in types
    assert types[-1] == "done"
    assert transport.calls == 2

    # Verify the file was actually written to the workspace
    cat_out = tools.execute("terminal", "cat hello_test.cpp")
    assert "Hello, C++ Testing!" in cat_out

    # Clean up test file
    tools.execute("terminal", "rm -f hello_test.cpp")


class _MockJsonXmlToolCallTransport(httpx.AsyncBaseTransport):
    """Simulates model emitting <tool_call>{"name": "terminal", "arguments": {"command": "echo 'xml json'"}}</tool_call>"""

    def __init__(self):
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls == 1:
            raw = '<tool_call>\n{"name": "terminal", "arguments": {"command": "echo \'xml json tool call\'"}}\n</tool_call>'
            body = _sse({"choices": [{"index": 0, "delta": {"content": raw}}]})
        else:
            body = _sse(
                {"choices": [{"index": 0, "delta": {"content": "Done."}, "finish_reason": "stop"}]}
            )
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/event-stream"}
        )


@pytest.mark.asyncio
async def test_agent_json_xml_tool_call(monkeypatch):
    transport = _MockJsonXmlToolCallTransport()
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=transport)

    monkeypatch.setattr(agent_mod.httpx, "AsyncClient", fake_client)

    harness = AgentHarness()
    req = ChatRequest(
        model="m",
        harness="agent",
        messages=[{"role": "user", "content": "run test"}],
    )
    events = [ev async for ev in harness.run(req)]
    types = [e.type for e in events]

    assert "tool_call" in types
    assert "tool_result" in types
    assert types[-1] == "done"

    result_ev = next(e for e in events if e.type == "tool_result")
    assert "xml json tool call" in json.loads(result_ev.data)["result"]
