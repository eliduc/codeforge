"""
Application settings and LLM provider API routes.
"""
from typing import List

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import AppSetting
from app.config import get_settings, AVAILABLE_MODELS, LLM_PRICING
from app.schemas import (
    LLMProvider, LLMProviderSettings, AppSettingsResponse,
    TestLLMRequest, TestLLMResponse
)
from app.llm.router import get_llm_router

router = APIRouter()

settings = get_settings()


def _get_rate_limits() -> dict:
    """Get rate limits for all providers (single source of truth)."""
    return {
        LLMProvider.OPENAI: settings.rate_limit_openai,
        LLMProvider.ANTHROPIC: settings.rate_limit_anthropic,
        LLMProvider.GOOGLE: settings.rate_limit_google,
        LLMProvider.GROK: settings.rate_limit_grok,
        LLMProvider.OLLAMA: settings.rate_limit_ollama,
    }


async def _check_sandbox_health() -> bool:
    """Check if the sandbox service is reachable via a quick HTTP health check."""
    import os
    sandbox_url = os.getenv("SANDBOX_URL", "http://sandbox:8080")
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{sandbox_url}/health")
            return resp.status_code == 200
    except Exception:
        return False


@router.get("/", response_model=AppSettingsResponse)
async def get_app_settings(
    db: AsyncSession = Depends(get_db),
):
    """Get application settings including LLM provider status."""
    router_instance = await get_llm_router()

    providers = []
    for provider in LLMProvider:
        is_available = router_instance.is_provider_available(provider)
        models = AVAILABLE_MODELS.get(provider.value, [])

        # Get rate limit
        rate_limits = _get_rate_limits()

        providers.append(LLMProviderSettings(
            provider=provider,
            api_key_set=is_available,
            available_models=models,
            rate_limit=rate_limits.get(provider, 10),
        ))

    return AppSettingsResponse(
        llm_providers=providers,
        default_max_iterations=settings.default_max_iterations,
        default_timeout_sec=settings.execution_timeout,
        sandbox_available=await _check_sandbox_health(),
    )


@router.get("/providers")
async def get_providers():
    """Get LLM providers in frontend-expected format."""
    router_instance = await get_llm_router()

    providers = []
    for provider in LLMProvider:
        # Use async check which also populates models
        is_available = await router_instance.check_provider_availability(provider.value)

        # Get available models (after is_available populates them)
        try:
            models = await router_instance.get_available_models(provider)
            if not models:
                models = AVAILABLE_MODELS.get(provider.value, [])
        except Exception:
            models = AVAILABLE_MODELS.get(provider.value, [])

        rate_limits = _get_rate_limits()

        # Get per-model capabilities (thinking_effort_options etc.)
        model_capabilities = router_instance.get_model_capabilities(provider.value)

        providers.append({
            "name": provider.value,
            "available": is_available,
            "configured": is_available,
            "models": models,
            "model_capabilities": model_capabilities,
            "rate_limit": rate_limits.get(provider, 10),
        })

    return {"providers": providers}


@router.get("/llm-providers", response_model=List[LLMProviderSettings])
async def list_llm_providers():
    """List all LLM providers and their status."""
    router_instance = await get_llm_router()

    providers = []
    for provider in LLMProvider:
        is_available = router_instance.is_provider_available(provider)

        # Get available models (try to fetch dynamically)
        try:
            models = await router_instance.get_available_models(provider)
        except Exception:
            models = AVAILABLE_MODELS.get(provider.value, [])

        rate_limits = _get_rate_limits()

        providers.append(LLMProviderSettings(
            provider=provider,
            api_key_set=is_available,
            available_models=models,
            rate_limit=rate_limits.get(provider, 10),
        ))

    return providers


@router.post("/test-llm", response_model=TestLLMResponse)
async def test_llm_connection(
    request: TestLLMRequest,
):
    """Test connection to an LLM provider."""
    router_instance = await get_llm_router()

    import time
    start = time.time()

    try:
        success = await router_instance.test_provider(request.provider, request.model)
        latency = int((time.time() - start) * 1000)

        return TestLLMResponse(
            success=success,
            message="Connection successful" if success else "Connection failed",
            latency_ms=latency,
        )
    except Exception as e:
        latency = int((time.time() - start) * 1000)
        # BUG #26: Sanitize error — don't expose internal details/stack traces
        error_msg = str(e)
        # Strip API keys or tokens that might appear in error messages
        import re as _re
        error_msg = _re.sub(r'(sk-|key-|Bearer\s+)\S+', r'\1***', error_msg)
        # Truncate to prevent overly long error messages
        if len(error_msg) > 200:
            error_msg = error_msg[:200] + "..."
        return TestLLMResponse(
            success=False,
            message=f"Connection test failed: {error_msg}",
            latency_ms=latency,
        )


@router.post("/providers/{provider}/test")
async def test_provider_connection(provider: LLMProvider):
    """Test connection to a specific LLM provider (auto-selects first model)."""
    router_instance = await get_llm_router()

    import time
    start = time.time()

    try:
        # Ensure provider is available and models are fetched
        is_available = await router_instance.check_provider_availability(provider.value)
        if not is_available:
            return {
                "success": False,
                "message": f"Provider {provider.value} is not available or not configured",
                "latency_ms": int((time.time() - start) * 1000)
            }

        # Get first available model for the provider
        models = await router_instance.get_available_models(provider)
        if not models:
            return {
                "success": False,
                "message": f"No models available for {provider.value}",
                "latency_ms": int((time.time() - start) * 1000)
            }

        model = models[0]
        success = await router_instance.test_provider(provider.value, model)
        latency = int((time.time() - start) * 1000)

        return {
            "success": success,
            "message": f"Connection successful (tested with {model})" if success else f"Connection failed with {model}",
            "latency_ms": latency,
            "model_tested": model
        }
    except Exception as e:
        latency = int((time.time() - start) * 1000)
        # BUG #26: Sanitize error message
        import re as _re
        error_msg = _re.sub(r'(sk-|key-|Bearer\s+)\S+', r'\1***', str(e))[:200]
        return {
            "success": False,
            "message": f"Connection test failed: {error_msg}",
            "latency_ms": latency
        }


@router.get("/pricing", response_model=dict)
async def get_llm_pricing():
    """Get LLM pricing information."""
    return LLM_PRICING


@router.post("/refresh-models")
async def refresh_models():
    """Force refresh of all provider models from APIs."""
    router_instance = await get_llm_router()

    results = await router_instance.refresh_all_models()

    return {
        "success": True,
        "message": "Models refreshed successfully",
        "providers": results
    }


@router.post("/refresh-models/{provider}")
async def refresh_provider_models(provider: LLMProvider):
    """Force refresh models for a specific provider."""
    router_instance = await get_llm_router()

    result = await router_instance.refresh_provider_models(provider.value)

    return {
        "success": result["success"],
        "provider": provider.value,
        "models": result["models"],
        "message": result.get("error", "Models refreshed successfully")
    }


@router.get("/models/{provider}", response_model=List[str])
async def get_provider_models(
    provider: LLMProvider,
):
    """Get available models for a specific provider."""
    router_instance = await get_llm_router()

    try:
        models = await router_instance.get_available_models(provider)
        return models
    except Exception:
        return AVAILABLE_MODELS.get(provider.value, [])


@router.get("/providers/{provider}/config")
async def get_provider_config(
    provider: LLMProvider,
    db: AsyncSession = Depends(get_db),
):
    """Get provider configuration (API key masked)."""
    # Check if there's a stored API key
    stmt = select(AppSetting).where(AppSetting.key == f"api_key_{provider.value}")
    result = await db.execute(stmt)
    key_setting = result.scalar_one_or_none()

    # Check for stored rate limit
    stmt = select(AppSetting).where(AppSetting.key == f"rate_limit_{provider.value}")
    result = await db.execute(stmt)
    rate_setting = result.scalar_one_or_none()

    # Get defaults from environment
    env_rate_limits = _get_rate_limits()

    api_key = key_setting.value.get("key", "") if key_setting else ""
    rate_limit = rate_setting.value.get("rate_limit", env_rate_limits.get(provider, 10)) if rate_setting else env_rate_limits.get(provider, 10)

    # Mask API key for display
    if api_key:
        if len(api_key) > 8:
            masked = api_key[:4] + "*" * (len(api_key) - 8) + api_key[-4:]
        else:
            masked = "*" * len(api_key)
    else:
        masked = ""

    return {
        "provider": provider.value,
        "api_key_masked": masked,
        "api_key_set": bool(api_key),
        "rate_limit": rate_limit,
    }


class ProviderConfigUpdate(BaseModel):
    """Validated provider configuration update."""
    api_key: str | None = None
    rate_limit: int | None = Field(default=None, ge=1, le=1000)


@router.put("/providers/{provider}/config")
async def update_provider_config(
    provider: LLMProvider,
    config: ProviderConfigUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update provider configuration (API key and/or rate limit)."""
    from app.llm.router import llm_router

    updated = []

    # Update API key if provided
    if config.api_key:
        api_key = config.api_key.strip()
        # BUG #25: Basic API key validation — reject empty/whitespace-only keys
        if not api_key:
            raise HTTPException(status_code=400, detail="API key cannot be empty or whitespace")
        if len(api_key) < 8:
            raise HTTPException(status_code=400, detail="API key is too short (minimum 8 characters)")
        stmt = select(AppSetting).where(AppSetting.key == f"api_key_{provider.value}")
        result = await db.execute(stmt)
        key_setting = result.scalar_one_or_none()

        if key_setting:
            key_setting.value = {"key": api_key}
        else:
            key_setting = AppSetting(key=f"api_key_{provider.value}", value={"key": api_key})
            db.add(key_setting)

        updated.append("api_key")

        # Reinitialize the provider with new key
        await llm_router.update_provider_key(provider.value, api_key)

    # Update rate limit if provided
    if config.rate_limit is not None:
        rate_limit = config.rate_limit
        stmt = select(AppSetting).where(AppSetting.key == f"rate_limit_{provider.value}")
        result = await db.execute(stmt)
        rate_setting = result.scalar_one_or_none()

        if rate_setting:
            rate_setting.value = {"rate_limit": rate_limit}
        else:
            rate_setting = AppSetting(key=f"rate_limit_{provider.value}", value={"rate_limit": rate_limit})
            db.add(rate_setting)

        updated.append("rate_limit")

        # Update rate limiter
        llm_router.update_rate_limit(provider.value, rate_limit)

    await db.commit()

    return {
        "success": True,
        "provider": provider.value,
        "updated": updated,
        "message": f"Updated {', '.join(updated)} for {provider.value}"
    }


# Allowed setting keys for the generic app settings endpoints
_ALLOWED_SETTING_KEYS = {
    "ui_theme", "default_pipeline", "default_language",
    "auto_continue", "default_enhancers",
}


def _validate_setting_key(key: str) -> None:
    if key not in _ALLOWED_SETTING_KEYS:
        raise HTTPException(
            status_code=400,
            detail=f"Setting key '{key}' is not allowed. Allowed keys: {sorted(_ALLOWED_SETTING_KEYS)}",
        )


# App settings storage
@router.get("/app/{key}")
async def get_app_setting(
    key: str,
    db: AsyncSession = Depends(get_db),
):
    """Get an app setting by key."""
    _validate_setting_key(key)
    stmt = select(AppSetting).where(AppSetting.key == key)
    result = await db.execute(stmt)
    setting = result.scalar_one_or_none()

    if not setting:
        raise HTTPException(status_code=404, detail="Setting not found")

    return {"key": setting.key, "value": setting.value}


@router.put("/app/{key}")
async def set_app_setting(
    key: str,
    value: dict,
    db: AsyncSession = Depends(get_db),
):
    """Set an app setting."""
    _validate_setting_key(key)
    stmt = select(AppSetting).where(AppSetting.key == key)
    result = await db.execute(stmt)
    setting = result.scalar_one_or_none()

    if setting:
        setting.value = value
    else:
        setting = AppSetting(key=key, value=value)
        db.add(setting)

    await db.commit()

    return {"key": key, "value": value}
