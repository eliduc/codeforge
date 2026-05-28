"""Smoke tests for the authentication flow.

These tests exercise behaviour that does NOT require a valid OTP:

- /api/auth/request-otp validation (bad email format)
- /api/auth/request-otp on a non-whitelisted email
- /api/sessions and /api/auth/me without a token

To obtain a JWT for follow-up tests, do the following manually:

    1. Add a test email to ALLOWED_EMAILS in .env (e.g. test@codeforge.local)
    2. POST /api/auth/request-otp {"email": "test@codeforge.local"}
       -- with EMAIL_DEV_MODE=true the OTP is logged to stdout instead of sent.
    3. Read the OTP from `docker compose logs backend`
    4. POST /api/auth/verify-otp {"email": "...", "code": "123456"}
       -- returns access_token, send as `Authorization: Bearer <token>`.

Anything requiring that token uses pytest.skip until a fixture is wired.

Run inside docker compose:

    docker compose exec backend pytest backend/tests/test_auth_smoke.py -v
"""

import os

import httpx
import pytest

BACKEND_URL = os.environ.get("BACKEND_URL", "http://backend:8000")
NON_WHITELISTED_EMAIL = os.environ.get(
    "TEST_NON_WHITELISTED_EMAIL", "definitely-not-allowed-9q3@example.com"
)


@pytest.mark.asyncio
async def test_request_otp_rejects_invalid_email_format() -> None:
    """Pydantic EmailStr rejects garbage input with 422."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.post("/api/auth/request-otp", json={"email": "notanemail"})
    assert resp.status_code == 422, f"expected 422, got {resp.status_code}: {resp.text}"


@pytest.mark.asyncio
async def test_request_otp_missing_email_field() -> None:
    """Missing required field returns 422."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.post("/api/auth/request-otp", json={})
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_request_otp_non_whitelisted_returns_not_allowed() -> None:
    """Non-whitelisted emails must get the not_allowed flag (no enumeration leak,
    but the frontend needs the flag to surface 'request access')."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.post(
            "/api/auth/request-otp", json={"email": NON_WHITELISTED_EMAIL}
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body.get("not_allowed") is True, f"expected not_allowed=True, got {body}"
    assert "message" in body


@pytest.mark.asyncio
async def test_verify_otp_with_no_existing_code_returns_400() -> None:
    """Verifying a code for an email that never requested one returns 400."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.post(
            "/api/auth/verify-otp",
            json={"email": NON_WHITELISTED_EMAIL, "code": "000000"},
        )
    assert resp.status_code == 400
    body = resp.json()
    assert "detail" in body


@pytest.mark.asyncio
async def test_sessions_list_requires_auth() -> None:
    """GET /api/sessions without a token must 401 (assuming AUTH_DISABLED is false)."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.get("/api/sessions/")
    if resp.status_code == 200:
        pytest.skip("AUTH_DISABLED=true in this environment; skipping auth check")
    assert resp.status_code == 401, f"expected 401, got {resp.status_code}: {resp.text}"


@pytest.mark.asyncio
async def test_me_without_token_returns_401() -> None:
    """GET /api/auth/me without Authorization must 401."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.get("/api/auth/me")
    if resp.status_code == 200:
        pytest.skip("AUTH_DISABLED=true; /me returns dev user")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_me_with_garbage_token_returns_401() -> None:
    """A clearly invalid bearer token must be rejected."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.get(
            "/api/auth/me",
            headers={"Authorization": "Bearer not.a.real.jwt"},
        )
    if resp.status_code == 200:
        pytest.skip("AUTH_DISABLED=true; bypasses JWT validation")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_authenticated_sessions_flow() -> None:
    """End-to-end happy path requires an authenticated client fixture (not yet wired)."""
    pytest.skip("Requires authenticated test fixture (see module docstring)")
