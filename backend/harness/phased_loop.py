"""
Phased coding harness — combines the best ideas for *local / GGUF* models.

Research-backed mix:
  - statewright: shrink tool space per phase (huge win on weak models)
  - Aider: tests-first + exact edits
  - SWE-agent: ACI-style observations (via tools/sandbox)
  - OpenCode: build/plan, max steps, done tool
  - LangChain harness eng.: verify before success claims
  - Claude Code: plan vs build agent split

Phases:
  PLAN   → understand + write tests strategy (readonly + todo)
  CODE   → write/edit implementation
  VERIFY → run tests
  REFLECT→ read failures, then back to CODE
"""

from __future__ import annotations

import os
from typing import Optional

from langchain_core.messages import HumanMessage

from harness.language import extract_fenced_code
from harness.tools.registry import ToolRegistry, parse_tool_calls

_progress_cb = None

MAX_STEPS = int(os.environ.get("EDGERUNNER_MAX_STEPS", "24"))

# Tool allow-lists per phase (OpenCode names)
PHASE_TOOLS: dict[str, set[str]] = {
    "PLAN": {
        "read",
        "grep",
        "glob",
        "list_dir",
        "webfetch",
        "todowrite",
        "done",
        "write",  # allow writing tests_only / plan.md
    },
    "CODE": {
        "read",
        "write",
        "edit",
        "apply_patch",
        "grep",
        "glob",
        "list_dir",
        "todowrite",
        "bash",
        "run_python",
        "done",
    },
    "VERIFY": {
        "bash",
        "run_python",
        "read",
        "list_dir",
        "grep",
        "done",
    },
    "REFLECT": {
        "read",
        "grep",
        "glob",
        "list_dir",
        "edit",
        "write",
        "apply_patch",
        "todowrite",
        "bash",
        "run_python",
        "done",
    },
}

SYSTEM = """You are EdgeRunner — a coding agent combining the best harness ideas:
OpenCode tools, Aider-style exact edits, SWE-agent verification, phased tool access.

You work in PHASES. Only use tools allowed in the current phase.
Always call tools with:
<tool name="NAME">
{"arg": "value"}
</tool>

Rules:
1. Prefer writing tests early (tests_auto.py or asserts).
2. Implementation goes in solution.py (or language-appropriate main file).
3. Never claim success without a green VERIFY observation.
4. read before edit.
5. Call done with a summary when finished and verified.
"""


def set_phased_progress(cb) -> None:
    global _progress_cb
    _progress_cb = cb


def _progress(msg: str) -> None:
    print(msg, flush=True)
    if _progress_cb is not None:
        try:
            _progress_cb(msg)
        except Exception:
            pass


def _llm(prompt: str, max_tokens: int = 1200) -> str:
    from harness.llm_bridge import get_llm

    llm = get_llm()
    try:
        bound = llm.bind(max_tokens=max_tokens) if hasattr(llm, "bind") else llm
        response = bound.invoke([HumanMessage(content=prompt)])
    except Exception:
        response = llm.invoke([HumanMessage(content=prompt)])
    return (getattr(response, "content", None) or str(response)).strip()


def _phase_prompt(phase: str, task: str, tools: ToolRegistry, history: str) -> str:
    allowed = sorted(PHASE_TOOLS.get(phase, set()))
    tool_docs = []
    for name in allowed:
        t = tools._tools.get(name)
        if t:
            tool_docs.append(f"- {name}: {t.description}")
    return (
        f"{SYSTEM}\n\n"
        f"## CURRENT PHASE: {phase}\n"
        f"Allowed tools: {', '.join(allowed)}\n"
        + "\n".join(tool_docs)
        + "\n\n"
        f"## Task\n{task}\n\n"
        f"## Recent transcript\n{history[-12000:]}\n\n"
        f"Act now in phase {phase}. Emit tool calls.\nassistant:"
    )


def _next_phase(phase: str, tools: ToolRegistry, step: int) -> str:
    if phase == "PLAN":
        return "CODE"
    if phase == "CODE":
        return "VERIFY"
    if phase == "VERIFY":
        if tools.ctx.last_test_ok:
            return "DONE"
        return "REFLECT"
    if phase == "REFLECT":
        return "CODE"
    return "CODE"


def run_phased_agent(task: str, *, max_steps: Optional[int] = None) -> dict:
    steps = max_steps or MAX_STEPS
    tools = ToolRegistry()
    phase = "PLAN"
    history = ""
    thought: list[str] = []
    final_text = ""
    finished = False
    last_reply = ""

    _progress(f"⚙️ [Phased harness] max {steps} steps · ws={tools.cwd.name}")

    # Seed: hint to write tests file in plan
    seed_hint = (
        "Start in PLAN: optionally write tests_auto.py with asserts for the task, "
        "and a short plan via todowrite. Then we move to CODE.\n"
    )
    history = seed_hint

    for step in range(1, steps + 1):
        tools.ctx.step = step
        if phase == "DONE" or finished:
            break

        _progress(f"🔁 [Phased] step {step}/{steps} · phase={phase}")
        prompt = _phase_prompt(phase, task, tools, history)
        reply = _llm(prompt, max_tokens=1400)
        last_reply = reply
        thought.append(f"**{phase} {step}:**\n{reply[:1800]}")
        history += f"\nassistant:\n{reply}\n"

        calls = parse_tool_calls(reply)
        if not calls:
            code = extract_fenced_code(reply, preferred="python")
            if code and phase in ("CODE", "PLAN", "REFLECT"):
                tools.call("write", {"path": "solution.py", "content": code})
                calls = [("write", {"path": "solution.py", "content": "(auto)"})]
                # fake observation already done
                history += "\nuser:\n[ok] auto-wrote solution.py from code fence\n"
            else:
                history += "\nuser:\nNo tool call. Use an allowed tool for this phase.\n"
                # force phase advance slowly
                if step % 2 == 0:
                    phase = _next_phase(phase, tools, step)
                continue

        allowed = PHASE_TOOLS.get(phase, set())
        observations = []
        for name, args in calls[:5]:
            resolved = tools.resolve_name(name)
            if resolved not in allowed and name not in allowed:
                msg = f"Tool '{name}' not allowed in phase {phase}. Allowed: {sorted(allowed)}"
                observations.append(msg)
                thought.append(f"🔧 {name} blocked ({phase})")
                continue
            _progress(f"🔧 [{phase}] {resolved}")
            result = tools.call(resolved, args)
            observations.append(f"### {resolved}\n{result.observation()}")
            thought.append(
                f"🔧 **{resolved}** → {'ok' if result.ok else 'err'}\n```\n{result.content[:600]}\n```"
            )
            if resolved == "done" and result.ok:
                # only accept done if verified or plan-only task
                if tools.ctx.last_test_ok or phase == "PLAN":
                    finished = True
                    final_text = result.content
                    phase = "DONE"
                else:
                    observations.append(
                        "done rejected: run VERIFY successfully first (tests must pass)."
                    )

        history += "user:\n" + "\n".join(observations) + "\n"
        if len(history) > 28000:
            history = history[-22000:]

        if finished:
            break

        # Phase transitions
        if phase == "VERIFY" and tools.ctx.last_test_ok:
            _progress("✅ [Phased] VERIFY green")
            finished = True
            final_text = "Tests passed (phased harness auto-complete)."
            phase = "DONE"
            break
        if phase == "VERIFY" and not tools.ctx.last_test_ok:
            phase = "REFLECT"
        elif phase == "PLAN" and step >= 2:
            phase = "CODE"
        elif phase == "CODE" and step >= 1:
            # after any code write, try verify
            if (tools.cwd / "solution.py").is_file() or (tools.cwd / "main.py").is_file():
                phase = "VERIFY"
        elif phase == "REFLECT":
            phase = "CODE"

    if not final_text:
        final_text = last_reply or "Stopped without completion."

    solution = ""
    for cand in ("solution.py", "main.py", "app.py"):
        p = tools.cwd / cand
        if p.is_file():
            solution = p.read_text(encoding="utf-8", errors="replace")
            break

    status = "✅ complete" if finished else "⚠️ incomplete"
    response = f"### EdgeRunner phased harness ({status})\n\n{final_text}\n"
    if solution:
        response += f"\n### Solution\n\n```python\n{solution.rstrip()}\n```\n"
    response += (
        f"\n_phase final={phase} · steps={tools.ctx.step}/{steps} · "
        f"tests_ok={tools.ctx.last_test_ok} · ws=`{tools.cwd}`_\n"
    )

    return {
        "mode": "harness",
        "agent": "phased",
        "response": response,
        "thought_process": thought,
        "code": solution,
        "terminal_output": history[-4000:],
        "lang": "python",
        "workspace": str(tools.cwd),
        "finished": finished,
        "tests_ok": tools.ctx.last_test_ok,
    }
