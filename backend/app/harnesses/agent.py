"""Agent Harness for EdgeRunner.

Powered directly by the DeepSeek AI Harness (dsh) runtime architecture:
- Cordis Plugin Meta-Framework
- Dual-Phase <think> Reasoning
- Contextual LinUCB matrix tool routing
- Reflexion episodic memory & platform sandboxing
"""

from __future__ import annotations

import httpx

from app.harnesses.deepseek import (
    DeepSeekHarness,
    MAX_ITERATIONS,
    _consume_chunk,
    _extract_markdown_command,
    _extract_text_tool_calls,
)


class AgentHarness(DeepSeekHarness):
    id = "agent"
    name = "Agent (DeepSeek Cordis Engine)"
    description = (
        "Autonomous DeepSeek Agent Harness (dsh): Cordis plugin-first architecture with "
        "dual-phase <think> reasoning, swappable presets (Code, Standard, Minimal, Creator), "
        "and Contextual LinUCB matrix tool routing."
    )


__all__ = [
    "AgentHarness",
    "MAX_ITERATIONS",
    "httpx",
    "_consume_chunk",
    "_extract_markdown_command",
    "_extract_text_tool_calls",
]
