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
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest
from starlette.responses import Response as StarletteResponse

from app.config import get_settings
from app.db.database import init_db, close_db
from app.llm.router import get_llm_router, close_llm_router
from app.sandbox import get_sandbox_client
from app.api.routes import sessions, prompts, code, settings as settings_routes, execution
from app.api.routes import auth as auth_routes
from app.api.websocket.manager import ws_router
from app.api.auth import require_auth

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

app_settings = get_settings()


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

    # Warn about auth configuration
    if app_settings.codeforge_api_key is None and app_settings.smtp_host is None:
        logger.warning(
            "Neither CODEFORGE_API_KEY nor SMTP_HOST is set — authentication is disabled (dev mode). "
            "Configure SMTP_HOST + ALLOWED_EMAILS for email OTP, or set CODEFORGE_API_KEY for API key auth."
        )

    # Reset zombie sessions (running/paused status left from a previous process)
    try:
        from app.db import AsyncSessionLocal
        from app.db.models import Session as SessionModel, SessionStatus, OTPCode
        from sqlalchemy import update, delete
        from datetime import datetime, timezone
        async with AsyncSessionLocal() as db:
            result = await db.execute(
                update(SessionModel)
                .where(SessionModel.status.in_([SessionStatus.RUNNING, SessionStatus.PAUSED, SessionStatus.ENHANCING]))
                .values(status=SessionStatus.FAILED)
                .returning(SessionModel.id)
            )
            zombie_ids = result.scalars().all()
            # Clean up expired OTP codes
            expired = await db.execute(
                delete(OTPCode).where(OTPCode.expires_at < datetime.now(timezone.utc))
            )
            await db.commit()
            if zombie_ids:
                logger.warning(f"Reset {len(zombie_ids)} zombie sessions to FAILED: {zombie_ids}")
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
# When origins is wildcard, disable credentials (browsers reject * + credentials anyway)
if app_settings.cors_origins == "*":
    _cors_origins: list[str] = ["*"]
    _allow_credentials = False
    if not app_settings.debug:
        logger.warning(
            "CORS is configured with wildcard origin ('*') in non-debug mode. "
            "Set CORS_ORIGINS to specific origins for production deployments."
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


# Strict-Transport-Security header in non-debug mode
class HSTSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        response: StarletteResponse = await call_next(request)
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        return response


if not app_settings.debug:
    app.add_middleware(HSTSMiddleware)


# Validation error handler to log detailed errors
@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    logger.error(f"Validation error on {request.method} {request.url.path}: {exc.errors()}")
    return JSONResponse(
        status_code=422,
        content={"detail": exc.errors()}
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
    """Health check endpoint."""
    return {"status": "healthy"}


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
