"""Harness registry.

Central place to register available harnesses and look them up by id.
"""

from __future__ import annotations

from app.harnesses.agent import AgentHarness
from app.harnesses.base import Harness, StreamEvent
from app.harnesses.echo import EchoHarness
from app.harnesses.llamacpp import LlamaCppHarness
from app.harnesses.terminal import TerminalHarness

_REGISTRY: dict[str, Harness] = {}

chat_harness = LlamaCppHarness()
agent_harness = AgentHarness()
terminal_harness = TerminalHarness()
echo_harness = EchoHarness()

# Register built-in harnesses
_REGISTRY["chat"] = chat_harness
_REGISTRY["llamacpp"] = chat_harness
_REGISTRY["agent"] = agent_harness
_REGISTRY["deepseek"] = agent_harness
_REGISTRY["dsh"] = agent_harness
_REGISTRY["terminal"] = terminal_harness
_REGISTRY["echo"] = echo_harness


def register(harness: Harness) -> None:
    _REGISTRY[harness.id] = harness


def get(harness_id: str) -> Harness | None:
    return _REGISTRY.get(harness_id)


def all_harnesses() -> list[Harness]:
    """Return the visible public harnesses: Agent, Chat, Terminal."""
    return [agent_harness, chat_harness, terminal_harness]


__all__ = ["Harness", "StreamEvent", "register", "get", "all_harnesses"]
