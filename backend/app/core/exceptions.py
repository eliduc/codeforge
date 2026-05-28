"""CodeForge custom exception hierarchy for cleaner error handling."""


class CodeForgeError(Exception):
    """Base exception for all CodeForge errors."""


class WorkflowError(CodeForgeError):
    """Error in workflow execution (orchestrator, agents)."""


class DatabaseError(CodeForgeError):
    """Database-related error (commit failure, integrity, etc.)."""


class SandboxError(CodeForgeError):
    """Sandbox execution error."""


class LLMError(CodeForgeError):
    """LLM API error (separate from llm.types.LLMError which is a result type)."""


class IntegrityViolation(DatabaseError):
    """Unique constraint or foreign key violation."""


class WorkflowTimeout(WorkflowError):
    """Workflow exceeded its overall timeout."""
