"""Tests for shared sampling params, system prompt, and context trimming."""

from __future__ import annotations

from app.sampling import (
    REPEAT_PENALTY,
    ensure_system_prompt,
    sampling_params,
    trim_history,
)


def test_sampling_params_defaults_and_overrides():
    p = sampling_params(None, None, None)
    assert p["repeat_penalty"] == REPEAT_PENALTY
    assert 0 < p["min_p"] < 1
    assert p["temperature"] > 0 and p["max_tokens"] > 0
    p2 = sampling_params(0.1, 0.5, 42)
    assert p2["temperature"] == 0.1 and p2["top_p"] == 0.5 and p2["max_tokens"] == 42


def test_ensure_system_prompt_prepends_once():
    msgs = [{"role": "user", "content": "hi"}]
    out = ensure_system_prompt(msgs, "SYS")
    assert out[0] == {"role": "system", "content": "SYS"}
    # doesn't double up if one already exists
    already = [{"role": "system", "content": "X"}, {"role": "user", "content": "hi"}]
    assert ensure_system_prompt(already, "SYS") == already


def test_trim_history_keeps_system_and_recent():
    system = {"role": "system", "content": "S"}
    old = [{"role": "user", "content": "x" * 10000} for _ in range(5)]
    recent = {"role": "user", "content": "latest question"}
    trimmed = trim_history([system, *old, recent], max_chars=16000)
    assert trimmed[0] == system  # system always kept
    assert trimmed[-1] == recent  # most recent kept
    assert len(trimmed) < len(old) + 2  # older turns dropped


def test_trim_history_short_is_unchanged():
    msgs = [
        {"role": "system", "content": "S"},
        {"role": "user", "content": "hi"},
    ]
    assert trim_history(msgs) == msgs
