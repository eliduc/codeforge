"""Public read-only share link (Feature #5).

This router is mounted WITHOUT the global require_auth dependency so the
GET /share/{token} endpoint is reachable by anonymous visitors. Only
sessions whose owner has explicitly minted a share_token are exposed; the
response contains read-only metadata + final code (no secrets, no agent
configs, no LLM request logs).

The corresponding POST /api/sessions/{id}/share endpoint (which mints the
token) lives in routes/sessions.py and IS auth-protected.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import FinalResult, Session as SessionModel

logger = logging.getLogger(__name__)

router = APIRouter()


class SharedSessionResponse(BaseModel):
    """Minimal, no-secret public view of a shared session."""

    id: str
    name: str
    specification: str
    language: str
    status: str
    current_iteration: int
    max_iterations: int
    final_code: str | None = None
    readme_content: str | None = None
    created_at: datetime
    updated_at: datetime


@router.get("/share/{token}", response_model=SharedSessionResponse)
async def get_shared_session(
    token: str,
    db: AsyncSession = Depends(get_db),
) -> SharedSessionResponse:
    """Anonymous read-only view of a session by its share token."""
    if not token or len(token) > 64:
        raise HTTPException(status_code=404, detail="Share link not found")

    stmt = select(SessionModel).where(SessionModel.share_token == token)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Share link not found")

    # Pull final code if it exists; absent for in-progress sessions.
    final: FinalResult | None = None
    fr_stmt = select(FinalResult).where(FinalResult.session_id == session.id)
    final = (await db.execute(fr_stmt)).scalar_one_or_none()

    return SharedSessionResponse(
        id=str(session.id),
        name=session.name,
        specification=session.specification,
        language=session.language,
        status=str(session.status.value) if hasattr(session.status, "value") else str(session.status),
        current_iteration=session.current_iteration,
        max_iterations=session.max_iterations,
        final_code=final.final_code if final else None,
        readme_content=final.readme_content if final else None,
        created_at=session.created_at,
        updated_at=session.updated_at,
    )
