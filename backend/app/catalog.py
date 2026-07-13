"""Model catalog.

When a llama-server is reachable we surface whatever model(s) it has actually
loaded (via its OpenAI-compatible `/v1/models`). Otherwise we fall back to a
static placeholder list so the frontend pickers still populate during local dev
with the echo harness.
"""

from __future__ import annotations

import httpx

from app.config import settings
from app.schemas import Model

# Placeholder list used when no llama-server is reachable.
STATIC_MODELS: list[Model] = [
    Model(
        id="qwen2.5-3b-instruct",
        name="Qwen2.5 3B Instruct",
        description="Placeholder — start a llama-server to serve a real model.",
        context_length=32768,
    ),
    Model(
        id="llama-3.2-3b-instruct",
        name="Llama 3.2 3B Instruct",
        description="Placeholder — start a llama-server to serve a real model.",
        context_length=131072,
    ),
]

# Backwards-compatible alias (older imports referenced MODELS).
MODELS = STATIC_MODELS


async def get_models() -> list[Model]:
    """Return live models from llama-server, or the static fallback."""
    live = await _fetch_live_models()
    return live or STATIC_MODELS


async def _fetch_live_models() -> list[Model]:
    url = f"{settings.llamacpp_base_url.rstrip('/')}/v1/models"
    headers = {}
    if settings.llamacpp_api_key:
        headers["Authorization"] = f"Bearer {settings.llamacpp_api_key}"
    try:
        async with httpx.AsyncClient(timeout=settings.llamacpp_connect_timeout) as c:
            resp = await c.get(url, headers=headers)
            resp.raise_for_status()
            data = resp.json().get("data", [])
    except (httpx.HTTPError, ValueError):
        return []

    models: list[Model] = []
    for entry in data:
        model_id = entry.get("id")
        if not model_id:
            continue
        models.append(
            Model(
                id=model_id,
                name=model_id,
                description="Loaded in llama-server.",
                context_length=int(entry.get("meta", {}).get("n_ctx_train", 4096)),
            )
        )
    return models
