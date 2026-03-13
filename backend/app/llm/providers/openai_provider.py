"""OpenAI LLM provider with GPT-5.2 and reasoning effort support."""

import logging
import time
from typing import Any

import httpx
from openai import AsyncOpenAI, APIError, APIConnectionError, RateLimitError

from app.llm.base import BaseLLMProvider, LLMError, LLMResponse

logger = logging.getLogger(__name__)


class OpenAIProvider(BaseLLMProvider):
    """OpenAI API provider with GPT-5.2 reasoning and Chat Completions."""

    # Fallback models (latest first)
    CODE_MODELS = [
        "gpt-5.2",
        "gpt-5-mini",
    ]

    # Pricing per 1M tokens (input, output) or (input, output, reasoning)
    PRICING = {
        # GPT-5.2 (latest flagship)
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

    # Models that use Responses API (completion-only, not chat)
    RESPONSES_API_MODELS = ["gpt-5.2-pro", "gpt-5.1-pro", "gpt-5-pro"]

    # Models that support reasoning_effort
    REASONING_EFFORT_MODELS = ["gpt-5.2", "gpt-5.1", "gpt-5-mini", "gpt-5", "o3", "o4-mini"]

    # Max output tokens per model family
    MAX_OUTPUT_TOKENS: dict[str, int] = {
        "o3": 100000,
        "o4": 100000,
        "o1": 100000,
        "gpt-5.2": 32768,
        "gpt-5.1": 32768,
        "gpt-5": 16384,
        "gpt-5-mini": 16384,
    }
    DEFAULT_MAX_OUTPUT = 16384

    def get_max_output_tokens(self, model: str) -> int:
        """Return the max allowed output tokens for a given OpenAI model."""
        model_lower = model.lower()
        for family, limit in self.MAX_OUTPUT_TOKENS.items():
            if family in model_lower:
                return limit
        return self.DEFAULT_MAX_OUTPUT

    def get_model_capabilities(self, model: str) -> dict:
        """Return per-model reasoning effort options for OpenAI."""
        caps: dict = {"max_output_tokens": self.get_max_output_tokens(model)}
        if self._is_reasoning_model(model):
            caps["thinking_effort_options"] = ["low", "medium", "high"]
        elif self._supports_reasoning_effort(model):
            caps["thinking_effort_options"] = ["low", "medium"]
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
                timeout=httpx.Timeout(None, connect=30.0),
            )
        return self._client

    async def close(self) -> None:
        """Close the underlying OpenAI client."""
        if self._client is not None:
            await self._client.close()
            self._client = None

    def _uses_responses_api(self, model: str) -> bool:
        """Check if model requires Responses API."""
        model_lower = model.lower()
        for resp_model in self.RESPONSES_API_MODELS:
            if resp_model in model_lower:
                return True
        return False

    def _is_reasoning_model(self, model: str) -> bool:
        """Check if model is a reasoning model that doesn't support temperature."""
        model_lower = model.lower()
        # O-series reasoning models
        if any(rm in model_lower for rm in ["o3", "o4", "o1"]):
            return True
        return False

    def _supports_reasoning_effort(self, model: str) -> bool:
        """Check if model supports the reasoning effort parameter."""
        model_lower = model.lower()
        return any(rm in model_lower for rm in self.REASONING_EFFORT_MODELS)

    async def is_available(self) -> bool:
        """Check availability and fetch models from API."""
        if not self.api_key:
            return False
        try:
            models_response = await self.client.models.list()

            families: dict[str, tuple[str, int, str]] = {}

            for model in models_response.data:
                model_id = model.id
                model_lower = model_id.lower()

                # Skip non-chat models
                if any(x in model_lower for x in [
                    'embed', 'dall-e', 'whisper', 'tts', 'audio',
                    'moderation', 'realtime', 'image', 'transcribe',
                    'codex',          # Codex models use /v1/completions
                    'deep-research',  # Deep research models use /v1/responses only
                ]):
                    continue

                # Determine family
                family = None

                # GPT-5.x families — detect any minor version (5.1, 5.2, 5.3, …)
                import re as _re
                gpt5_match = _re.match(r'gpt-5\.(\d+)', model_lower)
                if gpt5_match:
                    minor = gpt5_match.group(1)
                    base = f"gpt-5.{minor}"
                    if 'pro' in model_lower:
                        family = f"{base}-pro"
                    else:
                        family = base
                # GPT-5 base family (no minor version)
                elif _re.match(r'gpt-5(?!\.\d)', model_lower):
                    if 'search' in model_lower:
                        continue  # Skip search API models
                    elif 'nano' in model_lower:
                        family = "gpt-5-nano"
                    elif 'mini' in model_lower:
                        family = "gpt-5-mini"
                    elif 'pro' in model_lower:
                        family = "gpt-5-pro"
                    else:
                        family = "gpt-5"
                # O-series reasoning
                elif model_lower.startswith('o3'):
                    if 'pro' in model_lower:
                        family = "o3-pro"
                    elif 'mini' in model_lower:
                        family = "o3-mini"
                    else:
                        family = "o3"
                elif model_lower.startswith('o4'):
                    if 'mini' in model_lower:
                        family = "o4-mini"
                    else:
                        family = "o4"

                if not family:
                    continue

                # Priority: latest (0) > no date (1) > dated (2)
                if 'latest' in model_lower:
                    priority = 0
                elif not (model_id.split('-')[-1].isdigit() and len(model_id.split('-')[-1]) >= 8):
                    priority = 1
                else:
                    priority = 2

                created = str(model.created) if hasattr(model, 'created') else ""

                if family not in families:
                    families[family] = (model_id, priority, created)
                elif priority < families[family][1]:
                    families[family] = (model_id, priority, created)
                elif priority == families[family][1] and created > families[family][2]:
                    families[family] = (model_id, priority, created)

            # Build result: keep only latest version per category
            # e.g. if gpt-5.2 exists, skip gpt-5.1
            gpt5x_base = sorted(
                [f for f in families if _re.match(r'gpt-5\.\d+$', f)],
                key=lambda f: float(f.split('-')[1]),
                reverse=True,
            )

            # Only keep the latest gpt-5.x
            latest_base = gpt5x_base[0] if gpt5x_base else None

            preferred_order = []
            if latest_base:
                preferred_order.append(latest_base)
            preferred_order.extend(["gpt-5", "gpt-5-mini", "o3", "o4-mini"])

            result = []
            for fam in preferred_order:
                if fam in families:
                    result.append(families[fam][0])

            if result:
                self._fetched_models = result
                logger.info(f"OpenAI: found {len(result)} models: {result}")

            return True

        except Exception as e:
            logger.warning(f"OpenAI models fetch failed: {e}")
            return False

    async def _generate_responses_api(
        self,
        prompt: str,
        model: str,
        max_tokens: int,
        system_prompt: str | None = None,
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
        reasoning_effort: str | None = None,
        **kwargs: Any,
    ) -> LLMResponse | LLMError:
        """Generate response using appropriate API based on model type."""

        # Map unified thinking_effort to OpenAI reasoning_effort
        effective_effort = reasoning_effort
        if thinking_effort and not effective_effort:
            if self._is_reasoning_model(model):
                # O-series: supports low, medium, high
                effort_map = {"low": "low", "medium": "medium", "high": "high", "max": "high"}
            else:
                # GPT-5.x Chat Completions: gpt-5.2-chat-latest currently only supports "medium"
                effort_map = {"low": "low", "medium": "medium", "high": "medium", "max": "medium"}
            effective_effort = effort_map.get(thinking_effort)

        if self._uses_responses_api(model):
            return await self._generate_responses_api(
                prompt=prompt,
                model=model,
                max_tokens=max_tokens,
                system_prompt=system_prompt,
            )
        else:
            return await self._generate_chat_completions(
                prompt=prompt,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                system_prompt=system_prompt,
                reasoning_effort=effective_effort,
            )
