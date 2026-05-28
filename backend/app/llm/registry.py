"""KAO#VR-32 — community model registry for cross-checking provider model lists.

Wraps models.dev (https://models.dev/api.json) — a community-maintained
catalog of LLM providers, models, pricing, context windows. Cache the
fetch with a 24h TTL so we don't hit it on every request.

Used by each provider's is_available() as ENRICHMENT only — the provider's
own /models endpoint is still the source of truth for availability.
Registry adds pricing + capability flags that the API doesn't expose.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

logger = logging.getLogger(__name__)

REGISTRY_URL = "https://models.dev/api.json"
CACHE_TTL_SEC = 86400


class _ModelRegistryCache:
    """Async-safe singleton cache for the models.dev registry payload."""

    def __init__(self) -> None:
        self._data: dict[str, Any] | None = None
        self._fetched_at: float = 0.0
        self._lock = asyncio.Lock()

    async def get(self) -> dict[str, Any] | None:
        """Return the cached registry payload, fetching if stale or missing.

        On network failure we log a warning and return the last good payload
        (which may be ``None`` if we never succeeded). Callers must treat
        ``None`` as "registry unavailable; fall back to provider defaults".
        """
        async with self._lock:
            now = time.time()
            if self._data is not None and (now - self._fetched_at) < CACHE_TTL_SEC:
                return self._data
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    r = await client.get(REGISTRY_URL)
                    r.raise_for_status()
                    self._data = r.json()
                    self._fetched_at = now
                    return self._data
            except Exception as e:  # noqa: BLE001
                logger.warning(
                    "models.dev fetch failed: %s; using stale=%s",
                    e,
                    self._data is not None,
                )
                return self._data  # may still be None


_registry = _ModelRegistryCache()


async def get_provider_models(provider_id: str) -> dict[str, dict]:
    """Return ``{model_id: model_dict}`` for a provider, or ``{}`` if unknown.

    ``provider_id`` is the models.dev key (e.g. ``"anthropic"``, ``"openai"``,
    ``"google"``, ``"xai"``).
    """
    data = await _registry.get()
    if not data:
        return {}
    provider_entry = data.get(provider_id) or {}
    models = provider_entry.get("models") or {}
    if isinstance(models, dict):
        return models
    return {}


async def get_pricing(provider_id: str, model_id: str) -> tuple[float, float] | None:
    """Return ``(input_per_M, output_per_M)`` USD for a model, or ``None``.

    Used as an enrichment when our hardcoded ``PRICING`` dict doesn't know a
    model id we just discovered from the provider's live API.
    """
    models = await get_provider_models(provider_id)
    m = models.get(model_id)
    if not m or "cost" not in m:
        return None
    cost = m["cost"]
    if "input" in cost and "output" in cost:
        try:
            return (float(cost["input"]), float(cost["output"]))
        except (TypeError, ValueError):
            return None
    return None


async def get_capabilities(provider_id: str, model_id: str) -> dict[str, Any]:
    """Return raw capability flags from the registry, or ``{}`` if unknown.

    Useful for cross-checking things like ``reasoning``, ``tool_call``, or
    ``modalities`` that the provider's ``/models`` endpoint doesn't expose.
    """
    models = await get_provider_models(provider_id)
    m = models.get(model_id)
    if not m:
        return {}
    return {k: v for k, v in m.items() if k != "cost"}
