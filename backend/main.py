import os
import re
import threading
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from langchain_core.messages import HumanMessage

from agent import agent_app, get_model_meta, is_model_ready, load_model
from schemas import ChatRequest, ChatResponse, HeartbeatResponse, SessionStatus
from session_control import watchdog

PUBLIC_URL: Optional[str] = os.environ.get("KP_PUBLIC_URL")
ACCELERATOR: str = os.environ.get("KP_ACCELERATOR", "cpu")
SESSION_ID: str = os.environ.get("KP_SESSION_ID", "default")


def clean_output(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL)
    text = text.split("If the draft answers")[0]
    text = text.split("output exactly")[0]
    return text.strip()


def _preload_model() -> None:
    try:
        load_model()
    except Exception as e:
        print(f"⚠️ Model preload failed (will retry on first chat): {e}", flush=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    watchdog.start_background()
    # Load model in background so /health and heartbeats work immediately.
    threading.Thread(target=_preload_model, daemon=True).start()
    print(
        f"EdgeRunner worker online | session={SESSION_ID} | accel={ACCELERATOR}",
        flush=True,
    )
    if PUBLIC_URL:
        # Keep both markers so older log scrapers still match.
        print(f"EDGERUNNER_URL={PUBLIC_URL}", flush=True)
        print(f"KAGGLE_PILOT_URL={PUBLIC_URL}", flush=True)
    yield


app = FastAPI(title="EdgeRunner API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
async def root():
    return {
        "message": "EdgeRunner worker is online.",
        "session_id": SESSION_ID,
        "public_url": PUBLIC_URL,
    }


@app.get("/health")
async def health_check():
    return {
        "status": "online",
        "model_ready": is_model_ready(),
        "model": get_model_meta() if is_model_ready() else {"ready": False},
        "session_id": SESSION_ID,
        "accelerator": ACCELERATOR,
    }


@app.get("/session/status", response_model=SessionStatus)
async def session_status():
    return SessionStatus(
        status="online",
        model_ready=is_model_ready(),
        model=get_model_meta() if is_model_ready() else {"ready": False},
        session=watchdog.status(),
        public_url=PUBLIC_URL,
        accelerator=ACCELERATOR,
    )


@app.post("/session/heartbeat", response_model=HeartbeatResponse)
async def session_heartbeat(request: Request):
    # Any authenticated client can keep the session alive.
    _ = request
    status = watchdog.heartbeat()
    return HeartbeatResponse(ok=True, session=status)


@app.post("/session/shutdown")
async def session_shutdown(request: Request):
    """Called by the frontend on tab close (sendBeacon) to free GPU/CPU quota."""
    body = {}
    try:
        body = await request.json()
    except Exception:
        pass
    reason = body.get("reason", "client_requested") if isinstance(body, dict) else "client_requested"
    status = watchdog.request_shutdown(reason=reason)
    return {"ok": True, "session": status, "message": "Shutdown scheduled"}


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    # Heartbeat on real traffic too, so active chats never idle-kill.
    watchdog.heartbeat()

    if not is_model_ready():
        try:
            load_model()
        except Exception as e:
            return ChatResponse(
                response=f"⚠️ Model is still loading or failed to load: {e}",
                thought_process=[str(e)],
            )

    last_user_msg = [m for m in request.messages if m.role == "user"][-1]
    lc_messages = [HumanMessage(content=last_user_msg.content)]

    initial_state = {
        "messages": lc_messages,
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

    return ChatResponse(response=final_response, thought_process=thought_process)


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
