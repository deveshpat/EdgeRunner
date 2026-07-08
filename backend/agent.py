import re
import subprocess
from typing import TypedDict, Annotated, Sequence
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
from langchain_community.chat_models import ChatLlamaCpp
from langgraph.graph import StateGraph, END
import operator
from model_manager import get_or_download_model

# 1. Initialize Dynamic Model
model_config = get_or_download_model()

print("\nLoading model into memory... (This may take a few seconds)")
local_llm = ChatLlamaCpp(
    model_path=model_config["path"],
    temperature=0.3,
    n_ctx=model_config["n_ctx"],
    max_tokens=1024,      
    n_gpu_layers=-1,      
    verbose=False
)
print("✅ Model loaded successfully! Fasten your seatbelt.")

# 2. Define the State
class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], operator.add]
    iterations: int

# ─── TOOL: Code Execution ────────────────────────────────────────────

def extract_python_code(text: str) -> str:
    """Extracts python code from markdown blocks."""
    match = re.search(r"```python\n(.*?)\n```", text, re.DOTALL)
    return match.group(1) if match else None

def execute_code_locally(code: str) -> str:
    """Runs the code in a subprocess and captures terminal output."""
    try:
        # Run code safely with a 10-second timeout to prevent infinite loops
        result = subprocess.run(
            ["python", "-c", code],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            return f"✅ EXECUTION SUCCESS:\n{result.stdout.strip()}"
        else:
            return f"❌ EXECUTION FAILED:\n{result.stderr.strip()}"
    except subprocess.TimeoutExpired:
        return "⏳ EXECUTION TIMED OUT (Exceeded 10 seconds. Check for infinite loops)."
    except Exception as e:
        return f"⚠️ SYSTEM ERROR:\n{str(e)}"

# ─── NODES ───────────────────────────────────────────────────────────

def generate_draft(state: AgentState):
    """Generates the initial code or the revised response."""
    messages = state['messages']
    response = local_llm.invoke(messages)
    return {"messages": [response], "iterations": state.get("iterations", 0) + 1}

def execute_and_reflect(state: AgentState):
    """Executes any code found, then critiques the draft."""
    draft_message = state['messages'][-1].content
    
    # 1. Check if the model wrote Python code
    code = extract_python_code(draft_message)
    terminal_output = ""
    
    if code:
        print("\n⚙️ [Harness] Code detected! Executing in local sandbox...")
        terminal_output = execute_code_locally(code)
        print(f"🖥️ [Terminal] {terminal_output[:100]}...\n")
        
    # 2. Build the Reflection Prompt with the Terminal Logs
    reflection_content = f"""
    Review the following draft response. 
    Identify any logic flaws, missing information, or coding errors.
    
    Draft: {draft_message}
    """
    
    if terminal_output:
        reflection_content += f"""
    You wrote code in the draft. I executed it for you. Here is the terminal output:
    -----------------------------------
    {terminal_output}
    -----------------------------------
    If the execution failed, you MUST rewrite the code to fix the error.
    """
        
    reflection_content += "\nIf the draft answers the user perfectly and the code (if any) executed successfully with the expected output, output exactly 'PERFECT'."

    reflection_prompt = HumanMessage(content=reflection_content)
    critique = local_llm.invoke([reflection_prompt])
    
    return {"messages": [critique]}

def should_continue(state: AgentState):
    """Decides to loop back and fix code, or end the process."""
    last_message = state['messages'][-1].content
    iterations = state.get("iterations", 0)
    
    # Cap iterations to save compute
    if iterations >= 3:
        return "end"
        
    if "PERFECT" in last_message.upper():
        return "end"
        
    return "rewrite"

# ─── GRAPH CONSTRUCTION ──────────────────────────────────────────────

workflow = StateGraph(AgentState)

workflow.add_node("generate", generate_draft)
workflow.add_node("reflect", execute_and_reflect)

workflow.set_entry_point("generate")

workflow.add_edge("generate", "reflect")
workflow.add_conditional_edges(
    "reflect",
    should_continue,
    {"rewrite": "generate", "end": END}
)

agent_app = workflow.compile()