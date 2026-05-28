"""Unit tests for the "thinking is not supported" retry / cache in AnthropicProvider.

These tests mock the Anthropic SDK client at the ``messages.create`` boundary so
they run without network or API keys. They verify:

1. A 400 error containing "Adaptive thinking is not supported on this model"
   triggers a single retry WITHOUT thinking config, returns a normal
   ``LLMResponse``, and adds the model to the runtime cache.
2. After the cache is populated, subsequent calls skip the thinking config from
   the start — only ONE API call is issued and the request never contains a
   ``thinking`` key.
3. An unrelated 400 error (e.g. "invalid api key") is NOT treated as a thinking
   problem — it returns an ``LLMError`` and the model is NOT cached.
4. When the first call succeeds with thinking enabled, the cache is left alone.
"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

# Ensure ``backend/`` is on sys.path so ``import app...`` works regardless of
# where pytest is invoked from.
_BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(_BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(_BACKEND_DIR))

from anthropic import APIStatusError  # noqa: E402

# The ``app.llm`` package eagerly imports optional providers (e.g. google.genai)
# at package-init time. In local dev environments without google-genai installed
# this would break collection of these unit tests. Provide a lightweight stub
# so the import chain succeeds without changing production behavior — the stub
# is only used if the real module is missing.
import importlib  # noqa: E402
import types  # noqa: E402

try:
    importlib.import_module("google.genai")
except Exception:  # noqa: BLE001
    _genai_stub = types.ModuleType("google.genai")
    _genai_stub.Client = type("Client", (), {})  # placeholder, unused in these tests
    _genai_types_stub = types.ModuleType("google.genai.types")
    sys.modules.setdefault("google.genai", _genai_stub)
    sys.modules.setdefault("google.genai.types", _genai_types_stub)

ap_module = importlib.import_module("app.llm.providers.anthropic_provider")
_base_module = importlib.import_module("app.llm.base")

AnthropicProvider = ap_module.AnthropicProvider
LLMError = _base_module.LLMError
LLMResponse = _base_module.LLMResponse


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

MODEL = "claude-sonnet-4-6"


def _make_status_error(message: str, status_code: int = 400) -> APIStatusError:
    """Build a real APIStatusError instance the SDK would raise."""
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx.Response(
        status_code,
        request=request,
        json={"error": {"type": "invalid_request_error", "message": message}},
    )
    err = APIStatusError(message, response=response, body={"error": {"message": message}})
    # Some SDK versions set status_code from the response; ensure it's set.
    err.status_code = status_code
    return err


def _make_response(text: str = "ok", input_tokens: int = 10, output_tokens: int = 5):
    """Build a fake Anthropic SDK response shape used by ``generate()``."""
    text_block = SimpleNamespace(text=text)
    usage = SimpleNamespace(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        thinking_tokens=0,
        model_dump=lambda: {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "thinking_tokens": 0,
        },
    )
    return SimpleNamespace(
        content=[text_block],
        usage=usage,
        stop_reason="end_turn",
        model_dump=lambda: {"content": [{"text": text}], "stop_reason": "end_turn"},
    )


@pytest.fixture(autouse=True)
def _reset_cache():
    """Ensure each test starts with an empty thinking-unsupported cache."""
    ap_module._thinking_unsupported_models.clear()
    yield
    ap_module._thinking_unsupported_models.clear()


def _make_provider(side_effects):
    """Build a provider whose ``client.messages.create`` returns/raises from
    a sequence of side effects."""
    provider = AnthropicProvider(api_key="test-key")
    mock_create = AsyncMock(side_effect=side_effects)
    mock_client = MagicMock()
    mock_client.messages = MagicMock()
    mock_client.messages.create = mock_create
    provider._client = mock_client
    return provider, mock_create


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_thinking_unsupported_retries_without_thinking_and_caches():
    """Test 1: thinking-unsupported 400 -> retry succeeds -> cache populated."""
    err = _make_status_error("Adaptive thinking is not supported on this model")
    ok = _make_response("hello")
    provider, mock_create = _make_provider(side_effects=[err, ok])

    result = await provider.generate(prompt="hi", model=MODEL, max_tokens=1024)

    # Result must be a successful LLMResponse, not an LLMError.
    assert isinstance(result, LLMResponse), f"expected LLMResponse, got {type(result).__name__}: {result!r}"
    assert result.content == "hello"
    assert result.model == MODEL

    # Exactly two API calls: first with thinking, second without.
    assert mock_create.await_count == 2, f"expected 2 calls, got {mock_create.await_count}"

    first_kwargs = mock_create.await_args_list[0].kwargs
    second_kwargs = mock_create.await_args_list[1].kwargs
    assert "thinking" in first_kwargs, "first call should include thinking config"
    assert "thinking" not in second_kwargs, "retry must drop thinking config"
    assert "output_config" not in second_kwargs, "retry must drop output_config"
    assert "temperature" in second_kwargs, "retry must restore temperature"

    # Cache updated for this model.
    assert MODEL in ap_module._thinking_unsupported_models


@pytest.mark.asyncio
async def test_cache_hit_skips_thinking_from_start():
    """Test 2: cached model -> single call, no thinking config from the start."""
    ap_module._thinking_unsupported_models.add(MODEL)

    ok = _make_response("cached path")
    provider, mock_create = _make_provider(side_effects=[ok])

    result = await provider.generate(prompt="hi", model=MODEL, max_tokens=1024)

    assert isinstance(result, LLMResponse)
    assert result.content == "cached path"

    # Only ONE call when the cache is warm.
    assert mock_create.await_count == 1

    only_kwargs = mock_create.await_args_list[0].kwargs
    assert "thinking" not in only_kwargs, "cached call must skip thinking config"
    assert "output_config" not in only_kwargs
    assert "temperature" in only_kwargs


@pytest.mark.asyncio
async def test_unrelated_400_does_not_trigger_thinking_retry():
    """Test 3: an unrelated 400 must re-raise as LLMError, not retry."""
    err = _make_status_error("invalid x-api-key")
    provider, mock_create = _make_provider(side_effects=[err])

    result = await provider.generate(prompt="hi", model=MODEL, max_tokens=1024)

    # The provider returns LLMError for non-retryable 4xx.
    assert isinstance(result, LLMError), f"expected LLMError, got {type(result).__name__}"
    # Only ONE call — no thinking-retry attempted.
    assert mock_create.await_count == 1
    # Cache must NOT be polluted by unrelated errors.
    assert MODEL not in ap_module._thinking_unsupported_models


@pytest.mark.asyncio
async def test_first_call_success_does_not_touch_cache():
    """Test 4: a successful first call leaves the cache empty."""
    ok = _make_response("first try")
    provider, mock_create = _make_provider(side_effects=[ok])

    result = await provider.generate(prompt="hi", model=MODEL, max_tokens=1024)

    assert isinstance(result, LLMResponse)
    assert result.content == "first try"
    assert mock_create.await_count == 1
    # Cache stays empty when nothing failed.
    assert MODEL not in ap_module._thinking_unsupported_models
    assert len(ap_module._thinking_unsupported_models) == 0
