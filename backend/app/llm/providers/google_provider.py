"""Google Gemini LLM provider with new google-genai SDK (Gemini 3/2.5)."""

import asyncio
import logging
import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from google import genai
from google.genai import types

from app.llm.base import BaseLLMProvider, LLMError, LLMResponse

logger = logging.getLogger(__name__)


# КАО#VR-30 — version-agnostic Gemini model parser. Returns
# (version, tier, priority) where:
#   version  — float parsed from "gemini-X.Y..." (3.0, 3.1, 3.5, 4.0, ...)
#   tier     — "pro" | "flash" | "flash-lite" | "lite" | "other"
#   priority — 0=stable, 1=preview, 2=latest, 3=exp, 4=dated (lower = better)
#
# Used by is_available() to group + sort discovered models, and by
# _resolve_latest_in_family() to recover from 404 on deprecated names.
# Adding gemini-3.5, gemini-4, etc. requires NO code changes — the parser
# extracts whatever version Google publishes.

_VERSION_RE = re.compile(r"gemini[-_ ]?(\d+(?:\.\d+)?)")
_DATED_RE = re.compile(r"-\d{3,}")  # -001, -0925, -2025-04, etc.


def _parse_gemini_model(name: str) -> tuple[float, str, int]:
    """Parse a Gemini model name into (version, tier, priority).

    Examples:
      gemini-3-pro-preview            → (3.0, "pro",        1)
      gemini-3.5-flash                → (3.5, "flash",      0)
      gemini-3.1-flash-lite-001       → (3.1, "flash-lite", 3)  # dated
      gemini-2.5-pro-latest           → (2.5, "pro",        2)  # latest alias
      gemini-foobar                   → (0.0, "other",      0)  # ignored later
    """
    n = name.lower()
    v_match = _VERSION_RE.search(n)
    version = float(v_match.group(1)) if v_match else 0.0
    # Tier — order matters: flash-lite/lite checks must run BEFORE flash.
    if "flash-lite" in n or "flashlite" in n:
        tier = "flash-lite"
    elif "lite" in n and "flash" not in n:
        tier = "lite"
    elif "pro" in n:
        tier = "pro"
    elif "flash" in n:
        tier = "flash"
    else:
        tier = "other"
    # Priority — lower is better when picking the freshest stable.
    if "-exp" in n or "experimental" in n:
        priority = 3
    elif "preview" in n:
        priority = 1
    elif "latest" in n:
        priority = 2
    elif _DATED_RE.search(n):
        priority = 4
    else:
        priority = 0
    return version, tier, priority


class GoogleProvider(BaseLLMProvider):
    """Google Gemini API provider with Gemini 3 and 2.5 thinking support."""

    # Fallback models when the API list_models() call fails. Kept stable
    # (no -preview / -exp / dated names) so we never bake a deprecating
    # version into the default list. Real session picks come from
    # is_available()'s API fetch, which catches the latest stable per family
    # (see KAO#VR-30).
    CODE_MODELS = [
        "gemini-3-pro",
        "gemini-3-flash",
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

    # Dedicated thread pool for blocking google-genai SDK calls
    _executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="google-genai")

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
        """Check if model supports thinking mode.

        КАО#VR-32 — version-agnostic: Gemini 2.5+ pro/flash/flash-lite (and all
        future majors — 3.x, 4.x, …) support thinking; 2.0 and below do not.
        Replaces the hardcoded THINKING_MODELS substring list, so future
        flagships (e.g. gemini-4-pro) are recognized without a code edit
        (the bug that left every other provider version-agnostic but Google not).
        """
        version, tier, _ = _parse_gemini_model(model)
        return version >= 2.5 and tier in ("pro", "flash", "flash-lite")

    def _family_of(self, model: str) -> str | None:
        """Return just the tier key ('pro' | 'flash' | 'flash-lite' | 'lite')
        for a model name. Used by routing/fallback. KAO#VR-30.

        Version-agnostic: 'gemini-3-pro' and 'gemini-3.5-pro' and
        'gemini-4-pro' all return 'pro'.
        """
        _, tier, _ = _parse_gemini_model(model)
        return tier if tier != "other" else None

    def _resolve_latest_in_family(self, model: str) -> str | None:
        """Return the most recent model name in the same tier from the
        most recent ``client.models.list()`` fetch.

        Used by ``generate()`` to recover from "model is no longer available"
        404s without manual intervention: a session pinned to a deprecated
        preview (e.g. ``gemini-3-pro-preview``) silently retries against the
        current best in the same tier (e.g. ``gemini-3.5-pro`` if released,
        else ``gemini-3-pro``). KAO#VR-30.

        Returns None if there's no current model in the same tier OR the
        input is already what would be picked (no fallback would help —
        propagate the error so the caller sees a real failure).
        """
        requested_v, requested_tier, _ = _parse_gemini_model(model)
        if requested_tier == "other" or not self._fetched_models:
            return None
        for fetched in self._fetched_models:
            f_v, f_tier, _ = _parse_gemini_model(fetched)
            # Same tier — fetched_models is already sorted (best first),
            # so the first match in this tier is the latest stable.
            if f_tier == requested_tier and fetched != model:
                return fetched
        return None

    @staticmethod
    def _looks_like_not_found(err: Exception) -> bool:
        """Sniff a model-not-found / 404 / deprecated error. KAO#VR-30."""
        msg = str(err).lower()
        return (
            "404" in msg
            or "not_found" in msg
            or "not found" in msg
            or "no longer available" in msg
            or "is deprecated" in msg
        )

    async def is_available(self) -> bool:
        """Check availability and fetch models from API."""
        if not self.api_key:
            return False
        try:
            # Run synchronous list in executor
            loop = asyncio.get_running_loop()
            models_list = await loop.run_in_executor(
                self._executor, lambda: list(self.client.models.list())
            )

            # KAO#VR-30 — version-agnostic discovery.
            # Group candidates by (version, tier) and keep the best per (version,tier)
            # ranked by priority (lower better). Then sort the result by
            # (version DESC, tier-preference) so latest stable per tier
            # comes first. No hardcoded version numbers — works for 3, 3.1,
            # 3.5, 4, etc. as Google releases them.
            #
            # Best-per-(version,tier): each (3, 'pro'), (3.5, 'pro'),
            # (2.5, 'flash-lite') is treated independently. This way the UI
            # surfaces ALL major versions per tier (newer + older), so the
            # user can still pick e.g. gemini-2.5-pro even after 3.5 ships.
            best: dict[tuple[float, str], tuple[str, int]] = {}

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

                version, tier, priority = _parse_gemini_model(name)
                # Skip anything that isn't a recognizable gemini family.
                if tier == "other" or version <= 0.0:
                    continue
                # Drop ancient versions (Gemini 1.x retired pre-2025).
                if version < 2.0:
                    continue

                key = (version, tier)
                if key not in best or priority < best[key][1]:
                    best[key] = (name, priority)

            # Sort: newest version first, then by tier preference
            # (pro > flash > flash-lite > lite > other).
            tier_rank = {"pro": 0, "flash": 1, "flash-lite": 2, "lite": 3, "other": 4}
            ordered = sorted(
                best.items(),
                key=lambda kv: (-kv[0][0], tier_rank.get(kv[0][1], 99)),
            )
            result = [name for _key, (name, _prio) in ordered]

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
        request_timeout: float | None = None,
        use_thinking: bool = False,
        request_json_mode: bool = False,
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

            # JSON mode: Gemini supports response_mime_type for structured output
            if request_json_mode:
                config["response_mime_type"] = "application/json"

            # Apply per-request timeout override if provided
            if request_timeout is not None:
                config["http_options"] = {"timeout": int(request_timeout * 1000)}

            # Build contents
            contents: list[Any] = []
            if system_prompt:
                config["system_instruction"] = system_prompt
            contents.append(prompt)

            # Run synchronous generate in executor
            loop = asyncio.get_running_loop()
            response = await loop.run_in_executor(
                self._executor,
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
            # КАО#VR-30 — model-deprecated auto-retry. Google retires preview
            # models without warning (gemini-3-pro-preview → 404). If the
            # error looks like model-not-found AND we have a current latest
            # in the same family from the most recent list_models() fetch,
            # transparently retry with the new name.
            if self._looks_like_not_found(e) and not kwargs.get("_gemini_retry"):
                # Force-refresh model list so we pick up any name change that
                # happened since the last fetch.
                try:
                    await self.is_available()
                except Exception:
                    pass
                replacement = self._resolve_latest_in_family(model)
                if replacement and replacement != model:
                    logger.warning(
                        "Google model %r unavailable (%s); retrying with %r",
                        model, type(e).__name__, replacement,
                    )
                    return await self.generate(
                        prompt=prompt,
                        model=replacement,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        system_prompt=system_prompt,
                        thinking_effort=thinking_effort,
                        request_timeout=request_timeout,
                        use_thinking=use_thinking,
                        request_json_mode=request_json_mode,
                        _gemini_retry=True,
                        **{k: v for k, v in kwargs.items() if k != "_gemini_retry"},
                    )
            logger.error(f"Google generate error: {e}")
            return LLMError(
                message=str(e),
                provider=self.name,
                model=model,
                error_type="unknown",
                retryable=False,
                raw_error=e
            )
