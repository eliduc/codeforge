"""Google Gemini LLM provider with new google-genai SDK (Gemini 3/2.5)."""

import asyncio
import logging
import time
from typing import Any

from google import genai
from google.genai import types

from app.llm.base import BaseLLMProvider, LLMError, LLMResponse

logger = logging.getLogger(__name__)


class GoogleProvider(BaseLLMProvider):
    """Google Gemini API provider with Gemini 3 and 2.5 thinking support."""

    # Fallback models (latest first)
    CODE_MODELS = [
        "gemini-3-pro-preview",
        "gemini-3-flash-preview",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
    ]

    # Pricing per 1M tokens (input, output)
    PRICING = {
        # Gemini 3 family (latest, preview)
        "gemini-3-pro": (1.25, 5.00),
        "gemini-3-flash": (0.15, 0.60),
        # Gemini 2.5 family (stable)
        "gemini-2.5-pro": (1.25, 5.00),
        "gemini-2.5-flash": (0.15, 0.60),
        "gemini-2.5-flash-lite": (0.02, 0.10),
        # Gemini 2.0 (deprecated March 2026)
        "gemini-2.0-flash": (0.10, 0.40),
        "gemini-2.0-flash-lite": (0.02, 0.10),
    }

    # Models that support thinking mode
    THINKING_MODELS = ["gemini-3", "gemini-2.5-pro", "gemini-2.5-flash"]

    # Max output tokens per model family
    MAX_OUTPUT_TOKENS: dict[str, int] = {
        "gemini-3": 65536,
        "gemini-2.5-pro": 65536,
        "gemini-2.5-flash": 65536,
        "gemini-2.0": 8192,
    }
    DEFAULT_MAX_OUTPUT = 8192

    def get_max_output_tokens(self, model: str) -> int:
        """Return the max allowed output tokens for a given Google model."""
        model_lower = model.lower()
        for family, limit in self.MAX_OUTPUT_TOKENS.items():
            if family in model_lower:
                return limit
        return self.DEFAULT_MAX_OUTPUT

    def get_model_capabilities(self, model: str) -> dict:
        """Return per-model thinking effort options for Google Gemini."""
        caps: dict = {"max_output_tokens": self.get_max_output_tokens(model)}
        if self._supports_thinking(model):
            caps["thinking_effort_options"] = ["low", "medium", "high", "max"]
        else:
            caps["thinking_effort_options"] = []
        return caps

    def __init__(self, api_key: str | None = None, base_url: str | None = None):
        super().__init__(api_key, base_url)
        self._client: genai.Client | None = None
        self._fetched_models: list[str] | None = None

    @property
    def name(self) -> str:
        return "google"

    @property
    def available_models(self) -> list[str]:
        if self._fetched_models:
            return self._fetched_models
        return self.CODE_MODELS

    @property
    def client(self) -> genai.Client:
        if self._client is None:
            self._client = genai.Client(api_key=self.api_key)
        return self._client

    async def close(self) -> None:
        """Close provider resources (no persistent connection to close for google-genai)."""
        self._client = None

    def _supports_thinking(self, model: str) -> bool:
        """Check if model supports thinking mode."""
        model_lower = model.lower()
        return any(tm in model_lower for tm in self.THINKING_MODELS)

    async def is_available(self) -> bool:
        """Check availability and fetch models from API."""
        if not self.api_key:
            return False
        try:
            # Run synchronous list in executor
            loop = asyncio.get_running_loop()
            models_list = await loop.run_in_executor(
                None, lambda: list(self.client.models.list())
            )

            families: dict[str, tuple[str, int]] = {}

            for model in models_list:
                # Model name format: models/gemini-...
                name = model.name.replace("models/", "") if hasattr(model, 'name') else str(model)
                name_lower = name.lower()

                # Check if model supports content generation
                supported = getattr(model, 'supported_actions', [])
                if supported and 'generateContent' not in supported:
                    continue

                # Skip non-text models
                if any(x in name_lower for x in [
                    'embed', 'imagen', 'aqa', 'vision', 'gemma',
                    'learnlm', 'tts', 'audio', 'image', 'video'
                ]):
                    continue

                # Classify into families
                family = None

                # Gemini 3 family (newest)
                if 'gemini-3' in name_lower or 'gemini3' in name_lower:
                    if 'pro' in name_lower:
                        family = "3-pro"
                    elif 'flash' in name_lower:
                        family = "3-flash"
                # Gemini 2.5 family
                elif '2.5-pro' in name_lower or '2.5pro' in name_lower:
                    family = "2.5-pro"
                elif '2.5-flash-lite' in name_lower:
                    family = "2.5-flash-lite"
                elif '2.5-flash' in name_lower or '2.5flash' in name_lower:
                    family = "2.5-flash"
                # Gemini 2.0 family (deprecated)
                elif '2.0-flash-lite' in name_lower:
                    family = "2.0-flash-lite"
                elif '2.0-flash' in name_lower or '2.0flash' in name_lower:
                    family = "2.0-flash"

                if not family:
                    continue

                # Priority: stable (0) > preview (1) > exp (2) > dated (3)
                if '-exp' not in name_lower and 'preview' not in name_lower and 'latest' not in name_lower:
                    priority = 0
                elif 'preview' in name_lower:
                    priority = 1
                elif 'exp' in name_lower:
                    priority = 2
                else:
                    priority = 3

                if family not in families or priority < families[family][1]:
                    families[family] = (name, priority)

            # Build result: Gemini 3 first, then 2.5, then 2.0
            preferred_order = [
                "3-pro", "3-flash",
                "2.5-pro", "2.5-flash", "2.5-flash-lite",
                "2.0-flash", "2.0-flash-lite",
            ]

            result = []
            for fam in preferred_order:
                if fam in families:
                    result.append(families[fam][0])

            logger.info(f"Google: found {len(result)} models: {result}")
            self._fetched_models = result if result else self.CODE_MODELS
            return True

        except Exception as e:
            logger.warning(f"Google models fetch failed: {e}")
            return False

    # Map unified thinking_effort to Gemini thinking_budget
    THINKING_BUDGET_MAP = {
        "low": 1024,
        "medium": 4096,
        "high": 8000,
        "max": 24576,
    }

    async def generate(
        self,
        prompt: str,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: str | None = None,
        thinking_effort: str | None = None,
        use_thinking: bool = False,
        **kwargs: Any,
    ) -> LLMResponse | LLMError:
        """Generate response using new google-genai SDK."""
        start_time = time.time()

        try:
            # Build config — ensure thinking models have enough tokens for both thinking + response
            effective_max_tokens = max_tokens
            if self._supports_thinking(model) and effective_max_tokens < 1024:
                effective_max_tokens = 1024

            config: dict[str, Any] = {
                "max_output_tokens": effective_max_tokens,
            }

            # Thinking mode for supported models
            if self._supports_thinking(model):
                if thinking_effort and thinking_effort != "none":
                    budget = self.THINKING_BUDGET_MAP.get(thinking_effort, 8000)
                    config["thinking_config"] = types.ThinkingConfig(thinking_budget=budget)
                elif thinking_effort == "none":
                    # Explicitly disabled
                    config["thinking_config"] = types.ThinkingConfig(thinking_budget=0)
                    config["temperature"] = temperature
                elif use_thinking:
                    # Legacy flag: default budget
                    config["thinking_config"] = types.ThinkingConfig(thinking_budget=8000)
                else:
                    # Default for thinking-capable models: auto
                    config["thinking_config"] = types.ThinkingConfig(thinking_budget=-1)
            else:
                config["temperature"] = temperature

            # Build contents
            contents: list[Any] = []
            if system_prompt:
                config["system_instruction"] = system_prompt
            contents.append(prompt)

            # Run synchronous generate in executor
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(
                None,
                lambda: self.client.models.generate_content(
                    model=model,
                    contents=contents,
                    config=types.GenerateContentConfig(**config),
                )
            )

            latency_ms = int((time.time() - start_time) * 1000)

            # Extract text (response.text can be None if all output went to thinking)
            try:
                content = (response.text or "") if hasattr(response, 'text') else ""
            except ValueError:
                return LLMError(
                    message="Content blocked by safety filter",
                    provider=self.name,
                    model=model,
                    error_type="content_blocked",
                    retryable=False,
                )

            # Extract usage
            input_tokens = output_tokens = thinking_tokens = 0
            if hasattr(response, 'usage_metadata'):
                input_tokens = getattr(response.usage_metadata, 'prompt_token_count', 0) or 0
                output_tokens = getattr(response.usage_metadata, 'candidates_token_count', 0) or 0
                thinking_tokens = getattr(response.usage_metadata, 'thoughts_token_count', 0) or 0

            return LLMResponse(
                content=content,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                model=model,
                provider=self.name,
                latency_ms=latency_ms,
                raw_response={},
                thinking_tokens=thinking_tokens,
            )

        except Exception as e:
            logger.error(f"Google generate error: {e}")
            return LLMError(
                message=str(e),
                provider=self.name,
                model=model,
                error_type="unknown",
                retryable=False,
                raw_error=e
            )
