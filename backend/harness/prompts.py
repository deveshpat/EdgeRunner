"""
Prompts informed by coding-agent literature:

- SWE-agent (Yang et al.): tight ACI observations, explicit next-action format
- ReAct (Yao et al.): interleave reasoning with actions / reflection on failure
- CodeAct / OpenHands: code + shell as primary actions
- Aider: tests-first, small focused diffs / complete files for local models
"""

from __future__ import annotations

from harness.language import LangSpec


def system_chat() -> str:
    return (
        "You are EdgeRunner, a local coding assistant on the user's Kaggle/CPU session. "
        "Reply briefly and clearly. For substantial coding tasks, a multi-step harness "
        "(plan → tests → implement → run → reflect) will handle implementation."
    )


def plan_and_tests(task: str, lang: LangSpec) -> str:
    return f"""You are a senior engineer designing a solution (tests-first, like strong coding agents).

Task:
{task}

Language: {lang.id}

Respond with TWO sections:

## Plan
3–8 short bullets: approach, edge cases, public API (function/class names).

## Tests
A single ```{lang.fence} block with executable tests that:
- Call the API you planned (same names)
- Cover happy path + at least one edge case
- Prefer simple asserts (or language-idiomatic checks)
- Do NOT implement the full solution here — tests only

Output nothing after the tests block.
"""


def implement(task: str, lang: LangSpec, plan: str, tests: str, reflection: str = "") -> str:
    extra = ""
    if reflection:
        extra = f"""
## Prior failure analysis (fix these issues)
{reflection}
"""
    return f"""You are an expert {lang.id} implementer. Write code that passes the tests.

## Task
{task}

## Plan
{plan}

## Tests (must pass)
```{lang.fence}
{tests}
```
{extra}
## Rules
- Output ONE ```{lang.fence} block with the full solution only
- Do NOT include assert/tests, doctests, or `if __name__` demos in that block
- Match the API the tests call (names, signatures)
- Prefer clear, correct code over cleverness
- No markdown outside the code fence
"""


def reflect(task: str, lang: LangSpec, code: str, tests: str, observation: str) -> str:
    return f"""You are a debugging critic (ReAct-style reflection before the next edit).

## Task
{task}

## Language
{lang.id}

## Current code
```{lang.fence}
{code}
```

## Tests
```{lang.fence}
{tests}
```

## Execution observation
{observation}

Write a short failure analysis:
1. Root cause (1–2 sentences)
2. Concrete fix steps (bullets)
3. Any missing edge case in tests (optional)

Do NOT rewrite the full solution. Analysis only.
"""


def tool_augmented_hint(tools_block: str) -> str:
    return f"""
{tools_block}

If you need environment info (e.g. whether node/go exists), you may emit a single tool call
before coding. For pure algorithm tasks, skip tools and write the solution directly.
"""
