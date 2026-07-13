"""Chat endpoint: streams harness output as Server-Sent Events."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from app import harnesses
from app.harnesses.base import StreamEvent
from app.schemas import ChatRequest

router = APIRouter(tags=["chat"])


@router.post("/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    harness = harnesses.get(request.harness)
    if harness is None:
        raise HTTPException(status_code=404, detail=f"Unknown harness: {request.harness}")

    async def event_stream():
        try:
            async for event in harness.run(request):
                yield event.to_sse()
        except Exception as exc:  # surface harness failures to the client
            yield StreamEvent(type="error", data=str(exc)).to_sse()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
