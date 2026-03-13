"""
Application configuration using Pydantic Settings.
Re-exports from app.core.config for convenience.
"""
from app.core.config import Settings, get_settings, settings

# Also export pricing and models info

# LLM Pricing per 1M tokens (USD) — fallback reference, actual costs calculated by providers
LLM_PRICING = {
    "openai": {
        "gpt-4.1": {"input": 2.00, "output": 8.00},
        "gpt-4.1-mini": {"input": 0.40, "output": 1.60},
        "gpt-4.1-nano": {"input": 0.10, "output": 0.40},
        "o3-mini": {"input": 1.10, "output": 4.40},
    },
    "anthropic": {
        "claude-sonnet-4-5-20250929": {"input": 3.00, "output": 15.00},
        "claude-haiku-4-5-20251001": {"input": 0.80, "output": 4.00},
    },
    "google": {
        "gemini-2.5-pro-preview-06-05": {"input": 1.25, "output": 10.00},
        "gemini-2.5-flash-preview-05-20": {"input": 0.15, "output": 0.60},
    },
    "grok": {
        "grok-3-mini": {"input": 0.30, "output": 0.50},
    },
    "ollama": {
        "*": {"input": 0.00, "output": 0.00},
    }
}

# Fallback models per provider (used when dynamic fetch fails)
AVAILABLE_MODELS = {
    "openai": ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "o3-mini"],
    "anthropic": ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001"],
    "google": ["gemini-2.5-pro-preview-06-05", "gemini-2.5-flash-preview-05-20"],
    "grok": ["grok-3-mini"],
    "ollama": [],  # Dynamic, fetched from Ollama server
}

__all__ = ['Settings', 'get_settings', 'settings', 'LLM_PRICING', 'AVAILABLE_MODELS']
