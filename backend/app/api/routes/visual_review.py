"""API routes for the Visual Review feature (Wave 1).

Mounted under ``/api/sessions/{session_id}/visual-review/*`` (the same prefix
as the existing session endpoints) plus a separate ``/api/screenshots/...`` mount
for static-file serving of the PNGs.

The static prefix sits under ``/api/`` on purpose: the frontend nginx in front
of this service only proxies ``/api/*`` and ``/ws/*`` to the backend; everything
else is the SPA catch-all. Hosting the PNG route at the bare ``/screenshots/...``
prefix would make every ``<img src>`` request fall through to ``index.html`` and
render as a broken image — see КАО#VR-22.
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.auth import get_current_user_id, require_auth
from app.api.websocket.manager import session_manager
from app.core.visual_review import (
    get_storage_root,
    sign_screenshot_url,
    verify_screenshot_signature,
)
from app.db.database import get_db
from app.db.models import (
    AgentConfig,
    AgentType,
    CodeVersion,
    CodeVersionScreenshot,
    Session as SessionModel,
    SessionStatus,
    VisualReviewScore,
)
from app.services.visual_review import (
    cancel_timeout,
    resume_after_visual_review,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class _ScoreItem(BaseModel):
    code_version_id: UUID
    # КАО#VR-27 — accept half-step floats (0.5, 1.0, ..., 10.0) to match the
    # frontend slider step=0.5. The DB column is Numeric(3,1) since migration 021.
    score: float = Field(ge=0, le=10)


class VisualReviewScoresRequest(BaseModel):
    """User-submitted scores for the candidates of a session in visual review."""
    scores: list[_ScoreItem] = Field(..., min_length=1)

    @field_validator("scores")
    @classmethod
    def _unique_code_versions(cls, v: list[_ScoreItem]) -> list[_ScoreItem]:
        seen: set[UUID] = set()
        for item in v:
            if item.code_version_id in seen:
                raise ValueError(
                    f"Duplicate code_version_id in scores: {item.code_version_id}"
                )
            seen.add(item.code_version_id)
        return v


class _ScreenshotResponse(BaseModel):
    id: str
    frame_index: int
    t_seconds: float
    image_path: str
    image_url: str  # КАО#VR-17 — frontend expects fully-qualified URL, not raw filesystem path
    width: int
    height: int


class _ScoreResponse(BaseModel):
    # КАО#R2-02 — column is Numeric(3,1) (VR-27 half-steps) → SQLAlchemy yields
    # Decimal('7.5'); an int field rejects fractional values and FastAPI turns the
    # response_model ValidationError into a 500. Must be float to match _ScoreItem.
    score: float
    source: str
    submitted_by: str | None = None


class VisualReviewCandidate(BaseModel):
    code_version_id: str
    coder_index: int
    iteration: int
    screenshots: list[_ScreenshotResponse]
    scores: list[_ScoreResponse]


class VisualReviewStateResponse(BaseModel):
    session_id: str
    status: str
    candidates: list[VisualReviewCandidate]
    # VR-41 — total number of configured coder agents on this session. The
    # UI compares this to `len(candidates)` to surface a warning banner when
    # some coders failed (LLM timeouts, parse errors, etc.) and didn't make
    # it into the visual review pool.
    total_configured_coders: int = 0
    # VR-41 — which coder_index values were configured but produced no
    # screenshots (failed mid-pipeline). Used by the UI badge to name them.
    missing_coder_indices: list[int] = []


class VisualReviewActionResponse(BaseModel):
    session_id: str
    status: str
    action: str  # 'submitted' | 'skipped'


# ---------------------------------------------------------------------------
# Multi-tenancy helper (mirrors sessions.py _apply_user_filter)
# ---------------------------------------------------------------------------


def _apply_user_filter(stmt: Any, model: Any, current_user_id: str | None) -> Any:
    if current_user_id is None:
        return stmt
    return stmt.where(model.user_id == current_user_id)


async def _load_session(
    session_id: UUID,
    db: AsyncSession,
    current_user_id: str | None,
) -> SessionModel:
    stmt = select(SessionModel).where(SessionModel.id == str(session_id))
    stmt = _apply_user_filter(stmt, SessionModel, current_user_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


# ---------------------------------------------------------------------------
# GET — current state
# ---------------------------------------------------------------------------


@router.get(
    "/{session_id}/visual-review",
    response_model=VisualReviewStateResponse,
)
async def get_visual_review_state(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
) -> VisualReviewStateResponse:
    """Return the visual-review candidates (with screenshots + scores).

    Returns 404 if the session is not in AWAITING_VISUAL_REVIEW.
    """
    current_user_id = get_current_user_id(auth)
    session_obj = await _load_session(session_id, db, current_user_id)
    if session_obj.status != SessionStatus.AWAITING_VISUAL_REVIEW:
        raise HTTPException(
            status_code=404,
            detail="Session is not awaiting visual review",
        )

    # VR-41 — Latest CodeVersion per coder_index (not just the latest
    # iteration's coders). Previously a coder that failed mid-pipeline (e.g.
    # Gemini 504 / Anthropic timeout) at iteration N would be missing from
    # the visual review pool entirely if its peers ran iteration N+1. Now
    # we surface the latest version each coder DID manage to produce, so the
    # user gets a 3-way comparison whenever possible.
    from sqlalchemy import and_, func as sa_func

    max_iter_per_coder = (
        select(
            CodeVersion.coder_index.label("coder_index"),
            sa_func.max(CodeVersion.iteration).label("max_iter"),
        )
        .where(CodeVersion.session_id == str(session_id))
        .group_by(CodeVersion.coder_index)
        .subquery()
    )

    cv_stmt = (
        select(CodeVersion)
        .join(
            max_iter_per_coder,
            and_(
                CodeVersion.coder_index == max_iter_per_coder.c.coder_index,
                CodeVersion.iteration == max_iter_per_coder.c.max_iter,
            ),
        )
        .where(CodeVersion.session_id == str(session_id))
        .options(
            selectinload(CodeVersion.screenshots),
            selectinload(CodeVersion.visual_review_scores),
        )
        .order_by(CodeVersion.coder_index)
    )
    cv_res = await db.execute(cv_stmt)
    versions = cv_res.scalars().all()

    # VR-41 — Count configured coder agents (enabled + present) so the UI
    # can show "N of M coders" when some failed and didn't produce code.
    coder_cfg_stmt = (
        select(sa_func.count(AgentConfig.id))
        .where(AgentConfig.session_id == str(session_id))
        .where(AgentConfig.agent_type == AgentType.CODER)
    )
    total_coders = (await db.execute(coder_cfg_stmt)).scalar_one_or_none() or 0

    # Compute which coder_index values are MISSING (configured but didn't
    # make it into the candidate pool — either no code_version at all OR no
    # screenshots produced).
    present_indices = {cv.coder_index for cv in versions if cv.screenshots}
    missing_indices = sorted(set(range(total_coders)) - present_indices)

    candidates: list[VisualReviewCandidate] = []
    for cv in versions:
        shots = sorted(cv.screenshots, key=lambda s: s.frame_index)
        candidates.append(VisualReviewCandidate(
            code_version_id=str(cv.id),
            coder_index=cv.coder_index,
            iteration=cv.iteration,
            screenshots=[
                _ScreenshotResponse(
                    id=s.id,
                    frame_index=s.frame_index,
                    t_seconds=s.t_seconds,
                    image_path=s.image_path,
                    # КАО#VR-17 + VR-22 — signed URL the browser can fetch
                    # without an Authorization header (<img src> can't send
                    # Bearer). The handler accepts either a valid signature OR
                    # a Bearer token. See sign_screenshot_url() for rationale.
                    image_url=sign_screenshot_url(
                        session_id=str(session_id),
                        code_version_id=str(cv.id),
                        frame_index=s.frame_index,
                    ),
                    width=s.width,
                    height=s.height,
                )
                for s in shots
            ],
            scores=[
                _ScoreResponse(
                    score=score.score,
                    source=score.source,
                    submitted_by=score.submitted_by,
                )
                for score in cv.visual_review_scores
            ],
        ))

    return VisualReviewStateResponse(
        session_id=str(session_id),
        status=str(session_obj.status.value if hasattr(session_obj.status, "value") else session_obj.status),
        candidates=candidates,
        total_configured_coders=int(total_coders),
        missing_coder_indices=missing_indices,
    )


# ---------------------------------------------------------------------------
# POST — submit user scores
# ---------------------------------------------------------------------------


@router.post(
    "/{session_id}/visual-review/scores",
    response_model=VisualReviewActionResponse,
)
async def submit_visual_review_scores(
    session_id: UUID,
    payload: VisualReviewScoresRequest,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
) -> VisualReviewActionResponse:
    """Persist user scores for the visual review candidates and resume the workflow."""
    current_user_id = get_current_user_id(auth)
    session_obj = await _load_session(session_id, db, current_user_id)
    if session_obj.status != SessionStatus.AWAITING_VISUAL_REVIEW:
        raise HTTPException(
            status_code=409,
            detail=f"Session is not awaiting visual review (status={session_obj.status})",
        )

    # КАО#R3-M7 — validate against the CURRENT candidate set (latest
    # CodeVersion per coder_index — what the review panel actually shows),
    # not merely "any CodeVersion of this session": scores smuggled in for
    # stale iterations would silently skew the finalizer's winner pick.
    from sqlalchemy import func as sa_func

    max_iter_per_coder = (
        select(
            CodeVersion.coder_index.label("coder_index"),
            sa_func.max(CodeVersion.iteration).label("max_iter"),
        )
        .where(CodeVersion.session_id == str(session_id))
        .group_by(CodeVersion.coder_index)
        .subquery()
    )
    cv_ids = [str(item.code_version_id) for item in payload.scores]
    cv_check = await db.execute(
        select(CodeVersion.id)
        .join(
            max_iter_per_coder,
            (CodeVersion.coder_index == max_iter_per_coder.c.coder_index)
            & (CodeVersion.iteration == max_iter_per_coder.c.max_iter),
        )
        .where(
            CodeVersion.session_id == str(session_id),
            CodeVersion.id.in_(cv_ids),
        )
    )
    found_ids = {row[0] for row in cv_check.all()}
    missing = [cv_id for cv_id in cv_ids if cv_id not in found_ids]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=(
                "code_version_id(s) not in this session's current candidate set "
                f"(latest iteration per coder): {missing}"
            ),
        )

    # Upsert-by-delete-then-insert keeps the (session, code_version, source)
    # uniqueness invariant clean if the user resubmits.
    from sqlalchemy import delete

    await db.execute(
        delete(VisualReviewScore).where(
            VisualReviewScore.session_id == str(session_id),
            VisualReviewScore.code_version_id.in_(cv_ids),
            VisualReviewScore.source == "user",
        )
    )
    for item in payload.scores:
        db.add(VisualReviewScore(
            session_id=str(session_id),
            code_version_id=str(item.code_version_id),
            score=item.score,
            submitted_by=current_user_id,
            source="user",
        ))
    await db.commit()

    await session_manager.broadcast("visual_review_submitted", {
        "session_id": str(session_id),
        "scores": [
            {"code_version_id": str(item.code_version_id), "score": item.score}
            for item in payload.scores
        ],
        "submitted_by": current_user_id,
    })

    await resume_after_visual_review(
        db=db,
        session_id=str(session_id),
        reason="submitted",
        event_callback=session_manager.broadcast,
    )

    # Re-read the latest status (resume flipped it).
    await db.refresh(session_obj)
    return VisualReviewActionResponse(
        session_id=str(session_id),
        status=str(session_obj.status.value if hasattr(session_obj.status, "value") else session_obj.status),
        action="submitted",
    )


# ---------------------------------------------------------------------------
# GET — live HTML preview of a single candidate
# (КАО#VR-23 — was 404 before, broke "Live preview" button in panel)
# ---------------------------------------------------------------------------


@router.get(
    "/{session_id}/visual-review/{code_version_id}/preview",
    response_class=FileResponse,  # placeholder; actual return is HTMLResponse
    responses={200: {"content": {"text/html": {}}}},
)
async def get_visual_review_preview(
    session_id: UUID,
    code_version_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Return the candidate's raw HTML so the frontend can render it inside
    an ``<iframe srcdoc>``.

    We deliberately return the HTML as ``text/html`` (not JSON-wrapped) so
    the response can also be used by manual ``curl`` or any non-frontend
    consumer. The frontend, however, MUST use ``srcdoc`` rather than
    ``src`` to embed it: the platform's nginx adds ``X-Frame-Options: DENY``
    to every response, which would otherwise block the iframe load. ``srcdoc``
    bypasses that by loading the document from an in-process blob URL.

    Auth is via Bearer (the frontend XHR attaches the token); the route does
    NOT support signed URLs because there's no need — the iframe loads from
    srcdoc, not from this URL directly.
    """
    from fastapi.responses import HTMLResponse

    current_user_id = get_current_user_id(auth)
    session_obj = await _load_session(session_id, db, current_user_id)
    if session_obj.status != SessionStatus.AWAITING_VISUAL_REVIEW:
        raise HTTPException(
            status_code=404,
            detail="Session is not awaiting visual review",
        )

    cv_res = await db.execute(
        select(CodeVersion).where(
            CodeVersion.id == str(code_version_id),
            CodeVersion.session_id == str(session_id),
        )
    )
    cv = cv_res.scalar_one_or_none()
    if cv is None:
        raise HTTPException(status_code=404, detail="Code version not found")

    code = cv.code_content or ""
    # Sanity: if a coder produced something that doesn't look like HTML, wrap it
    # in a minimal scaffold so the iframe still shows SOMETHING usable. We err
    # on the side of returning the raw content when the file already opens with
    # a DOCTYPE / <html> tag — coders are instructed to produce complete HTML
    # for browser-renderable languages and this is the common case.
    stripped = code.lstrip()
    is_html = stripped.lower().startswith(("<!doctype", "<html"))
    if not is_html:
        # Treat as a JS/script body that should be evaluated in a blank page.
        code = (
            "<!DOCTYPE html><html><head>"
            '<meta charset="utf-8">'
            "<title>Preview</title>"
            "</head><body>"
            f"<script>{code}</script>"
            "</body></html>"
        )

    return HTMLResponse(
        content=code,
        # Tell upstream nginx and browser caches not to retain this.
        headers={"Cache-Control": "no-store"},
    )


# ---------------------------------------------------------------------------
# POST — skip
# ---------------------------------------------------------------------------


@router.post(
    "/{session_id}/visual-review/skip",
    response_model=VisualReviewActionResponse,
)
async def skip_visual_review(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
) -> VisualReviewActionResponse:
    """User explicitly skips visual review — resume Finalizer without scores."""
    current_user_id = get_current_user_id(auth)
    session_obj = await _load_session(session_id, db, current_user_id)
    if session_obj.status != SessionStatus.AWAITING_VISUAL_REVIEW:
        raise HTTPException(
            status_code=409,
            detail=f"Session is not awaiting visual review (status={session_obj.status})",
        )

    await session_manager.broadcast("visual_review_skipped", {
        "session_id": str(session_id),
        "skipped_by": current_user_id,
    })

    await cancel_timeout(str(session_id))
    await resume_after_visual_review(
        db=db,
        session_id=str(session_id),
        reason="skipped",
        event_callback=session_manager.broadcast,
    )

    await db.refresh(session_obj)
    return VisualReviewActionResponse(
        session_id=str(session_id),
        status=str(session_obj.status.value if hasattr(session_obj.status, "value") else session_obj.status),
        action="skipped",
    )


# ---------------------------------------------------------------------------
# Static-file serving — GET /api/screenshots/<session_id>/<code_version_id>/frame_<n>.png
# (must live under /api/ — frontend nginx only proxies /api/* and /ws/* to backend;
#  bare /screenshots/* falls through to SPA index.html → broken images. КАО#VR-22)
# ---------------------------------------------------------------------------

# Standalone router (no /api prefix in registration; the route itself includes
# /api/ — see КАО#VR-22). main.py mounts this WITHOUT dependencies=_auth because
# the handler enforces auth internally (signed URL OR Bearer) — browser <img>
# requests can't send Authorization headers, so a global Bearer dep would
# 401 every image.
static_router = APIRouter()

# Bearer scheme used by the screenshot handler. Made auto_error=False so we
# can distinguish "no header" (try signed URL) from "bad header" (401).
_screenshot_bearer = HTTPBearer(auto_error=False)


@static_router.get("/api/screenshots/{session_id}/{code_version_id}/frame_{frame_index}.png")
async def serve_screenshot(
    request: Request,
    session_id: UUID,
    code_version_id: UUID,
    frame_index: int,
    exp: int | None = Query(None, description="Signed-URL expiry (unix seconds)"),
    sig: str | None = Query(None, description="HMAC-SHA256 signature (hex)"),
    db: AsyncSession = Depends(get_db),
    credentials: HTTPAuthorizationCredentials | None = Depends(_screenshot_bearer),
) -> FileResponse:
    """Serve a captured PNG.

    Auth (КАО#VR-22): accepts EITHER a valid signed URL (``?exp=&sig=``) OR a
    Bearer token. Signed URLs are required for browser ``<img>`` requests
    because the img tag cannot attach an Authorization header. Bearer is kept
    so CLI/E2E tests and direct API consumers keep working unchanged.
    """
    if frame_index < 0 or frame_index > 999:
        raise HTTPException(status_code=400, detail="Invalid frame index")

    # --- Auth path 1: signed URL ---------------------------------------------
    sig_ok = verify_screenshot_signature(
        session_id=str(session_id),
        code_version_id=str(code_version_id),
        frame_index=frame_index,
        exp=exp,
        sig=sig,
    )
    # --- Auth path 2: Bearer (JWT or API key) --------------------------------
    # Only run when the signed URL did NOT validate. require_auth raises 401
    # if its check fails, which is what we want when no signature was supplied
    # either.
    if sig_ok:
        current_user_id: str | None = None  # signed URL implies access
    else:
        if exp is not None or sig is not None:
            # Caller TRIED to use a signed URL but it was invalid/expired —
            # 404 (same as "not found", to avoid leaking existence).
            raise HTTPException(status_code=404, detail="Screenshot not found")
        # КАО#SG1-selfxss — require_auth now needs the Request (to read the
        # session cookie). Pass it explicitly since this is a direct call, not
        # a Depends() resolution.
        auth = await require_auth(request=request, credentials=credentials)
        current_user_id = get_current_user_id(auth)

    # Confirm the screenshot belongs to a code_version in the session the
    # URL claims (mirrors the multi-tenancy guard elsewhere). For signed URLs
    # this is technically redundant (the signature already binds session_id),
    # but cheap and defence-in-depth.
    stmt = (
        select(CodeVersionScreenshot, SessionModel.user_id)
        .join(CodeVersion, CodeVersion.id == CodeVersionScreenshot.code_version_id)
        .join(SessionModel, SessionModel.id == CodeVersion.session_id)
        .where(CodeVersionScreenshot.code_version_id == str(code_version_id))
        .where(CodeVersionScreenshot.frame_index == frame_index)
        .where(SessionModel.id == str(session_id))
    )
    res = await db.execute(stmt)
    row = res.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Screenshot not found")

    _shot, owner_id = row
    # Only enforce per-user ownership for Bearer auth. Signed URLs already
    # encode access in the signature itself.
    if current_user_id is not None and owner_id is not None and str(owner_id) != str(current_user_id):
        # Same 404 instead of 403 — avoid leaking existence.
        raise HTTPException(status_code=404, detail="Screenshot not found")

    # Resolve and confirm the file lives strictly under STORAGE_ROOT/screenshots.
    storage_root = get_storage_root().resolve()
    target = (
        storage_root
        / "screenshots"
        / str(session_id)
        / str(code_version_id)
        / f"frame_{frame_index}.png"
    )
    try:
        resolved = target.resolve(strict=True)
    except (OSError, FileNotFoundError):
        raise HTTPException(status_code=404, detail="Screenshot file missing")

    # Defence-in-depth path traversal check.
    try:
        resolved.relative_to(storage_root)
    except ValueError:
        raise HTTPException(status_code=404, detail="Screenshot not found")

    return FileResponse(str(resolved), media_type="image/png")
