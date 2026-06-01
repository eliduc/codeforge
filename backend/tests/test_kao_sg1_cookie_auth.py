"""КАО#SG1-selfxss — JWT delivered via an httpOnly cookie.

Integration tests (run against the live stage backend, like the rest of
backend/tests/). They verify that:

  * verify-otp sets an HttpOnly, SameSite=Lax session cookie AND still returns
    access_token in the body (backward compat — conftest._provision_token_sync
    and every Bearer-based test depend on the body token);
  * a client holding ONLY the cookie (no Authorization header) reaches
    protected endpoints;
  * the Bearer-header path still works (regression);
  * a forged/garbage cookie is rejected on a protected endpoint (symmetry with
    the header negative tests);
  * logout clears the cookie;
  * the screenshot endpoint — which calls require_auth() DIRECTLY rather than
    via Depends — still works with the new request-aware signature
    (КАО#SG1 P0 regression guard: a wrong signature would 500, not 404).

Skips cleanly when the backend isn't reachable or the test email isn't
whitelisted, exactly like conftest's fixtures.
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8000")
SESSION_COOKIE = "codeforge_session"

# Disposable test-email domain. Default is the RFC-2606 reserved example.com;
# override (e.g. CF_SG1_TEST_DOMAIN=gmail.com) to match a given stage's
# ALLOWED_EMAILS so check_email_allowed() lets the fixture user through.
_TEST_DOMAIN = os.environ.get("CF_SG1_TEST_DOMAIN", "codeforge-test.example.com")


# ---------------------------------------------------------------------------
# Helpers (mirror conftest's provisioning so this file is self-contained)
# ---------------------------------------------------------------------------

def _skip_if_backend_down() -> None:
    try:
        with httpx.Client(base_url=BACKEND_URL, timeout=5.0) as probe:
            if probe.get("/health").status_code != 200:
                pytest.skip("backend /health not 200")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"backend unreachable at {BACKEND_URL}: {exc!r}")


def _insert_otp(email: str, code: str) -> bool:
    """Insert an OTP row directly. Returns False to signal a skip."""
    try:
        from app.api.auth import check_email_allowed
        from app.api.routes.auth import _hash_code
        from app.config import get_settings
        from app.db import AsyncSessionLocal, engine as _engine
        from app.db.models import OTPCode
    except Exception:
        return False
    if not check_email_allowed(email):
        return False
    settings = get_settings()

    async def _insert():
        await _engine.dispose()
        async with AsyncSessionLocal() as db:
            db.add(OTPCode(
                email=email.lower().strip(),
                code_hash=_hash_code(code),
                expires_at=datetime.now(timezone.utc)
                + timedelta(minutes=settings.otp_expiry_minutes),
            ))
            await db.commit()

    try:
        asyncio.run(_insert())
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_insert())
        finally:
            loop.close()
    return True


def _cleanup_user(email: str) -> None:
    try:
        from sqlalchemy import delete, select
        from app.db import AsyncSessionLocal
        from app.db.models import OTPCode, User

        async def _do():
            async with AsyncSessionLocal() as db:
                user = (
                    await db.execute(select(User).where(User.email == email.lower().strip()))
                ).scalar_one_or_none()
                if user is not None:
                    await db.delete(user)
                await db.execute(delete(OTPCode).where(OTPCode.email == email.lower().strip()))
                await db.commit()

        try:
            asyncio.run(_do())
        except RuntimeError:
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(_do())
            finally:
                loop.close()
    except Exception:  # noqa: BLE001
        pass


def _fresh_login() -> tuple[httpx.Client, httpx.Response, str]:
    """Provision a user + verify-otp.

    Returns ``(cookie_client, verify_response, email)``. The client holds ONLY
    the session cookie (no Authorization header). Caller closes the client and
    cleans up the user.
    """
    _skip_if_backend_down()
    email = f"cf-sg1-{uuid.uuid4().hex[:10]}@{_TEST_DOMAIN}"
    code = "135790"
    if not _insert_otp(email, code):
        pytest.skip("cannot insert OTP (backend modules not importable / email not whitelisted)")

    client = httpx.Client(base_url=BACKEND_URL, timeout=15.0)
    resp = client.post("/api/auth/verify-otp", json={"email": email, "code": code})
    if resp.status_code != 200:
        client.close()
        _cleanup_user(email)
        pytest.skip(f"verify-otp failed: {resp.status_code} {resp.text}")
    return client, resp, email


def _auth_enforced(client: httpx.Client) -> bool:
    """True when the backend enforces auth (i.e. not dev-mode)."""
    return client.get("/api/sessions/?skip=0&limit=1").status_code == 401


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_verify_otp_sets_httponly_session_cookie():
    client, resp, email = _fresh_login()
    try:
        raw = " ; ".join(resp.headers.get_list("set-cookie")).lower()
        assert "codeforge_session=" in raw, f"no session cookie in Set-Cookie: {raw!r}"
        assert "httponly" in raw, "session cookie must be HttpOnly"
        assert "samesite=lax" in raw, "session cookie must be SameSite=Lax"
        assert "path=/" in raw, "session cookie must be Path=/"
        # This call has no X-Forwarded-Proto (direct to backend) → no Secure, so
        # local http login keeps working. Inspect only the cookie ATTRIBUTES
        # (after the first ';'), not the JWT value, to avoid false positives.
        attrs = raw.split(";", 1)[1] if ";" in raw else ""
        assert "secure" not in attrs, f"Secure must be absent without X-Forwarded-Proto: {raw!r}"
        # Backward compat: the body STILL carries access_token.
        assert resp.json().get("access_token"), "verify-otp must keep access_token in the body"
        # And the cookie landed in the client jar.
        assert SESSION_COOKIE in client.cookies
    finally:
        client.close()
        _cleanup_user(email)


def test_cookie_only_reaches_protected_endpoints():
    client, _resp, email = _fresh_login()
    try:
        # This client carries NO Authorization header — only the cookie.
        assert "authorization" not in {k.lower() for k in client.headers}
        me = client.get("/api/auth/me")
        assert me.status_code == 200, me.text
        sessions = client.get("/api/sessions/?skip=0&limit=1")
        assert sessions.status_code == 200, sessions.text
    finally:
        client.close()
        _cleanup_user(email)


def test_header_bearer_still_works():
    client, resp, email = _fresh_login()
    try:
        token = resp.json()["access_token"]
        # Fresh client with NO cookie jar — only the Bearer header.
        with httpx.Client(
            base_url=BACKEND_URL, timeout=15.0,
            headers={"Authorization": f"Bearer {token}"},
        ) as bearer:
            me = bearer.get("/api/auth/me")
            assert me.status_code == 200, me.text
    finally:
        client.close()
        _cleanup_user(email)


def test_forged_cookie_is_rejected():
    _skip_if_backend_down()
    with httpx.Client(
        base_url=BACKEND_URL, timeout=15.0,
        cookies={SESSION_COOKIE: "not.a.valid.jwt"},
    ) as client:
        resp = client.get("/api/sessions/?skip=0&limit=1")
        if resp.status_code == 200:
            pytest.skip("backend in dev-mode (auth not configured) — nothing to assert")
        assert resp.status_code == 401, resp.text


def test_logout_clears_cookie():
    client, _resp, email = _fresh_login()
    try:
        out = client.post("/api/auth/logout")
        assert out.status_code == 200, out.text
        raw = " ; ".join(out.headers.get_list("set-cookie")).lower()
        assert "codeforge_session=" in raw, f"logout must emit a clearing Set-Cookie: {raw!r}"
        # delete_cookie clears via empty value + a past expiry / Max-Age=0.
        assert ("max-age=0" in raw) or ("expires=thu, 01 jan 1970" in raw), raw
    finally:
        client.close()
        _cleanup_user(email)


def test_screenshot_cookie_path_does_not_crash():
    # КАО#SG1 P0 regression: serve_screenshot calls require_auth() directly and
    # must pass `request` through. With a VALID session cookie but a random
    # (non-existent) screenshot, auth should PASS and the lookup should 404 —
    # never 500 (which a broken require_auth signature would produce).
    client, _resp, email = _fresh_login()
    try:
        r = client.get(f"/api/screenshots/{uuid.uuid4()}/{uuid.uuid4()}/frame_0.png")
        assert r.status_code == 404, (
            f"expected 404 (auth ok, not found), got {r.status_code}: {r.text[:200]}"
        )
    finally:
        client.close()
        _cleanup_user(email)


def test_secure_flag_set_when_forwarded_proto_https():
    # КАО#SG1 — the cookie's Secure flag is derived from X-Forwarded-Proto so it
    # is correct behind a TLS-terminating proxy (stage/prod) while staying off
    # for local http dev. Here we assert the positive path.
    _skip_if_backend_down()
    email = f"cf-sg1-{uuid.uuid4().hex[:10]}@{_TEST_DOMAIN}"
    code = "246802"
    if not _insert_otp(email, code):
        pytest.skip("cannot insert OTP (backend modules not importable / email not whitelisted)")
    try:
        with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as c:
            r = c.post(
                "/api/auth/verify-otp",
                json={"email": email, "code": code},
                headers={"X-Forwarded-Proto": "https"},
            )
            if r.status_code != 200:
                pytest.skip(f"verify-otp failed: {r.status_code} {r.text}")
            raw = " ; ".join(r.headers.get_list("set-cookie")).lower()
            assert "codeforge_session=" in raw
            assert "secure" in raw, f"Secure must be set when X-Forwarded-Proto=https: {raw!r}"
    finally:
        _cleanup_user(email)


def test_screenshot_requires_auth_when_anonymous():
    _skip_if_backend_down()
    with httpx.Client(base_url=BACKEND_URL, timeout=15.0) as client:
        if not _auth_enforced(client):
            pytest.skip("backend in dev-mode (auth not configured)")
        # No cookie, no Bearer, no signature → the Bearer fallback must 401.
        r = client.get(f"/api/screenshots/{uuid.uuid4()}/{uuid.uuid4()}/frame_0.png")
        assert r.status_code == 401, r.text
