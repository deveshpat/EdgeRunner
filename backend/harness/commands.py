"""
OpenCode-style slash command expansion on the server.

Client handles pure-UI commands (/help, /new, /settings…).
Anything that reaches the backend as a prompt may still start with /plan, /init, etc.
This module normalizes those into agent mode + task text.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


@dataclass
class ResolvedCommand:
    task: str
    agent: str  # build | plan
    force_harness: bool
    command: Optional[str] = None


_SLASH = re.compile(r"^/([a-zA-Z0-9_?-]+)(?:\s+([\s\S]*))?$")

# Templates (mirrors frontend + OpenCode initialize/review spirit)
_TEMPLATES: dict[str, tuple[str, str]] = {
    # name -> (agent, template with $ARGUMENTS)
    "init": (
        "plan",
        "Create or update a compact AGENTS.md-style project guide.\n"
        "User focus: $ARGUMENTS\n"
        "Only high-signal, repo-specific guidance.",
    ),
    "review": (
        "plan",
        "You are a code reviewer. Scope: $ARGUMENTS\n"
        "Focus on bugs, edge cases, security, and requirement fit. Be certain.",
    ),
    "test": (
        "build",
        "Write thorough tests for: $ARGUMENTS\n"
        "Implement/fix until tests pass. Use tools and verify with execution.",
    ),
    "fix": (
        "build",
        "Debug and fix:\n$ARGUMENTS\nUse tools, verify, then finish.",
    ),
    "plan": ("plan", "$ARGUMENTS"),
    "build": ("build", "$ARGUMENTS"),
    "code": ("build", "$ARGUMENTS"),
}

_ALIASES = {
    "summarize": "compact",  # client-only usually
    "?": "help",
}


def resolve_slash(text: str, *, default_agent: str = "build") -> ResolvedCommand:
    """
    If `text` starts with a known slash command, expand it.
    Unknown / UI-only commands are left as plain text (client should have handled them).
    """
    t = (text or "").strip()
    m = _SLASH.match(t)
    if not m:
        agent = "plan" if _wants_plan(t) else default_agent
        return ResolvedCommand(task=t, agent=agent, force_harness=False)

    name = m.group(1).lower()
    name = _ALIASES.get(name, name)
    args = (m.group(2) or "").strip()

    if name in _TEMPLATES:
        agent, tmpl = _TEMPLATES[name]
        body = tmpl.replace("$ARGUMENTS", args or "(none)").strip()
        if name in ("plan", "build", "code") and not args:
            # bare /plan or /build — short instruction to switch mode
            body = (
                "Stay in plan mode: analyze only, no file writes."
                if name == "plan"
                else "Use full build tools to implement the next coding request."
            )
        return ResolvedCommand(
            task=body,
            agent=agent,
            force_harness=True,
            command=name,
        )

    # Unknown slash → pass through (may be custom)
    return ResolvedCommand(task=t, agent=default_agent, force_harness=False)


def _wants_plan(task: str) -> bool:
    return bool(
        re.search(
            r"\b(plan only|don't (edit|write)|do not (edit|write)|read only|analyze only)\b",
            (task or "").lower(),
        )
    )
