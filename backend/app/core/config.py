"""Application configuration with environment variables."""

import logging
import secrets
from functools import lru_cache
from typing import Any

from pydantic import PostgresDsn, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_config_logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application
    app_name: str = "CodeForge"
    debug: bool = False
    log_level: str = "INFO"
    secret_key: str = ""
    cors_origins: str = "*"  # Comma-separated origins, or "*" for dev
    cors_allow_wildcard: bool = False  # Explicit opt-in to '*' CORS in debug mode (LOCAL DEV ONLY)
    codeforge_api_key: SecretStr | None = None

    @model_validator(mode="after")
    def _ensure_secret_key(self) -> "Settings":
        """Generate a random secret key if none is set, and warn.

        In non-debug mode with weak/empty key, generate ephemeral but log a
        prominent warning.  Sessions will be lost on restart.
        """
        # Common public-placeholder values that should be rejected as weak.
        # Includes templates left in .env files from copy-paste, dev defaults,
        # and well-known framework placeholders.
        weak_defaults = {
            "",
            "change-me-in-production",
            "your-secret-key-change-in-production",
            "your-secret-key-here",
            "secret-key",
            "changeme",
            "default-secret",
            "dev-secret-key",
            "test-secret",
        }
        if self.secret_key in weak_defaults:
            original = self.secret_key
            self.secret_key = secrets.token_urlsafe(48)
            _config_logger.log(
                logging.ERROR if not self.debug else logging.WARNING,
                "SECRET_KEY is a known weak/placeholder value (%r) — generated "
                "a random ephemeral key. JWTs will be invalidated on restart! "
                "Set SECRET_KEY in your .env to a strong random value (e.g. "
                "`python -c \"import secrets; print(secrets.token_urlsafe(48))\"`).",
                original or "<empty>",
            )
        return self

    # Database
    database_url: PostgresDsn = "postgresql+asyncpg://codeforge:codeforge_secret@localhost:5432/codeforge"

    # LLM API Keys
    openai_api_key: SecretStr | None = None
    anthropic_api_key: SecretStr | None = None
    google_api_key: SecretStr | None = None
    grok_api_key: SecretStr | None = None
    ollama_base_url: str = "http://localhost:11434"

    # Code Execution
    docker_socket: str = "/var/run/docker.sock"
    execution_timeout: int = 60
    max_memory_mb: int = 512

    # Rate Limiting (requests per minute per provider)
    rate_limit_openai: int = 10
    rate_limit_anthropic: int = 10
    rate_limit_google: int = 10
    rate_limit_grok: int = 10
    rate_limit_ollama: int = 100

    # Workflow defaults
    default_max_iterations: int = 5
    default_auto_continue: bool = True
    sandbox_image: str = "codeforge-python-sandbox:latest"

    # Email / SMTP (OTP delivery)
    smtp_host: str | None = None  # None → dev mode (OTP logged to console)
    smtp_port: int = 587
    smtp_user: str | None = None
    smtp_password: SecretStr | None = None
    smtp_from_email: str = "noreply@codeforge.local"
    smtp_use_tls: bool = True

    # Auth — email OTP + JWT
    allowed_emails: str | None = None  # comma-separated whitelist, e.g. "user@x.com,*@company.com"
    admin_email: str | None = None  # receives access requests from non-whitelisted users (set ADMIN_EMAIL env var)
    jwt_expiry_minutes: int = 1440  # 24 hours
    otp_expiry_minutes: int = 5
    otp_length: int = 6

    @field_validator("database_url", mode="before")
    @classmethod
    def ensure_async_driver(cls, v: Any) -> Any:
        if isinstance(v, str) and v.startswith("postgresql://"):
            return v.replace("postgresql://", "postgresql+asyncpg://", 1)
        return v

    @property
    def available_providers(self) -> list[str]:
        """Return list of configured LLM providers."""
        providers = []
        if self.openai_api_key and self.openai_api_key.get_secret_value():
            providers.append("openai")
        if self.anthropic_api_key and self.anthropic_api_key.get_secret_value():
            providers.append("anthropic")
        if self.google_api_key and self.google_api_key.get_secret_value():
            providers.append("google")
        if self.grok_api_key and self.grok_api_key.get_secret_value():
            providers.append("grok")
        providers.append("ollama")  # Always available locally
        return providers

    def get_rate_limit(self, provider: str) -> int:
        """Get rate limit for a specific provider."""
        limits = {
            "openai": self.rate_limit_openai,
            "anthropic": self.rate_limit_anthropic,
            "google": self.rate_limit_google,
            "grok": self.rate_limit_grok,
            "ollama": self.rate_limit_ollama,
        }
        return limits.get(provider, 10)

    @property
    def sync_database_url(self) -> str:
        """Get sync database URL for Alembic migrations."""
        return str(self.database_url).replace("+asyncpg", "")


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


settings = get_settings()
