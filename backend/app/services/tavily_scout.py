"""КАО#R6-models — Tavily "latest models" scout.

Queries the Tavily web-search REST API against each vendor's own documentation
domains and extracts candidate model IDs from the results. Used to AUGMENT the
authoritative vendor ``/v1/models`` discovery: Tavily surfaces models that were
announced on the web but may not yet appear in (or lag behind) the API, so the
background "new models available" check can flag them.

Per the chosen design (Tavily + validation by API), the caller cross-checks
these candidates against the live vendor API — candidates that are NOT in the
API are reported separately as "announced / not yet available", never offered
as directly-usable model IDs.

Entirely optional: when ``TAVILY_API_KEY`` is unset the scout is disabled and
callers fall back to vendor-API discovery only.
"""
from __future__ import annotations

import logging
import re

import httpx

logger = logging.getLogger(__name__)

_TAVILY_ENDPOINT = "https://api.tavily.com/search"

# Per-vendor scouting recipe: the search query, the vendor's own doc domains
# (so we trust first-party sources), and the regex that recognises that
# vendor's model-ID shape. Keys match LLMProvider values.
_VENDOR_RECIPES: dict[str, dict] = {
    "openai": {
        "query": "OpenAI API latest available models list model IDs gpt",
        "domains": ["platform.openai.com", "developers.openai.com", "openai.com"],
        # gpt-5, gpt-5.4-mini, o3, o4-mini, o3-pro, chatgpt-4o-latest …
        "pattern": r"\b(?:gpt-[0-9][a-z0-9.\-]*|o[0-9][a-z0-9\-]*|chatgpt-[a-z0-9.\-]+)\b",
    },
    "anthropic": {
        "query": "Anthropic Claude API latest models list model IDs",
        "domains": ["docs.anthropic.com", "anthropic.com"],
        "pattern": r"\bclaude-[a-z0-9.\-]+\b",
    },
    "google": {
        "query": "Google Gemini API latest models list model IDs",
        "domains": ["ai.google.dev", "cloud.google.com", "developers.google.com"],
        "pattern": r"\bgemini-[0-9][a-z0-9.\-]*\b",
    },
    "grok": {
        "query": "xAI Grok API latest models list model IDs",
        "domains": ["docs.x.ai", "x.ai"],
        "pattern": r"\bgrok-[0-9][a-z0-9.\-]*\b",
    },
}

# Substrings that mark an extracted token as a non-chat / irrelevant artefact.
_NOISE = (
    "embed", "whisper", "tts", "audio", "dall-e", "dalle", "moderation",
    "realtime", "transcribe", "image", "-vision-", "imagen", "veo",
)


def _clean(token: str) -> str:
    # Trim trailing punctuation / markdown that regex word-boundaries may keep.
    return token.strip().strip(".,);:'\"`").lower()


def _extract_ids(text: str, pattern: str) -> set[str]:
    out: set[str] = set()
    for raw in re.findall(pattern, text, flags=re.IGNORECASE):
        tok = _clean(raw)
        if len(tok) < 3:
            continue
        if any(n in tok for n in _NOISE):
            continue
        out.add(tok)
    return out


class TavilyModelScout:
    """Discovers candidate model IDs per vendor via Tavily web search."""

    def __init__(self, api_key: str | None, *, timeout: float = 20.0):
        self._api_key = api_key or None
        self._timeout = timeout

    @property
    def enabled(self) -> bool:
        return bool(self._api_key)

    async def scout(self, provider_name: str) -> list[str]:
        """Return de-duplicated candidate model IDs for *provider_name*.

        Never raises — on any error (disabled, network, bad response) returns
        an empty list so the caller degrades gracefully to vendor-API-only.
        """
        recipe = _VENDOR_RECIPES.get(provider_name)
        if not self.enabled or recipe is None:
            return []

        payload = {
            "api_key": self._api_key,
            "query": recipe["query"],
            "search_depth": "advanced",
            "max_results": 5,
            "include_domains": recipe["domains"],
        }
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                resp = await client.post(_TAVILY_ENDPOINT, json=payload)
            if resp.status_code != 200:
                logger.warning(
                    "Tavily scout for %s returned HTTP %s", provider_name, resp.status_code
                )
                return []
            data = resp.json()
        except Exception as exc:  # noqa: BLE001 — scouting is best-effort
            logger.warning("Tavily scout for %s failed: %s", provider_name, exc)
            return []

        found: set[str] = set()
        for result in data.get("results", []):
            blob = f"{result.get('title', '')}\n{result.get('content', '')}"
            found |= _extract_ids(blob, recipe["pattern"])
        # Also mine Tavily's synthesised answer, when present.
        if isinstance(data.get("answer"), str):
            found |= _extract_ids(data["answer"], recipe["pattern"])

        return sorted(found)
