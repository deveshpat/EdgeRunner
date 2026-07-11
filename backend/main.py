import asyncio
import json
import os
import queue
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse

from agent import (
    get_model_meta,
    is_model_ready,
    load_model,
    run_user_message,
    set_progress_callback,
    switch_model,
    unload_model,
)
from schemas import (
    ChatRequest,
    ChatResponse,
    HeartbeatResponse,
    ModelLoadRequest,
    SessionStatus,
)
from session_control import watchdog

PUBLIC_URL: Optional[str] = os.environ.get("KP_PUBLIC_URL")
ACCELERATOR: str = os.environ.get("KP_ACCELERATOR", "cpu")
SESSION_ID: str = os.environ.get("KP_SESSION_ID", "default")

# Keep the event loop free: LLM invoke is sync/CPU-bound.
# Separate pool for model switch so /models/load is not stuck behind a long chat
# turn (that was causing browser "Failed to fetch" on Cloudflare tunnels).
_CHAT_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="edgerunner-chat")
_MODEL_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="edgerunner-model")


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
    _MODEL_POOL.shutdown(wait=False, cancel_futures=True)


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
    meta = get_model_meta()
    ready = is_model_ready()
    # Surface load errors (e.g. GLIBC mismatch) so the UI can show more than "loading"
    err = (meta or {}).get("error") or (meta or {}).get("detail") if (meta or {}).get("phase") == "error" else None
    return {
        "status": "online",
        "model_ready": ready,
        "model": meta if meta else {"ready": False, "loading": not ready},
        "model_error": err,
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


def _do_detach(reason: str, grace: Optional[float] = None) -> dict:
    """Soft leave — refresh can reconnect; true close expires grace."""
    print(f"Detach requested: {reason}", flush=True)
    status = watchdog.request_detach(reason=reason, grace=grace)
    return {"ok": True, "session": status, "message": "Detach grace started"}


@app.api_route("/session/detach", methods=["GET", "POST", "OPTIONS"])
async def session_detach(
    request: Request,
    reason: str = Query("client_detached", max_length=200),
    grace: float = Query(60.0, ge=5.0, le=600.0),
):
    """Soft client leave (pagehide/refresh). Heartbeat cancels the kill timer."""
    if request.method == "OPTIONS":
        return PlainTextResponse("ok", status_code=204)
    final_reason = reason or "client_detached"
    g = grace
    if request.method == "POST":
        try:
            raw = await request.body()
            if raw:
                text = raw.decode("utf-8", errors="replace").strip()
                if text.startswith("{"):
                    body = json.loads(text)
                    if isinstance(body, dict):
                        if body.get("reason"):
                            final_reason = str(body["reason"])[:200]
                        if body.get("grace") is not None:
                            g = float(body["grace"])
                elif text:
                    final_reason = text[:200]
        except Exception:
            pass
    payload = _do_detach(final_reason, g)
    if request.method == "GET" or "text/plain" in (
        request.headers.get("accept") or ""
    ):
        return PlainTextResponse(
            f"ok detach={final_reason}",
            status_code=200,
            headers={"Cache-Control": "no-store"},
        )
    return payload


@app.api_route("/session/shutdown", methods=["GET", "POST", "OPTIONS"])
async def session_shutdown(
    request: Request,
    reason: str = Query("client_requested", max_length=200),
):
    """
    Explicit stop only (UI Stop button). Refresh must use /session/detach.

    Multiple shapes so browsers can always deliver:
      POST application/json  {"reason":"user_stop"}
      POST text/plain         user_stop
      GET  ?reason=user_stop
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
    if request.method == "GET" or "text/plain" in (
        request.headers.get("accept") or ""
    ):
        return PlainTextResponse(
            f"ok shutdown={final_reason}",
            status_code=200,
            headers={"Cache-Control": "no-store"},
        )
    return payload


@app.get("/models")
async def models_list():
    """Model picker options + hardware (RAM-fit, no hard GB cap)."""
    watchdog.heartbeat()
    from model_manager import list_model_options

    data = await asyncio.get_running_loop().run_in_executor(
        None, list_model_options
    )
    return {
        "ok": True,
        "current": get_model_meta(),
        **data,
    }


@app.post("/models/load")
async def models_load(body: ModelLoadRequest):
    """Switch model: unload + GC previous, then load requested GGUF.

    Runs on a dedicated pool so a long coding-agent turn cannot block the switch
    (and so the Cloudflare tunnel keeps seeing progress via heartbeats).
    """
    watchdog.heartbeat()
    if not body.repo_id.strip() or not body.filename.strip():
        return {"ok": False, "error": "repo_id and filename required"}

    def _run():
        # Keep idle watchdog happy during multi-minute download/load
        stop = threading.Event()

        def _hb():
            while not stop.wait(8.0):
                try:
                    watchdog.heartbeat()
                except Exception:
                    pass

        t = threading.Thread(target=_hb, daemon=True, name="model-load-hb")
        t.start()
        try:
            if body.n_ctx:
                os.environ["EDGERUNNER_N_CTX"] = str(int(body.n_ctx))
            return switch_model(body.repo_id.strip(), body.filename.strip())
        finally:
            stop.set()

    try:
        meta = await asyncio.get_running_loop().run_in_executor(_MODEL_POOL, _run)
        watchdog.heartbeat()
        return {"ok": True, "model": meta}
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "model": get_model_meta(),
        }


@app.post("/models/unload")
async def models_unload():
    watchdog.heartbeat()

    def _run():
        return unload_model("api")

    meta = await asyncio.get_running_loop().run_in_executor(_MODEL_POOL, _run)
    return {"ok": True, "model": meta}


def _chat_work(user_text: str, history_msgs: list, force_harness: bool, progress_q: queue.Queue):
    """Runs on the chat thread pool; pushes progress + final result onto progress_q."""

    def on_progress(msg: str) -> None:
        watchdog.heartbeat()
        try:
            progress_q.put_nowait({"type": "status", "message": msg})
        except Exception:
            pass

    set_progress_callback(on_progress)
    try:
        result = run_user_message(
            user_text, history=history_msgs, force_harness=force_harness
        )
        progress_q.put(
            {
                "type": "done",
                "response": clean_output(result.get("response") or ""),
                "thought_process": result.get("thought_process") or [],
                "mode": result.get("mode") or "chat",
            }
        )
    except Exception as e:
        progress_q.put(
            {
                "type": "done",
                "response": f"⚠️ Agent error: {e}",
                "thought_process": [str(e)],
                "mode": "error",
            }
        )
    finally:
        set_progress_callback(None)
        progress_q.put(None)  # sentinel


@app.post("/chat")
async def chat_endpoint(request: ChatRequest, raw: Request):
    """
    Chat with NDJSON streaming by default so Cloudflare tunnels get first-byte
    quickly and progress keepalives during multi-minute LLM work.

    Lines:
      {"type":"status","message":"..."}
      {"type":"ping","t":...}
      {"type":"done","response":"...","thought_process":[...],"mode":"chat|harness"}

    Clients that only accept JSON get a single ChatResponse (no stream).
    """
    watchdog.heartbeat()

    if not is_model_ready():
        try:
            await asyncio.get_running_loop().run_in_executor(_CHAT_POOL, load_model)
        except Exception as e:
            err = ChatResponse(
                response=f"⚠️ Model is still loading or failed to load: {e}",
                thought_process=[str(e)],
            )
            accept = (raw.headers.get("accept") or "").lower()
            if "application/json" in accept and "ndjson" not in accept:
                return err
            async def _err():
                yield json.dumps({"type": "done", **err.model_dump()}) + "\n"
            return StreamingResponse(_err(), media_type="application/x-ndjson")

    last_user_msg = [m for m in request.messages if m.role == "user"][-1]
    history = [{"role": m.role, "content": m.content} for m in request.messages[:-1]]
    # Optional force: client can prefix message or we detect coding tasks server-side
    force = False
    user_text = last_user_msg.content or ""
    if user_text.strip().lower().startswith("/code "):
        force = True
        user_text = user_text.strip()[6:].lstrip()

    accept = (raw.headers.get("accept") or "").lower()
    want_json_only = (
        "application/json" in accept
        and "ndjson" not in accept
        and "x-ndjson" not in accept
        and "text/event-stream" not in accept
    )

    progress_q: queue.Queue = queue.Queue()
    loop = asyncio.get_running_loop()
    fut = loop.run_in_executor(
        _CHAT_POOL,
        _chat_work,
        user_text,
        history,
        force,
        progress_q,
    )

    if want_json_only:
        # Blocking JSON path (local tooling / old clients)
        while True:
            item = await loop.run_in_executor(None, progress_q.get)
            if item is None:
                break
            if item.get("type") == "done":
                if watchdog.shutdown_requested:
                    watchdog.force_exit_soon(
                        watchdog.shutdown_reason or "client_requested", 0.0
                    )
                return ChatResponse(
                    response=item.get("response") or "",
                    thought_process=item.get("thought_process"),
                )
        try:
            await fut
        except Exception as e:
            return ChatResponse(
                response=f"⚠️ Agent error: {e}", thought_process=[str(e)]
            )
        return ChatResponse(response="⚠️ Empty agent result.", thought_process=[])

    def _q_get(timeout: float = 2.0):
        try:
            return progress_q.get(timeout=timeout)
        except queue.Empty:
            return "__timeout__"

    async def ndjson_stream():
        # Immediate first byte — avoids Cloudflare TTFB / client "connection error"
        yield (
            json.dumps(
                {
                    "type": "status",
                    "message": "Working… (casual chat is fast; coding uses the multi-step harness)",
                }
            )
            + "\n"
        )
        last_ping = time.monotonic()
        done_payload = None
        while True:
            item = await loop.run_in_executor(None, _q_get, 2.0)

            if item is None:
                break
            if item == "__timeout__":
                # Keepalive so trycloudflare / browsers don't drop the proxy
                now = time.monotonic()
                if now - last_ping >= 2.0:
                    last_ping = now
                    watchdog.heartbeat()
                    yield json.dumps({"type": "ping", "t": int(time.time())}) + "\n"
                continue

            if item.get("type") == "done":
                done_payload = item
                continue

            yield json.dumps(item) + "\n"
            last_ping = time.monotonic()

        if done_payload is None:
            done_payload = {
                "type": "done",
                "response": "⚠️ Empty agent result.",
                "thought_process": [],
                "mode": "error",
            }
        yield json.dumps(done_payload) + "\n"

        if watchdog.shutdown_requested:
            watchdog.force_exit_soon(
                watchdog.shutdown_reason or "client_requested", 0.0
            )
        try:
            await fut
        except Exception:
            pass

    return StreamingResponse(
        ndjson_stream(),
        media_type="application/x-ndjson",
        headers={
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
