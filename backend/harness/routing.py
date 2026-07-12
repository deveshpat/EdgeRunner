"""Chat vs harness routing + simple chat path."""

from __future__ import annotations

import re
from typing import Any, Optional

from harness.prompts import system_chat

_progress_cb = None


def set_routing_progress(cb) -> None:
    global _progress_cb
    _progress_cb = cb


def _progress(msg: str) -> None:
    print(msg, flush=True)
    if _progress_cb is not None:
        try:
            _progress_cb(msg)
        except Exception:
            pass


_CODE_HINT = re.compile(
    r"\b("
    r"code|python|function|class|implement|algorithm|debug|fix|bug|"
    r"write\s+(a|an|the|me|some)|script|program|leetcode|solve|assert|"
    r"refactor|optimize|test\s+case|unit\s+test|api|regex|parse|"
    r"sort|binary\s+search|linked\s*list|tree|graph|dfs|bfs|"
    r"sql|query|html|css|javascript|typescript|rust|golang|"
    r"compile|runtime|exception|traceback|stack\s*overflow|"
    r"reverse|string|list|array|dict|hash|recursion|dynamic\s+programming"
    r")\b|"
    r"```|def\s+\w+\s*\(|class\s+\w+|function\s+\w+\s*\(",
    re.IGNORECASE,
)

# User wants to resume incomplete work (must check history)
_CONTINUE_HINT = re.compile(
    r"\b("
    r"continue|resume|left\s+off|keep\s+going|finish|complete|retry|"
    r"try\s+again|fix\s+(it|that|the|this)|where\s+you\s+left|"
    r"pick\s+up|go\s+on|same\s+task|previous\s+task"
    r")\b",
    re.IGNORECASE,
)

_FAILED_HARNESS = re.compile(
    r"(FAILED|AssertionError|Traceback|tests not fully green|Sandbox)",
    re.IGNORECASE,
)


def looks_like_coding_task(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if len(t) < 40 and not _CODE_HINT.search(t):
        return False
    if _CODE_HINT.search(t):
        return True
    return False


def _msg_fields(m: Any) -> tuple[str, str]:
    role = getattr(m, "role", None) or (m.get("role") if isinstance(m, dict) else "") or ""
    content = getattr(m, "content", None) or (
        m.get("content") if isinstance(m, dict) else str(m)
    ) or ""
    return str(role), str(content)


def history_implies_coding(history: Optional[list]) -> bool:
    """True if recent turns look like an unfinished coding task."""
    if not history:
        return False
    # Scan last ~8 messages newest-first
    recent = list(history)[-8:]
    for m in reversed(recent):
        role, content = _msg_fields(m)
        if role == "user" and looks_like_coding_task(content):
            return True
        if role == "assistant" and (
            _FAILED_HARNESS.search(content)
            or "```python" in content
            or "Final SOTA" in content
            or "### Solution" in content
            or "Execution Results" in content
        ):
            return True
    return False


def is_continue_request(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    if _CONTINUE_HINT.search(t):
        return True
    # Very short nudges
    if t.lower() in ("continue", "go on", "again", "retry", "resume"):
        return True
    return False


def resolve_coding_task(user_text: str, history: Optional[list] = None) -> Optional[str]:
    """
    If this turn should run the harness, return the effective task string.
    For 'continue where you left off', rehydrate the last coding user request
    and include failure context from the last assistant reply.
    """
    t = (user_text or "").strip()
    if not t:
        return None

    if looks_like_coding_task(t) and not is_continue_request(t):
        return t

    if is_continue_request(t) or (
        len(t) < 80 and history_implies_coding(history) and not looks_like_coding_task(t)
    ):
        if not history_implies_coding(history):
            # continue with no coding history → not harness
            if not looks_like_coding_task(t):
                return None
            return t

        last_user_task = ""
        last_assistant = ""
        for m in history or []:
            role, content = _msg_fields(m)
            if role == "user" and looks_like_coding_task(content):
                last_user_task = content.strip()
            if role == "assistant":
                last_assistant = content.strip()

        if not last_user_task:
            # fall back: any substantial user message
            for m in reversed(history or []):
                role, content = _msg_fields(m)
                if role == "user" and len(content.strip()) > 20:
                    last_user_task = content.strip()
                    break

        if not last_user_task:
            return t if looks_like_coding_task(t) else None

        # Build continuation task with prior failure snippet for reflection
        fail_snip = ""
        if last_assistant:
            # Keep last ~1200 chars of assistant (errors matter)
            fail_snip = last_assistant[-1200:]
        parts = [
            last_user_task,
            "\n\n---\nThe previous attempt was incomplete or failed. "
            "Continue and finish a correct solution that passes thorough tests.",
        ]
        if fail_snip:
            parts.append(f"\n\nPrevious assistant output (for context):\n{fail_snip}")
        if t and not is_continue_request(t):
            parts.append(f"\n\nUser note: {t}")
        return "".join(parts)

    return None


def should_use_harness(
    user_text: str, history: Optional[list] = None, force: bool = False
) -> tuple[bool, str]:
    """Return (use_harness, effective_task)."""
    if force:
        return True, (user_text or "").strip()
    task = resolve_coding_task(user_text, history)
    if task:
        return True, task
    return False, (user_text or "").strip()


def _invoke_text(llm, prompt: str, *, max_tokens: int) -> str:
    from langchain_core.messages import HumanMessage

    try:
        bound = llm.bind(max_tokens=max_tokens) if hasattr(llm, "bind") else llm
        response = bound.invoke([HumanMessage(content=prompt)])
    except Exception:
        response = llm.invoke([HumanMessage(content=prompt)])
    return getattr(response, "content", None) or str(response)


def simple_chat(user_text: str, history: Optional[list] = None) -> dict:
    from harness.llm_bridge import get_llm
    from harness.thinking import split_think

    _progress("💬 [Chat] Generating reply…")
    hist = history or []
    hist_snip = ""
    for m in hist[-8:]:
        role, content = _msg_fields(m)
        if role and content:
            hist_snip += f"{role}: {str(content)[:500]}\n"

    prompt = f"{system_chat()}\n\n{hist_snip}user: {user_text}\nassistant:"
    llm = get_llm()
    raw = _invoke_text(llm, prompt, max_tokens=768)
    visible, thoughts = split_think(raw)

    if not visible:
        # Thinking model spent every token inside <think> (or truncated there).
        # Close the block ourselves and ask for the answer only.
        _progress("💬 [Chat] Reply was all reasoning — asking for the final answer…")
        follow = (
            f"{prompt}{raw}\n</think>\n\n"
            "Now give ONLY the final answer to the user — concise, complete "
            "sentences, no <think> tags:"
        )
        raw2 = _invoke_text(llm, follow, max_tokens=512)
        v2, t2 = split_think(raw2)
        visible = v2 or raw2.strip()
        thoughts = "\n\n".join(x for x in (thoughts, t2) if x)

    _progress("💬 [Chat] Done.")
    return {
        "mode": "chat",
        "response": visible.strip(),
        "thought_process": (
            [thoughts]
            if thoughts
            else ["Direct chat reply (coding harness skipped for this message)."]
        ),
        "code": "",
        "terminal_output": "",
    }
