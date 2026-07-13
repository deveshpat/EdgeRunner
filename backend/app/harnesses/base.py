"""Harness interface.

A harness turns a chat request into a stream of events. Concrete harnesses
(echo mock, llama.cpp-on-Kaggle, etc.) implement `run`.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from typing import AsyncIterator, Literal

from app.schemas import ChatRequest

EventType = Literal["token", "tool_call", "tool_result", "done", "error"]


@dataclass
class StreamEvent:
    """A single event in a harness response stream."""

    type: EventType
    data: str = ""

    def to_sse(self) -> str:
        """Serialise as a Server-Sent Events frame."""
        import json

        payload = json.dumps({"type": self.type, "data": self.data})
        return f"data: {payload}\n\n"


class Harness(abc.ABC):
    """Base class for all harnesses."""

    id: str
    name: str
    description: str = ""

    @abc.abstractmethod
    async def run(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        """Stream events for the given chat request."""
        raise NotImplementedError
        yield  # pragma: no cover - makes this an async generator
