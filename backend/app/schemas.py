"""Pydantic models shared across the API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Role = Literal["system", "user", "assistant"]


class Model(BaseModel):
    """A model that can be served by a harness."""

    id: str
    name: str
    description: str = ""
    context_length: int = 4096


class Harness(BaseModel):
    """An agent harness capable of driving a model."""

    id: str
    name: str
    description: str = ""


class Catalog(BaseModel):
    """Everything the frontend needs to populate its pickers."""

    models: list[Model]
    harnesses: list[Harness]


class ChatMessage(BaseModel):
    role: Role
    content: str


class ChatRequest(BaseModel):
    model: str
    harness: str
    messages: list[ChatMessage] = Field(default_factory=list)
    # Optional sampling params; harnesses fall back to their own defaults.
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None
