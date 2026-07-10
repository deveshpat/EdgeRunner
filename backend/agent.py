import gc
import re
import subprocess
import threading
from typing import Annotated, Optional, Sequence, TypedDict

import operator
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
from langgraph.graph import END, StateGraph

# Lazy-loaded LLM so FastAPI can boot and report /health before the model is ready.
_local_llm = None
_model_meta: dict = {"ready": False, "loading": False}
_load_lock = threading.Lock()


def is_model_ready() -> bool:
    return _local_llm is not None


def get_model_meta() -> dict:
    meta = dict(_model_meta)
    try:
        from model_manager import get_load_status

        st = get_load_status()
        meta.setdefault("loading", st.get("loading", False))
        if st.get("phase"):
            meta["phase"] = st["phase"]
        if st.get("detail"):
            meta["detail"] = st["detail"]
    except Exception:
        pass
    meta["ready"] = _local_llm is not None
    return meta


def _release_llama_cpp(obj) -> None:
    """Best-effort free of native llama.cpp weights (avoid OOM on switch)."""
    if obj is None:
        return
    try:
        # langchain ChatLlamaCpp → .client is often the llama_cpp.Llama
        client = getattr(obj, "client", None) or getattr(obj, "llm", None)
        if client is not None:
            close = getattr(client, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass
            # Drop internal model pointer if present
            for attr in ("model", "_model", "ctx", "_ctx"):
                if hasattr(client, attr):
                    try:
                        setattr(client, attr, None)
                    except Exception:
                        pass
            del client
    except Exception:
        pass
    try:
        del obj
    except Exception:
        pass


def unload_model(reason: str = "switch") -> dict:
    """Drop the in-RAM model and force GC so a new load won't OOM."""
    global _local_llm, _model_meta
    with _load_lock:
        print(f"♻️ Unloading model ({reason})…", flush=True)
        old = _local_llm
        _local_llm = None
        _release_llama_cpp(old)
        # Multiple GC passes help with native + Python cycles
        for _ in range(3):
            gc.collect()
        try:
            import ctypes

            libc = ctypes.CDLL("libc.so.6")
            libc.malloc_trim(0)
        except Exception:
            pass
        _model_meta = {
            "ready": False,
            "loading": False,
            "phase": "unloaded",
            "detail": reason,
        }
        try:
            from model_manager import _set_status

            _set_status("unloaded", reason, loading=False)
        except Exception:
            pass
        print("♻️ Model unloaded + GC", flush=True)
        return dict(_model_meta)


def load_model(
    repo_id: Optional[str] = None,
    filename: Optional[str] = None,
    *,
    force_reload: bool = False,
) -> dict:
    """Download / load a GGUF. Thread-safe. force_reload unloads first."""
    global _local_llm, _model_meta

    with _load_lock:
        if _local_llm is not None and not force_reload and not (repo_id and filename):
            return _model_meta

        if _local_llm is not None and (force_reload or (repo_id and filename)):
            # Inline unload without re-entering lock
            old = _local_llm
            _local_llm = None
            _release_llama_cpp(old)
            for _ in range(3):
                gc.collect()
            try:
                import ctypes

                ctypes.CDLL("libc.so.6").malloc_trim(0)
            except Exception:
                pass

        from langchain_community.chat_models import ChatLlamaCpp
        from model_manager import get_or_download_model, _set_status

        _model_meta = {"ready": False, "loading": True, "phase": "download"}
        try:
            model_config = get_or_download_model(
                repo_id=repo_id, filename=filename
            )
            print("\nLoading model into memory...", flush=True)
            _set_status("load", f"Loading {model_config.get('name', '')} into RAM…")
            # Cap context by free RAM later if needed; default from picker
            n_ctx = int(model_config.get("n_ctx") or 4096)
            _local_llm = ChatLlamaCpp(
                model_path=model_config["path"],
                temperature=0.2,
                n_ctx=n_ctx,
                max_tokens=1500,
                n_gpu_layers=-1,
                verbose=False,
            )
            _model_meta = {
                "name": model_config.get("name", "local"),
                "path": model_config["path"],
                "n_ctx": n_ctx,
                "repo_id": model_config.get("repo_id"),
                "filename": model_config.get("filename"),
                "ready": True,
                "loading": False,
                "phase": "ready",
            }
            _set_status("ready", _model_meta["name"], loading=False)
            print("✅ SOTA Engine Loaded!", flush=True)
        except Exception as e:
            _local_llm = None
            _model_meta = {
                "ready": False,
                "loading": False,
                "phase": "error",
                "error": str(e),
            }
            _set_status("error", str(e), loading=False)
            # GC after failed load too (partial maps)
            for _ in range(3):
                gc.collect()
            raise
        return _model_meta


def switch_model(repo_id: str, filename: str) -> dict:
    """Unload current model (GC) then load the chosen GGUF."""
    return load_model(repo_id=repo_id, filename=filename, force_reload=True)


def _llm():
    if _local_llm is None:
        load_model()
    return _local_llm


# Optional progress callback set by /chat for streaming keepalives.
_progress_cb = None


def set_progress_callback(cb) -> None:
    """cb(message: str) — called from worker threads during long runs."""
    global _progress_cb
    _progress_cb = cb


def _progress(msg: str) -> None:
    print(msg, flush=True)
    cb = _progress_cb
    if cb is not None:
        try:
            cb(msg)
        except Exception:
            pass


# Coding-harness keywords. Casual chat ("hi") must NOT run plan→code→test.
_CODE_HINT = re.compile(
    r"\b("
    r"code|python|function|class|implement|algorithm|debug|fix|bug|"
    r"write\s+(a|an|the|me|some)|script|program|leetcode|solve|assert|"
    r"refactor|optimize|test\s+case|unit\s+test|api|regex|parse|"
    r"sort|binary\s+search|linked\s*list|tree|graph|dfs|bfs|"
    r"sql|query|html|css|javascript|typescript|rust|golang|"
    r"compile|runtime|exception|traceback|stack\s*overflow"
    r")\b|"
    r"```|def\s+\w+\s*\(|class\s+\w+",
    re.IGNORECASE,
)


def looks_like_coding_task(text: str) -> bool:
    """True when the full SOTA coding harness is worth the multi-LLM cost."""
    t = (text or "").strip()
    if not t:
        return False
    # Very short greetings / chitchat → simple reply
    if len(t) < 40 and not _CODE_HINT.search(t):
        return False
    if _CODE_HINT.search(t):
        return True
    # Longer free-form without code signals → still chat, not harness
    return False


def simple_chat(user_text: str, history: Optional[list] = None) -> dict:
    """Single short LLM turn — used for hi / Q&A so tunnels don't time out."""
    _progress("💬 [Chat] Generating reply…")
    hist = history or []
    # Keep prompt small for CPU inference speed
    hist_snip = ""
    for m in hist[-4:]:
        role = getattr(m, "role", None) or (m.get("role") if isinstance(m, dict) else "")
        content = getattr(m, "content", None) or (
            m.get("content") if isinstance(m, dict) else str(m)
        )
        if role and content:
            hist_snip += f"{role}: {str(content)[:400]}\n"

    prompt = (
        "You are EdgeRunner, a helpful local coding assistant running on the user's "
        "Kaggle/CPU session. Reply briefly and clearly. If they want code later, "
        "you'll use a multi-step harness — for now just converse.\n\n"
        f"{hist_snip}"
        f"user: {user_text}\nassistant:"
    )
    # Cap generation length so "hi" isn't a multi-minute wait on CPU
    llm = _llm()
    try:
        # ChatLlamaCpp / LlamaCpp support max_tokens override via bind or config
        bound = llm.bind(max_tokens=256) if hasattr(llm, "bind") else llm
        response = bound.invoke([HumanMessage(content=prompt)])
    except Exception:
        response = llm.invoke([HumanMessage(content=prompt)])

    content = getattr(response, "content", None) or str(response)
    _progress("💬 [Chat] Done.")
    return {
        "mode": "chat",
        "response": content.strip(),
        "thought_process": ["Direct chat reply (coding harness skipped for this message)."],
        "code": "",
        "terminal_output": "",
    }


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
    _progress("🧠 [Harness] Analyzing problem & writing tests...")
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
    _progress("💻 [Harness] Writing implementation code...")
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
    _progress("⚙️ [Harness] Running Sandboxed Tests...")
    code = state.get("code", "")
    tests = state.get("tests", "")

    if not code:
        terminal_output = "❌ FAILED: No Python code was generated."
    else:
        terminal_output = execute_code_locally(code, tests)

    _progress(f"🖥️ [Terminal] {terminal_output[:100]}...")

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


def run_coding_harness(user_text: str) -> dict:
    """Full plan → code → test loop. Slow on CPU; stream progress via callback."""
    _progress("🧠 [Harness] Starting coding harness…")
    initial_state = {
        "messages": [HumanMessage(content=user_text)],
        "iterations": 0,
        "plan": "",
        "tests": "",
        "code": "",
        "terminal_output": "",
    }
    result = agent_app.invoke(initial_state)
    thought_process = [m.content for m in result["messages"][1:]]
    final_code = result.get("code", "No code generated.")
    final_terminal = result.get("terminal_output", "")
    final_response = (
        f"### Final SOTA Solution:\n\n```python\n{final_code}\n```\n\n"
        f"### Execution Results:\n```text\n{final_terminal}\n```"
    )
    _progress("✅ [Harness] Complete.")
    return {
        "mode": "harness",
        "response": final_response,
        "thought_process": thought_process,
        "code": final_code,
        "terminal_output": final_terminal,
    }


def run_user_message(user_text: str, history: Optional[list] = None, force_harness: bool = False) -> dict:
    """Route casual chat vs coding harness."""
    if force_harness or looks_like_coding_task(user_text):
        return run_coding_harness(user_text)
    return simple_chat(user_text, history=history)


workflow = StateGraph(AgentState)
workflow.add_node("plan", planner_and_tester)
workflow.add_node("code", code_generator)
workflow.add_node("execute", executor_and_critic)
workflow.set_entry_point("plan")
workflow.add_edge("plan", "code")
workflow.add_edge("code", "execute")
workflow.add_conditional_edges("execute", should_loop, {"rewrite": "code", "end": END})

agent_app = workflow.compile()
