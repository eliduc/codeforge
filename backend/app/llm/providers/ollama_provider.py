"""Ollama LLM provider implementation for local models."""

import logging
import time
from typing import Any

import httpx

from app.llm.base import BaseLLMProvider, LLMError, LLMResponse

logger = logging.getLogger(__name__)


class OllamaProvider(BaseLLMProvider):
    """Ollama local LLM provider."""

    # Local models are free
    PRICING: dict[str, tuple[float, float]] = {}

    DEFAULT_MODELS = [
        "llama3.2",
        "llama3.2:1b",
        "llama3.1",
        "llama3.1:70b",
        "codellama",
        "codellama:13b",
        "codellama:34b",
        "mistral",
        "mistral:7b",
        "mixtral",
        "mixtral:8x7b",
        "deepseek-coder",
        "deepseek-coder:6.7b",
        "deepseek-coder:33b",
        "qwen2.5-coder",
        "qwen2.5-coder:7b",
        "qwen2.5-coder:32b",
        "phi3",
        "phi3:mini",
        "gemma2",
        "gemma2:9b",
    ]

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        super().__init__(api_key, base_url)
        self.base_url = base_url or "http://localhost:11434"
        self._available_models: list[str] | None = None
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=30.0))

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    @property
    def name(self) -> str:
        return "ollama"

    @property
    def available_models(self) -> list[str]:
        if self._available_models is not None:
            return self._available_models
        return self.DEFAULT_MODELS

    async def _fetch_available_models(self) -> list[str]:
        """Fetch available models from Ollama server."""
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.get(f"{self.base_url}/api/tags")
                if response.status_code == 200:
                    data = response.json()
                    models = [m["name"] for m in data.get("models", [])]
                    return models if models else self.DEFAULT_MODELS
        except Exception as e:
            logger.debug(f"Model fetch failed: {e}")
        return self.DEFAULT_MODELS

    async def is_available(self) -> bool:
        """Check if Ollama is available."""
        try:
            models = await self._fetch_available_models()
            if models:
                self._available_models = models
                return True
        except Exception as e:
            logger.debug(f"Ollama availability check failed: {e}")
        return False

    async def generate(
        self,
        prompt: str,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        **kwargs: Any,
    ) -> LLMResponse | LLMError:
        """Generate a response using Ollama."""
        start_time = time.time()

        try:
            request_body: dict[str, Any] = {
                "model": model,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "temperature": temperature,
                    "num_predict": max_tokens,
                },
            }

            if system_prompt:
                request_body["system"] = system_prompt

            response = await self._client.post(
                f"{self.base_url}/api/generate",
                json=request_body,
            )

            latency_ms = int((time.time() - start_time) * 1000)

            if response.status_code != 200:
                return LLMError(
                    message=f"Ollama returned status {response.status_code}: {response.text}",
                    provider=self.name,
                    model=model,
                    error_type="api",
                    retryable=response.status_code >= 500,
                )

            try:
                data = response.json()
            except (ValueError, KeyError) as json_err:
                logger.error(f"Ollama response is not valid JSON: {json_err}")
                return LLMError(
                    message=f"Invalid JSON in Ollama response: {json_err}",
                    provider=self.name,
                    model=model,
                    error_type="parse_error",
                    retryable=True,
                )

            # Ollama provides token counts in eval_count and prompt_eval_count
            input_tokens = data.get("prompt_eval_count", 0)
            output_tokens = data.get("eval_count", 0)

            return LLMResponse(
                content=data.get("response", ""),
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                model=model,
                provider=self.name,
                latency_ms=latency_ms,
                raw_response=data,
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
                message=f"Failed to connect to Ollama: {e}",
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

    def calculate_cost(self, model: str, input_tokens: int, output_tokens: int, thinking_tokens: int = 0) -> float:
        """Ollama models are free (running locally)."""
        return 0.0
