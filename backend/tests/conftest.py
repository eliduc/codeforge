"""Pytest fixtures for CodeForge integration tests.

Reusable auth fixtures that work inside the stage backend container, where
both the FastAPI app modules and the running backend HTTP API are reachable.

Usage:
    # All non-e2e tests (no auth needed)
    docker compose exec backend python -m pytest backend/tests/ -v

    # Authenticated end-to-end tests
    docker compose exec backend python -m pytest backend/tests/ -v -m e2e

The ``auth_token`` fixture inserts an OTPCode row directly into the database
with a known plaintext, then calls /api/auth/verify-otp normally to obtain a
real JWT — exercising the actual auth code path without relying on email or
log-scraping. Cleanup deletes the test user (cascades sessions via FK).

Phase 1 tests (test_authenticated_flow.py) are async and use:
  - async_auth_client       (httpx.AsyncClient)
  - async_created_session   (dict)

Phase 2 tests (test_sessions_crud.py, test_multitenancy.py, test_security.py,
test_features.py) are sync (or async-marked but use sync HTTP calls) and use:
  - auth_client       (httpx.Client)
  - auth_client_b     (httpx.Client, second user for multitenancy)
  - created_session   (str — session ID)
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator

import httpx
import pytest
import pytest_asyncio


# When running inside docker compose, "backend" resolves; if pytest is invoked
# from inside the backend container itself, localhost works too.
BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8000")


def pytest_configure(config):
    config.addinivalue_line(
        "markers",
        "e2e: end-to-end tests that require the backend to be running and "
        "ALLOWED_EMAILS configured to permit the test fixture email.",
    )
    config.addinivalue_line(
        "markers",
        "slow: tests that perform direct DB writes; not run by default smoke",
    )


# ---------------------------------------------------------------------------
# Email used by the auth fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def test_email() -> str:
    """Stable per-run unique email. Must match an ALLOWED_EMAILS pattern.

    Override with CF_TEST_EMAIL env var to use a specific whitelisted address.
    Default uses *@example.com (RFC 2606 reserved test domain) which the stage
    .env explicitly whitelists via ``*@example.com``.
    """
    return os.environ.get(
        "CF_TEST_EMAIL",
        f"cf-test-{uuid.uuid4().hex[:10]}@codeforge-test.example.com",
    )


@pytest.fixture(scope="session")
def test_email_b() -> str:
    """Second test user (User B) for multitenancy isolation tests."""
    return os.environ.get(
        "CF_TEST_EMAIL_B",
        f"cf-test-b-{uuid.uuid4().hex[:10]}@codeforge-test.example.com",
    )


# ---------------------------------------------------------------------------
# Async auth_token: inserts an OTP row, then calls verify-otp to get a real JWT.
# Used by async tests (Phase 1, test_authenticated_flow.py).
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def auth_token(test_email: str) -> AsyncIterator[str]:
    # Imports are deferred so non-e2e tests can collect even outside the
    # backend container.
    try:
        from app.api.auth import check_email_allowed
        from app.api.routes.auth import _hash_code
        from app.config import get_settings
        from app.db import AsyncSessionLocal
        from app.db.models import OTPCode
    except Exception as exc:
        pytest.skip(f"backend modules not importable ({exc!r}); run inside the stage container")

    settings = get_settings()
    if not check_email_allowed(test_email):
        pytest.skip(
            f"{test_email!r} does not match any ALLOWED_EMAILS pattern; "
            "set CF_TEST_EMAIL to a whitelisted address or add *@example.com to ALLOWED_EMAILS"
        )

    # Verify the backend is reachable before we go further.
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as probe:
            health = await probe.get("/health")
            if health.status_code != 200:
                pytest.skip(f"backend /health returned {health.status_code}")
    except Exception as exc:
        pytest.skip(f"backend unreachable at {BACKEND_URL}: {exc!r}")

    # Each pytest-asyncio test runs in a fresh event loop. The shared
    # AsyncSessionLocal/engine cache connections bound to whichever loop ran
    # first, so we dispose the engine here to force a fresh pool on this loop.
    from app.db import engine as _engine
    await _engine.dispose()

    code = "654321"  # known plaintext, hashed using the same SECRET_KEY the route uses
    async with AsyncSessionLocal() as db:
        db.add(
            OTPCode(
                email=test_email.lower().strip(),
                code_hash=_hash_code(code),
                expires_at=datetime.now(timezone.utc)
                + timedelta(minutes=settings.otp_expiry_minutes),
            )
        )
        await db.commit()

    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.post(
            "/api/auth/verify-otp",
            json={"email": test_email, "code": code},
        )
    if resp.status_code != 200:
        pytest.skip(f"verify-otp failed: {resp.status_code} {resp.text}")
    token = resp.json().get("access_token")
    if not token:
        pytest.skip(f"verify-otp 200 but no access_token: {resp.text}")

    yield token

    # Cleanup: remove the test user (FK cascades sessions/audits/etc.)
    try:
        from sqlalchemy import delete, select

        from app.db import AsyncSessionLocal
        from app.db.models import OTPCode, User

        async with AsyncSessionLocal() as db:
            user = (
                await db.execute(select(User).where(User.email == test_email.lower().strip()))
            ).scalar_one_or_none()
            if user is not None:
                await db.delete(user)
            # Also purge any leftover OTP rows for this email to keep the table tidy.
            await db.execute(delete(OTPCode).where(OTPCode.email == test_email.lower().strip()))
            await db.commit()
    except Exception:
        # Cleanup is best-effort.
        pass


# ---------------------------------------------------------------------------
# Async HTTP client + created session — used by test_authenticated_flow.py
# ---------------------------------------------------------------------------

@pytest_asyncio.fixture
async def async_auth_client(auth_token: str) -> AsyncIterator[httpx.AsyncClient]:
    """Async HTTP client preconfigured with the Bearer token.

    Used by Phase 1 async tests in test_authenticated_flow.py.
    """
    async with httpx.AsyncClient(
        base_url=BACKEND_URL,
        headers={"Authorization": f"Bearer {auth_token}"},
        timeout=30.0,
    ) as client:
        yield client


@pytest_asyncio.fixture
async def async_created_session(
    async_auth_client: httpx.AsyncClient,
) -> AsyncIterator[dict]:
    """A freshly-created session as a dict — used by async Phase 1 tests."""
    resp = await async_auth_client.post(
        "/api/sessions/",
        json={
            "name": f"cf-test-{uuid.uuid4().hex[:8]}",
            "specification": "Print 'hello world' in Python.",
        },
    )
    assert resp.status_code in (200, 201), resp.text
    session = resp.json()

    yield session

    try:
        await async_auth_client.delete(f"/api/sessions/{session['id']}")
    except Exception:
        pass


# ============================================================================
# Phase 2 fixtures — sync HTTP clients + second user (User B) for multitenancy
# ============================================================================
#
# Phase 2 test files (test_sessions_crud.py, test_security.py, test_features.py,
# test_multitenancy.py) declare `auth_client: httpx.Client` (sync) and call it
# without ``await``. They use ``pytest.mark.asyncio`` for the test bodies but
# the HTTP client itself is synchronous.
#
# We provision OTPs synchronously here (run the async DB insert via asyncio.run)
# so these fixtures don't depend on pytest-asyncio's event loop.


def _provision_token_sync(email: str) -> str | None:
    """Insert OTP row + verify, return JWT or None on skip."""
    try:
        from app.api.auth import check_email_allowed
        from app.api.routes.auth import _hash_code
        from app.config import get_settings
        from app.db import AsyncSessionLocal
        from app.db.models import OTPCode
    except Exception:
        return None

    settings = get_settings()
    if not check_email_allowed(email):
        return None

    code = "246813"

    async def _insert():
        from app.db import engine as _engine
        await _engine.dispose()
        async with AsyncSessionLocal() as db:
            db.add(
                OTPCode(
                    email=email.lower().strip(),
                    code_hash=_hash_code(code),
                    expires_at=datetime.now(timezone.utc)
                    + timedelta(minutes=settings.otp_expiry_minutes),
                )
            )
            await db.commit()

    try:
        asyncio.run(_insert())
    except RuntimeError:
        # already in loop — fallback: create new loop
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_insert())
        finally:
            loop.close()

    with httpx.Client(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = client.post("/api/auth/verify-otp", json={"email": email, "code": code})
        if resp.status_code != 200:
            return None
        return resp.json().get("access_token")


@pytest.fixture(scope="session")
def auth_token_sync(test_email: str) -> str:
    tok = _provision_token_sync(test_email)
    if not tok:
        pytest.skip(f"could not provision sync token for {test_email}")
    return tok


@pytest.fixture(scope="session")
def auth_token_b_sync(test_email_b: str) -> str:
    tok = _provision_token_sync(test_email_b)
    if not tok:
        pytest.skip(f"could not provision sync token for {test_email_b}")
    return tok


@pytest.fixture
def auth_client(auth_token_sync: str):
    """SYNC httpx.Client for Phase 2 tests (User A)."""
    with httpx.Client(
        base_url=BACKEND_URL,
        headers={"Authorization": f"Bearer {auth_token_sync}"},
        timeout=30.0,
    ) as client:
        yield client


@pytest.fixture
def auth_client_b(auth_token_b_sync: str):
    """SYNC httpx.Client for User B (multitenancy)."""
    with httpx.Client(
        base_url=BACKEND_URL,
        headers={"Authorization": f"Bearer {auth_token_b_sync}"},
        timeout=30.0,
    ) as client:
        yield client


@pytest.fixture
def sync_auth_client(auth_client):
    """Backwards-compatible alias for tests that asked for ``sync_auth_client``."""
    return auth_client


@pytest.fixture
def created_session(auth_client):
    """A freshly-created session ID (str) — used by Phase 2 sync tests."""
    resp = auth_client.post(
        "/api/sessions/",
        json={
            "name": f"cf-test-{uuid.uuid4().hex[:8]}",
            "specification": "Print 'hello world' in Python.",
        },
    )
    assert resp.status_code in (200, 201), resp.text
    sid = resp.json()["id"]
    yield sid
    # Cleanup: lifecycle tests may have flipped the row to status="running"
    # via direct DB writes, which would make the delete endpoint return 400.
    # Force the status to a deletable value first via a sync DB UPDATE so the
    # DELETE always succeeds and no orphan rows are left behind.
    try:
        from sqlalchemy import create_engine, update as sa_update
        from app.config import get_settings
        from app.db.models import Session as SessionModel

        sync_url = get_settings().sync_database_url
        sync_engine = create_engine(sync_url)
        try:
            with sync_engine.begin() as conn:
                conn.execute(
                    sa_update(SessionModel.__table__)
                    .where(SessionModel.__table__.c.id == sid)
                    .values(status="cancelled")
                )
        finally:
            sync_engine.dispose()
    except Exception:
        # Best-effort: if this fails, fall through to the DELETE anyway.
        pass
    try:
        auth_client.delete(f"/api/sessions/{sid}")
    except Exception:
        pass


def _cleanup_user_sync(email: str) -> None:
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
    except Exception:
        pass


@pytest.fixture(scope="session", autouse=True)
def _cleanup_user_b_after_session(test_email_b: str):
    yield
    _cleanup_user_sync(test_email_b)
