"""
Prompt template management API routes.
"""
import re
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import PromptTemplate
from app.schemas import (
    PromptTemplateCreate, PromptTemplateUpdate, PromptTemplateResponse,
    AgentType
)
from app.agents.prompts import CODER_PROMPT, TESTER_PROMPT, SUMMARIZER_PROMPT, FINALIZER_PROMPT

router = APIRouter()


@router.get("/", response_model=List[PromptTemplateResponse])
async def list_prompts(
    agent_type: Optional[AgentType] = None,
    db: AsyncSession = Depends(get_db),
):
    """List all prompt templates with optional agent type filter."""
    stmt = select(PromptTemplate).order_by(PromptTemplate.agent_type, PromptTemplate.name)

    if agent_type:
        stmt = stmt.where(PromptTemplate.agent_type == agent_type)

    result = await db.execute(stmt)
    prompts = result.scalars().all()

    return prompts


@router.get("/defaults", response_model=dict)
async def get_default_prompts():
    """Get built-in default prompts for all agent types."""
    return {
        "coder": CODER_PROMPT,
        "tester": TESTER_PROMPT,
        "summarizer": SUMMARIZER_PROMPT,
        "finalizer": FINALIZER_PROMPT,
    }


@router.get("/{prompt_id}", response_model=PromptTemplateResponse)
async def get_prompt(
    prompt_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Get a prompt template by ID."""
    stmt = select(PromptTemplate).where(PromptTemplate.id == prompt_id)
    result = await db.execute(stmt)
    prompt = result.scalar_one_or_none()

    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt template not found")

    return prompt


@router.post("/", response_model=PromptTemplateResponse, status_code=status.HTTP_201_CREATED)
async def create_prompt(
    prompt_data: PromptTemplateCreate,
    db: AsyncSession = Depends(get_db),
):
    """Create a new prompt template."""
    # If setting as default, unset existing default for this agent type
    if prompt_data.is_default:
        stmt = select(PromptTemplate).where(
            PromptTemplate.agent_type == prompt_data.agent_type,
            PromptTemplate.is_default == True,
        )
        result = await db.execute(stmt)
        existing_default = result.scalar_one_or_none()
        if existing_default:
            existing_default.is_default = False

    prompt = PromptTemplate(
        name=prompt_data.name,
        agent_type=prompt_data.agent_type,
        template_text=prompt_data.template_text,
        is_default=prompt_data.is_default,
    )
    db.add(prompt)
    await db.commit()
    await db.refresh(prompt)

    return prompt


@router.patch("/{prompt_id}", response_model=PromptTemplateResponse)
async def update_prompt(
    prompt_id: int,
    prompt_data: PromptTemplateUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update a prompt template."""
    stmt = select(PromptTemplate).where(PromptTemplate.id == prompt_id)
    result = await db.execute(stmt)
    prompt = result.scalar_one_or_none()

    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt template not found")

    # Reject attempts to change agent_type (BUG #31)
    update_data = prompt_data.model_dump(exclude_unset=True)
    if "agent_type" in update_data:
        raise HTTPException(
            status_code=400,
            detail="Cannot change agent_type on an existing prompt template. Create a new prompt instead.",
        )

    # Handle is_default change
    if update_data.get("is_default"):
        stmt = select(PromptTemplate).where(
            PromptTemplate.agent_type == prompt.agent_type,
            PromptTemplate.is_default == True,
            PromptTemplate.id != prompt_id,
        )
        result = await db.execute(stmt)
        existing_default = result.scalar_one_or_none()
        if existing_default:
            existing_default.is_default = False

    for field, value in update_data.items():
        setattr(prompt, field, value)

    await db.commit()
    await db.refresh(prompt)

    return prompt


@router.delete("/{prompt_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_prompt(
    prompt_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Delete a prompt template."""
    stmt = select(PromptTemplate).where(PromptTemplate.id == prompt_id)
    result = await db.execute(stmt)
    prompt = result.scalar_one_or_none()

    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt template not found")

    # If deleting a default prompt, ensure another template exists for the same agent_type
    # and promote one of them to be the new default
    if prompt.is_default:
        next_default_stmt = select(PromptTemplate).where(
            PromptTemplate.agent_type == prompt.agent_type,
            PromptTemplate.id != prompt.id,
        ).order_by(PromptTemplate.created_at.desc()).limit(1)
        next_default_result = await db.execute(next_default_stmt)
        next_default = next_default_result.scalar_one_or_none()
        if not next_default:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot delete the only prompt template for agent type '{prompt.agent_type}'. "
                       f"Create another template first or assign a different default.",
            )
        # Promote the next prompt to default so the agent type always has one
        next_default.is_default = True

    await db.delete(prompt)
    await db.commit()


class ValidatePromptRequest(BaseModel):
    """Request body for prompt validation."""
    prompt_text: str
    agent_type: AgentType


@router.post("/validate", response_model=dict)
async def validate_prompt(
    body: ValidatePromptRequest,
):
    """Validate a prompt template for required variables."""
    # Define required variables for each agent type
    required_vars = {
        AgentType.CODER: ["specification", "language"],
        AgentType.TESTER: ["specification", "code", "language"],
        AgentType.SUMMARIZER: ["specification", "code", "language"],
        AgentType.FINALIZER: ["specification", "language"],
    }

    required = required_vars.get(body.agent_type, [])
    missing = []

    for var in required:
        # Check for Jinja2 variable syntax {{ var }} with flexible whitespace,
        # and also Jinja2 block syntax {% ... var ... %}
        var_pattern = re.compile(r"\{\{\s*" + re.escape(var) + r"\s*\}\}")
        block_pattern = re.compile(r"\{%.*?" + re.escape(var) + r".*?%\}")
        if not var_pattern.search(body.prompt_text) and not block_pattern.search(body.prompt_text):
            missing.append(var)

    return {
        "valid": len(missing) == 0,
        "missing_variables": missing,
        "agent_type": body.agent_type,
    }
