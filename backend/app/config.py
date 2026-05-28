"""
Application configuration using Pydantic Settings.
Re-exports from app.core.config for convenience.
"""
from app.core.config import Settings, get_settings, settings


def _build_pricing_and_models() -> tuple[dict, dict]:
    """Build LLM_PRICING and AVAILABLE_MODELS from actual provider classes.

    This ensures the fallback data stays in sync with provider implementations
    instead of requiring manual updates to hardcoded dicts.
    """
    from app.llm.providers.openai_provider import OpenAIProvider
    from app.llm.providers.anthropic_provider import AnthropicProvider
    from app.llm.providers.google_provider import GoogleProvider
    from app.llm.providers.grok_provider import GrokProvider

    pricing: dict = {}
    models: dict = {}

    for name, cls in [
        ("openai", OpenAIProvider),
        ("anthropic", AnthropicProvider),
        ("google", GoogleProvider),
        ("grok", GrokProvider),
    ]:
        provider_pricing = {}
        for model_id, costs in cls.PRICING.items():
            if len(costs) == 3:
                provider_pricing[model_id] = {"input": costs[0], "output": costs[1], "thinking": costs[2]}
            else:
                provider_pricing[model_id] = {"input": costs[0], "output": costs[1]}
        pricing[name] = provider_pricing
        models[name] = cls.CODE_MODELS if hasattr(cls, "CODE_MODELS") else []

    pricing["ollama"] = {"*": {"input": 0.00, "output": 0.00}}
    models["ollama"] = []  # Dynamic, fetched from Ollama server

    return pricing, models


LLM_PRICING, AVAILABLE_MODELS = _build_pricing_and_models()

__all__ = ['Settings', 'get_settings', 'settings', 'LLM_PRICING', 'AVAILABLE_MODELS']
