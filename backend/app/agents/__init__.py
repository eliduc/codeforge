"""CodeForge agents module."""

from app.agents.base import AgentResult, BaseAgent
from app.agents.coder import CoderAgent, DEFAULT_CODER_PROMPT
from app.agents.finalizer import FinalizerAgent, DEFAULT_FINALIZER_PROMPT
from app.agents.summarizer import SummarizerAgent, DEFAULT_SUMMARIZER_PROMPT
from app.agents.tester import TesterAgent, DEFAULT_TESTER_PROMPT
from app.agents.enhancer import (
    DesignEnhancerAgent,
    FunctionalityEnhancerAgent,
    SecurityEnhancerAgent,
    EnhancementSummarizerAgent,
    format_suggestions_for_spec,
)

__all__ = [
    # Base
    "BaseAgent",
    "AgentResult",
    # Agents
    "CoderAgent",
    "TesterAgent",
    "SummarizerAgent",
    "FinalizerAgent",
    # Enhancer Agents
    "DesignEnhancerAgent",
    "FunctionalityEnhancerAgent",
    "SecurityEnhancerAgent",
    "EnhancementSummarizerAgent",
    "format_suggestions_for_spec",
    # Default prompts
    "DEFAULT_CODER_PROMPT",
    "DEFAULT_TESTER_PROMPT",
    "DEFAULT_SUMMARIZER_PROMPT",
    "DEFAULT_FINALIZER_PROMPT",
]
