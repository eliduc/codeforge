"""Anthropic LLM provider with Claude 4.6 adaptive thinking support."""

import asyncio
import logging
import time
from typing import Any

import httpx
from anthropic import AsyncAnthropic, APIError, APIConnectionError, RateLimitError, APIStatusError

from app.llm.base import BaseLLMProvider, LLMError, LLMResponse

logger = logging.getLogger(__name__)


class AnthropicProvider(BaseLLMProvider):
    """Anthropic Claude API provider with Claude 4.6 adaptive thinking."""

    # Fallback models (latest first)
    CODE_MODELS = [
        "claude-sonnet-4-6",
        "claude-opus-4-6",
    ]

    # Pricing per 1M tokens (input, output, thinking)
    PRICING = {
        # Claude 4.6 family (latest)
        "claude-opus-4-6": (5.00, 25.00, 25.00),
        "claude-sonnet-4-6": (3.00, 15.00, 15.00),
        # Claude 4.5 family
        "claude-opus-4-5": (5.00, 25.00, 25.00),
        "claude-sonnet-4-5": (3.00, 15.00, 15.00),
        "claude-haiku-4-5": (1.00, 5.00, 5.00),
    }

    # Models that support extended thinking (all Claude 4+ models)
    THINKING_MODELS = [
        "opus-4-6", "sonnet-4-6",
        "opus-4-5", "sonnet-4-5", "haiku-4-5",
    ]

    # Models that support adaptive thinking (4.6 only)
    ADAPTIVE_THINKING_MODELS = ["opus-4-6", "sonnet-4-6"]

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
                timeout=httpx.Timeout(None, connect=30.0),
            )
        return self._client

    async def close(self) -> None:
        """Close the underlying Anthropic client."""
        if self._client is not None:
            await self._client.close()
            self._client = None

    def _supports_thinking(self, model: str) -> bool:
        """Check if model supports extended thinking."""
        model_lower = model.lower()
        return any(tm in model_lower for tm in self.THINKING_MODELS)

    def _supports_adaptive_thinking(self, model: str) -> bool:
        """Check if model supports adaptive thinking (4.6+)."""
        model_lower = model.lower()
        return any(tm in model_lower for tm in self.ADAPTIVE_THINKING_MODELS)

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

                    # Classify models into families
                    families: dict[str, tuple[dict, int, str]] = {}

                    for m in models:
                        model_id = m.get("id", "")
                        model_lower = model_id.lower()

                        # Determine family
                        family = None
                        if "opus-4-6" in model_lower or "opus-4.6" in model_lower:
                            family = "opus-4.6"
                        elif "sonnet-4-6" in model_lower or "sonnet-4.6" in model_lower:
                            family = "sonnet-4.6"
                        elif "opus-4-5" in model_lower or "opus-4.5" in model_lower:
                            family = "opus-4.5"
                        elif "sonnet-4-5" in model_lower or "sonnet-4.5" in model_lower:
                            family = "sonnet-4.5"
                        elif "haiku-4-5" in model_lower or "haiku-4.5" in model_lower:
                            family = "haiku-4.5"

                        if not family:
                            continue

                        # Priority: latest alias (0) > no date (1) > dated (2)
                        if "latest" in model_lower:
                            priority = 0
                        elif not any(c.isdigit() for c in model_id.split("-")[-1]):
                            priority = 1
                        else:
                            priority = 2

                        created = m.get("created_at", "")

                        if family not in families:
                            families[family] = (m, priority, created)
                        elif priority < families[family][1]:
                            families[family] = (m, priority, created)
                        elif priority == families[family][1] and created > families[family][2]:
                            families[family] = (m, priority, created)

                    # Build result: Sonnet first (best for coding), then Opus
                    preferred_order = [
                        "sonnet-4.6",   # Best for coding (recommended)
                        "opus-4.6",     # Most intelligent
                        "sonnet-4.5",
                        "haiku-4.5",    # Fast / cheap
                        "opus-4.5",
                    ]

                    result = []
                    for fam in preferred_order:
                        if fam in families:
                            result.append(families[fam][0]["id"])

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
        use_thinking: bool = False,
        thinking_budget: int = 10000,
        **kwargs: Any,
    ) -> LLMResponse | LLMError:
        """Generate response with adaptive or extended thinking."""
        start_time = time.time()

        # Clamp max_tokens to provider limit
        model_limit = self._get_max_output_tokens(model)
        if max_tokens > model_limit:
            logger.info(f"Clamping max_tokens {max_tokens} -> {model_limit} for {model}")
            max_tokens = model_limit

        create_kwargs: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "messages": [{"role": "user", "content": prompt}],
        }

        if system_prompt:
            create_kwargs["system"] = system_prompt

        # Thinking configuration
        if self._supports_adaptive_thinking(model):
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
                # Default: adaptive thinking with medium effort (balanced speed/quality).
                # Without explicit effort, the API defaults to high which can be very slow
                # on complex tasks (e.g. Opus 4.6 may exceed 900s).
                create_kwargs["thinking"] = {"type": "adaptive"}
                create_kwargs["output_config"] = {"effort": "medium"}
        elif use_thinking and self._supports_thinking(model):
            # Older models (4.5): use legacy type=enabled + budget_tokens
            create_kwargs["thinking"] = {
                "type": "enabled",
                "budget_tokens": thinking_budget,
            }
        else:
            create_kwargs["temperature"] = temperature

        # Custom retry logic for 529 overloaded errors
        last_error = None
        for attempt in range(self.MAX_OVERLOAD_RETRIES):
            try:
                response = await self.client.messages.create(**create_kwargs)
                latency_ms = int((time.time() - start_time) * 1000)

                # Extract text content (skip thinking blocks)
                content = ""
                for block in response.content:
                    if hasattr(block, "text"):
                        content += block.text

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
                        start_time = time.time()
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
                        start_time = time.time()
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
