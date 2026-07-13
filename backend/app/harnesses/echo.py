"""Mock harness that streams a canned reply token-by-token.

Lets the full frontend<->backend streaming loop run locally with no GPU.
Swap for a real llama.cpp harness by implementing the same `run` interface.
"""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

from app.harnesses.base import Harness, StreamEvent
from app.schemas import ChatRequest


class EchoHarness(Harness):
    id = "echo"
    name = "Echo (mock)"
    description = "Streams a canned reply. No model required — for local dev."

    # seconds between tokens, to simulate generation latency
    token_delay = 0.04

    async def run(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        last_user = next(
            (m.content for m in reversed(request.messages) if m.role == "user"),
            "",
        )
        reply = (
            f"[{self.name} via {request.model}] "
            f"You said: {last_user!r}. "
            "This is a mock stream — wire up a real harness to see live tokens."
        )
        for word in reply.split(" "):
            await asyncio.sleep(self.token_delay)
            yield StreamEvent(type="token", data=word + " ")
        yield StreamEvent(type="done")
