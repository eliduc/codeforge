"""Authentication API routes — email OTP login flow.

POST /api/auth/request-otp   — send a one-time code to the user's email
POST /api/auth/verify-otp    — verify the code and return a JWT
GET  /api/auth/me            — return the current authenticated user
"""

import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, func as sa_func, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import (
    SESSION_COOKIE_NAME,
    check_email_allowed,
    cookie_secure_flag,
    create_jwt_token,
    require_auth,
)
from app.config import get_settings
from app.db import AsyncSessionLocal
from app.db.models import OTPCode, User
from app.services.email import send_otp_email, send_access_request_email

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Request / response schemas
# ---------------------------------------------------------------------------

class OTPRequest(BaseModel):
    email: EmailStr


class OTPVerify(BaseModel):
    email: EmailStr
    code: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: dict


class UserResponse(BaseModel):
    id: str
    email: str
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _hash_code(code: str) -> str:
    """HMAC-SHA256 hash of a one-time code, keyed with SECRET_KEY.

    Using HMAC prevents offline brute-force of the 6-digit OTP from a DB dump
    (attacker would also need the secret key).
    """
    key = get_settings().secret_key.encode()
    return hmac.new(key, code.encode(), hashlib.sha256).hexdigest()


def _generate_otp(length: int = 6) -> str:
    """Generate a random numeric OTP of the given length."""
    return "".join(secrets.choice("0123456789") for _ in range(length))


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/request-otp")
async def request_otp(body: OTPRequest):
    """Send a one-time code to the user's email.

    If the email is not in the whitelist, returns {not_allowed: true} so the
    frontend can offer the "Request access" button.
    """
    settings = get_settings()
    email = body.email.lower().strip()

    # Check whitelist
    if not check_email_allowed(email):
        logger.info("OTP request for non-whitelisted email: %s", email)
        return {
            "message": "This email is not in the allowed list.",
            "not_allowed": True,
        }

    ok_msg = {"message": "If this email is allowed, you will receive a code shortly."}

    async with AsyncSessionLocal() as db:
        # Rate limit: max 3 pending (unused + unexpired) OTPs per email in last 10 min.
        # Lock matching rows first (FOR UPDATE), then count in Python to prevent
        # TOCTOU race (two concurrent requests both passing the count check).
        # Note: FOR UPDATE cannot be used with aggregate functions in PostgreSQL.
        ten_min_ago = datetime.now(timezone.utc) - timedelta(minutes=10)
        result = await db.execute(
            select(OTPCode.id)
            .where(
                OTPCode.email == email,
                OTPCode.used == False,  # noqa: E712
                OTPCode.expires_at > datetime.now(timezone.utc),
                OTPCode.created_at > ten_min_ago,
            )
            .with_for_update()
        )
        pending_count = len(result.all())
        if pending_count >= 3:
            logger.warning("OTP rate limit hit for %s (%d pending)", email, pending_count)
            await db.rollback()  # release FOR UPDATE lock
            return ok_msg

        # Generate OTP
        otp_code = _generate_otp(settings.otp_length)
        otp_record = OTPCode(
            email=email,
            code_hash=_hash_code(otp_code),
            expires_at=datetime.now(timezone.utc) + timedelta(minutes=settings.otp_expiry_minutes),
        )
        db.add(otp_record)
        await db.commit()

    # Send email (or log in dev mode)
    try:
        await send_otp_email(email, otp_code)
    except Exception:
        logger.exception("Failed to send OTP email to %s", email)
        # Still return OK to prevent enumeration
        return ok_msg

    return ok_msg


@router.post("/verify-otp", response_model=TokenResponse)
async def verify_otp(body: OTPVerify, request: Request, response: Response):
    """Verify an OTP code and return a JWT access token."""
    email = body.email.lower().strip()
    code = body.code.strip()

    async with AsyncSessionLocal() as db:
        # Find the latest unused, unexpired OTP for this email
        result = await db.execute(
            select(OTPCode)
            .where(
                OTPCode.email == email,
                OTPCode.used == False,  # noqa: E712
                OTPCode.expires_at > datetime.now(timezone.utc),
            )
            .order_by(OTPCode.created_at.desc())
            .limit(1)
        )
        otp_record = result.scalar_one_or_none()

        if otp_record is None:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid or expired code. Please request a new one.",
            )

        # Check max attempts (5)
        if otp_record.attempts >= 5:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many attempts. Please request a new code.",
            )

        # Increment attempts
        otp_record.attempts += 1

        # Compare hash
        if not hmac.compare_digest(_hash_code(code), otp_record.code_hash):
            await db.commit()
            remaining = 5 - otp_record.attempts
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Incorrect code. {remaining} attempt(s) remaining.",
            )

        # Mark OTP as used
        otp_record.used = True
        await db.flush()

        # Upsert user
        user_result = await db.execute(
            select(User).where(User.email == email)
        )
        user = user_result.scalar_one_or_none()

        if user is None:
            user = User(email=email)
            db.add(user)
            await db.flush()
            logger.info("Created new user: %s (%s)", email, user.id)

        user.last_login_at = datetime.now(timezone.utc)
        await db.commit()
        await db.refresh(user)

    # Generate JWT
    token = create_jwt_token(user.id, user.email)

    # КАО#SG1-selfxss — also deliver the JWT in an httpOnly cookie so page-level
    # XSS (e.g. a same-origin preview tab opened from generated code) cannot
    # read it from localStorage. The body still carries access_token for
    # API/CLI clients and to keep the response contract unchanged.
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=get_settings().jwt_expiry_minutes * 60,
        httponly=True,
        samesite="lax",
        secure=cookie_secure_flag(request),
        path="/",
    )

    return TokenResponse(
        access_token=token,
        user={
            "id": user.id,
            "email": user.email,
            "is_active": user.is_active,
        },
    )


@router.get("/me", response_model=UserResponse)
async def get_current_user(auth: dict | None = Depends(require_auth)):
    """Return the currently authenticated user's profile."""
    if auth is None:
        # Dev mode or API key auth — no user context
        return UserResponse(
            id="dev",
            email="dev@localhost",
            is_active=True,
            created_at=datetime.now(timezone.utc),
            last_login_at=None,
        )

    user_id = auth.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token")

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()

    if user is None:
        raise HTTPException(status_code=401, detail="User not found")

    return UserResponse(
        id=user.id,
        email=user.email,
        is_active=user.is_active,
        created_at=user.created_at,
        last_login_at=user.last_login_at,
    )


@router.post("/logout")
async def logout(request: Request, response: Response):
    """КАО#SG1-selfxss — clear the httpOnly session cookie.

    Public on purpose: logout must succeed even when the current session
    cookie is already expired/invalid. The delete attributes (path, samesite,
    secure) must mirror the ones used in ``set_cookie`` or the browser leaves
    a zombie cookie behind.
    """
    response.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        samesite="lax",
        secure=cookie_secure_flag(request),
    )
    return {"message": "Logged out"}


class AccessRequest(BaseModel):
    email: EmailStr


@router.post("/request-access")
async def request_access(body: AccessRequest):
    """Send an access request email to the administrator.

    Called when a user's email is not in the whitelist.
    """
    email = body.email.lower().strip()
    settings = get_settings()

    if not settings.admin_email:
        logger.warning("Access request from %s but ADMIN_EMAIL is not configured", email)
        return {"message": "Your access request has been sent to the administrator."}

    try:
        await send_access_request_email(
            requester_email=email,
            admin_email=settings.admin_email,
        )
    except Exception:
        logger.exception("Failed to send access request for %s", email)

    return {"message": "Your access request has been sent to the administrator."}
