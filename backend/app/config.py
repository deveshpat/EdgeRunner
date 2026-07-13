"""Runtime configuration, read from the environment.

On the Kaggle node these point the FastAPI backend at the local llama-server
process. Everything has a sensible local-dev default.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    # Base URL of the llama.cpp `llama-server` (OpenAI-compatible API).
    llamacpp_base_url: str = os.getenv("LLAMACPP_BASE_URL", "http://localhost:8080")
    # Optional API key if llama-server was started with --api-key.
    llamacpp_api_key: str | None = os.getenv("LLAMACPP_API_KEY") or None
    # Seconds to wait when connecting to llama-server before giving up.
    llamacpp_connect_timeout: float = float(os.getenv("LLAMACPP_CONNECT_TIMEOUT", "5"))
    # Overall read timeout for a streaming generation (long — models are slow).
    llamacpp_read_timeout: float = float(os.getenv("LLAMACPP_READ_TIMEOUT", "600"))


settings = Settings()
