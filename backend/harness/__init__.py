"""EdgeRunner coding harness — best-of SOTA agent loop + MCP tools.

See docs/HARNESS.md for the research synthesis (OpenCode, SWE-agent, Aider,
Claude Code, CodeAct, phased tools).
"""

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
    if name == "run_opencode_style_agent":
        from harness.agent_loop import run_opencode_style_agent

        return run_opencode_style_agent
    if name == "run_phased_agent":
        from harness.phased_loop import run_phased_agent

        return run_phased_agent
    raise AttributeError(name)


__all__ = [
    "run_coding_harness",
    "run_opencode_style_agent",
    "run_phased_agent",
    "looks_like_coding_task",
    "simple_chat",
    "set_harness_progress",
    "set_routing_progress",
]
