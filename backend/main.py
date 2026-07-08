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
    thought_process = [m.content for m in messages if m.content and "PERFECT" not in m.content]
    final_response = messages[-1].content if "PERFECT" in messages[-1].content else messages[-2].content

    return ChatResponse(
        response=final_response.replace("PERFECT", "").strip(),
        thought_process=thought_process
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
