"""Catalog endpoint: models + harnesses for the frontend pickers."""

from __future__ import annotations

from fastapi import APIRouter

from app import harnesses
from app.catalog import get_models
from app.schemas import Catalog, Harness

router = APIRouter(tags=["catalog"])


@router.get("/catalog", response_model=Catalog)
async def get_catalog() -> Catalog:
    return Catalog(
        models=await get_models(),
        harnesses=[
            Harness(id=h.id, name=h.name, description=h.description)
            for h in harnesses.all_harnesses()
        ],
    )
