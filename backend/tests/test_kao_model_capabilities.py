"""КАО#VR-32 / КАО#VR-59 — exhaustive coverage of get_model_capabilities()
and the version-agnostic model parsers for ALL FOUR LLM providers.

Round zone: version-agnostic LLM model capabilities (dynamic model discovery,
VR-32 / VR-30) + OpenAI thinking levels (VR-59).

These are PURE UNIT TESTS — no network, no real API key. Every provider is
constructed as ``Provider(api_key="fake")`` (mirroring
test_dynamic_model_discovery.py and test_round12_anthropic_family.py); none of
the capability/parsing code touches the network, so a fake key is sufficient.

What this file adds on top of the two existing discovery test files:
  * get_model_capabilities() exact-list assertions for OpenAI, Anthropic,
    Google, Grok across CURRENT and hypothetical FUTURE version names, to prove
    the parsers are genuinely version-agnostic.
  * The minimal / o-series / pro distinctions for OpenAI (VR-59).
  * opus-gets-"max" vs sonnet/haiku-no-"max" for Anthropic.
  * non-thinking models → [] for every provider.
  * max_output_tokens surfaced in the capabilities dict.
  * Edge-case parser predicate coverage not already in
    test_dynamic_model_discovery.py.

NOTE FOR THE КАО TESTER/FIXER PHASE:
  The Google block intentionally asserts the *current* (buggy) behavior of
  GoogleProvider._supports_thinking so the suite stays green, with the
  divergence-from-version-agnostic loudly documented inline (see the
  ``test_google_*`` section header and the ``# КАО-FINDING`` comments). The
  accompanying findings report classifies this as a SERIOUS bug: a future
  gemini-4+/5+ flagship returns thinking_effort_options == [] because Google
  still uses a hardcoded THINKING_MODELS substring list instead of a
  version-agnostic predicate like the other three providers. When the fixer
  migrates GoogleProvider to a parser-based predicate, the two
  ``test_google_future_*_REGRESSION`` tests below must be flipped to expect the
  full thinking set.
"""
from __future__ import annotations

import asyncio

import pytest


# ===========================================================================
# Helpers — provider construction mirrors the existing tests exactly.
# ===========================================================================


def _openai():
    from app.llm.providers.openai_provider import OpenAIProvider
    return OpenAIProvider(api_key="fake")


def _anthropic():
    from app.llm.providers.anthropic_provider import AnthropicProvider
    return AnthropicProvider(api_key="fake")


def _google():
    from app.llm.providers.google_provider import GoogleProvider
    return GoogleProvider(api_key="fake")


def _grok():
    from app.llm.providers.grok_provider import GrokProvider
    return GrokProvider(api_key="fake")


# ===========================================================================
# OpenAI — get_model_capabilities (VR-59 thinking levels)
#   gpt-5+ chat  → ['minimal','low','medium','high']
#   o-series     → ['low','medium','high']  (NO 'minimal')
#   *-pro        → []   (Responses API path)
#   legacy <5    → []
# ===========================================================================

_OPENAI_FULL_EFFORT = ["minimal", "low", "medium", "high"]
_OSERIES_EFFORT = ["low", "medium", "high"]


@pytest.mark.parametrize(
    "model",
    [
        "gpt-5",
        "gpt-5.4",
        "gpt-5.5",
        "gpt-5-mini",
        "gpt-5-nano",
        "gpt-5.4-codex",   # codex suffix still parses as base gpt-5.x chat → effort
        "gpt-5-chat",      # chat suffix → base tier
        # FUTURE versions — version-agnostic parser must keep working:
        "gpt-6",
        "gpt-6.2",
        "gpt-7-mini",
        "gpt-10",
    ],
)
def test_openai_caps_gpt5plus_full_effort_set(model):
    """VR-59 — every gpt-5+ (and future gpt-N) chat/mini/nano model exposes the
    full OpenAI reasoning_effort set including 'minimal'."""
    caps = _openai().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == _OPENAI_FULL_EFFORT, model


@pytest.mark.parametrize(
    "model",
    [
        "o3",
        "o4-mini",
        "o3-mini",
        "o1",
        # FUTURE o-series:
        "o5",
        "o6-mini",
    ],
)
def test_openai_caps_oseries_no_minimal(model):
    """O-series pure-reasoning models expose low/medium/high — never 'minimal'."""
    caps = _openai().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == _OSERIES_EFFORT, model
    assert "minimal" not in caps["thinking_effort_options"], model


@pytest.mark.parametrize(
    "model",
    [
        "gpt-5-pro",
        "gpt-5.4-pro",
        # FUTURE pro:
        "gpt-6-pro",
        "gpt-7.1-pro",
    ],
)
def test_openai_caps_pro_no_effort(model):
    """*-pro variants take the Responses-API path → no reasoning_effort options."""
    caps = _openai().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == [], model


@pytest.mark.parametrize(
    "model",
    [
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
        "gpt-4",
        "gpt-3.5-turbo",
        "text-davinci-003",  # unparseable → []
        "totally-unknown",
    ],
)
def test_openai_caps_legacy_and_unknown_empty(model):
    """Legacy (<5) and unparseable models expose no reasoning_effort options."""
    caps = _openai().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == [], model


def test_openai_caps_oseries_pro_distinction():
    """КАО#VR-32 (was a MINOR finding, now FIXED): o3-pro routes through the
    Responses API (like gpt-*-pro), which this client does not pass
    reasoning_effort to — so it advertises NO effort options. The responses-api
    check now runs BEFORE the o-series reasoning check in get_model_capabilities.
    """
    caps = _openai().get_model_capabilities("o3-pro")
    assert caps["thinking_effort_options"] == []


def test_openai_caps_include_max_output_tokens():
    p = _openai()
    assert p.get_model_capabilities("gpt-5.4")["max_output_tokens"] == 32768
    assert p.get_model_capabilities("o3")["max_output_tokens"] == 100000
    # Unknown model → DEFAULT_MAX_OUTPUT.
    assert p.get_model_capabilities("gpt-totally-new")["max_output_tokens"] == 16384


# ===========================================================================
# КАО#VR-59 — thinking_effort UI path round-trip through generate()
#
# get_model_capabilities() advertising a level is only half the contract: the
# node-settings "Thinking" select sends that level to generate() as
# `thinking_effort`, which maps it to OpenAI's `reasoning_effort` via an
# effort_map. If a level is advertised but has no effort_map key, generate()
# yields effective_effort=None, _generate_chat_completions sets has_effort=False,
# and NO reasoning_effort reaches the API — which silently applies its medium
# default. The UI then lies: it shows "Minimal"/"High" while the model runs at
# medium. These tests pin the frontend↔backend lockstep at the generate() layer.
# ===========================================================================


def _capture_effective_effort(model: str, thinking_effort: str):
    """Drive generate() down the thinking_effort UI path and return the
    reasoning_effort it forwards to the OpenAI call — with NO network I/O.

    Both downstream API methods are stubbed to capture their reasoning_effort
    kwarg, so this exercises the real effort_map in generate() (lines ~511-525)
    without an API key or HTTP. A None result is exactly the VR-59 bug: the level
    was advertised in the UI but dropped before it could reach OpenAI.
    """
    from app.llm.providers.openai_provider import OpenAIProvider

    provider = OpenAIProvider(api_key="fake")
    captured: dict = {}

    async def _stub(**kwargs):
        captured["reasoning_effort"] = kwargs.get("reasoning_effort")
        return "ok"

    # generate() routes to one of these depending on _uses_responses_api(model).
    provider._generate_chat_completions = _stub
    provider._generate_responses_api = _stub
    asyncio.run(provider.generate(prompt="hi", model=model, thinking_effort=thinking_effort))
    return captured.get("reasoning_effort")


@pytest.mark.parametrize(
    "model",
    ["gpt-5", "gpt-5.4", "gpt-5.5", "gpt-5-mini", "gpt-5-nano", "gpt-5-chat", "gpt-6"],
)
def test_openai_every_advertised_effort_roundtrips_through_generate(model):
    """VR-59 CORE: for a GPT-5.x chat model, EVERY level get_model_capabilities
    advertises must map to a non-None reasoning_effort when sent through the
    thinking_effort UI path of generate(). Driven straight off the advertised
    list, so it stays in lockstep automatically if that list ever changes."""
    advertised = _openai().get_model_capabilities(model)["thinking_effort_options"]
    assert advertised == _OPENAI_FULL_EFFORT, model  # guard: list under test
    for effort in advertised:
        effective = _capture_effective_effort(model, effort)
        assert effective is not None, (
            f"{model}: thinking_effort={effort!r} is advertised in the UI but "
            f"generate()'s effort_map dropped it to None — the API would silently "
            f"fall back to its medium default (КАО#VR-59 regression)."
        )


@pytest.mark.parametrize(
    "thinking_effort,expected",
    [
        ("minimal", "minimal"),  # problem #1: 'minimal' had no key → None → dropped
        ("low", "low"),
        ("medium", "medium"),
        ("high", "high"),        # problem #2: was silently collapsed to 'medium'
        ("max", "high"),         # unified ceiling → OpenAI tops out at 'high'
    ],
)
def test_openai_gpt5_chat_effort_exact_mapping(thinking_effort, expected):
    """VR-59: GPT-5.x chat honors the reasoning_effort set 1:1. In particular
    'high' must NOT collapse to 'medium' and 'minimal' must NOT vanish — the two
    concrete bugs the fix addresses."""
    assert _capture_effective_effort("gpt-5.4", thinking_effort) == expected


@pytest.mark.parametrize(
    "model",
    ["o3", "o4-mini", "o1"],
)
def test_openai_oseries_advertised_efforts_roundtrip(model):
    """O-series advertises only low/medium/high (no 'minimal'); each must still
    round-trip to a non-None reasoning_effort through generate() — frontend and
    backend stay in lockstep for the reasoning-model path too."""
    advertised = _openai().get_model_capabilities(model)["thinking_effort_options"]
    assert advertised == _OSERIES_EFFORT, model
    for effort in advertised:
        assert _capture_effective_effort(model, effort) is not None, (model, effort)


# ---- OpenAI parser / predicate edge cases (beyond test_dynamic_model_discovery) ----


def test_openai_parse_nano_tier():
    from app.llm.providers.openai_provider import _parse_openai_model
    assert _parse_openai_model("gpt-5-nano") == (5, 0, "nano")
    assert _parse_openai_model("gpt-6.3-nano") == (6, 3, "nano")


def test_openai_parse_named_variants_are_distinct():
    """КАО#R6 — named suffixes (chat/preview AND codenames like luna/sol) are kept
    as DISTINCT variant slots, not collapsed to 'base' — otherwise same-version
    variants (gpt-5.6-luna / gpt-5.6-sol) merge and only one survives. A plain
    version → 'base'. ('search' models are dropped by the noise filter upstream.)"""
    from app.llm.providers.openai_provider import _parse_openai_model
    assert _parse_openai_model("gpt-5") == (5, 0, "base")
    assert _parse_openai_model("gpt-5-chat") == (5, 0, "chat")
    assert _parse_openai_model("gpt-5-preview") == (5, 0, "preview")
    assert _parse_openai_model("gpt-5.6-luna") == (5, 6, "luna")
    assert _parse_openai_model("gpt-5.6-sol") == (5, 6, "sol")
    assert _parse_openai_model("gpt-5.4-mini") == (5, 4, "mini")


def test_openai_parse_o_series_future_major():
    from app.llm.providers.openai_provider import _parse_openai_model
    assert _parse_openai_model("o5") == (5, 0, "base")
    assert _parse_openai_model("o7-mini") == (7, 0, "mini")
    assert _parse_openai_model("o5-pro") == (5, 0, "pro")


def test_openai_parse_unparseable_returns_none():
    from app.llm.providers.openai_provider import _parse_openai_model
    assert _parse_openai_model("claude-opus-4-8") is None
    assert _parse_openai_model("gemini-3-pro") is None
    assert _parse_openai_model("") is None


def test_openai_is_reasoning_model_oseries_only():
    p = _openai()
    assert p._is_reasoning_model("o3") is True
    assert p._is_reasoning_model("o4-mini") is True
    assert p._is_reasoning_model("o10") is True
    assert p._is_reasoning_model("gpt-5.4") is False
    assert p._is_reasoning_model("gpt-5-mini") is False
    # 'o' prefixed non-o-series words must NOT match (regex requires o\d).
    assert p._is_reasoning_model("omni-model") is False


def test_openai_supports_reasoning_effort_major_threshold():
    """gpt-4o (major 4) must NOT support reasoning_effort; gpt-5 (major 5) must.
    Off-by-one guard on the `major >= 5` threshold."""
    from app.llm.providers.openai_provider import _supports_reasoning_effort
    assert _supports_reasoning_effort("gpt-4o") is False
    assert _supports_reasoning_effort("gpt-4-turbo") is False
    assert _supports_reasoning_effort("gpt-5") is True
    assert _supports_reasoning_effort("gpt-5-mini") is True
    # pro → False (Responses API path)
    assert _supports_reasoning_effort("gpt-5-pro") is False
    assert _supports_reasoning_effort("gpt-6-pro") is False


def test_openai_supports_responses_api_only_pro_suffix():
    from app.llm.providers.openai_provider import _supports_responses_api
    assert _supports_responses_api("gpt-5-pro") is True
    assert _supports_responses_api("gpt-5.4-pro") is True
    assert _supports_responses_api("gpt-6-pro") is True
    # Must anchor on the '-pro' SUFFIX, not 'pro' anywhere.
    assert _supports_responses_api("gpt-5-pro-preview") is False
    assert _supports_responses_api("gpt-5") is False
    # КАО#VR-32 — o-series '-pro' now routes via the Responses API too.
    assert _supports_responses_api("o3-pro") is True
    assert _supports_responses_api("o4-pro") is True


# ===========================================================================
# Anthropic — get_model_capabilities
#   adaptive (4.6+ opus/sonnet, all 5.x+):
#       opus   → ['low','medium','high','max']
#       sonnet → ['low','medium','high']         (NO 'max')
#       haiku 5.x → ['low','medium','high']      (adaptive but not opus → no max)
#   legacy thinking (4.0–4.5, haiku 4.6) → ['low','medium','high']
#   claude-3 / unparseable → []
# ===========================================================================

_FULL_WITH_MAX = ["low", "medium", "high", "max"]
_NO_MAX = ["low", "medium", "high"]


@pytest.mark.parametrize(
    "model",
    [
        "claude-opus-4-6",
        "claude-opus-4-7",
        "claude-opus-4-8",
        "claude-opus-4.8",          # dot-style
        "claude-opus-4-8-20260101",  # dated suffix
        # FUTURE opus:
        "claude-opus-5-0",
        "claude-opus-5-2",
        "claude-opus-6-0",
    ],
)
def test_anthropic_caps_opus_adaptive_has_max(model):
    """Adaptive-thinking Opus exposes the full set INCLUDING 'max'."""
    caps = _anthropic().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == _FULL_WITH_MAX, model


@pytest.mark.parametrize(
    "model",
    [
        "claude-sonnet-4-6",
        "claude-sonnet-4-7",
        "claude-sonnet-4-8",
        # FUTURE sonnet (adaptive via major>=5) — still NO 'max' (max is opus-only):
        "claude-sonnet-5-0",
        "claude-sonnet-5-3",
        "claude-sonnet-6-0",
    ],
)
def test_anthropic_caps_sonnet_adaptive_no_max(model):
    """Adaptive-thinking Sonnet exposes low/medium/high — 'max' is Opus-only and
    must NOT leak onto Sonnet at any version."""
    caps = _anthropic().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == _NO_MAX, model
    assert "max" not in caps["thinking_effort_options"], model


@pytest.mark.parametrize(
    "model",
    [
        # Haiku 5.x is adaptive (major>=5) but NOT opus → no 'max'.
        "claude-haiku-5-0",
        "claude-haiku-5-2",
        "claude-haiku-6-0",
    ],
)
def test_anthropic_caps_future_haiku_adaptive_no_max(model):
    caps = _anthropic().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == _NO_MAX, model
    assert "max" not in caps["thinking_effort_options"], model


@pytest.mark.parametrize(
    "model",
    [
        # Legacy extended-thinking (major 4, minor<6) → low/medium/high, no max.
        "claude-opus-4-5",
        "claude-sonnet-4-5",
        "claude-haiku-4-5",
        "claude-opus-4-0",
        "claude-opus-4",        # bare major → minor 0
        # Haiku 4.6: parses adaptive cutoff minor>=6 but haiku is excluded from
        # adaptive → falls through to legacy thinking branch → low/medium/high.
        "claude-haiku-4-6",
        "claude-haiku-4-8",
    ],
)
def test_anthropic_caps_legacy_thinking_no_max(model):
    caps = _anthropic().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == _NO_MAX, model
    assert "max" not in caps["thinking_effort_options"], model


@pytest.mark.parametrize(
    "model",
    [
        "claude-opus-3-5",          # Claude 3 family → no thinking
        "claude-3-opus-20240229",   # alt ordering, major<4 / unparsed → []
        "claude-2.1",
        "gpt-5.4",                  # wrong provider name → unparseable → []
        "not-a-model",
        "",
    ],
)
def test_anthropic_caps_non_thinking_empty(model):
    caps = _anthropic().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == [], model


def test_anthropic_caps_include_max_output_tokens():
    p = _anthropic()
    # Known families map to 64000; unknown falls back to DEFAULT (also 64000).
    assert p.get_model_capabilities("claude-opus-4-6")["max_output_tokens"] == 64000
    assert p.get_model_capabilities("claude-opus-9-9")["max_output_tokens"] == 64000


# ---- Anthropic parser / predicate edge cases ----


def test_anthropic_supports_adaptive_haiku_4_6_excluded():
    """Even at the 4.6 cutoff, haiku is excluded from adaptive (opus/sonnet only)."""
    p = _anthropic()
    assert p._supports_adaptive_thinking("claude-haiku-4-6") is False
    assert p._supports_adaptive_thinking("claude-opus-4-6") is True
    assert p._supports_adaptive_thinking("claude-sonnet-4-6") is True


def test_anthropic_supports_adaptive_minor_threshold():
    """4.5 below the 4.6 adaptive cutoff (off-by-one guard); 4.6 at cutoff."""
    p = _anthropic()
    assert p._supports_adaptive_thinking("claude-opus-4-5") is False
    assert p._supports_adaptive_thinking("claude-opus-4-6") is True


def test_anthropic_supports_thinking_major_threshold():
    """major>=4 supports thinking; Claude 3 does not (off-by-one guard)."""
    p = _anthropic()
    assert p._supports_thinking("claude-opus-3-5") is False
    assert p._supports_thinking("claude-opus-4-0") is True
    assert p._supports_thinking("claude-haiku-4-5") is True


def test_anthropic_is_adaptive_all_families_at_5x():
    from app.llm.providers.anthropic_provider import _is_adaptive_thinking_model
    # At major>=5 ALL families (incl. haiku) become adaptive.
    assert _is_adaptive_thinking_model("claude-haiku-5-0") is True
    assert _is_adaptive_thinking_model("claude-opus-5-0") is True
    assert _is_adaptive_thinking_model("claude-sonnet-5-1") is True


def test_anthropic_parse_family_garbage_none():
    from app.llm.providers.anthropic_provider import _parse_family
    assert _parse_family("gpt-4o") is None
    assert _parse_family("gemini-3-pro") is None
    assert _parse_family("") is None


# ===========================================================================
# Grok — get_model_capabilities
#   Grok exposes a TWO-VALUE effort set ['low','high'] (no 'medium') and ONLY
#   for the mini family (version>=3) via _supports_search/_supports_reasoning_effort.
#   Everything else (base/fast/pro/code, and grok<3 mini) → [].
# ===========================================================================

_GROK_EFFORT = ["low", "high"]


@pytest.mark.parametrize(
    "model",
    [
        "grok-3-mini",
        "grok-4-mini",
        # FUTURE mini (version>=3):
        "grok-5-mini",
        "grok-6-1-mini",
    ],
)
def test_grok_caps_mini_effort_low_high(model):
    """grok mini (version>=3) exposes ['low','high'] — NOTE: no 'medium'."""
    caps = _grok().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == _GROK_EFFORT, model


@pytest.mark.parametrize(
    "model",
    [
        "grok-4",
        "grok-4-0709",
        "grok-4-1",
        "grok-4-1-fast-reasoning",
        "grok-4-1-fast-non-reasoning",
        "grok-5-pro",
        "grok-code-fast-1",
        "grok-2-mini",   # mini but version<3 → no search/effort
        "grok-3",        # base tier, not mini → []
        "grok-foobar",
        "",
    ],
)
def test_grok_caps_non_mini_or_old_empty(model):
    caps = _grok().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == [], model


def test_grok_caps_include_max_output_tokens():
    p = _grok()
    assert p.get_model_capabilities("grok-4")["max_output_tokens"] == 131072
    assert p.get_model_capabilities("grok-2-1212")["max_output_tokens"] == 32768
    # Unknown → DEFAULT.
    assert p.get_model_capabilities("grok-99")["max_output_tokens"] == 32768


# ---- Grok parser / predicate edge cases ----


def test_grok_supports_reasoning_effort_equals_supports_search():
    """_supports_reasoning_effort delegates to _supports_search (mini + v>=3)."""
    p = _grok()
    assert p._supports_reasoning_effort("grok-3-mini") is True
    assert p._supports_reasoning_effort("grok-4-mini") is True
    assert p._supports_reasoning_effort("grok-4-0709") is False
    assert p._supports_reasoning_effort("grok-2-mini") is False


def test_grok_supports_search_version_threshold():
    """Off-by-one guard: grok-2-mini (v<3) no search; grok-3-mini (v>=3) yes."""
    p = _grok()
    assert p._supports_search("grok-2-mini") is False
    assert p._supports_search("grok-3-mini") is True


def test_grok_is_reasoning_version_and_non_reasoning_flag():
    p = _grok()
    # version>=4 → reasoning unless name says non-reasoning.
    assert p._is_reasoning_model("grok-4") is True
    assert p._is_reasoning_model("grok-4-1") is True
    assert p._is_reasoning_model("grok-5-pro") is True
    assert p._is_reasoning_model("grok-4-1-fast-non-reasoning") is False
    # version<4 → not reasoning.
    assert p._is_reasoning_model("grok-3") is False
    assert p._is_reasoning_model("grok-3-mini") is False


def test_grok_parse_code_line_and_future():
    from app.llm.providers.grok_provider import _parse_grok_model
    v, tier, _prio = _parse_grok_model("grok-code-fast-1")
    assert tier == "code"
    v, tier, _prio = _parse_grok_model("grok-5-pro")
    assert (v, tier) == (5.0, "pro")
    # "grok-4-1" minor parsing: 4.1 not 4-then-date.
    v, tier, _prio = _parse_grok_model("grok-4-1")
    assert v == 4.1
    # dated suffix keeps the base version (grok-4-0709 → 4.0, priority dated).
    v, tier, prio = _parse_grok_model("grok-4-0709")
    assert v == 4.0 and prio == 4


# ===========================================================================
# Google — get_model_capabilities
#
# CURRENT behavior (asserted so the suite is green) — but see КАО-FINDING:
#   GoogleProvider._supports_thinking uses a HARDCODED substring list
#   THINKING_MODELS = ["gemini-3", "gemini-2.5-pro", "gemini-2.5-flash"].
#   This is NOT version-agnostic, unlike the other three providers:
#     * gemini-4-pro / gemini-5-pro (future flagships) → thinking == FALSE
#       → thinking_effort_options == []   <-- SERIOUS: a thinking model reports [].
#     * "gemini-3" substring also matches gemini-30/gemini-31 etc. (collision).
#   Thinking-capable models currently return ['low','medium','high','max'].
# ===========================================================================

_GEMINI_FULL = ["low", "medium", "high", "max"]


@pytest.mark.parametrize(
    "model",
    [
        "gemini-3-pro",
        "gemini-3-flash",
        "gemini-3-pro-preview",
        "gemini-3.5-pro",          # matched via 'gemini-3' substring
        "gemini-3.5-flash-lite",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",   # matched via 'gemini-2.5-flash' substring
    ],
)
def test_google_caps_thinking_models_full_set(model):
    """Models that the current substring list recognizes expose the full
    low/medium/high/max thinking set."""
    caps = _google().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == _GEMINI_FULL, model


@pytest.mark.parametrize(
    "model",
    [
        "gemini-2.0-flash",
        "gemini-2.0-flash-lite",
        "gemini-1.5-pro",
        "not-a-gemini",
        "",
    ],
)
def test_google_caps_non_thinking_empty(model):
    caps = _google().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == [], model


@pytest.mark.parametrize("model", ["gemini-4-pro", "gemini-4.0-pro", "gemini-5-pro", "gemini-4-flash"])
def test_google_future_flagship_thinking(model):
    """КАО#VR-32 (was SERIOUS, now FIXED): a FUTURE Gemini 4+/5+ flagship must
    expose the full thinking set. GoogleProvider._supports_thinking is now
    version-agnostic (version>=2.5 + pro/flash/flash-lite tier, via
    _parse_gemini_model) instead of a hardcoded THINKING_MODELS substring list,
    so future majors are recognized without a code edit — matching the other
    three providers.
    """
    caps = _google().get_model_capabilities(model)
    assert caps["thinking_effort_options"] == _GEMINI_FULL, model


def test_google_supports_thinking_high_versions():
    """КАО#VR-32: high future majors (gemini-30/31) are recognized as thinking
    via the version-agnostic predicate (version>=2.5 + pro/flash tier), not a
    brittle 'gemini-3' substring match; 2.0 and below correctly do NOT think."""
    p = _google()
    assert p._supports_thinking("gemini-30-pro") is True
    assert p._supports_thinking("gemini-31-flash") is True
    assert p._supports_thinking("gemini-2.0-pro") is False
    assert p._supports_thinking("gemini-1.5-pro") is False


def test_google_caps_include_max_output_tokens():
    p = _google()
    assert p.get_model_capabilities("gemini-3-pro")["max_output_tokens"] == 65536
    assert p.get_model_capabilities("gemini-2.0-flash")["max_output_tokens"] == 8192
    # Unknown → DEFAULT.
    assert p.get_model_capabilities("gemini-totally-new")["max_output_tokens"] == 8192


# ---- Google parser edge cases (beyond test_dynamic_model_discovery) ----


def test_google_parse_future_version_and_tiers():
    from app.llm.providers.google_provider import _parse_gemini_model
    assert _parse_gemini_model("gemini-4-pro")[:2] == (4.0, "pro")
    assert _parse_gemini_model("gemini-3.5-flash")[:2] == (3.5, "flash")
    # flash-lite must be detected BEFORE flash (ordering guard).
    assert _parse_gemini_model("gemini-3-flash-lite")[1] == "flash-lite"
    # bare 'lite' (no flash) → 'lite' tier.
    assert _parse_gemini_model("gemini-3-lite")[1] == "lite"


def test_google_parse_priority_buckets():
    from app.llm.providers.google_provider import _parse_gemini_model
    assert _parse_gemini_model("gemini-3-pro")[2] == 0          # stable
    assert _parse_gemini_model("gemini-3-pro-preview")[2] == 1  # preview
    assert _parse_gemini_model("gemini-3-pro-latest")[2] == 2   # latest alias
    assert _parse_gemini_model("gemini-3-pro-exp")[2] == 3      # experimental
    assert _parse_gemini_model("gemini-3.1-flash-001")[2] == 4  # dated


def test_google_parse_unrecognized_other_tier():
    from app.llm.providers.google_provider import _parse_gemini_model
    version, tier, _prio = _parse_gemini_model("gemini-foobar")
    assert tier == "other"


# ===========================================================================
# Cross-provider invariants
# ===========================================================================


def test_all_providers_capabilities_have_required_keys():
    """Every provider's get_model_capabilities must return a dict containing
    both 'max_output_tokens' (int) and 'thinking_effort_options' (list)."""
    samples = [
        (_openai(), "gpt-5.4"),
        (_anthropic(), "claude-opus-4-8"),
        (_google(), "gemini-3-pro"),
        (_grok(), "grok-3-mini"),
    ]
    for provider, model in samples:
        caps = provider.get_model_capabilities(model)
        assert isinstance(caps, dict)
        assert isinstance(caps["max_output_tokens"], int)
        assert caps["max_output_tokens"] > 0
        assert isinstance(caps["thinking_effort_options"], list)


def test_thinking_effort_options_are_known_tokens():
    """No provider should ever emit an effort token outside the known vocabulary."""
    known = {"minimal", "low", "medium", "high", "max"}
    cases = [
        (_openai(), "gpt-5.5"),
        (_openai(), "o3"),
        (_anthropic(), "claude-opus-4-8"),
        (_anthropic(), "claude-sonnet-4-8"),
        (_google(), "gemini-3-pro"),
        (_grok(), "grok-3-mini"),
    ]
    for provider, model in cases:
        opts = provider.get_model_capabilities(model)["thinking_effort_options"]
        assert set(opts) <= known, (model, opts)
        # Options must be unique and non-empty strings.
        assert len(opts) == len(set(opts)), (model, opts)


def test_max_effort_only_on_openai_oseries_absent_and_anthropic_opus_google():
    """'max' should appear for Anthropic Opus and Google thinking models, but
    NOT for OpenAI (whose top token is 'high') nor Anthropic Sonnet/Haiku."""
    # OpenAI never emits 'max'.
    assert "max" not in _openai().get_model_capabilities("gpt-5.5")["thinking_effort_options"]
    assert "max" not in _openai().get_model_capabilities("o3")["thinking_effort_options"]
    # Anthropic: opus yes, sonnet/haiku no.
    assert "max" in _anthropic().get_model_capabilities("claude-opus-4-8")["thinking_effort_options"]
    assert "max" not in _anthropic().get_model_capabilities("claude-sonnet-4-8")["thinking_effort_options"]
    # Google thinking models include 'max'.
    assert "max" in _google().get_model_capabilities("gemini-3-pro")["thinking_effort_options"]
    # Grok never emits 'max' (only low/high).
    assert "max" not in _grok().get_model_capabilities("grok-3-mini")["thinking_effort_options"]
