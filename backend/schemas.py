from typing import List, Optional

from pydantic import BaseModel


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[Message]
    session_id: Optional[str] = "default"
    # OpenCode-style agent hint from UI (build | plan); routing may still override
    agent: Optional[str] = None
    # User memory / custom system additions (from /memory and /system)
    system: Optional[str] = None
    # Engine choice: "hermes" (default, real Hermes Agent loop) or "native"
    engine: Optional[str] = None


class ChatResponse(BaseModel):
    response: str
    thought_process: Optional[List[str]] = None


class HeartbeatResponse(BaseModel):
    ok: bool
    session: dict


class SessionStatus(BaseModel):
    status: str
    model_ready: bool
    model: dict
    session: dict
    public_url: Optional[str] = None
    accelerator: Optional[str] = None


class ModelLoadRequest(BaseModel):
    repo_id: str
    filename: str
    n_ctx: Optional[int] = None
