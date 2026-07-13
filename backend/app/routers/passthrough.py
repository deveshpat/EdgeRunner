"""Passthrough proxy to the local llama-server's OpenAI-compatible API.

Exposes /v1/* through the same origin (and tunnel) as the rest of the app, so
the browser can talk to the raw model directly (used by the browser-hosted
agent) without a separate tunnel. CORS is already wide-open on the app.
"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
import httpx

from app.config import settings

router = APIRouter(tags=["passthrough"])


@router.api_route("/v1/{path:path}", methods=["GET", "POST"])
async def proxy_v1(path: str, request: Request) -> StreamingResponse:
    url = f"{settings.llamacpp_base_url.rstrip('/')}/v1/{path}"
    body = await request.body()
    timeout = httpx.Timeout(
        settings.llamacpp_read_timeout, connect=settings.llamacpp_connect_timeout
    )
    client = httpx.AsyncClient(timeout=timeout)
    req = client.build_request(
        request.method,
        url,
        content=body,
        params=request.query_params,
        headers={"content-type": request.headers.get("content-type", "application/json")},
    )
    try:
        resp = await client.send(req, stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        return StreamingResponse(
            iter([f'{{"error":"llama-server unreachable: {exc}"}}'.encode()]),
            status_code=502,
            media_type="application/json",
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
