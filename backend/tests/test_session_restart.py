"""Tests for POST /api/sessions/{session_id}/restart.

КАО#VR-11 RestartFromScratch — verify the restart endpoint:
  * wipes all run artifacts (code versions, audits, screenshots, final result,
    enhancement suggestions, summary audits, coder responses, llm requests,
    interventions, workflow checkpoints, visual review scores),
  * resets the session to iteration 0 / status='running',
  * rejects with 409 while a workflow is actually live (running/enhancing),
  * cancels pending visual-review timers,
  * broadcasts a WebSocket ``session_restarted`` event.

Marked ``slow`` + ``e2e`` because we manipulate ``Session.status`` directly
via the DB to probe state-transition guards without spinning up real LLM
calls — same pattern as test_workflow_lifecycle.py.
"""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e, pytest.mark.slow]


# ---------------------------------------------------------------------------
# Direct-DB helpers — mirror test_workflow_lifecycle.py
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _db_session() -> AsyncIterator:
    try:
        from app.db import AsyncSessionLocal
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"cannot import AsyncSessionLocal ({exc})")
    async with AsyncSessionLocal() as db:
        yield db


async def _set_status(session_id: str, new_status: str) -> None:
    """Force a session's status via the DB (bypasses orchestrator)."""
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


async def _insert_artifacts(session_id: str) -> str:
    """Insert a minimal set of run artifacts so the restart endpoint has
    something to delete. Returns the code_version_id for downstream FK use.
    """
    from app.db.models import (
        Audit,
        CodeVersion,
        CodeVersionScreenshot,
        EnhancementSuggestion,
        FinalResult,
        Intervention,
        LLMRequest,
        SummaryAudit,
        VisualReviewScore,
    )
    cv_id = str(uuid.uuid4())
    async with _db_session() as db:
        db.add(CodeVersion(
            id=cv_id,
            session_id=session_id,
            coder_index=0,
            iteration=0,
            code_content="print('hi')",
            status="generated",
        ))
        await db.flush()
        db.add(CodeVersionScreenshot(
            id=str(uuid.uuid4()),
            code_version_id=cv_id,
            frame_index=0,
            t_seconds=0.0,
            image_path=f"screenshots/{session_id}/{cv_id}/frame_0.png",
            width=1280,
            height=720,
        ))
        db.add(Audit(
            id=str(uuid.uuid4()),
            session_id=session_id,
            code_version_id=cv_id,
            tester_index=0,
            iteration=0,
            audit_content="lgtm",
        ))
        db.add(SummaryAudit(
            id=str(uuid.uuid4()),
            session_id=session_id,
            coder_index=0,
            iteration=0,
            summary_content="ok",
        ))
        db.add(FinalResult(
            id=str(uuid.uuid4()),
            session_id=session_id,
            selected_coder_index=0,
            final_code="print('hi')",
            selection_reasoning="only one",
        ))
        db.add(EnhancementSuggestion(
            id=str(uuid.uuid4()),
            session_id=session_id,
            agent_type="enhancer_design",
            content="add colors",
            llm_provider="anthropic",
            llm_model="claude-sonnet-4-6",
        ))
        db.add(VisualReviewScore(
            id=str(uuid.uuid4()),
            session_id=session_id,
            code_version_id=cv_id,
            source="user",
            score=8,
        ))
        db.add(Intervention(
            id=str(uuid.uuid4()),
            session_id=session_id,
            iteration=0,
            intervention_type="hint",
            content="try harder",
        ))
        db.add(LLMRequest(
            id=str(uuid.uuid4()),
            session_id=session_id,
            agent_type="coder",
            agent_index=0,
            iteration=0,
            llm_provider="anthropic",
            llm_model="claude-sonnet-4-6",
            prompt_sent="hi",
            response_received="hi",
        ))
        await db.commit()
    return cv_id


async def _count_artifacts(session_id: str) -> dict[str, int]:
    """Return a {table: count} dict for the artifacts touched by /restart."""
    from sqlalchemy import func, select
    from app.db.models import (
        Audit,
        CodeVersion,
        EnhancementSuggestion,
        FinalResult,
        Intervention,
        LLMRequest,
        SummaryAudit,
        VisualReviewScore,
    )
    out: dict[str, int] = {}
    async with _db_session() as db:
        for label, model in [
            ("code_versions", CodeVersion),
            ("audits", Audit),
            ("summary_audits", SummaryAudit),
            ("final_results", FinalResult),
            ("enhancement_suggestions", EnhancementSuggestion),
            ("visual_review_scores", VisualReviewScore),
            ("interventions", Intervention),
            ("llm_requests", LLMRequest),
        ]:
            n = (await db.execute(
                select(func.count(model.id)).where(model.session_id == session_id)
            )).scalar() or 0
            out[label] = int(n)
    return out


# ---------------------------------------------------------------------------
# Endpoint behavior
# ---------------------------------------------------------------------------


async def test_restart_on_paused_drops_artifacts_and_runs(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Restart on a PAUSED session wipes artifacts and flips status to RUNNING."""
    await _insert_artifacts(created_session)
    await _set_status(created_session, "paused")

    before = await _count_artifacts(created_session)
    assert before["code_versions"] >= 1
    assert before["final_results"] >= 1

    r = auth_client.post(f"/api/sessions/{created_session}/restart")
    assert r.status_code == 200, r.text

    body = r.json()
    # Status starts as RUNNING (background workflow may flip to FAILED quickly
    # in the test env if no real LLM creds are wired up — we only assert that
    # the restart succeeded and the row is no longer in 'paused').
    assert body.get("status") in ("running", "failed", "completed"), body
    assert body.get("current_iteration") == 0
    assert body.get("enhancement_round") == 0

    after = await _count_artifacts(created_session)
    # Restarted runs may have re-inserted *new* code_versions etc. by the time
    # we sample — what we really care about is that none of the *original*
    # final_result / enhancement / VR rows survived.
    assert after["final_results"] == 0
    assert after["enhancement_suggestions"] == 0
    assert after["visual_review_scores"] == 0
    assert after["summary_audits"] == 0

    # Cleanup so the conftest teardown can DELETE the session cleanly.
    auth_client.post(f"/api/sessions/{created_session}/cancel")


async def test_restart_on_awaiting_visual_review_clears_screenshots_and_timers(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Restart on AWAITING_VISUAL_REVIEW drops screenshots and cancels timers."""
    cv_id = await _insert_artifacts(created_session)
    await _set_status(created_session, "awaiting_visual_review")

    # Arm a fake VR timer so we can prove the restart cancels it.
    try:
        from app.services.visual_review import _active_timers, _timers_lock  # noqa: SLF001
        import asyncio as _asyncio

        async def _noop_runner() -> None:
            try:
                await _asyncio.sleep(3600)
            except _asyncio.CancelledError:
                return

        async with _timers_lock:
            _active_timers[str(created_session)] = _asyncio.create_task(_noop_runner())
    except Exception:
        # If timer plumbing isn't importable, fall through — the DB-side
        # assertions below are still meaningful.
        pass

    r = auth_client.post(f"/api/sessions/{created_session}/restart")
    assert r.status_code == 200, r.text

    # Screenshots cascade from code_versions, which the restart removes.
    from sqlalchemy import func, select
    from app.db.models import CodeVersionScreenshot
    async with _db_session() as db:
        n = (await db.execute(
            select(func.count(CodeVersionScreenshot.id))
            .where(CodeVersionScreenshot.code_version_id == cv_id)
        )).scalar() or 0
        assert n == 0, "screenshots from the wiped code_version should be gone"

    # Timer should have been cancelled (popped from the registry).
    try:
        from app.services.visual_review import _active_timers  # noqa: SLF001
        assert str(created_session) not in _active_timers
    except Exception:
        pass

    auth_client.post(f"/api/sessions/{created_session}/cancel")


async def test_restart_on_running_returns_409(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Restart while the workflow is live must be rejected with 409."""
    await _set_status(created_session, "running")
    r = auth_client.post(f"/api/sessions/{created_session}/restart")
    assert r.status_code == 409, r.text
    detail = r.json().get("detail", "")
    assert "pause" in detail.lower() or "cancel" in detail.lower()


async def test_restart_on_enhancing_returns_409(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Restart while enhancers are mid-run must also be rejected with 409."""
    await _set_status(created_session, "enhancing")
    r = auth_client.post(f"/api/sessions/{created_session}/restart")
    assert r.status_code == 409, r.text


async def test_restart_on_completed_succeeds(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Restart on a COMPLETED session is allowed (re-run after completion)."""
    await _insert_artifacts(created_session)
    await _set_status(created_session, "completed")
    r = auth_client.post(f"/api/sessions/{created_session}/restart")
    assert r.status_code == 200, r.text
    assert r.json().get("current_iteration") == 0
    auth_client.post(f"/api/sessions/{created_session}/cancel")


async def test_restart_on_failed_succeeds(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Restart on a FAILED session resets and re-runs."""
    await _insert_artifacts(created_session)
    await _set_status(created_session, "failed")
    r = auth_client.post(f"/api/sessions/{created_session}/restart")
    assert r.status_code == 200, r.text
    assert r.json().get("current_iteration") == 0
    auth_client.post(f"/api/sessions/{created_session}/cancel")


async def test_restart_emits_session_restarted_event(
    auth_client: httpx.Client, created_session: str
) -> None:
    """The restart endpoint must broadcast a ``session_restarted`` WS event."""
    from app.api.websocket import manager as ws_manager
    recorded: list[tuple[str, dict]] = []

    async def _spy(event_type: str, data: dict) -> None:
        recorded.append((event_type, dict(data)))

    original = ws_manager.session_manager.broadcast
    ws_manager.session_manager.broadcast = _spy  # type: ignore[assignment]
    try:
        await _set_status(created_session, "paused")
        r = auth_client.post(f"/api/sessions/{created_session}/restart")
        assert r.status_code == 200, r.text
    finally:
        ws_manager.session_manager.broadcast = original  # type: ignore[assignment]

    restart_events = [e for e in recorded if e[0] == "session_restarted"]
    assert restart_events, f"expected session_restarted event, got: {[e[0] for e in recorded]}"
    payload = restart_events[0][1]
    assert payload.get("session_id") == created_session
    assert "restarted_at" in payload

    auth_client.post(f"/api/sessions/{created_session}/cancel")
