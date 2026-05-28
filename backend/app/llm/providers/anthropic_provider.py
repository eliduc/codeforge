"""Anthropic LLM provider with Claude 4.6 adaptive thinking support."""

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any

import httpx
from anthropic import AsyncAnthropic, APIError, APIConnectionError, RateLimitError, APIStatusError

from app.llm.base import BaseLLMProvider, LLMError, LLMResponse
from app.llm import registry as model_registry


# Regex to extract family + version from any Anthropic model id.
# Matches: claude-opus-4-7, claude-sonnet-4-6-20251022, claude-haiku-5-0, etc.
# Also matches dot-style: claude-opus-4.7
_MODEL_FAMILY_RE = re.compile(
    r"claude[-_]?(opus|sonnet|haiku)[-_]?(\d+)[-._]?(\d+)?",
    re.IGNORECASE,
)


def _parse_family(model_id: str) -> tuple[str, int, int] | None:
    """Extract (family_name, major, minor) from a Claude model id, or None.

    Examples:
        claude-opus-4-7        -> ('opus', 4, 7)
        claude-sonnet-4-6-2025 -> ('sonnet', 4, 6)
        claude-haiku-5-0       -> ('haiku', 5, 0)
        claude-opus-4.7        -> ('opus', 4, 7)
    """
    m = _MODEL_FAMILY_RE.search(model_id)
    if not m:
        return None
    name = m.group(1).lower()
    major = int(m.group(2))
    minor = int(m.group(3) or 0)
    return (name, major, minor)

logger = logging.getLogger(__name__)


# Runtime cache of models that the Anthropic API has rejected for "thinking"
# (adaptive or extended). Populated lazily when a 400 response with one of the
# unsupported-thinking error messages arrives. On subsequent calls we skip the
# thinking config entirely for these models so the workflow never has to take
# the retry path twice for the same model.
_thinking_unsupported_models: set[str] = set()


# Substrings (lowercase, case-insensitive match) in API 400 messages that
# indicate the model rejected our "thinking" config and we should retry the
# request once without thinking.
_THINKING_UNSUPPORTED_MARKERS: tuple[str, ...] = (
    "adaptive thinking is not supported",
    "extended thinking is not supported",
    "thinking is not supported",
)


def _is_thinking_unsupported_error(err: Exception) -> bool:
    """Return True if the Anthropic API error indicates thinking isn't supported.

    We check both the exception message and (defensively) the parsed body, since
    the SDK formats the user-facing message in slightly different shapes across
    versions.
    """
    text = str(err).lower()
    if any(marker in text for marker in _THINKING_UNSUPPORTED_MARKERS):
        return True
    body = getattr(err, "body", None)
    if isinstance(body, dict):
        try:
            inner = body.get("error", {})
            msg = (inner.get("message") if isinstance(inner, dict) else None) or ""
            if any(marker in str(msg).lower() for marker in _THINKING_UNSUPPORTED_MARKERS):
                return True
        except Exception:  # noqa: BLE001 - never let body parsing crash the path
            pass
    return False


def _is_adaptive_thinking_model(model_id: str) -> bool:
    """KAO#VR-32 — version-agnostic predicate for adaptive thinking support.

    Rules (preserving the original semantics):
      * Claude 5.x and beyond — ALL families assumed adaptive.
      * Claude 4.6+ — only Opus and Sonnet (Haiku 4.6 is NOT adaptive).
      * Anything else — False.

    Encoded without naming a specific version, so claude-opus-4-7,
    claude-haiku-6-0, etc. all return True automatically.
    """
    parsed = _parse_family(model_id)
    if not parsed:
        return False
    name, major, minor = parsed
    if major >= 5:
        return True  # all Claude 5.x+ assumed adaptive across families
    if major == 4 and minor >= 6:
        return name in ("opus", "sonnet")
    return False


class AnthropicProvider(BaseLLMProvider):
    """Anthropic Claude API provider with Claude 4.6 adaptive thinking."""

    # KAO#VR-32 — replaced with version-agnostic parser (_parse_family).
    # Last-resort fallback only used when both the live API fetch AND the
    # models.dev registry are unreachable. Listed as bare family names with
    # no version pinned, so we never bake a deprecating version into defaults.
    CODE_MODELS = [
        "claude-opus",
        "claude-sonnet",
        "claude-haiku",
    ]

    # Pricing per 1M tokens (input, output, thinking).
    # Kept as a fallback when models.dev registry enrichment is unavailable.
    PRICING = {
        # Claude 4.6 family (latest)
        "claude-opus-4-6": (5.00, 25.00, 25.00),
        "claude-sonnet-4-6": (3.00, 15.00, 15.00),
        # Claude 4.5 family
        "claude-opus-4-5": (5.00, 25.00, 25.00),
        "claude-sonnet-4-5": (3.00, 15.00, 15.00),
        "claude-haiku-4-5": (1.00, 5.00, 5.00),
    }

    # KAO#VR-32 — replaced with _supports_thinking() predicate that uses
    # _parse_family to detect any Claude 4+ model. No hardcoded list.

    # KAO#VR-32 — replaced with _is_adaptive_thinking_model() predicate.

    def get_max_output_tokens(self, model: str) -> int:
        """Return the max allowed output tokens for a given Anthropic model."""
        return self._get_max_output_tokens(model)

    def get_model_capabilities(self, model: str) -> dict:
        """Return per-model thinking effort options for Anthropic."""
        caps: dict = {"max_output_tokens": self.get_max_output_tokens(model)}
        if self._supports_adaptive_thinking(model):
            # Claude 4.6: adaptive thinking with effort control
            if "opus" in model.lower():
                caps["thinking_effort_options"] = ["low", "medium", "high", "max"]
            else:
                # Sonnet 4.6: "max" not supported
                caps["thinking_effort_options"] = ["low", "medium", "high"]
        elif self._supports_thinking(model):
            # Claude 4.5: legacy extended thinking (budget-based), expose as effort
            caps["thinking_effort_options"] = ["low", "medium", "high"]
        else:
            caps["thinking_effort_options"] = []
        return caps

    # Retry configuration for overloaded errors
    MAX_OVERLOAD_RETRIES = 4
    OVERLOAD_RETRY_DELAYS = [5, 10, 20, 30]

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        super().__init__(api_key, base_url)
        self._client: AsyncAnthropic | None = None
        self._fetched_models: list[str] | None = None

    @property
    def name(self) -> str:
        return "anthropic"

    @property
    def available_models(self) -> list[str]:
        if self._fetched_models:
            return self._fetched_models
        return self.CODE_MODELS

    @property
    def client(self) -> AsyncAnthropic:
        if self._client is None:
            self._client = AsyncAnthropic(
                api_key=self.api_key,
                base_url=self.base_url,
                max_retries=0,
                timeout=httpx.Timeout(600.0, connect=30.0),  # 10 min read timeout to prevent infinite hangs
            )
        return self._client

    async def close(self) -> None:
        """Close the underlying Anthropic client."""
        if self._client is not None:
            await self._client.close()
            self._client = None

    def _supports_thinking(self, model: str) -> bool:
        """Check if model supports extended thinking. All Claude 4+ do.

        KAO#VR-32 — version-agnostic via _parse_family. Returns False for
        Claude 3 and unparseable names (we no longer fall back to a hardcoded
        list — those models are out of support).
        """
        parsed = _parse_family(model)
        if not parsed:
            return False
        _, major, _ = parsed
        return major >= 4

    def _supports_adaptive_thinking(self, model: str) -> bool:
        """Check if model supports adaptive thinking (4.6+ Opus/Sonnet, all 5.x+).

        KAO#VR-32 — delegates to the module-level predicate, which works
        for any future Claude version without code changes.
        """
        return _is_adaptive_thinking_model(model)

    async def get_pricing(self, model: str) -> tuple[float, float] | None:
        """KAO#VR-32 — pricing lookup with registry fallback.

        Order:
          1. Hardcoded ``PRICING`` (fast, no network).
          2. ``models.dev`` registry (async, cached 24h).
          3. Family prefix match against ``PRICING`` (last resort).
        """
        if model in self.PRICING:
            costs = self.PRICING[model]
            return (costs[0], costs[1])
        # Registry enrichment for newly-released model ids.
        try:
            reg = await model_registry.get_pricing("anthropic", model)
            if reg is not None:
                return reg
        except Exception:  # noqa: BLE001
            pass
        # Family-prefix fallback (e.g. claude-opus-4-7 → claude-opus-4-6 pricing).
        model_lower = model.lower()
        for pid, costs in self.PRICING.items():
            if model_lower.startswith(pid.lower()):
                return (costs[0], costs[1])
        return None

    async def is_available(self) -> bool:
        """Check availability and fetch models from API."""
        if not self.api_key:
            return False

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(
                    "https://api.anthropic.com/v1/models",
                    headers={
                        "x-api-key": self.api_key,
                        "anthropic-version": "2023-06-01",
                    },
                )

                if response.status_code == 200:
                    data = response.json()
                    models = data.get("data", [])

                    # Classify models into families using regex (future-proof).
                    # Key: f"{name}-{major}.{minor}" e.g. "opus-4.7", "sonnet-5.0"
                    # Skip Claude 3.x and earlier — only 4.0+ are supported by this provider.
                    MIN_MAJOR = 4
                    families: dict[str, tuple[dict, int, str, tuple[str, int, int]]] = {}

                    for m in models:
                        model_id = m.get("id", "")
                        parsed = _parse_family(model_id)
                        if not parsed:
                            continue
                        name, major, minor = parsed
                        if major < MIN_MAJOR:
                            continue  # skip Claude 3.x and earlier

                        family = f"{name}-{major}.{minor}"
                        model_lower = model_id.lower()

                        # Priority: latest alias (0) > no date (1) > dated (2)
                        if "latest" in model_lower:
                            priority = 0
                        elif not any(c.isdigit() for c in model_id.split("-")[-1]):
                            priority = 1
                        else:
                            priority = 2

                        created = m.get("created_at", "")

                        if family not in families:
                            families[family] = (m, priority, created, parsed)
                        elif priority < families[family][1]:
                            families[family] = (m, priority, created, parsed)
                        elif priority == families[family][1] and created > families[family][2]:
                            families[family] = (m, priority, created, parsed)

                    # Sort families by (newest version desc, then by family preference: sonnet > opus > haiku for coding)
                    family_order = {"sonnet": 0, "opus": 1, "haiku": 2}
                    sorted_families = sorted(
                        families.items(),
                        # Sort key: (-major, -minor, family_order_index)
                        # negative versions = descending; family_order ascending
                        key=lambda kv: (-kv[1][3][1], -kv[1][3][2], family_order.get(kv[1][3][0], 99)),
                    )

                    result = [meta[0]["id"] for _, meta in sorted_families]

                    if result:
                        self._fetched_models = result
                        logger.info(f"Anthropic: found {len(result)} models: {result}")

                    return True
                else:
                    logger.warning(f"Anthropic models API returned {response.status_code}")
                    return False

        except Exception as e:
            logger.warning(f"Anthropic models fetch failed: {e}, using defaults")
            return False

    # Max output tokens per model family
    MAX_OUTPUT_TOKENS = {
        "opus-4-6": 64000,
        "sonnet-4-6": 64000,
        "opus-4-5": 64000,
        "sonnet-4-5": 64000,
        "haiku-4-5": 64000,
    }
    DEFAULT_MAX_OUTPUT = 64000

    def _get_max_output_tokens(self, model: str) -> int:
        """Get the max allowed output tokens for a given model."""
        model_lower = model.lower()
        for family, limit in self.MAX_OUTPUT_TOKENS.items():
            if family in model_lower:
                return limit
        return self.DEFAULT_MAX_OUTPUT

    async def generate(
        self,
        prompt: str,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        thinking_effort: str | None = None,
        request_timeout: float | None = None,
        use_thinking: bool = False,
        thinking_budget: int = 10000,
        request_json_mode: bool = False,
        **kwargs: Any,
    ) -> LLMResponse | LLMError:
        """Generate response with adaptive or extended thinking."""
        start_time = time.time()

        # Clamp max_tokens to provider limit
        model_limit = self._get_max_output_tokens(model)
        if max_tokens > model_limit:
            logger.info(f"Clamping max_tokens {max_tokens} -> {model_limit} for {model}")
            max_tokens = model_limit

        # JSON-mode prefill: starting the assistant turn with "{" forces the
        # model to continue valid JSON. We strip-prepend "{" to the content on
        # the way out so the caller still sees a complete JSON object.
        # Skipped when adaptive/extended thinking is on — prefill is
        # incompatible with the thinking block format.
        json_prefill_active = False

        messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]

        create_kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": messages,
        }

        if system_prompt:
            create_kwargs["system"] = system_prompt

        # Thinking configuration.
        # If we've already learned at runtime that the API rejects "thinking"
        # for this model, bypass all thinking config from the start. This
        # prevents the "Adaptive thinking is not supported on this model"
        # toast-spam after the first failed attempt.
        if model in _thinking_unsupported_models:
            create_kwargs["temperature"] = temperature
        elif self._supports_adaptive_thinking(model):
            # Claude 4.6: use adaptive thinking
            if thinking_effort and thinking_effort != "none":
                create_kwargs["thinking"] = {"type": "adaptive"}
                # Map unified effort to Anthropic effort
                effort_map = {"low": "low", "medium": "medium", "high": "high", "max": "max"}
                effort = effort_map.get(thinking_effort, "high")
                # "max" only supported on Opus 4.6
                if effort == "max" and "opus" not in model.lower():
                    effort = "high"
                create_kwargs["output_config"] = {"effort": effort}
                # Thinking models don't use temperature
            elif thinking_effort == "none":
                # Explicitly disabled — no thinking param, use temperature
                create_kwargs["temperature"] = temperature
            else:
                # Default thinking effort depends on model:
                # - Opus: medium (balanced speed/quality)
                # - Sonnet: low (Sonnet with medium+ spends all 64K tokens on thinking
                #   on complex tasks, producing 0 text output and timing out at ~800s)
                default_effort = "medium" if "opus" in model.lower() else "low"
                create_kwargs["thinking"] = {"type": "adaptive"}
                create_kwargs["output_config"] = {"effort": default_effort}
        elif self._supports_thinking(model):
            # Claude 4.5: use legacy type=enabled + budget_tokens
            if thinking_effort and thinking_effort != "none":
                # Map effort to budget tokens
                effort_budget = {"low": 2048, "medium": 5000, "high": 10000, "max": 10000}
                budget = effort_budget.get(thinking_effort, thinking_budget)
                create_kwargs["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": budget,
                }
            elif use_thinking:
                create_kwargs["thinking"] = {
                    "type": "enabled",
                    "budget_tokens": thinking_budget,
                }
            else:
                create_kwargs["temperature"] = temperature
        else:
            create_kwargs["temperature"] = temperature

        # Apply JSON prefill after thinking config is set. Anthropic does NOT
        # allow assistant prefill messages when extended/adaptive thinking is
        # enabled, so only prefill when no "thinking" key is present.
        if request_json_mode and "thinking" not in create_kwargs:
            messages.append({"role": "assistant", "content": "{"})
            json_prefill_active = True

        # Apply per-request timeout override if provided
        if request_timeout is not None:
            create_kwargs["timeout"] = httpx.Timeout(request_timeout, connect=30.0)

        # Custom retry logic for 529 overloaded errors
        last_error = None
        for attempt in range(self.MAX_OVERLOAD_RETRIES):
            try:
                try:
                    response = await self.client.messages.create(**create_kwargs)
                except APIStatusError as thinking_err:
                    # Detect "thinking is not supported" rejections and retry
                    # ONCE without the thinking config. This handles cases where
                    # our adaptive-thinking heuristic is too optimistic about a
                    # model (e.g. claude-sonnet-4-6 rejects adaptive thinking).
                    if (
                        getattr(thinking_err, "status_code", None) == 400
                        and "thinking" in create_kwargs
                        and _is_thinking_unsupported_error(thinking_err)
                    ):
                        thinking_cfg = create_kwargs.pop("thinking", None)
                        create_kwargs.pop("output_config", None)
                        create_kwargs["temperature"] = temperature
                        thinking_type = (
                            thinking_cfg.get("type", "adaptive")
                            if isinstance(thinking_cfg, dict)
                            else "adaptive"
                        )
                        logger.warning(
                            f"Model {model} does not support {thinking_type} thinking; "
                            f"retrying without thinking"
                        )
                        # Re-attempt the API call ONCE without thinking. If this
                        # still fails, let the exception propagate to the outer
                        # error-handling so a real error gets surfaced.
                        response = await self.client.messages.create(**create_kwargs)
                        # Success — remember this model so future calls skip
                        # thinking config from the start (no second toast).
                        _thinking_unsupported_models.add(model)
                    else:
                        raise
                latency_ms = int((time.time() - start_time) * 1000)

                # Extract text content (skip thinking blocks)
                content = ""
                for block in response.content:
                    if hasattr(block, "text"):
                        content += block.text

                # If we prefilled "{" the API echoes only the continuation —
                # restore the leading brace so callers see complete JSON.
                if json_prefill_active and not content.lstrip().startswith("{"):
                    content = "{" + content

                # Extract thinking tokens from usage if available
                thinking_tokens = 0
                usage_dict = response.usage.model_dump() if hasattr(response.usage, 'model_dump') else {}
                if 'cache_creation_input_tokens' in usage_dict:
                    # Anthropic reports thinking via separate field when extended thinking is on
                    pass
                # Check for thinking tokens in the usage metadata
                thinking_tokens = getattr(response.usage, 'thinking_tokens', 0) or 0

                stop_reason = getattr(response, 'stop_reason', None)

                # --- Thinking overflow detection & automatic retry ---
                # When adaptive thinking is enabled the model may consume the
                # entire max_tokens budget on thinking, leaving too few tokens
                # for the actual text response.  Two scenarios:
                #   1) Empty content: all tokens went to thinking
                #   2) Truncated content: some text produced but cut off
                # In both cases, retry with lower thinking effort.
                if (
                    stop_reason == "max_tokens"
                    and "thinking" in create_kwargs
                ):
                    is_empty = not content.strip()
                    label = "empty" if is_empty else "truncated"
                    logger.warning(
                        f"Thinking overflow ({label} text): stop_reason=max_tokens "
                        f"(output_tokens={response.usage.output_tokens}, "
                        f"thinking_tokens={thinking_tokens}, model={model}, "
                        f"content_len={len(content)}). "
                        f"Retrying with thinking_effort=low..."
                    )
                    retry_kwargs = dict(create_kwargs)
                    retry_kwargs["output_config"] = {"effort": "low"}
                    # Bump max_tokens on retry to give more room for text output
                    orig_max = retry_kwargs.get("max_tokens", 32768)
                    retry_kwargs["max_tokens"] = max(orig_max, 64000)
                    try:
                        response = await self.client.messages.create(**retry_kwargs)
                        latency_ms = int((time.time() - start_time) * 1000)
                        retry_content = ""
                        for block in response.content:
                            if hasattr(block, "text"):
                                retry_content += block.text
                        if json_prefill_active and retry_content and not retry_content.lstrip().startswith("{"):
                            retry_content = "{" + retry_content
                        thinking_tokens = getattr(response.usage, 'thinking_tokens', 0) or 0
                        stop_reason = getattr(response, 'stop_reason', None)
                        logger.info(
                            f"Thinking overflow retry result: "
                            f"content_len={len(retry_content)}, stop_reason={stop_reason}"
                        )
                        # Use retry content if it's longer (better) or original was empty
                        if is_empty or len(retry_content) > len(content):
                            content = retry_content
                        else:
                            logger.info(
                                f"Keeping original content ({len(content)} chars) "
                                f"over retry ({len(retry_content)} chars)"
                            )
                    except Exception as retry_err:
                        logger.error(f"Thinking overflow retry failed: {retry_err}")

                return LLMResponse(
                    content=content,
                    input_tokens=response.usage.input_tokens,
                    output_tokens=response.usage.output_tokens,
                    model=model,
                    provider=self.name,
                    latency_ms=latency_ms,
                    raw_response=response.model_dump(),
                    thinking_tokens=thinking_tokens,
                    stop_reason=stop_reason,
                )

            except APIStatusError as e:
                if e.status_code == 529:
                    last_error = e
                    if attempt < self.MAX_OVERLOAD_RETRIES - 1:
                        delay = self.OVERLOAD_RETRY_DELAYS[min(attempt, len(self.OVERLOAD_RETRY_DELAYS) - 1)]
                        logger.warning(
                            f"Anthropic API overloaded (529), model={model}, "
                            f"retry {attempt + 1}/{self.MAX_OVERLOAD_RETRIES} in {delay}s..."
                        )
                        await asyncio.sleep(delay)
                        # NOTE: Do NOT reset start_time here — latency should
                        # reflect total wall-clock time including retries/waits.
                        continue
                    else:
                        total_wait = sum(self.OVERLOAD_RETRY_DELAYS[:self.MAX_OVERLOAD_RETRIES - 1])
                        logger.error(
                            f"Anthropic API overloaded after {self.MAX_OVERLOAD_RETRIES} retries "
                            f"(~{total_wait}s total wait), model={model}"
                        )
                        return LLMError(
                            message=f"API overloaded after {self.MAX_OVERLOAD_RETRIES} retries (~{total_wait}s wait). Try again later or use a different model.",
                            provider=self.name,
                            model=model,
                            error_type="overloaded",
                            retryable=True,
                            raw_error=e,
                        )
                elif e.status_code >= 500:
                    last_error = e
                    if attempt < self.MAX_OVERLOAD_RETRIES - 1:
                        delay = self.OVERLOAD_RETRY_DELAYS[min(attempt, len(self.OVERLOAD_RETRY_DELAYS) - 1)]
                        logger.warning(
                            f"Anthropic API error {e.status_code}, model={model}, "
                            f"retry {attempt + 1}/{self.MAX_OVERLOAD_RETRIES} in {delay}s..."
                        )
                        await asyncio.sleep(delay)
                        continue
                    else:
                        return LLMError(
                            message=f"Server error {e.status_code} after {self.MAX_OVERLOAD_RETRIES} retries: {e}",
                            provider=self.name,
                            model=model,
                            error_type="server_error",
                            retryable=True,
                            raw_error=e,
                        )
                else:
                    return LLMError(
                        message=str(e),
                        provider=self.name,
                        model=model,
                        error_type="api_status",
                        retryable=False,
                        raw_error=e,
                    )
            except RateLimitError as e:
                return LLMError(message=str(e), provider=self.name, model=model, error_type="rate_limit", retryable=True, raw_error=e)
            except APIConnectionError as e:
                return LLMError(message=str(e), provider=self.name, model=model, error_type="connection", retryable=True, raw_error=e)
            except APIError as e:
                return LLMError(message=str(e), provider=self.name, model=model, error_type="api", retryable=False, raw_error=e)
            except Exception as e:
                return LLMError(message=str(e), provider=self.name, model=model, error_type="unknown", retryable=False, raw_error=e)

        # Fallback if all retries exhausted
        return LLMError(
            message=f"All retries exhausted: {last_error}",
            provider=self.name,
            model=model,
            error_type="overloaded",
            retryable=True,
            raw_error=last_error,
        )

    async def generate_stream(
        self,
        prompt: str,
        model: str,
        on_chunk: Callable[[str], Awaitable[None]],
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        thinking_effort: str | None = None,
        request_timeout: float | None = None,
        use_thinking: bool = False,
        thinking_budget: int = 10000,
        **kwargs: Any,
    ) -> LLMResponse | LLMError:
        """Streaming variant — calls ``on_chunk`` for each text delta.

        This is a proof-of-concept implementation. It uses the Anthropic
        ``messages.stream`` API to get incremental text deltas. Thinking
        configuration mirrors :meth:`generate` but the overflow-retry path
        is intentionally simplified — if the stream completes with truncated
        output, we return what we have rather than restarting from scratch.

        Errors fall back to a non-streaming :meth:`generate` call so callers
        always get a usable response (no silent regressions vs. baseline).
        """
        start_time = time.time()

        # Clamp max_tokens to provider limit (same as generate)
        model_limit = self._get_max_output_tokens(model)
        if max_tokens > model_limit:
            max_tokens = model_limit

        create_kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system_prompt:
            create_kwargs["system"] = system_prompt

        # Thinking config (mirrors generate)
        if self._supports_adaptive_thinking(model):
            if thinking_effort and thinking_effort != "none":
                create_kwargs["thinking"] = {"type": "adaptive"}
                effort_map = {"low": "low", "medium": "medium", "high": "high", "max": "max"}
                effort = effort_map.get(thinking_effort, "high")
                if effort == "max" and "opus" not in model.lower():
                    effort = "high"
                create_kwargs["output_config"] = {"effort": effort}
            elif thinking_effort == "none":
                create_kwargs["temperature"] = temperature
            else:
                default_effort = "medium" if "opus" in model.lower() else "low"
                create_kwargs["thinking"] = {"type": "adaptive"}
                create_kwargs["output_config"] = {"effort": default_effort}
        elif self._supports_thinking(model):
            if thinking_effort and thinking_effort != "none":
                effort_budget = {"low": 2048, "medium": 5000, "high": 10000, "max": 10000}
                budget = effort_budget.get(thinking_effort, thinking_budget)
                create_kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
            elif use_thinking:
                create_kwargs["thinking"] = {"type": "enabled", "budget_tokens": thinking_budget}
            else:
                create_kwargs["temperature"] = temperature
        else:
            create_kwargs["temperature"] = temperature

        if request_timeout is not None:
            create_kwargs["timeout"] = httpx.Timeout(request_timeout, connect=30.0)

        try:
            full_text = ""
            async with self.client.messages.stream(**create_kwargs) as stream:
                async for delta in stream.text_stream:
                    full_text += delta
                    try:
                        await on_chunk(delta)
                    except Exception as cb_err:  # noqa: BLE001
                        # A failing UI callback must not abort the LLM call.
                        logger.warning(f"Streaming on_chunk callback raised: {cb_err}")
                message = await stream.get_final_message()

            latency_ms = int((time.time() - start_time) * 1000)

            # If text_stream produced nothing (e.g. all tokens went to thinking),
            # fall back to extracting from the final message content.
            if not full_text:
                for block in message.content:
                    if hasattr(block, "text"):
                        full_text += block.text

            thinking_tokens = getattr(message.usage, "thinking_tokens", 0) or 0
            stop_reason = getattr(message, "stop_reason", None)

            return LLMResponse(
                content=full_text,
                input_tokens=message.usage.input_tokens,
                output_tokens=message.usage.output_tokens,
                model=model,
                provider=self.name,
                latency_ms=latency_ms,
                raw_response=message.model_dump(),
                thinking_tokens=thinking_tokens,
                stop_reason=stop_reason,
            )

        except (APIStatusError, RateLimitError, APIConnectionError, APIError) as e:
            # Streaming-specific errors fall back to the non-streaming path so
            # behavior never regresses below the baseline.
            logger.warning(
                f"Anthropic streaming failed ({type(e).__name__}: {e}); "
                f"falling back to non-streaming generate()."
            )
            response = await self.generate(
                prompt=prompt,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                system_prompt=system_prompt,
                thinking_effort=thinking_effort,
                request_timeout=request_timeout,
                use_thinking=use_thinking,
                thinking_budget=thinking_budget,
                **kwargs,
            )
            if isinstance(response, LLMResponse) and response.content:
                try:
                    await on_chunk(response.content)
                except Exception:  # noqa: BLE001
                    pass
            return response
        except Exception as e:  # noqa: BLE001
            logger.exception(f"Unexpected streaming error: {e}")
            return LLMError(
                message=str(e),
                provider=self.name,
                model=model,
                error_type="streaming_error",
                retryable=False,
                raw_error=e,
            )
