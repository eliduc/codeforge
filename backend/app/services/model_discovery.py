"""КАО#R6-models — background "new models available" detection.

Two signals, combined:

1. **Reliable (vendor API):** the current per-provider model list (Part-1
   discovery, i.e. the real ``/v1/models``) diffed against a stored *baseline*
   of what the user has already acknowledged → genuinely NEW usable models.

2. **Augment (Tavily, optional):** candidate model IDs scouted from the web
   that parse to a version STRICTLY NEWER than anything currently in the vendor
   API → "announced / not yet available" heads-up. Validated against the API so
   we never present a non-usable ID as loadable.

State (baseline + cached current/announced + timestamps) lives in a single
``AppSetting`` row so it survives restarts and is shared app-wide (provider keys
are global). Vendor-API and Tavily lookups are TTL-throttled so app-entry
checks stay cheap.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from sqlalchemy import select

from app.db.models import AppSetting

logger = logging.getLogger(__name__)

_STATE_KEY = "model_discovery_state"
_FETCH_TTL_SECONDS = 30 * 60      # re-hit vendor /v1/models at most every 30 min
_TAVILY_TTL_SECONDS = 12 * 60 * 60  # re-scout the web at most twice a day


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _age_seconds(iso: str | None) -> float:
    if not iso:
        return float("inf")
    try:
        return (_now() - datetime.fromisoformat(iso)).total_seconds()
    except (ValueError, TypeError):
        return float("inf")


def _version_of(provider: str, model_id: str) -> float | None:
    """Comparable numeric version for a model ID, or None if unparseable.

    Reuses each provider's own parser so the notion of "newer" matches how the
    provider itself groups models. Versions are sanity-capped: a real model is
    never v>=100, so anything larger is a date/artefact the parser mis-read as a
    version (e.g. "claude-sonnet-4-20250514" → minor 20250514, or "grok-420" →
    420) and is rejected to avoid false "newer than API" alerts.
    """
    v: float | None = None
    try:
        if provider == "openai":
            from app.llm.providers.openai_provider import _parse_openai_model
            p = _parse_openai_model(model_id)
            if p:
                v = p[0] + p[1] / 100
        elif provider == "anthropic":
            from app.llm.providers.anthropic_provider import _parse_family
            p = _parse_family(model_id)
            if p:
                v = p[1] + p[2] / 100
        elif provider == "google":
            from app.llm.providers.google_provider import _parse_gemini_model
            gv, _tier, _prio = _parse_gemini_model(model_id)
            v = gv
        elif provider == "grok":
            from app.llm.providers.grok_provider import _parse_grok_model
            gv, _tier, _prio = _parse_grok_model(model_id)
            v = gv
    except Exception:  # noqa: BLE001 — version parsing is best-effort
        return None
    if v is None or not (0 < v < 100):
        return None
    return v


class ModelDiscoveryService:
    """Detects newly-available / newly-announced models across vendors."""

    def __init__(self, router, scout):
        self._router = router
        self._scout = scout

    # ---- vendor API current lineup -------------------------------------- #

    async def _fetch_current(self, force: bool) -> dict[str, list[str]]:
        """Current models per provider that actually has a key configured."""
        current: dict[str, list[str]] = {}
        for name, provider in getattr(self._router, "_providers", {}).items():
            if name == "ollama":
                continue  # local models — not part of "new vendor model" alerts
            try:
                if force and hasattr(provider, "_fetched_models"):
                    provider._fetched_models = None
                available = await provider.is_available()
                if available:
                    current[name] = list(provider.available_models)
            except Exception as exc:  # noqa: BLE001
                logger.warning("current-models fetch failed for %s: %s", name, exc)
        return current

    # ---- Tavily "announced ahead of API" -------------------------------- #

    async def _scout_announced(self, current: dict[str, list[str]]) -> dict[str, list[str]]:
        announced: dict[str, list[str]] = {}
        if not self._scout.enabled:
            return announced
        for provider, models in current.items():
            try:
                candidates = await self._scout.scout(provider)
            except Exception as exc:  # noqa: BLE001
                logger.warning("tavily scout failed for %s: %s", provider, exc)
                continue
            cur_versions = [v for v in (_version_of(provider, m) for m in models) if v is not None]
            cur_max = max(cur_versions, default=0.0)
            fresh = []
            for cand in candidates:
                if cand in models:
                    continue
                v = _version_of(provider, cand)
                if v is not None and v > cur_max:
                    fresh.append(cand)
            if fresh:
                announced[provider] = sorted(set(fresh))
        return announced

    # ---- state persistence ---------------------------------------------- #

    async def _load_state(self, db) -> dict:
        row = (await db.execute(select(AppSetting).where(AppSetting.key == _STATE_KEY))).scalar_one_or_none()
        return dict(row.value) if row and isinstance(row.value, dict) else {}

    async def _save_state(self, db, state: dict) -> None:
        row = (await db.execute(select(AppSetting).where(AppSetting.key == _STATE_KEY))).scalar_one_or_none()
        if row is None:
            db.add(AppSetting(key=_STATE_KEY, value=state, description="Model discovery baseline + cache"))
        else:
            row.value = state
        await db.commit()

    # ---- public API ------------------------------------------------------ #

    async def detect_updates(self, db, *, force: bool = False) -> dict:
        """Return {providers: {p: {current, new, announced}}, has_updates, ...}.

        First-ever call lazily initialises the baseline to the current lineup and
        reports no updates (the user already knows today's models).
        """
        state = await self._load_state(db)
        baseline: dict[str, list[str]] = state.get("baseline") or {}

        # Refresh the current lineup (TTL-throttled unless forced).
        if force or _age_seconds(state.get("fetched_at")) > _FETCH_TTL_SECONDS:
            current = await self._fetch_current(force=force)
            state["current"] = current
            state["fetched_at"] = _now().isoformat()
        else:
            current = state.get("current") or {}

        # Refresh Tavily "announced" (its own, slower TTL).
        if self._scout.enabled and (force or _age_seconds(state.get("tavily_at")) > _TAVILY_TTL_SECONDS):
            announced = await self._scout_announced(current)
            state["announced"] = announced
            state["tavily_at"] = _now().isoformat()
        else:
            announced = state.get("announced") or {}

        # Lazy baseline init — record today's lineup, notify nothing.
        first_run = not baseline
        if first_run:
            baseline = {p: list(ms) for p, ms in current.items()}
            state["baseline"] = baseline

        providers: dict[str, dict] = {}
        has_updates = False
        for provider, models in current.items():
            base = set(baseline.get(provider, []))
            new = [] if first_run else sorted(m for m in models if m not in base)
            ann = announced.get(provider, [])
            if new or ann:
                has_updates = True
            providers[provider] = {"current": list(models), "new": new, "announced": list(ann)}

        state["checked_at"] = _now().isoformat()
        await self._save_state(db, state)

        return {
            "providers": providers,
            "has_updates": has_updates,
            "tavily_enabled": self._scout.enabled,
            "checked_at": state["checked_at"],
        }

    async def acknowledge(self, db) -> dict:
        """Mark the current lineup as seen — clears the 'new' set."""
        state = await self._load_state(db)
        current = await self._fetch_current(force=True)
        state["current"] = current
        state["fetched_at"] = _now().isoformat()
        state["baseline"] = {p: list(ms) for p, ms in current.items()}
        await self._save_state(db, state)
        return {"acknowledged": True, "providers": list(current.keys())}
