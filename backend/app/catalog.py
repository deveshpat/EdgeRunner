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

# Curated models matching frontend LAUNCH_MODELS.
CURATED_MODELS: list[Model] = [
    Model(
        id="DeepSeek-V4-Pro-Qwen3.5-4B.Q4_K_M",
        name="DeepSeek-V4 Pro 4B [SOTA REASONING EDGE CORE]",
        description="Distilled from DeepSeek-V4-Pro; ultra-fast 2026 frontier reasoning on CPU or GPU edge nodes.",
        context_length=65536,
    ),
    Model(
        id="DeepSeek-V4-Pro-Qwen3.5-9B.Q4_K_M",
        name="DeepSeek-V4 Pro 9B [SOTA REASONING PAYLOAD]",
        description="High-precision DeepSeek-V4-Pro reasoning engine (~5.5 GB) fitting 100% in 16GB VRAM.",
        context_length=65536,
    ),
    Model(
        id="Qwen3.5-4B-Q4_K_M",
        name="Qwen3.5 4B [FAST DEFAULT EDGE CORE]",
        description="Ultra-responsive 2026 default core (~2.6 GB) for rapid prompt synthesis on CPU or GPU edge nodes.",
        context_length=32768,
    ),
    Model(
        id="Qwen3.8-27B-Q4_K_M",
        name="Qwen3.8 27B [ALIBABA SOTA OPEN-WEIGHTS]",
        description="Released August 14, 2026; Alibaba's premier open-weights foundation for local & edge compute.",
        context_length=65536,
    ),
    Model(
        id="Qwen3-Coder-30B-A3B-Instruct-Q4_K_M",
        name="Qwen3 Coder 30B [SOTA CODE & AGENT]",
        description="Alibaba's 2026 flagship coding engine with 10M+ downloads for autonomous coding and tools.",
        context_length=65536,
    ),
    Model(
        id="Qwen3.5-9B-Q4_K_M",
        name="Qwen3.5 9B [ALL-ROUNDER PAYLOAD]",
        description="High-capability 9B model that fits 100% in 16GB VRAM at peak token generation speed.",
        context_length=32768,
    ),
    Model(
        id="gemma-4-26B-A4B-it-MXFP4_MOE",
        name="Gemma 4 26B [GOOGLE OPEN SOTA]",
        description="Google's 2026 flagship Gemma 4 MoE architecture; high speed and multimodal reasoning.",
        context_length=65536,
    ),
    Model(
        id="Bonsai-27B-dspark-Q4_1",
        name="Bonsai 27B [PRISM ML REASONING]",
        description="DSpark-quantized 27B model for high throughput and agentic memory tasks.",
        context_length=32768,
    ),
    Model(
        id="Laguna-XS-2.1-APEX-Compact",
        name="Laguna XS 2.1 [APEX COMPACT]",
        description="High-performance compact apex architecture for low-latency edge deployment.",
        context_length=32768,
    ),
    Model(
        id="Qwen3.5-4B-Q8_0",
        name="Qwen3.5 4B Q8 [HIGH-PRECISION 4B]",
        description="Full 8-bit uncompressed precision 4B model for highest accuracy outputs.",
        context_length=32768,
    ),
]

STATIC_MODELS = CURATED_MODELS
MODELS = STATIC_MODELS


async def get_models() -> list[Model]:
    """Return curated models with the live llama-server model highlighted and prioritized."""
    live = await _fetch_live_models()
    if not live:
        return CURATED_MODELS

    live_id = live[0].id
    clean_live_id = live_id.replace(".gguf", "").lower()

    # Find if the live model matches any curated model
    matched_cm: Model | None = None
    remaining_curated: list[Model] = []

    for cm in CURATED_MODELS:
        clean_cm_id = cm.id.replace(".gguf", "").lower()
        if clean_cm_id == clean_live_id or clean_live_id in clean_cm_id or clean_cm_id in clean_live_id:
            matched_cm = Model(
                id=live_id,
                name=f"{cm.name} [MOUNTED]",
                description=f"Active in llama-server :: {cm.description}",
                context_length=cm.context_length,
            )
        else:
            remaining_curated.append(cm)

    active_model = matched_cm or Model(
        id=live_id,
        name=f"{live_id} [MOUNTED]",
        description="Active in llama-server.",
        context_length=live[0].context_length,
    )

    return [active_model] + remaining_curated


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
