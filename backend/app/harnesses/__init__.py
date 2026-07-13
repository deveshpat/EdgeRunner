"""Harness registry.

Central place to register available harnesses and look them up by id.
"""

from __future__ import annotations

from app.harnesses.agent import AgentHarness
from app.harnesses.base import Harness, StreamEvent
from app.harnesses.echo import EchoHarness
from app.harnesses.llamacpp import LlamaCppHarness

_REGISTRY: dict[str, Harness] = {}


def register(harness: Harness) -> None:
    _REGISTRY[harness.id] = harness


def get(harness_id: str) -> Harness | None:
    return _REGISTRY.get(harness_id)


def all_harnesses() -> list[Harness]:
    return list(_REGISTRY.values())


# Register built-in harnesses. Echo stays first so it is the default in the
# picker and local dev works with no llama-server running.
register(EchoHarness())
register(LlamaCppHarness())
register(AgentHarness())

__all__ = ["Harness", "StreamEvent", "register", "get", "all_harnesses"]
