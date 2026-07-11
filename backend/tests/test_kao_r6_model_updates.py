"""КАО#R6-models — tests for the background "new models" detection (Part 2).

Covers:
  - TavilyModelScout ID extraction from raw web content (offline fixture).
  - ModelDiscoveryService baseline diff + lazy-init + acknowledge + the Tavily
    "newer-than-API" augment with version sanity-capping.

No network / no DB: the vendor providers and Tavily are stubbed, and AppSetting
persistence runs against a tiny in-memory fake session.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

pytestmark = pytest.mark.asyncio


# --------------------------------------------------------------------------- #
# TavilyModelScout extraction (pure, offline)
# --------------------------------------------------------------------------- #

async def test_scout_extracts_model_ids_and_drops_noise():
    from app.services.tavily_scout import _extract_ids, _VENDOR_RECIPES

    blob = (
        "Model ID gpt-5.5. A more affordable model gpt-5.4-mini and gpt-5.4-nano. "
        '"id": "gpt-4o-mini-2024-07-18". o3-pro and o4-mini. '
        "text-embedding-3-large, dall-e-3, whisper-1 are not chat models."
    )
    ids = _extract_ids(blob, _VENDOR_RECIPES["openai"]["pattern"])
    assert "gpt-5.5" in ids
    assert "gpt-5.4-mini" in ids
    assert "o3-pro" in ids and "o4-mini" in ids
    # noise filtered
    assert not any("embed" in i or "dall-e" in i or "whisper" in i for i in ids)


# --------------------------------------------------------------------------- #
# Fakes for the detection service
# --------------------------------------------------------------------------- #

class _StubProvider:
    def __init__(self, models):
        self._models = list(models)
        self._fetched_models = list(models)

    async def is_available(self):
        return True

    @property
    def available_models(self):
        return self._models


def _router(**providers):
    return SimpleNamespace(_providers=providers)


class _FakeScout:
    def __init__(self, enabled=False, mapping=None):
        self.enabled = enabled
        self._mapping = mapping or {}

    async def scout(self, provider):
        return list(self._mapping.get(provider, []))


class _FakeDB:
    """Minimal async-session stand-in for a single AppSetting key."""

    def __init__(self):
        self.row = None

    async def execute(self, _stmt):
        row = self.row
        return SimpleNamespace(scalar_one_or_none=lambda: row)

    def add(self, obj):
        self.row = obj

    async def commit(self):
        pass


def _svc(router, scout):
    from app.services.model_discovery import ModelDiscoveryService
    return ModelDiscoveryService(router, scout)


# --------------------------------------------------------------------------- #
# Detection logic
# --------------------------------------------------------------------------- #

async def test_first_run_initialises_baseline_and_reports_nothing():
    svc = _svc(_router(openai=_StubProvider(["gpt-5", "gpt-5.4"])), _FakeScout())
    db = _FakeDB()

    res = await svc.detect_updates(db, force=True)

    assert res["has_updates"] is False
    assert res["providers"]["openai"]["new"] == []
    # baseline persisted == current
    assert db.row.value["baseline"]["openai"] == ["gpt-5", "gpt-5.4"]


async def test_new_model_detected_on_second_run():
    router = _router(openai=_StubProvider(["gpt-5", "gpt-5.4"]))
    svc = _svc(router, _FakeScout())
    db = _FakeDB()
    await svc.detect_updates(db, force=True)  # baseline = {gpt-5, gpt-5.4}

    # A new model ships:
    router._providers["openai"]._models.append("gpt-5.5")

    res = await svc.detect_updates(db, force=True)
    assert res["has_updates"] is True
    assert res["providers"]["openai"]["new"] == ["gpt-5.5"]


async def test_acknowledge_clears_new():
    router = _router(openai=_StubProvider(["gpt-5"]))
    svc = _svc(router, _FakeScout())
    db = _FakeDB()
    await svc.detect_updates(db, force=True)
    router._providers["openai"]._models.append("gpt-5.5")
    assert (await svc.detect_updates(db, force=True))["has_updates"] is True

    await svc.acknowledge(db)  # baseline := current (incl. gpt-5.5)

    res = await svc.detect_updates(db, force=True)
    assert res["has_updates"] is False
    assert res["providers"]["openai"]["new"] == []


async def test_tavily_announced_only_when_strictly_newer():
    # API has up to grok-4.3; Tavily mentions grok-4.5 (newer) + grok-4.2 (older)
    # + grok-420-reasoning (date/artefact → must be capped out).
    router = _router(grok=_StubProvider(["grok-4.3"]))
    scout = _FakeScout(enabled=True, mapping={"grok": ["grok-4.5", "grok-4.2", "grok-420-reasoning"]})
    svc = _svc(router, scout)
    db = _FakeDB()

    res = await svc.detect_updates(db, force=True)
    announced = res["providers"]["grok"]["announced"]
    assert announced == ["grok-4.5"]
    assert res["has_updates"] is True
    assert res["tavily_enabled"] is True


async def test_acknowledged_announced_does_not_renag():
    """КАО#R6 — an announced item (not in the API, can't enter the baseline) must
    stop re-notifying after the user acknowledges it."""
    router = _router(grok=_StubProvider(["grok-4.3"]))
    scout = _FakeScout(enabled=True, mapping={"grok": ["grok-4.5"]})
    svc = _svc(router, scout)
    db = _FakeDB()

    res1 = await svc.detect_updates(db, force=True)
    assert res1["providers"]["grok"]["announced"] == ["grok-4.5"]
    assert res1["has_updates"] is True

    await svc.acknowledge(db)

    res2 = await svc.detect_updates(db, force=True)
    assert res2["providers"]["grok"]["announced"] == []
    assert res2["has_updates"] is False


async def test_no_tavily_when_disabled():
    router = _router(grok=_StubProvider(["grok-4.3"]))
    svc = _svc(router, _FakeScout(enabled=False, mapping={"grok": ["grok-9.9"]}))
    db = _FakeDB()
    res = await svc.detect_updates(db, force=True)
    assert res["tavily_enabled"] is False
    assert res["providers"]["grok"]["announced"] == []


async def test_version_cap_rejects_date_derived_versions():
    from app.services.model_discovery import _version_of
    assert _version_of("anthropic", "claude-sonnet-4-20250514-v1") is None  # date as minor
    assert _version_of("grok", "grok-420-reasoning") is None                # 420, not 4.20
    assert _version_of("openai", "gpt-5.4") == pytest.approx(5.04)
    assert _version_of("grok", "grok-4.5") == pytest.approx(4.5)
