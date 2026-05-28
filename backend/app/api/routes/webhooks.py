"""Webhook CRUD + test endpoint.

Webhooks let users register external URLs (Slack, Discord, generic JSON) that
receive event notifications when significant workflow events happen.

Multi-tenancy: webhooks are owned by a user (set on creation, filtered on read).
API-key / dev-mode callers see and manage all webhooks for backwards compat.
"""
import logging
from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user_id, require_auth
from app.db.database import get_db
from app.db.models import Webhook
from app.schemas import (
    WebhookCreate,
    WebhookResponse,
    WebhookTestResponse,
    WebhookUpdate,
)
from app.services.webhook_dispatcher import send_test_event

logger = logging.getLogger(__name__)

router = APIRouter()


def _to_response(wh: Webhook) -> dict:
    """Convert Webhook ORM row to response dict (omits the actual secret)."""
    return {
        "id": str(wh.id),
        "name": wh.name,
        "url": wh.url,
        "webhook_type": wh.webhook_type,
        "event_filter": wh.event_filter,
        "enabled": wh.enabled,
        "has_secret": bool(wh.secret),
        "last_sent_at": wh.last_sent_at,
        "last_status": wh.last_status,
        "last_error": wh.last_error,
        "total_sent": wh.total_sent,
        "total_failed": wh.total_failed,
        "created_at": wh.created_at,
        "updated_at": wh.updated_at,
    }


def _filter_by_user(stmt, current_user_id: str | None):
    """Apply ownership filter if a user is in scope; otherwise no-op."""
    if current_user_id is None:
        return stmt
    return stmt.where(Webhook.user_id == current_user_id)


@router.get("/", response_model=List[WebhookResponse])
async def list_webhooks(
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """List all webhooks ordered by most recently updated."""
    current_user_id = get_current_user_id(auth)
    stmt = select(Webhook).order_by(Webhook.updated_at.desc())
    stmt = _filter_by_user(stmt, current_user_id)
    result = await db.execute(stmt)
    return [_to_response(wh) for wh in result.scalars().all()]


@router.post("/", response_model=WebhookResponse, status_code=status.HTTP_201_CREATED)
async def create_webhook(
    payload: WebhookCreate,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Register a new webhook."""
    current_user_id = get_current_user_id(auth)
    wh = Webhook(
        name=payload.name,
        url=payload.url,
        webhook_type=payload.webhook_type,
        event_filter=payload.event_filter,
        secret=payload.secret,
        enabled=payload.enabled,
        user_id=current_user_id,
    )
    db.add(wh)
    await db.commit()
    await db.refresh(wh)
    logger.info(f"Created webhook '{wh.name}' (id={wh.id}, type={wh.webhook_type})")
    return _to_response(wh)


@router.patch("/{webhook_id}", response_model=WebhookResponse)
async def update_webhook(
    webhook_id: UUID,
    payload: WebhookUpdate,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Update a webhook (only provided fields are changed)."""
    current_user_id = get_current_user_id(auth)
    stmt = select(Webhook).where(Webhook.id == str(webhook_id))
    stmt = _filter_by_user(stmt, current_user_id)
    result = await db.execute(stmt)
    wh = result.scalar_one_or_none()
    if not wh:
        raise HTTPException(status_code=404, detail="Webhook not found")

    data = payload.model_dump(exclude_unset=True)
    # Allow clearing the secret by passing an empty string explicitly
    if "secret" in data and data["secret"] == "":
        data["secret"] = None
    for field, value in data.items():
        setattr(wh, field, value)

    await db.commit()
    await db.refresh(wh)
    return _to_response(wh)


@router.delete("/{webhook_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_webhook(
    webhook_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Delete a webhook."""
    current_user_id = get_current_user_id(auth)
    stmt = select(Webhook).where(Webhook.id == str(webhook_id))
    stmt = _filter_by_user(stmt, current_user_id)
    result = await db.execute(stmt)
    wh = result.scalar_one_or_none()
    if not wh:
        raise HTTPException(status_code=404, detail="Webhook not found")
    await db.delete(wh)
    await db.commit()


@router.post("/{webhook_id}/test", response_model=WebhookTestResponse)
async def test_webhook(
    webhook_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Send a test event to a webhook and report the result."""
    current_user_id = get_current_user_id(auth)
    stmt = select(Webhook).where(Webhook.id == str(webhook_id))
    stmt = _filter_by_user(stmt, current_user_id)
    result = await db.execute(stmt)
    wh = result.scalar_one_or_none()
    if not wh:
        raise HTTPException(status_code=404, detail="Webhook not found")

    success, status_code, error = await send_test_event(wh)
    return WebhookTestResponse(success=success, status_code=status_code, error=error)
