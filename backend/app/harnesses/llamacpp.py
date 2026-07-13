"""Real harness: streams from a llama.cpp `llama-server` over HTTP.

`llama-server` exposes an OpenAI-compatible API. We POST to
`/v1/chat/completions` with `stream: true` and translate the SSE delta frames
it returns into EdgeRunner `StreamEvent`s.

The server is expected to run on the same node (Kaggle GPU box); its URL comes
from `LLAMACPP_BASE_URL`. See `deploy/kaggle_bootstrap.sh`.
"""

from __future__ import annotations

import json
from typing import AsyncIterator

import httpx

from app.config import settings
from app.harnesses.base import Harness, StreamEvent
from app.schemas import ChatRequest

# llama-server's default sampling when the request omits a value.
DEFAULT_TEMPERATURE = 0.7
DEFAULT_TOP_P = 0.95
DEFAULT_MAX_TOKENS = 1024


class LlamaCppHarness(Harness):
    id = "llamacpp"
    name = "llama.cpp (live)"
    description = "Streams from a llama.cpp llama-server running a local GGUF model."

    def _payload(self, request: ChatRequest) -> dict:
        return {
            "model": request.model,
            "messages": [m.model_dump() for m in request.messages],
            "stream": True,
            "temperature": request.temperature
            if request.temperature is not None
            else DEFAULT_TEMPERATURE,
            "top_p": request.top_p if request.top_p is not None else DEFAULT_TOP_P,
            "max_tokens": request.max_tokens
            if request.max_tokens is not None
            else DEFAULT_MAX_TOKENS,
        }

    async def run(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        headers = {"Content-Type": "application/json"}
        if settings.llamacpp_api_key:
            headers["Authorization"] = f"Bearer {settings.llamacpp_api_key}"

        timeout = httpx.Timeout(
            settings.llamacpp_read_timeout,
            connect=settings.llamacpp_connect_timeout,
        )
        url = f"{settings.llamacpp_base_url.rstrip('/')}/v1/chat/completions"

        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                async with client.stream(
                    "POST", url, json=self._payload(request), headers=headers
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
                        token = _extract_delta(data)
                        if token:
                            yield StreamEvent(type="token", data=token)
        except httpx.ConnectError:
            yield StreamEvent(
                type="error",
                data=(
                    f"Could not connect to llama-server at "
                    f"{settings.llamacpp_base_url}. Is it running?"
                ),
            )
            return
        except httpx.TimeoutException:
            yield StreamEvent(type="error", data="llama-server timed out.")
            return

        yield StreamEvent(type="done")


def _extract_delta(data: str) -> str:
    """Pull the incremental text out of one OpenAI-style SSE chunk."""
    try:
        chunk = json.loads(data)
    except json.JSONDecodeError:
        return ""
    choices = chunk.get("choices") or []
    if not choices:
        return ""
    delta = choices[0].get("delta") or {}
    return delta.get("content") or ""
