from typing import List, Optional

from pydantic import BaseModel


class Message(BaseModel):
    role: str
    content: str


class ChatRequest(BaseModel):
    messages: List[Message]
    session_id: Optional[str] = "default"


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
