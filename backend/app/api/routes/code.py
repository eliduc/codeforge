"""
Code and audit retrieval API routes.
"""
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import (
    Session, CodeVersion, Audit, SummaryAudit, CoderResponse,
    FinalResult, LLMRequest, Intervention
)
from app.schemas import (
    CodeVersionResponse, AuditResponse, SummaryAuditResponse,
    CoderResponseResponse, FinalResultResponse, LLMRequestResponse,
    InterventionCreate, InterventionResponse, SessionMetrics
)

router = APIRouter()


# Code versions
@router.get("/sessions/{session_id}/code", response_model=List[CodeVersionResponse])
async def list_code_versions(
    session_id: UUID,
    iteration: Optional[int] = None,
    coder_index: Optional[int] = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List code versions for a session."""
    stmt = select(CodeVersion).where(CodeVersion.session_id == session_id)

    if iteration is not None:
        stmt = stmt.where(CodeVersion.iteration == iteration)
    if coder_index is not None:
        stmt = stmt.where(CodeVersion.coder_index == coder_index)

    stmt = stmt.order_by(CodeVersion.iteration.desc(), CodeVersion.coder_index)
    stmt = stmt.offset(skip).limit(limit)

    result = await db.execute(stmt)
    versions = result.scalars().all()

    return versions


@router.get("/code/{version_id}", response_model=CodeVersionResponse)
async def get_code_version(
    version_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get a specific code version."""
    stmt = select(CodeVersion).where(CodeVersion.id == version_id)
    result = await db.execute(stmt)
    version = result.scalar_one_or_none()

    if not version:
        raise HTTPException(status_code=404, detail="Code version not found")

    return version


# Audits
@router.get("/sessions/{session_id}/audits", response_model=List[AuditResponse])
async def list_audits(
    session_id: UUID,
    iteration: Optional[int] = None,
    coder_index: Optional[int] = None,
    tester_index: Optional[int] = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List audits for a session."""
    # Build query based on whether coder_index filter is needed
    if coder_index is not None:
        stmt = select(Audit).join(
            CodeVersion, Audit.code_version_id == CodeVersion.id
        ).where(
            Audit.session_id == session_id,
            CodeVersion.coder_index == coder_index,
        )
    else:
        stmt = select(Audit).where(Audit.session_id == session_id)

    if iteration is not None:
        stmt = stmt.where(Audit.iteration == iteration)
    if tester_index is not None:
        stmt = stmt.where(Audit.tester_index == tester_index)

    stmt = stmt.order_by(Audit.iteration.desc(), Audit.tester_index)
    stmt = stmt.offset(skip).limit(limit)

    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/audits/{audit_id}", response_model=AuditResponse)
async def get_audit(
    audit_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get a specific audit."""
    stmt = select(Audit).where(Audit.id == audit_id)
    result = await db.execute(stmt)
    audit = result.scalar_one_or_none()

    if not audit:
        raise HTTPException(status_code=404, detail="Audit not found")

    return audit


# Summary audits
@router.get("/sessions/{session_id}/summaries", response_model=List[SummaryAuditResponse])
async def list_summary_audits(
    session_id: UUID,
    iteration: Optional[int] = None,
    coder_index: Optional[int] = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List summary audits for a session."""
    stmt = select(SummaryAudit).where(SummaryAudit.session_id == session_id)

    if iteration is not None:
        stmt = stmt.where(SummaryAudit.iteration == iteration)
    if coder_index is not None:
        stmt = stmt.where(SummaryAudit.coder_index == coder_index)

    stmt = stmt.order_by(SummaryAudit.iteration.desc(), SummaryAudit.coder_index)
    stmt = stmt.offset(skip).limit(limit)

    result = await db.execute(stmt)
    summaries = result.scalars().all()

    return summaries


# Coder responses
@router.get("/sessions/{session_id}/responses", response_model=List[CoderResponseResponse])
async def list_coder_responses(
    session_id: UUID,
    iteration: Optional[int] = None,
    coder_index: Optional[int] = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List coder responses for a session."""
    stmt = select(CoderResponse).where(CoderResponse.session_id == session_id)

    if iteration is not None:
        stmt = stmt.where(CoderResponse.iteration == iteration)
    if coder_index is not None:
        stmt = stmt.where(CoderResponse.coder_index == coder_index)

    stmt = stmt.order_by(CoderResponse.iteration.desc(), CoderResponse.coder_index)
    stmt = stmt.offset(skip).limit(limit)

    result = await db.execute(stmt)
    responses = result.scalars().all()

    return responses


# Final result
@router.get("/sessions/{session_id}/result", response_model=Optional[FinalResultResponse])
async def get_final_result(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get the final result for a session. Returns null if not yet available."""
    stmt = select(FinalResult).where(FinalResult.session_id == session_id)
    result = await db.execute(stmt)
    final = result.scalar_one_or_none()

    return final


# LLM requests (for debugging/tracking)
@router.get("/sessions/{session_id}/llm-requests", response_model=List[LLMRequestResponse])
async def list_llm_requests(
    session_id: UUID,
    iteration: Optional[int] = None,
    limit: int = Query(default=100, ge=1, le=1000),
    db: AsyncSession = Depends(get_db),
):
    """List LLM requests for a session."""
    stmt = select(LLMRequest).where(LLMRequest.session_id == session_id)

    if iteration is not None:
        stmt = stmt.where(LLMRequest.iteration == iteration)

    stmt = stmt.order_by(LLMRequest.created_at.desc()).limit(limit)

    result = await db.execute(stmt)
    requests = result.scalars().all()

    return requests


# Metrics
@router.get("/sessions/{session_id}/metrics", response_model=SessionMetrics)
async def get_session_metrics(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get aggregated metrics for a session using SQL aggregation."""
    base_filter = LLMRequest.session_id == session_id

    # Totals via SQL aggregation (avoids loading all rows into memory)
    totals_stmt = select(
        func.sum(LLMRequest.input_tokens).label("total_input"),
        func.sum(LLMRequest.output_tokens).label("total_output"),
        func.sum(LLMRequest.cost_usd).label("total_cost"),
        func.sum(LLMRequest.latency_ms).label("total_time"),
        func.max(LLMRequest.iteration).label("max_iteration"),
        func.count().label("total_requests"),
    ).where(base_filter)
    totals_row = (await db.execute(totals_stmt)).one()

    if not totals_row.total_requests:
        raise HTTPException(status_code=404, detail="No metrics found for session")

    total_input = totals_row.total_input or 0
    total_output = totals_row.total_output or 0
    total_cost = float(totals_row.total_cost or 0)
    total_time = totals_row.total_time or 0
    iterations = totals_row.max_iteration or 0

    # Group by agent via SQL
    agent_stmt = select(
        LLMRequest.agent_type,
        LLMRequest.agent_index,
        func.count().label("requests"),
        func.sum(LLMRequest.input_tokens).label("input_tokens"),
        func.sum(LLMRequest.output_tokens).label("output_tokens"),
        func.sum(LLMRequest.cost_usd).label("cost_usd"),
        func.sum(LLMRequest.latency_ms).label("latency_ms"),
    ).where(base_filter).group_by(LLMRequest.agent_type, LLMRequest.agent_index)
    agent_rows = (await db.execute(agent_stmt)).all()

    by_agent = {}
    for row in agent_rows:
        key = f"{row.agent_type.value}_{row.agent_index or 0}"
        by_agent[key] = {
            "requests": row.requests,
            "input_tokens": row.input_tokens or 0,
            "output_tokens": row.output_tokens or 0,
            "cost_usd": float(row.cost_usd or 0),
            "latency_ms": row.latency_ms or 0,
        }

    # Group by provider via SQL
    provider_stmt = select(
        LLMRequest.llm_provider,
        func.count().label("requests"),
        func.sum(LLMRequest.input_tokens).label("input_tokens"),
        func.sum(LLMRequest.output_tokens).label("output_tokens"),
        func.sum(LLMRequest.cost_usd).label("cost_usd"),
    ).where(base_filter).group_by(LLMRequest.llm_provider)
    provider_rows = (await db.execute(provider_stmt)).all()

    by_provider = {}
    for row in provider_rows:
        by_provider[row.llm_provider] = {
            "requests": row.requests,
            "input_tokens": row.input_tokens or 0,
            "output_tokens": row.output_tokens or 0,
            "cost_usd": float(row.cost_usd or 0),
        }

    return SessionMetrics(
        session_id=session_id,
        total_tokens_input=total_input,
        total_tokens_output=total_output,
        total_tokens=total_input + total_output,
        total_cost_usd=total_cost,
        total_requests=totals_row.total_requests,
        total_time_ms=total_time,
        iterations_completed=iterations,
        by_agent=by_agent,
        by_provider=by_provider,
    )


# Interventions
@router.get("/sessions/{session_id}/interventions", response_model=List[InterventionResponse])
async def list_interventions(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """List interventions for a session."""
    stmt = select(Intervention).where(
        Intervention.session_id == session_id
    ).order_by(Intervention.created_at.desc())

    result = await db.execute(stmt)
    interventions = result.scalars().all()

    return interventions


@router.post("/sessions/{session_id}/intervene", response_model=InterventionResponse)
async def create_intervention(
    session_id: UUID,
    intervention_data: InterventionCreate,
    db: AsyncSession = Depends(get_db),
):
    """Create an intervention for a session."""
    # Verify session exists
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # BUG #22: Only allow interventions on running or paused sessions
    from app.schemas import SessionStatus as _SessionStatus
    if session.status not in (_SessionStatus.RUNNING, _SessionStatus.PAUSED):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot intervene on session in '{session.status}' status (must be running or paused)",
        )

    from app.db.models import Intervention as InterventionModel

    intervention = InterventionModel(
        session_id=session_id,
        iteration=session.current_iteration,
        intervention_type=intervention_data.intervention_type,
        target_agent_type=intervention_data.target_agent_type,
        target_agent_index=intervention_data.target_agent_index,
        content=intervention_data.content,
    )
    db.add(intervention)
    await db.commit()
    await db.refresh(intervention)

    # Notify via WebSocket
    from app.api.websocket.manager import session_manager
    await session_manager.broadcast("intervention_added", {
        "session_id": str(session_id),
        "intervention": {
            "id": str(intervention.id),
            "type": intervention.intervention_type,
            "content": intervention.content,
        }
    })

    return intervention
