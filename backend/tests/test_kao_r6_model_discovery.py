"""КАО#R6-models — regression tests for provider model discovery.

The user reported that "Refresh models" surfaces only ONE of several new
models per vendor (e.g. for ChatGPT only 1 of 3 new gpt-5.x models). Root
cause: OpenAIProvider.is_available() keyed every gpt-* model into a single
family slot "gpt", so gpt-5 / 5.1 / 5.2 / 5.4 / 5.5 collapsed to one (gpt,
base) slot and only the newest survived.

These tests drive the REAL discovery logic with a synthetic models.list()
(shaped like the live OpenAI /v1/models response) and assert that every
current version surfaces, while dated snapshots / obsolete / non-chat models
are still filtered out.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, PropertyMock, patch

import pytest

pytestmark = pytest.mark.asyncio


def _fake_models_response(ids):
    # created just needs to be present + sortable; dated snapshots get a
    # slightly newer created so priority (alias vs dated) is what decides.
    data = [SimpleNamespace(id=i, created=1_700_000_000 + n) for n, i in enumerate(ids)]
    return SimpleNamespace(data=data)


# A realistic slice of the live OpenAI catalog (see the Tavily probe of
# developers.openai.com): several concurrent gpt-5.x versions + tiers, dated
# snapshots, o-series, and non-chat/obsolete noise that must be filtered.
LIVE_LIKE_IDS = [
    "gpt-5.6-luna", "gpt-5.6-sol",   # same-version NAMED variants — both must show
    "gpt-5.5", "gpt-5.5-pro",
    "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
    "gpt-5.2", "gpt-5.2-pro",
    "gpt-5.1",
    "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-pro",
    "gpt-5-2025-08-07",        # dated snapshot → should collapse to alias gpt-5
    "gpt-4.1", "gpt-4.1-mini",
    "gpt-3.5-turbo",           # obsolete → dropped
    "o3", "o3-pro", "o4-mini",
    "text-embedding-3-large",  # non-chat → dropped
    "dall-e-3",                # non-chat → dropped
    "chatgpt-4o-latest",       # not a parseable API coding model → dropped
    "gpt-5.1-codex",           # codex → dropped (different API)
]


async def _discover(ids):
    try:
        from app.llm.providers.openai_provider import OpenAIProvider
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"openai provider not importable: {exc!r}")

    prov = OpenAIProvider(api_key="test-key")
    prov.refresh_registry_pricing = AsyncMock()  # no DB in unit test

    mock_client = MagicMock()
    mock_client.models.list = AsyncMock(return_value=_fake_models_response(ids))
    with patch.object(type(prov), "client", new_callable=PropertyMock, return_value=mock_client):
        ok = await prov.is_available()
    assert ok is True
    return prov._fetched_models or []


async def test_all_current_gpt5_versions_surface():
    """The core "1 of 3" fix — every distinct current gpt-5.x base model shows."""
    models = await _discover(LIVE_LIKE_IDS)
    for expected in ["gpt-5.5", "gpt-5.4", "gpt-5.2", "gpt-5.1", "gpt-5"]:
        assert expected in models, f"{expected} missing from {models}"


async def test_tier_variants_surface():
    models = await _discover(LIVE_LIKE_IDS)
    for expected in ["gpt-5.5-pro", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5-pro"]:
        assert expected in models, f"{expected} missing from {models}"


async def test_dated_snapshot_collapses_to_alias():
    models = await _discover(LIVE_LIKE_IDS)
    assert "gpt-5" in models
    assert "gpt-5-2025-08-07" not in models  # alias preferred over dated snapshot


async def test_obsolete_and_noise_filtered():
    models = await _discover(LIVE_LIKE_IDS)
    for junk in [
        "gpt-3.5-turbo", "text-embedding-3-large", "dall-e-3",
        "chatgpt-4o-latest", "gpt-5.1-codex",
    ]:
        assert junk not in models, f"{junk} should have been filtered"


async def test_o_series_present_and_distinct():
    models = await _discover(LIVE_LIKE_IDS)
    assert "o3" in models
    assert "o4-mini" in models
    assert "o3-pro" in models


async def test_no_regression_single_version_still_works():
    """A vendor with one model per tier must still return exactly those."""
    models = await _discover(["gpt-5", "gpt-5-mini"])
    assert "gpt-5" in models and "gpt-5-mini" in models


async def test_gpt_ordered_before_o_series():
    models = await _discover(LIVE_LIKE_IDS)
    gpt_idx = [i for i, m in enumerate(models) if m.startswith("gpt")]
    o_idx = [i for i, m in enumerate(models) if m.startswith("o")]
    assert max(gpt_idx) < min(o_idx), f"gpt should precede o-series: {models}"


async def test_same_version_named_variants_both_surface():
    """КАО#R6 — gpt-5.6-luna and gpt-5.6-sol are distinct 5.6 variants; the old
    parser mapped both to (5,6,base) so only one survived. Both must show now."""
    models = await _discover(LIVE_LIKE_IDS)
    assert "gpt-5.6-luna" in models, models
    assert "gpt-5.6-sol" in models, models


async def test_anthropic_generic_family_parsing():
    """КАО#R6 — Anthropic family name is generic, not a hardcoded opus/sonnet/
    haiku list, so a NEW family (claude-fable-5, returned by /v1/models) is no
    longer silently dropped."""
    try:
        from app.llm.providers.anthropic_provider import _parse_family
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"anthropic provider not importable: {exc!r}")
    assert _parse_family("claude-fable-5") == ("fable", 5, 0)
    assert _parse_family("claude-opus-4-8") == ("opus", 4, 8)
    assert _parse_family("claude-sonnet-4-6-2025") == ("sonnet", 4, 6)
    assert _parse_family("not-a-claude-model") is None
