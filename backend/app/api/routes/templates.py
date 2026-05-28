"""Session Template API routes.

Templates capture a reusable snapshot of a session's configuration
(agent configs + session-level settings) so users can spin up a new
session pre-configured the same way with one click.

Multi-tenancy: templates are owned by a user (set on creation, filtered on
read). API-key / dev-mode callers see and manage all templates for
backwards compat.
"""
import logging
from typing import List
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.auth import get_current_user_id, require_auth
from app.db.database import get_db
from app.db.models import AgentConfig, Session, SessionStatus, SessionTemplate
from app.schemas import (
    SessionResponse,
    TemplateApplyRequest,
    TemplateCreate,
    TemplateFromSessionRequest,
    TemplateResponse,
    TemplateUpdate,
)

logger = logging.getLogger(__name__)

router = APIRouter()


def _filter_template_by_user(stmt, current_user_id: str | None):
    if current_user_id is None:
        return stmt
    return stmt.where(SessionTemplate.user_id == current_user_id)


def _filter_session_by_user(stmt, current_user_id: str | None):
    if current_user_id is None:
        return stmt
    return stmt.where(Session.user_id == current_user_id)


def _agent_config_to_dict(ac: AgentConfig) -> dict:
    """Serialize an AgentConfig row into a JSON-safe dict for storage in a template."""
    return {
        "agent_type": ac.agent_type.value if hasattr(ac.agent_type, "value") else str(ac.agent_type),
        "agent_index": ac.agent_index,
        "llm_provider": ac.llm_provider,
        "llm_model": ac.llm_model,
        "prompt_template_id": ac.prompt_template_id,
        "custom_prompt": ac.custom_prompt,
        "temperature": ac.temperature,
        "max_tokens": ac.max_tokens,
        "thinking_effort": ac.thinking_effort,
        "enabled": ac.enabled,
    }


@router.get("/", response_model=List[TemplateResponse])
async def list_templates(
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """List all session templates ordered by most recently updated."""
    current_user_id = get_current_user_id(auth)
    stmt = select(SessionTemplate).order_by(SessionTemplate.updated_at.desc())
    stmt = _filter_template_by_user(stmt, current_user_id)
    result = await db.execute(stmt)
    return result.scalars().all()


@router.post("/", response_model=TemplateResponse, status_code=status.HTTP_201_CREATED)
async def create_template(
    payload: TemplateCreate,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Create a new template from raw configuration data."""
    current_user_id = get_current_user_id(auth)
    template = SessionTemplate(
        name=payload.name,
        description=payload.description,
        agent_configs=payload.agent_configs,
        language=payload.language,
        max_iterations=payload.max_iterations,
        auto_continue=payload.auto_continue,
        enable_code_execution=payload.enable_code_execution,
        execution_timeout=payload.execution_timeout,
        max_fix_attempts=payload.max_fix_attempts,
        auto_install_deps=payload.auto_install_deps,
        agent_timeout=payload.agent_timeout,
        request_timeout=payload.request_timeout,
        settings=payload.settings,
        user_id=current_user_id,
    )
    db.add(template)
    await db.commit()
    await db.refresh(template)
    return template


@router.post(
    "/from-session/{session_id}",
    response_model=TemplateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_template_from_session(
    session_id: UUID,
    payload: TemplateFromSessionRequest,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Snapshot the given session's configuration into a new template."""
    current_user_id = get_current_user_id(auth)
    stmt = (
        select(Session)
        .where(Session.id == str(session_id))
        .options(selectinload(Session.agent_configs))
    )
    stmt = _filter_session_by_user(stmt, current_user_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    template = SessionTemplate(
        name=payload.name,
        description=payload.description,
        agent_configs=[_agent_config_to_dict(ac) for ac in session.agent_configs],
        language=session.language,
        max_iterations=session.max_iterations,
        auto_continue=session.auto_continue,
        enable_code_execution=session.enable_code_execution,
        execution_timeout=session.execution_timeout,
        max_fix_attempts=session.max_fix_attempts,
        auto_install_deps=session.auto_install_deps,
        agent_timeout=session.agent_timeout,
        request_timeout=session.request_timeout,
        settings=session.settings or None,
        user_id=current_user_id,
    )
    db.add(template)
    await db.commit()
    await db.refresh(template)
    logger.info(
        "Created template '%s' (id=%s) from session %s",
        template.name, template.id, session_id,
    )
    return template


@router.get("/{template_id}", response_model=TemplateResponse)
async def get_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Fetch a single template by id."""
    current_user_id = get_current_user_id(auth)
    stmt = select(SessionTemplate).where(SessionTemplate.id == str(template_id))
    stmt = _filter_template_by_user(stmt, current_user_id)
    result = await db.execute(stmt)
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    return template


@router.patch("/{template_id}", response_model=TemplateResponse)
async def update_template(
    template_id: UUID,
    payload: TemplateUpdate,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Update a template's name and/or description (other fields are immutable)."""
    current_user_id = get_current_user_id(auth)
    stmt = select(SessionTemplate).where(SessionTemplate.id == str(template_id))
    stmt = _filter_template_by_user(stmt, current_user_id)
    result = await db.execute(stmt)
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    data = payload.model_dump(exclude_unset=True)
    for field, value in data.items():
        setattr(template, field, value)

    await db.commit()
    await db.refresh(template)
    return template


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Delete a template."""
    current_user_id = get_current_user_id(auth)
    stmt = select(SessionTemplate).where(SessionTemplate.id == str(template_id))
    stmt = _filter_template_by_user(stmt, current_user_id)
    result = await db.execute(stmt)
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    await db.delete(template)
    await db.commit()


@router.post(
    "/{template_id}/apply",
    response_model=SessionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def apply_template(
    template_id: UUID,
    payload: TemplateApplyRequest,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Apply a template by creating a new session pre-populated from the template."""
    current_user_id = get_current_user_id(auth)
    stmt = select(SessionTemplate).where(SessionTemplate.id == str(template_id))
    stmt = _filter_template_by_user(stmt, current_user_id)
    result = await db.execute(stmt)
    template = result.scalar_one_or_none()
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")

    new_id = str(uuid4())
    new_session = Session(
        id=new_id,
        name=payload.name,
        specification=payload.specification,
        original_specification=payload.specification,
        initial_code=None,
        initial_docs=None,
        attachments=[],
        language=template.language,
        max_iterations=template.max_iterations,
        current_iteration=0,
        auto_continue=template.auto_continue,
        enable_code_execution=template.enable_code_execution,
        execution_timeout=template.execution_timeout,
        max_fix_attempts=template.max_fix_attempts,
        auto_install_deps=template.auto_install_deps,
        agent_timeout=template.agent_timeout,
        request_timeout=template.request_timeout,
        status=SessionStatus.CREATED,
        settings=template.settings or {},
        user_id=current_user_id,
    )
    db.add(new_session)
    await db.flush()

    for cfg in template.agent_configs or []:
        if not isinstance(cfg, dict):
            continue
        try:
            ac = AgentConfig(
                session_id=new_id,
                agent_type=cfg.get("agent_type"),
                agent_index=cfg.get("agent_index", 0),
                llm_provider=cfg.get("llm_provider"),
                llm_model=cfg.get("llm_model"),
                prompt_template_id=cfg.get("prompt_template_id"),
                custom_prompt=cfg.get("custom_prompt"),
                temperature=cfg.get("temperature", 0.7),
                max_tokens=cfg.get("max_tokens", 4096),
                thinking_effort=cfg.get("thinking_effort"),
                enabled=cfg.get("enabled", True),
            )
            db.add(ac)
        except Exception as e:
            logger.warning("Skipped invalid agent_config in template %s: %s", template_id, e)

    await db.commit()

    stmt2 = (
        select(Session)
        .where(Session.id == new_id)
        .options(selectinload(Session.agent_configs))
    )
    result2 = await db.execute(stmt2)
    fresh = result2.scalar_one()
    logger.info("Applied template %s -> session %s", template_id, new_id)
    return fresh
