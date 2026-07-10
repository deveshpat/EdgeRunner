import asyncio
import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from langchain_core.messages import HumanMessage

from agent import agent_app, get_model_meta, is_model_ready, load_model
from schemas import ChatRequest, ChatResponse, HeartbeatResponse, SessionStatus
from session_control import watchdog

PUBLIC_URL: Optional[str] = os.environ.get("KP_PUBLIC_URL")
ACCELERATOR: str = os.environ.get("KP_ACCELERATOR", "cpu")
SESSION_ID: str = os.environ.get("KP_SESSION_ID", "default")

# Keep the event loop free: LLM invoke is sync/CPU-bound.
_CHAT_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="edgerunner-chat")


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
    # Thread watchdog — survives blocked event loops during inference.
    watchdog.start_background()
    threading.Thread(target=_preload_model, daemon=True).start()
    print(
        f"EdgeRunner worker online | session={SESSION_ID} | accel={ACCELERATOR}",
        flush=True,
    )
    if PUBLIC_URL:
        print(f"EDGERUNNER_URL={PUBLIC_URL}", flush=True)
        print(f"KAGGLE_PILOT_URL={PUBLIC_URL}", flush=True)
    yield
    _CHAT_POOL.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="EdgeRunner API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    # credentials + "*" is invalid in browsers; beacons/fetch don't need cookies
    allow_credentials=False,
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
        "session": watchdog.status(),
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
@app.get("/session/heartbeat", response_model=HeartbeatResponse)
async def session_heartbeat(request: Request):
    _ = request
    status = watchdog.heartbeat()
    return HeartbeatResponse(ok=True, session=status)


def _do_shutdown(reason: str) -> dict:
    print(f"Shutdown requested: {reason}", flush=True)
    status = watchdog.request_shutdown(reason=reason)
    return {"ok": True, "session": status, "message": "Shutdown scheduled"}


@app.api_route("/session/shutdown", methods=["GET", "POST", "OPTIONS"])
async def session_shutdown(
    request: Request,
    reason: str = Query("client_requested", max_length=200),
):
    """
    Tab close / stop.

    Multiple shapes so browsers can always deliver:
      POST application/json  {"reason":"tab_closed"}
      POST text/plain         tab_closed
      GET  ?reason=tab_closed   (Image / sendBeacon / no preflight)
    """
    if request.method == "OPTIONS":
        return PlainTextResponse("ok", status_code=204)

    final_reason = reason or "client_requested"
    if request.method == "POST":
        try:
            ctype = (request.headers.get("content-type") or "").lower()
            raw = await request.body()
            if raw:
                text = raw.decode("utf-8", errors="replace").strip()
                if "json" in ctype or (text.startswith("{") and text.endswith("}")):
                    body = json.loads(text)
                    if isinstance(body, dict) and body.get("reason"):
                        final_reason = str(body["reason"])[:200]
                elif text.startswith("reason="):
                    final_reason = text.split("=", 1)[1][:200] or final_reason
                elif text:
                    final_reason = text[:200]
        except Exception:
            pass

    payload = _do_shutdown(final_reason)
    # Plain text is sendBeacon-friendly and still kills the process.
    if request.method == "GET" or "text/plain" in (
        request.headers.get("accept") or ""
    ):
        return PlainTextResponse(
            f"ok shutdown={final_reason}",
            status_code=200,
            headers={"Cache-Control": "no-store"},
        )
    return payload


@app.post("/chat", response_model=ChatResponse)
async def chat_endpoint(request: ChatRequest):
    # Heartbeat on real traffic too, so active chats never idle-kill.
    watchdog.heartbeat()

    if not is_model_ready():
        try:
            await asyncio.get_running_loop().run_in_executor(_CHAT_POOL, load_model)
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

    def _run():
        return agent_app.invoke(initial_state)

    try:
        result = await asyncio.get_running_loop().run_in_executor(_CHAT_POOL, _run)
    except Exception as e:
        return ChatResponse(
            response=f"⚠️ Agent error: {e}",
            thought_process=[str(e)],
        )

    # If tab closed during inference, die immediately after.
    if watchdog.shutdown_requested:
        watchdog.force_exit_soon(watchdog.shutdown_reason or "client_requested", 0.0)

    thought_process = [m.content for m in result["messages"][1:]]
    final_code = result.get("code", "No code generated.")
    final_terminal = result.get("terminal_output", "")

    final_response = (
        f"### Final SOTA Solution:\n\n```python\n{final_code}\n```\n\n"
        f"### Execution Results:\n```text\n{final_terminal}\n```"
    )

    return ChatResponse(
        response=clean_output(final_response), thought_process=thought_process
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
