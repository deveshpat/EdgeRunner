"""Unit tests that do not require a loaded GGUF."""

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness.language import detect_language, extract_fenced_code
from harness.mcp_client import BuiltinToolRegistry, parse_tool_calls as mcp_parse
from harness.sandbox import run_solution_and_tests
from harness.tools.registry import ToolRegistry, parse_tool_calls
from harness.commands import resolve_slash
from harness.routing import should_use_harness, is_continue_request


def test_detect_python():
    lang = detect_language("write a python function that reverses a string")
    assert lang.id == "python"


def test_detect_js():
    lang = detect_language("implement a javascript function to reverse a string")
    assert lang.id == "javascript"


def test_extract_fence():
    text = "Here:\n```python\ndef f():\n    return 1\n```\n"
    assert "def f" in extract_fenced_code(text, preferred="python")


def test_sandbox_python_pass():
    code = "def rev(s):\n    return s[::-1]\n"
    tests = "assert rev('ab') == 'ba'\nassert rev('') == ''\n"
    res, ws = run_solution_and_tests(detect_language("python"), code, tests)
    try:
        assert res.ok, res.observation()
        assert "status: SUCCESS" in res.observation()
    finally:
        ws.cleanup()


def test_sandbox_python_fail():
    code = "def rev(s):\n    return s\n"
    tests = "assert rev('ab') == 'ba'\n"
    res, ws = run_solution_and_tests(detect_language("python"), code, tests)
    try:
        assert not res.ok
    finally:
        ws.cleanup()


def test_builtin_python_exec():
    reg = BuiltinToolRegistry()
    r = reg.call("python_exec", {"code": "print(2+2)"})
    assert r.ok
    assert "4" in r.content


def test_parse_tool_calls_mcp():
    text = 'before <tool name="which">{"name": "python"}</tool> after'
    calls = mcp_parse(text)
    assert calls == [("which", {"name": "python"})]


def test_opencode_tools_write_edit_read():
    with tempfile.TemporaryDirectory() as d:
        reg = ToolRegistry(cwd=Path(d))
        r = reg.call("write", {"path": "a.py", "content": "x = 1\n"})
        assert r.ok
        r = reg.call("read", {"path": "a.py"})
        assert r.ok and "x = 1" in r.content
        r = reg.call(
            "edit",
            {"path": "a.py", "oldString": "x = 1", "newString": "x = 2"},
        )
        assert r.ok
        assert "x = 2" in (reg.cwd / "a.py").read_text()


def test_opencode_edit_requires_read():
    with tempfile.TemporaryDirectory() as d:
        reg = ToolRegistry(cwd=Path(d))
        (reg.cwd / "b.py").write_text("y = 1\n")
        r = reg.call(
            "edit",
            {"path": "b.py", "oldString": "y = 1", "newString": "y = 2"},
        )
        assert not r.ok
        assert "Read" in r.content or "read" in r.content.lower()


def test_parse_opencode_tool_xml():
    text = '<tool name="bash">{"command": "echo hi"}</tool>'
    calls = parse_tool_calls(text)
    assert calls[0][0] == "bash"
    assert calls[0][1]["command"] == "echo hi"


def test_aliases():
    with tempfile.TemporaryDirectory() as d:
        reg = ToolRegistry(cwd=Path(d))
        r = reg.call("shell_exec", {"command": "echo ok"})
        assert r.ok
        assert "ok" in r.content


def test_websearch_registered():
    with tempfile.TemporaryDirectory() as d:
        reg = ToolRegistry(cwd=Path(d))
        assert "websearch" in reg.names(plan_mode=True)
        # missing query fails fast (no network)
        r = reg.call("websearch", {})
        assert not r.ok


def test_sanitize_fenced_write_content():
    from harness.tools.registry import sanitize_file_content, ToolRegistry

    raw = "```python\ndef f():\n    return 1\n```"
    clean = sanitize_file_content(raw)
    assert clean.startswith("def f")
    assert "```" not in clean

    with tempfile.TemporaryDirectory() as d:
        reg = ToolRegistry(cwd=Path(d))
        r = reg.call(
            "write",
            {"path": "solution.py", "content": raw},
        )
        assert r.ok
        body = (reg.cwd / "solution.py").read_text()
        assert "def f" in body
        assert "```" not in body


def test_pure_coding_and_auto_verify():
    from harness.agent_loop import (
        _is_pure_coding_exercise,
        _ensure_tests_file,
        _maybe_auto_verify,
    )

    assert _is_pure_coding_exercise("write a function to reverse a string")
    assert not _is_pure_coding_exercise("x" * 3000 + " implement")

    with tempfile.TemporaryDirectory() as d:
        reg = ToolRegistry(cwd=Path(d))
        _ensure_tests_file(reg, "write reverse_string")
        assert (reg.cwd / "tests_auto.py").is_file()
        # second call is no-op
        _ensure_tests_file(reg, "write reverse_string")

        # without solution → no auto verify
        assert _maybe_auto_verify(
            reg, wrote_this_step=True, already_ran_verify=False
        ) == []

        reg.call("write", {"path": "solution.py", "content": "def reverse_string(s):\n    return s[::-1]\n"})
        auto = _maybe_auto_verify(
            reg, wrote_this_step=True, already_ran_verify=False
        )
        assert auto and auto[0][0] == "run_python"
        assert auto[0][1]["path"] == "tests_auto.py"

        # skip if already verified this step
        assert (
            _maybe_auto_verify(
                reg, wrote_this_step=True, already_ran_verify=True
            )
            == []
        )

        # run tests — should pass (validates auto-test quality for reverse)
        r = reg.call("run_python", {"path": "tests_auto.py"})
        assert r.ok, r.content


def test_resolve_slash_plan():
    r = resolve_slash("/plan reverse a string")
    assert r.agent == "plan"
    assert r.force_harness
    assert "reverse" in r.task.lower() or "ARGUMENTS" not in r.task


def test_resolve_slash_code():
    r = resolve_slash("/code def foo")
    assert r.agent == "build"
    assert r.force_harness


def test_continue_routing():
    assert is_continue_request("continue where you left off")
    use, task = should_use_harness(
        "continue",
        history=[
            {"role": "user", "content": "write a python function to reverse a string"},
            {"role": "assistant", "content": "### Solution\n```python\npass\n```\nFAILED"},
        ],
    )
    assert use
    assert "reverse" in task.lower()


if __name__ == "__main__":
    test_detect_python()
    test_detect_js()
    test_extract_fence()
    test_sandbox_python_pass()
    test_sandbox_python_fail()
    test_builtin_python_exec()
    test_parse_tool_calls_mcp()
    test_opencode_tools_write_edit_read()
    test_opencode_edit_requires_read()
    test_parse_opencode_tool_xml()
    test_aliases()
    test_resolve_slash_plan()
    test_resolve_slash_code()
    test_continue_routing()
    print("ok")


# ── thinking-model output hygiene ────────────────────────────────────────────

from harness.thinking import split_think, strip_think


def test_split_think_closed_block():
    visible, reasoning = split_think("<think>let me plan</think>The answer is 4.")
    assert visible == "The answer is 4."
    assert "let me plan" in reasoning


def test_split_think_unclosed_truncated():
    visible, reasoning = split_think("<think>I was cut off mid reason")
    assert visible == ""
    assert "cut off" in reasoning


def test_split_think_stray_close_tag():
    visible, reasoning = split_think("hidden reasoning here</think>Visible reply.")
    assert visible == "Visible reply."
    assert "hidden reasoning" in reasoning


def test_split_think_no_tags_passthrough():
    visible, reasoning = split_think("Plain answer, no tags.")
    assert visible == "Plain answer, no tags."
    assert reasoning == ""


def test_split_think_multiple_blocks():
    visible, _ = split_think("<think>a</think>one <think>b</think>two")
    assert "one" in visible and "two" in visible
    assert "<think>" not in visible


def test_strip_think_helper():
    assert strip_think("<think>x</think>y") == "y"


def test_clean_output_handles_unclosed_think():
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from main import clean_output

    # Unclosed think block → nothing visible; keep raw text rather than empty
    out = clean_output("<think>only reasoning, truncated")
    assert out  # never returns empty for non-empty input
    assert clean_output("<think>r</think>final") == "final"


def test_parse_unknown_slash_never_reaches_model():
    # Backend counterpart: /commands resolver should not treat /sett as chat
    from harness.commands import resolve_slash

    resolved = resolve_slash("/sett")
    # resolve_slash returns None/no-op for unknown; the frontend now blocks it
    assert resolved is None or getattr(resolved, "kind", None) != "prompt"


def test_question_after_coding_history_routes_to_chat():
    history = [
        {"role": "user", "content": "write a python function fizzbuzz(n) with tests"},
        {"role": "assistant", "content": "### Solution\n```python\ndef fizzbuzz(n): ...\n```"},
    ]
    use, _ = should_use_harness(
        "Can you give me an overview of the EdgeRunner project?", history=history
    )
    assert use is False


def test_explicit_continue_after_coding_history_still_harness():
    history = [
        {"role": "user", "content": "write a python function fizzbuzz(n) with tests"},
        {"role": "assistant", "content": "Traceback (most recent call last): FAILED"},
    ]
    use, task = should_use_harness("continue", history=history)
    assert use is True
    assert "fizzbuzz" in task


# ── generation completeness (anti-truncation) ────────────────────────────────

from harness.generate import looks_unfinished


def test_unfinished_unclosed_think():
    assert looks_unfinished("<think>still reasoning about the")


def test_unfinished_unclosed_tool():
    assert looks_unfinished('<tool name="write">\n{"path": "a.py"')


def test_unfinished_unclosed_fence():
    assert looks_unfinished("Here is code:\n```python\ndef f():")


def test_unfinished_mid_sentence():
    assert looks_unfinished("The answer is that we should refactor the")


def test_finished_clean_reply():
    assert not looks_unfinished("The function reverses a string. Tests pass.")


def test_finished_closed_fence():
    assert not looks_unfinished("```python\ndef f():\n    return 1\n```")


def test_chat_request_accepts_system_field():
    from schemas import ChatRequest

    req = ChatRequest(
        messages=[{"role": "user", "content": "hi"}],
        system="always answer in haiku",
    )
    assert req.system == "always answer in haiku"


# ── Hermes engine integration (OpenAI shim dialect) ──────────────────────────

import json

from openai_shim import convert_messages, render_tools_block
from openai_shim import parse_tool_calls as shim_parse_tool_calls


def test_shim_parses_tool_call_block():
    text = 'Sure.\n<tool_call>\n{"name": "terminal", "arguments": {"command": "ls"}}\n</tool_call>'
    content, calls = shim_parse_tool_calls(text)
    assert content == "Sure."
    assert len(calls) == 1
    assert calls[0]["function"]["name"] == "terminal"
    assert json.loads(calls[0]["function"]["arguments"]) == {"command": "ls"}


def test_shim_parses_single_quoted_tool_call():
    text = "<tool_call>\n{'name': 'todo', 'arguments': {'action': 'list'}}\n</tool_call>"
    content, calls = shim_parse_tool_calls(text)
    assert content == ""
    assert calls[0]["function"]["name"] == "todo"


def test_shim_leaves_plain_text_alone():
    content, calls = shim_parse_tool_calls("Just a normal answer.")
    assert content == "Just a normal answer."
    assert calls == []


def test_shim_injects_hermes_tools_into_system():
    tools = [
        {
            "type": "function",
            "function": {"name": "terminal", "parameters": {"type": "object"}},
        }
    ]
    msgs = convert_messages(
        [{"role": "system", "content": "base"}, {"role": "user", "content": "hi"}],
        tools,
    )
    assert msgs[0]["role"] == "system"
    assert "<tools>" in msgs[0]["content"]
    assert '"terminal"' in msgs[0]["content"]
    assert "<tool_call>" in msgs[0]["content"]  # dialect instructions present


def test_shim_converts_tool_history_to_plain_roles():
    msgs = convert_messages(
        [
            {"role": "user", "content": "run ls"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "terminal", "arguments": '{"command": "ls"}'},
                    }
                ],
            },
            {"role": "tool", "content": "file_a\nfile_b", "tool_call_id": "call_1"},
        ],
        None,
    )
    roles = [m["role"] for m in msgs]
    assert roles == ["user", "assistant", "user"]
    assert "<tool_call>" in msgs[1]["content"]
    assert "<tool_response>" in msgs[2]["content"]


def test_render_tools_block_one_per_line():
    block = render_tools_block(
        [
            {"type": "function", "function": {"name": "a"}},
            {"type": "function", "function": {"name": "b"}},
        ]
    )
    assert block.count("\n") == 1


def test_engine_falls_back_to_native_when_hermes_missing(monkeypatch):
    import er_agent

    called = {}

    def fake_simple_chat(text, history=None, system_extra=""):
        called["chat"] = True
        return {"mode": "chat", "response": "ok", "thought_process": []}

    monkeypatch.setattr(er_agent, "simple_chat", fake_simple_chat)
    # hermes-agent is not installed in the test venv → must fall back
    result = er_agent.run_user_message("hello there", engine="hermes")
    assert called.get("chat") is True
    assert result["response"] == "ok"
