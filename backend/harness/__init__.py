"""EdgeRunner coding harness — one automatic agent loop + tools.

Research basis: docs/HARNESS.md. No multi-mode fallbacks.
"""


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
    if name in ("run_coding_agent", "run_opencode_style_agent"):
        from harness.agent_loop import run_coding_agent, run_opencode_style_agent

        return {
            "run_coding_agent": run_coding_agent,
            "run_opencode_style_agent": run_opencode_style_agent,
        }[name]
    raise AttributeError(name)


__all__ = [
    "run_coding_harness",
    "run_coding_agent",
    "looks_like_coding_task",
    "simple_chat",
    "set_harness_progress",
    "set_routing_progress",
]
