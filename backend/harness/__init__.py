"""EdgeRunner coding harness — SOTA-inspired agent loop + MCP tools."""

# Lazy exports so lightweight modules (language/sandbox) import without langchain.


def __getattr__(name: str):
    if name in ("run_coding_harness", "set_harness_progress"):
        from harness.pipeline import run_coding_harness, set_harness_progress

        return {
            "run_coding_harness": run_coding_harness,
            "set_harness_progress": set_harness_progress,
        }[name]
    if name in ("looks_like_coding_task", "simple_chat", "set_routing_progress"):
        from harness.routing import (
            looks_like_coding_task,
            set_routing_progress,
            simple_chat,
        )

        return {
            "looks_like_coding_task": looks_like_coding_task,
            "simple_chat": simple_chat,
            "set_routing_progress": set_routing_progress,
        }[name]
    raise AttributeError(name)


__all__ = [
    "run_coding_harness",
    "looks_like_coding_task",
    "simple_chat",
    "set_harness_progress",
    "set_routing_progress",
]
