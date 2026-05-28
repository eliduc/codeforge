"""
Code and audit retrieval API routes.
"""
from datetime import datetime, timedelta, timezone
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy import func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user_id, require_auth
from app.db.database import get_db
from app.db.models import (
    Session, CodeVersion, Audit, SummaryAudit, CoderResponse,
    FinalResult, LLMRequest, Intervention, SessionStatus,
)
from app.schemas import (
    CodeVersionResponse, AuditResponse, SummaryAuditResponse,
    CoderResponseResponse, FinalResultResponse, LLMRequestResponse,
    InterventionCreate, InterventionResponse, SessionMetrics, CostAlert,
)

router = APIRouter()


# ---------------------------------------------------------------------------
# Multi-tenancy helpers (mirror the ones in routes/sessions.py)
# ---------------------------------------------------------------------------

async def _verify_session_ownership(
    db: AsyncSession,
    session_id: UUID,
    current_user_id: str | None,
) -> None:
    """Raise 404 if session doesn't exist OR isn't owned by current user.

    For API-key / dev-mode (current_user_id is None) the ownership check is
    skipped — only the existence check applies.

    Returning 404 (not 403) avoids leaking the existence of other users'
    sessions.
    """
    stmt = select(Session.id).where(Session.id == session_id)
    if current_user_id is not None:
        stmt = stmt.where(Session.user_id == current_user_id)
    result = await db.execute(stmt)
    if result.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Session not found")


def _session_user_filter(current_user_id: str | None):
    """Build a SQL fragment to restrict LLMRequest/etc by parent session ownership.

    Returns a `Session.id.in_(<subquery>)` clause when a user is in scope,
    otherwise None (caller should skip filtering).
    """
    if current_user_id is None:
        return None
    return select(Session.id).where(Session.user_id == current_user_id)


# ============================================================================
# Aggregate dashboard metrics across all sessions
# ============================================================================
@router.get("/dashboard/stats")
async def get_dashboard_stats(
    days: int = Query(default=30, ge=1, le=365),
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Aggregate stats across all sessions for the dashboard.

    Multi-tenancy: when JWT-authenticated, only the current user's sessions
    are included in the totals. API-key / dev-mode sees everything.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    current_user_id = get_current_user_id(auth)
    user_session_ids = _session_user_filter(current_user_id)  # subquery or None

    # Sessions by status
    status_stmt = (
        select(Session.status, sa_func.count())
        .where(Session.created_at >= cutoff)
        .group_by(Session.status)
    )
    if current_user_id is not None:
        status_stmt = status_stmt.where(Session.user_id == current_user_id)
    status_query = await db.execute(status_stmt)
    sessions_by_status: dict[str, int] = {}
    for row in status_query.all():
        key = row[0].value if hasattr(row[0], "value") else str(row[0])
        sessions_by_status[key] = int(row[1])

    # Total cost & tokens in window (filter by user via parent session)
    cost_stmt = select(
        sa_func.coalesce(sa_func.sum(LLMRequest.cost_usd), 0),
        sa_func.coalesce(
            sa_func.sum(LLMRequest.input_tokens + LLMRequest.output_tokens), 0
        ),
        sa_func.count(),
    ).where(LLMRequest.created_at >= cutoff)
    if user_session_ids is not None:
        cost_stmt = cost_stmt.where(LLMRequest.session_id.in_(user_session_ids))
    cost_query = await db.execute(cost_stmt)
    cost_row = cost_query.one()
    total_cost = float(cost_row[0] or 0)
    total_tokens = int(cost_row[1] or 0)
    total_requests = int(cost_row[2] or 0)

    # Average iterations (completed sessions only)
    avg_stmt = (
        select(sa_func.coalesce(sa_func.avg(Session.current_iteration), 0))
        .where(
            Session.created_at >= cutoff,
            Session.status == SessionStatus.COMPLETED,
        )
    )
    if current_user_id is not None:
        avg_stmt = avg_stmt.where(Session.user_id == current_user_id)
    avg_iter_query = await db.execute(avg_stmt)
    avg_iterations = float(avg_iter_query.scalar() or 0)

    # Top providers by request count
    providers_stmt = (
        select(
            LLMRequest.llm_provider,
            sa_func.count(),
            sa_func.sum(LLMRequest.cost_usd),
        )
        .where(LLMRequest.created_at >= cutoff)
        .group_by(LLMRequest.llm_provider)
        .order_by(sa_func.count().desc())
        .limit(10)
    )
    if user_session_ids is not None:
        providers_stmt = providers_stmt.where(LLMRequest.session_id.in_(user_session_ids))
    providers_query = await db.execute(providers_stmt)
    top_providers = [
        {
            "provider": row[0],
            "requests": int(row[1]),
            "cost_usd": float(row[2] or 0),
        }
        for row in providers_query.all()
    ]

    # Top models by cost
    models_stmt = (
        select(
            LLMRequest.llm_model,
            sa_func.count(),
            sa_func.sum(LLMRequest.cost_usd),
        )
        .where(LLMRequest.created_at >= cutoff)
        .group_by(LLMRequest.llm_model)
        .order_by(sa_func.sum(LLMRequest.cost_usd).desc().nullslast())
        .limit(10)
    )
    if user_session_ids is not None:
        models_stmt = models_stmt.where(LLMRequest.session_id.in_(user_session_ids))
    models_query = await db.execute(models_stmt)
    top_models = [
        {
            "model": row[0],
            "requests": int(row[1]),
            "cost_usd": float(row[2] or 0),
        }
        for row in models_query.all()
    ]

    # Daily cost breakdown (last 14 days)
    daily_cutoff = datetime.now(timezone.utc) - timedelta(days=14)
    daily_stmt = (
        select(
            sa_func.date_trunc("day", LLMRequest.created_at).label("day"),
            sa_func.sum(LLMRequest.cost_usd),
            sa_func.count(),
        )
        .where(LLMRequest.created_at >= daily_cutoff)
        .group_by("day")
        .order_by("day")
    )
    if user_session_ids is not None:
        daily_stmt = daily_stmt.where(LLMRequest.session_id.in_(user_session_ids))
    daily_query = await db.execute(daily_stmt)
    daily_cost = [
        {
            "date": row[0].isoformat() if row[0] else None,
            "cost_usd": float(row[1] or 0),
            "requests": int(row[2]),
        }
        for row in daily_query.all()
        if row[0] is not None
    ]

    return {
        "window_days": days,
        "sessions_by_status": sessions_by_status,
        "total_cost_usd": total_cost,
        "total_tokens": total_tokens,
        "total_requests": total_requests,
        "avg_iterations": round(avg_iterations, 2),
        "top_providers": top_providers,
        "top_models": top_models,
        "daily_cost": daily_cost,
    }


# Code versions
@router.get("/sessions/{session_id}/code", response_model=List[CodeVersionResponse])
async def list_code_versions(
    session_id: UUID,
    iteration: Optional[int] = None,
    coder_index: Optional[int] = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """List code versions for a session."""
    await _verify_session_ownership(db, session_id, get_current_user_id(auth))
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
    auth: dict | None = Depends(require_auth),
):
    """Get a specific code version."""
    current_user_id = get_current_user_id(auth)
    # Join through Session to enforce ownership
    stmt = (
        select(CodeVersion)
        .join(Session, Session.id == CodeVersion.session_id)
        .where(CodeVersion.id == version_id)
    )
    if current_user_id is not None:
        stmt = stmt.where(Session.user_id == current_user_id)
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
    auth: dict | None = Depends(require_auth),
):
    """List audits for a session."""
    await _verify_session_ownership(db, session_id, get_current_user_id(auth))
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
    auth: dict | None = Depends(require_auth),
):
    """Get a specific audit."""
    current_user_id = get_current_user_id(auth)
    stmt = (
        select(Audit)
        .join(Session, Session.id == Audit.session_id)
        .where(Audit.id == audit_id)
    )
    if current_user_id is not None:
        stmt = stmt.where(Session.user_id == current_user_id)
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
    auth: dict | None = Depends(require_auth),
):
    """List summary audits for a session."""
    await _verify_session_ownership(db, session_id, get_current_user_id(auth))
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
    auth: dict | None = Depends(require_auth),
):
    """List coder responses for a session."""
    await _verify_session_ownership(db, session_id, get_current_user_id(auth))
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
    auth: dict | None = Depends(require_auth),
):
    """Get the final result for a session. Returns null if not yet available."""
    await _verify_session_ownership(db, session_id, get_current_user_id(auth))
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
    auth: dict | None = Depends(require_auth),
):
    """List LLM requests for a session."""
    await _verify_session_ownership(db, session_id, get_current_user_id(auth))
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
    auth: dict | None = Depends(require_auth),
):
    """Get aggregated metrics for a session using SQL aggregation."""
    await _verify_session_ownership(db, session_id, get_current_user_id(auth))
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
        agent_type = row.agent_type.value if hasattr(row.agent_type, 'value') else str(row.agent_type)
        key = f"{agent_type}_{row.agent_index or 0}"
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

    # Compute cost budget alert based on total cost
    cost_alert: CostAlert | None = None
    if total_cost > 50.0:
        cost_alert = CostAlert(
            cost_usd=total_cost,
            threshold_usd=50.0,
            severity="critical",
            message="Session cost exceeds $50 — consider stopping",
        )
    elif total_cost > 10.0:
        cost_alert = CostAlert(
            cost_usd=total_cost,
            threshold_usd=10.0,
            severity="warning",
            message="Session cost exceeds $10",
        )
    elif total_cost > 5.0:
        cost_alert = CostAlert(
            cost_usd=total_cost,
            threshold_usd=5.0,
            severity="info",
            message="Session cost exceeds $5",
        )

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
        cost_alert=cost_alert,
    )


# Interventions
@router.get("/sessions/{session_id}/interventions", response_model=List[InterventionResponse])
async def list_interventions(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """List interventions for a session."""
    await _verify_session_ownership(db, session_id, get_current_user_id(auth))
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
    auth: dict | None = Depends(require_auth),
):
    """Create an intervention for a session."""
    current_user_id = get_current_user_id(auth)
    # Verify session exists AND is owned by current user
    stmt = select(Session).where(Session.id == session_id)
    if current_user_id is not None:
        stmt = stmt.where(Session.user_id == current_user_id)
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
