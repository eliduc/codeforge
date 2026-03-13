"""
Sandbox Client - Interface to the code execution sandbox service.
"""

import asyncio
import logging
import os
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


class SandboxLanguage(str, Enum):
    """Supported programming languages."""
    PYTHON = "python"
    JAVASCRIPT = "javascript"
    TYPESCRIPT = "typescript"
    JAVA = "java"
    CPP = "cpp"
    C = "c"
    GO = "go"
    RUST = "rust"
    BASH = "bash"


@dataclass
class ExecutionResult:
    """Result of code execution."""
    success: bool
    exit_code: int
    stdout: str
    stderr: str
    execution_time_ms: int
    memory_used_mb: float = 0
    timeout_exceeded: bool = False
    error: Optional[str] = None
    installed_deps: list[str] = None

    def __post_init__(self):
        if self.installed_deps is None:
            self.installed_deps = []

    @property
    def has_runtime_error(self) -> bool:
        """Check if there was a runtime error."""
        return self.exit_code != 0 and not self.timeout_exceeded

    @property
    def output(self) -> str:
        """Combined output (stdout + stderr if error)."""
        if self.stderr and not self.success:
            return f"{self.stdout}\n\nErrors:\n{self.stderr}".strip()
        return self.stdout

    def to_dict(self) -> dict:
        """Convert to dictionary."""
        return {
            "success": self.success,
            "exit_code": self.exit_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "execution_time_ms": self.execution_time_ms,
            "memory_used_mb": self.memory_used_mb,
            "timeout_exceeded": self.timeout_exceeded,
            "error": self.error,
            "installed_deps": self.installed_deps,
        }


# Language mapping from common names to sandbox language enum
LANGUAGE_MAPPING = {
    "python": SandboxLanguage.PYTHON,
    "py": SandboxLanguage.PYTHON,
    "python3": SandboxLanguage.PYTHON,
    "javascript": SandboxLanguage.JAVASCRIPT,
    "javascript_browser": SandboxLanguage.JAVASCRIPT,
    "typescript_browser": SandboxLanguage.TYPESCRIPT,
    "js": SandboxLanguage.JAVASCRIPT,
    "node": SandboxLanguage.JAVASCRIPT,
    "typescript": SandboxLanguage.TYPESCRIPT,
    "ts": SandboxLanguage.TYPESCRIPT,
    "java": SandboxLanguage.JAVA,
    "cpp": SandboxLanguage.CPP,
    "c++": SandboxLanguage.CPP,
    "c": SandboxLanguage.C,
    "go": SandboxLanguage.GO,
    "golang": SandboxLanguage.GO,
    "rust": SandboxLanguage.RUST,
    "rs": SandboxLanguage.RUST,
    "bash": SandboxLanguage.BASH,
    "shell": SandboxLanguage.BASH,
    "sh": SandboxLanguage.BASH,
}


class SandboxClient:
    """Client for the sandbox code execution service."""

    def __init__(
        self,
        base_url: Optional[str] = None,
        timeout: float = 120.0,  # HTTP timeout (longer than execution timeout)
    ):
        """
        Initialize sandbox client.

        Args:
            base_url: Sandbox service URL (default from SANDBOX_URL env)
            timeout: HTTP request timeout
        """
        self.base_url = base_url or os.getenv("SANDBOX_URL", "http://sandbox:8080")
        self.timeout = timeout
        self._api_key = os.getenv("SANDBOX_API_KEY", "")
        self._client: Optional[httpx.AsyncClient] = None
        self._client_lock = asyncio.Lock()

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client (thread-safe with asyncio.Lock)."""
        async with self._client_lock:
            if self._client is None or self._client.is_closed:
                headers = {}
                if self._api_key:
                    headers["X-Sandbox-Key"] = self._api_key
                self._client = httpx.AsyncClient(
                    base_url=self.base_url,
                    timeout=self.timeout,
                    headers=headers,
                )
            return self._client

    async def close(self):
        """Close the HTTP client."""
        if self._client and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    def _normalize_language(self, language: str) -> SandboxLanguage:
        """Convert language string to SandboxLanguage enum."""
        lang_lower = language.lower().strip()

        if lang_lower in LANGUAGE_MAPPING:
            return LANGUAGE_MAPPING[lang_lower]

        # Try to match as enum value directly
        try:
            return SandboxLanguage(lang_lower)
        except ValueError:
            pass

        # Default to Python
        logger.warning(f"Unknown language '{language}', defaulting to Python")
        return SandboxLanguage.PYTHON

    async def health_check(self) -> bool:
        """Check if sandbox service is healthy."""
        try:
            client = await self._get_client()
            response = await client.get("/health")
            return response.status_code == 200
        except Exception as e:
            logger.warning(f"Sandbox health check failed: {e}")
            return False

    # Languages that generate HTML pages for browser execution (not Node.js)
    BROWSER_LANGUAGES = frozenset({"javascript_browser", "typescript_browser", "html"})

    async def execute(
        self,
        code: str,
        language: str,
        stdin: str = "",
        timeout: int = 60,
        memory_limit_mb: int = 512,
        auto_install_deps: bool = True,
    ) -> ExecutionResult:
        """
        Execute code in the sandbox.

        For browser languages (javascript_browser, typescript_browser, html),
        the code is validated in headless Chromium instead of being run in Node.js.
        This catches WebGL/GLSL errors, DOM errors, and JS runtime errors.

        Args:
            code: Source code to execute
            language: Programming language
            stdin: Standard input for the program
            timeout: Execution timeout in seconds
            memory_limit_mb: Memory limit in MB
            auto_install_deps: Whether to auto-install dependencies

        Returns:
            ExecutionResult with execution details
        """
        # Browser languages are validated via headless Chromium, not Node.js
        lang_lower = language.lower().strip()
        if lang_lower in self.BROWSER_LANGUAGES:
            return await self.validate_browser(code=code, timeout=timeout)

        try:
            client = await self._get_client()

            sandbox_language = self._normalize_language(language)

            logger.info(
                f"Executing {sandbox_language.value} code, "
                f"timeout={timeout}s, memory={memory_limit_mb}MB"
            )

            # Per-request timeout: sandbox execution timeout + buffer for overhead
            request_timeout = timeout + 15
            response = await client.post(
                "/execute",
                json={
                    "code": code,
                    "language": sandbox_language.value,
                    "stdin": stdin,
                    "timeout": timeout,
                    "memory_limit_mb": memory_limit_mb,
                    "auto_install_deps": auto_install_deps,
                },
                timeout=request_timeout,
            )

            if response.status_code != 200:
                error_text = response.text[:500]
                logger.error(f"Sandbox returned {response.status_code}: {error_text}")
                return ExecutionResult(
                    success=False,
                    exit_code=-1,
                    stdout="",
                    stderr="",
                    execution_time_ms=0,
                    error=f"Sandbox service error: {response.status_code} - {error_text}"
                )

            data = response.json()

            result = ExecutionResult(
                success=data.get("success", False),
                exit_code=data.get("exit_code", -1),
                stdout=data.get("stdout", ""),
                stderr=data.get("stderr", ""),
                execution_time_ms=data.get("execution_time_ms", 0),
                memory_used_mb=data.get("memory_used_mb", 0),
                timeout_exceeded=data.get("timeout_exceeded", False),
                error=data.get("error"),
                installed_deps=data.get("installed_deps", []),
            )

            logger.info(
                f"Execution complete: success={result.success}, "
                f"exit_code={result.exit_code}, time={result.execution_time_ms}ms"
            )

            return result

        except httpx.TimeoutException:
            logger.error(f"Sandbox request timed out after {timeout}+15s")
            return ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                execution_time_ms=int(timeout * 1000),
                timeout_exceeded=True,
                error=f"Execution timed out after {timeout}s — code may have an infinite loop"
            )
        except httpx.ConnectError as e:
            logger.error(f"Cannot connect to sandbox service: {e}")
            return ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                execution_time_ms=0,
                error=f"Cannot connect to sandbox service at {self.base_url}"
            )
        except Exception as e:
            logger.exception(f"Sandbox execution error: {e}")
            return ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                execution_time_ms=0,
                error=str(e)[:500]
            )

    async def list_languages(self) -> list[str]:
        """Get list of supported languages."""
        try:
            client = await self._get_client()
            response = await client.get("/languages")

            if response.status_code == 200:
                data = response.json()
                return data.get("languages", [])

            return [lang.value for lang in SandboxLanguage]

        except Exception as e:
            logger.warning(f"Failed to get languages from sandbox: {e}")
            return [lang.value for lang in SandboxLanguage]

    async def bundle(
        self,
        code: str,
        language: str,
        timeout: int = 60,
        auto_install_deps: bool = True,
        html_template: str | None = None,
    ) -> dict:
        """
        Bundle JS/TS code into a browser-ready HTML page.

        Args:
            code: Source code (may contain multi-file markers)
            language: Programming language (javascript/typescript)
            timeout: Build timeout in seconds
            auto_install_deps: Whether to auto-install npm dependencies
            html_template: Optional custom HTML template with {{SCRIPT}} placeholder

        Returns:
            Dict with keys: success, html, error, build_time_ms, bundled_size_bytes, warnings
        """
        try:
            client = await self._get_client()

            sandbox_language = self._normalize_language(language)

            logger.info(f"Bundling {sandbox_language.value} code, timeout={timeout}s")

            payload = {
                "code": code,
                "language": sandbox_language.value,
                "timeout": timeout,
                "auto_install_deps": auto_install_deps,
            }
            if html_template:
                payload["html_template"] = html_template

            response = await client.post("/bundle", json=payload)

            if response.status_code != 200:
                error_text = response.text[:500]
                logger.error(f"Sandbox bundle returned {response.status_code}: {error_text}")
                return {
                    "success": False,
                    "html": "",
                    "error": f"Sandbox bundle error: {response.status_code} - {error_text}",
                }

            data = response.json()
            logger.info(
                f"Bundle complete: success={data.get('success')}, "
                f"size={data.get('bundled_size_bytes', 0)} bytes"
            )
            return data

        except httpx.TimeoutException:
            logger.error("Sandbox bundle request timed out")
            return {"success": False, "html": "", "error": "Bundle request timeout"}
        except httpx.ConnectError as e:
            logger.error(f"Cannot connect to sandbox for bundling: {e}")
            return {"success": False, "html": "", "error": f"Cannot connect to sandbox at {self.base_url}"}
        except Exception as e:
            logger.exception(f"Sandbox bundle error: {e}")
            return {"success": False, "html": "", "error": str(e)[:500]}


    # Maximum timeout the executor's /validate-browser endpoint accepts
    _BROWSER_VALIDATION_MAX_TIMEOUT = 60

    async def validate_browser(
        self,
        code: str,
        timeout: int = 15,
    ) -> ExecutionResult:
        """
        Validate browser code (HTML page) by loading it in headless Chromium.

        Catches WebGL/GLSL shader compilation errors, JS runtime errors,
        uncaught exceptions, and resource loading failures.

        Args:
            code: HTML page content to validate
            timeout: Validation timeout in seconds (clamped to max 60)

        Returns:
            ExecutionResult with validation details
        """
        try:
            client = await self._get_client()

            # Clamp timeout to executor's max (Chromium doesn't need long timeouts)
            effective_timeout = min(timeout, self._BROWSER_VALIDATION_MAX_TIMEOUT)
            logger.info(f"Validating browser code in headless Chromium, timeout={effective_timeout}s")

            # Browser validation has longer startup time (Chromium launch)
            request_timeout = effective_timeout + 30
            response = await client.post(
                "/validate-browser",
                json={
                    "html": code,
                    "timeout": effective_timeout,
                },
                timeout=request_timeout,
            )

            if response.status_code != 200:
                error_text = response.text[:500]
                logger.error(f"Browser validation returned {response.status_code}: {error_text}")
                return ExecutionResult(
                    success=False,
                    exit_code=-1,
                    stdout="",
                    stderr="",
                    execution_time_ms=0,
                    error=f"Browser validation service error: {response.status_code} - {error_text}",
                )

            data = response.json()

            result = ExecutionResult(
                success=data.get("success", False),
                exit_code=data.get("exit_code", -1),
                stdout=data.get("stdout", ""),
                stderr=data.get("stderr", ""),
                execution_time_ms=data.get("execution_time_ms", 0),
                memory_used_mb=data.get("memory_used_mb", 0),
                timeout_exceeded=data.get("timeout_exceeded", False),
                error=data.get("error"),
            )

            logger.info(
                f"Browser validation complete: success={result.success}, "
                f"time={result.execution_time_ms}ms"
            )

            return result

        except httpx.TimeoutException:
            logger.error(f"Browser validation timed out after {timeout}+30s")
            return ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                execution_time_ms=int(timeout * 1000),
                timeout_exceeded=True,
                error=f"Browser validation timed out after {timeout}s",
            )
        except httpx.ConnectError as e:
            logger.error(f"Cannot connect to sandbox for browser validation: {e}")
            return ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                execution_time_ms=0,
                error=f"Cannot connect to sandbox service at {self.base_url}",
            )
        except Exception as e:
            logger.exception(f"Browser validation error: {e}")
            return ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                execution_time_ms=0,
                error=str(e)[:500],
            )


# Global sandbox client instance
# ACCEPTED RISK (BUG #36): This singleton is not thread-safe, but the app
# uses asyncio (single-threaded event loop) so concurrent mutation is not
# possible under normal operation.
_sandbox_client: Optional[SandboxClient] = None


def get_sandbox_client() -> SandboxClient:
    """Get the global sandbox client instance."""
    global _sandbox_client
    if _sandbox_client is None:
        _sandbox_client = SandboxClient()
    return _sandbox_client


async def execute_code(
    code: str,
    language: str,
    stdin: str = "",
    timeout: int = 60,
    memory_limit_mb: int = 512,
    auto_install_deps: bool = True,
) -> ExecutionResult:
    """
    Convenience function to execute code.

    Args:
        code: Source code to execute
        language: Programming language
        stdin: Standard input
        timeout: Execution timeout in seconds
        memory_limit_mb: Memory limit
        auto_install_deps: Whether to auto-install dependencies

    Returns:
        ExecutionResult
    """
    client = get_sandbox_client()
    return await client.execute(
        code=code,
        language=language,
        stdin=stdin,
        timeout=timeout,
        memory_limit_mb=memory_limit_mb,
        auto_install_deps=auto_install_deps,
    )
