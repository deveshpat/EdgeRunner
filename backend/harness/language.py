"""Language detection for multi-runtime harness execution."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class LangSpec:
    id: str
    fence: str
    ext: str
    # Shell template: {path} = solution file, {test_path} = tests file
    run: list[str]


LANGS: dict[str, LangSpec] = {
    "python": LangSpec(
        id="python",
        fence="python",
        ext=".py",
        run=["python", "{path}"],
    ),
    "javascript": LangSpec(
        id="javascript",
        fence="javascript",
        ext=".js",
        run=["node", "{path}"],
    ),
    "typescript": LangSpec(
        id="typescript",
        fence="typescript",
        ext=".ts",
        # Best-effort: node if plain JS-compatible; else fail clearly
        run=["node", "{path}"],
    ),
    "bash": LangSpec(
        id="bash",
        fence="bash",
        ext=".sh",
        run=["bash", "{path}"],
    ),
    "go": LangSpec(
        id="go",
        fence="go",
        ext=".go",
        run=["go", "run", "{path}"],
    ),
    "rust": LangSpec(
        id="rust",
        fence="rust",
        ext=".rs",
        run=["rustc", "{path}", "-o", "{bin}", "&&", "{bin}"],
    ),
}


_HINTS = [
    (r"\b(typescript|tsx|\.ts\b)", "typescript"),
    (r"\b(javascript|node\.?js|\.js\b|npm|react)", "javascript"),
    (r"\b(golang|\bgo\b|\.go\b)", "go"),
    (r"\b(rust|cargo|\.rs\b)", "rust"),
    (r"\b(bash|shell|zsh|\.sh\b)", "bash"),
    (r"\b(python|pytest|django|fastapi|\.py\b)", "python"),
]


def detect_language(task: str, code_hint: str = "") -> LangSpec:
    blob = f"{task}\n{code_hint}".lower()
    for pat, lid in _HINTS:
        if re.search(pat, blob, re.I):
            return LANGS[lid]
    # Fence in existing code
    m = re.search(r"```(\w+)", code_hint or task)
    if m:
        fence = m.group(1).lower()
        if fence in ("js", "javascript", "nodejs"):
            return LANGS["javascript"]
        if fence in ("ts", "typescript"):
            return LANGS["typescript"]
        if fence in ("py", "python"):
            return LANGS["python"]
        if fence in LANGS:
            return LANGS[fence]
    return LANGS["python"]


def extract_fenced_code(text: str, preferred: Optional[str] = None) -> str:
    """Extract first fenced code block; prefer language fence if given."""
    if not text:
        return ""
    blocks = re.findall(r"```(\w*)\n(.*?)```", text, re.DOTALL)
    if not blocks:
        # bare code fallback
        if "def " in text or "function " in text:
            return strip_tests_from_solution(text.strip(), preferred or "python")
        return ""
    if preferred:
        pref = preferred.lower()
        aliases = {
            "python": {"python", "py"},
            "javascript": {"javascript", "js", "nodejs"},
            "typescript": {"typescript", "ts"},
            "bash": {"bash", "sh", "shell", "zsh"},
            "go": {"go", "golang"},
            "rust": {"rust", "rs"},
        }
        want = aliases.get(pref, {pref})
        for lang, body in blocks:
            if lang.lower() in want:
                return strip_tests_from_solution(body.strip(), pref)
    # Prefer non-empty largest block
    body = max((b for _, b in blocks), key=lambda s: len(s.strip()), default="")
    return strip_tests_from_solution(body.strip(), preferred or "python")


def strip_tests_from_solution(code: str, lang_id: str = "python") -> str:
    """
    Models often dump asserts/tests into the solution fence.
    Keep implementation only so sandbox can append its own tests cleanly.
    """
    if not code or not code.strip():
        return code
    lid = (lang_id or "python").lower()
    lines = code.splitlines()
    cut = len(lines)

    if lid in ("python", "py"):
        for i, line in enumerate(lines):
            s = line.strip()
            # Explicit test section markers
            if re.match(r"^#\s*-{0,3}\s*(tests?|test suite|comprehensive test)", s, re.I):
                cut = i
                break
            if re.match(r'^(if\s+__name__\s*==\s*[\'"]__main__[\'"]\s*:)', s):
                cut = i
                break
            # Leading assert block (not inside a function — no indent)
            if s.startswith("assert ") and (not line[:1].isspace()):
                # If we already saw a def/class, treat top-level asserts as tests
                head = "\n".join(lines[:i])
                if "def " in head or "class " in head:
                    cut = i
                    break
    elif lid in ("javascript", "js", "typescript", "ts"):
        for i, line in enumerate(lines):
            s = line.strip()
            if re.match(r"^//\s*-{0,3}\s*tests?", s, re.I):
                cut = i
                break
            if re.match(r"^(console\.assert|assert\()", s) and (not line[:1].isspace()):
                head = "\n".join(lines[:i])
                if "function " in head or "=>" in head:
                    cut = i
                    break

    cleaned = "\n".join(lines[:cut]).rstrip()
    return cleaned + ("\n" if cleaned else "")
