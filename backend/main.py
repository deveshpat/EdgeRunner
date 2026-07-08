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
    for msg in request.messages:
        if msg.role == 'user':
            lc_messages.append(HumanMessage(content=msg.content))
        elif msg.role == 'assistant':
            lc_messages.append(AIMessage(content=msg.content))
            
    initial_state = {"messages": lc_messages, "iterations": 0}
    result = agent_app.invoke(initial_state)
    
    messages = result['messages']
    
    # Store raw thoughts for the UI hacker terminal
    thought_process = [m.content for m in messages if m.content and "PERFECT" not in m.content]
    
    # Get the final draft
    raw_final = messages[-1].content if "PERFECT" in messages[-1].content else messages[-2].content
    
    return ChatResponse(
        response=clean_output(raw_final.replace("PERFECT", "")),
        thought_process=thought_process
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)