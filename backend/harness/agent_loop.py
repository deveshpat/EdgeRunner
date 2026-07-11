"""
OpenCode-inspired agent loop for EdgeRunner.

OpenCode architecture (anomalyco/opencode packages/core + packages/opencode):
  - Session runner streams one LLM turn with registered tools
  - Tool calls are settled (executed), results appended, loop continues
  - Primary agents: build (default) and plan (readonly)
  - Max steps bound the loop; final text-only turn when limit hit
  - Built-in tools: bash, read, write, edit, grep, glob, apply_patch, todo, …

EdgeRunner adaptation for local GGUF (often no native tool JSON mode):
  - Same tool set + `done` / `run_python`
  - Tools invoked via <tool name="…">{…}</tool> text protocol
  - Workspace sandbox per run
  - History-aware task text still comes from routing
"""

from __future__ import annotations

import os
import re
from typing import Optional

from langchain_core.messages import HumanMessage

from harness.language import extract_fenced_code
from harness.tools.registry import ToolRegistry, parse_tool_calls

_progress_cb = None

# Mirrors OpenCode session runner step limits
MAX_STEPS_DEFAULT = int(os.environ.get("EDGERUNNER_MAX_STEPS", "20"))
MAX_STEPS_PLAN = int(os.environ.get("EDGERUNNER_MAX_STEPS_PLAN", "12"))

# Exact spirit of OpenCode packages/core/src/session/runner/max-steps.ts
MAX_STEPS_PROMPT = """CRITICAL - MAXIMUM STEPS REACHED

The maximum number of steps allowed for this task has been reached. Tools are disabled until next user input. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls (no reads, writes, edits, searches, or any other tools)
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions, including any user requests for edits or tool use

Response must include:
- Statement that maximum steps for this agent have been reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY."""

BUILD_SYSTEM = """You are EdgeRunner Build agent — an OpenCode-style coding agent.

You solve the user task by using tools in a workspace. Workflow:
1) For multi-step work, set todos with todowrite
2) Write or edit code with write / edit / apply_patch
3) Verify with bash or run_python (run real tests — do not invent pass results)
4) Call done with a clear summary when finished

Rules (OpenCode-aligned):
- Prefer small edit steps over huge rewrites when fixing failures
- You MUST read a file before editing it
- Prefer editing existing files over rewriting from scratch
- After writing code, run tests; fix until green, then done
- Paths are workspace-relative
- For pure coding exercises (e.g. reverse a string), create solution.py (+ tests), run them, fix, then done
- Never claim success without running verification tools

Tool call format (required):
<tool name="write">
{"path": "solution.py", "content": "def reverse_string(s):\\n    return s[::-1]\\n"}
</tool>
"""

PLAN_SYSTEM = """You are EdgeRunner Plan agent (OpenCode plan mode).

You may only use readonly tools (read, grep, glob, list_dir, webfetch, todowrite, done).
Analyze the task and propose a concrete implementation plan with steps and risks.
Do not write or edit files. Call done with the plan when ready.
"""


def set_loop_progress(cb) -> None:
    global _progress_cb
    _progress_cb = cb


def _progress(msg: str) -> None:
    print(msg, flush=True)
    if _progress_cb is not None:
        try:
            _progress_cb(msg)
        except Exception:
            pass


def _llm_text(prompt: str, *, max_tokens: int = 1200) -> str:
    from harness.llm_bridge import get_llm

    llm = get_llm()
    try:
        bound = llm.bind(max_tokens=max_tokens) if hasattr(llm, "bind") else llm
        response = bound.invoke([HumanMessage(content=prompt)])
    except Exception:
        response = llm.invoke([HumanMessage(content=prompt)])
    return (getattr(response, "content", None) or str(response)).strip()


def _wants_plan_mode(task: str) -> bool:
    t = (task or "").lower()
    return bool(
        re.search(
            r"\b(plan only|don't (edit|write|change)|do not (edit|write|change)|"
            r"read only|readonly|analyze only|review only|planning mode)\b",
            t,
        )
    )


def _extract_assert_hints(task: str) -> list[str]:
    """Pull simple assert-like expectations from the user task for auto-tests."""
    hints = []
    for m in re.finditer(
        r"(?:assert|expect|should\s+(?:return|be)|e\.g\.|example)[:\s]+(.+)",
        task or "",
        re.I,
    ):
        hints.append(m.group(0).strip()[:200])
    # reverse string common cases
    if re.search(r"reverse\s+(a\s+)?string", task or "", re.I):
        hints.extend(
            [
                "assert reverse_string('hello') == 'olleh'",
                "assert reverse_string('') == ''",
                "assert reverse_string('ab') == 'ba'",
            ]
        )
    return hints[:8]


def _auto_tests_for_solution(task: str) -> str:
    hints = _extract_assert_hints(task)
    assert_lines = "\n".join(f"    {h}" if h.startswith("assert") else f"    # {h}" for h in hints)
    if not any(h.startswith("assert") for h in hints):
        assert_lines = (
            "    assert fn is not None, 'no public function found in solution'\n"
            "    # smoke: callable returns something for empty/str input\n"
            "    try:\n"
            "        r = fn('') if fn.__code__.co_argcount >= 1 else fn()\n"
            "        assert r is not None or r == '' or r == [] or r == 0\n"
            "    except TypeError:\n"
            "        pass\n"
        )
    return f'''"""Auto-generated smoke tests (OpenCode-style verify step)."""
import solution as sol

def _first_fn():
    for name in ("reverse_string", "reverse", "rev", "solution", "solve", "main", "run"):
        obj = getattr(sol, name, None)
        if callable(obj):
            return obj
    for name in dir(sol):
        if name.startswith("_"):
            continue
        obj = getattr(sol, name)
        if callable(obj):
            return obj
    return None

fn = _first_fn()

def test_main():
{assert_lines if assert_lines.strip() else "    assert fn is not None"}

if __name__ == "__main__":
    test_main()
    print("AUTO_OK")
'''


def _find_solution(tools: ToolRegistry) -> str:
    for candidate in (
        "solution.py",
        "main.py",
        "app.py",
        "index.js",
        "main.go",
        "main.rs",
        "solution.js",
    ):
        p = tools.cwd / candidate
        if p.is_file():
            return p.read_text(encoding="utf-8", errors="replace")
    # any single .py that isn't tests
    pys = [
        p
        for p in tools.cwd.glob("*.py")
        if p.is_file() and not p.name.startswith("test") and "auto" not in p.name
    ]
    if len(pys) == 1:
        return pys[0].read_text(encoding="utf-8", errors="replace")
    return ""


def run_opencode_style_agent(
    task: str,
    *,
    max_steps: Optional[int] = None,
    plan_mode: Optional[bool] = None,
) -> dict:
    """
    Main harness entry: OpenCode-like tool loop (build or plan agent).
    """
    plan = plan_mode if plan_mode is not None else _wants_plan_mode(task)
    steps = max_steps or (MAX_STEPS_PLAN if plan else MAX_STEPS_DEFAULT)
    tools = ToolRegistry()
    system = PLAN_SYSTEM if plan else BUILD_SYSTEM
    tool_block = tools.list_for_prompt(plan_mode=plan)

    transcript: list[str] = []
    thought: list[str] = []
    final_text = ""
    finished = False
    last_reply = ""

    _progress(
        f"⚙️ [OpenCode] {'Plan' if plan else 'Build'} agent · max {steps} steps · ws={tools.cwd.name}"
    )

    seed = (
        f"{system}\n\n{tool_block}\n\n"
        f"## User task\n{task}\n\n"
        "Begin. Use tools now. For a coding exercise, create files under the workspace, "
        "test them, then call done.\n"
    )
    messages_blob = seed

    for step in range(1, steps + 1):
        tools.ctx.step = step
        _progress(f"🔁 [OpenCode] step {step}/{steps}")

        if step == steps:
            prompt = messages_blob + "\n\n" + MAX_STEPS_PROMPT + "\nassistant:"
            final_text = _llm_text(prompt, max_tokens=800)
            thought.append(f"**Step {step} (max):** {final_text[:1500]}")
            break

        prompt = messages_blob + "\nassistant:"
        reply = _llm_text(prompt, max_tokens=1400)
        last_reply = reply
        thought.append(f"**Step {step}:**\n{reply[:2000]}")
        transcript.append(f"assistant:\n{reply}")

        calls = parse_tool_calls(reply)

        # If model only wrote a code fence without tools, auto-materialize (build only)
        if not calls and not plan:
            code = extract_fenced_code(reply, preferred="python")
            if code and step <= 3:
                _progress("📝 [OpenCode] No tool call — auto write solution.py from fence")
                tools.call("write", {"path": "solution.py", "content": code})
                tools.call(
                    "write",
                    {"path": "tests_auto.py", "content": _auto_tests_for_solution(task)},
                )
                calls = [("run_python", {"path": "tests_auto.py"})]
            else:
                messages_blob += (
                    f"\nassistant:\n{reply}\n\n"
                    "user:\nContinue using tools (write/edit/bash/run_python). "
                    "Call done when finished.\n"
                )
                # keep prompt bounded
                if len(messages_blob) > 24000:
                    messages_blob = messages_blob[-20000:]
                continue

        observations: list[str] = []
        # OpenCode settles all tool calls in a turn; cap for GGUF context
        for name, args in calls[:6]:
            if plan and name not in tools.names(plan_mode=True) and tools.resolve_name(name) not in tools.names(
                plan_mode=True
            ):
                res_txt = f"Tool '{name}' blocked in plan mode (readonly only)."
                observations.append(f"### observation:{name}\n{res_txt}")
                thought.append(f"🔧 {name} blocked (plan mode)")
                continue
            _progress(f"🔧 [Tool] {name}")
            result = tools.call(name, args)
            obs = result.observation()
            observations.append(f"### observation:{name}\n{obs}")
            thought.append(
                f"🔧 **{name}** → {'ok' if result.ok else 'error'}\n```\n{obs[:800]}\n```"
            )
            if tools.resolve_name(name) == "done" and result.ok:
                finished = True
                final_text = result.content
                break

        messages_blob += f"\nassistant:\n{reply}\n\n"
        messages_blob += "user:\n" + "\n\n".join(observations) + "\n"
        if not finished:
            messages_blob += (
                "Continue. If tests passed, call done with a summary. "
                "If tests failed, edit and re-run.\n"
            )
        if len(messages_blob) > 24000:
            messages_blob = messages_blob[-20000:]

        if finished:
            break

        # Auto-finish if tests passed and solution exists (model forgot done)
        if tools.ctx.last_test_ok and _find_solution(tools) and step >= 2:
            _progress("✅ [OpenCode] Tests passed — auto done")
            finished = True
            final_text = (
                "Tests passed. Solution is ready "
                f"(auto-completed after successful verification at step {step})."
            )
            break

    if not final_text:
        final_text = last_reply or "Agent stopped without calling done."

    solution_body = _find_solution(tools)
    if not solution_body:
        solution_body = extract_fenced_code(final_text, preferred="python") or extract_fenced_code(
            "\n".join(transcript), preferred="python"
        )

    # Detect language fence for display
    fence = "python"
    if (tools.cwd / "index.js").is_file() or (tools.cwd / "solution.js").is_file():
        fence = "javascript"
    elif (tools.cwd / "main.go").is_file():
        fence = "go"
    elif (tools.cwd / "main.rs").is_file():
        fence = "rust"

    status_line = "✅ complete" if finished else "⚠️ stopped (max steps or incomplete)"
    response = f"### EdgeRunner OpenCode agent ({status_line})\n\n{final_text}\n"
    if solution_body:
        response += f"\n### Solution\n\n```{fence}\n{solution_body.rstrip()}\n```\n"
    if tools.ctx.todos:
        response += "\n### Todos\n"
        for t in tools.ctx.todos:
            if isinstance(t, dict):
                response += f"- [{t.get('status', '?')}] {t.get('content', t.get('id', ''))}\n"
    response += f"\n_Workspace: `{tools.cwd}` · steps: {tools.ctx.step}/{steps} · mode: {'plan' if plan else 'build'}_\n"

    return {
        "mode": "harness",
        "agent": "plan" if plan else "build",
        "response": response,
        "thought_process": thought,
        "code": solution_body,
        "terminal_output": "\n".join(transcript)[-4000:],
        "lang": fence,
        "workspace": str(tools.cwd),
        "finished": finished,
        "tests_ok": tools.ctx.last_test_ok,
    }
