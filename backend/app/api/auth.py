"""Authentication for CodeForge.

Supports three auth mechanisms (checked in order):
1. JWT Bearer token  — issued after email OTP verification
2. API key Bearer     — legacy CODEFORGE_API_KEY (fallback / machine access)
3. Dev mode           — when nothing is configured, all requests are allowed

When both JWT and API key are absent/invalid → 401 Unauthorized.
"""

import fnmatch
import hmac
import logging
from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt

from app.config import get_settings

logger = logging.getLogger(__name__)

# Optional bearer — allows requests without Authorization header (for dev mode check)
_bearer_scheme = HTTPBearer(auto_error=False)

# JWT constants
_JWT_ALGORITHM = "HS256"

# КАО#SG1-selfxss — name of the httpOnly cookie that carries the session JWT
# for browser clients. Kept distinct from the legacy `codeforge_token`
# localStorage key so the migration is unambiguous.
SESSION_COOKIE_NAME = "codeforge_session"


def cookie_secure_flag(request: Request | None) -> bool:
    """КАО#SG1-selfxss — decide the Secure flag for the session cookie.

    Fail-safe toward "login works": only mark the cookie Secure when we have a
    *positive* https signal from the proxy (``X-Forwarded-Proto: https``). When
    the header is absent we return False so local-dev (http) login still works —
    the only cost on an https deployment that forgot the proxy header is a
    missing Secure attribute, never a broken login. ``COOKIE_SECURE`` overrides.
    """
    override = get_settings().cookie_secure
    if override is not None:
        return override
    if request is None:
        return False
    return request.headers.get("x-forwarded-proto", "").lower() == "https"


# ---------------------------------------------------------------------------
# JWT helpers
# ---------------------------------------------------------------------------

def create_jwt_token(user_id: str, email: str) -> str:
    """Create a signed JWT token for an authenticated user."""
    settings = get_settings()
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expiry_minutes)
    payload = {
        "sub": user_id,
        "email": email,
        "exp": expire,
        "type": "access",
    }
    return jwt.encode(payload, settings.secret_key, algorithm=_JWT_ALGORITHM)


def decode_jwt_token(token: str) -> dict | None:
    """Decode and validate a JWT token. Returns payload dict or None."""
    settings = get_settings()
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[_JWT_ALGORITHM])
        if payload.get("type") != "access":
            return None
        return payload
    except JWTError:
        return None


# ---------------------------------------------------------------------------
# Email whitelist
# ---------------------------------------------------------------------------

def check_email_allowed(email: str) -> bool:
    """Check if email matches the ALLOWED_EMAILS whitelist.

    Returns True if:
    - ALLOWED_EMAILS is not set (no restriction)
    - email matches any pattern in the comma-separated list
      Patterns support wildcards, e.g. "*@company.com"
    """
    settings = get_settings()
    if not settings.allowed_emails:
        return True

    patterns = [p.strip().lower() for p in settings.allowed_emails.split(",") if p.strip()]
    if not patterns:
        return True

    email_lower = email.lower()
    return any(fnmatch.fnmatch(email_lower, pat) for pat in patterns)


# ---------------------------------------------------------------------------
# Auth mode detection
# ---------------------------------------------------------------------------

def _is_auth_configured() -> bool:
    """Return True if any authentication mechanism is configured."""
    settings = get_settings()
    has_api_key = (
        settings.codeforge_api_key is not None
        and bool(settings.codeforge_api_key.get_secret_value().strip())
    )
    has_smtp = settings.smtp_host is not None
    has_whitelist = bool(settings.allowed_emails)
    return has_api_key or has_smtp or has_whitelist


# ---------------------------------------------------------------------------
# Unified auth dependency (replaces require_api_key)
# ---------------------------------------------------------------------------

async def require_auth(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> dict | None:
    """Unified FastAPI dependency for authentication.

    Returns a dict with user info (from JWT) or None (API key / dev mode).
    Raises 401 if authentication fails.

    КАО#SG1-selfxss — accepts the session JWT from EITHER the Authorization
    Bearer header (API-key + programmatic clients) OR the httpOnly
    ``codeforge_session`` cookie (browser clients). The header is tried first
    so existing behaviour is unchanged. Direct (non-Depends) callers must pass
    ``request`` explicitly.
    """
    settings = get_settings()

    # Dev mode: nothing configured — skip auth entirely
    if not _is_auth_configured():
        return None

    header_token = credentials.credentials if credentials else None
    cookie_token = request.cookies.get(SESSION_COOKIE_NAME) if request is not None else None

    # Try a JWT from either source — header first, then cookie.
    for token in (header_token, cookie_token):
        if token:
            payload = decode_jwt_token(token)
            if payload:
                return payload

    # API key fallback — header only (cookies never carry the machine key).
    if header_token and settings.codeforge_api_key:
        expected = settings.codeforge_api_key.get_secret_value()
        if expected and expected.strip() and hmac.compare_digest(header_token, expected):
            return None  # API key auth — no user context

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or missing credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


# ---------------------------------------------------------------------------
# WebSocket auth (replaces validate_ws_api_key)
# ---------------------------------------------------------------------------

def validate_ws_token(token: str | None) -> bool:
    """Validate JWT or API key for WebSocket connections.

    Returns True if auth passes, False otherwise.
    When nothing is configured, always returns True (dev mode).
    """
    if not _is_auth_configured():
        return True

    if not token or not token.strip():
        return False

    # Try JWT
    if decode_jwt_token(token) is not None:
        return True

    # Try API key
    settings = get_settings()
    if settings.codeforge_api_key:
        expected = settings.codeforge_api_key.get_secret_value()
        if expected and expected.strip():
            return hmac.compare_digest(token, expected)

    return False


# ---------------------------------------------------------------------------
# Legacy aliases (kept for backward compatibility during transition)
# ---------------------------------------------------------------------------

async def require_api_key(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
) -> None:
    """Legacy wrapper — delegates to require_auth."""
    await require_auth(request, credentials)


validate_ws_api_key = validate_ws_token


# ---------------------------------------------------------------------------
# Multi-tenancy helper
# ---------------------------------------------------------------------------

def get_current_user_id(auth_data: dict | None) -> str | None:
    """Extract the authenticated user's UUID from auth_data.

    Returns the user's UUID string for JWT-authenticated requests,
    or None for API-key / dev-mode contexts (which retain full access
    for backwards compatibility).
    """
    if auth_data is None:
        return None  # Dev mode or API key — no user context, treat as "all access"
    return auth_data.get("sub")  # JWT 'sub' claim is the user UUID
