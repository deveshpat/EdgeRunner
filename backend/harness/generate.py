"""Shared LLM text generation: token streaming + auto-continuation + cancel.

Design notes (distilled from production harnesses):
  • Tokens stream to the client as they are produced (Claude Code / OpenCode
    style) so a dropped session keeps the partial output and "continue where
    you left off" has real text to resume from.
  • Truncation is treated as a harness failure: when a reply hits the token
    cap or ends visibly unfinished (unclosed <think>/<tool>/code fence,
    mid-sentence), generation continues for up to `rounds` extra passes.
  • Compute guards: continuation stops the moment a round ends naturally,
    produces nothing new, or repeats text it already wrote.
  • A cancel check aborts between tokens and between rounds (user /stop).
"""

from __future__ import annotations

import re
from typing import Callable, Optional

_token_cb: Optional[Callable[[str], None]] = None
_cancel_check: Optional[Callable[[], bool]] = None


def set_token_callback(cb: Optional[Callable[[str], None]]) -> None:
    global _token_cb
    _token_cb = cb


def get_token_callback() -> Optional[Callable[[str], None]]:
    return _token_cb


def set_cancel_check(cb: Optional[Callable[[], bool]]) -> None:
    global _cancel_check
    _cancel_check = cb


def cancelled() -> bool:
    try:
        return bool(_cancel_check and _cancel_check())
    except Exception:
        return False


def _emit(text: str) -> None:
    if _token_cb is not None and text:
        try:
            _token_cb(text)
        except Exception:
            pass


def _stream_once(llm, prompt: str, max_tokens: int) -> str:
    from langchain_core.messages import HumanMessage

    try:
        bound = llm.bind(max_tokens=max_tokens) if hasattr(llm, "bind") else llm
    except Exception:
        bound = llm
    parts: list[str] = []
    try:
        for chunk in bound.stream([HumanMessage(content=prompt)]):
            t = getattr(chunk, "content", None) or ""
            if t:
                parts.append(t)
                _emit(t)
            if cancelled():
                break
        return "".join(parts)
    except Exception:
        if parts:
            return "".join(parts)
        # Streaming unsupported → single blocking call
        resp = bound.invoke([HumanMessage(content=prompt)])
        text = getattr(resp, "content", None) or str(resp)
        _emit(text)
        return text


_FENCE = re.compile(r"```")
_TAGS = r"(?:think|thinking|thought|reasoning)"


def looks_unfinished(text: str) -> bool:
    """Heuristic: did generation stop before the model finished?"""
    t = (text or "").rstrip()
    if not t:
        return False
    opens = len(re.findall(rf"<\s*{_TAGS}\s*>", t, re.I))
    closes = len(re.findall(rf"</\s*{_TAGS}\s*>", t, re.I))
    if opens > closes:
        return True
    if t.count("<tool") > t.count("</tool>"):
        return True
    if len(_FENCE.findall(t)) % 2 == 1:
        return True
    # Ends mid-sentence / mid-expression (no terminal punctuation or closer)
    if re.search(r"[A-Za-z0-9,;:(\[{\-=+*/]$", t) and not t.endswith("done"):
        return True
    return False


def generate_text(
    prompt: str,
    *,
    max_tokens: int = 1200,
    rounds: int = 2,
    llm=None,
) -> str:
    """Stream one reply; continue up to `rounds` passes until it is finished."""
    if llm is None:
        from harness.llm_bridge import get_llm

        llm = get_llm()

    total = _stream_once(llm, prompt, max_tokens)
    done_rounds = 0
    while (
        looks_unfinished(total)
        and done_rounds < rounds
        and not cancelled()
    ):
        done_rounds += 1
        cont = _stream_once(llm, prompt + total, max_tokens)
        stripped = cont.strip()
        if not stripped:
            break
        # Repeat guard: model re-emitting text it already wrote → stop
        if stripped in total:
            break
        total += cont
    return total.strip()
