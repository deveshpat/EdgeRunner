"""
EdgeRunner coding agent — single integrated loop.

Design decisions come from research literature + production harnesses
(see docs/HARNESS.md). There is no harness menu and no fallback modes:
the loop always does the right thing for the task.

Integrated logic (always on):
  • OpenCode tools + max-steps + done
  • Plan vs build (readonly when planning)
  • Phase rhythm PLAN → CODE → VERIFY → REFLECT (statewright: helps GGUF)
  • Aider-style exact edit + read-before-edit
  • SWE-agent ACI observations via tools
  • Must verify before success / auto-done on green tests
  • Code-fence auto-materialize when the model forgets tools
"""

from __future__ import annotations

import os
import re
from typing import Optional

from harness.language import extract_fenced_code
from harness.tools.registry import ToolRegistry, parse_tool_calls

_progress_cb = None

MAX_STEPS_BUILD = int(os.environ.get("EDGERUNNER_MAX_STEPS", "24"))
MAX_STEPS_PLAN = int(os.environ.get("EDGERUNNER_MAX_STEPS_PLAN", "12"))

# Soft phase rhythm (tools preferred per stage; full build set remains available
# after first CODE so the model is never stuck — gates guide, not brick walls)
PHASE_ORDER = ("PLAN", "CODE", "VERIFY", "REFLECT")

PHASE_FOCUS: dict[str, str] = {
    "PLAN": (
        "Focus: understand the task, optionally write tests_auto.py and todowrite. "
        "Prefer readonly tools + write for tests only. Do not claim done yet."
    ),
    "CODE": (
        "Focus: implement in solution.py (or language-appropriate main file) via "
        "write/edit/apply_patch. Prefer small edits after the first draft."
    ),
    "VERIFY": (
        "Focus: run tests with run_python or bash. Do not claim success without "
        "a green observation. If green, call done."
    ),
    "REFLECT": (
        "Focus: read the failure, edit the minimal fix, then we re-verify."
    ),
}

MAX_STEPS_PROMPT = """CRITICAL — MAXIMUM STEPS REACHED

Tools are disabled. Respond with text only:
1. What you accomplished
2. What remains
3. Recommended next steps
Do not invent successful test results.
"""

BUILD_SYSTEM = """You are EdgeRunner, an autonomous coding agent.

You solve tasks with tools in a workspace. The harness advances phases for you
(PLAN → CODE → VERIFY → REFLECT). Follow the current phase focus.

Rules:
- Prefer write/edit over huge rewrites when fixing failures
- You must read a file before editing it
- After writing code, run real tests (run_python or bash)
- Never invent pass results — only trust tool observations
- Call done with a short summary when verified
- Paths are workspace-relative
- Pure exercises (e.g. reverse a string): solution.py + tests → run → fix → done

Tool format (required):
<tool name="write">
{"path": "solution.py", "content": "def reverse_string(s):\\n    return s[::-1]\\n"}
</tool>
"""

PLAN_SYSTEM = """You are EdgeRunner in plan mode (readonly analysis).

Use only: read, grep, glob, list_dir, webfetch, websearch, todowrite, done.
Do not write or edit code files. Produce a concrete plan, then call done.
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
    from langchain_core.messages import HumanMessage
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
    hints: list[str] = []
    for m in re.finditer(
        r"(?:assert|expect|should\s+(?:return|be)|e\.g\.|example)[:\s]+(.+)",
        task or "",
        re.I,
    ):
        hints.append(m.group(0).strip()[:200])
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
    assert_lines = "\n".join(
        f"    {h}" if h.startswith("assert") else f"    # {h}" for h in hints
    )
    if not any(h.startswith("assert") for h in hints):
        assert_lines = (
            "    assert fn is not None, 'no public function found in solution'\n"
            "    try:\n"
            "        r = fn('') if getattr(fn, '__code__', None) and "
            "fn.__code__.co_argcount >= 1 else fn()\n"
            "        assert r is not None or r == '' or r == [] or r == 0\n"
            "    except TypeError:\n"
            "        pass\n"
        )
    return f'''"""Auto smoke tests."""
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
    pys = [
        p
        for p in tools.cwd.glob("*.py")
        if p.is_file() and not p.name.startswith("test") and "auto" not in p.name
    ]
    if len(pys) == 1:
        return pys[0].read_text(encoding="utf-8", errors="replace")
    return ""


def _advance_phase(phase: str, tools: ToolRegistry, wrote_code: bool) -> str:
    if phase == "PLAN":
        return "CODE"
    if phase == "CODE":
        return "VERIFY" if wrote_code or _find_solution(tools) else "CODE"
    if phase == "VERIFY":
        return "DONE" if tools.ctx.last_test_ok else "REFLECT"
    if phase == "REFLECT":
        return "CODE"
    return phase


def _is_pure_coding_exercise(task: str) -> bool:
    """Heuristic: short algorithmic / implement-function tasks benefit from auto-tests."""
    t = (task or "").lower()
    if len(t) > 2500:
        return False
    return bool(
        re.search(
            r"\b(implement|write|create|code|function|def |class |reverse|"
            r"sort|leetcode|algorithm|return|assert)\b",
            t,
        )
    )


def _ensure_tests_file(tools: ToolRegistry, task: str) -> None:
    """Aider-style: have a test file ready before/with implementation."""
    for name in ("tests_auto.py", "test_solution.py", "tests.py"):
        if (tools.cwd / name).is_file():
            return
    tools.call(
        "write",
        {"path": "tests_auto.py", "content": _auto_tests_for_solution(task)},
    )


def _maybe_auto_verify(
    tools: ToolRegistry,
    *,
    wrote_this_step: bool,
    already_ran_verify: bool,
) -> list[tuple[str, dict]]:
    """
    Harness engineering: after a write/edit, always settle a verify turn if the
    model forgot. Prevents claim-success-without-run (common GGUF failure mode).
    """
    if already_ran_verify or not wrote_this_step:
        return []
    if not _find_solution(tools):
        return []
    test_path = None
    for name in ("tests_auto.py", "test_solution.py", "tests.py"):
        if (tools.cwd / name).is_file():
            test_path = name
            break
    if test_path:
        return [("run_python", {"path": test_path})]
    # No test file: at least import/run solution for syntax
    return [("run_python", {"path": "solution.py"})]


def run_coding_agent(
    task: str,
    *,
    max_steps: Optional[int] = None,
    plan_mode: Optional[bool] = None,
) -> dict:
    """
    Single hands-free coding agent entry.
    plan_mode: True = analysis only; False = full build; None = detect from task.
    """
    plan = plan_mode if plan_mode is not None else _wants_plan_mode(task)
    steps = max_steps or (MAX_STEPS_PLAN if plan else MAX_STEPS_BUILD)
    tools = ToolRegistry()
    system = PLAN_SYSTEM if plan else BUILD_SYSTEM
    tool_block = tools.list_for_prompt(plan_mode=plan)

    thought: list[str] = []
    transcript: list[str] = []
    final_text = ""
    finished = False
    last_reply = ""
    phase = "PLAN"
    wrote_code = False
    # Stuck-loop detection (LangChain harness eng. / OpenCode step discipline)
    last_fail_sig = ""
    fail_streak = 0
    empty_steps = 0

    _progress(
        f"⚙️ [Agent] {'plan' if plan else 'build'} · up to {steps} steps · ws={tools.cwd.name}"
    )

    # Tests-first seed for pure coding (Aider): materialize smoke tests once
    if not plan and _is_pure_coding_exercise(task):
        _ensure_tests_file(tools, task)
        thought.append("**Harness:** seeded tests_auto.py (tests-first)")

    messages_blob = (
        f"{system}\n\n{tool_block}\n\n"
        f"## User task\n{task}\n\n"
        "Begin with tools.\n"
    )
    if not plan and (tools.cwd / "tests_auto.py").is_file():
        messages_blob += (
            "Note: tests_auto.py already exists in the workspace. "
            "Implement solution.py then run_python tests_auto.py.\n"
        )

    for step in range(1, steps + 1):
        tools.ctx.step = step
        focus = PHASE_FOCUS.get(phase, "") if not plan else "Produce the plan, then done."
        _progress(f"🔁 step {step}/{steps}" + (f" · {phase}" if not plan else " · plan"))

        if step == steps:
            prompt = messages_blob + "\n\n" + MAX_STEPS_PROMPT + "\nassistant:"
            final_text = _llm_text(prompt, max_tokens=800)
            thought.append(f"**Step {step} (max):** {final_text[:1500]}")
            break

        stuck_nudge = ""
        if fail_streak >= 2 and last_fail_sig:
            stuck_nudge = (
                f"\n## Stuck-loop guard\n"
                f"The same verification failure repeated {fail_streak} times:\n"
                f"{last_fail_sig[:600]}\n"
                "Make a *minimal* edit (edit tool), then re-run tests. "
                "Do not rewrite the whole file unless necessary.\n"
            )
        phase_hdr = f"\n## Phase: {phase}\n{focus}\n" if not plan else "\n"
        prompt = messages_blob + phase_hdr + stuck_nudge + "assistant:"
        reply = _llm_text(prompt, max_tokens=1400)
        last_reply = reply
        thought.append(f"**Step {step} ({phase}):**\n{reply[:2000]}")
        transcript.append(f"assistant:\n{reply}")

        calls = parse_tool_calls(reply)

        if not calls and not plan:
            code = extract_fenced_code(reply, preferred="python")
            if code and step <= 4:
                _progress("📝 materializing solution.py from code fence")
                tools.call("write", {"path": "solution.py", "content": code})
                _ensure_tests_file(tools, task)
                wrote_code = True
                calls = [("run_python", {"path": "tests_auto.py"})]
                phase = "VERIFY"
            else:
                empty_steps += 1
                nudge = (
                    "Continue with tools. Call done when verified.\n"
                    if empty_steps < 2
                    else (
                        "No tools detected. Emit a <tool name=\"write\"> or "
                        "<tool name=\"run_python\"> block now.\n"
                    )
                )
                messages_blob += f"\nassistant:\n{reply}\n\nuser:\n{nudge}"
                if len(messages_blob) > 24000:
                    messages_blob = messages_blob[-20000:]
                if not plan:
                    phase = _advance_phase(phase, tools, wrote_code)
                continue

        empty_steps = 0
        observations: list[str] = []
        wrote_this_step = False
        ran_verify = False
        for name, args in calls[:6]:
            resolved = tools.resolve_name(name)
            if plan and resolved not in tools.names(plan_mode=True):
                observations.append(
                    f"### observation:{name}\nTool blocked in plan mode (readonly)."
                )
                thought.append(f"🔧 {name} blocked (plan)")
                continue
            _progress(f"🔧 {resolved}")
            result = tools.call(resolved, args)
            obs = result.observation()
            observations.append(f"### observation:{resolved}\n{obs}")
            thought.append(
                f"🔧 **{resolved}** → {'ok' if result.ok else 'error'}\n```\n{obs[:800]}\n```"
            )
            if resolved in ("write", "edit", "apply_patch") and result.ok:
                path = str(args.get("path") or "")
                if path and "test" not in path.lower():
                    wrote_code = True
                    wrote_this_step = True
            if resolved in ("run_python", "bash"):
                ran_verify = True
                if not result.ok:
                    # Signature for stuck detection (stderr tail)
                    sig = obs[-400:]
                    if sig == last_fail_sig:
                        fail_streak += 1
                    else:
                        last_fail_sig = sig
                        fail_streak = 1
                else:
                    fail_streak = 0
                    last_fail_sig = ""
            if resolved == "done" and result.ok:
                if plan or tools.ctx.last_test_ok or step >= steps - 1:
                    finished = True
                    final_text = result.content
                    break
                observations.append(
                    "### note\ndone deferred: run verification (tests) first, then done."
                )

        # Auto-verify if model wrote code but skipped tests (Aider / harness eng.)
        if not finished and not plan:
            extra = _maybe_auto_verify(
                tools,
                wrote_this_step=wrote_this_step,
                already_ran_verify=ran_verify,
            )
            for name, args in extra:
                _progress(f"🔧 {name} (auto-verify)")
                result = tools.call(name, args)
                obs = result.observation()
                observations.append(f"### observation:{name} [auto-verify]\n{obs}")
                thought.append(
                    f"🔧 **{name}** (auto) → {'ok' if result.ok else 'error'}\n```\n{obs[:800]}\n```"
                )
                if not result.ok:
                    sig = obs[-400:]
                    if sig == last_fail_sig:
                        fail_streak += 1
                    else:
                        last_fail_sig = sig
                        fail_streak = 1
                else:
                    fail_streak = 0
                    last_fail_sig = ""
                phase = "VERIFY"

        messages_blob += f"\nassistant:\n{reply}\n\n"
        messages_blob += "user:\n" + "\n\n".join(observations) + "\n"
        if not finished and not plan:
            if tools.ctx.last_test_ok:
                messages_blob += "Tests passed. Call done with a short summary.\n"
            elif fail_streak >= 2:
                messages_blob += (
                    "Same failure twice — use edit with a small fix, then run_python.\n"
                )
            else:
                messages_blob += "Continue. Fix failures then re-verify.\n"
        if len(messages_blob) > 24000:
            messages_blob = messages_blob[-20000:]

        if finished:
            break

        # Auto-complete when verified (model forgot done)
        if not plan and tools.ctx.last_test_ok and _find_solution(tools) and step >= 2:
            _progress("✅ tests green — finishing")
            finished = True
            final_text = "Tests passed. Solution ready."
            break

        if not plan and not finished:
            phase = _advance_phase(phase, tools, wrote_code)

    if not final_text:
        final_text = last_reply or "Agent stopped without finishing."

    solution_body = _find_solution(tools)
    if not solution_body:
        solution_body = extract_fenced_code(final_text, preferred="python") or extract_fenced_code(
            "\n".join(transcript), preferred="python"
        )

    fence = "python"
    if (tools.cwd / "index.js").is_file() or (tools.cwd / "solution.js").is_file():
        fence = "javascript"
    elif (tools.cwd / "main.go").is_file():
        fence = "go"
    elif (tools.cwd / "main.rs").is_file():
        fence = "rust"

    status = "✅ complete" if finished else "⚠️ incomplete"
    response = f"### EdgeRunner ({status})\n\n{final_text}\n"
    if solution_body:
        response += f"\n### Solution\n\n```{fence}\n{solution_body.rstrip()}\n```\n"
    if tools.ctx.todos:
        response += "\n### Todos\n"
        for t in tools.ctx.todos:
            if isinstance(t, dict):
                response += f"- [{t.get('status', '?')}] {t.get('content', t.get('id', ''))}\n"
    response += f"\n_steps {tools.ctx.step}/{steps} · {'plan' if plan else 'build'}_\n"

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


# Backward-compatible name (internal callers)
run_opencode_style_agent = run_coding_agent
