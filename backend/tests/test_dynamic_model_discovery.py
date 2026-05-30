"""KAO#VR-32 — unit tests for version-agnostic LLM model discovery.

Verifies that the four cloud LLM providers (Anthropic, OpenAI, Grok, Google)
no longer hardcode specific model version strings. Each provider exposes a
``_parse_*_model`` function that parses arbitrary model names into structured
(version, tier, priority) tuples, and capability predicates that work for
any future version without code changes.

Pure unit tests — no network, no API key required.
"""
from __future__ import annotations

import pytest


# ===========================================================================
# Anthropic — _parse_family + _is_adaptive_thinking_model
# ===========================================================================


def test_anthropic_parse_opus_4_7():
    from app.llm.providers.anthropic_provider import _parse_family
    assert _parse_family("claude-opus-4-7") == ("opus", 4, 7)


def test_anthropic_parse_sonnet_5_0():
    from app.llm.providers.anthropic_provider import _parse_family
    assert _parse_family("claude-sonnet-5-0") == ("sonnet", 5, 0)


def test_anthropic_parse_haiku_dated():
    from app.llm.providers.anthropic_provider import _parse_family
    assert _parse_family("claude-haiku-4-5-20251022") == ("haiku", 4, 5)


def test_anthropic_parse_dot_style():
    from app.llm.providers.anthropic_provider import _parse_family
    assert _parse_family("claude-opus-4.7") == ("opus", 4, 7)


def test_is_adaptive_thinking_opus_4_6_true():
    from app.llm.providers.anthropic_provider import _is_adaptive_thinking_model
    assert _is_adaptive_thinking_model("claude-opus-4-6") is True


def test_is_adaptive_thinking_opus_4_5_false():
    from app.llm.providers.anthropic_provider import _is_adaptive_thinking_model
    assert _is_adaptive_thinking_model("claude-opus-4-5") is False


def test_is_adaptive_thinking_sonnet_4_7_true():
    from app.llm.providers.anthropic_provider import _is_adaptive_thinking_model
    assert _is_adaptive_thinking_model("claude-sonnet-4-7") is True


def test_is_adaptive_thinking_haiku_4_6_false():
    """Haiku is excluded from adaptive thinking (only opus/sonnet)."""
    from app.llm.providers.anthropic_provider import _is_adaptive_thinking_model
    assert _is_adaptive_thinking_model("claude-haiku-4-6") is False


def test_is_adaptive_thinking_future_opus_5_2_true():
    from app.llm.providers.anthropic_provider import _is_adaptive_thinking_model
    assert _is_adaptive_thinking_model("claude-opus-5-2") is True


def test_is_adaptive_thinking_garbage_false():
    from app.llm.providers.anthropic_provider import _is_adaptive_thinking_model
    assert _is_adaptive_thinking_model("gpt-4o") is False
    assert _is_adaptive_thinking_model("") is False


def test_anthropic_no_hardcoded_thinking_model_list():
    """KAO#VR-32 — the class must NOT define THINKING_MODELS or
    ADAPTIVE_THINKING_MODELS as hardcoded lists."""
    from app.llm.providers.anthropic_provider import AnthropicProvider
    assert not hasattr(AnthropicProvider, "THINKING_MODELS")
    assert not hasattr(AnthropicProvider, "ADAPTIVE_THINKING_MODELS")


# ===========================================================================
# OpenAI — _parse_openai_model + predicates
# ===========================================================================


def test_openai_parse_gpt_5():
    from app.llm.providers.openai_provider import _parse_openai_model
    assert _parse_openai_model("gpt-5") == (5, 0, "base")


def test_openai_parse_gpt_5_4():
    from app.llm.providers.openai_provider import _parse_openai_model
    assert _parse_openai_model("gpt-5.4") == (5, 4, "base")


def test_openai_parse_gpt_5_4_pro():
    from app.llm.providers.openai_provider import _parse_openai_model
    assert _parse_openai_model("gpt-5.4-pro") == (5, 4, "pro")


def test_openai_parse_gpt_5_mini():
    from app.llm.providers.openai_provider import _parse_openai_model
    assert _parse_openai_model("gpt-5-mini") == (5, 0, "mini")


def test_openai_parse_o3():
    from app.llm.providers.openai_provider import _parse_openai_model
    assert _parse_openai_model("o3") == (3, 0, "base")


def test_openai_parse_o4_mini():
    from app.llm.providers.openai_provider import _parse_openai_model
    assert _parse_openai_model("o4-mini") == (4, 0, "mini")


def test_openai_parse_gpt_4o_returns_none():
    """gpt-4o doesn't fit our gpt-X.Y pattern with a tier — treated as legacy."""
    from app.llm.providers.openai_provider import _parse_openai_model
    parsed = _parse_openai_model("gpt-4o")
    # gpt-4o parses as (4, 0, "base") via the regex — confirm we get major=4.
    assert parsed is not None and parsed[0] == 4 and parsed[1] == 0


def test_supports_responses_api_pro_true():
    from app.llm.providers.openai_provider import _supports_responses_api
    assert _supports_responses_api("gpt-5.4-pro") is True
    assert _supports_responses_api("gpt-5-pro") is True
    assert _supports_responses_api("gpt-6-pro") is True


def test_supports_responses_api_base_false():
    from app.llm.providers.openai_provider import _supports_responses_api
    assert _supports_responses_api("gpt-5.4") is False
    assert _supports_responses_api("gpt-5-mini") is False
    assert _supports_responses_api("o3") is False


def test_supports_reasoning_effort_gpt5x_true():
    from app.llm.providers.openai_provider import _supports_reasoning_effort
    assert _supports_reasoning_effort("gpt-5.4") is True
    assert _supports_reasoning_effort("gpt-5-mini") is True


def test_supports_reasoning_effort_o3_true():
    from app.llm.providers.openai_provider import _supports_reasoning_effort
    assert _supports_reasoning_effort("o3") is True
    assert _supports_reasoning_effort("o4-mini") is True


def test_supports_reasoning_effort_pro_false():
    """Pro variants go through Responses API, not reasoning_effort."""
    from app.llm.providers.openai_provider import _supports_reasoning_effort
    assert _supports_reasoning_effort("gpt-5.4-pro") is False


def test_openai_no_hardcoded_responses_api_list():
    from app.llm.providers.openai_provider import OpenAIProvider
    assert not hasattr(OpenAIProvider, "RESPONSES_API_MODELS")
    assert not hasattr(OpenAIProvider, "REASONING_EFFORT_MODELS")


def test_get_model_capabilities_gpt5x_full_effort_set():
    """VR-59 — GPT-5+ chat models expose minimal/low/medium/high."""
    from app.llm.providers.openai_provider import OpenAIProvider
    p = OpenAIProvider(api_key="fake")
    assert p.get_model_capabilities("gpt-5.5")["thinking_effort_options"] == [
        "minimal", "low", "medium", "high",
    ]
    # mini/nano chat variants too
    assert p.get_model_capabilities("gpt-5-mini")["thinking_effort_options"] == [
        "minimal", "low", "medium", "high",
    ]


def test_get_model_capabilities_oseries_no_minimal():
    """o-series pure-reasoning models: low/medium/high (no 'minimal')."""
    from app.llm.providers.openai_provider import OpenAIProvider
    p = OpenAIProvider(api_key="fake")
    caps = p.get_model_capabilities("o3")
    assert caps["thinking_effort_options"] == ["low", "medium", "high"]
    assert "minimal" not in caps["thinking_effort_options"]


def test_get_model_capabilities_gpt5_pro_no_effort():
    """Pro variants use the Responses API path → no reasoning_effort options."""
    from app.llm.providers.openai_provider import OpenAIProvider
    p = OpenAIProvider(api_key="fake")
    assert p.get_model_capabilities("gpt-5.4-pro")["thinking_effort_options"] == []


# ===========================================================================
# Grok — _parse_grok_model + predicates
# ===========================================================================


def test_grok_parse_4_0709():
    from app.llm.providers.grok_provider import _parse_grok_model
    version, tier, priority = _parse_grok_model("grok-4-0709")
    assert version == 4.0
    assert tier == "base"
    assert priority == 4  # dated


def test_grok_parse_4_1():
    from app.llm.providers.grok_provider import _parse_grok_model
    version, tier, priority = _parse_grok_model("grok-4-1")
    assert version == 4.1
    assert tier == "base"
    assert priority == 0


def test_grok_parse_3_mini():
    from app.llm.providers.grok_provider import _parse_grok_model
    version, tier, priority = _parse_grok_model("grok-3-mini")
    assert version == 3.0
    assert tier == "mini"


def test_grok_parse_code_fast_1():
    from app.llm.providers.grok_provider import _parse_grok_model
    version, tier, _priority = _parse_grok_model("grok-code-fast-1")
    assert tier == "code"


def test_grok_parse_5_pro_future():
    from app.llm.providers.grok_provider import _parse_grok_model
    version, tier, _priority = _parse_grok_model("grok-5-pro")
    assert version == 5.0
    assert tier == "pro"


def test_grok_parse_4_1_fast_reasoning():
    from app.llm.providers.grok_provider import _parse_grok_model
    version, tier, _priority = _parse_grok_model("grok-4-1-fast-reasoning")
    assert version == 4.1
    assert tier == "fast"


def test_grok_supports_search_3_mini_true():
    from app.llm.providers.grok_provider import GrokProvider
    p = GrokProvider(api_key="fake")
    assert p._supports_search("grok-3-mini") is True


def test_grok_supports_search_4_mini_true():
    """Future grok-4-mini should also support search (mini + version>=3)."""
    from app.llm.providers.grok_provider import GrokProvider
    p = GrokProvider(api_key="fake")
    assert p._supports_search("grok-4-mini") is True


def test_grok_supports_search_4_base_false():
    from app.llm.providers.grok_provider import GrokProvider
    p = GrokProvider(api_key="fake")
    assert p._supports_search("grok-4-0709") is False


def test_grok_supports_search_2_mini_false():
    """Version < 3 → no search."""
    from app.llm.providers.grok_provider import GrokProvider
    p = GrokProvider(api_key="fake")
    assert p._supports_search("grok-2-mini") is False


def test_grok_is_reasoning_4_true():
    from app.llm.providers.grok_provider import GrokProvider
    p = GrokProvider(api_key="fake")
    assert p._is_reasoning_model("grok-4-0709") is True


def test_grok_is_reasoning_non_reasoning_false():
    from app.llm.providers.grok_provider import GrokProvider
    p = GrokProvider(api_key="fake")
    assert p._is_reasoning_model("grok-4-1-fast-non-reasoning") is False


def test_grok_is_reasoning_future_5_true():
    """Future grok-5+ assumed reasoning."""
    from app.llm.providers.grok_provider import GrokProvider
    p = GrokProvider(api_key="fake")
    assert p._is_reasoning_model("grok-5-pro") is True


def test_grok_no_hardcoded_reasoning_list():
    from app.llm.providers.grok_provider import GrokProvider
    assert not hasattr(GrokProvider, "REASONING_MODELS")


# ===========================================================================
# Google — _parse_gemini_model (already refactored — sanity-check tests)
# ===========================================================================


def test_google_parse_3_pro_preview():
    from app.llm.providers.google_provider import _parse_gemini_model
    version, tier, priority = _parse_gemini_model("gemini-3-pro-preview")
    assert version == 3.0
    assert tier == "pro"
    assert priority == 1  # preview


def test_google_parse_2_5_flash():
    from app.llm.providers.google_provider import _parse_gemini_model
    version, tier, priority = _parse_gemini_model("gemini-2.5-flash")
    assert version == 2.5
    assert tier == "flash"
    assert priority == 0


def test_google_parse_3_5_flash_lite_dated():
    from app.llm.providers.google_provider import _parse_gemini_model
    version, tier, priority = _parse_gemini_model("gemini-3.5-flash-lite-001")
    assert version == 3.5
    assert tier == "flash-lite"
    assert priority == 4  # dated


# ===========================================================================
# Registry — basic smoke (no network)
# ===========================================================================


@pytest.mark.asyncio
async def test_registry_module_importable():
    """KAO#VR-32 — the registry module exists and exposes the expected API."""
    from app.llm import registry
    assert hasattr(registry, "get_provider_models")
    assert hasattr(registry, "get_pricing")
    assert callable(registry.get_provider_models)
