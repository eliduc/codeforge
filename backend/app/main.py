"""
CodeForge - Multi-Agent Code Generation and Audit System
FastAPI Application Entry Point
"""
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from fastapi import Depends
from starlette.types import ASGIApp, Receive, Scope, Send

from app.config import get_settings
from app.db.database import init_db, close_db
from app.llm.router import get_llm_router, close_llm_router
from app.sandbox import get_sandbox_client
from app.api.routes import sessions, prompts, code, settings as settings_routes, execution
from app.api.routes import auth as auth_routes
from app.api.routes import templates as templates_routes
from app.api.routes import webhooks as webhooks_routes
from app.api.routes import spec_helper as spec_helper_routes
from app.api.routes import share as share_routes
from app.api.routes import deploy as deploy_routes
from app.api.routes import visual_review as visual_review_routes
from app.api.websocket.manager import ws_router
from app.api.auth import require_auth

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

app_settings = get_settings()


# VR-21 — hold strong refs to boot-time auto-resume tasks so the event loop
# doesn't garbage-collect them mid-flight (create_task only keeps a weak ref).
_boot_resume_tasks: set = set()


async def _auto_resume_session(session_id) -> None:
    """VR-21 — re-launch the orchestrator for a session orphaned by a backend
    restart, instead of failing it.

    Mirrors the ``/resume`` fallback in routes/sessions.py (used when the
    orchestrator isn't registered after a restart): recreate the
    WorkflowOrchestrator, register it, and run() — which picks up from the
    persisted DB state. On ANY failure the session is marked FAILED so a bad
    resume never leaves it as a perpetual zombie.
    """
    from app.db.database import AsyncSessionLocal
    from app.db.models import Session as SessionModel, SessionStatus
    from app.core.orchestrator import WorkflowOrchestrator
    from app.api.websocket.manager import session_manager
    from sqlalchemy import select, update
    from sqlalchemy.orm import selectinload

    sid = str(session_id)
    try:
        async with AsyncSessionLocal() as db:
            stmt = (
                select(SessionModel)
                .where(SessionModel.id == session_id)
                .options(selectinload(SessionModel.agent_configs))
            )
            session_obj = (await db.execute(stmt)).scalar_one_or_none()
            if session_obj is None:
                return
            orchestrator = WorkflowOrchestrator(
                db=db,
                session=session_obj,
                event_callback=session_manager.broadcast,
            )
            await session_manager.register_orchestrator(sid, orchestrator)
            try:
                await orchestrator.run()
            finally:
                await session_manager.unregister_orchestrator(sid)
    except Exception as e:
        logger.error(f"VR-21 auto-resume failed for session {sid}: {e}")
        try:
            async with AsyncSessionLocal() as db2:
                await db2.execute(
                    update(SessionModel)
                    .where(SessionModel.id == session_id)
                    .values(status=SessionStatus.FAILED)
                )
                await db2.commit()
        except Exception:
            pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler."""
    # Startup
    logger.info("Starting CodeForge...")

    # Initialize database
    await init_db()
    logger.info("Database initialized")

    # Initialize LLM router
    await get_llm_router()
    logger.info("LLM Router initialized")

    # Ensure Visual Review storage root exists and is writable.
    # Bug fix: bind-mounted /var/lib/codeforge can be root-owned on first boot,
    # which makes appuser (uid 1000) hit Errno 13 on first capture. Doing this
    # in the lifespan hook means a `docker restart` cannot leave us in a state
    # where the dir was lost (e.g. tmpfs) or the mount perms drifted.
    try:
        from app.core.visual_review import ensure_storage_root
        storage_path = ensure_storage_root()
        logger.info(f"Visual Review storage root ready at {storage_path}")
    except Exception as e:
        # Never crash the backend over storage prep — visual review will surface
        # its own error if/when it tries to write. Defence in depth #1.
        logger.warning(f"ensure_storage_root() failed (non-fatal): {e}")

    # Warn about auth configuration
    if app_settings.codeforge_api_key is None and app_settings.smtp_host is None:
        logger.warning(
            "Neither CODEFORGE_API_KEY nor SMTP_HOST is set — authentication is disabled (dev mode). "
            "Configure SMTP_HOST + ALLOWED_EMAILS for email OTP, or set CODEFORGE_API_KEY for API key auth."
        )

    # VR-21 — Auto-resume sessions interrupted by a backend restart instead of
    # blanket-failing them. orchestrator.run() resumes from the persisted DB
    # state (same path /resume uses when the orchestrator isn't registered after
    # a restart). Guards:
    #   * only RECENT sessions (updated within RESUME_WINDOW) are resurrected;
    #     older RUNNING/ENHANCING zombies are failed (can't meaningfully resume);
    #   * capped at RESUME_CAP so a backlog can't fire a thundering herd of LLM
    #     calls on boot;
    #   * PAUSED sessions are LEFT paused (the user paused them on purpose; they
    #     resume via /resume) — no longer auto-failed;
    #   * AWAITING_VISUAL_REVIEW is left untouched on boot. КАО#R2-04 wires the
    #     in-process 24h auto-finalize + 1h vision auto-resume timers so they fire
    #     for sessions that entered review during THIS process's lifetime; a user
    #     submit/skip always advances it. Re-arming those timers across a restart
    #     is NOT yet implemented (tracked separately as VR-21).
    try:
        import asyncio
        from app.db import AsyncSessionLocal
        from app.db.models import Session as SessionModel, SessionStatus, OTPCode
        from sqlalchemy import select, update, delete
        from datetime import datetime, timezone, timedelta

        RESUME_WINDOW = timedelta(hours=6)
        RESUME_CAP = 5
        cutoff = datetime.now(timezone.utc) - RESUME_WINDOW
        active = [SessionStatus.RUNNING, SessionStatus.ENHANCING]
        async with AsyncSessionLocal() as db:
            # КАО#R1-03 — only RUNNING sessions are orchestrator-resumable.
            # ENHANCING is driven by a separate _run_enhancement task (NOT the
            # orchestrator); resuming it via orchestrator.run() would re-run the
            # whole coder→tester→finalizer pipeline and overwrite the existing
            # FinalResult. So auto-resume RUNNING only…
            recent = await db.execute(
                select(SessionModel.id)
                .where(SessionModel.status == SessionStatus.RUNNING)
                .where(SessionModel.updated_at >= cutoff)
                .order_by(SessionModel.updated_at.desc())
                .limit(RESUME_CAP)
            )
            resume_ids = list(recent.scalars().all())
            # …and reset recent interrupted ENHANCING sessions back to COMPLETED
            # (FinalResult is preserved; the user can re-trigger /enhance).
            enh_reset = await db.execute(
                update(SessionModel)
                .where(SessionModel.status == SessionStatus.ENHANCING)
                .where(SessionModel.updated_at >= cutoff)
                .values(status=SessionStatus.COMPLETED)
                .returning(SessionModel.id)
            )
            enh_reset_ids = list(enh_reset.scalars().all())
            # Older RUNNING/ENHANCING zombies (beyond the window) → FAILED.
            stale = await db.execute(
                update(SessionModel)
                .where(SessionModel.status.in_(active))
                .where(SessionModel.updated_at < cutoff)
                .values(status=SessionStatus.FAILED)
                .returning(SessionModel.id)
            )
            stale_ids = list(stale.scalars().all())
            # Clean up expired OTP codes
            expired = await db.execute(
                delete(OTPCode).where(OTPCode.expires_at < datetime.now(timezone.utc))
            )
            await db.commit()

        for _sid in resume_ids:
            _t = asyncio.create_task(_auto_resume_session(_sid))
            _boot_resume_tasks.add(_t)
            _t.add_done_callback(_boot_resume_tasks.discard)
        if resume_ids:
            logger.warning(f"VR-21 — auto-resuming {len(resume_ids)} interrupted sessions: {resume_ids}")
        if enh_reset_ids:
            logger.warning(f"КАО#R1-03 — reset {len(enh_reset_ids)} interrupted ENHANCING sessions to COMPLETED: {enh_reset_ids}")
        if stale_ids:
            logger.warning(f"Reset {len(stale_ids)} stale zombie sessions to FAILED: {stale_ids}")
        if expired.rowcount:
            logger.info(f"Cleaned up {expired.rowcount} expired OTP codes")
    except Exception as e:
        logger.error(f"Failed startup cleanup (database may be unreachable): {e}")

    yield

    # Shutdown
    logger.info("Shutting down CodeForge...")
    await get_sandbox_client().close()
    await close_llm_router()
    await close_db()
    logger.info("Shutdown complete")


# Create FastAPI app
app = FastAPI(
    title="CodeForge",
    description="Multi-Agent Code Generation and Audit System",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS middleware
# Security policy: wildcard CORS is ONLY allowed when both debug=true AND explicitly opted-in.
# Stage and prod environments — even with debug=true for verbose logging — should NOT expose
# Access-Control-Allow-Origin: * to the public internet.
_explicit_wildcard_dev = app_settings.cors_origins == "*" and app_settings.debug and getattr(app_settings, "cors_allow_wildcard", False)
if app_settings.cors_origins == "*":
    if _explicit_wildcard_dev:
        # Local dev only — opt-in via CORS_ALLOW_WILDCARD=true
        _cors_origins: list[str] = ["*"]
        _allow_credentials = False
        logger.warning("CORS wildcard explicitly enabled (CORS_ALLOW_WILDCARD=true). Local dev only.")
    else:
        # Default safe behavior: restrict to known origins
        _cors_origins = [
            "https://gotcode.ai", "https://www.gotcode.ai",
            "https://stage.gotcode.ai",
            "http://localhost:3000", "http://localhost:3100",
            "http://localhost:3200", "http://localhost:3300",
        ]
        _allow_credentials = True
        logger.warning(
            "CORS_ORIGINS='*' — auto-restricting to known origins (gotcode.ai, stage.gotcode.ai, localhost). "
            "Set CORS_ORIGINS to a specific list for explicit production config, "
            "or CORS_ALLOW_WILDCARD=true (debug only) to keep '*'."
        )
else:
    _cors_origins = [o.strip() for o in app_settings.cors_origins.split(",")]
    _allow_credentials = True
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Security headers middleware (pure ASGI — no BaseHTTPMiddleware overhead)
class SecurityHeadersMiddleware:
    """Add security headers to all HTTP responses."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                # HSTS only over HTTPS (avoid leaking to HTTP-only dev setups)
                if not app_settings.debug:
                    headers.append((b"strict-transport-security", b"max-age=63072000; includeSubDomains"))
                # These headers are ALWAYS safe to apply (no HTTPS dependency)
                headers.append((b"x-content-type-options", b"nosniff"))
                headers.append((b"x-frame-options", b"DENY"))
                headers.append((b"referrer-policy", b"strict-origin-when-cross-origin"))
                headers.append((b"cache-control", b"no-store"))
                message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_headers)


# Security headers ALWAYS apply (regardless of debug mode).
# Previously gated on `not debug`, which left stage/prod with debug=true vulnerable.
app.add_middleware(SecurityHeadersMiddleware)


# Validation error handler to log detailed errors.
# Pydantic v2 includes the raw exception object in ctx.error when a field_validator
# raises ValueError — that's not JSON-serializable, so we sanitize it to a string.
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.error(f"Validation error on {request.method} {request.url.path}: {exc.errors()}")

    def _sanitize(item: object) -> object:
        if isinstance(item, dict):
            return {k: _sanitize(v) for k, v in item.items()}
        if isinstance(item, list):
            return [_sanitize(x) for x in item]
        if isinstance(item, BaseException):
            return str(item)
        try:
            import json as _json
            _json.dumps(item)
            return item
        except (TypeError, ValueError):
            return str(item)

    safe_errors = _sanitize(exc.errors())
    return JSONResponse(
        status_code=422,
        content={"detail": safe_errors},
    )


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """Catch-all handler — log the error, return a safe 500 response."""
    logger.exception(f"Unhandled error on {request.method} {request.url.path}: {exc}")
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
    )

# Auth routes — public (no auth dependency)
app.include_router(auth_routes.router, prefix="/api/auth", tags=["Auth"])

# Include routers — all API routes require authentication (JWT or API key)
_auth = [Depends(require_auth)]
app.include_router(sessions.router, prefix="/api/sessions", tags=["Sessions"], dependencies=_auth)
app.include_router(prompts.router, prefix="/api/prompts", tags=["Prompts"], dependencies=_auth)
app.include_router(code.router, prefix="/api/code", tags=["Code"], dependencies=_auth)
app.include_router(settings_routes.router, prefix="/api/settings", tags=["Settings"], dependencies=_auth)
app.include_router(execution.router, prefix="/api/execution", tags=["Execution"], dependencies=_auth)
app.include_router(templates_routes.router, prefix="/api/templates", tags=["Templates"], dependencies=_auth)
app.include_router(webhooks_routes.router, prefix="/api/webhooks", tags=["Webhooks"], dependencies=_auth)
# Deployment endpoints (Feature #10) — Vercel one-click deploy. Mounted at /api so
# the resulting path is /api/sessions/{id}/deploy/vercel. Auth is enforced inside
# the route via Depends(require_auth) so we know the caller's user_id.
app.include_router(deploy_routes.router, prefix="/api", tags=["Deploy"], dependencies=_auth)
# Visual Review (Wave 1) — endpoints mounted under /api/sessions/{id}/visual-review/*
# Static PNG serving lives at /api/screenshots/* (auth still enforced). It MUST
# live under /api/ so the frontend nginx proxies it; see КАО#VR-22 in
# app/api/routes/visual_review.py for the regression history.
app.include_router(
    visual_review_routes.router,
    prefix="/api/sessions",
    tags=["VisualReview"],
    dependencies=_auth,
)
app.include_router(
    visual_review_routes.static_router,
    tags=["VisualReview"],
    # NO dependencies=_auth here — KAO#VR-22: the handler enforces auth
    # internally (signed URL OR Bearer). A global Bearer dep would 401 every
    # browser <img> request because img tags can't send Authorization headers.
)
# Spec quality scorer + cost estimator (Features 2a/2b) — auth-protected so
# anonymous users can't burn our cycles, but no per-user state.
app.include_router(
    spec_helper_routes.router,
    prefix="/api/spec-helper",
    tags=["SpecHelper"],
    dependencies=_auth,
)
# Public read-only share link (Feature #5). NO auth dependency — anyone
# with the token can view. Only minimal, non-secret fields are exposed.
app.include_router(share_routes.router, prefix="/api", tags=["Share"])
# WebSocket auth is handled inside the endpoint via validate_ws_token
app.include_router(ws_router, tags=["WebSocket"])


@app.get("/")
async def root():
    """Root endpoint."""
    return {
        "name": "CodeForge",
        "status": "running",
    }


@app.get("/health")
async def health():
    """Health check endpoint with database connectivity test."""
    from app.db.database import AsyncSessionLocal
    from sqlalchemy import text
    try:
        async with AsyncSessionLocal() as session:
            await session.execute(text("SELECT 1"))
        return {"status": "healthy"}
    except Exception as e:
        logger.error(f"Health check failed: {e}")
        return JSONResponse(status_code=503, content={"status": "unhealthy", "detail": "database unavailable"})


if __name__ == "__main__":
    import uvicorn
    # NOTE: For production, configure uvicorn with --limit-concurrency and
    # --limit-max-requests to bound request body sizes and prevent resource exhaustion.
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=8000,
        reload=app_settings.debug,
    )
