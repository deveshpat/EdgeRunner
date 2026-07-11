"""Unit tests that do not require a loaded GGUF."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from harness.language import detect_language, extract_fenced_code
from harness.mcp_client import BuiltinToolRegistry, parse_tool_calls
from harness.sandbox import run_solution_and_tests


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


def test_parse_tool_calls():
    text = 'before <tool name="which">{"name": "python"}</tool> after'
    calls = parse_tool_calls(text)
    assert calls == [("which", {"name": "python"})]


if __name__ == "__main__":
    test_detect_python()
    test_detect_js()
    test_extract_fence()
    test_sandbox_python_pass()
    test_sandbox_python_fail()
    test_builtin_python_exec()
    test_parse_tool_calls()
    print("ok")
