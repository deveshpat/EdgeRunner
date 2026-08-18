"""Unified 'terminal' omnitool for EdgeRunner.

Consolidates all agent capabilities into a single universal tool that any model
(from 3B non-reasoning to 70B frontier) can reliably call and execute in the
shared `./workspace` sandbox.

Includes a tolerant alias router and fuzzy argument parser to handle whatever
names or keys a model generates.
"""

from __future__ import annotations

import json
import subprocess
import sys
from dataclasses import dataclass
from typing import Any, Callable

from app.workspace import WORKSPACE_ROOT, ensure_workspace

CODE_TIMEOUT = 30
_OUTPUT_CAP = 4000


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: dict  # OpenAI JSON schema for the arguments object
    func: Callable[[dict | str], str]


def _cap(text: str) -> str:
    text = text.strip()
    return text[:_OUTPUT_CAP] + "\n…(truncated)" if len(text) > _OUTPUT_CAP else text


import ast
import re

def _extract_command(args: Any) -> str:
    """Fuzzy extractor: pulls the command or code string out of any argument structure,
    including raw strings, JSON dicts, escaped JSON strings, or Python literal dicts."""
    if isinstance(args, dict):
        # Priority key search
        for key in ("command", "cmd", "code", "script", "expression", "input", "text", "query", "run"):
            val = args.get(key)
            if val is not None and str(val).strip():
                return str(val).strip()

        # If dict has only 1 string value, use it
        for val in args.values():
            if isinstance(val, str) and val.strip():
                return val.strip()

        return ""

    if isinstance(args, str):
        s = args.strip()
        if not s:
            return ""

        # Check if the string is serialized JSON or a Python dict with command/cmd/code
        if (s.startswith("{") and s.endswith("}")) or any(
            k in s for k in ('"command":', "'command':", '"cmd":', "'cmd':", '"code":', "'code':")
        ):
            try:
                p = json.loads(s, strict=False)
                if isinstance(p, dict):
                    return _extract_command(p)
            except Exception:
                pass
            try:
                p = ast.literal_eval(s)
                if isinstance(p, dict):
                    return _extract_command(p)
            except Exception:
                pass
            # Regex fallback to extract command value from malformed JSON
            m = re.search(
                r'["\'](?:command|cmd|code|script|input)["\']\s*:\s*["\'](.*?)["\']\s*\}?$',
                s,
                re.DOTALL,
            )
            if m:
                return m.group(1).strip()

        return s

    return str(args).strip()


def run_command(cmd: str, timeout: int = CODE_TIMEOUT) -> tuple[str, int]:
    """Execute a shell command inside the shared workspace sandbox."""
    workspace = ensure_workspace()
    cmd = cmd.strip()
    if not cmd:
        return "error: empty command", 1

    try:
        r = subprocess.run(
            cmd,
            shell=True,
            cwd=str(workspace),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return f"error: command timed out after {timeout}s", 124
    except Exception as exc:  # noqa: BLE001
        return f"error: {exc}", 1

    out = r.stdout
    if r.stderr:
        out += ("\n" if out else "") + "[stderr]\n" + r.stderr
    out = _cap(out) or "(no output)"
    return out, r.returncode


def _terminal_func(args: dict | str) -> str:
    """Universal terminal handler."""
    cmd = _extract_command(args)
    if not cmd:
        return "error: no command provided"
    out, code = run_command(cmd)
    if code != 0:
        return f"[exit code {code}]\n{out}"
    return out


def _python_func(args: dict | str) -> str:
    """Handler for models calling a python-specific tool."""
    code = _extract_command(args)
    if not code:
        return "error: no code provided"
    # Execute python code via python interpreter inside the workspace
    py_exec = sys.executable or "python3"
    # If code is single-line simple expression or script, run with -c
    escaped_code = code.replace("'", "'\"'\"'")
    cmd = f"{py_exec} -c '{escaped_code}'"
    return _terminal_func(cmd)


# --- Universal Tool Specification ---

TERMINAL_TOOL = Tool(
    name="terminal",
    description=(
        "Run any shell command or script in the workspace terminal. "
        "Use this for calculations, running Python (e.g. 'python3 -c \"...\"' or 'python3 script.py'), "
        "inspecting or creating files (e.g. 'cat', 'ls', 'echo ... > file'), "
        "or installing packages ('pip install <pkg>')."
    ),
    parameters={
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "The shell command to execute in the workspace (e.g. 'python3 -c \"import math; print(math.sqrt(2))\"').",
            }
        },
        "required": ["command"],
    },
    func=_terminal_func,
)

TOOLS: dict[str, Tool] = {
    "terminal": TERMINAL_TOOL,
}

# Tolerant Alias Mapping: route whatever the model hallucinates to the right executor
_ALIASES: dict[str, Callable[[dict | str], str]] = {
    "terminal": _terminal_func,
    "bash": _terminal_func,
    "sh": _terminal_func,
    "shell": _terminal_func,
    "run_shell": _terminal_func,
    "cmd": _terminal_func,
    "command": _terminal_func,
    "exec": _terminal_func,
    "execute": _terminal_func,
    "python": _python_func,
    "py": _python_func,
    "python3": _python_func,
    "run_python": _python_func,
    "code_interpreter": _python_func,
    "eval": _python_func,
    "calculator": _python_func,
}


def specs() -> list[dict]:
    """OpenAI-style tool specifications advertised to llama-server."""
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.parameters,
            },
        }
        for t in TOOLS.values()
    ]


def execute(name: str, arguments: str | dict) -> str:
    """Run a tool by name with fuzzy argument parsing and alias fallback."""
    clean_name = name.strip().lower()

    func = _ALIASES.get(clean_name)
    if func is None:
        # If unknown tool name, fallback to executing with terminal
        func = _terminal_func

    if isinstance(arguments, str):
        try:
            parsed_args = json.loads(arguments, strict=False) if arguments.strip() else {}
        except Exception:
            # If arguments is raw text / command instead of JSON
            parsed_args = arguments
    else:
        parsed_args = arguments or {}

    return func(parsed_args)
