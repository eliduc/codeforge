"""Unit tests for the Wave-3 vision-LLM auto-ranking.

These tests are stand-alone — no DB, no network. They mock:

  * The Anthropic vision call (``_call_anthropic_vision``) so we never
    hit the real API.
  * The AsyncSession's ``execute()`` method to return scripted result
    objects matching the queries fired by ``rank_with_vision_llm``.
  * The on-disk PNG reads (``_read_and_encode``) so we don't need real
    screenshot files.

Coverage:

  * ``rank_with_vision_llm`` happy path — two candidates, mock returns
    A=8 / B=3 → two persisted ``VisualReviewScore`` rows in source order.
  * JSON parsing tolerance — fenced JSON / clamped scores.
  * 1-hour timer scheduling — verifies the task lands in the registry,
    can be cancelled, and re-arming replaces the prior task.
  * Auto-resume threshold — spread >= threshold fires ``on_resume`` and
    emits ``visual_review_auto_resumed_by_vision``.
  * No auto-resume when spread below threshold.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Iterable, Sequence
from unittest.mock import AsyncMock, patch

import pytest

from app.services import visual_review_vision as vrv
from app.services.visual_review_vision import (
    VisionRankingResult,
    _clamp_score,
    _parse_ranking_json,
    _pick_representative_frames,
    cancel_vision_timer,
    rank_with_vision_llm,
    schedule_vision_ranker,
)


# ---------------------------------------------------------------------------
# Tiny test doubles (same pattern as test_visual_review_finalizer.py)
# ---------------------------------------------------------------------------


@dataclass
class _FakeSession:
    id: str = "session-1"
    specification: str = "Render a glowing red circle that pulses."


@dataclass
class _FakeCodeVersion:
    id: str
    iteration: int = 0
    coder_index: int = 0


@dataclass
class _FakeScreenshot:
    code_version_id: str
    frame_index: int
    t_seconds: float = 0.0
    image_path: str = ""
    width: int = 1280
    height: int = 720


class _ScalarsResult:
    def __init__(self, items: list[Any]) -> None:
        self._items = list(items)

    def all(self) -> list[Any]:
        return self._items


class _ResultWrapper:
    """Mimic SQLAlchemy ``Result`` — supports both scalar_one_or_none(),
    scalars().all(), and .first()."""

    def __init__(
        self,
        *,
        scalar: Any | None = None,
        scalars: list[Any] | None = None,
        first: Any | None = None,
    ):
        self._scalar = scalar
        self._scalars = scalars or []
        self._first = first

    def scalar_one_or_none(self) -> Any:
        return self._scalar

    def scalars(self) -> _ScalarsResult:
        return _ScalarsResult(self._scalars)

    def first(self) -> Any:
        return self._first


def _scripted_db(results: Sequence[_ResultWrapper]) -> Any:
    """Build an AsyncMock db whose execute() returns the scripted results."""
    db = AsyncMock()
    state = {"i": 0}
    seq = list(results)

    async def _execute(_stmt: Any) -> _ResultWrapper:
        i = state["i"]
        state["i"] += 1
        if i >= len(seq):
            return _ResultWrapper()
        return seq[i]

    db.execute = _execute
    return db


# ---------------------------------------------------------------------------
# Helper: build a result sequence matching rank_with_vision_llm's queries.
#
# rank_with_vision_llm fires queries in this order:
#   1. select(SessionModel) WHERE id=...                  -> .scalar_one_or_none()
#   2. select(max(CodeVersion.iteration)) WHERE ...       -> .scalar_one_or_none()
#   3. select(CodeVersion) WHERE iteration=max            -> .scalars().all()
#   4..N. select(CodeVersionScreenshot) WHERE cv=X        -> .scalars().all() (one per cv)
# ---------------------------------------------------------------------------


def _build_rank_db_results(
    session: _FakeSession,
    max_iter: int,
    cvs: list[_FakeCodeVersion],
    screenshots_by_cv: dict[str, list[_FakeScreenshot]],
) -> list[_ResultWrapper]:
    results: list[_ResultWrapper] = [
        _ResultWrapper(scalar=session),
        _ResultWrapper(scalar=max_iter),
        _ResultWrapper(scalars=list(cvs)),
    ]
    for cv in cvs:
        shots = screenshots_by_cv.get(cv.id, [])
        results.append(_ResultWrapper(scalars=list(shots)))
    return results


# ===========================================================================
# rank_with_vision_llm — happy path
# ===========================================================================


@pytest.mark.asyncio
async def test_rank_with_vision_llm_two_candidates_persists_scores() -> None:
    """Two candidates, mock returns A=8 / B=3 → both scores in result."""
    cv_a = "11111111-1111-1111-1111-111111111111"
    cv_b = "22222222-2222-2222-2222-222222222222"

    cvs = [
        _FakeCodeVersion(id=cv_a, iteration=2, coder_index=0),
        _FakeCodeVersion(id=cv_b, iteration=2, coder_index=1),
    ]
    shots = {
        cv_a: [_FakeScreenshot(cv_a, 0, image_path=f"screenshots/s/{cv_a}/frame_0.png")],
        cv_b: [_FakeScreenshot(cv_b, 0, image_path=f"screenshots/s/{cv_b}/frame_0.png")],
    }
    db = _scripted_db(
        _build_rank_db_results(_FakeSession(id="s"), 2, cvs, shots)
    )

    fake_llm_json = (
        '{"ranking": ['
        f'{{"code_version_id": "{cv_a}", "score_0_10": 8, "reasoning": "clean render"}}, '
        f'{{"code_version_id": "{cv_b}", "score_0_10": 3, "reasoning": "broken layout"}}'
        ']}'
    )

    async def _fake_encode(path: str) -> str | None:
        return "ZmFrZS1wbmctYnl0ZXM="  # b64("fake-png-bytes")

    async def _fake_vision(*_args: Any, **_kwargs: Any) -> tuple[str, str | None]:
        return fake_llm_json, None

    with patch.object(vrv, "_read_and_encode", side_effect=lambda p: "ZmFrZQ=="), \
            patch.object(vrv, "_call_anthropic_vision", side_effect=_fake_vision):
        result = await rank_with_vision_llm(db, "s")

    assert result.error is None
    assert len(result.scores) == 2
    by_cv = {row.code_version_id: row for row in result.scores}
    assert by_cv[cv_a].score == 8
    assert by_cv[cv_b].score == 3
    assert all(row.source == "vision_llm" for row in result.scores)
    assert all(row.submitted_by is None for row in result.scores)
    assert result.spread == pytest.approx(5.0)
    assert result.raw_reasoning[cv_a] == "clean render"
    assert result.raw_reasoning[cv_b] == "broken layout"


@pytest.mark.asyncio
async def test_rank_with_vision_llm_ignores_invalid_code_version_ids() -> None:
    """If the model hallucinates an id we never asked about, drop it."""
    cv_a = "11111111-1111-1111-1111-111111111111"
    cvs = [_FakeCodeVersion(id=cv_a, iteration=0, coder_index=0)]
    shots = {cv_a: [_FakeScreenshot(cv_a, 0, image_path="x.png")]}
    db = _scripted_db(_build_rank_db_results(_FakeSession(id="s"), 0, cvs, shots))

    bogus = "99999999-9999-9999-9999-999999999999"
    fake_json = (
        '{"ranking": ['
        f'{{"code_version_id": "{cv_a}", "score_0_10": 9}}, '
        f'{{"code_version_id": "{bogus}", "score_0_10": 1}}'
        ']}'
    )

    async def _fake_vision(*_a: Any, **_kw: Any) -> tuple[str, str | None]:
        return fake_json, None

    with patch.object(vrv, "_read_and_encode", side_effect=lambda p: "ZmFrZQ=="), \
            patch.object(vrv, "_call_anthropic_vision", side_effect=_fake_vision):
        result = await rank_with_vision_llm(db, "s")

    assert result.error is None
    assert len(result.scores) == 1
    assert result.scores[0].code_version_id == cv_a
    assert result.scores[0].score == 9


@pytest.mark.asyncio
async def test_rank_with_vision_llm_no_screenshots_returns_error() -> None:
    """No screenshots → error, no scores."""
    cv_a = "11111111-1111-1111-1111-111111111111"
    cvs = [_FakeCodeVersion(id=cv_a)]
    db = _scripted_db(
        _build_rank_db_results(_FakeSession(id="s"), 0, cvs, {cv_a: []})
    )
    result = await rank_with_vision_llm(db, "s")
    assert result.scores == []
    assert result.error is not None
    assert "screenshot" in result.error.lower()


@pytest.mark.asyncio
async def test_rank_with_vision_llm_no_session_returns_error() -> None:
    db = _scripted_db([_ResultWrapper(scalar=None)])
    result = await rank_with_vision_llm(db, "missing")
    assert result.scores == []
    assert result.error is not None
    assert "not found" in result.error


@pytest.mark.asyncio
async def test_rank_with_vision_llm_clamps_out_of_range_scores() -> None:
    """Model returning 15 / -3 → clamped to 10 / 0."""
    cv_a = "aaaa1111-1111-1111-1111-111111111111"
    cv_b = "bbbb2222-2222-2222-2222-222222222222"
    cvs = [_FakeCodeVersion(id=cv_a), _FakeCodeVersion(id=cv_b)]
    shots = {
        cv_a: [_FakeScreenshot(cv_a, 0, image_path="a.png")],
        cv_b: [_FakeScreenshot(cv_b, 0, image_path="b.png")],
    }
    db = _scripted_db(_build_rank_db_results(_FakeSession(id="s"), 0, cvs, shots))
    fake_json = (
        '{"ranking": ['
        f'{{"code_version_id": "{cv_a}", "score_0_10": 15}}, '
        f'{{"code_version_id": "{cv_b}", "score_0_10": -3}}'
        ']}'
    )

    async def _fake_vision(*_a: Any, **_kw: Any) -> tuple[str, str | None]:
        return fake_json, None

    with patch.object(vrv, "_read_and_encode", side_effect=lambda p: "ZmFrZQ=="), \
            patch.object(vrv, "_call_anthropic_vision", side_effect=_fake_vision):
        result = await rank_with_vision_llm(db, "s")
    by_cv = {r.code_version_id: r.score for r in result.scores}
    assert by_cv[cv_a] == 10
    assert by_cv[cv_b] == 0


# ===========================================================================
# JSON parsing tolerance
# ===========================================================================


def test_parse_ranking_json_plain() -> None:
    out = _parse_ranking_json('{"ranking": [{"code_version_id": "x", "score_0_10": 7}]}')
    assert out == [{"code_version_id": "x", "score_0_10": 7}]


def test_parse_ranking_json_with_markdown_fence() -> None:
    raw = '```json\n{"ranking": [{"code_version_id": "x", "score_0_10": 4}]}\n```'
    out = _parse_ranking_json(raw)
    assert out[0]["score_0_10"] == 4


def test_parse_ranking_json_with_leading_prose() -> None:
    raw = (
        "Here is my ranking:\n"
        '{"ranking": [{"code_version_id": "x", "score_0_10": 2}]}\n'
        "Thanks!"
    )
    out = _parse_ranking_json(raw)
    assert out[0]["code_version_id"] == "x"


def test_parse_ranking_json_empty_raises() -> None:
    with pytest.raises(ValueError):
        _parse_ranking_json("")


def test_parse_ranking_json_missing_ranking_key_raises() -> None:
    with pytest.raises(ValueError):
        _parse_ranking_json('{"foo": []}')


def test_clamp_score_handles_floats_strings_and_nones() -> None:
    assert _clamp_score(7.6) == 8
    assert _clamp_score("4") == 4
    assert _clamp_score(None) == 0
    assert _clamp_score(100) == 10
    assert _clamp_score(-1.0) == 0


# ===========================================================================
# Frame picker
# ===========================================================================


def test_pick_representative_frames_first_middle_last() -> None:
    shots = [_FakeScreenshot("cv", i) for i in range(5)]
    picked = _pick_representative_frames(shots, n=3)
    assert [s.frame_index for s in picked] == [0, 2, 4]


def test_pick_representative_frames_handles_fewer_than_n() -> None:
    shots = [_FakeScreenshot("cv", 0), _FakeScreenshot("cv", 1)]
    picked = _pick_representative_frames(shots, n=3)
    assert [s.frame_index for s in picked] == [0, 1]


def test_pick_representative_frames_empty() -> None:
    assert _pick_representative_frames([], n=3) == []


# ===========================================================================
# 1h timer scheduling
# ===========================================================================


@pytest.mark.asyncio
async def test_schedule_vision_ranker_registers_task_and_can_cancel() -> None:
    """schedule_vision_ranker lands a task in the registry; cancel removes it."""
    # Long delay — we never want the runner body to actually fire.
    await schedule_vision_ranker("sess-A", delay_sec=3600.0)
    assert "sess-A" in vrv._vision_timers
    task = vrv._vision_timers["sess-A"]
    assert not task.done()

    await cancel_vision_timer("sess-A")
    assert "sess-A" not in vrv._vision_timers
    assert task.done()


@pytest.mark.asyncio
async def test_schedule_vision_ranker_replaces_prior_timer() -> None:
    """Calling schedule twice for the same session cancels the first task."""
    await schedule_vision_ranker("sess-B", delay_sec=3600.0)
    first = vrv._vision_timers["sess-B"]
    await schedule_vision_ranker("sess-B", delay_sec=3600.0)
    second = vrv._vision_timers["sess-B"]

    assert first is not second
    # First should have been cancelled.
    try:
        await asyncio.wait_for(first, timeout=0.5)
    except (asyncio.CancelledError, Exception):
        pass
    assert first.done()

    await cancel_vision_timer("sess-B")


# ===========================================================================
# Auto-resume threshold logic
# ===========================================================================


@pytest.mark.asyncio
async def test_auto_resume_fires_when_spread_above_threshold() -> None:
    """spread=5 >= threshold=3 → on_resume is called and the WS event emitted."""
    cv_a = "aaaa1111-aaaa-1111-1111-111111111111"
    cv_b = "bbbb2222-bbbb-2222-2222-222222222222"
    fake_result = VisionRankingResult(
        scores=[
            vrv.VisualReviewScore(
                session_id="sess-AR1", code_version_id=cv_a,
                score=9, source="vision_llm", submitted_by=None,
            ),
            vrv.VisualReviewScore(
                session_id="sess-AR1", code_version_id=cv_b,
                score=4, source="vision_llm", submitted_by=None,
            ),
        ],
        spread=5.0,
        raw_reasoning={cv_a: "best", cv_b: "worst"},
        model="claude-opus-4-5",
        error=None,
    )

    resumed: list[tuple[str, str]] = []
    events: list[tuple[str, dict]] = []

    async def _on_resume(sid: str, reason: str) -> None:
        resumed.append((sid, reason))

    async def _emit(name: str, payload: dict) -> None:
        events.append((name, payload))

    # Patch the AsyncSessionLocal-based runner to use a scripted DB and
    # the rank fn to return our fake result.
    from contextlib import asynccontextmanager

    class _FakeDB:
        async def execute(self, _stmt: Any) -> _ResultWrapper:
            # Two queries are run by _run_vision_ranker_once before it
            # calls rank_with_vision_llm:
            #   1. select(SessionModel.status) -> scalar_one_or_none = AWAITING_VISUAL_REVIEW
            #   2. select(VisualReviewScore.id) WHERE source='user' .first() -> None
            idx = self._idx
            self._idx += 1
            from app.db.models import SessionStatus
            if idx == 0:
                return _ResultWrapper(scalar=SessionStatus.AWAITING_VISUAL_REVIEW)
            return _ResultWrapper(first=None)

        def __init__(self) -> None:
            self._idx = 0

        def add(self, _row: Any) -> None:
            pass

        async def commit(self) -> None:
            pass

        async def rollback(self) -> None:
            pass

    @asynccontextmanager
    async def _fake_session_local():
        yield _FakeDB()

    with patch.object(vrv, "AsyncSessionLocal", _fake_session_local), \
            patch.object(vrv, "rank_with_vision_llm",
                         new=AsyncMock(return_value=fake_result)):
        await vrv._run_vision_ranker_once(
            session_id="sess-AR1",
            event_callback=_emit,
            on_resume=_on_resume,
            auto_resume_threshold=3.0,
            model="claude-opus-4-5",
        )

    assert resumed == [("sess-AR1", "vision_llm_auto")]
    names = [e[0] for e in events]
    assert "vision_llm_scored" in names
    assert "visual_review_auto_resumed_by_vision" in names


@pytest.mark.asyncio
async def test_auto_resume_does_not_fire_when_spread_below_threshold() -> None:
    """spread=2 < threshold=3 → no on_resume, no auto-resume WS event."""
    cv_a = "aaaa1111-aaaa-1111-1111-111111111111"
    cv_b = "bbbb2222-bbbb-2222-2222-222222222222"
    fake_result = VisionRankingResult(
        scores=[
            vrv.VisualReviewScore(
                session_id="sess-AR2", code_version_id=cv_a,
                score=6, source="vision_llm", submitted_by=None,
            ),
            vrv.VisualReviewScore(
                session_id="sess-AR2", code_version_id=cv_b,
                score=4, source="vision_llm", submitted_by=None,
            ),
        ],
        spread=2.0,
        raw_reasoning={},
        model="claude-opus-4-5",
        error=None,
    )

    resumed: list[tuple[str, str]] = []
    events: list[tuple[str, dict]] = []

    async def _on_resume(sid: str, reason: str) -> None:
        resumed.append((sid, reason))

    async def _emit(name: str, payload: dict) -> None:
        events.append((name, payload))

    from contextlib import asynccontextmanager

    class _FakeDB:
        async def execute(self, _stmt: Any) -> _ResultWrapper:
            from app.db.models import SessionStatus
            idx = self._idx
            self._idx += 1
            if idx == 0:
                return _ResultWrapper(scalar=SessionStatus.AWAITING_VISUAL_REVIEW)
            return _ResultWrapper(first=None)

        def __init__(self) -> None:
            self._idx = 0

        def add(self, _row: Any) -> None:
            pass

        async def commit(self) -> None:
            pass

        async def rollback(self) -> None:
            pass

    @asynccontextmanager
    async def _fake_session_local():
        yield _FakeDB()

    with patch.object(vrv, "AsyncSessionLocal", _fake_session_local), \
            patch.object(vrv, "rank_with_vision_llm",
                         new=AsyncMock(return_value=fake_result)):
        await vrv._run_vision_ranker_once(
            session_id="sess-AR2",
            event_callback=_emit,
            on_resume=_on_resume,
            auto_resume_threshold=3.0,
            model="claude-opus-4-5",
        )

    assert resumed == []  # critically: no auto-resume
    names = [e[0] for e in events]
    assert "vision_llm_scored" in names
    assert "visual_review_auto_resumed_by_vision" not in names


@pytest.mark.asyncio
async def test_ranker_skips_when_user_scores_already_present() -> None:
    """If a user already submitted, the 1h runner bails before calling LLM."""
    from contextlib import asynccontextmanager

    class _FakeDB:
        async def execute(self, _stmt: Any) -> _ResultWrapper:
            from app.db.models import SessionStatus
            idx = self._idx
            self._idx += 1
            if idx == 0:
                return _ResultWrapper(scalar=SessionStatus.AWAITING_VISUAL_REVIEW)
            # User score present.
            return _ResultWrapper(first=("user-score-id",))

        def __init__(self) -> None:
            self._idx = 0

        def add(self, _row: Any) -> None:  # pragma: no cover - shouldn't be hit
            raise AssertionError("add() must not be called when user scores exist")

        async def commit(self) -> None:  # pragma: no cover
            raise AssertionError("commit() must not be called when user scores exist")

        async def rollback(self) -> None:
            pass

    @asynccontextmanager
    async def _fake_session_local():
        yield _FakeDB()

    rank_mock = AsyncMock()
    with patch.object(vrv, "AsyncSessionLocal", _fake_session_local), \
            patch.object(vrv, "rank_with_vision_llm", new=rank_mock):
        await vrv._run_vision_ranker_once(
            session_id="sess-skip",
            event_callback=None,
            on_resume=None,
            auto_resume_threshold=3.0,
            model="claude-opus-4-5",
        )

    rank_mock.assert_not_called()


@pytest.mark.asyncio
async def test_ranker_skips_when_session_not_in_awaiting_review() -> None:
    """Status moved on (e.g. user already submitted+resumed) → no-op."""
    from contextlib import asynccontextmanager

    class _FakeDB:
        async def execute(self, _stmt: Any) -> _ResultWrapper:
            from app.db.models import SessionStatus
            return _ResultWrapper(scalar=SessionStatus.RUNNING)

        def add(self, _row: Any) -> None:  # pragma: no cover
            raise AssertionError("add() must not be called for wrong status")

        async def commit(self) -> None:  # pragma: no cover
            raise AssertionError("commit() must not be called for wrong status")

        async def rollback(self) -> None:
            pass

    @asynccontextmanager
    async def _fake_session_local():
        yield _FakeDB()

    rank_mock = AsyncMock()
    with patch.object(vrv, "AsyncSessionLocal", _fake_session_local), \
            patch.object(vrv, "rank_with_vision_llm", new=rank_mock):
        await vrv._run_vision_ranker_once(
            session_id="sess-not-awaiting",
            event_callback=None,
            on_resume=None,
            auto_resume_threshold=3.0,
            model="claude-opus-4-5",
        )

    rank_mock.assert_not_called()
