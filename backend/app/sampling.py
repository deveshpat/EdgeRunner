"""Shared sampling params, system prompts, and context trimming.

Small local models loop and drift without a repetition penalty and sensible
truncation sampling. These defaults follow current best practice for local
GGUF instruct models (repeat_penalty ~1.1, min_p tail cutoff) and are applied
by every harness so responses stay coherent.
"""

from __future__ import annotations

from typing import Optional

DEFAULT_TEMPERATURE = 0.7
DEFAULT_TOP_P = 0.95
DEFAULT_MIN_P = 0.05
DEFAULT_MAX_TOKENS = 1024
REPEAT_PENALTY = 1.1

CHAT_SYSTEM_PROMPT = (
    "You are EdgeRunner, a helpful, precise assistant running on a local model. "
    "Answer directly and correctly; think step by step for hard problems. "
    "Use GitHub-flavored Markdown, and put code in fenced blocks with a language "
    "tag. Keep answers as short as the question allows."
)


def sampling_params(
    temperature: Optional[float],
    top_p: Optional[float],
    max_tokens: Optional[int],
) -> dict:
    """Build the sampling half of a chat-completions payload.

    llama-cpp-python's OpenAI server honours the llama.cpp extras (min_p,
    repeat_penalty) alongside the standard OpenAI fields.
    """
    return {
        "temperature": temperature if temperature is not None else DEFAULT_TEMPERATURE,
        "top_p": top_p if top_p is not None else DEFAULT_TOP_P,
        "min_p": DEFAULT_MIN_P,
        "repeat_penalty": REPEAT_PENALTY,
        "max_tokens": max_tokens if max_tokens is not None else DEFAULT_MAX_TOKENS,
    }


def ensure_system_prompt(messages: list[dict], prompt: str) -> list[dict]:
    """Prepend a system prompt unless the caller already set one."""
    if messages and messages[0].get("role") == "system":
        return messages
    return [{"role": "system", "content": prompt}] + messages


def trim_history(messages: list[dict], max_chars: int = 16000) -> list[dict]:
    """Keep the system message + the most recent turns under a char budget.

    A rough guard against exceeding the context window on long chats (no
    tokenizer here — ~3.5 chars/token, so 16k chars ≈ 4.5k tokens of input,
    leaving room for the reply within an 8k context).
    """
    if not messages:
        return messages
    system: list[dict] = []
    rest = messages
    if messages[0].get("role") == "system":
        system = [messages[0]]
        rest = messages[1:]

    kept: list[dict] = []
    budget = max_chars - sum(len(str(m.get("content") or "")) for m in system)
    for msg in reversed(rest):
        cost = len(str(msg.get("content") or "")) + 16
        if budget - cost < 0 and kept:
            break
        budget -= cost
        kept.append(msg)
    kept.reverse()
    return system + kept
