"""Tests for POST /api/sessions/{session_id}/reset.

VR-Reset-Cancel — /reset is a soft restart that:
  * cancels any running orchestrator (status=RUNNING/ENHANCING) so background
    coders/testers stop burning LLM tokens,
  * cancels any pending visual-review timers when in AWAITING_VISUAL_REVIEW,
  * wipes ALL workflow artifacts (code_versions, audits, screenshots,
    visual_review_scores, summary_audits, coder_responses, llm_requests,
    interventions, final_results, enhancement_suggestions,
    workflow_checkpoints),
  * preserves agent_configs (coder/tester selection stays),
  * rewinds the session row to iteration 0 / status='created',
  * does NOT auto-start the workflow (user must click Start),
  * broadcasts a WebSocket ``session_reset`` event.

Marked ``slow`` + ``e2e`` because we manipulate ``Session.status`` directly
via the DB to probe state-transition guards without spinning up real LLM
calls — same pattern as test_session_restart.py / test_workflow_lifecycle.py.
"""
from __future__ import annotations

import asyncio
import uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e, pytest.mark.slow]


# ---------------------------------------------------------------------------
# Direct-DB helpers — mirror test_session_restart.py
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
    """Insert a minimal set of run artifacts so the reset endpoint has
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
    """Return a {table: count} dict for the artifacts touched by /reset."""
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


async def _count_agent_configs(session_id: str) -> int:
    from sqlalchemy import func, select
    from app.db.models import AgentConfig
    async with _db_session() as db:
        n = (await db.execute(
            select(func.count(AgentConfig.id)).where(AgentConfig.session_id == session_id)
        )).scalar() or 0
        return int(n)


async def _get_session_row(session_id: str) -> dict:
    """Read session columns directly so we can assert post-reset state without
    relying on the response payload."""
    from sqlalchemy import select
    from app.db.models import Session as SessionModel
    async with _db_session() as db:
        row = (await db.execute(
            select(SessionModel).where(SessionModel.id == session_id)
        )).scalar_one()
        return {
            "status": row.status.value if hasattr(row.status, "value") else str(row.status),
            "current_iteration": row.current_iteration,
            "enhancement_round": row.enhancement_round,
            "parent_session_id": row.parent_session_id,
        }


# ---------------------------------------------------------------------------
# Endpoint behavior
# ---------------------------------------------------------------------------


async def test_reset_on_running_cancels_orchestrator_and_does_not_resume(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Reset on a RUNNING session must:
      * cancel the orchestrator,
      * drop artifacts,
      * flip status to 'created',
      * NOT auto-start the workflow.
    """
    # Arm a fake orchestrator in the registry so we can prove .stop() is called.
    from app.api.websocket import manager as ws_manager

    class _FakeOrch:
        def __init__(self) -> None:
            self.stopped = False
            self.paused_flag = False

        def stop(self) -> None:
            self.stopped = True
            self.paused_flag = False

        def pause(self) -> None:
            self.paused_flag = True

        def resume(self) -> None:
            self.paused_flag = False

    fake = _FakeOrch()
    await ws_manager.session_manager.register_orchestrator(created_session, fake)

    try:
        await _insert_artifacts(created_session)
        await _set_status(created_session, "running")

        before = await _count_artifacts(created_session)
        assert before["code_versions"] >= 1
        assert before["final_results"] >= 1

        r = auth_client.post(f"/api/sessions/{created_session}/reset")
        assert r.status_code == 200, r.text
        body = r.json()
        # /reset MUST land on 'created' — not 'running'. This is the key
        # difference from /restart.
        assert body.get("status") == "created", body
        assert body.get("current_iteration") == 0
        assert body.get("enhancement_round") == 0

        # Orchestrator was told to stop (this is what /cancel does too).
        assert fake.stopped, "orchestrator.stop() should have been called"

        # Artifacts gone.
        after = await _count_artifacts(created_session)
        assert after["code_versions"] == 0
        assert after["final_results"] == 0
        assert after["enhancement_suggestions"] == 0
        assert after["visual_review_scores"] == 0
        assert after["summary_audits"] == 0
        assert after["audits"] == 0
        assert after["interventions"] == 0
        assert after["llm_requests"] == 0

        # Critical: the workflow does NOT auto-resume. Sample the DB twice
        # with a short gap; the row must stay 'created' the whole time
        # (no background task is allowed to flip it back to 'running').
        await asyncio.sleep(0.3)
        row1 = await _get_session_row(created_session)
        assert row1["status"] == "created", f"workflow auto-resumed: {row1}"
        await asyncio.sleep(0.3)
        row2 = await _get_session_row(created_session)
        assert row2["status"] == "created", f"workflow auto-resumed: {row2}"
    finally:
        await ws_manager.session_manager.unregister_orchestrator(created_session)


async def test_reset_on_awaiting_visual_review_drops_screenshots_and_cancels_timers(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Reset on AWAITING_VISUAL_REVIEW drops screenshots and cancels VR timers."""
    cv_id = await _insert_artifacts(created_session)
    await _set_status(created_session, "awaiting_visual_review")

    # Arm a fake VR timer so we can prove the reset cancels it.
    timer_was_registered = False
    try:
        from app.services.visual_review import _active_timers, _timers_lock  # noqa: SLF001

        async def _noop_runner() -> None:
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                return

        async with _timers_lock:
            _active_timers[str(created_session)] = asyncio.create_task(_noop_runner())
        timer_was_registered = True
    except Exception:
        # If timer plumbing isn't importable, fall through — the DB-side
        # assertions below are still meaningful.
        pass

    r = auth_client.post(f"/api/sessions/{created_session}/reset")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("status") == "created", body

    # Screenshots cascade from code_versions, which the reset removes.
    from sqlalchemy import func, select
    from app.db.models import CodeVersionScreenshot
    async with _db_session() as db:
        n = (await db.execute(
            select(func.count(CodeVersionScreenshot.id))
            .where(CodeVersionScreenshot.code_version_id == cv_id)
        )).scalar() or 0
        assert n == 0, "screenshots from the wiped code_version should be gone"

    # Timer should have been cancelled (popped from the registry).
    if timer_was_registered:
        from app.services.visual_review import _active_timers  # noqa: SLF001
        assert str(created_session) not in _active_timers


async def test_reset_on_completed_resets_cleanly(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Reset on a COMPLETED session is allowed and yields a clean 'created' row,
    ready to be re-run after the user clicks Start.
    """
    await _insert_artifacts(created_session)
    await _set_status(created_session, "completed")

    r = auth_client.post(f"/api/sessions/{created_session}/reset")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("status") == "created", body
    assert body.get("current_iteration") == 0
    assert body.get("enhancement_round") == 0

    after = await _count_artifacts(created_session)
    assert after["final_results"] == 0
    assert after["code_versions"] == 0

    # And it stays 'created' — nothing kicks off in the background.
    await asyncio.sleep(0.2)
    row = await _get_session_row(created_session)
    assert row["status"] == "created"


async def test_reset_emits_session_reset_ws_event(
    auth_client: httpx.Client, created_session: str
) -> None:
    """The reset endpoint must broadcast a ``session_reset`` WS event with
    {session_id, user_id, reset_at}."""
    from app.api.websocket import manager as ws_manager
    recorded: list[tuple[str, dict]] = []

    async def _spy(event_type: str, data: dict) -> None:
        recorded.append((event_type, dict(data)))

    original = ws_manager.session_manager.broadcast
    ws_manager.session_manager.broadcast = _spy  # type: ignore[assignment]
    try:
        await _set_status(created_session, "paused")
        r = auth_client.post(f"/api/sessions/{created_session}/reset")
        assert r.status_code == 200, r.text
    finally:
        ws_manager.session_manager.broadcast = original  # type: ignore[assignment]

    reset_events = [e for e in recorded if e[0] == "session_reset"]
    assert reset_events, (
        f"expected session_reset event, got: {[e[0] for e in recorded]}"
    )
    payload = reset_events[0][1]
    assert payload.get("session_id") == created_session
    assert "reset_at" in payload
    # user_id key must be present (value may be None for API-key auth, but
    # the auth_client fixture is JWT so it should be a string).
    assert "user_id" in payload


async def test_reset_preserves_agent_configs(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Reset must KEEP agent_configs so the coder/tester selection survives."""
    # The session-create default expands to ~8 agent_configs
    # (coder/tester/summarizer/finalizer + 4 enhancers). The exact count
    # depends on which providers are configured in the stage env, but it
    # must be > 0 and must be the same before and after /reset.
    before = await _count_agent_configs(created_session)
    assert before > 0, "session should have default agent_configs"

    await _insert_artifacts(created_session)
    await _set_status(created_session, "completed")

    r = auth_client.post(f"/api/sessions/{created_session}/reset")
    assert r.status_code == 200, r.text

    after = await _count_agent_configs(created_session)
    assert after == before, (
        f"agent_configs count changed across reset: {before} -> {after}"
    )


async def test_reset_does_not_break_restart_flow(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Regression guard: /restart (VR-11) still works after the shared-helper
    refactor — drops artifacts and flips to 'running'."""
    await _insert_artifacts(created_session)
    await _set_status(created_session, "completed")

    r = auth_client.post(f"/api/sessions/{created_session}/restart")
    assert r.status_code == 200, r.text
    body = r.json()
    # /restart sets status='running' (test env may quickly flip to failed/
    # completed if no real LLM creds, but it must NOT be 'created').
    assert body.get("status") in ("running", "failed", "completed"), body
    assert body.get("status") != "created"
    assert body.get("current_iteration") == 0

    after = await _count_artifacts(created_session)
    assert after["final_results"] == 0
    assert after["enhancement_suggestions"] == 0

    # Cleanup so the conftest teardown can DELETE the session cleanly.
    auth_client.post(f"/api/sessions/{created_session}/cancel")
