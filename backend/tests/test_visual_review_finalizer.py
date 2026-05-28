"""Unit tests for the Visual Review wave-2 Finalizer integration.

These tests stand alone — no DB or network. They mock the AsyncSession's
``execute()`` method to return scripted result objects that match the
shape the production code expects from the three queries fired by
``aggregate_visual_review_scores``:

  1. ``select(VisualReviewScore).where(session_id=...)``           -> scalars().all()
  2. ``select(CodeVersion.id, CodeVersion.coder_index)``           -> .all() (tuples)
  3. ``select(SummaryAudit).join(...).where(session_id=...)``      -> scalars().all()

The tests assert the priority rules (user > vision_llm > LLM fallback)
and that the audit-trail string contains the right indicator for each path.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable
from unittest.mock import AsyncMock

import pytest

from app.services.visual_review import (
    VisualReviewDecision,
    aggregate_visual_review_scores,
)


# ---------------------------------------------------------------------------
# Tiny test doubles
# ---------------------------------------------------------------------------


@dataclass
class _FakeScore:
    """Stand-in for db.models.VisualReviewScore — only the read fields matter."""
    code_version_id: str
    score: int
    source: str  # 'user' | 'vision_llm'


@dataclass
class _FakeSummary:
    """Stand-in for db.models.SummaryAudit (only fields read by aggregator)."""
    coder_index: int
    critical_issues: list
    serious_issues: list


class _ScalarsResult:
    """Mimic the SQLAlchemy ``Result.scalars().all()`` chain."""

    def __init__(self, items: list[Any]):
        self._items = list(items)

    def all(self) -> list[Any]:
        return self._items


class _AllResult:
    """Mimic the SQLAlchemy ``Result.all()`` chain that returns tuples."""

    def __init__(self, rows: list[tuple]):
        self._rows = list(rows)

    def all(self) -> list[tuple]:
        return self._rows


class _ResultWrapper:
    """Mimic SQLAlchemy ``Result`` — supports both ``.scalars().all()`` and ``.all()``."""

    def __init__(
        self,
        scalars: list[Any] | None = None,
        rows: list[tuple] | None = None,
    ):
        self._scalars = scalars or []
        self._rows = rows or []

    def scalars(self) -> _ScalarsResult:
        return _ScalarsResult(self._scalars)

    def all(self) -> list[tuple]:
        return self._rows


def _make_db(
    *,
    scores: list[_FakeScore],
    code_versions: Iterable[tuple[str, int]],
    summaries: list[_FakeSummary],
) -> Any:
    """Build an AsyncMock db whose ``execute()`` returns the right shape per call.

    The aggregator fires three queries in order:
      1. scores  -> scalars().all()
      2. code_versions  -> .all()  (tuples of (id, coder_index))
      3. summaries  -> scalars().all()
    """
    results = [
        _ResultWrapper(scalars=scores),
        _ResultWrapper(rows=list(code_versions)),
        _ResultWrapper(scalars=summaries),
    ]
    db = AsyncMock()
    call_count = {"n": 0}

    async def _execute(_stmt: Any) -> _ResultWrapper:
        idx = call_count["n"]
        call_count["n"] += 1
        if idx >= len(results):
            return _ResultWrapper()
        return results[idx]

    db.execute = _execute
    return db


# ---------------------------------------------------------------------------
# Path 1: user scores override everything
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_user_scores_pick_highest_user_avg() -> None:
    """Two candidates, user_scores A=9 / B=4 -> A wins (HARD tiebreaker)."""
    cv_a = "11111111-1111-1111-1111-111111111111"
    cv_b = "22222222-2222-2222-2222-222222222222"

    db = _make_db(
        scores=[
            _FakeScore(cv_a, 9, "user"),
            _FakeScore(cv_b, 4, "user"),
        ],
        code_versions=[(cv_a, 0), (cv_b, 1)],
        summaries=[
            _FakeSummary(coder_index=0, critical_issues=[1], serious_issues=[]),
            _FakeSummary(coder_index=1, critical_issues=[], serious_issues=[]),
        ],
    )

    decision = await aggregate_visual_review_scores(db, "session-1")
    assert decision.forced_winner_code_version_id == cv_a
    assert decision.selection_source == "user"
    assert "user_score=9.0/10" in decision.reasoning
    assert "coder 0" in decision.reasoning


@pytest.mark.asyncio
async def test_user_scores_override_default_finalizer_pick() -> None:
    """User picks coder 1 (avg=8) but coder 0 has fewer tester issues —
    the reasoning must mention the override."""
    cv_a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    cv_b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

    db = _make_db(
        scores=[
            _FakeScore(cv_a, 3, "user"),
            _FakeScore(cv_b, 8, "user"),
        ],
        code_versions=[(cv_a, 0), (cv_b, 1)],
        summaries=[
            # coder 0 has 0 tester issues -> default finalizer would prefer it
            _FakeSummary(coder_index=0, critical_issues=[], serious_issues=[]),
            # coder 1 has 3 tester issues
            _FakeSummary(
                coder_index=1,
                critical_issues=[{"id": 1}, {"id": 2}],
                serious_issues=[{"id": 3}],
            ),
        ],
    )

    decision = await aggregate_visual_review_scores(db, "session-1")
    assert decision.forced_winner_code_version_id == cv_b
    assert decision.selection_source == "user"
    # Must mention that user overrode the default pick (coder 0)
    assert "overrode default Finalizer pick" in decision.reasoning
    assert "coder 0" in decision.reasoning
    assert "tester_issues=3" in decision.reasoning


@pytest.mark.asyncio
async def test_user_scores_average_across_multiple_voters() -> None:
    """Three user votes for cv_a (avg 7.3...) beat two for cv_b (avg 6.0)."""
    cv_a = "11111111-1111-1111-1111-111111111111"
    cv_b = "22222222-2222-2222-2222-222222222222"

    db = _make_db(
        scores=[
            _FakeScore(cv_a, 7, "user"),
            _FakeScore(cv_a, 8, "user"),
            _FakeScore(cv_a, 7, "user"),  # avg 7.33
            _FakeScore(cv_b, 6, "user"),
            _FakeScore(cv_b, 6, "user"),  # avg 6.0
        ],
        code_versions=[(cv_a, 0), (cv_b, 1)],
        summaries=[],
    )

    decision = await aggregate_visual_review_scores(db, "session-1")
    assert decision.forced_winner_code_version_id == cv_a
    assert decision.selection_source == "user"


# ---------------------------------------------------------------------------
# Path 2: no user input, vision_llm only
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_vision_llm_used_when_no_user_scores() -> None:
    """vision A=5, vision B=8 -> B wins because higher avg."""
    cv_a = "11111111-1111-1111-1111-111111111111"
    cv_b = "22222222-2222-2222-2222-222222222222"

    db = _make_db(
        scores=[
            _FakeScore(cv_a, 5, "vision_llm"),
            _FakeScore(cv_b, 8, "vision_llm"),
        ],
        code_versions=[(cv_a, 0), (cv_b, 1)],
        summaries=[],
    )

    decision = await aggregate_visual_review_scores(db, "session-1")
    assert decision.forced_winner_code_version_id == cv_b
    assert decision.selection_source == "vision_llm"
    assert "no user input" in decision.reasoning
    assert "vision_llm=8.0" in decision.reasoning
    assert "vision-LLM ranking as fallback" in decision.reasoning


@pytest.mark.asyncio
async def test_vision_llm_ignored_when_user_scores_present() -> None:
    """User signal beats vision_llm even when vision_llm strongly disagrees."""
    cv_a = "11111111-1111-1111-1111-111111111111"
    cv_b = "22222222-2222-2222-2222-222222222222"

    db = _make_db(
        scores=[
            _FakeScore(cv_a, 9, "user"),
            _FakeScore(cv_b, 2, "user"),
            # vision_llm strongly disagrees with the user
            _FakeScore(cv_a, 1, "vision_llm"),
            _FakeScore(cv_b, 10, "vision_llm"),
        ],
        code_versions=[(cv_a, 0), (cv_b, 1)],
        summaries=[],
    )

    decision = await aggregate_visual_review_scores(db, "session-1")
    assert decision.forced_winner_code_version_id == cv_a
    assert decision.selection_source == "user"
    # The reasoning must include the vision_llm number for the winner.
    assert "vision_llm=1.0" in decision.reasoning


# ---------------------------------------------------------------------------
# Path 3: no scores at all → fall back to default Finalizer LLM
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_scores_falls_back_to_default_llm_picker() -> None:
    """No user / no vision scores -> forced_winner_code_version_id is None."""
    db = _make_db(
        scores=[],
        code_versions=[
            ("11111111-1111-1111-1111-111111111111", 0),
            ("22222222-2222-2222-2222-222222222222", 1),
        ],
        summaries=[],
    )

    decision = await aggregate_visual_review_scores(db, "session-1")
    assert decision.forced_winner_code_version_id is None
    assert decision.selection_source == "finalizer_llm"
    assert "fell back to default Finalizer LLM" in decision.reasoning


# ---------------------------------------------------------------------------
# Reasoning-string smoke tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_reasoning_indicates_user_path() -> None:
    cv_a = "11111111-1111-1111-1111-111111111111"
    db = _make_db(
        scores=[_FakeScore(cv_a, 8, "user")],
        code_versions=[(cv_a, 0)],
        summaries=[
            _FakeSummary(coder_index=0, critical_issues=[], serious_issues=[]),
        ],
    )
    decision = await aggregate_visual_review_scores(db, "session-1")
    assert decision.selection_source == "user"
    assert "user_score=" in decision.reasoning


@pytest.mark.asyncio
async def test_reasoning_indicates_vision_llm_path() -> None:
    cv_a = "11111111-1111-1111-1111-111111111111"
    db = _make_db(
        scores=[_FakeScore(cv_a, 7, "vision_llm")],
        code_versions=[(cv_a, 0)],
        summaries=[],
    )
    decision = await aggregate_visual_review_scores(db, "session-1")
    assert decision.selection_source == "vision_llm"
    assert "vision_llm=" in decision.reasoning
    assert "Used vision-LLM ranking as fallback" in decision.reasoning


@pytest.mark.asyncio
async def test_reasoning_indicates_finalizer_llm_path() -> None:
    db = _make_db(scores=[], code_versions=[], summaries=[])
    decision = await aggregate_visual_review_scores(db, "session-1")
    assert decision.selection_source == "finalizer_llm"
    assert "default Finalizer LLM" in decision.reasoning


# ---------------------------------------------------------------------------
# Decision dataclass shape
# ---------------------------------------------------------------------------


def test_decision_dataclass_is_immutable() -> None:
    d = VisualReviewDecision(
        forced_winner_code_version_id="cv-1",
        selection_source="user",
        reasoning="...",
        per_candidate_user_avg={"cv-1": 9.0},
        per_candidate_vision_avg={},
    )
    # frozen=True means assignment must raise.
    with pytest.raises(Exception):
        d.selection_source = "vision_llm"  # type: ignore[misc]
