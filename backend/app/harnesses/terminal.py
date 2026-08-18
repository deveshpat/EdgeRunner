"""Terminal harness: direct shell command execution in the workspace sandbox."""

from __future__ import annotations

import asyncio
from typing import AsyncIterator

from app import tools
from app.harnesses.base import Harness, StreamEvent
from app.schemas import ChatRequest


class TerminalHarness(Harness):
    id = "terminal"
    name = "Terminal"
    description = "Direct interactive shell command execution in the shared workspace sandbox."

    async def run(self, request: ChatRequest) -> AsyncIterator[StreamEvent]:
        # Get the last user message as the shell command
        last_user = next(
            (m.content for m in reversed(request.messages) if m.role == "user"),
            "",
        ).strip()

        if not last_user:
            yield StreamEvent(type="token", data="error: no command provided\n")
            yield StreamEvent(type="done")
            return

        # Execute in workspace
        out, code = tools.run_command(last_user)

        # Format output
        header = f"```\n"
        yield StreamEvent(type="token", data=header)
        await asyncio.sleep(0.01)

        for line in out.splitlines(keepends=True):
            yield StreamEvent(type="token", data=line)
            await asyncio.sleep(0.005)

        footer = f"\n```\n`● exit {code}`" if code != 0 else "\n```\n`● exit 0`"
        yield StreamEvent(type="token", data=footer)
        yield StreamEvent(type="done")
