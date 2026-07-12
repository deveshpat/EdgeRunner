"""
Hermes Agent engine for EdgeRunner.

Runs the real hermes-agent (github.com/NousResearch/hermes-agent, MIT,
pinned in kaggle_worker/bootstrap.py) as the conversation/tool loop,
pointed at EdgeRunner's own OpenAI-compatible shim (openai_shim.py) so it
drives the in-process GGUF — no second model load, no external provider.

Hermes brings its exact loop: tool calling, todo tracking, memory manager,
skills (self-improving), context compression, subagent delegation. Its
home directory lives under /kaggle/working so learned skills and memory
persist across worker sessions via the kernel output data source.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Callable, Optional

_progress_cb: Optional[Callable[[str], None]] = None

# One Hermes conversation per worker session (persists history in-process;
# durable state lives in HERMES_HOME).
_agent = None
_agent_lock = threading.Lock()

HERMES_TOOLSETS = ["coding", "todo", "memory", "code_execution"]
HERMES_MAX_ITERATIONS = int(os.environ.get("EDGERUNNER_HERMES_MAX_ITER", "40"))


def set_progress(cb: Optional[Callable[[str], None]]) -> None:
    global _progress_cb
    _progress_cb = cb


def _progress(msg: str) -> None:
    print(msg, flush=True)
    if _progress_cb is not None:
        try:
            _progress_cb(msg)
        except Exception:
            pass


def _hermes_home() -> str:
    if Path("/kaggle/working").is_dir():
        return "/kaggle/working/edgerunner/hermes_home"
    return str(Path.home() / ".edgerunner" / "hermes_home")


def hermes_available() -> bool:
    try:
        import run_agent  # noqa: F401 — hermes-agent top-level module

        return hasattr(run_agent, "AIAgent")
    except Exception:
        return False


def _emit_token(text: str) -> None:
    from harness.generate import get_token_callback

    cb = get_token_callback()
    if cb is not None and text:
        try:
            cb(text)
        except Exception:
            pass


def _build_agent(model_name: str):
    os.environ.setdefault("HERMES_HOME", _hermes_home())
    Path(os.environ["HERMES_HOME"]).mkdir(parents=True, exist_ok=True)

    from run_agent import AIAgent

    thoughts: list[str] = []

    def on_status(msg) -> None:
        _progress(str(msg))

    def on_tool_start(name, *args, **kwargs) -> None:
        _progress(f"🔧 {name}")

    def on_delta(text) -> None:
        _emit_token(str(text))

    def on_thinking(text) -> None:
        t = str(text).strip()
        if t:
            thoughts.append(t)

    agent = AIAgent(
        base_url=f"http://127.0.0.1:{os.environ.get('PORT', '8000')}/v1",
        api_key="edgerunner-local",
        model=model_name,
        max_iterations=HERMES_MAX_ITERATIONS,
        tool_delay=0.0,
        enabled_toolsets=HERMES_TOOLSETS,
        quiet_mode=True,
        status_callback=on_status,
        tool_start_callback=on_tool_start,
        stream_delta_callback=on_delta,
        thinking_callback=on_thinking,
        skip_context_files=True,
    )
    agent._edgerunner_thoughts = thoughts
    return agent


def run_hermes_message(
    user_text: str,
    history: Optional[list] = None,
    system_extra: str = "",
) -> dict:
    """Run one Hermes conversation turn. Raises on failure (caller falls back)."""
    global _agent

    from er_agent import get_model_meta, is_model_ready, load_model

    if not is_model_ready():
        load_model()
    model_name = get_model_meta().get("name") or "edgerunner-local"

    with _agent_lock:
        if _agent is None:
            _progress("☤ Hermes engine starting…")
            _agent = _build_agent(model_name)
        agent = _agent

    thoughts: list[str] = getattr(agent, "_edgerunner_thoughts", [])
    thoughts.clear()

    conversation_history = None
    if history:
        conversation_history = [
            {"role": m.get("role"), "content": m.get("content") or ""}
            if isinstance(m, dict)
            else {"role": getattr(m, "role", "user"), "content": getattr(m, "content", "")}
            for m in history
            if (m.get("role") if isinstance(m, dict) else getattr(m, "role", ""))
            in ("user", "assistant")
        ]

    kwargs = {}
    if system_extra:
        kwargs["system_message"] = None  # let hermes build its own
        agent.ephemeral_system_prompt = system_extra[:1500]

    result = agent.run_conversation(
        user_text,
        conversation_history=conversation_history,
        **kwargs,
    )
    final = (result or {}).get("final_response") or ""
    return {
        "mode": "hermes",
        "response": final,
        "thought_process": list(thoughts)
        or ["Hermes Agent turn (tool loop ran server-side)."],
        "code": "",
        "terminal_output": "",
    }
