import re
import subprocess
from typing import Annotated, Optional, Sequence, TypedDict

import operator
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langgraph.graph import END, StateGraph

# Lazy-loaded LLM so FastAPI can boot and report /health before the model is ready.
_local_llm = None
_model_meta: dict = {}


def is_model_ready() -> bool:
    return _local_llm is not None


def get_model_meta() -> dict:
    return dict(_model_meta)


def load_model() -> dict:
    """Download / load the GGUF model. Safe to call multiple times."""
    global _local_llm, _model_meta
    if _local_llm is not None:
        return _model_meta

    from langchain_community.chat_models import ChatLlamaCpp
    from model_manager import get_or_download_model

    model_config = get_or_download_model()
    print("\nLoading model into memory...", flush=True)
    _local_llm = ChatLlamaCpp(
        model_path=model_config["path"],
        temperature=0.2,
        n_ctx=model_config["n_ctx"],
        max_tokens=1500,
        n_gpu_layers=-1,
        verbose=False,
    )
    _model_meta = {
        "name": model_config.get("name", "local"),
        "path": model_config["path"],
        "n_ctx": model_config["n_ctx"],
        "ready": True,
    }
    print("✅ SOTA Engine Loaded!", flush=True)
    return _model_meta


def _llm():
    if _local_llm is None:
        load_model()
    return _local_llm


class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], operator.add]
    plan: str
    tests: str
    code: str
    terminal_output: str
    iterations: int


def extract_code(text: str) -> str:
    match = re.search(r"```python\n(.*?)\n```", text, re.DOTALL)
    return match.group(1) if match else ""


def execute_code_locally(code: str, tests: str) -> str:
    """Runs the generated code and the tests together."""
    full_script = f"{code}\n\n# --- TESTS ---\n{tests}"
    try:
        result = subprocess.run(
            ["python", "-c", full_script],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            return f"✅ SUCCESS. Output:\n{result.stdout.strip()}"
        return f"❌ FAILED. Error Traceback:\n{result.stderr.strip()}"
    except subprocess.TimeoutExpired:
        return "⏳ TIMEOUT. Infinite loop detected."
    except Exception as e:
        return f"⚠️ SYSTEM ERROR: {str(e)}"


def planner_and_tester(state: AgentState):
    print("🧠 [Harness] Analyzing problem & writing tests...", flush=True)
    task = state["messages"][0].content

    prompt = f"""You are a SOTA software architect. 
    Task: {task}
    
    1. Write a brief, step-by-step plan to solve this.
    2. Write a Python script containing `assert` statements to thoroughly test the solution. 
    Ensure the tests call the functions you plan to write.
    
    Output the tests inside a ```python block.
    """
    response = _llm().invoke([HumanMessage(content=prompt)])

    tests = extract_code(response.content)
    return {
        "plan": response.content,
        "tests": tests,
        "messages": [AIMessage(content=f"**1. Planning & Testing Phase:**\n{response.content}")],
    }


def code_generator(state: AgentState):
    print("💻 [Harness] Writing implementation code...", flush=True)
    task = state["messages"][0].content
    plan = state.get("plan", "")
    tests = state.get("tests", "")
    error = state.get("terminal_output", "")

    prompt = f"Task: {task}\n\nPlan:\n{plan}\n\nTests you must pass:\n{tests}\n"

    if error:
        prompt += f"\n⚠️ PREVIOUS ATTEMPT FAILED! Terminal Output:\n{error}\nFix the bug!\n"

    prompt += (
        "\nWrite the final complete Python code to solve the task and pass the tests. "
        "Output ONLY the code inside a ```python block."
    )

    response = _llm().invoke([HumanMessage(content=prompt)])
    code = extract_code(response.content)

    return {
        "code": code,
        "iterations": state.get("iterations", 0) + 1,
        "messages": [
            AIMessage(
                content="**2. Implementation Phase:**\nI have written the code. Running tests..."
            )
        ],
    }


def executor_and_critic(state: AgentState):
    print("⚙️ [Harness] Running Sandboxed Tests...", flush=True)
    code = state.get("code", "")
    tests = state.get("tests", "")

    if not code:
        terminal_output = "❌ FAILED: No Python code was generated."
    else:
        terminal_output = execute_code_locally(code, tests)

    print(f"🖥️ [Terminal] {terminal_output[:100]}...\n", flush=True)

    return {
        "terminal_output": terminal_output,
        "messages": [
            AIMessage(content=f"**3. Sandbox Execution:**\n```text\n{terminal_output}\n```")
        ],
    }


def should_loop(state: AgentState):
    output = state.get("terminal_output", "")
    iterations = state.get("iterations", 0)

    if iterations >= 3:
        return "end"

    if "✅ SUCCESS" in output:
        return "end"

    return "rewrite"


workflow = StateGraph(AgentState)
workflow.add_node("plan", planner_and_tester)
workflow.add_node("code", code_generator)
workflow.add_node("execute", executor_and_critic)
workflow.set_entry_point("plan")
workflow.add_edge("plan", "code")
workflow.add_edge("code", "execute")
workflow.add_conditional_edges("execute", should_loop, {"rewrite": "code", "end": END})

agent_app = workflow.compile()
