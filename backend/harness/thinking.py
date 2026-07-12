"""Reasoning-tag handling for thinking GGUF models (Qwen/QwQ/DeepSeek-style).

These models emit chain-of-thought inside <think>…</think> before the answer.
Three failure modes leak reasoning into the visible reply:
  • closed block left in place:  "<think>…</think> answer"
  • generation truncated inside the block (no </think> ever arrives)
  • chat template omits the opening tag, so output is "reasoning</think> answer"
"""

from __future__ import annotations

import re

_TAGS = r"(?:think|thinking|thought|reasoning)"
_OPEN = re.compile(rf"<\s*{_TAGS}\s*>", re.I)
_CLOSE = re.compile(rf"</\s*{_TAGS}\s*>", re.I)
_CLOSED_BLOCK = re.compile(rf"<\s*{_TAGS}\s*>(.*?)</\s*{_TAGS}\s*>", re.I | re.S)


def split_think(text: str) -> tuple[str, str]:
    """Split model output into (visible, reasoning). Both may be empty."""
    if not text:
        return "", ""
    reasoning: list[str] = []
    s = text

    def _cut(m: re.Match) -> str:
        reasoning.append(m.group(1).strip())
        return " "

    s = _CLOSED_BLOCK.sub(_cut, s)

    # Unclosed <think>… — generation stopped while still reasoning
    m = _OPEN.search(s)
    if m:
        reasoning.append(s[m.end() :].strip())
        s = s[: m.start()]

    # Stray </think> with no opener — everything before it is reasoning
    m = _CLOSE.search(s)
    if m:
        reasoning.append(s[: m.start()].strip())
        s = s[m.end() :]

    visible = re.sub(r"\n{3,}", "\n\n", s).strip()
    thoughts = "\n\n".join(p for p in reasoning if p)
    return visible, thoughts


def strip_think(text: str) -> str:
    """Visible part only (empty string if the model never left reasoning)."""
    return split_think(text)[0]
