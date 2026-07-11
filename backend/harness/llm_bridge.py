"""Avoid circular imports: agent registers the LLM getter; harness uses it."""

from __future__ import annotations

from typing import Any, Callable, Optional

_get_llm: Optional[Callable[[], Any]] = None


def register_llm_getter(fn: Callable[[], Any]) -> None:
    global _get_llm
    _get_llm = fn


def get_llm() -> Any:
    if _get_llm is None:
        raise RuntimeError("LLM getter not registered (call register_llm_getter from agent)")
    return _get_llm()
