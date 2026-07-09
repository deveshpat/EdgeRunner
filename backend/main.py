import re
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from schemas import ChatRequest, ChatResponse
from agent import agent_app
from langchain_core.messages import HumanMessage, AIMessage

app = FastAPI(title="EdgeRunner API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def clean_output(text: str) -> str:
    """Removes <think> tags and cleans up stray prompt leakage from small models."""
    if not text:
        return ""
    # Remove reasoning blocks
    text = re.sub(r'<think>.*?</think>', '', text, flags=re.DOTALL)
    # Remove prompt leakage if the model hallucinates it
    text = text.split("If the draft answers")[0]
    text = text.split("output exactly")[0]
    return text.strip()

@app.get("/")
async def root():
    return {"message": "EdgeRunner Backend is Online."}

@app.get("/health")
async def health_check():
    return {"status": "online", "model": "local_dynamic"}

@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    lc_messages = []
    # Only send the latest user prompt to start the graph cleanly
    last_user_msg = [m for m in request.messages if m.role == 'user'][-1]
    lc_messages.append(HumanMessage(content=last_user_msg.content))
            
    initial_state = {
        "messages": lc_messages, 
        "iterations": 0, 
        "plan": "", 
        "tests": "", 
        "code": "", 
        "terminal_output": ""
    }
    
    # Execute SOTA Graph
    result = agent_app.invoke(initial_state)
    
    # Extract all the AI's internal dialogue for the UI's Hacker Terminal
    # Skip the first message (which is the user's prompt)
    thought_process = [m.content for m in result['messages'][1:]]
    
    # The final answer is the combination of the working code and the execution result
    final_code = result.get('code', 'No code generated.')
    final_terminal = result.get('terminal_output', '')
    
    final_response = f"### Final SOTA Solution:\n\n```python\n{final_code}\n```\n\n### Execution Results:\n```text\n{final_terminal}\n```"

    return ChatResponse(
        response=final_response,
        thought_process=thought_process
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
