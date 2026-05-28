"""Base LLM provider interface and common utilities."""

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any


@dataclass
class LLMResponse:
    """Response from an LLM provider."""

    content: str
    input_tokens: int
    output_tokens: int
    model: str
    provider: str
    latency_ms: int
    raw_response: dict[str, Any] | None = None
    thinking_tokens: int = 0
    stop_reason: str | None = None  # "end_turn", "max_tokens", etc.

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens + self.thinking_tokens


@dataclass
class LLMError:
    """Error from an LLM provider."""

    message: str
    provider: str
    model: str
    error_type: str
    retryable: bool = False
    raw_error: Any = None


class BaseLLMProvider(ABC):
    """Abstract base class for LLM providers."""

    # Pricing per 1M tokens: (input, output) or (input, output, thinking)
    PRICING: dict[str, tuple[float, ...]] = {}

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        self.api_key = api_key
        self.base_url = base_url

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider name."""
        pass

    @property
    @abstractmethod
    def available_models(self) -> list[str]:
        """List of available models."""
        pass

    @abstractmethod
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
        """Generate a response from the LLM.

        thinking_effort: unified effort level across providers.
            Values: "low", "medium", "high", "max", or None (provider default).
        request_timeout: per-request timeout in seconds for the HTTP call.
            When provided, overrides the default client timeout for this request.
            Typically set to agent_timeout / 2 to ensure the httpx call finishes
            before the outer agent timeout fires.
        request_json_mode: when True, ask the provider to produce JSON-only
            output using provider-specific mechanisms (OpenAI response_format,
            Anthropic prefill, Gemini response_mime_type). Providers that
            don't support a JSON mode should ignore this flag — the system
            prompt is still expected to steer the model toward JSON.
        """
        pass

    @abstractmethod
    async def is_available(self) -> bool:
        """Check if the provider is available and configured."""
        pass

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
        **kwargs: Any,
    ) -> "LLMResponse | LLMError":
        """Streaming variant — calls ``on_chunk`` for each text delta and
        returns the final ``LLMResponse``.

        Default implementation delegates to ``generate`` and emits the full
        response as a single chunk. Providers that natively support streaming
        (e.g. Anthropic) override this to yield real-time deltas.
        """
        response = await self.generate(
            prompt=prompt,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            system_prompt=system_prompt,
            thinking_effort=thinking_effort,
            request_timeout=request_timeout,
            **kwargs,
        )
        if isinstance(response, LLMResponse) and response.content:
            try:
                await on_chunk(response.content)
            except Exception:  # noqa: BLE001 - callback errors must not break the flow
                pass
        return response

    def calculate_cost(
        self, model: str, input_tokens: int, output_tokens: int, thinking_tokens: int = 0
    ) -> float:
        """Calculate the cost of a request in USD."""
        pricing = None
        # Try exact match first
        if model in self.PRICING:
            pricing = self.PRICING[model]
        else:
            # Try to find matching base model (handle variants like gpt-5.2-chat-latest -> gpt-5.2)
            model_lower = model.lower()
            for pricing_model in self.PRICING:
                if model_lower.startswith(pricing_model.lower()):
                    pricing = self.PRICING[pricing_model]
                    break

        if pricing is None:
            return 0.0

        input_price, output_price = pricing[0], pricing[1]
        thinking_price = pricing[2] if len(pricing) > 2 else output_price
        return (
            input_tokens * input_price
            + output_tokens * output_price
            + thinking_tokens * thinking_price
        ) / 1_000_000

    def get_max_output_tokens(self, model: str) -> int:
        """Return the maximum allowed output tokens for a given model.

        Subclasses should override to provide accurate per-model limits.
        Default: 16384.
        """
        return 16384

    def get_model_capabilities(self, model: str) -> dict[str, Any]:
        """Return capabilities metadata for a given model.

        Returns a dict with at least:
          - thinking_effort_options: list of supported values (e.g. ["low","medium","high"])
                                     empty list means thinking/reasoning not supported
          - max_output_tokens: max allowed output tokens for this model
        Subclasses should override to provide accurate per-model data.
        """
        return {
            "thinking_effort_options": [],
            "max_output_tokens": self.get_max_output_tokens(model),
        }

    def get_all_model_capabilities(self) -> dict[str, dict[str, Any]]:
        """Return capabilities for every available model."""
        return {m: self.get_model_capabilities(m) for m in self.available_models}

    def supports_model(self, model: str) -> bool:
        """Check if the provider supports a given model (exact match, case-insensitive)."""
        model_lower = model.lower()
        return any(model_lower == available.lower() for available in self.available_models)
