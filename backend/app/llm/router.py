"""LLM Router for managing multiple providers with rate limiting."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from app.core.config import settings
from app.llm.base import BaseLLMProvider, LLMError, LLMResponse
from app.llm.providers import (
    AnthropicProvider,
    GoogleProvider,
    GrokProvider,
    OllamaProvider,
    OpenAIProvider,
)

logger = logging.getLogger(__name__)


@dataclass
class RateLimiter:
    """Simple sliding window rate limiter.

    NOTE: This limiter is per-process. In multi-worker deployments
    (uvicorn --workers N), each worker has its own bucket — total
    request rate is approximately rate_per_minute * N. For strict
    global limits, use an external queue (Redis-backed) — not yet
    implemented.

    The asyncio.Lock makes it safe within a single async event loop.
    """

    max_requests: int
    window_seconds: int = 60
    requests: list[datetime] = field(default_factory=list)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def acquire(self) -> bool:
        """Try to acquire a request slot. Returns True if allowed."""
        async with self._lock:
            now = datetime.now(timezone.utc)
            cutoff = now.timestamp() - self.window_seconds

            # Remove old requests
            self.requests = [r for r in self.requests if r.timestamp() > cutoff]

            if len(self.requests) >= self.max_requests:
                return False

            self.requests.append(now)
            return True

    async def wait_and_acquire(self, timeout: float = 60.0) -> bool:
        """Wait until a slot is available or timeout."""
        start = datetime.now(timezone.utc)
        while (datetime.now(timezone.utc) - start).total_seconds() < timeout:
            if await self.acquire():
                return True
            await asyncio.sleep(0.5)
        return False

    @property
    def available_slots(self) -> int:
        """Number of available request slots.

        Note: approximate count without lock — acceptable for display purposes.
        """
        now = datetime.now(timezone.utc)
        cutoff = now.timestamp() - self.window_seconds
        active = len([r for r in self.requests if r.timestamp() > cutoff])
        return max(0, self.max_requests - active)


class LLMRouter:
    """Routes LLM requests to appropriate providers with rate limiting."""

    def __init__(self):
        self._providers: dict[str, BaseLLMProvider] = {}
        self._rate_limiters: dict[str, RateLimiter] = {}
        self._initialized = False
        self._init_lock = asyncio.Lock()

    async def initialize(self) -> None:
        """Initialize all configured providers."""
        if self._initialized:
            return
        async with self._init_lock:
            if self._initialized:
                return  # Double-checked locking

            # Initialize providers based on available API keys
            if settings.openai_api_key and settings.openai_api_key.get_secret_value():
                self._providers["openai"] = OpenAIProvider(api_key=settings.openai_api_key.get_secret_value())
                self._rate_limiters["openai"] = RateLimiter(
                    max_requests=settings.rate_limit_openai
                )

            if settings.anthropic_api_key and settings.anthropic_api_key.get_secret_value():
                self._providers["anthropic"] = AnthropicProvider(
                    api_key=settings.anthropic_api_key.get_secret_value()
                )
                self._rate_limiters["anthropic"] = RateLimiter(
                    max_requests=settings.rate_limit_anthropic
                )

            if settings.google_api_key and settings.google_api_key.get_secret_value():
                self._providers["google"] = GoogleProvider(api_key=settings.google_api_key.get_secret_value())
                self._rate_limiters["google"] = RateLimiter(
                    max_requests=settings.rate_limit_google
                )

            if settings.grok_api_key and settings.grok_api_key.get_secret_value():
                self._providers["grok"] = GrokProvider(api_key=settings.grok_api_key.get_secret_value())
                self._rate_limiters["grok"] = RateLimiter(
                    max_requests=settings.rate_limit_grok
                )

            # Ollama is always available (local)
            self._providers["ollama"] = OllamaProvider(base_url=settings.ollama_base_url)
            self._rate_limiters["ollama"] = RateLimiter(
                max_requests=settings.rate_limit_ollama
            )

            self._initialized = True
            logger.info(f"LLM Router initialized with providers: {list(self._providers.keys())}")

            # Auto-fetch models from APIs on startup
            logger.info("Fetching models from provider APIs...")
            for name, provider in self._providers.items():
                try:
                    available = await provider.is_available()
                    if available:
                        models = provider.available_models
                        logger.info(f"  {name}: {len(models)} models loaded")
                    else:
                        logger.warning(f"  {name}: provider not available")
                except Exception as e:
                    logger.error(f"  {name}: error fetching models - {e}")

    def get_provider(self, provider_name: str) -> BaseLLMProvider | None:
        """Get a provider by name."""
        return self._providers.get(provider_name)

    def get_all_providers(self) -> dict[str, BaseLLMProvider]:
        """Get all available providers."""
        return self._providers.copy()

    async def check_provider_availability(self, provider_name: str) -> bool:
        """Check if a specific provider is available."""
        provider = self._providers.get(provider_name)
        if not provider:
            return False
        return await provider.is_available()

    async def get_available_providers(self) -> list[dict[str, Any]]:
        """Get list of available providers with their models."""
        result = []
        for name, provider in self._providers.items():
            available = await provider.is_available()
            result.append({
                "name": name,
                "available": available,
                "models": provider.available_models,
                "rate_limit": self._rate_limiters[name].max_requests,
                "available_slots": self._rate_limiters[name].available_slots,
            })
        return result

    async def generate(
        self,
        provider: str,
        model: str,
        prompt: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        thinking_effort: str | None = None,
        wait_for_rate_limit: bool = True,
        request_timeout: float | None = None,
        request_json_mode: bool = False,
        **kwargs: Any,
    ) -> LLMResponse | LLMError:
        """Generate a response from the specified provider/model."""
        await self.initialize()

        # Get provider
        llm_provider = self._providers.get(provider)
        if not llm_provider:
            logger.error(f"Provider '{provider}' not found. Available: {list(self._providers.keys())}")
            return LLMError(
                message=f"Provider '{provider}' not found or not configured",
                provider=provider,
                model=model,
                error_type="provider_not_found",
                retryable=False,
            )

        # Check model support — fall back to first available model if requested model is stale
        if not llm_provider.supports_model(model):
            available = llm_provider.available_models
            if available:
                fallback_model = available[0]
                logger.warning(
                    f"Model '{model}' not available for {provider}. "
                    f"Falling back to '{fallback_model}'. Available: {available}"
                )
                model = fallback_model
            else:
                logger.error(f"Model '{model}' not in available models for {provider}: {available}")
                return LLMError(
                    message=f"Model '{model}' not supported by provider '{provider}'. Available: {available}",
                    provider=provider,
                    model=model,
                    error_type="model_not_supported",
                    retryable=False,
                )

        # Rate limiting
        rate_limiter = self._rate_limiters[provider]
        if wait_for_rate_limit:
            acquired = await rate_limiter.wait_and_acquire(timeout=120.0)
        else:
            acquired = await rate_limiter.acquire()

        if not acquired:
            return LLMError(
                message=f"Rate limit exceeded for provider '{provider}'",
                provider=provider,
                model=model,
                error_type="rate_limit",
                retryable=True,
            )

        # Generate response
        try:
            result = await llm_provider.generate(
                prompt=prompt,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                system_prompt=system_prompt,
                thinking_effort=thinking_effort,
                request_timeout=request_timeout,
                request_json_mode=request_json_mode,
                **kwargs,
            )

            # Calculate cost if successful
            if isinstance(result, LLMResponse):
                result.raw_response = result.raw_response or {}
                cost = llm_provider.calculate_cost(
                    model, result.input_tokens, result.output_tokens, result.thinking_tokens
                )
                result.raw_response["calculated_cost_usd"] = cost

            return result

        except Exception as e:
            logger.exception(f"Error generating response from {provider}/{model}")
            return LLMError(
                message=str(e),
                provider=provider,
                model=model,
                error_type="unknown",
                retryable=False,
                raw_error=e,
            )

    async def generate_stream(
        self,
        provider: str,
        model: str,
        prompt: str,
        on_chunk: Callable[[str], Awaitable[None]],
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        thinking_effort: str | None = None,
        wait_for_rate_limit: bool = True,
        request_timeout: float | None = None,
        **kwargs: Any,
    ) -> LLMResponse | LLMError:
        """Streaming variant of :meth:`generate`.

        Provider-level support is optional — :class:`BaseLLMProvider` ships a
        default that wraps ``generate`` and emits the full text as a single
        chunk, so this is safe to call for any provider. Only the Anthropic
        provider currently delivers true incremental streaming.
        """
        await self.initialize()

        llm_provider = self._providers.get(provider)
        if not llm_provider:
            return LLMError(
                message=f"Provider '{provider}' not found or not configured",
                provider=provider,
                model=model,
                error_type="provider_not_found",
                retryable=False,
            )

        if not llm_provider.supports_model(model):
            available = llm_provider.available_models
            if available:
                model = available[0]
            else:
                return LLMError(
                    message=f"Model '{model}' not supported by provider '{provider}'.",
                    provider=provider,
                    model=model,
                    error_type="model_not_supported",
                    retryable=False,
                )

        rate_limiter = self._rate_limiters[provider]
        if wait_for_rate_limit:
            acquired = await rate_limiter.wait_and_acquire(timeout=120.0)
        else:
            acquired = await rate_limiter.acquire()
        if not acquired:
            return LLMError(
                message=f"Rate limit exceeded for provider '{provider}'",
                provider=provider,
                model=model,
                error_type="rate_limit",
                retryable=True,
            )

        try:
            result = await llm_provider.generate_stream(
                prompt=prompt,
                model=model,
                on_chunk=on_chunk,
                temperature=temperature,
                max_tokens=max_tokens,
                system_prompt=system_prompt,
                thinking_effort=thinking_effort,
                request_timeout=request_timeout,
                **kwargs,
            )
            if isinstance(result, LLMResponse):
                result.raw_response = result.raw_response or {}
                cost = llm_provider.calculate_cost(
                    model, result.input_tokens, result.output_tokens, result.thinking_tokens
                )
                result.raw_response["calculated_cost_usd"] = cost
            return result
        except Exception as e:
            logger.exception(f"Error streaming response from {provider}/{model}")
            return LLMError(
                message=str(e),
                provider=provider,
                model=model,
                error_type="unknown",
                retryable=False,
                raw_error=e,
            )

    def calculate_cost(
        self, provider: str, model: str, input_tokens: int, output_tokens: int,
        thinking_tokens: int = 0,
    ) -> float:
        """Calculate the cost of a request."""
        llm_provider = self._providers.get(provider)
        if not llm_provider:
            return 0.0
        return llm_provider.calculate_cost(model, input_tokens, output_tokens, thinking_tokens)

    def is_provider_available(self, provider) -> bool:
        """Check if a provider is configured (has API key)."""
        # Handle both string and enum
        provider_name = provider.value if hasattr(provider, 'value') else str(provider)
        return provider_name in self._providers

    async def get_available_models(self, provider) -> list[str]:
        """Get available models for a provider."""
        provider_name = provider.value if hasattr(provider, 'value') else str(provider)
        llm_provider = self._providers.get(provider_name)
        if not llm_provider:
            return []
        return llm_provider.available_models

    def get_model_capabilities(self, provider_name: str) -> dict[str, dict[str, Any]]:
        """Get capabilities for all models of a provider."""
        llm_provider = self._providers.get(provider_name)
        if not llm_provider:
            return {}
        return llm_provider.get_all_model_capabilities()

    def get_max_output_tokens(self, provider_name: str, model: str) -> int:
        """Get the max allowed output tokens for a specific provider/model.

        Returns 16384 as a safe default if the provider is unknown.
        """
        llm_provider = self._providers.get(provider_name)
        if not llm_provider:
            return 16384
        return llm_provider.get_max_output_tokens(model)

    async def refresh_provider_models(self, provider_name: str) -> dict[str, Any]:
        """Force refresh models for a specific provider from API."""
        provider = self._providers.get(provider_name)
        if not provider:
            return {
                "success": False,
                "models": [],
                "error": f"Provider '{provider_name}' not found"
            }

        try:
            # Clear cached models
            if hasattr(provider, '_fetched_models'):
                provider._fetched_models = None

            # Re-fetch by calling is_available (which populates models)
            available = await provider.is_available()

            if available:
                models = provider.available_models
                logger.info(f"Refreshed {len(models)} models for {provider_name}")
                return {
                    "success": True,
                    "models": models,
                }
            else:
                return {
                    "success": False,
                    "models": provider.CODE_MODELS if hasattr(provider, 'CODE_MODELS') else [],
                    "error": "Provider not available"
                }
        except Exception as e:
            logger.exception(f"Error refreshing models for {provider_name}")
            return {
                "success": False,
                "models": [],
                "error": str(e)
            }

    async def refresh_all_models(self) -> list[dict[str, Any]]:
        """Force refresh models for all providers from APIs."""
        results = []
        for name in self._providers.keys():
            result = await self.refresh_provider_models(name)
            results.append({
                "provider": name,
                **result
            })
        return results

    async def update_provider_key(self, provider_name: str, api_key: str) -> bool:
        """Update API key for a provider and reinitialize it."""
        # Import providers here to avoid circular imports
        from app.llm.providers import (
            AnthropicProvider, GoogleProvider, GrokProvider,
            OllamaProvider, OpenAIProvider
        )

        provider_classes = {
            "openai": OpenAIProvider,
            "anthropic": AnthropicProvider,
            "google": GoogleProvider,
            "grok": GrokProvider,
            "ollama": OllamaProvider,
        }

        provider_class = provider_classes.get(provider_name)
        if not provider_class:
            logger.error(f"Unknown provider: {provider_name}")
            return False

        try:
            # Create new provider instance with new key
            if provider_name == "ollama":
                new_provider = provider_class(base_url=api_key)  # For Ollama, it's the base URL
            else:
                new_provider = provider_class(api_key=api_key)

            # Close old provider's HTTP client before replacing
            old_provider = self._providers.get(provider_name)
            if old_provider and hasattr(old_provider, 'close'):
                try:
                    await old_provider.close()
                except Exception as close_err:
                    logger.warning(f"Error closing old {provider_name} provider: {close_err}")

            # Replace old provider
            self._providers[provider_name] = new_provider

            # Verify the new key works
            available = await new_provider.is_available()
            if available:
                logger.info(f"Updated {provider_name} with new API key - {len(new_provider.available_models)} models available")
            else:
                logger.warning(f"Updated {provider_name} but provider not available")

            return available
        except Exception as e:
            logger.exception(f"Error updating {provider_name} API key: {e}")
            return False

    def update_rate_limit(self, provider_name: str, rate_limit: int) -> None:
        """Update rate limit for a provider."""
        if provider_name in self._rate_limiters:
            self._rate_limiters[provider_name].max_requests = rate_limit
            logger.info(f"Updated rate limit for {provider_name}: {rate_limit}/min")
        else:
            self._rate_limiters[provider_name] = RateLimiter(max_requests=rate_limit)
            logger.info(f"Created rate limiter for {provider_name}: {rate_limit}/min")

    async def test_provider(self, provider: str, model: str) -> bool | str:
        """Test connection to a provider. Returns True on success, error message on failure."""
        await self.initialize()

        llm_provider = self._providers.get(provider)
        if not llm_provider:
            logger.error(f"Test failed: Provider '{provider}' not found")
            return f"Provider '{provider}' not found"

        try:
            logger.info(f"Testing {provider} with model {model}")
            result = await llm_provider.generate(
                prompt="Say 'Hello' in one word.",
                model=model,
                temperature=0.7,  # Will be ignored for reasoning models
                max_tokens=100,   # Increased for reasoning models
            )

            if isinstance(result, LLMResponse):
                logger.info(f"Test successful for {provider}/{model}: {result.content[:50]}")
                return True
            else:
                # LLMError
                error_msg = f"{result.error_type}: {result.message}"
                logger.warning(f"Test failed for {provider}/{model}: {error_msg}")
                return error_msg
        except Exception as e:
            logger.exception(f"Test exception for {provider}/{model}: {e}")
            return str(e)

    async def close(self) -> None:
        """Close all provider connections."""
        for provider in self._providers.values():
            if hasattr(provider, 'close'):
                await provider.close()


async def close_llm_router() -> None:
    """Close the global LLM router."""
    await llm_router.close()


# Global router instance
llm_router = LLMRouter()


async def get_llm_router() -> LLMRouter:
    """Get initialized LLM router."""
    await llm_router.initialize()
    return llm_router
