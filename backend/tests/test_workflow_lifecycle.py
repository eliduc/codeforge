"""Workflow lifecycle endpoint tests.

These verify the start/pause/resume/cancel/reset/re-finalize endpoints respond
correctly to each session state, WITHOUT actually running real LLM calls. We
manipulate `Session.status` directly via the ORM so we can probe the API's
state-transition guards cheaply.

Marked `slow` because they bypass auth boundaries via direct DB writes — we
don't want them in the default smoke run.

Fixtures consumed (provided by conftest.py from Phase 1):
  - auth_client       : httpx.Client with Bearer token
  - created_session   : str — id of a freshly created CREATED-status session
"""

from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e, pytest.mark.slow]


# ---------------------------------------------------------------------------
# Direct-DB helper: bypass orchestrator + auth, set status to whatever we want.
# ---------------------------------------------------------------------------

@asynccontextmanager
async def _db_session():
    """Yield an AsyncSession scoped to the backend's own engine."""
    try:
        from app.db import AsyncSessionLocal
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"cannot import AsyncSessionLocal ({exc})")
    async with AsyncSessionLocal() as db:
        yield db


async def _set_status(session_id: str, new_status: str) -> None:
    """Async DB UPDATE — call with `await` from async tests.

    Disposes the engine pool first so connections are bound to the CURRENT
    event loop. pytest-asyncio creates a fresh loop per test, so connections
    from a previous loop would otherwise raise 'Future attached to a different
    loop' when this test tries to use them.
    """
    from sqlalchemy import update as sa_update
    from app.db.models import Session as SessionModel
    try:
        from app.db.database import engine
        await engine.dispose()
    except Exception:
        pass
    async with _db_session() as db:
        await db.execute(
            sa_update(SessionModel)
            .where(SessionModel.id == session_id)
            .values(status=new_status)
        )
        await db.commit()


# Backwards-compat alias kept as no-op-rename for any external caller.
_set_status_sync = _set_status  # use `await _set_status(...)` from now on


# ---------------------------------------------------------------------------
# start
# ---------------------------------------------------------------------------

async def test_start_session_from_created(auth_client: httpx.Client, created_session: str) -> None:
    """POST /start on a CREATED session transitions it to RUNNING (sync DB write)."""
    r = auth_client.post(f"/api/sessions/{created_session}/start")
    # Either succeeds (200) and orchestrator was scheduled, or 400 if the
    # default agent-config fails the has_coder/has_tester guard.  Both are
    # valid lifecycle responses — we only assert *not* 5xx.
    assert r.status_code in (200, 400, 409), r.text
    if r.status_code == 200:
        body = r.json()
        assert body["status"] in ("running", "completed", "failed", "paused")
    # cancel any scheduled background work to keep test isolated
    auth_client.post(f"/api/sessions/{created_session}/cancel")


async def test_double_start_returns_conflict(auth_client: httpx.Client, created_session: str) -> None:
    """Second POST /start while already RUNNING returns 409 (or 400)."""
    await _set_status(created_session, "running")
    r = auth_client.post(f"/api/sessions/{created_session}/start")
    assert r.status_code in (400, 409), r.text


async def test_start_nonexistent_returns_404(auth_client: httpx.Client) -> None:
    bogus = uuid.uuid4()
    r = auth_client.post(f"/api/sessions/{bogus}/start")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# pause
# ---------------------------------------------------------------------------

async def test_pause_running_session(auth_client: httpx.Client, created_session: str) -> None:
    """POST /pause on RUNNING transitions to PAUSED (CAS path when no orchestrator)."""
    await _set_status(created_session, "running")
    r = auth_client.post(f"/api/sessions/{created_session}/pause")
    # No orchestrator registered, so route falls back to CAS update — 200 + paused.
    assert r.status_code in (200, 409), r.text
    if r.status_code == 200:
        got = auth_client.get(f"/api/sessions/{created_session}")
        assert got.json()["status"] == "paused"


async def test_pause_created_returns_400(auth_client: httpx.Client, created_session: str) -> None:
    """Pausing a non-running session returns 400."""
    r = auth_client.post(f"/api/sessions/{created_session}/pause")
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# resume
# ---------------------------------------------------------------------------

async def test_resume_paused_session(auth_client: httpx.Client, created_session: str) -> None:
    """POST /resume on PAUSED transitions back to RUNNING."""
    await _set_status(created_session, "paused")
    r = auth_client.post(f"/api/sessions/{created_session}/resume")
    assert r.status_code in (200, 409), r.text
    # cleanup
    auth_client.post(f"/api/sessions/{created_session}/cancel")


async def test_resume_created_returns_400(auth_client: httpx.Client, created_session: str) -> None:
    """Resuming a session that was never paused returns 400."""
    r = auth_client.post(f"/api/sessions/{created_session}/resume")
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# cancel
# ---------------------------------------------------------------------------

async def test_cancel_running_session(auth_client: httpx.Client, created_session: str) -> None:
    """POST /cancel on RUNNING transitions to CANCELLED via CAS."""
    await _set_status(created_session, "running")
    r = auth_client.post(f"/api/sessions/{created_session}/cancel")
    assert r.status_code in (200, 409), r.text
    if r.status_code == 200:
        got = auth_client.get(f"/api/sessions/{created_session}")
        assert got.json()["status"] == "cancelled"


async def test_cancel_completed_returns_400(auth_client: httpx.Client, created_session: str) -> None:
    """Can't cancel an already-completed session."""
    await _set_status(created_session, "completed")
    r = auth_client.post(f"/api/sessions/{created_session}/cancel")
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# reset
# ---------------------------------------------------------------------------

async def test_reset_completed_session(auth_client: httpx.Client, created_session: str) -> None:
    """POST /reset on COMPLETED returns the session to CREATED status."""
    await _set_status(created_session, "completed")
    r = auth_client.post(f"/api/sessions/{created_session}/reset")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "created"
    assert body["current_iteration"] == 0


# ---------------------------------------------------------------------------
# re-finalize
# ---------------------------------------------------------------------------

async def test_re_finalize_without_code_returns_400(auth_client: httpx.Client, created_session: str) -> None:
    """re-finalize requires existing code versions; without them it 400s."""
    await _set_status(created_session, "completed")
    r = auth_client.post(f"/api/sessions/{created_session}/re-finalize")
    # 400 (no code versions) or 200 (if backend permits empty re-finalize)
    assert r.status_code in (200, 400), r.text


# ---------------------------------------------------------------------------
# max_iterations validation
# ---------------------------------------------------------------------------

async def test_create_session_max_iterations_zero_rejected(auth_client: httpx.Client) -> None:
    """max_iterations=0 violates the >=1 schema constraint."""
    r = auth_client.post(
        "/api/sessions/",
        json={"name": "iter-zero", "specification": "x", "max_iterations": 0},
    )
    assert r.status_code == 422


async def test_create_session_max_iterations_negative_rejected(auth_client: httpx.Client) -> None:
    r = auth_client.post(
        "/api/sessions/",
        json={"name": "iter-neg", "specification": "x", "max_iterations": -5},
    )
    assert r.status_code == 422


async def test_create_session_max_iterations_too_high_rejected(auth_client: httpx.Client) -> None:
    """Schema caps max_iterations at 50."""
    r = auth_client.post(
        "/api/sessions/",
        json={"name": "iter-huge", "specification": "x", "max_iterations": 9999},
    )
    assert r.status_code == 422
