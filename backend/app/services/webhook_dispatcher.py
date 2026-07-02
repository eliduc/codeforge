"""Webhook dispatcher — sends event notifications to registered webhooks.

Fire-and-forget design: failures are logged but never propagate to callers,
so a misconfigured webhook can never break workflow execution.
"""
import asyncio
import hashlib
import hmac
import json
import logging
from datetime import datetime, timezone
from typing import Any

import httpx
from sqlalchemy import select, update

from app.core.net_guard import assert_public_url  # КАО#R5-ssrf
from app.db import AsyncSessionLocal
from app.db.models import Webhook

logger = logging.getLogger(__name__)


def _format_slack_payload(event_type: str, data: dict) -> dict:
    """Format payload for Slack-compatible webhooks."""
    emoji_map = {
        "workflow_completed": ":white_check_mark:",
        "workflow_error": ":x:",
        "workflow_cancelled": ":octagonal_sign:",
        "awaiting_enhancement": ":sparkles:",
    }
    emoji = emoji_map.get(event_type, ":information_source:")
    session_name = data.get("session_name", "Unknown session")
    session_id = str(data.get("session_id", ""))

    if event_type == "workflow_completed":
        color = "good"
    elif "error" in event_type or "failed" in event_type or "cancelled" in event_type:
        color = "danger"
    else:
        color = "warning"

    return {
        "text": f"{emoji} *CodeForge*: `{event_type}`",
        "attachments": [{
            "color": color,
            "fields": [
                {"title": "Session", "value": session_name, "short": True},
                {"title": "ID", "value": session_id[:8], "short": True},
                {"title": "Event", "value": event_type, "short": False},
            ],
        }],
    }


def _format_discord_payload(event_type: str, data: dict) -> dict:
    """Format payload for Discord-compatible webhooks."""
    color_map = {
        "workflow_completed": 0x10B981,  # green
        "workflow_error": 0xEF4444,  # red
        "workflow_cancelled": 0x6B7280,  # grey
        "awaiting_enhancement": 0xA855F7,  # purple
    }
    return {
        "embeds": [{
            "title": f"CodeForge: {event_type}",
            "description": (
                f"**Session**: {data.get('session_name', 'Unknown')}\n"
                f"**ID**: `{str(data.get('session_id', ''))[:8]}`"
            ),
            "color": color_map.get(event_type, 0x6B7280),
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }],
    }


def _format_generic_payload(event_type: str, data: dict) -> dict:
    """Generic JSON payload — just the event + data."""
    return {
        "event": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "data": data,
    }


def _sign_payload(secret: str, payload_bytes: bytes) -> str:
    """HMAC-SHA256 signature of the payload."""
    return hmac.new(secret.encode(), payload_bytes, hashlib.sha256).hexdigest()


def _build_payload(webhook: Webhook, event_type: str, data: dict) -> dict:
    if webhook.webhook_type == "slack":
        return _format_slack_payload(event_type, data)
    if webhook.webhook_type == "discord":
        return _format_discord_payload(event_type, data)
    return _format_generic_payload(event_type, data)


async def _send_one(client: httpx.AsyncClient, webhook: Webhook, event_type: str, data: dict) -> int:
    """Send a single webhook. Returns HTTP status code."""
    # КАО#R5-ssrf: authoritative guard at the sink — re-validate the target
    # host at dispatch time (covers rows created before this guard existed and
    # DNS-rebinding), so a webhook can never reach the internal network or the
    # cloud metadata endpoint. Runs off the event loop since it resolves DNS.
    await asyncio.get_running_loop().run_in_executor(
        None, lambda: assert_public_url(webhook.url)
    )

    payload = _build_payload(webhook, event_type, data)
    payload_bytes = json.dumps(payload).encode()
    headers = {"Content-Type": "application/json"}

    if webhook.secret:
        headers["X-CodeForge-Signature"] = _sign_payload(webhook.secret, payload_bytes)
        headers["X-CodeForge-Event"] = event_type

    response = await client.post(webhook.url, content=payload_bytes, headers=headers)
    return response.status_code


async def dispatch_event(event_type: str, data: dict[str, Any]) -> None:
    """Fire-and-forget webhook dispatch — never raises.

    Looks up enabled webhooks matching the event filter, sends them in parallel,
    and updates stats. Failures are logged but never propagate.
    """
    try:
        async with AsyncSessionLocal() as db:
            # Multi-tenancy: only fire webhooks belonging to the session's owner.
            # Look up the session's user_id from event data (orchestrator passes
            # session_id for all webhook-eligible events).
            owner_user_id: str | None = None
            session_id = data.get("session_id")
            if session_id:
                from app.db.models import Session as SessionModel
                try:
                    sess_result = await db.execute(
                        select(SessionModel.user_id).where(SessionModel.id == session_id)
                    )
                    owner_user_id = sess_result.scalar_one_or_none()
                except Exception as lookup_err:
                    logger.warning(f"Webhook dispatch: failed to look up session owner for {session_id}: {lookup_err}")
                    return  # Fail-closed: don't dispatch if we can't determine owner

            # Build the webhook query, filtered by owner when known.
            webhook_query = select(Webhook).where(Webhook.enabled == True)  # noqa: E712
            if owner_user_id is not None:
                # JWT-owned session — only fire owner's webhooks
                webhook_query = webhook_query.where(Webhook.user_id == owner_user_id)
            else:
                # Session has NULL user_id (API-key/dev mode pre-multitenancy session).
                # Fire only webhooks with NULL user_id (legacy/admin webhooks).
                webhook_query = webhook_query.where(Webhook.user_id.is_(None))

            result = await db.execute(webhook_query)
            webhooks = result.scalars().all()

            matching: list[Webhook] = []
            for wh in webhooks:
                if not wh.event_filter:
                    matching.append(wh)
                else:
                    filters = [f.strip() for f in wh.event_filter.split(",") if f.strip()]
                    if event_type in filters:
                        matching.append(wh)

            if not matching:
                return

            logger.info(f"Dispatching '{event_type}' to {len(matching)} webhook(s)")

            async with httpx.AsyncClient(timeout=10.0) as client:
                tasks = [_send_one(client, wh, event_type, data) for wh in matching]
                results = await asyncio.gather(*tasks, return_exceptions=True)

            now = datetime.now(timezone.utc)
            for wh, send_result in zip(matching, results):
                if isinstance(send_result, Exception):
                    await db.execute(
                        update(Webhook)
                        .where(Webhook.id == wh.id)
                        .values(
                            last_sent_at=now,
                            last_status=None,
                            last_error=str(send_result)[:500],
                            total_failed=Webhook.total_failed + 1,
                        )
                    )
                    logger.warning(
                        f"Webhook '{wh.name}' ({wh.id}) failed for {event_type}: {send_result}"
                    )
                else:
                    status_code = int(send_result)
                    success = 200 <= status_code < 300
                    await db.execute(
                        update(Webhook)
                        .where(Webhook.id == wh.id)
                        .values(
                            last_sent_at=now,
                            last_status=status_code,
                            last_error=None if success else f"HTTP {status_code}",
                            total_sent=(Webhook.total_sent + 1) if success else Webhook.total_sent,
                            total_failed=(Webhook.total_failed + 1) if not success else Webhook.total_failed,
                        )
                    )
                    if not success:
                        logger.warning(
                            f"Webhook '{wh.name}' ({wh.id}) returned HTTP {status_code} for {event_type}"
                        )
            await db.commit()
    except Exception as e:
        logger.exception(f"Webhook dispatcher failed for {event_type}: {e}")


async def send_test_event(webhook: Webhook) -> tuple[bool, int | None, str | None]:
    """Send a single test payload to a webhook. Returns (success, status_code, error)."""
    test_data = {
        "session_id": "00000000-0000-0000-0000-000000000000",
        "session_name": "Test session",
        "test": True,
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            status_code = await _send_one(client, webhook, "workflow_completed", test_data)
        success = 200 <= status_code < 300
        return success, status_code, None if success else f"HTTP {status_code}"
    except Exception as e:  # noqa: BLE001
        return False, None, str(e)[:500]
