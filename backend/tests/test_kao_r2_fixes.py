"""КАО#R2 regression tests — lock the serious backend fixes from audit round R2.

These cover the half-step (Numeric(3,1)) score path end-to-end on the READ side,
which the original VR-27 tests only exercised on the input/column side.
"""
from decimal import Decimal

from app.api.routes.visual_review import _ScoreResponse
from app.services.visual_review import _avg


def test_r2_02_score_response_accepts_half_step_decimal():
    # КАО#R2-02 — VisualReviewScore.score is Numeric(3,1) → SQLAlchemy yields a
    # Decimal('7.5'); the old `score: int` response field made FastAPI 500 on
    # any fractional user score. The field is now float.
    assert _ScoreResponse(score=Decimal("7.5"), source="user").score == 7.5
    assert _ScoreResponse(
        score=Decimal("9.5"), source="vision_llm", submitted_by="u"
    ).score == 9.5
    # Whole numbers still round-trip.
    assert _ScoreResponse(score=Decimal("7.0"), source="user").score == 7.0


def test_r2_03_avg_preserves_half_step():
    # КАО#R2-03 — winner aggregation used int(row.score), collapsing 7.5 and 7.0
    # to a spurious tie. Scores now flow as floats; the average keeps 0.5 detail.
    assert _avg([7.5, 7.0]) == 7.25
    assert _avg([9.5]) == 9.5
    assert _avg([]) == 0.0
