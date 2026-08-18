"""Agentic harness: a streaming, dual-mode tool-calling loop over llama-server.

Dual-Mode Architecture:
1. Native Tool Calling: Uses the OpenAI-compatible `terminal` omnitool.
2. Markdown Interceptor Fallback: If a smaller/non-reasoning model outputs a
   fenced ````bash ```` or ````python ```` block instead of a JSON tool call,
   the agent detects it, executes it in the `./workspace` sandbox, emits
   `tool_call` and `tool_result` events, and feeds the output back into the loop.

This guarantees robust code execution regardless of model size or prompt format.
"""

from __future__ import annotations

import json
import re
import sys
from typing import AsyncIterator

import httpx

from app import tools
from app.config import settings
from app.harnesses.base import Harness, StreamEvent
from app.sampling import ensure_system_prompt, sampling_params, trim_history
from app.schemas import ChatRequest

MAX_ITERATIONS = 5

SYSTEM_PROMPT = (
    "You are EdgeRunner, a capable autonomous coding agent with a live workspace terminal. "
    "You have access to a universal tool: `terminal` (run any shell command, Python code via "
    "'python3 -c \"...\"' or scripts, inspect files with 'ls'/'cat', or install packages). "
    "Always prefer to WRITE AND RUN code in the terminal to solve and verify tasks.\n"
    "Autonomous Self-Healing: If a command or script fails with a traceback, compiler error, or non-zero exit code, "
    "carefully analyze the error diagnostics and line numbers, patch the source code, and re-run to verify the fix.\n"
    "Example tool call format:\n"
    '{"name": "terminal", "arguments": {"command": "python3 -c \\"import math; print(math.sqrt(144))\\""}}\n'
    "Think step by step, verify your work using the terminal, and give a clear final answer in Markdown."
)

_CODE_BLOCK_RE = re.compile(
    r"```(?:bash|sh|shell|zsh|python|py)\s*\n(.*?)```",
    re.DOTALL | re.IGNORECASE,
)


class AgentHarness(Harness):
    id = "agent"
    name = "Agent"
    description = (
        "Autonomous coding agent: runs Python, shell commands, and tools inside "
        "the shared workspace sandbox with dual-mode execution."
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
                for iteration in range(MAX_ITERATIONS):
                    calls: dict[int, dict] = {}
                    error = None
                    turn_content = ""

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
                                turn_content += token
                                yield StreamEvent(type="token", data=token)

                    if error:
                        yield StreamEvent(type="error", data=error)
                        return

                    # Path A: Model emitted formal OpenAI tool calls
                    if calls:
                        ordered = [calls[i] for i in sorted(calls)]
                        messages.append(_assistant_tool_message(ordered))
                        for call in ordered:
                            async for ev in self._run_tool(call, messages):
                                yield ev
                        continue

                    # Path B: Fallback - check if non-reasoning model outputted an executable markdown code block
                    # Only trigger fallback on earlier iterations if tool calls were omitted
                    if iteration == 0 and not calls and turn_content:
                        extracted_cmd = _extract_markdown_command(turn_content)
                        if extracted_cmd:
                            call = {
                                "id": f"fallback_call_{iteration}",
                                "name": "terminal",
                                "arguments": json.dumps({"command": extracted_cmd}),
                            }
                            messages.append({"role": "assistant", "content": turn_content})
                            async for ev in self._run_tool(call, messages):
                                yield ev
                            continue

                    # No tool calls this turn: answer is complete.
                    yield StreamEvent(type="done")
                    return

            yield StreamEvent(
                type="error",
                data=f"Agent stopped after {MAX_ITERATIONS} tool iterations.",
            )
        except httpx.ConnectError:
            last_user = next(
                (m.content for m in reversed(request.messages) if m.role == "user"),
                "",
            )
            msg = (
                f"[Offline Mock via {request.model}] Backend model server is currently offline. "
                f"You said: {last_user!r}. "
                "Start a local llama-server or connect your Kaggle GPU rig to run live agent loops in the workspace."
            )
            import asyncio
            for word in msg.split(" "):
                await asyncio.sleep(0.02)
                yield StreamEvent(type="token", data=word + " ")
            yield StreamEvent(type="done")
            return
        except httpx.TimeoutException:
            yield StreamEvent(type="error", data="llama-server timed out.")

    async def _run_tool(
        self, call: dict, messages: list[dict]
    ) -> AsyncIterator[StreamEvent]:
        call_id = call.get("id", "")
        name = call.get("name", "terminal")
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
    """Parse one SSE chunk. Returns (content_delta, is_error)."""
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


def _extract_markdown_command(text: str) -> str | None:
    """Extract an executable command from a markdown code block if present."""
    match = _CODE_BLOCK_RE.search(text)
    if not match:
        return None
    code = match.group(1).strip()
    if not code:
        return None

    # Check if python or bash
    block_header = text[: match.start() + 10].lower()
    if "python" in block_header or "py" in block_header:
        py_exec = sys.executable or "python3"
        escaped = code.replace("'", "'\"'\"'")
        return f"{py_exec} -c '{escaped}'"
    return code
