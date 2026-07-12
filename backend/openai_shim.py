"""
OpenAI-compatible /v1 endpoints over the in-process llama.cpp model.

Purpose: run Hermes Agent (github.com/NousResearch/hermes-agent, MIT)
against EdgeRunner's already-loaded GGUF without loading a second model.

The shim speaks Hermes's own function-calling dialect: incoming OpenAI
`tools` definitions are injected into the system prompt inside
<tools></tools> XML (the exact wording Hermes models were trained on),
and `<tool_call>{json}</tool_call>` blocks in the model output are parsed
back into structured OpenAI `tool_calls`. Works with any instruct GGUF.
"""

from __future__ import annotations

import ast
import json
import re
import threading
import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

router = APIRouter()

# llama.cpp is not safe to call concurrently
_MODEL_LOCK = threading.Lock()

MAX_COMPLETION_TOKENS = 1536

# Verbatim Hermes function-calling system block (trajectory format from
# hermes-agent agent/agent_runtime_helpers.py).
HERMES_FC_TEMPLATE = (
    "You are a function calling AI model. You are provided with function "
    "signatures within <tools> </tools> XML tags. You may call one or more "
    "functions to assist with the user query. If available tools are not "
    "relevant in assisting with user query, just respond in natural "
    "conversational language. Don't make assumptions about what values to "
    "plug into functions. After calling & executing the functions, you will "
    "be provided with function results within <tool_response> </tool_response> "
    "XML tags. Here are the available tools:\n<tools>\n{tools}\n</tools>\n"
    "For each function call return a JSON object, with the following pydantic "
    "model json schema for each:\n"
    "{{'title': 'FunctionCall', 'type': 'object', 'properties': {{'name': "
    "{{'title': 'Name', 'type': 'string'}}, 'arguments': {{'title': "
    "'Arguments', 'type': 'object'}}}}, 'required': ['name', 'arguments']}}\n"
    "Each function call should be enclosed within <tool_call> </tool_call> "
    "XML tags.\nExample:\n<tool_call>\n{{'name': <function-name>,'arguments': "
    "<args-dict>}}\n</tool_call>"
)

_TOOL_CALL_RE = re.compile(r"<tool_call>\s*(\{.*?\})\s*</tool_call>", re.DOTALL)


def render_tools_block(tools: list) -> str:
    """One JSON function signature per line, Hermes-style."""
    lines = []
    for t in tools or []:
        fn = t.get("function") if isinstance(t, dict) else None
        if fn:
            lines.append(json.dumps(fn, ensure_ascii=False))
    return "\n".join(lines)


def convert_messages(messages: list, tools: Optional[list]) -> list:
    """
    Normalize OpenAI messages (incl. tool_calls / role=tool) into plain
    system/user/assistant turns every GGUF chat template can render.
    """
    out: list[dict] = []
    fc_block = (
        HERMES_FC_TEMPLATE.format(tools=render_tools_block(tools))
        if tools
        else ""
    )
    saw_system = False
    for m in messages or []:
        role = m.get("role", "user")
        content = m.get("content") or ""
        if isinstance(content, list):  # multimodal parts → text only
            content = "\n".join(
                p.get("text", "") for p in content if isinstance(p, dict)
            )
        if role == "system":
            if fc_block and not saw_system:
                content = f"{content}\n\n{fc_block}" if content else fc_block
            saw_system = True
            out.append({"role": "system", "content": content})
        elif role == "assistant":
            body = content
            for tc in m.get("tool_calls") or []:
                fn = tc.get("function", {})
                args = fn.get("arguments")
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except Exception:
                        pass
                call = {"name": fn.get("name"), "arguments": args}
                body += f"\n<tool_call>\n{json.dumps(call, ensure_ascii=False)}\n</tool_call>"
            out.append({"role": "assistant", "content": body})
        elif role == "tool":
            out.append(
                {
                    "role": "user",
                    "content": f"<tool_response>\n{content}\n</tool_response>",
                }
            )
        else:
            out.append({"role": "user", "content": content})
    if fc_block and not saw_system:
        out.insert(0, {"role": "system", "content": fc_block})
    return out


def parse_tool_calls(text: str) -> tuple[str, list]:
    """Extract <tool_call> blocks → OpenAI tool_calls; return cleaned text."""
    calls: list[dict] = []

    def _cut(m: re.Match) -> str:
        raw = m.group(1)
        obj = None
        try:
            obj = json.loads(raw)
        except Exception:
            try:
                obj = ast.literal_eval(raw)  # single-quoted JSON-ish
            except Exception:
                return m.group(0)  # unparseable — leave in content
        if not isinstance(obj, dict) or "name" not in obj:
            return m.group(0)
        calls.append(
            {
                "id": f"call_{uuid.uuid4().hex[:24]}",
                "type": "function",
                "function": {
                    "name": str(obj.get("name")),
                    "arguments": json.dumps(
                        obj.get("arguments") or {}, ensure_ascii=False
                    ),
                },
            }
        )
        return ""

    cleaned = _TOOL_CALL_RE.sub(_cut, text or "")
    return cleaned.strip(), calls


def _get_llama():
    from er_agent import get_raw_llama

    return get_raw_llama()


def _generate(messages: list, *, max_tokens: int, temperature: float) -> str:
    llama = _get_llama()
    with _MODEL_LOCK:
        result = llama.create_chat_completion(
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
        )
    return (
        (result.get("choices") or [{}])[0].get("message", {}).get("content")
        or ""
    )


def _completion_payload(model: str, content: str, tool_calls: list) -> dict:
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool_calls:
        message["tool_calls"] = tool_calls
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": "tool_calls" if tool_calls else "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }


def _sse_chunks(model: str, content: str, tool_calls: list):
    """Minimal valid streaming response: content delta(s), tool_calls, DONE."""
    cid = f"chatcmpl-{uuid.uuid4().hex[:24]}"
    base = {
        "id": cid,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
    }

    def chunk(delta: dict, finish: Optional[str] = None) -> str:
        payload = dict(base)
        payload["choices"] = [
            {"index": 0, "delta": delta, "finish_reason": finish}
        ]
        return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"

    yield chunk({"role": "assistant"})
    if content:
        # Emit in modest slices so SDK consumers see streaming behavior
        step = 512
        for i in range(0, len(content), step):
            yield chunk({"content": content[i : i + step]})
    if tool_calls:
        deltas = []
        for idx, tc in enumerate(tool_calls):
            deltas.append(
                {
                    "index": idx,
                    "id": tc["id"],
                    "type": "function",
                    "function": tc["function"],
                }
            )
        yield chunk({"tool_calls": deltas})
    yield chunk({}, finish="tool_calls" if tool_calls else "stop")
    yield "data: [DONE]\n\n"


def _model_entry() -> dict:
    from er_agent import get_model_meta

    meta = get_model_meta()
    name = meta.get("name") or "edgerunner-local"
    n_ctx = int(meta.get("n_ctx") or 8192)
    return {
        "id": name,
        "object": "model",
        "created": int(time.time()),
        "owned_by": "edgerunner",
        # Context metadata — Hermes's local-server probe reads these
        # (agent/model_metadata.py _query_local_context_length_uncached)
        "context_length": n_ctx,
        "max_model_len": n_ctx,
        "max_completion_tokens": MAX_COMPLETION_TOKENS,
    }


@router.get("/v1/models")
async def v1_models():
    return {"object": "list", "data": [_model_entry()]}


@router.get("/v1/models/{model_id:path}")
async def v1_model_detail(model_id: str):
    _ = model_id
    return _model_entry()


@router.post("/v1/chat/completions")
async def v1_chat_completions(request: Request):
    import asyncio

    try:
        body = await request.json()
    except Exception:
        return JSONResponse(
            {"error": {"message": "invalid JSON body"}}, status_code=400
        )

    messages = body.get("messages") or []
    tools = body.get("tools")
    model = body.get("model") or "edgerunner-local"
    stream = bool(body.get("stream"))
    max_tokens = min(
        int(body.get("max_tokens") or MAX_COMPLETION_TOKENS),
        MAX_COMPLETION_TOKENS,
    )
    temperature = float(body.get("temperature") or 0.2)

    converted = convert_messages(messages, tools)
    loop = asyncio.get_running_loop()
    try:
        raw = await loop.run_in_executor(
            None, lambda: _generate(converted, max_tokens=max_tokens, temperature=temperature)
        )
    except Exception as e:
        return JSONResponse(
            {"error": {"message": f"generation failed: {e}"}},
            status_code=500,
        )

    content, tool_calls = parse_tool_calls(raw)

    if stream:
        return StreamingResponse(
            _sse_chunks(model, content, tool_calls),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )
    return JSONResponse(_completion_payload(model, content, tool_calls))
