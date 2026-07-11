"""
Coding harness entry — single automatic agent loop.

All research-backed behavior lives in agent_loop.run_coding_agent.
No mode switches, no fallback harnesses.
"""

from __future__ import annotations

from typing import Optional

from harness.agent_loop import run_coding_agent, set_loop_progress
from harness.commands import resolve_slash

_progress_cb = None


def set_harness_progress(cb) -> None:
    global _progress_cb
    _progress_cb = cb
    set_loop_progress(cb)


def _progress(msg: str) -> None:
    print(msg, flush=True)
    if _progress_cb is not None:
        try:
            _progress_cb(msg)
        except Exception:
            pass


def run_coding_harness(
    user_text: str,
    *,
    agent: Optional[str] = None,
) -> dict:
    """
    Hands-free coding path.

    Slash commands and chat history are normalized first; then one agent loop
    runs (plan if the task is analysis-only, otherwise build with automatic
    PLAN→CODE→VERIFY→REFLECT rhythm).
    """
    resolved = resolve_slash(user_text, default_agent=agent or "build")
    plan_mode = resolved.agent == "plan" or (agent or "").lower() == "plan"
    set_loop_progress(_progress_cb)
    _progress(f"🧠 Coding agent ({'plan' if plan_mode else 'build'})…")
    return run_coding_agent(resolved.task, plan_mode=plan_mode)
