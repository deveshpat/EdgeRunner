"""DeepSeek Harness (dsh) for EdgeRunner.

Integrates the official DeepSeek AI agent runtime architecture:
- Spatiotemporal composability via Cordis plugin pipeline.
- Dual-phase <think> reasoning extraction and streaming.
- Swappable runtime presets: Code, Standard, Minimal, Creator.
- Native tool execution with Contextual LinUCB bandit selection and Reflexion memory.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sys
import time
from typing import AsyncIterator

import httpx

from app import tools
from app.config import settings
from app.dsh_plugins import CordisKernel, DshContext, DSH_PRESET_PROMPTS
from app.harnesses.base import Harness, StreamEvent
from app.sampling import ensure_system_prompt, sampling_params, trim_history
from app.schemas import ChatRequest

logger = logging.getLogger("edgerunner.dsh")

MAX_ITERATIONS = 100

_CODE_BLOCK_RE = re.compile(
    r"```(?:bash|sh|shell|zsh|python|py)\s*\n(.*?)```",
    re.DOTALL | re.IGNORECASE,
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


def _extract_markdown_command(text: str) -> str | None:
    """Extract an executable command from a markdown code block if present."""
    match = _CODE_BLOCK_RE.search(text)
    if not match:
        return None
    code = match.group(1).strip()
    if not code:
        return None

    block_header = text[: match.start() + 10].lower()
    if "python" in block_header or "py" in block_header:
        py_exec = sys.executable or "python3"
        escaped = code.replace("'", "'\"'\"'")
        return f"{py_exec} -c '{escaped}'"
    return code


def _extract_text_tool_calls(text: str) -> list[dict]:
    """Extract tool calls from free-form model text when structured SSE tool_calls are omitted."""
    calls: list[dict] = []

    # 1. <tool_call> ... </tool_call> blocks
    tool_call_re = re.compile(r"<tool_call>(.*?)</tool_call>", re.DOTALL | re.IGNORECASE)
    for match in tool_call_re.finditer(text):
        inner = match.group(1).strip()
        call_id = f"text_call_{len(calls) + 1}"

        # 1a. JSON inside <tool_call>
        try:
            parsed = json.loads(inner, strict=False)
            if isinstance(parsed, dict):
                name = parsed.get("name") or parsed.get("function", {}).get("name") or "terminal"
                args = (
                    parsed.get("arguments")
                    or parsed.get("parameters")
                    or parsed.get("function", {}).get("arguments")
                    or parsed.get("function", {}).get("parameters")
                    or parsed
                )
                calls.append(
                    {
                        "id": call_id,
                        "name": str(name),
                        "arguments": json.dumps(args) if isinstance(args, dict) else str(args),
                    }
                )
                continue
        except Exception:
            pass

        # 1b. XML / JSON hybrid tags inside <tool_call>: <function=...>, {"function=...>, {"name=...>, {"function_name=...>
        fn_match = re.search(
            r"(?:<function(?:=|\s+name=[\"']?)|(?:\{[\"']?(?:function_name|function|name)[\"']?\s*[:=]\s*[\"']?))([\w\-_]+)[\"']?\s*>?([\s\S]*?)(?:</function>|\}|$)",
            inner,
            re.DOTALL | re.IGNORECASE,
        )
        if fn_match:
            fn_name = fn_match.group(1).strip()
            fn_body = fn_match.group(2).strip()

            params: dict[str, str] = {}
            for pm in re.finditer(
                r"<parameter(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)(?:</parameter>|$)",
                fn_body,
                re.DOTALL | re.IGNORECASE,
            ):
                params[pm.group(1).strip()] = pm.group(2).strip()

            if not params:
                if fn_name in ("view_file", "read_file", "cat"):
                    params["path"] = fn_body.replace('"', '').replace("'", '').strip()
                else:
                    params["command"] = fn_body

            calls.append(
                {
                    "id": call_id,
                    "name": fn_name,
                    "arguments": json.dumps(params),
                }
            )
            continue

        # 1c. Plain text / command directly inside <tool_call>
        if inner:
            calls.append(
                {
                    "id": call_id,
                    "name": "terminal",
                    "arguments": json.dumps({"command": inner}),
                }
            )

    # 2. Standalone tags outside <tool_call>
    if not calls:
        fn_matches = list(
            re.finditer(
                r"(?:<function(?:=|\s+name=[\"']?)|(?:\{[\"']?(?:function_name|function|name)[\"']?\s*[:=]\s*[\"']?))([\w\-_]+)[\"']?\s*>?([\s\S]*?)(?:</function>|\}|$)",
                text,
                re.DOTALL | re.IGNORECASE,
            )
        )
        for fn_match in fn_matches:
            fn_name = fn_match.group(1).strip()
            fn_body = fn_match.group(2).strip()
            params = {}
            for pm in re.finditer(
                r"<parameter(?:=|\s+name=[\"']?)([\w\-_]+)[\"']?\s*>([\s\S]*?)(?:</parameter>|$)",
                fn_body,
                re.DOTALL | re.IGNORECASE,
            ):
                params[pm.group(1).strip()] = pm.group(2).strip()
            if not params:
                if fn_name in ("view_file", "read_file", "cat"):
                    params["path"] = fn_body.replace('"', '').replace("'", '').strip()
                else:
                    params["command"] = fn_body
            calls.append(
                {
                    "id": f"text_call_{len(calls) + 1}",
                    "name": fn_name,
                    "arguments": json.dumps(params),
                }
            )

    # 3. Action: / Action Input: pattern
    if not calls:
        action_match = re.search(
            r"Action:\s*([\w\-_]+)\s*\n+Action Input:\s*(.+?)(?:\n\s*Observation:|$)",
            text,
            re.DOTALL | re.IGNORECASE,
        )
        if action_match:
            calls.append(
                {
                    "id": f"action_call_{len(calls) + 1}",
                    "name": action_match.group(1).strip(),
                    "arguments": json.dumps({"command": action_match.group(2).strip()}),
                }
            )

    # 4. Markdown code block fallback (```bash or ```python)
    if not calls:
        cmd = _extract_markdown_command(text)
        if cmd:
            calls.append(
                {
                    "id": f"markdown_call_{len(calls) + 1}",
                    "name": "terminal",
                    "arguments": json.dumps({"command": cmd}),
                }
            )

    # Deduplicate identical tool calls emitted in the same turn (e.g. XML followed by JSON duplicate)
    unique_calls: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for c in calls:
        key = (c["name"], str(c["arguments"]).strip())
        if key not in seen:
            seen.add(key)
            unique_calls.append(c)

    return unique_calls


class DeepSeekHarness(Harness):
    id = "deepseek"
    name = "DeepSeek Harness"
    description = (
        "DeepSeek AI Agent Harness (dsh): Plugin-first agent runtime with "
        "dual-phase <think> reasoning, swappable presets (Code, Standard, Minimal, Creator), "
        "and LinUCB tool routing."
    )

    async def run(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        # Determine preset mode (default to "code" for developer assistant)
        preset = (getattr(request, "preset", None) or "code").lower()
        if preset not in DSH_PRESET_PROMPTS:
            preset = "code"

        system_prompt = DSH_PRESET_PROMPTS[preset]
        kernel = CordisKernel(preset=preset)

        ctx = DshContext(
            session_id=getattr(request, "session_id", "dsh_session"),
            model=request.model,
            preset=preset,
        )

        messages: list[dict] = ensure_system_prompt(
            [m.model_dump() for m in request.messages], system_prompt
        )
        messages = trim_history(messages)
        ctx.messages = messages

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
                    ctx.iteration = iteration
                    calls: dict[int, dict] = {}
                    error = None
                    turn_content = ""
                    in_think = False
                    think_buffer = ""

                    # Run Cordis lifecycle before_step
                    await kernel.run_before_step(ctx)

                    last_hint = str(messages[-1].get("content") or "") if messages else ""

                    payload = {
                        "model": request.model,
                        "messages": ctx.messages,
                        "tools": ctx.active_tools or tools.get_active_tool_slice(ctx.messages),
                        "stream": True,
                        **sampling_params(
                            request.temperature, request.top_p, request.max_tokens, context_hint=last_hint
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
                            if not line or not line.startswith("data: "):
                                continue
                            data_str = line[6:].strip()
                            if data_str == "[DONE]":
                                break

                            token, is_final = _consume_chunk(data_str, calls)
                            if token:
                                turn_content += token

                                # Handle <think>...</think> reasoning token tags in real-time
                                if "<think>" in token:
                                    in_think = True
                                    token = token.replace("<think>", "")

                                if in_think:
                                    if "</think>" in token:
                                        parts = token.split("</think>", 1)
                                        think_token = parts[0]
                                        norm_token = parts[1] if len(parts) > 1 else ""
                                        in_think = False
                                        if think_token:
                                            yield StreamEvent(type="think", data=think_token)
                                            await kernel.plugins[0].on_reasoning_chunk(think_token, ctx)
                                        if norm_token:
                                            yield StreamEvent(type="token", data=norm_token)
                                    else:
                                        yield StreamEvent(type="think", data=token)
                                        await kernel.plugins[0].on_reasoning_chunk(token, ctx)
                                else:
                                    yield StreamEvent(type="token", data=token)

                    # Post-process freeform tool calls if structured calls were omitted
                    if not calls and turn_content:
                        extracted = _extract_text_tool_calls(turn_content)
                        if extracted:
                            for idx, c in enumerate(extracted):
                                calls[idx] = c
                        elif "```" in turn_content:
                            cmd = _extract_markdown_command(turn_content)
                            if cmd:
                                calls[0] = {
                                    "id": "dsh_markdown_exec",
                                    "name": "terminal",
                                    "arguments": json.dumps({"command": cmd}),
                                }

                    if calls:
                        # Append assistant turn
                        messages.append(
                            {
                                "role": "assistant",
                                "content": turn_content or None,
                                "tool_calls": [
                                    {
                                        "id": c.get("id", f"call_{i}"),
                                        "type": "function",
                                        "function": {
                                            "name": c.get("name", "terminal"),
                                            "arguments": c.get("arguments", ""),
                                        },
                                    }
                                    for i, c in calls.items()
                                ],
                            }
                        )

                        # Execute tool calls through Cordis pipeline
                        for call in calls.values():
                            async for ev in self._run_tool(call, messages, kernel, ctx):
                                yield ev
                        continue

                    # No tool calls: generation complete
                    yield StreamEvent(type="done")
                    return

            yield StreamEvent(
                type="error",
                data=f"DeepSeek Harness stopped after {MAX_ITERATIONS} iterations.",
            )
        except httpx.ConnectError:
            last_user = next(
                (m.get("content") for m in reversed(messages) if m.get("role") == "user"),
                "",
            )
            msg = (
                f"[DeepSeek Harness Mock via {request.model}] Model backend is offline. "
                f"Prompt received: {last_user!r}. Start llama-server to run live DeepSeek inference."
            )
            for word in msg.split(" "):
                await asyncio.sleep(0.02)
                yield StreamEvent(type="token", data=word + " ")
            yield StreamEvent(type="done")
            return
        except httpx.TimeoutException:
            yield StreamEvent(type="error", data="DeepSeek Harness: model server timed out.")

    async def _run_tool(
        self, call: dict, messages: list[dict], kernel: CordisKernel, ctx: DshContext
    ) -> AsyncIterator[StreamEvent]:
        call_id = call.get("id", "")
        name = call.get("name", "terminal")
        raw_arguments = call.get("arguments", "") or ""

        parsed_args: dict = {}
        try:
            parsed_args = json.loads(raw_arguments) if isinstance(raw_arguments, str) else raw_arguments
        except Exception:
            parsed_args = {"command": raw_arguments}

        # Cordis tool call hook
        name, parsed_args = await kernel.process_tool_call(name, parsed_args, ctx)
        arguments = json.dumps(parsed_args)

        yield StreamEvent(
            type="tool_call",
            data=json.dumps({"id": call_id, "name": name, "arguments": arguments}),
        )

        result = tools.execute(name, arguments)
        # Cordis tool result post-processing hook
        result = await kernel.process_tool_result(name, result, ctx)

        yield StreamEvent(
            type="tool_result",
            data=json.dumps({"id": call_id, "name": name, "result": result}),
        )
        messages.append(
            {"role": "tool", "tool_call_id": call_id, "name": name, "content": result}
        )
