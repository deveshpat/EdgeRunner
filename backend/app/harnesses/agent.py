"""Agentic harness: a streaming, OpenAI-style tool-calling loop over llama-server.

Each turn we open a streaming completion, advertising the built-in tools:
  - content deltas are emitted as `token` events immediately (live streaming),
  - tool-call deltas are accumulated across chunks by their index.

If the finished turn produced tool calls we execute them (emitting
`tool_call` / `tool_result` events), append the results, and loop; otherwise
the answer has already been streamed and we finish.

Requires a llama-server new enough to stream OpenAI-compatible tool calls.
"""

from __future__ import annotations

import json
from typing import AsyncIterator

import httpx

from app import tools
from app.config import settings
from app.harnesses.base import Harness, StreamEvent
from app.sampling import ensure_system_prompt, sampling_params, trim_history
from app.schemas import ChatRequest

MAX_ITERATIONS = 5

SYSTEM_PROMPT = (
    "You are EdgeRunner, a helpful agent running on a local model. You have "
    "tools available (calculator, clock, random number, text stats, hashing). "
    "Call a tool whenever the answer needs a precise computation, the current "
    "time, randomness, or a hash — never guess those. Think step by step, then "
    "give a clear final answer in Markdown. Do not fabricate tool results."
)


class AgentHarness(Harness):
    id = "agent"
    name = "Agent (tools)"
    description = (
        "Streaming tool-calling agent over llama-server: calculator, clock, "
        "random numbers, text stats, and hashing."
    )

    async def run(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        messages: list[dict] = ensure_system_prompt(
            [m.model_dump() for m in request.messages], SYSTEM_PROMPT
        )
        messages = trim_history(messages)

        headers = {"Content-Type": "application/json"}
        if settings.llamacpp_api_key:
            headers["Authorization"] = f"Bearer {settings.llamacpp_api_key}"
        url = f"{settings.llamacpp_base_url.rstrip('/')}/v1/chat/completions"
        timeout = httpx.Timeout(
            settings.llamacpp_read_timeout, connect=settings.llamacpp_connect_timeout
        )

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                for _ in range(MAX_ITERATIONS):
                    calls: dict[int, dict] = {}
                    error = None

                    payload = {
                        "model": request.model,
                        "messages": messages,
                        "tools": tools.specs(),
                        "stream": True,
                        **sampling_params(
                            request.temperature, request.top_p, request.max_tokens
                        ),
                    }

                    async with client.stream(
                        "POST", url, json=payload, headers=headers
                    ) as resp:
                        if resp.status_code != 200:
                            body = (await resp.aread()).decode("utf-8", "replace")
                            yield StreamEvent(
                                type="error",
                                data=f"llama-server {resp.status_code}: {body[:500]}",
                            )
                            return
                        async for line in resp.aiter_lines():
                            if not line.startswith("data: "):
                                continue
                            data = line[len("data: ") :].strip()
                            if data == "[DONE]":
                                break
                            token, is_error = _consume_chunk(data, calls)
                            if is_error:
                                error = token
                                break
                            if token:
                                yield StreamEvent(type="token", data=token)

                    if error:
                        yield StreamEvent(type="error", data=error)
                        return

                    if calls:
                        ordered = [calls[i] for i in sorted(calls)]
                        messages.append(_assistant_tool_message(ordered))
                        for call in ordered:
                            async for ev in self._run_tool(call, messages):
                                yield ev
                        continue

                    # No tool calls this turn: the answer has been streamed.
                    yield StreamEvent(type="done")
                    return

            yield StreamEvent(
                type="error",
                data=f"Agent stopped after {MAX_ITERATIONS} tool iterations.",
            )
        except httpx.ConnectError:
            yield StreamEvent(
                type="error",
                data=(
                    f"Could not connect to llama-server at "
                    f"{settings.llamacpp_base_url}. Is it running?"
                ),
            )
        except httpx.TimeoutException:
            yield StreamEvent(type="error", data="llama-server timed out.")

    async def _run_tool(
        self, call: dict, messages: list[dict]
    ) -> AsyncIterator[StreamEvent]:
        call_id = call.get("id", "")
        name = call.get("name", "")
        arguments = call.get("arguments", "") or ""

        yield StreamEvent(
            type="tool_call",
            data=json.dumps({"id": call_id, "name": name, "arguments": arguments}),
        )
        result = tools.execute(name, arguments)
        yield StreamEvent(
            type="tool_result",
            data=json.dumps({"id": call_id, "name": name, "result": result}),
        )
        messages.append(
            {"role": "tool", "tool_call_id": call_id, "name": name, "content": result}
        )


def _consume_chunk(data: str, calls: dict[int, dict]) -> tuple[str, bool]:
    """Parse one SSE chunk. Returns (content_delta, is_error).

    Content deltas are returned for streaming; tool-call deltas are merged into
    `calls` in place, keyed by index.
    """
    try:
        chunk = json.loads(data)
    except json.JSONDecodeError:
        return "", False
    choices = chunk.get("choices") or []
    if not choices:
        return "", False
    delta = choices[0].get("delta") or {}

    for tc in delta.get("tool_calls") or []:
        idx = tc.get("index", 0)
        slot = calls.setdefault(idx, {"id": "", "name": "", "arguments": ""})
        if tc.get("id"):
            slot["id"] = tc["id"]
        fn = tc.get("function") or {}
        if fn.get("name"):
            slot["name"] = fn["name"]
        if fn.get("arguments"):
            slot["arguments"] += fn["arguments"]

    return delta.get("content") or "", False


def _assistant_tool_message(calls: list[dict]) -> dict:
    """Rebuild the assistant turn (with tool_calls) to append to history."""
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": c["id"],
                "type": "function",
                "function": {"name": c["name"], "arguments": c["arguments"]},
            }
            for c in calls
        ],
    }
