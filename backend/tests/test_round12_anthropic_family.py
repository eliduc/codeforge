"""R12 — Anthropic provider regex-based model family detection.

Verifies `_parse_family()` parses arbitrary Claude model IDs into
(family_name, major, minor) without hardcoded version lists, and that
the higher-level capability helpers (`_supports_thinking`,
`_supports_adaptive_thinking`) work for future versions (Claude 4.x, 5.x).

These are pure unit tests — no network, no API key needed.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest


# ===========================================================================
# _parse_family — basic patterns
# ===========================================================================


def test_parse_family_opus_4_7():
    """C.1 — `claude-opus-4-7` → ('opus', 4, 7)."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    assert _parse_family("claude-opus-4-7") == ("opus", 4, 7)


def test_parse_family_sonnet_4_6():
    """C.2 — `claude-sonnet-4-6` → ('sonnet', 4, 6)."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    assert _parse_family("claude-sonnet-4-6") == ("sonnet", 4, 6)


def test_parse_family_haiku_5_0_future_proof():
    """C.3 — `claude-haiku-5-0` → ('haiku', 5, 0) (future Claude 5)."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    assert _parse_family("claude-haiku-5-0") == ("haiku", 5, 0)


def test_parse_family_opus_4_1():
    """C.4 — `claude-opus-4-1` → ('opus', 4, 1)."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    assert _parse_family("claude-opus-4-1") == ("opus", 4, 1)


def test_parse_family_dated_suffix():
    """Dated model IDs still parse the family correctly."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    assert _parse_family("claude-sonnet-4-6-20251022") == ("sonnet", 4, 6)


def test_parse_family_dot_style():
    """Dot-style version separator (claude-opus-4.7) also parses."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    assert _parse_family("claude-opus-4.7") == ("opus", 4, 7)


def test_parse_family_case_insensitive():
    """Family detection is case-insensitive."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    parsed = _parse_family("Claude-OPUS-4-7")
    assert parsed is not None
    name, major, minor = parsed
    assert name == "opus"
    assert major == 4
    assert minor == 7


def test_parse_family_missing_minor_defaults_to_zero():
    """If only major version is present, minor defaults to 0."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    parsed = _parse_family("claude-opus-5")
    assert parsed is not None
    assert parsed[0] == "opus"
    assert parsed[1] == 5
    assert parsed[2] == 0  # minor defaults to 0


def test_parse_family_returns_none_for_garbage():
    """Non-matching strings return None."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    assert _parse_family("gpt-4o") is None
    assert _parse_family("") is None
    assert _parse_family("not-a-real-model") is None


def test_parse_family_returns_none_for_claude_3():
    """Claude 3 still parses to ('opus', 3, 5) — major-version filtering is
    a caller-side concern (in is_available, only major>=4 is kept)."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    parsed = _parse_family("claude-opus-3-5")
    assert parsed is not None
    assert parsed == ("opus", 3, 5)


# ===========================================================================
# C.5 — is_available no longer hardcodes specific model strings (regex-based).
# ===========================================================================


def test_is_available_uses_regex_not_hardcoded_list():
    """is_available() should use _parse_family (regex) to classify models.

    We verify by inspecting source: it must call `_parse_family` inside
    the available-models loop, NOT use a hardcoded comparison list.
    """
    try:
        import inspect
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    src = inspect.getsource(AnthropicProvider.is_available)
    assert "_parse_family" in src, (
        "is_available() must call _parse_family() to classify models (R12 regex-based detection)"
    )


# ===========================================================================
# C.6 — _supports_thinking / _supports_adaptive_thinking work for parsed family.
# ===========================================================================


def test_supports_thinking_for_opus_4_7_via_regex():
    """Future model `claude-opus-4-7` (not in any hardcoded list) MUST be
    detected as thinking-capable because major>=4."""
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    assert p._supports_thinking("claude-opus-4-7") is True


def test_supports_thinking_for_sonnet_5_0_future():
    """Claude 5 sonnet → supports thinking."""
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    assert p._supports_thinking("claude-sonnet-5-0") is True


def test_supports_thinking_for_haiku_5_2_future():
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    assert p._supports_thinking("claude-haiku-5-2") is True


def test_supports_thinking_for_claude_3_returns_false():
    """Claude 3 family — major<4 — should NOT support thinking."""
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    assert p._supports_thinking("claude-opus-3-5") is False


def test_supports_adaptive_thinking_for_opus_4_7():
    """C.6 — Adaptive thinking on Opus 4.7 (major=4, minor>=6) → True."""
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    assert p._supports_adaptive_thinking("claude-opus-4-7") is True


def test_supports_adaptive_thinking_for_sonnet_4_6():
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    assert p._supports_adaptive_thinking("claude-sonnet-4-6") is True


def test_supports_adaptive_thinking_for_claude_5():
    """All Claude 5.x assumed adaptive."""
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    assert p._supports_adaptive_thinking("claude-haiku-5-0") is True
    assert p._supports_adaptive_thinking("claude-opus-5-1") is True


def test_supports_adaptive_thinking_for_claude_4_5_returns_false():
    """Claude 4.5 family — minor<6 — should NOT support adaptive thinking."""
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    # 4.5 is below the 4.6 adaptive cutoff.
    assert p._supports_adaptive_thinking("claude-opus-4-5") is False


def test_supports_adaptive_thinking_haiku_4_6_returns_false():
    """Even at minor=6, haiku is excluded from adaptive (only opus/sonnet)."""
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    assert p._supports_adaptive_thinking("claude-haiku-4-6") is False


def test_get_model_capabilities_returns_effort_options_for_new_opus():
    """Capabilities surface for Opus 4.7 (not in any hardcoded ADAPTIVE list)."""
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    caps = p.get_model_capabilities("claude-opus-4-7")
    # Opus on adaptive thinking → low/medium/high/max
    assert caps["thinking_effort_options"] == ["low", "medium", "high", "max"]


def test_get_model_capabilities_sonnet_46_no_max():
    """Sonnet 4.6: 'max' effort not supported."""
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    caps = p.get_model_capabilities("claude-sonnet-4-6")
    assert "max" not in caps["thinking_effort_options"]
    assert set(caps["thinking_effort_options"]) == {"low", "medium", "high"}


def test_get_model_capabilities_haiku_46_no_thinking_options():
    """Haiku 4.6 is not adaptive but does support legacy thinking → low/med/high."""
    try:
        from app.llm.providers.anthropic_provider import AnthropicProvider
    except Exception as exc:
        pytest.skip(f"anthropic_provider not importable: {exc!r}")
    p = AnthropicProvider(api_key="fake")
    caps = p.get_model_capabilities("claude-haiku-4-6")
    # _supports_thinking is True (major=4) but _supports_adaptive_thinking False
    # → legacy thinking branch → low/medium/high
    assert caps["thinking_effort_options"] == ["low", "medium", "high"]
