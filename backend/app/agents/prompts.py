"""
Prompt templates for all agents.
Re-exports from individual agent modules for convenience.
"""
from app.agents.coder import DEFAULT_CODER_PROMPT as CODER_PROMPT
from app.agents.tester import DEFAULT_TESTER_PROMPT as TESTER_PROMPT
from app.agents.summarizer import DEFAULT_SUMMARIZER_PROMPT as SUMMARIZER_PROMPT
from app.agents.finalizer import DEFAULT_FINALIZER_PROMPT as FINALIZER_PROMPT

__all__ = [
    "CODER_PROMPT",
    "TESTER_PROMPT",
    "SUMMARIZER_PROMPT",
    "FINALIZER_PROMPT",
]
