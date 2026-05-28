"""xAI Grok LLM provider with Grok 4 and reasoning support."""

import logging
import re
import time
from typing import Any

import httpx

from app.llm.base import BaseLLMProvider, LLMError, LLMResponse
from app.llm import registry as model_registry

logger = logging.getLogger(__name__)


# KAO#VR-32 — version-agnostic Grok model parser.
# Matches: grok-4, grok-4-1, grok-4-0709, grok-4.1-fast-reasoning,
# grok-3-mini, grok-code-fast-1, grok-5-pro, etc.
# Minor version is 1-2 digits ONLY (so "grok-4-1" → 4.1 but
# "grok-4-0709" → 4.0 with a date suffix, not 4.0709).
_GROK_VERSION_RE = re.compile(r"grok[-_]?(\d+(?:\.\d+|-\d{1,2}(?=-|$))?)", re.IGNORECASE)
_GROK_CODE_RE = re.compile(r"grok[-_]?code", re.IGNORECASE)
# Any 4+ digit run anywhere in the name (e.g. -0709, -20251022) is a date.
_DATED_SUFFIX_RE = re.compile(r"-\d{3,}(?:-|$)")


def _parse_grok_model(name: str) -> tuple[float, str, int]:
    """Parse a Grok model id into (version, tier, priority).

    Returns:
      version  — float (4.0, 4.1, 3.0, ...). "grok-4-1" → 4.1, "grok-4" → 4.0
      tier     — "pro" | "mini" | "fast" | "code" | "vision" | "base"
      priority — 0=stable, 1=preview, 3=exp, 4=dated (lower=better)

    Examples:
      grok-4-0709                 → (4.0, "base", 4)   # dated
      grok-4-1                    → (4.1, "base", 0)
      grok-4-1-fast-reasoning     → (4.1, "fast", 0)
      grok-3-mini                 → (3.0, "mini", 0)
      grok-code-fast-1            → (0.0, "code", 0)   # special-case code line
      grok-5-pro                  → (5.0, "pro",  0)
      grok-foobar                 → (0.0, "base", 0)
    """
    n = name.lower()

    # grok-code-* is its own product line (not really versioned by number).
    if _GROK_CODE_RE.search(n):
        tier = "code"
        # Try to extract a trailing version (grok-code-fast-1 → 1.0).
        v_match = re.search(r"-(\d+(?:\.\d+)?)$", n)
        version = float(v_match.group(1)) if v_match else 0.0
        # Dated suffix detection still applies.
        if _DATED_SUFFIX_RE.search(n):
            priority = 4
        elif "preview" in n:
            priority = 1
        elif "exp" in n or "experimental" in n:
            priority = 3
        else:
            priority = 0
        return (version, tier, priority)

    v_match = _GROK_VERSION_RE.search(n)
    if v_match:
        raw = v_match.group(1).replace("-", ".")
        try:
            version = float(raw)
        except ValueError:
            version = 0.0
    else:
        version = 0.0

    # Tier extraction — order matters (most specific first).
    if "pro" in n:
        tier = "pro"
    elif "mini" in n:
        tier = "mini"
    elif "fast" in n:
        tier = "fast"
    elif "vision" in n:
        tier = "vision"
    else:
        tier = "base"

    # Priority.
    if "preview" in n:
        priority = 1
    elif "-exp" in n or "experimental" in n:
        priority = 3
    elif _DATED_SUFFIX_RE.search(n):
        priority = 4
    else:
        priority = 0
    return (version, tier, priority)


class GrokProvider(BaseLLMProvider):
    """xAI Grok API provider with Grok 4 and reasoning support."""

    # KAO#VR-32 — replaced with version-agnostic _parse_grok_model().
    # Last-resort fallback only used when both the live API fetch AND the
    # models.dev registry are unreachable. Pure family names — no versions.
    CODE_MODELS = [
        "grok-pro",
        "grok-code",
        "grok-mini",
    ]

    # Pricing per 1M tokens (input, output)
    PRICING = {
        # Grok 4.1 family (latest)
        "grok-4-1-fast-reasoning": (2.00, 10.00),
        "grok-4-1-fast-non-reasoning": (2.00, 10.00),
        # Grok 4 family
        "grok-4": (6.00, 30.00),
        "grok-4-fast-reasoning": (2.00, 10.00),
        "grok-4-fast-non-reasoning": (2.00, 10.00),
        # Grok Code
        "grok-code-fast-1": (2.00, 10.00),
        # Grok 3 family
        "grok-3": (3.00, 15.00),
        "grok-3-mini": (0.30, 1.50),
        # Grok 2 family
        "grok-2-1212": (2.00, 10.00),
        "grok-2-vision-1212": (2.00, 10.00),
    }

    # KAO#VR-32 — REASONING_MODELS removed; _is_reasoning_model() uses
    # _parse_grok_model() to detect any Grok 4+ family (version-agnostic).

    BASE_URL = "https://api.x.ai/v1"

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        super().__init__(api_key, base_url)
        self.base_url = base_url or self.BASE_URL
        self._fetched_models: list[str] | None = None
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=30.0))

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    @property
    def name(self) -> str:
        return "grok"

    @property
    def available_models(self) -> list[str]:
        if self._fetched_models:
            return self._fetched_models
        return self.CODE_MODELS

    def _is_reasoning_model(self, model: str) -> bool:
        """Check if model has reasoning capabilities.

        KAO#VR-32 — version-agnostic: Grok 4+ is reasoning unless the name
        explicitly says "non-reasoning". Works for grok-4, grok-4-1,
        grok-5-pro, etc.
        """
        model_lower = model.lower()
        if "non-reasoning" in model_lower:
            return False
        version, _tier, _priority = _parse_grok_model(model)
        return version >= 4.0

    def _supports_reasoning_effort(self, model: str) -> bool:
        """Check if model supports reasoning_effort parameter.

        KAO#VR-32 — Grok mini family (version >= 3). Grok 4 models do NOT
        support reasoning_effort — passing it causes an error.
        """
        return self._supports_search(model)

    def _supports_search(self, model: str) -> bool:
        """Check if model supports live search (grok-N-mini, N>=3).

        KAO#VR-32 — version-agnostic. Replaces the hardcoded
        ``'grok-3-mini' in model.lower()`` check.
        """
        version, tier, _priority = _parse_grok_model(model)
        return tier == "mini" and version >= 3.0

    # Max output tokens per model family
    MAX_OUTPUT_TOKENS: dict[str, int] = {
        "grok-4": 131072,
        "grok-code": 131072,
        "grok-3": 131072,
        "grok-2": 32768,
    }
    DEFAULT_MAX_OUTPUT = 32768

    def get_max_output_tokens(self, model: str) -> int:
        """Return the max allowed output tokens for a given Grok model."""
        model_lower = model.lower()
        for family, limit in self.MAX_OUTPUT_TOKENS.items():
            if family in model_lower:
                return limit
        return self.DEFAULT_MAX_OUTPUT

    def get_model_capabilities(self, model: str) -> dict:
        """Return per-model reasoning effort options for Grok."""
        caps: dict = {"max_output_tokens": self.get_max_output_tokens(model)}
        if self._supports_reasoning_effort(model):
            caps["thinking_effort_options"] = ["low", "high"]
        else:
            caps["thinking_effort_options"] = []
        return caps

    async def is_available(self) -> bool:
        """Check availability and fetch models from API.

        KAO#VR-32 — version-agnostic discovery. Parses each model id with
        ``_parse_grok_model``, groups by ``(version, tier)`` keeping the
        best-priority entry per slot, sorts by (newer version desc, tier
        preference). No hardcoded family names — grok-5-pro, grok-4-2-fast,
        etc. are picked up automatically.
        """
        if not self.api_key:
            return False
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    f"{self.base_url}/models",
                    headers={"Authorization": f"Bearer {self.api_key}"},
                )
                if response.status_code == 200:
                    data = response.json()
                    models = data.get("data", [])

                    # Best per (version, tier, has_reasoning_qualifier).
                    # has_reasoning_qualifier distinguishes
                    # grok-4-fast-reasoning vs grok-4-fast-non-reasoning so
                    # both show up if the API lists both.
                    best: dict[tuple[float, str, str], tuple[dict, int]] = {}

                    for m in models:
                        model_id = m["id"]
                        model_lower = model_id.lower()

                        # Skip non-text models. Vision is allowed (text + image).
                        if any(x in model_lower for x in ['embed', 'image', 'audio', 'video']):
                            if 'vision' not in model_lower:
                                continue

                        version, tier, base_priority = _parse_grok_model(model_id)
                        if version <= 0.0 and tier == "base":
                            continue  # unrecognized
                        # Reasoning-qualifier — distinguish reasoning vs non-reasoning fast variants.
                        if "non-reasoning" in model_lower:
                            qualifier = "non-reasoning"
                        elif "reasoning" in model_lower:
                            qualifier = "reasoning"
                        else:
                            qualifier = ""

                        slot = (version, tier, qualifier)

                        # Priority refinement: "latest" alias beats anything.
                        if "latest" in model_lower:
                            priority = -1
                        else:
                            priority = base_priority

                        existing = best.get(slot)
                        if existing is None or priority < existing[1]:
                            best[slot] = (m, priority)
                        elif priority == existing[1]:
                            if m.get("created", 0) > existing[0].get("created", 0):
                                best[slot] = (m, priority)

                    # Sort: newest version first, then tier preference, then qualifier.
                    tier_rank = {"base": 0, "pro": 1, "fast": 2, "code": 3, "mini": 4, "vision": 5}
                    qualifier_rank = {"reasoning": 0, "": 1, "non-reasoning": 2}
                    ordered = sorted(
                        best.items(),
                        key=lambda kv: (
                            -kv[0][0],  # newer version first
                            tier_rank.get(kv[0][1], 99),
                            qualifier_rank.get(kv[0][2], 99),
                        ),
                    )
                    result = [meta[0]["id"] for _slot, meta in ordered]

                    logger.info(f"Grok: found {len(result)} models: {result}")
                    self._fetched_models = result if result else self.CODE_MODELS
                    return True

                logger.warning(f"Grok models API returned {response.status_code}")
                return False

        except Exception as e:
            logger.warning(f"Grok models fetch failed: {e}")
            return False

    async def get_pricing(self, model: str) -> tuple[float, float] | None:
        """KAO#VR-32 — pricing lookup with registry fallback (xAI on models.dev)."""
        if model in self.PRICING:
            return self.PRICING[model]
        try:
            reg = await model_registry.get_pricing("xai", model)
            if reg is not None:
                return reg
        except Exception:  # noqa: BLE001
            pass
        model_lower = model.lower()
        for pid, costs in self.PRICING.items():
            if model_lower.startswith(pid.lower()):
                return costs
        return None

    async def generate(
        self,
        prompt: str,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        thinking_effort: str | None = None,
        request_timeout: float | None = None,
        request_json_mode: bool = False,
        **kwargs: Any,
    ) -> LLMResponse | LLMError:
        """Generate response using Grok."""
        start_time = time.time()

        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})

        try:
            request_body: dict[str, Any] = {
                "model": model,
                "messages": messages,
                "max_tokens": max_tokens,
            }

            # Grok exposes an OpenAI-compatible response_format. The newer
            # Grok 4.x models accept JSON object mode.
            if request_json_mode:
                request_body["response_format"] = {"type": "json_object"}

            # Grok 4 reasoning models don't use temperature
            if not self._is_reasoning_model(model):
                request_body["temperature"] = temperature

            # grok-3-mini supports reasoning_effort: "low" or "high"
            if self._supports_reasoning_effort(model) and thinking_effort:
                effort_map = {"low": "low", "medium": "low", "high": "high", "max": "high"}
                effort = effort_map.get(thinking_effort)
                if effort:
                    request_body["reasoning_effort"] = effort

            # Per-request timeout override
            post_kwargs: dict[str, Any] = {
                "headers": {
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                "json": request_body,
            }
            if request_timeout is not None:
                post_kwargs["timeout"] = httpx.Timeout(request_timeout, connect=30.0)

            response = await self._client.post(
                f"{self.base_url}/chat/completions",
                **post_kwargs,
            )

            latency_ms = int((time.time() - start_time) * 1000)

            if response.status_code == 429:
                return LLMError(
                    message="Rate limit exceeded",
                    provider=self.name,
                    model=model,
                    error_type="rate_limit",
                    retryable=True,
                )

            if response.status_code != 200:
                return LLMError(
                    message=f"xAI returned status {response.status_code}: {response.text}",
                    provider=self.name,
                    model=model,
                    error_type="api",
                    retryable=response.status_code >= 500,
                )

            try:
                data = response.json()
            except (ValueError, KeyError) as json_err:
                logger.error(f"xAI response is not valid JSON: {json_err}")
                return LLMError(
                    message=f"Invalid JSON in xAI response: {json_err}",
                    provider=self.name,
                    model=model,
                    error_type="parse_error",
                    retryable=True,
                )
            try:
                content = data["choices"][0]["message"]["content"]
            except (KeyError, IndexError) as e:
                return LLMError(
                    message=f"Unexpected response structure: {e}",
                    provider=self.name,
                    model=model,
                    error_type="parse_error",
                    retryable=False,
                    raw_error=e,
                )
            usage = data.get("usage", {})

            # Extract reasoning tokens from completion_tokens_details
            reasoning_tokens = 0
            details = usage.get("completion_tokens_details")
            if details:
                reasoning_tokens = details.get("reasoning_tokens", 0) or 0

            return LLMResponse(
                content=content,
                input_tokens=usage.get("prompt_tokens", 0),
                output_tokens=usage.get("completion_tokens", 0),
                model=model,
                provider=self.name,
                latency_ms=latency_ms,
                raw_response=data,
                thinking_tokens=reasoning_tokens,
            )

        except httpx.TimeoutException as e:
            return LLMError(
                message=f"Request timed out: {e}",
                provider=self.name,
                model=model,
                error_type="timeout",
                retryable=True,
                raw_error=e,
            )
        except httpx.ConnectError as e:
            return LLMError(
                message=f"Failed to connect: {e}",
                provider=self.name,
                model=model,
                error_type="connection",
                retryable=True,
                raw_error=e,
            )
        except Exception as e:
            return LLMError(
                message=str(e),
                provider=self.name,
                model=model,
                error_type="unknown",
                retryable=False,
                raw_error=e,
            )
