from pydantic import BaseModel
from typing import List, Optional

class Message(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    messages: List[Message]
    session_id: Optional[str] = "default"

class ChatResponse(BaseModel):
    response: str
    thought_process: Optional[List[str]] = None
