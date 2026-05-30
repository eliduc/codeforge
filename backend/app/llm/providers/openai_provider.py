"""OpenAI LLM provider with GPT-5.4 and reasoning effort support."""

import logging
import re
import time
from typing import Any

import httpx
from openai import AsyncOpenAI, APIError, APIConnectionError, RateLimitError

from app.llm.base import BaseLLMProvider, LLMError, LLMResponse
from app.llm import registry as model_registry

logger = logging.getLogger(__name__)


# KAO#VR-32 — version-agnostic OpenAI model parser.
# Matches gpt-5, gpt-5.4, gpt-5.4-pro, gpt-5-mini, gpt-6, etc.
# Returns (major, minor, tier) where tier ∈ {"pro", "base", "mini", "nano"}.
_GPT_RE = re.compile(r"^gpt-(\d+)(?:\.(\d+))?(?:-(pro|mini|nano|chat|search|preview))?", re.IGNORECASE)
# O-series reasoning models: o1, o3, o4-mini, o3-pro, etc.
_O_RE = re.compile(r"^(o\d+)(?:-(mini|pro|preview))?", re.IGNORECASE)


def _parse_openai_model(name: str) -> tuple[int, int, str] | None:
    """Parse an OpenAI model name into (major, minor, tier).

    Examples:
      gpt-5            → (5, 0,  "base")
      gpt-5.4          → (5, 4,  "base")
      gpt-5.4-pro      → (5, 4,  "pro")
      gpt-5-mini       → (5, 0,  "mini")
      gpt-5-nano       → (5, 0,  "nano")
      o3               → (3, 0,  "base")  (using o-series, major-only)
      o3-pro           → (3, 0,  "pro")
      o4-mini          → (4, 0,  "mini")
      gpt-4o           → None  (no version digit after gpt- → not modern chat)
    """
    n = name.lower().strip()
    m = _GPT_RE.match(n)
    if m:
        major = int(m.group(1))
        minor = int(m.group(2) or 0)
        tier_raw = (m.group(3) or "").lower()
        tier = tier_raw if tier_raw in ("pro", "mini", "nano") else "base"
        return (major, minor, tier)
    m = _O_RE.match(n)
    if m:
        # o-series uses the leading digit as the "major" (o3 → 3, o4 → 4).
        head = m.group(1).lower()
        try:
            major = int(head[1:])
        except ValueError:
            return None
        tier_raw = (m.group(2) or "").lower()
        tier = tier_raw if tier_raw in ("pro", "mini") else "base"
        return (major, 0, tier)
    return None


def _supports_responses_api(model: str) -> bool:
    """KAO#VR-32 — predicate replacing hardcoded RESPONSES_API_MODELS list.

    Any ``gpt-X.Y-pro`` / ``gpt-X-pro`` AND o-series ``oN-pro`` (o3-pro,
    o4-pro) variant uses the Responses API. КАО#VR-32 — o-series '-pro' was
    previously missed, so o3-pro fell through to the Chat Completions path
    (and would likely 400). The '-pro' SUFFIX is still required (anchored $),
    so 'gpt-5-pro-preview' stays on Chat Completions.
    """
    return bool(re.search(r"(?:gpt-\d+(?:\.\d+)?|o\d+)-pro$", model.lower()))


def _supports_reasoning_effort(model: str) -> bool:
    """KAO#VR-32 — predicate replacing hardcoded REASONING_EFFORT_MODELS list.

    Reasoning-effort is supported by every gpt-X.Y/gpt-X-mini/gpt-X-nano
    chat model (not pro), and by o-series reasoning models. Excludes
    legacy gpt-4 and older.
    """
    parsed = _parse_openai_model(model)
    if not parsed:
        return False
    major, _minor, tier = parsed
    name_lower = model.lower()
    # o-series reasoning models always support it.
    if name_lower.startswith("o"):
        return True
    # gpt-X.Y / gpt-X-mini / gpt-X-nano (NOT -pro, which uses Responses API).
    if tier == "pro":
        return False
    # Require major >= 5 to avoid catching legacy gpt-3 / gpt-4 lines.
    return major >= 5


class OpenAIProvider(BaseLLMProvider):
    """OpenAI API provider with GPT-5.4 reasoning and Chat Completions."""

    # KAO#VR-32 — replaced with version-agnostic _parse_openai_model().
    # Last-resort fallback (used when both the live API fetch AND the
    # models.dev registry are unreachable). Bare family names — no version.
    CODE_MODELS = [
        "gpt-5",
        "gpt-5-mini",
        "o3",
        "o4-mini",
    ]

    # Pricing per 1M tokens (input, output) or (input, output, reasoning).
    # Kept as fallback when models.dev registry enrichment is unavailable.
    PRICING = {
        # GPT-5.4 (latest flagship)
        "gpt-5.4": (3.00, 12.00),
        # GPT-5.2
        "gpt-5.2": (2.50, 10.00),
        "gpt-5.2-codex": (2.50, 10.00),
        # GPT-5.1
        "gpt-5.1": (2.50, 10.00),
        "gpt-5.1-codex": (2.50, 10.00),
        # GPT-5 variants
        "gpt-5": (2.00, 8.00),
        "gpt-5-mini": (0.40, 1.60),
        # O-series reasoning models (input, output, reasoning)
        "o3": (2.00, 8.00, 8.00),
        "o3-pro": (20.00, 80.00, 80.00),
        "o3-mini": (1.10, 4.40, 4.40),
        "o4-mini": (1.10, 4.40, 4.40),
    }

    # KAO#VR-32 — RESPONSES_API_MODELS replaced by _supports_responses_api() predicate.
    # KAO#VR-32 — REASONING_EFFORT_MODELS replaced by _supports_reasoning_effort() predicate.

    # Max output tokens per model family
    MAX_OUTPUT_TOKENS: dict[str, int] = {
        "o3": 100000,
        "o4": 100000,
        "o1": 100000,
        "gpt-5.4": 32768,
        "gpt-5.2": 32768,
        "gpt-5.1": 32768,
        "gpt-5": 16384,
        "gpt-5-mini": 16384,
    }
    DEFAULT_MAX_OUTPUT = 16384

    def get_max_output_tokens(self, model: str) -> int:
        """Return the max allowed output tokens for a given OpenAI model."""
        model_lower = model.lower()
        # КАО#VR-59 — version-agnostic first: o-series → 100k; GPT-5.1+ (any
        # future minor) → 32768; base GPT-5 / mini / nano → 16384. The old
        # substring table under-reported future minors (gpt-5.5 matched
        # "gpt-5" → 16384 instead of the 5.x-class 32768).
        parsed = _parse_openai_model(model)
        if parsed:
            major, minor, tier = parsed
            if model_lower.startswith("o"):
                return 100000
            if major >= 5:
                if tier in ("mini", "nano"):
                    return 16384
                return 32768 if minor >= 1 else 16384
        for family, limit in self.MAX_OUTPUT_TOKENS.items():
            if family in model_lower:
                return limit
        return self.DEFAULT_MAX_OUTPUT

    def get_model_capabilities(self, model: str) -> dict:
        """Return per-model reasoning effort options for OpenAI."""
        caps: dict = {"max_output_tokens": self.get_max_output_tokens(model)}
        if _supports_responses_api(model):
            # КАО#VR-32 — '-pro' models (gpt-*-pro AND o*-pro) use the Responses
            # API path, which this client does not pass reasoning_effort to —
            # advertise no effort options so the UI matches what generate() honors.
            caps["thinking_effort_options"] = []
        elif self._is_reasoning_model(model):
            # o-series pure-reasoning models (o1/o3/o4…): low/medium/high.
            caps["thinking_effort_options"] = ["low", "medium", "high"]
        elif self._supports_reasoning_effort(model):
            # КАО#VR-59 — GPT-5+ chat models expose OpenAI's full reasoning_effort
            # set, which adds "minimal" below "low" (previously capped at
            # [low, medium], under-reporting the model's real capability).
            # LOCKSTEP INVARIANT: every level listed here is offered in the
            # node-settings "Thinking" select, so generate()'s thinking_effort
            # effort_map MUST map each one to a non-None reasoning_effort —
            # otherwise the UI shows the level but the API silently ignores it
            # and falls back to its medium default. (The earlier note here that
            # generate() "passes any effort value straight through" was wrong for
            # this UI path: thinking_effort goes through effort_map.get(), which
            # had no "minimal" key and collapsed high→medium until the VR-59 fix.)
            caps["thinking_effort_options"] = ["minimal", "low", "medium", "high"]
        else:
            caps["thinking_effort_options"] = []
        return caps

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        super().__init__(api_key, base_url)
        self._client: AsyncOpenAI | None = None
        self._fetched_models: list[str] | None = None

    @property
    def name(self) -> str:
        return "openai"

    @property
    def available_models(self) -> list[str]:
        if self._fetched_models:
            return self._fetched_models
        return self.CODE_MODELS

    @property
    def client(self) -> AsyncOpenAI:
        if self._client is None:
            self._client = AsyncOpenAI(
                api_key=self.api_key,
                base_url=self.base_url,
                max_retries=0,
                timeout=httpx.Timeout(600.0, connect=30.0),
            )
        return self._client

    async def close(self) -> None:
        """Close the underlying OpenAI client."""
        if self._client is not None:
            await self._client.close()
            self._client = None

    def _uses_responses_api(self, model: str) -> bool:
        """Check if model requires Responses API. KAO#VR-32 — predicate-based."""
        return _supports_responses_api(model)

    def _is_reasoning_model(self, model: str) -> bool:
        """Check if model is a reasoning model that doesn't support temperature.

        KAO#VR-32 — version-agnostic: matches any o-series (o1, o3, o4, o5, ...).
        """
        return bool(re.match(r"^o\d+(-|$)", model.lower()))

    def _supports_reasoning_effort(self, model: str) -> bool:
        """Check if model supports the reasoning effort parameter.

        KAO#VR-32 — delegates to module-level predicate (no hardcoded list).
        """
        return _supports_reasoning_effort(model)

    async def is_available(self) -> bool:
        """Check availability and fetch models from API.

        KAO#VR-32 — version-agnostic discovery. Models are parsed by
        ``_parse_openai_model`` into ``(major, minor, tier)`` and grouped by
        ``(family_key, tier)`` where family_key is the highest (major,minor)
        seen on that tier. No hardcoded version strings — works for gpt-6,
        gpt-5.7, o5, o4-pro, etc. as OpenAI ships them.
        """
        if not self.api_key:
            return False
        try:
            models_response = await self.client.models.list()

            # Best-per-(family, tier) → (model_id, priority, created)
            # family is the highest (major, minor) seen overall per tier.
            # Tier slots: "base", "mini", "nano", "pro" + o-series.
            best: dict[tuple[str, str], tuple[str, int, str, tuple[int, int, str]]] = {}

            for model in models_response.data:
                model_id = model.id
                model_lower = model_id.lower()

                # Skip non-chat / non-supported APIs.
                if any(x in model_lower for x in [
                    'embed', 'dall-e', 'whisper', 'tts', 'audio',
                    'moderation', 'realtime', 'image', 'transcribe',
                    'codex',          # Codex models use /v1/completions
                    'deep-research',  # Deep research models use /v1/responses only
                    'search',         # Search API models
                ]):
                    continue

                parsed = _parse_openai_model(model_id)
                if not parsed:
                    continue
                major, minor, tier = parsed

                # Tier-specific family key. For gpt-X.Y-tier, the family key
                # is "gpt-X" — so we only surface the LATEST minor per tier
                # (gpt-5.4 wins over gpt-5.1 for the "gpt"+"base" slot).
                if model_lower.startswith("o"):
                    family_key = f"o{major}"  # o3, o4, o5 — keep distinct
                else:
                    family_key = "gpt"
                slot = (family_key, tier)

                # Priority: latest alias (0) > no dated suffix (1) > dated (2).
                if 'latest' in model_lower:
                    priority = 0
                elif not (model_id.split('-')[-1].isdigit() and len(model_id.split('-')[-1]) >= 8):
                    priority = 1
                else:
                    priority = 2
                created = str(model.created) if hasattr(model, 'created') else ""

                existing = best.get(slot)
                if existing is None:
                    best[slot] = (model_id, priority, created, parsed)
                else:
                    _eid, eprio, ecreated, eparsed = existing
                    # Prefer higher (major, minor); tie-break on priority then created.
                    new_key = (parsed[0], parsed[1], -priority, created)
                    old_key = (eparsed[0], eparsed[1], -eprio, ecreated)
                    if new_key > old_key:
                        best[slot] = (model_id, priority, created, parsed)

            # Tier preference order — base first (flagship), then mini/nano, pro last.
            tier_rank = {"base": 0, "mini": 1, "nano": 2, "pro": 3}
            # Family preference — gpt before o-series in the UI.
            family_rank = {"gpt": 0}

            ordered = sorted(
                best.items(),
                key=lambda kv: (
                    family_rank.get(kv[0][0], 1),  # gpt then o-series
                    tier_rank.get(kv[0][1], 99),
                    -kv[1][3][0],  # newer major first
                    -kv[1][3][1],  # newer minor first
                ),
            )
            result = [meta[0] for _slot, meta in ordered]

            if result:
                self._fetched_models = result
                logger.info(f"OpenAI: found {len(result)} models: {result}")

            return True

        except Exception as e:
            logger.warning(f"OpenAI models fetch failed: {e}")
            return False

    async def get_pricing(self, model: str) -> tuple[float, float] | None:
        """KAO#VR-32 — pricing lookup with registry fallback."""
        if model in self.PRICING:
            costs = self.PRICING[model]
            return (costs[0], costs[1])
        try:
            reg = await model_registry.get_pricing("openai", model)
            if reg is not None:
                return reg
        except Exception:  # noqa: BLE001
            pass
        model_lower = model.lower()
        for pid, costs in self.PRICING.items():
            if model_lower.startswith(pid.lower()):
                return (costs[0], costs[1])
        return None

    async def _generate_responses_api(
        self,
        prompt: str,
        model: str,
        max_tokens: int,
        system_prompt: str | None = None,
        request_timeout: float | None = None,
    ) -> LLMResponse | LLMError:
        """Generate using Responses API for Pro models."""
        start_time = time.time()

        try:
            create_kwargs: dict[str, Any] = {
                "model": model,
                "input": prompt,
                "max_output_tokens": max_tokens,
            }

            if system_prompt:
                create_kwargs["instructions"] = system_prompt

            if request_timeout is not None:
                create_kwargs["timeout"] = httpx.Timeout(request_timeout, connect=30.0)
            response = await self.client.responses.create(**create_kwargs)
            latency_ms = int((time.time() - start_time) * 1000)

            content = response.output_text if hasattr(response, 'output_text') else ""

            input_tokens = output_tokens = reasoning_tokens = 0
            if hasattr(response, 'usage'):
                input_tokens = getattr(response.usage, 'input_tokens', 0)
                output_tokens = getattr(response.usage, 'output_tokens', 0)
                # Extract reasoning tokens from output_tokens_details if available
                details = getattr(response.usage, 'output_tokens_details', None)
                if details:
                    reasoning_tokens = getattr(details, 'reasoning_tokens', 0) or 0

            return LLMResponse(
                content=content,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                model=model,
                provider=self.name,
                latency_ms=latency_ms,
                raw_response=response.model_dump() if hasattr(response, 'model_dump') else {},
                thinking_tokens=reasoning_tokens,
            )

        except Exception as e:
            return LLMError(
                message=str(e),
                provider=self.name,
                model=model,
                error_type="api",
                retryable=False,
                raw_error=e,
            )

    async def _generate_chat_completions(
        self,
        prompt: str,
        model: str,
        temperature: float,
        max_tokens: int,
        system_prompt: str | None = None,
        reasoning_effort: str | None = None,
        request_timeout: float | None = None,
        request_json_mode: bool = False,
    ) -> LLMResponse | LLMError:
        """Generate using Chat Completions API."""
        start_time = time.time()

        try:
            messages = []
            if system_prompt:
                if self._is_reasoning_model(model):
                    messages.append({"role": "developer", "content": system_prompt})
                else:
                    messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": prompt})

            create_kwargs: dict[str, Any] = {
                "model": model,
                "messages": messages,
            }

            # Parameter handling based on model type
            is_reasoning = self._is_reasoning_model(model)
            has_effort = reasoning_effort and reasoning_effort != "none"

            if is_reasoning:
                # O-series: no temperature, use max_completion_tokens
                create_kwargs["max_completion_tokens"] = max_tokens
                if has_effort:
                    create_kwargs["reasoning_effort"] = reasoning_effort
            elif self._supports_reasoning_effort(model) and has_effort:
                # GPT-5.x with reasoning enabled: no temperature
                create_kwargs["max_completion_tokens"] = max_tokens
                create_kwargs["reasoning_effort"] = reasoning_effort
            elif 'gpt-5' in model.lower():
                # GPT-5.x without reasoning: use max_completion_tokens, no temperature
                # (gpt-5.2, gpt-5-mini do not support the temperature parameter)
                create_kwargs["max_completion_tokens"] = max_tokens
            else:
                # Legacy models
                create_kwargs["max_tokens"] = max_tokens
                create_kwargs["temperature"] = temperature

            # JSON mode: GPT-4o / GPT-4o-mini / GPT-5.x / o-series all support
            # response_format={"type":"json_object"}. Safe to set unconditionally
            # for modern OpenAI chat-completion models.
            if request_json_mode:
                create_kwargs["response_format"] = {"type": "json_object"}

            if request_timeout is not None:
                create_kwargs["timeout"] = httpx.Timeout(request_timeout, connect=30.0)
            response = await self.client.chat.completions.create(**create_kwargs)
            latency_ms = int((time.time() - start_time) * 1000)

            if not response.choices:
                return LLMError(
                    message="Empty choices in response",
                    provider=self.name,
                    model=model,
                    error_type="empty_response",
                    retryable=True,
                )

            content = response.choices[0].message.content or ""

            # Extract reasoning tokens from completion_tokens_details
            reasoning_tokens = 0
            if response.usage and hasattr(response.usage, 'completion_tokens_details'):
                details = response.usage.completion_tokens_details
                if details:
                    reasoning_tokens = getattr(details, 'reasoning_tokens', 0) or 0

            return LLMResponse(
                content=content,
                input_tokens=response.usage.prompt_tokens if response.usage else 0,
                output_tokens=response.usage.completion_tokens if response.usage else 0,
                model=model,
                provider=self.name,
                latency_ms=latency_ms,
                raw_response=response.model_dump(),
                thinking_tokens=reasoning_tokens,
            )

        except RateLimitError as e:
            return LLMError(message=str(e), provider=self.name, model=model, error_type="rate_limit", retryable=True, raw_error=e)
        except APIConnectionError as e:
            return LLMError(message=str(e), provider=self.name, model=model, error_type="connection", retryable=True, raw_error=e)
        except APIError as e:
            return LLMError(message=str(e), provider=self.name, model=model, error_type="api", retryable=False, raw_error=e)
        except Exception as e:
            return LLMError(message=str(e), provider=self.name, model=model, error_type="unknown", retryable=False, raw_error=e)

    async def generate(
        self,
        prompt: str,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        thinking_effort: str | None = None,
        request_timeout: float | None = None,
        reasoning_effort: str | None = None,
        request_json_mode: bool = False,
        **kwargs: Any,
    ) -> LLMResponse | LLMError:
        """Generate response using appropriate API based on model type."""

        # Map unified thinking_effort to OpenAI reasoning_effort
        effective_effort = reasoning_effort
        if thinking_effort and not effective_effort:
            if self._is_reasoning_model(model):
                # O-series: low/medium/high (no "minimal" tier — clamp to low)
                effort_map = {"minimal": "low", "low": "low", "medium": "medium", "high": "high", "max": "high"}
            else:
                # КАО#VR-59 — GPT-5+ Chat Completions support OpenAI's full
                # reasoning_effort set (minimal/low/medium/high). The old map
                # dropped "minimal" and collapsed high/max→medium, so the
                # node-settings UI (which offers minimal/low/medium/high for
                # GPT-5.x) silently didn't honor those choices. OpenAI has no
                # "max", so clamp max→high.
                effort_map = {"minimal": "minimal", "low": "low", "medium": "medium", "high": "high", "max": "high"}
            effective_effort = effort_map.get(thinking_effort)

        if self._uses_responses_api(model):
            return await self._generate_responses_api(
                prompt=prompt,
                model=model,
                max_tokens=max_tokens,
                system_prompt=system_prompt,
                request_timeout=request_timeout,
            )
        else:
            return await self._generate_chat_completions(
                prompt=prompt,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                system_prompt=system_prompt,
                reasoning_effort=effective_effort,
                request_timeout=request_timeout,
                request_json_mode=request_json_mode,
            )
