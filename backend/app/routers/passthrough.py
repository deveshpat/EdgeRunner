"""Passthrough proxy to the local llama-server's OpenAI-compatible API.

Exposes /v1/* through the same origin (and tunnel) as the rest of the app, so
the browser can talk to the raw model directly (used by the browser-hosted
agent) without a separate tunnel. CORS is already wide-open on the app.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
import httpx

from app.catalog import STATIC_MODELS
from app.config import settings

router = APIRouter(tags=["passthrough"])


def _mock_completion_chunk(content: str, model: str, finish_reason: str | None = None) -> str:
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"content": content} if content else {},
                "finish_reason": finish_reason,
            }
        ],
    }
    return f"data: {json.dumps(chunk)}\n\n"


async def _mock_stream_response(model: str, user_text: str):
    prefix = f"[Local Mock via {model}] "
    msg = (
        f"{prefix}llama-server is not running at {settings.llamacpp_base_url}. "
        f"You said: {user_text!r}. "
        "Start a local llama-server or launch the Kaggle GPU backend to chat with a live model."
    )
    for word in msg.split(" "):
        await asyncio.sleep(0.03)
        yield _mock_completion_chunk(word + " ", model).encode("utf-8")
    yield _mock_completion_chunk("", model, finish_reason="stop").encode("utf-8")
    yield b"data: [DONE]\n\n"


@router.api_route("/v1/models", methods=["GET"])
async def proxy_v1_models(request: Request) -> Response:
    url = f"{settings.llamacpp_base_url.rstrip('/')}/v1/models"
    headers: dict[str, str] = {}
    if "authorization" in request.headers:
        headers["authorization"] = request.headers["authorization"]
    elif settings.llamacpp_api_key:
        headers["authorization"] = f"Bearer {settings.llamacpp_api_key}"

    try:
        async with httpx.AsyncClient(timeout=settings.llamacpp_connect_timeout) as client:
            resp = await client.get(url, headers=headers)
            if resp.status_code == 200:
                return Response(
                    content=resp.content,
                    status_code=200,
                    media_type="application/json",
                )
    except (httpx.HTTPError, Exception):
        pass

    # Fallback to static catalog in OpenAI list format
    return JSONResponse(
        content={
            "object": "list",
            "data": [
                {
                    "id": m.id,
                    "object": "model",
                    "created": int(time.time()),
                    "owned_by": "edgerunner",
                }
                for m in STATIC_MODELS
            ],
        }
    )


@router.api_route("/v1/{path:path}", methods=["GET", "POST"])
async def proxy_v1(path: str, request: Request) -> Response:
    url = f"{settings.llamacpp_base_url.rstrip('/')}/v1/{path}"
    body = await request.body()
    timeout = httpx.Timeout(
        settings.llamacpp_read_timeout, connect=settings.llamacpp_connect_timeout
    )
    headers = {"content-type": request.headers.get("content-type", "application/json")}
    if "accept" in request.headers:
        headers["accept"] = request.headers["accept"]
    if "authorization" in request.headers:
        headers["authorization"] = request.headers["authorization"]
    elif settings.llamacpp_api_key:
        headers["authorization"] = f"Bearer {settings.llamacpp_api_key}"

    client = httpx.AsyncClient(timeout=timeout)
    req = client.build_request(
        request.method,
        url,
        content=body,
        params=request.query_params,
        headers=headers,
    )
    try:
        resp = await client.send(req, stream=True)
    except httpx.HTTPError:
        await client.aclose()
        if path == "chat/completions" and request.method == "POST":
            try:
                data = json.loads(body.decode("utf-8")) if body else {}
            except Exception:
                data = {}
            model = data.get("model", "qwen2.5-3b-instruct")
            is_stream = data.get("stream", False)
            messages = data.get("messages", [])
            last_user = next(
                (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
                "",
            )
            if is_stream:
                return StreamingResponse(
                    _mock_stream_response(model, str(last_user)),
                    status_code=200,
                    media_type="text/event-stream",
                    headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
                )
            else:
                reply = (
                    f"[Local Mock via {model}] llama-server is not running at {settings.llamacpp_base_url}. "
                    f"You said: {last_user!r}."
                )
                return JSONResponse(
                    content={
                        "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "message": {"role": "assistant", "content": reply},
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {
                            "prompt_tokens": 10,
                            "completion_tokens": 20,
                            "total_tokens": 30,
                        },
                    },
                    status_code=200,
                )

        return JSONResponse(
            content={"error": f"llama-server unreachable at {settings.llamacpp_base_url}"},
            status_code=503,
        )

    async def gen():
        try:
            async for chunk in resp.aiter_raw():
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(
        gen(),
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )
