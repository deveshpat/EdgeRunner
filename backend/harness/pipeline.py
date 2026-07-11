"""
Coding harness pipeline.

Primary path (default): OpenCode-style tool loop
  build|plan agent · bash/read/write/edit/grep/glob/apply_patch/todo · max steps

Legacy path (EDGERUNNER_HARNESS=langgraph):
  plan+tests → implement → execute (sandbox ACI) → reflect on fail → implement …
  Optional tool calls between steps via MCP / builtin ToolHub.
"""

from __future__ import annotations

import os
import operator
from typing import Annotated, Optional, Sequence, TypedDict

from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langgraph.graph import END, StateGraph

from harness.language import detect_language, extract_fenced_code, LangSpec
from harness.mcp_client import ToolHub, parse_tool_calls
from harness.prompts import implement, plan_and_tests, reflect
from harness.sandbox import run_solution_and_tests


# Progress callback injected from agent.py / main.py
_progress_cb = None


def set_harness_progress(cb) -> None:
    global _progress_cb
    _progress_cb = cb
    # Keep OpenCode loop progress in sync
    try:
        from harness.agent_loop import set_loop_progress

        set_loop_progress(cb)
    except Exception:
        pass


def _progress(msg: str) -> None:
    print(msg, flush=True)
    cb = _progress_cb
    if cb is not None:
        try:
            cb(msg)
        except Exception:
            pass


def _invoke_text(prompt: str, *, max_tokens: int = 1500) -> str:
    from harness.llm_bridge import get_llm

    llm = get_llm()
    try:
        bound = llm.bind(max_tokens=max_tokens) if hasattr(llm, "bind") else llm
        response = bound.invoke([HumanMessage(content=prompt)])
    except Exception:
        response = llm.invoke([HumanMessage(content=prompt)])
    return (getattr(response, "content", None) or str(response)).strip()


class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], operator.add]
    task: str
    lang_id: str
    plan: str
    tests: str
    code: str
    reflection: str
    terminal_output: str
    iterations: int
    tools_used: list


def _lang(state: AgentState) -> LangSpec:
    return detect_language(state.get("task") or "", state.get("code") or "")


def node_plan(state: AgentState):
    _progress("🧠 [Harness] Planning & writing tests (tests-first)…")
    lang = detect_language(state["task"])
    prompt = plan_and_tests(state["task"], lang)

    # Optional: allow one tool probe for runtime availability
    hub = ToolHub.create()
    try:
        which = hub.call("which", {"name": "python"})
        tool_note = f"\n(worker which python: {which.content})"
    except Exception:
        tool_note = ""
    finally:
        hub.close()

    text = _invoke_text(prompt + tool_note, max_tokens=1200)
    tests = extract_fenced_code(text, preferred=lang.fence)
    return {
        "lang_id": lang.id,
        "plan": text,
        "tests": tests,
        "reflection": "",
        "messages": [AIMessage(content=f"**1. Plan & tests ({lang.id}):**\n{text}")],
    }


def node_code(state: AgentState):
    _progress("💻 [Harness] Implementing solution…")
    lang = _lang(state)
    prompt = implement(
        state["task"],
        lang,
        state.get("plan") or "",
        state.get("tests") or "",
        reflection=state.get("reflection") or "",
    )
    text = _invoke_text(prompt, max_tokens=1800)

    # Honor optional tool calls (e.g. which node) then re-prompt lightly
    calls = parse_tool_calls(text)
    tools_used = list(state.get("tools_used") or [])
    if calls:
        hub = ToolHub.create()
        try:
            obs_parts = []
            for name, args in calls[:3]:
                _progress(f"🔧 [Tool] {name}…")
                res = hub.call(name, args)
                tools_used.append(name)
                obs_parts.append(f"{name} → {res.content[:800]}")
            if obs_parts:
                prompt2 = (
                    prompt
                    + "\n\nTool observations:\n"
                    + "\n".join(obs_parts)
                    + "\n\nNow output the full solution code fence only."
                )
                text = _invoke_text(prompt2, max_tokens=1800)
        finally:
            hub.close()

    code = extract_fenced_code(text, preferred=lang.fence)
    if not code:
        code = extract_fenced_code(text)

    return {
        "code": code,
        "lang_id": lang.id,
        "iterations": int(state.get("iterations") or 0) + 1,
        "tools_used": tools_used,
        "messages": [
            AIMessage(
                content=(
                    f"**2. Implementation (iter {int(state.get('iterations') or 0) + 1}):**\n"
                    f"```{lang.fence}\n{code}\n```"
                )
            )
        ],
    }


def node_execute(state: AgentState):
    _progress("⚙️ [Harness] Running sandboxed tests…")
    lang = _lang(state)
    code = state.get("code") or ""
    tests = state.get("tests") or ""

    if not code.strip():
        obs = "status: FAILED\nexit_code: -1\nstderr:\nNo code was generated."
        return {
            "terminal_output": obs,
            "messages": [AIMessage(content=f"**3. Sandbox:**\n```text\n{obs}\n```")],
        }

    result, ws = run_solution_and_tests(lang, code, tests, timeout=20.0)
    try:
        obs = result.observation()
    finally:
        # Keep workspace only if we need files later — always cleanup for now
        ws.cleanup()

    status = "SUCCESS" if result.ok else "FAILED"
    _progress(f"🖥️ [Sandbox] {status} (exit {result.exit_code})")
    return {
        "terminal_output": obs,
        "messages": [AIMessage(content=f"**3. Sandbox execution:**\n```text\n{obs}\n```")],
    }


def node_reflect(state: AgentState):
    _progress("🔍 [Harness] Reflecting on failure (ReAct critic)…")
    lang = _lang(state)
    text = _invoke_text(
        reflect(
            state["task"],
            lang,
            state.get("code") or "",
            state.get("tests") or "",
            state.get("terminal_output") or "",
        ),
        max_tokens=600,
    )
    return {
        "reflection": text,
        "messages": [AIMessage(content=f"**4. Reflection:**\n{text}")],
    }


def should_continue(state: AgentState) -> str:
    out = state.get("terminal_output") or ""
    iterations = int(state.get("iterations") or 0)
    if "status: SUCCESS" in out or "✅ SUCCESS" in out:
        return "end"
    if iterations >= 3:
        return "end"
    # Reflect then rewrite
    return "reflect"


def after_reflect(state: AgentState) -> str:
    return "code"


def build_graph():
    g = StateGraph(AgentState)
    g.add_node("plan", node_plan)
    g.add_node("code", node_code)
    g.add_node("execute", node_execute)
    g.add_node("reflect", node_reflect)
    g.set_entry_point("plan")
    g.add_edge("plan", "code")
    g.add_edge("code", "execute")
    g.add_conditional_edges(
        "execute",
        should_continue,
        {"reflect": "reflect", "end": END},
    )
    g.add_edge("reflect", "code")
    return g.compile()


_app = None


def _app_graph():
    global _app
    if _app is None:
        _app = build_graph()
    return _app


def run_coding_harness(
    user_text: str,
    *,
    agent: Optional[str] = None,
) -> dict:
    """
    Coding harness entry — best-of combination (see docs/HARNESS.md).

    EDGERUNNER_HARNESS:
      best | auto | phased  → phase-gated tools (best for GGUF)  [default]
      opencode | tools      → free-form OpenCode tool loop
      langgraph | legacy    → plan→test→reflect graph
    """
    mode = (os.environ.get("EDGERUNNER_HARNESS") or "best").strip().lower()

    from harness.commands import resolve_slash

    resolved = resolve_slash(user_text, default_agent=agent or "build")
    plan_mode = resolved.agent == "plan" or (agent or "").lower() == "plan"
    task = resolved.task

    # Plan-only always uses OpenCode plan agent (readonly)
    if plan_mode and mode not in ("langgraph", "legacy", "pipeline", "graph"):
        from harness.agent_loop import run_opencode_style_agent, set_loop_progress

        set_loop_progress(_progress_cb)
        _progress("🧠 [Harness] Plan agent (readonly)…")
        return run_opencode_style_agent(task, plan_mode=True)

    if mode in ("langgraph", "legacy", "pipeline", "graph"):
        return _run_langgraph_harness(task)

    if mode in ("opencode", "tools", "open"):
        from harness.agent_loop import run_opencode_style_agent, set_loop_progress

        set_loop_progress(_progress_cb)
        _progress("🧠 [Harness] OpenCode-style Build agent…")
        return run_opencode_style_agent(task, plan_mode=False)

    # Default: phased (statewright + Aider + SWE-agent + OpenCode tools)
    from harness.phased_loop import run_phased_agent, set_phased_progress

    set_phased_progress(_progress_cb)
    _progress("🧠 [Harness] Best-of phased agent (PLAN→CODE→VERIFY→REFLECT)…")
    return run_phased_agent(task)


def _run_langgraph_harness(user_text: str) -> dict:
    """Legacy plan → implement → sandbox → reflect loop."""
    _progress("🧠 [Harness] Starting langgraph coding harness…")
    lang = detect_language(user_text)
    initial: AgentState = {
        "messages": [HumanMessage(content=user_text)],
        "task": user_text,
        "lang_id": lang.id,
        "plan": "",
        "tests": "",
        "code": "",
        "reflection": "",
        "terminal_output": "",
        "iterations": 0,
        "tools_used": [],
    }
    result = _app_graph().invoke(initial)
    thought = [m.content for m in result["messages"][1:]]
    code = result.get("code") or ""
    terminal = result.get("terminal_output") or ""
    lang_id = result.get("lang_id") or lang.id
    fence = detect_language(user_text, code).fence

    success = "status: SUCCESS" in terminal
    header = "### Solution" if success else "### Solution (tests not fully green)"
    final_response = (
        f"{header}\n\n```{fence}\n{code}\n```\n\n"
        f"### Execution\n```text\n{terminal}\n```\n"
    )
    if result.get("tools_used"):
        final_response += f"\n_Tools used: {', '.join(result['tools_used'])}_\n"

    _progress("✅ [Harness] Complete.")
    return {
        "mode": "harness",
        "response": final_response,
        "thought_process": thought,
        "code": code,
        "terminal_output": terminal,
        "lang": lang_id,
    }
