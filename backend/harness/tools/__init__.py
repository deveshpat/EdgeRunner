"""OpenCode-parity tool registry for EdgeRunner (GGUF-friendly text protocol)."""

from harness.tools.registry import (
    ToolDef,
    ToolRegistry,
    ToolResult,
    parse_tool_calls,
)

__all__ = [
    "ToolDef",
    "ToolRegistry",
    "ToolResult",
    "parse_tool_calls",
]
