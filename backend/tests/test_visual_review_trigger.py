"""Unit tests for the Visual Review trigger detection (Wave 1).

These tests stand alone — they don't touch the DB or the network. They
exercise the pure predicate ``should_run_visual_review()`` against a
minimal stand-in for the SQLAlchemy Session model.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pytest

from app.core.visual_review import (
    VISUAL_KEYWORDS,
    VISUAL_LANGUAGES,
    should_run_visual_review,
)


@dataclass
class _FakeSession:
    """Duck-typed stand-in for the SQLAlchemy Session model.

    ``should_run_visual_review`` only reads ``.language``, ``.specification``,
    and ``.settings``, so we can pass any object with those attributes.
    """

    language: str = "python"
    specification: str = ""
    settings: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Negative cases — non-visual languages or no keyword
# ---------------------------------------------------------------------------


def test_python_session_with_visual_keyword_does_not_trigger() -> None:
    """Python is not a visual language; the keyword alone is not enough."""
    s = _FakeSession(language="python", specification="Render a fractal in ASCII.")
    assert should_run_visual_review(s) is False


def test_visual_language_without_keyword_does_not_trigger() -> None:
    """JS in the browser but the spec has no visual keyword — no review."""
    s = _FakeSession(language="javascript_browser", specification="Compute fibonacci.")
    assert should_run_visual_review(s) is False


def test_empty_spec_does_not_trigger() -> None:
    s = _FakeSession(language="html", specification="")
    assert should_run_visual_review(s) is False


def test_unknown_language_does_not_trigger() -> None:
    s = _FakeSession(language="cobol", specification="draw a beautiful animation")
    assert should_run_visual_review(s) is False


# ---------------------------------------------------------------------------
# Positive cases — visual language AND a keyword
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("language", sorted(VISUAL_LANGUAGES))
def test_visual_language_with_keyword_triggers(language: str) -> None:
    s = _FakeSession(language=language, specification="Render a particle simulation.")
    assert should_run_visual_review(s) is True


@pytest.mark.parametrize("keyword", sorted(VISUAL_KEYWORDS))
def test_every_keyword_triggers_when_language_is_visual(keyword: str) -> None:
    s = _FakeSession(
        language="javascript_browser",
        specification=f"Please {keyword} the output as required.",
    )
    assert should_run_visual_review(s) is True


def test_keyword_is_case_insensitive() -> None:
    s = _FakeSession(language="html", specification="RENDER a colour wheel")
    assert should_run_visual_review(s) is True


def test_keyword_must_be_a_whole_word() -> None:
    """``ui`` should not match ``guidance`` or ``built-in``."""
    s = _FakeSession(
        language="javascript_browser",
        specification="Build a guidance system for an autonomous robot.",
    )
    assert should_run_visual_review(s) is False


# ---------------------------------------------------------------------------
# Override flags
# ---------------------------------------------------------------------------


def test_force_visual_review_overrides_language() -> None:
    """Even Python sessions can opt in via ``settings.force_visual_review``."""
    s = _FakeSession(
        language="python",
        specification="Print hello world.",
        settings={"force_visual_review": True},
    )
    assert should_run_visual_review(s) is True


def test_skip_visual_review_overrides_keyword_and_language() -> None:
    """The skip flag is a hard veto."""
    s = _FakeSession(
        language="html",
        specification="Render an animation",
        settings={"skip_visual_review": True},
    )
    assert should_run_visual_review(s) is False


def test_skip_overrides_force() -> None:
    """Skip wins over force — the user opts out."""
    s = _FakeSession(
        language="html",
        specification="Render an animation",
        settings={"force_visual_review": True, "skip_visual_review": True},
    )
    assert should_run_visual_review(s) is False


def test_missing_settings_field_treated_as_empty() -> None:
    s = _FakeSession(language="html", specification="render a plot")
    s.settings = None  # type: ignore[assignment]
    assert should_run_visual_review(s) is True


# ---------------------------------------------------------------------------
# Spec normalisation
# ---------------------------------------------------------------------------


def test_keyword_in_multiline_spec_is_found() -> None:
    spec = (
        "Build a CLI tool with the following features:\n"
        "- Parse input\n"
        "- Visualize the result as a chart\n"
        "- Save to disk"
    )
    s = _FakeSession(language="html", specification=spec)
    assert should_run_visual_review(s) is True


def test_language_with_surrounding_whitespace_is_handled() -> None:
    s = _FakeSession(language="  HTML  ", specification="draw something")
    assert should_run_visual_review(s) is True
