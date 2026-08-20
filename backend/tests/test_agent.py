"""Tests for the unified terminal omnitool, alias resolver, and dual-mode streaming agent harness."""

from __future__ import annotations

import json

import httpx
import pytest

from app import tools
from app.harnesses import agent as agent_mod
from app.harnesses.agent import AgentHarness
from app.schemas import ChatRequest


# --- tools & aliases --------------------------------------------------------


def test_terminal_basic():
    out = tools.execute("terminal", json.dumps({"command": "echo 'hello terminal'"}))
    assert "hello terminal" in out


def test_terminal_alias_bash_and_sh():
    out = tools.execute("bash", json.dumps({"command": "echo 'from bash'"}))
    assert "from bash" in out
    out2 = tools.execute("sh", json.dumps({"cmd": "echo 'from sh'"}))
    assert "from sh" in out2


def test_terminal_alias_python():
    out = tools.execute("python", json.dumps({"code": "print(21 * 2)"}))
    assert "42" in out.strip()


def test_terminal_alias_calculator():
    out = tools.execute("calculator", json.dumps({"expression": "print(10 + 5)"}))
    assert "15" in out.strip()


def test_terminal_fuzzy_args():
    # Model sends 'cmd' instead of 'command'
    out = tools.execute("terminal", json.dumps({"cmd": "echo 'fuzzy cmd'"}))
    assert "fuzzy cmd" in out
    # Model sends raw text instead of JSON
    out_raw = tools.execute("terminal", "echo 'raw text'")
    assert "raw text" in out_raw


def test_terminal_specs():
    specs = tools.specs()
    assert len(specs) == 19
    tool_names = [s["function"]["name"] for s in specs]
    assert "terminal" in tool_names
    assert "view_file" in tool_names
    assert "replace_file_content" in tool_names
    assert "grep_search" in tool_names
    assert "file_search" in tool_names
    assert "web_search" in tool_names
    assert "fetch_web_page" in tool_names
    assert "save_skill" in tool_names
    assert "run_skill" in tool_names
    assert "list_skills" in tool_names
    assert "delegate_task" in tool_names
    assert "ask_user" in tool_names
    assert "consult_oracle" in tool_names
    assert "create_custom_tool" in tool_names
    assert "update_tool" in tool_names
    assert "retire_tool" in tool_names
    assert "inspect_tool_telemetry" in tool_names
    assert "evolve_prompt" in tool_names
    assert "inspect_agent_genome" in tool_names


def test_prompt_evolution_and_adaptive_sampling():
    from app.prompt_evolution import get_evolved_system_prompt
    from app.sampling import sampling_params

    # 1. Test prompt evolution tool
    evolve_out = tools.execute("evolve_prompt", json.dumps({
        "gene_name": "error_recovery",
        "lesson_learned": "Always check for pyproject.toml before installing with uv",
    }))
    assert "Successfully evolved prompt gene" in evolve_out

    # 2. Verify evolved system prompt reflects new mutation
    system_prompt = get_evolved_system_prompt()
    assert "pyproject.toml" in system_prompt

    # 3. Test genome inspection
    genome_rep = tools.execute("inspect_agent_genome", {})
    assert "Evolutionary Prompt Genome" in genome_rep

    # 4. Test adaptive sampling
    code_params = sampling_params(context_hint="Traceback (most recent call last): syntax error")
    assert code_params["temperature"] == 0.15

    creative_params = sampling_params(context_hint="Research and brainstorm architecture for microservices")
    assert creative_params["temperature"] == 0.60


def test_tool_crud_and_telemetry():
    # 1. Create a custom tool
    create_out = tools.execute("create_custom_tool", json.dumps({
        "name": "calc_square",
        "description": "Calculate square of a number",
        "script": "import sys, json\nargs = json.loads(sys.argv[1]) if sys.argv[1].startswith('{') else {'num': float(sys.argv[1])}\nprint(float(args.get('num', 0)) ** 2)\n",
    }))
    assert "Successfully created and hot-loaded" in create_out

    # 2. Execute custom tool
    run_out = tools.execute("calc_square", json.dumps({"num": 5}))
    assert "25.0" in run_out

    # 3. Update tool
    up_out = tools.execute("update_tool", json.dumps({
        "name": "calc_square",
        "description": "Calculate square of a number (updated description)",
    }))
    assert "Successfully updated" in up_out

    # 4. Inspect telemetry
    telem_out = tools.execute("inspect_tool_telemetry", {})
    assert "calc_square" in telem_out or "Healthy" in telem_out

    # 5. Retire tool
    ret_out = tools.execute("retire_tool", json.dumps({"name": "calc_square"}))
    assert "Retired deadweight tool" in ret_out


def test_consult_oracle_and_tool_slicing():
    # 1. Test consult_oracle tool execution
    diag = tools.execute("consult_oracle", json.dumps({"problem_or_query": "ModuleNotFoundError: No module named 'pydantic'"}))
    assert "Missing Python dependency" in diag
    assert "uv pip install pydantic" in diag

    # 2. Test dynamic tool slicing (slicing down from 13 to a lean 4-6 tools)
    sliced_search = tools.get_active_tool_slice([{"role": "user", "content": "search docs for nextjs"}])
    assert len(sliced_search) < len(tools.specs())
    sliced_names = [s["function"]["name"] for s in sliced_search]
    assert "web_search" in sliced_names
    assert "terminal" in sliced_names
    assert "consult_oracle" in sliced_names


def test_compute_tool_nudge():
    from app.nudges import compute_tool_nudge

    # 1. Test traceback nudge
    tb_msgs = [{"role": "tool", "content": 'Traceback (most recent call last):\n  File "main.py", line 42, in <module>\n    foo()\nTypeError: bar'}]
    nudge = compute_tool_nudge(tb_msgs)
    assert nudge is not None
    assert "view_file" in nudge
    assert "main.py" in nudge

    # 2. Test missing module nudge
    mod_msgs = [{"role": "tool", "content": "ModuleNotFoundError: No module named 'fastapi'"}]
    mod_nudge = compute_tool_nudge(mod_msgs)
    assert mod_nudge is not None
    assert "uv pip install fastapi" in mod_nudge

    # 3. Test user documentation intent
    user_msgs = [{"role": "user", "content": "how to configure tailwind v4 in nextjs"}]
    user_nudge = compute_tool_nudge(user_msgs)
    assert user_nudge is not None
    assert "web_search" in user_nudge


def test_skill_store_and_delegation():
    # Test list_skills
    skills_out = tools.execute("list_skills", {})
    assert "csv_to_sqlite" in skills_out

    # Test save_skill and run_skill
    save_out = tools.execute("save_skill", json.dumps({
        "name": "greet_user",
        "description": "Greet a user by name",
        "script": "import sys\nprint(f'Hello {sys.argv[1]} from EdgeRunner Skill!')\n",
        "parameters": ["name"],
    }))
    assert "Registered skill 'greet_user'" in save_out

    run_out = tools.execute("run_skill", json.dumps({
        "name": "greet_user",
        "arguments": ["Developer"],
    }))
    assert "Hello Developer from EdgeRunner Skill!" in run_out

    # Test delegate_task
    deleg_out = tools.execute("delegate_task", json.dumps({
        "role": "researcher",
        "objective": "find react documentation",
    }))
    assert "Researcher" in deleg_out


def test_view_and_replace_file_tools(tmp_path):
    # Test view_file and replace_file_content in workspace
    from app.workspace import WORKSPACE_ROOT
    test_file = WORKSPACE_ROOT / "test_sample.txt"
    test_file.write_text("line 1\nline 2: hello world\nline 3\n", encoding="utf-8")

    # 1. View file
    view_out = tools.execute("view_file", json.dumps({"path": "test_sample.txt", "start_line": 1, "end_line": 2}))
    assert "1 | line 1" in view_out
    assert "2 | line 2: hello world" in view_out

    # 2. Replace file content
    rep_out = tools.execute("replace_file_content", json.dumps({
        "path": "test_sample.txt",
        "target_content": "hello world",
        "replacement_content": "hello edgerunner",
    }))
    assert "Successfully replaced" in rep_out
    assert "hello edgerunner" in test_file.read_text(encoding="utf-8")

    # Cleanup
    test_file.unlink(missing_ok=True)


# --- streaming agent loop --------------------------------------------------


def _sse(*chunks: dict) -> str:
    body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks)
    return body + "data: [DONE]\n\n"


class _MockTransport(httpx.AsyncBaseTransport):
    """Streams a tool call (split across chunks) then a streamed answer."""

    def __init__(self):
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls == 1:
            body = _sse(
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "id": "call_1",
                                        "type": "function",
                                        "function": {"name": "terminal", "arguments": ""},
                                    }
                                ],
                            },
                            "finish_reason": None,
                        }
                    ]
                },
                # arguments arrive fragmented across two chunks
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {"index": 0, "function": {"arguments": '{"command": "python3 -c \\"print(21'}}
                                ]
                            },
                            "finish_reason": None,
                        }
                    ]
                },
                {
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": 0,
                                        "function": {"arguments": ' * 2)\\""}'},
                                    }
                                ]
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                },
            )
        else:
            body = _sse(
                {"choices": [{"index": 0, "delta": {"content": "The "}}]},
                {"choices": [{"index": 0, "delta": {"content": "answer "}}]},
                {
                    "choices": [
                        {"index": 0, "delta": {"content": "is 42."}, "finish_reason": "stop"}
                    ]
                },
            )
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/event-stream"}
        )


@pytest.mark.asyncio
async def test_agent_streams_tool_then_answer(monkeypatch):
    transport = _MockTransport()
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=transport)

    monkeypatch.setattr(agent_mod.httpx, "AsyncClient", fake_client)

    harness = AgentHarness()
    req = ChatRequest(
        model="m",
        harness="agent",
        messages=[{"role": "user", "content": "what is 21 * 2?"}],
    )
    events = [ev async for ev in harness.run(req)]
    types = [e.type for e in events]

    assert "tool_call" in types
    assert "tool_result" in types
    assert types[-1] == "done"
    assert transport.calls == 2

    # Fragmented arguments were reassembled and execution produced 42.
    call_ev = next(e for e in events if e.type == "tool_call")
    assert "21 * 2" in json.loads(call_ev.data)["arguments"]
    result_ev = next(e for e in events if e.type == "tool_result")
    assert "42" in json.loads(result_ev.data)["result"]

    # The final answer was streamed as tokens.
    answer = "".join(e.data for e in events if e.type == "token")
    assert "42" in answer


class _MockMarkdownFallbackTransport(httpx.AsyncBaseTransport):
    """Simulates a small model writing a python markdown block instead of a tool call."""

    def __init__(self):
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls == 1:
            body = _sse(
                {"choices": [{"index": 0, "delta": {"content": "Let me compute:\n```python\nprint(100 + 44)\n```"}}]}
            )
        else:
            body = _sse(
                {"choices": [{"index": 0, "delta": {"content": "The result is 144."}, "finish_reason": "stop"}]}
            )
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/event-stream"}
        )


@pytest.mark.asyncio
async def test_agent_markdown_fallback(monkeypatch):
    transport = _MockMarkdownFallbackTransport()
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=transport)

    monkeypatch.setattr(agent_mod.httpx, "AsyncClient", fake_client)

    harness = AgentHarness()
    req = ChatRequest(
        model="m",
        harness="agent",
        messages=[{"role": "user", "content": "compute 100+44"}],
    )
    events = [ev async for ev in harness.run(req)]
    types = [e.type for e in events]

    assert "tool_call" in types
    assert "tool_result" in types
    assert types[-1] == "done"
    assert transport.calls == 2

    result_ev = next(e for e in events if e.type == "tool_result")
    assert "144" in json.loads(result_ev.data)["result"]


class _MockXmlToolCallTransport(httpx.AsyncBaseTransport):
    """Simulates model emitting raw XML <tool_call><function=terminal><parameter=command>..."""

    def __init__(self):
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls == 1:
            xml_output = """I'll teach you C++ in a structured way! Let's start with a practical example in the terminal.

<tool_call>
<function=terminal>
<parameter=command>
cat > hello_test.cpp << 'EOF'
#include <iostream>
using namespace std;

int main() {
    cout << "Hello, C++ Testing!" << endl;
    return 0;
}
EOF
</parameter>
</function>
</tool_call>"""
            body = _sse({"choices": [{"index": 0, "delta": {"content": xml_output}}]})
        else:
            body = _sse(
                {"choices": [{"index": 0, "delta": {"content": "File hello_test.cpp created successfully."}, "finish_reason": "stop"}]}
            )
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/event-stream"}
        )


@pytest.mark.asyncio
async def test_agent_xml_tool_call_cpp(monkeypatch):
    transport = _MockXmlToolCallTransport()
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=transport)

    monkeypatch.setattr(agent_mod.httpx, "AsyncClient", fake_client)

    harness = AgentHarness()
    req = ChatRequest(
        model="m",
        harness="agent",
        messages=[{"role": "user", "content": "teach me C++"}],
    )
    events = [ev async for ev in harness.run(req)]
    types = [e.type for e in events]

    assert "tool_call" in types
    assert "tool_result" in types
    assert types[-1] == "done"
    assert transport.calls == 2

    # Verify the file was actually written to the workspace
    cat_out = tools.execute("terminal", "cat hello_test.cpp")
    assert "Hello, C++ Testing!" in cat_out

    # Clean up test file
    tools.execute("terminal", "rm -f hello_test.cpp")


class _MockJsonXmlToolCallTransport(httpx.AsyncBaseTransport):
    """Simulates model emitting <tool_call>{"name": "terminal", "arguments": {"command": "echo 'xml json'"}}</tool_call>"""

    def __init__(self):
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls == 1:
            raw = '<tool_call>\n{"name": "terminal", "arguments": {"command": "echo \'xml json tool call\'"}}\n</tool_call>'
            body = _sse({"choices": [{"index": 0, "delta": {"content": raw}}]})
        else:
            body = _sse(
                {"choices": [{"index": 0, "delta": {"content": "Done."}, "finish_reason": "stop"}]}
            )
        return httpx.Response(
            200, content=body.encode(), headers={"content-type": "text/event-stream"}
        )


@pytest.mark.asyncio
async def test_agent_json_xml_tool_call(monkeypatch):
    transport = _MockJsonXmlToolCallTransport()
    real_client = httpx.AsyncClient

    def fake_client(*args, **kwargs):
        kwargs.pop("timeout", None)
        return real_client(transport=transport)

    monkeypatch.setattr(agent_mod.httpx, "AsyncClient", fake_client)

    harness = AgentHarness()
    req = ChatRequest(
        model="m",
        harness="agent",
        messages=[{"role": "user", "content": "run test"}],
    )
    events = [ev async for ev in harness.run(req)]
    types = [e.type for e in events]

    assert "tool_call" in types
    assert "tool_result" in types
    assert types[-1] == "done"

    result_ev = next(e for e in events if e.type == "tool_result")
    assert "xml json tool call" in json.loads(result_ev.data)["result"]


def test_implicit_behavioral_learner():
    from app.implicit_learner import process_turn_behavior, get_behavioral_telemetry_report

    # 1. Test frustrated user correction
    neg_rew = process_turn_behavior(
        current_prompt="NO! THAT IS WRONG. I said don't touch that file!!",
        previous_prompts=["Please update the readme"],
        iterations=8,
        duration=12.5,
    )
    assert neg_rew < 0.0

    # 2. Test clean satisfied turn
    pos_rew = process_turn_behavior(
        current_prompt="looks great, now add the unit test",
        previous_prompts=["Please implement the endpoint"],
        iterations=2,
        duration=3.0,
    )
    assert pos_rew > 0.5

    # 3. Test report generation
    rep = get_behavioral_telemetry_report()
    assert "Implicit Human Behavioral Telemetry" in rep


def test_linucb_and_reflexion():
    from app.telemetry import score_tool_linucb, record_tool_call, extract_context_features
    from app.reflexion import record_episodic_reflection, retrieve_episodic_reflections, get_reflexion_report

    # 1. Test LinUCB feature extraction
    feat_err = extract_context_features([{"role": "tool", "content": "Traceback: File app.py line 12"}])
    assert feat_err[1] == 1.0  # error flag

    feat_search = extract_context_features([{"role": "user", "content": "search docs for nextjs"}])
    assert feat_search[2] == 1.0  # search flag

    # 2. Test LinUCB scoring and arm updating
    score_before = score_tool_linucb("web_search", [{"role": "user", "content": "search docs"}])
    assert score_before > 0.0
    record_tool_call("web_search", duration_ms=25.0, is_success=True, context_messages=[{"role": "user", "content": "search docs"}])

    # 3. Test Reflexion episodic memory storage and retrieval
    rec_out = record_episodic_reflection(
        signature="TypeError: cannot unpack non-iterable NoneType object in router.py",
        root_cause="Missing return statement in handler function",
        counterfactual_fix="Inspect handler with 'view_file' and ensure all code branches return a response dict.",
    )
    assert "Recorded Reflexion episodic memory" in rec_out

    # 4. Verify semantic retrieval
    retrieved = retrieve_episodic_reflections("TypeError router.py NoneType")
    assert len(retrieved) > 0
    assert "view_file" in retrieved[0]

    # 5. Verify memory report
    rep = get_reflexion_report()
    assert "Reflexion Episodic Memory Buffer" in rep


def test_recursive_command_sanitization():
    # Test doubly-nested JSON escaping generated by confused models
    nested_json = '{"name=terminal", "arguments": {"command": "{\\"name=terminal\\", \\"arguments\\": {\\"command\\": \\"echo \'unwrapped successfully\'\\"}}"}}'
    out = tools.execute("terminal", nested_json)
    assert "unwrapped successfully" in out

    # Test XML wrapped inside JSON command
    xml_inside_json = json.dumps({"command": "<function=terminal>\n<parameter=command>\necho 'clean xml inside json'\n</parameter>\n</function>"})
    out2 = tools.execute("terminal", xml_inside_json)
    assert "clean xml inside json" in out2


def test_persistent_cwd_and_fuzzy_path_resolution(tmp_path):
    # 1. Test persistent CWD tracking across consecutive commands
    tools.execute("terminal", "mkdir -p my_subproject && cd my_subproject")
    out_pwd = tools.execute("terminal", "pwd")
    assert "my_subproject" in out_pwd

    # Create a nested file
    tools.execute("terminal", "echo 'nested content 123' > nested_file.txt")

    # 2. Test view_file with fuzzy auto-resolution when path is requested from root or without full prefix
    view_out = tools.execute("view_file", json.dumps({"path": "nested_file.txt"}))
    assert "nested content 123" in view_out
    assert "Auto-resolved" in view_out

    # 3. Test replace_file_content with fuzzy resolution
    rep_out = tools.execute("replace_file_content", json.dumps({
        "path": "nested_file.txt",
        "target_content": "nested content 123",
        "replacement_content": "updated content 456",
    }))
    assert "Successfully replaced" in rep_out

    # Verify updated content
    view_updated = tools.execute("view_file", json.dumps({"path": "nested_file.txt"}))
    assert "updated content 456" in view_updated

    # Reset CWD to workspace root
    tools.execute("terminal", "cd /workspace")


def test_hybrid_xml_json_tool_extraction():
    text = '<tool_call>\n{"function=view_file>\n<parameter=path>\npackage.json\n</parameter>\n</function>\n</tool_call>'
    calls = agent_mod._extract_text_tool_calls(text)
    assert len(calls) == 1
    assert calls[0]["name"] == "view_file"
    assert json.loads(calls[0]["arguments"])["path"] == "package.json"


@pytest.mark.asyncio
async def test_deepseek_harness_and_cordis_kernel():
    from app import harnesses
    from app.dsh_plugins import CordisKernel, DshContext, DSH_PRESET_PROMPTS
    from app.harnesses.deepseek import DeepSeekHarness

    # 1. Registry verification
    dsh = harnesses.get("deepseek")
    assert dsh is not None
    assert isinstance(dsh, DeepSeekHarness)
    assert harnesses.get("dsh") is dsh

    # 2. Cordis Kernel Presets
    for preset in ("code", "standard", "minimal", "creator"):
        kernel = CordisKernel(preset=preset)
        assert kernel.preset == preset
        assert len(kernel.plugins) >= 2
        assert preset in DSH_PRESET_PROMPTS

    # 3. Cordis Lifecycle execution
    ctx = DshContext(session_id="test_sess", model="deepseek-coder", preset="code")
    kernel = CordisKernel(preset="code")
    await kernel.run_before_step(ctx)
    assert ctx.active_tools is not None

    # 4. Tool call interception via sandbox plugin
    name, args = await kernel.process_tool_call("terminal", {"command": 'echo "hello"'}, ctx)
    assert name == "terminal"
    assert "echo" in args["command"]

    # 5. Tool result post-processing
    res = await kernel.process_tool_result("terminal", "stdout: clean output", ctx)
    assert "clean output" in res
