"""Deployment endpoints — push session results to external hosting (Feature #10).

Currently supports Vercel only, for HTML/JS sessions only. The deployment
token is NOT persisted: each request carries the token as part of the body.
"""
from __future__ import annotations

import logging
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user_id, require_auth
from app.db.database import get_db
from app.db.models import FinalResult, Session as SessionModel

logger = logging.getLogger(__name__)
router = APIRouter()


class VercelDeployRequest(BaseModel):
    token: str
    project_name: str | None = None  # default: cf-<session_id[:8]>


class VercelDeployResponse(BaseModel):
    deploy_url: str
    inspect_url: str | None = None
    project_id: str | None = None
    deployment_id: str | None = None


# Languages we currently support deploying to Vercel as a static site.
_SUPPORTED_LANGUAGES = {"html", "javascript", "typescript"}


@router.post(
    "/sessions/{session_id}/deploy/vercel",
    response_model=VercelDeployResponse,
)
async def deploy_to_vercel(
    session_id: UUID,
    body: VercelDeployRequest,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
) -> VercelDeployResponse:
    """Deploy a session's final code to Vercel as a static site.

    Currently supports HTML/JS/TS sessions only. The Vercel API token is
    passed in the request body and NOT persisted server-side.
    """
    # Basic validation on the token before we hit Vercel.
    token = (body.token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="Vercel API token is required")

    current_user_id = get_current_user_id(auth)

    # Look up session — must be owned by the caller (when JWT-authed).
    session_query = select(SessionModel).where(SessionModel.id == session_id)
    if current_user_id is not None:
        session_query = session_query.where(SessionModel.user_id == current_user_id)
    session = (await db.execute(session_query)).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get final code for the session.
    fr_stmt = select(FinalResult).where(FinalResult.session_id == session_id)
    fr = (await db.execute(fr_stmt)).scalar_one_or_none()
    if fr is None or not fr.final_code:
        raise HTTPException(status_code=400, detail="Session has no final code yet")

    # Validate language is HTML/JS-compatible.
    lang = (session.language or "").lower()
    if lang not in _SUPPORTED_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=(
                "Vercel deploy currently supports HTML/JS only. "
                f"Session language: {session.language}"
            ),
        )

    # Build the static-site payload. JS/TS code is wrapped in a minimal HTML page.
    if lang == "html":
        filename = "index.html"
        content = fr.final_code
    else:
        filename = "index.html"
        # Escape closing-script-tag sequences in JS content to avoid breaking the wrapper.
        safe_code = (fr.final_code or "").replace("</script>", "<\\/script>")
        title = (session.name or "CodeForge deployment").replace("<", "&lt;").replace(">", "&gt;")
        content = (
            "<!DOCTYPE html>\n"
            f"<html><head><meta charset=\"utf-8\"><title>{title}</title></head>"
            f"<body><script>{safe_code}</script></body></html>"
        )

    project_name = body.project_name or f"cf-{str(session_id)[:8]}"

    # Vercel deployments API
    # Docs: https://vercel.com/docs/rest-api/endpoints/deployments
    api_url = "https://api.vercel.com/v13/deployments"
    payload = {
        "name": project_name,
        "files": [
            {
                "file": filename,
                "data": content,
                "encoding": "utf-8",
            }
        ],
        "target": "production",
        "projectSettings": {
            # Static site — no framework.
            "framework": None,
        },
    }
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(api_url, json=payload, headers=headers)
    except httpx.HTTPError as e:
        logger.exception("Vercel API request failed for session %s", session_id)
        raise HTTPException(status_code=502, detail=f"Vercel API request failed: {e}") from e

    if resp.status_code >= 400:
        error_body = resp.text[:500]
        logger.error(
            "Vercel deploy failed for session %s: %s %s",
            session_id, resp.status_code, error_body,
        )
        # Surface a trimmed error to the caller — do NOT leak the token.
        raise HTTPException(
            status_code=502,
            detail=f"Vercel API error {resp.status_code}: {error_body[:200]}",
        )

    try:
        data = resp.json()
    except ValueError as e:
        raise HTTPException(status_code=502, detail="Vercel returned invalid JSON") from e

    deploy_url = data.get("url") or ""
    if deploy_url and not deploy_url.startswith("http"):
        deploy_url = f"https://{deploy_url}"

    return VercelDeployResponse(
        deploy_url=deploy_url,
        inspect_url=data.get("inspectorUrl"),
        project_id=data.get("projectId"),
        deployment_id=data.get("id"),
    )
