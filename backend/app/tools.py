"""Built-in tools the agentic harness can call.

Tools are intentionally safe: a sandboxed arithmetic/maths evaluator, a clock,
a random-number generator, text statistics, and a hasher. Each tool exposes an
OpenAI-style JSON schema so it can be advertised to llama-server, plus a `func`
that executes it.
"""

from __future__ import annotations

import ast
import hashlib
import json
import math
import operator
import random
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    parameters: dict  # JSON schema for the arguments object
    func: Callable[[dict], str]


# --- calculator ------------------------------------------------------------

_BIN_OPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.FloorDiv: operator.floordiv,
}
_UNARY_OPS = {ast.UAdd: operator.pos, ast.USub: operator.neg}

# Whitelisted maths functions and constants the calculator may reference.
_FUNCS: dict[str, Callable] = {
    "sqrt": math.sqrt,
    "abs": abs,
    "round": round,
    "floor": math.floor,
    "ceil": math.ceil,
    "min": min,
    "max": max,
    "log": math.log,
    "log2": math.log2,
    "log10": math.log10,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "exp": math.exp,
    "factorial": math.factorial,
}
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau}


def _safe_eval(node: ast.AST) -> float:
    """Evaluate an arithmetic AST, allowing only whitelisted names/calls."""
    if isinstance(node, ast.Expression):
        return _safe_eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.Name) and node.id in _CONSTS:
        return _CONSTS[node.id]
    if isinstance(node, ast.BinOp) and type(node.op) in _BIN_OPS:
        return _BIN_OPS[type(node.op)](_safe_eval(node.left), _safe_eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY_OPS:
        return _UNARY_OPS[type(node.op)](_safe_eval(node.operand))
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in _FUNCS
        and not node.keywords
    ):
        args = [_safe_eval(a) for a in node.args]
        return _FUNCS[node.func.id](*args)
    raise ValueError("unsupported expression")


def _calculator(args: dict) -> str:
    expr = str(args.get("expression", "")).strip()
    if not expr:
        return "error: no expression provided"
    try:
        result = _safe_eval(ast.parse(expr, mode="eval"))
    except Exception:
        return f"error: could not evaluate {expr!r}"
    if isinstance(result, float) and result.is_integer():
        result = int(result)
    return str(result)


# --- clock -----------------------------------------------------------------


def _current_time(args: dict) -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


# --- random ----------------------------------------------------------------


def _random_number(args: dict) -> str:
    try:
        low = int(args.get("min", 0))
        high = int(args.get("max", 100))
    except (TypeError, ValueError):
        return "error: min and max must be integers"
    if low > high:
        low, high = high, low
    return str(random.randint(low, high))


# --- text stats ------------------------------------------------------------


def _text_stats(args: dict) -> str:
    text = str(args.get("text", ""))
    stats = {
        "characters": len(text),
        "words": len(text.split()),
        "lines": len(text.splitlines()) or (1 if text else 0),
    }
    return json.dumps(stats)


# --- hash ------------------------------------------------------------------

_ALGOS = {"sha256", "sha1", "md5"}


def _hash_text(args: dict) -> str:
    text = str(args.get("text", ""))
    algo = str(args.get("algorithm", "sha256")).lower()
    if algo not in _ALGOS:
        return f"error: unsupported algorithm {algo!r} (use one of {sorted(_ALGOS)})"
    digest = hashlib.new(algo, text.encode("utf-8")).hexdigest()
    return digest


# --- code execution --------------------------------------------------------
# Runs in the backend's environment. In production that's the isolated,
# ephemeral Kaggle worker (its own Linux sandbox), which is the point: the
# agent gets a real code interpreter with the whole toolchain available.

CODE_TIMEOUT = 30
_OUTPUT_CAP = 4000


def _cap(text: str) -> str:
    text = text.strip()
    return text[:_OUTPUT_CAP] + "\n…(truncated)" if len(text) > _OUTPUT_CAP else text


def _run(cmd: list[str] | str, shell: bool) -> str:
    try:
        r = subprocess.run(
            cmd, shell=shell, capture_output=True, text=True, timeout=CODE_TIMEOUT
        )
    except subprocess.TimeoutExpired:
        return f"error: timed out after {CODE_TIMEOUT}s"
    except Exception as exc:  # noqa: BLE001
        return f"error: {exc}"
    out = r.stdout
    if r.stderr:
        out += ("\n" if out else "") + "[stderr]\n" + r.stderr
    out = _cap(out)
    return out or "(no output)"


def _run_python(args: dict) -> str:
    code = str(args.get("code", ""))
    if not code.strip():
        return "error: no code provided"
    return _run([sys.executable, "-c", code], shell=False)


def _run_shell(args: dict) -> str:
    cmd = str(args.get("command", ""))
    if not cmd.strip():
        return "error: no command provided"
    return _run(cmd, shell=True)


# --- registry --------------------------------------------------------------

TOOLS: dict[str, Tool] = {
    t.name: t
    for t in [
        Tool(
            name="calculator",
            description=(
                "Evaluate a maths expression. Supports + - * / // % **, "
                "functions (sqrt, abs, round, floor, ceil, min, max, log, "
                "sin, cos, tan, exp, factorial) and constants (pi, e, tau)."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "Expression, e.g. 'sqrt(2) * 10' or '3*(4+5)'.",
                    }
                },
                "required": ["expression"],
            },
            func=_calculator,
        ),
        Tool(
            name="current_time",
            description="Get the current date and time in UTC.",
            parameters={"type": "object", "properties": {}},
            func=_current_time,
        ),
        Tool(
            name="random_number",
            description="Generate a random integer between min and max (inclusive).",
            parameters={
                "type": "object",
                "properties": {
                    "min": {"type": "integer", "description": "Lower bound."},
                    "max": {"type": "integer", "description": "Upper bound."},
                },
                "required": ["min", "max"],
            },
            func=_random_number,
        ),
        Tool(
            name="text_stats",
            description="Count characters, words, and lines in a piece of text.",
            parameters={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text to analyse."}
                },
                "required": ["text"],
            },
            func=_text_stats,
        ),
        Tool(
            name="hash_text",
            description="Compute a cryptographic hash of some text.",
            parameters={
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Text to hash."},
                    "algorithm": {
                        "type": "string",
                        "enum": sorted(_ALGOS),
                        "description": "Hash algorithm (default sha256).",
                    },
                },
                "required": ["text"],
            },
            func=_hash_text,
        ),
        Tool(
            name="run_python",
            description=(
                "Run Python 3 and return its stdout/stderr. Use for calculations, "
                "data work, or to write and TEST code before answering. The full "
                "standard library is available; install more with run_shell "
                "('pip install ...')."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python source to execute."}
                },
                "required": ["code"],
            },
            func=_run_python,
        ),
        Tool(
            name="run_shell",
            description=(
                "Run a shell command and return its output. Use to run other "
                "languages (node, gcc, go, etc.), inspect files, or install "
                "packages (pip/apt). Runs in an isolated, ephemeral sandbox."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "Shell command to run."}
                },
                "required": ["command"],
            },
            func=_run_shell,
        ),
    ]
}


def specs() -> list[dict]:
    """OpenAI-style tool specs to advertise to llama-server."""
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


def execute(name: str, arguments: str) -> str:
    """Run a tool by name with a JSON-encoded argument string."""
    tool = TOOLS.get(name)
    if tool is None:
        return f"error: unknown tool {name!r}"
    try:
        args = json.loads(arguments) if arguments else {}
    except json.JSONDecodeError:
        return f"error: invalid arguments for {name}: {arguments!r}"
    if not isinstance(args, dict):
        return f"error: arguments for {name} must be a JSON object"
    return tool.func(args)
