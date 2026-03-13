"""xAI Grok LLM provider with Grok 4 and reasoning support."""

import logging
import time
from typing import Any

import httpx

from app.llm.base import BaseLLMProvider, LLMError, LLMResponse

logger = logging.getLogger(__name__)


class GrokProvider(BaseLLMProvider):
    """xAI Grok API provider with Grok 4 and reasoning support."""

    # Fallback models (latest first)
    CODE_MODELS = [
        "grok-4-0709",
        "grok-4-1-fast-reasoning",
        "grok-code-fast-1",
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

    # Reasoning models (have reasoning capabilities)
    REASONING_MODELS = [
        "grok-4", "grok-4-1", "grok-4-fast-reasoning", "grok-4-1-fast-reasoning"
    ]

    BASE_URL = "https://api.x.ai/v1"

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        super().__init__(api_key, base_url)
        self.base_url = base_url or self.BASE_URL
        self._fetched_models: list[str] | None = None
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(None, connect=30.0))

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
        """Check if model has reasoning capabilities."""
        model_lower = model.lower()
        # Grok 4 is always reasoning, fast variants specify reasoning/non-reasoning
        if "grok-4" in model_lower:
            # Non-reasoning variants explicitly marked
            if "non-reasoning" in model_lower:
                return False
            return True
        return False

    def _supports_reasoning_effort(self, model: str) -> bool:
        """Check if model supports reasoning_effort parameter.

        Only grok-3-mini supports it. Grok 4 models do NOT — passing it causes an error.
        """
        return "grok-3-mini" in model.lower()

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
        """Check availability and fetch models from API."""
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

                    # Classify models into families
                    families: dict[str, tuple[dict, int]] = {}

                    for m in models:
                        model_id = m["id"]
                        model_lower = model_id.lower()

                        # Skip non-text models
                        if any(x in model_lower for x in ['embed', 'image', 'vision', 'audio', 'video']):
                            # Allow vision models as they also do text
                            if 'vision' not in model_lower:
                                continue

                        # Determine family
                        family = None

                        # Grok 4.1 family (newest)
                        if 'grok-4-1' in model_lower or 'grok-4.1' in model_lower:
                            if 'fast-reasoning' in model_lower:
                                family = "grok-4.1-fast-reasoning"
                            elif 'fast-non-reasoning' in model_lower:
                                family = "grok-4.1-fast-non-reasoning"
                            elif 'fast' in model_lower:
                                family = "grok-4.1-fast"
                            else:
                                family = "grok-4.1"
                        # Grok 4 family
                        elif 'grok-4' in model_lower:
                            if 'fast-reasoning' in model_lower:
                                family = "grok-4-fast-reasoning"
                            elif 'fast-non-reasoning' in model_lower:
                                family = "grok-4-fast-non-reasoning"
                            elif 'fast' in model_lower:
                                family = "grok-4-fast"
                            else:
                                family = "grok-4"
                        # Grok Code
                        elif 'grok-code' in model_lower:
                            family = "grok-code"
                        # Grok 3 family
                        elif 'grok-3' in model_lower:
                            if 'mini' in model_lower:
                                family = "grok-3-mini"
                            else:
                                family = "grok-3"
                        # Grok 2 family
                        elif 'grok-2' in model_lower:
                            if 'vision' in model_lower:
                                family = "grok-2-vision"
                            elif 'mini' in model_lower:
                                family = "grok-2-mini"
                            else:
                                family = "grok-2"

                        if not family:
                            continue

                        # Priority: latest (0) > clean name (1) > dated (2)
                        if 'latest' in model_lower:
                            priority = 0
                        elif not any(c.isdigit() for c in model_id[-8:].replace('grok', '')):
                            priority = 1
                        else:
                            priority = 2

                        if family not in families or priority < families[family][1]:
                            families[family] = (m, priority)
                        elif priority == families[family][1]:
                            if m.get("created", 0) > families[family][0].get("created", 0):
                                families[family] = (m, priority)

                    # Build result: Grok 4 first, then 3, then 2
                    preferred_order = [
                        # Grok 4.1 (newest)
                        "grok-4.1", "grok-4.1-fast-reasoning", "grok-4.1-fast-non-reasoning",
                        # Grok 4
                        "grok-4", "grok-4-fast-reasoning", "grok-4-fast-non-reasoning",
                        # Grok Code
                        "grok-code",
                        # Grok 3
                        "grok-3", "grok-3-mini",
                        # Grok 2
                        "grok-2", "grok-2-vision", "grok-2-mini",
                    ]

                    result = []
                    for fam in preferred_order:
                        if fam in families:
                            result.append(families[fam][0]["id"])

                    logger.info(f"Grok: found {len(result)} models: {result}")
                    self._fetched_models = result if result else self.CODE_MODELS
                    return True

                logger.warning(f"Grok models API returned {response.status_code}")
                return False

        except Exception as e:
            logger.warning(f"Grok models fetch failed: {e}")
            return False

    async def generate(
        self,
        prompt: str,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        thinking_effort: str | None = None,
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

            # Grok 4 reasoning models don't use temperature
            if not self._is_reasoning_model(model):
                request_body["temperature"] = temperature

            # grok-3-mini supports reasoning_effort: "low" or "high"
            if self._supports_reasoning_effort(model) and thinking_effort:
                effort_map = {"low": "low", "medium": "low", "high": "high", "max": "high"}
                effort = effort_map.get(thinking_effort)
                if effort:
                    request_body["reasoning_effort"] = effort

            response = await self._client.post(
                f"{self.base_url}/chat/completions",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json=request_body,
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
