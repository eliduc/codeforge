"""Base agent class for CodeForge."""

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from jinja2.sandbox import SandboxedEnvironment

from app.db.models import AgentType
from app.llm import LLMError, LLMResponse, LLMRouter

logger = logging.getLogger(__name__)


@dataclass
class AgentResult:
    """Result from an agent execution."""

    success: bool
    content: str
    parsed_data: dict[str, Any] | None = None
    input_tokens: int = 0
    output_tokens: int = 0
    thinking_tokens: int = 0
    cost_usd: float = 0.0
    latency_ms: int = 0
    error: str | None = None
    raw_response: dict[str, Any] | None = None
    stop_reason: str | None = None


class BaseAgent(ABC):
    """Abstract base class for all agents."""

    agent_type: AgentType
    _jinja_env: SandboxedEnvironment | None = None

    def __init__(
        self,
        llm_router: LLMRouter,
        provider: str,
        model: str,
        prompt_template: str,
        agent_index: int = 0,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        thinking_effort: str | None = None,
    ):
        self.llm_router = llm_router
        self.provider = provider
        self.model = model
        self.prompt_template = prompt_template
        self.agent_index = agent_index
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.thinking_effort = thinking_effort

    @property
    def llm_provider(self) -> str:
        """Alias for provider."""
        return self.provider

    @property
    def llm_model(self) -> str:
        """Alias for model."""
        return self.model

    @classmethod
    def _get_jinja_env(cls) -> SandboxedEnvironment:
        """Return a cached SandboxedEnvironment instance."""
        if cls._jinja_env is None:
            cls._jinja_env = SandboxedEnvironment()
        return cls._jinja_env

    def render_prompt(self, **context: Any) -> str:
        """Render the prompt template with given context."""
        env = self._get_jinja_env()
        template = env.from_string(self.prompt_template)
        return template.render(**context)

    @abstractmethod
    async def execute(self, **kwargs: Any) -> AgentResult:
        """Execute the agent's task."""
        pass

    @abstractmethod
    def parse_response(self, content: str) -> dict[str, Any]:
        """Parse the LLM response into structured data."""
        pass

    async def _call_llm(
        self,
        prompt: str,
        system_prompt: str | None = None,
        max_tokens: int | None = None,
        thinking_effort: str | None = None,
    ) -> LLMResponse | LLMError:
        """Call the LLM with the given prompt."""
        effective_effort = thinking_effort if thinking_effort is not None else self.thinking_effort
        return await self.llm_router.generate(
            provider=self.provider,
            model=self.model,
            prompt=prompt,
            temperature=self.temperature,
            max_tokens=max_tokens if max_tokens is not None else self.max_tokens,
            system_prompt=system_prompt,
            thinking_effort=effective_effort,
        )

    def _create_result(
        self,
        response: LLMResponse | LLMError,
        parsed_data: dict[str, Any] | None = None,
    ) -> AgentResult:
        """Create an AgentResult from an LLM response."""
        if isinstance(response, LLMError):
            return AgentResult(
                success=False,
                content="",
                error=response.message,
                raw_response={"error": response.message, "type": response.error_type},
            )

        cost = self.llm_router.calculate_cost(
            self.provider,
            self.model,
            response.input_tokens,
            response.output_tokens,
            response.thinking_tokens,
        )

        return AgentResult(
            success=True,
            content=response.content,
            parsed_data=parsed_data,
            input_tokens=response.input_tokens,
            output_tokens=response.output_tokens,
            thinking_tokens=response.thinking_tokens,
            cost_usd=cost,
            latency_ms=response.latency_ms,
            raw_response=response.raw_response,
            stop_reason=getattr(response, 'stop_reason', None),
        )
