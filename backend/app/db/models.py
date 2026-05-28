"""SQLAlchemy database models for CodeForge. v1.1.0"""

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    CheckConstraint,
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from app.core.defaults import (
    DEFAULT_AGENT_TIMEOUT_SEC,
    DEFAULT_EXECUTION_TIMEOUT_SEC,
    DEFAULT_MAX_FIX_ATTEMPTS,
    DEFAULT_MAX_ITERATIONS,
    DEFAULT_REQUEST_TIMEOUT_SEC,
)


class Base(DeclarativeBase):
    """Base class for all models."""

    type_annotation_map = {
        dict[str, Any]: JSON,
    }


class SessionStatus(str, Enum):
    """Session workflow status."""

    CREATED = "created"
    RUNNING = "running"
    PAUSED = "paused"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    AWAITING_ENHANCEMENT = "awaiting_enhancement"
    ENHANCING = "enhancing"
    AWAITING_ENHANCEMENT_REVIEW = "awaiting_enhancement_review"
    AWAITING_VISUAL_REVIEW = "awaiting_visual_review"


class AgentType(str, Enum):
    """Types of agents in the system."""

    CODER = "coder"
    TESTER = "tester"
    SUMMARIZER = "summarizer"
    FINALIZER = "finalizer"
    ENHANCER_DESIGN = "enhancer_design"
    ENHANCER_FUNC = "enhancer_func"
    ENHANCER_SECURITY = "enhancer_security"
    ENHANCER_SUMMARY = "enhancer_summary"


class IssueSeverity(str, Enum):
    """Severity levels for code issues."""

    CRITICAL = "critical"
    SERIOUS = "serious"
    MINOR = "minor"
    SUGGESTION = "suggestion"


class CodeVersionStatus(str, Enum):
    """Status of a code version."""

    GENERATED = "generated"
    TESTING = "testing"
    TESTED = "tested"
    FINALIZED = "finalized"


# ============================================================================
# Session and Configuration Models
# ============================================================================


class Session(Base):
    """A code generation/audit session."""

    __tablename__ = "sessions"
    __table_args__ = (
        # Valid status values: created, running, paused, completed, failed,
        # cancelled, awaiting_enhancement, enhancing, awaiting_enhancement_review,
        # awaiting_visual_review
        CheckConstraint(
            "status IN ('created', 'running', 'paused', 'completed', 'failed', "
            "'cancelled', 'awaiting_enhancement', 'enhancing', 'awaiting_enhancement_review', "
            "'awaiting_visual_review')",
            name="ck_sessions_status_valid",
        ),
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    specification: Mapped[str] = mapped_column(Text, nullable=False)
    original_specification: Mapped[str | None] = mapped_column(Text, nullable=True)
    initial_code: Mapped[str | None] = mapped_column(Text)
    initial_docs: Mapped[str | None] = mapped_column(Text)
    attachments: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    language: Mapped[str] = mapped_column(String(50), default="python")
    max_iterations: Mapped[int] = mapped_column(Integer, default=DEFAULT_MAX_ITERATIONS)
    current_iteration: Mapped[int] = mapped_column(Integer, default=0)
    auto_continue: Mapped[bool] = mapped_column(Boolean, default=True)

    # Code execution settings
    enable_code_execution: Mapped[bool] = mapped_column(Boolean, default=True)
    execution_timeout: Mapped[int] = mapped_column(Integer, default=DEFAULT_EXECUTION_TIMEOUT_SEC)  # seconds
    max_fix_attempts: Mapped[int] = mapped_column(Integer, default=DEFAULT_MAX_FIX_ATTEMPTS)
    auto_install_deps: Mapped[bool] = mapped_column(Boolean, default=True)
    agent_timeout: Mapped[int] = mapped_column(Integer, default=DEFAULT_AGENT_TIMEOUT_SEC)  # Overall agent timeout (asyncio.wait_for) in seconds
    request_timeout: Mapped[int] = mapped_column(Integer, default=DEFAULT_REQUEST_TIMEOUT_SEC)  # Per-LLM-request httpx timeout in seconds

    # Cost / time guards (None = no limit)
    cost_limit_usd: Mapped[float | None] = mapped_column(Numeric(10, 2), nullable=True)
    session_timeout_sec: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Test-driven mode: if set, coder output is compared against this expected output
    expected_output: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[SessionStatus] = mapped_column(String(50), default=SessionStatus.CREATED, index=True)
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)

    # Enhancement chain
    parent_session_id: Mapped[str | None] = mapped_column(UUID(as_uuid=False), ForeignKey("sessions.id", ondelete="SET NULL"), nullable=True, index=True)
    enhancement_round: Mapped[int] = mapped_column(Integer, default=0)

    # Multi-tenancy: owner of this session (nullable for backwards-compat with
    # pre-migration rows / API-key auth). Existing rows are backfilled to the
    # first user in migration 017.
    user_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    # Public read-only share token (Feature #5). Nullable; minted by the
    # owner via POST /api/sessions/{id}/share. Unique so each token resolves
    # to at most one session in GET /api/share/{token}.
    share_token: Mapped[str | None] = mapped_column(
        String(64), nullable=True, unique=True, index=True
    )

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    agent_configs: Mapped[list["AgentConfig"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    code_versions: Mapped[list["CodeVersion"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    audits: Mapped[list["Audit"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    summary_audits: Mapped[list["SummaryAudit"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    coder_responses: Mapped[list["CoderResponse"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    llm_requests: Mapped[list["LLMRequest"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    interventions: Mapped[list["Intervention"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    final_result: Mapped["FinalResult | None"] = relationship(back_populates="session", uselist=False, cascade="all, delete-orphan")
    enhancement_suggestions: Mapped[list["EnhancementSuggestion"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    visual_review_scores: Mapped[list["VisualReviewScore"]] = relationship(back_populates="session", cascade="all, delete-orphan")
    parent_session: Mapped["Session | None"] = relationship(remote_side="Session.id", foreign_keys="[Session.parent_session_id]")


class AgentConfig(Base):
    """Configuration for an agent in a session."""

    __tablename__ = "agent_configs"
    __table_args__ = (
        UniqueConstraint("session_id", "agent_type", "agent_index", name="uq_agent_config"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("sessions.id", ondelete="CASCADE"))
    agent_type: Mapped[AgentType] = mapped_column(String(20), nullable=False)
    agent_index: Mapped[int] = mapped_column(Integer, default=0)
    llm_provider: Mapped[str] = mapped_column(String(50), nullable=False)
    llm_model: Mapped[str] = mapped_column(String(100), nullable=False)
    prompt_template_id: Mapped[int | None] = mapped_column(Integer, ForeignKey("prompt_templates.id"))
    custom_prompt: Mapped[str | None] = mapped_column(Text)
    temperature: Mapped[float] = mapped_column(Float, default=0.7)
    max_tokens: Mapped[int] = mapped_column(Integer, default=4096)
    thinking_effort: Mapped[str | None] = mapped_column(String(20), nullable=True, default=None)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="agent_configs")
    prompt_template: Mapped["PromptTemplate | None"] = relationship()


class PromptTemplate(Base):
    """Reusable prompt templates for agents."""

    __tablename__ = "prompt_templates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    agent_type: Mapped[AgentType] = mapped_column(String(20), nullable=False)
    template_text: Mapped[str] = mapped_column(Text, nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    description: Mapped[str | None] = mapped_column(Text)
    current_version: Mapped[int] = mapped_column(Integer, default=1, nullable=False, server_default=text("1"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PromptTemplateVersion(Base):
    """Historical versions of a PromptTemplate. Created on every update."""

    __tablename__ = "prompt_template_versions"
    __table_args__ = (
        UniqueConstraint("template_id", "version_number", name="uq_prompt_template_version"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    template_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("prompt_templates.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)

    # Snapshot of template fields at this version
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    agent_type: Mapped[str] = mapped_column(String(50), nullable=False)
    template_text: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Optional: who/what triggered this version
    change_note: Mapped[str | None] = mapped_column(String(500), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ============================================================================
# Code and Audit Models
# ============================================================================


class CodeVersion(Base):
    """A version of generated code from a coder agent."""

    __tablename__ = "code_versions"
    __table_args__ = (
        UniqueConstraint("session_id", "coder_index", "iteration", name="uq_code_version"),
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    coder_index: Mapped[int] = mapped_column(Integer, nullable=False)
    iteration: Mapped[int] = mapped_column(Integer, nullable=False)
    code_content: Mapped[str] = mapped_column(Text, nullable=False)
    file_structure: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    analysis: Mapped[str | None] = mapped_column(Text)
    status: Mapped[CodeVersionStatus] = mapped_column(String(20), default=CodeVersionStatus.GENERATED)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="code_versions")
    audits: Mapped[list["Audit"]] = relationship(back_populates="code_version", cascade="all, delete-orphan")
    executions: Mapped[list["CodeExecution"]] = relationship(back_populates="code_version", cascade="all, delete-orphan")
    screenshots: Mapped[list["CodeVersionScreenshot"]] = relationship(
        back_populates="code_version", cascade="all, delete-orphan"
    )
    visual_review_scores: Mapped[list["VisualReviewScore"]] = relationship(
        back_populates="code_version", cascade="all, delete-orphan"
    )


class Audit(Base):
    """An audit of a code version by a tester agent."""

    __tablename__ = "audits"
    __table_args__ = (
        UniqueConstraint("session_id", "code_version_id", "tester_index", name="uq_audit"),
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    code_version_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("code_versions.id", ondelete="CASCADE"))
    tester_index: Mapped[int] = mapped_column(Integer, nullable=False)
    iteration: Mapped[int] = mapped_column(Integer, nullable=False)
    audit_content: Mapped[str] = mapped_column(Text, nullable=False)
    overall_assessment: Mapped[str | None] = mapped_column(Text)
    specification_compliance: Mapped[int | None] = mapped_column(Integer)
    issues: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    positive_aspects: Mapped[list[str]] = mapped_column(JSON, default=list)
    test_cases_needed: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="audits")
    code_version: Mapped["CodeVersion"] = relationship(back_populates="audits")


class SummaryAudit(Base):
    """Summarized audit for a coder's code across all testers."""

    __tablename__ = "summary_audits"
    __table_args__ = (
        UniqueConstraint("session_id", "coder_index", "iteration", name="uq_summary_audit"),
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    coder_index: Mapped[int] = mapped_column(Integer, nullable=False)
    iteration: Mapped[int] = mapped_column(Integer, nullable=False)
    summary_content: Mapped[str] = mapped_column(Text, nullable=False)
    critical_issues: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    serious_issues: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    minor_issues: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    suggestions: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    consensus_notes: Mapped[str | None] = mapped_column(Text)
    recommended_focus: Mapped[list[str]] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="summary_audits")


class CoderResponse(Base):
    """Coder's response to audit summary - accepted/rejected issues."""

    __tablename__ = "coder_responses"
    __table_args__ = (
        UniqueConstraint("session_id", "coder_index", "iteration", name="uq_coder_response"),
    )

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("sessions.id", ondelete="CASCADE"))
    coder_index: Mapped[int] = mapped_column(Integer, nullable=False)
    iteration: Mapped[int] = mapped_column(Integer, nullable=False)
    accepted_issues: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    partial_issues: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    rejected_issues: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    rejection_reasons: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="coder_responses")


# ============================================================================
# Execution and Metrics Models
# ============================================================================


class CodeExecution(Base):
    """Record of code execution in sandbox."""

    __tablename__ = "code_executions"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    code_version_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("code_versions.id", ondelete="CASCADE"), index=True)
    executor_type: Mapped[str] = mapped_column(String(50), default="docker")
    command: Mapped[str | None] = mapped_column(Text)
    exit_code: Mapped[int | None] = mapped_column(Integer)
    stdout: Mapped[str | None] = mapped_column(Text)
    stderr: Mapped[str | None] = mapped_column(Text)
    execution_time_ms: Mapped[int | None] = mapped_column(Integer)
    memory_used_mb: Mapped[float | None] = mapped_column(Float)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    code_version: Mapped["CodeVersion"] = relationship(back_populates="executions")


class LLMRequest(Base):
    """Record of LLM API requests for metrics and cost tracking."""

    __tablename__ = "llm_requests"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    agent_type: Mapped[AgentType] = mapped_column(String(20), nullable=False, index=True)
    agent_index: Mapped[int] = mapped_column(Integer, default=0)
    iteration: Mapped[int] = mapped_column(Integer, nullable=False)
    llm_provider: Mapped[str] = mapped_column(String(50), nullable=False)
    llm_model: Mapped[str] = mapped_column(String(100), nullable=False)
    prompt_sent: Mapped[str] = mapped_column(Text, nullable=False)
    response_received: Mapped[str] = mapped_column(Text, nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(precision=12, scale=6), default=0.0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    error_message: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="llm_requests")


class Intervention(Base):
    """User intervention during workflow execution."""

    __tablename__ = "interventions"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    iteration: Mapped[int] = mapped_column(Integer, nullable=False)
    intervention_type: Mapped[str] = mapped_column(String(50), nullable=False)
    target_agent_type: Mapped[AgentType | None] = mapped_column(String(20))
    target_agent_index: Mapped[int | None] = mapped_column(Integer)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    applied: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="interventions")


class FinalResult(Base):
    """Final result of a completed session."""

    __tablename__ = "final_results"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("sessions.id", ondelete="CASCADE"), unique=True)
    selected_coder_index: Mapped[int] = mapped_column(Integer, nullable=False)
    final_code: Mapped[str] = mapped_column(Text, nullable=False)
    file_structure: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    readme_content: Mapped[str] = mapped_column(Text, nullable=False)
    api_docs: Mapped[str | None] = mapped_column(Text)
    report_pdf_path: Mapped[str | None] = mapped_column(String(500))
    selection_reasoning: Mapped[str] = mapped_column(Text, nullable=False)
    total_iterations: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_cost_usd: Mapped[float] = mapped_column(Numeric(precision=12, scale=6), default=0.0)
    known_limitations: Mapped[list[str]] = mapped_column(JSON, default=list)
    # Verification: execution of final code after finalization
    verification_passed: Mapped[bool | None] = mapped_column(Boolean)
    verification_exit_code: Mapped[int | None] = mapped_column(Integer)
    verification_stdout: Mapped[str | None] = mapped_column(Text)
    verification_stderr: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="final_result")


class EnhancementSuggestion(Base):
    """Improvement suggestion from an enhancement agent."""

    __tablename__ = "enhancement_suggestions"

    id: Mapped[str] = mapped_column(UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4()))
    session_id: Mapped[str] = mapped_column(UUID(as_uuid=False), ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    agent_type: Mapped[str] = mapped_column(String(20), nullable=False)  # enhancer_design/enhancer_func/enhancer_security/enhancer_summary
    content: Mapped[str] = mapped_column(Text, nullable=False)
    user_recommendations: Mapped[str | None] = mapped_column(Text)
    llm_provider: Mapped[str] = mapped_column(String(50), nullable=False)
    llm_model: Mapped[str] = mapped_column(String(100), nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(precision=12, scale=6), default=0.0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="enhancement_suggestions")


class AppSetting(Base):
    """Application-wide settings stored in database."""

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(255), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


# ---------------------------------------------------------------------------
# Authentication models
# ---------------------------------------------------------------------------


class User(Base):
    """Authenticated user (created on first successful OTP verification)."""

    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    email: Mapped[str] = mapped_column(String(255), unique=True, nullable=False, index=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_login_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class SessionTemplate(Base):
    """Saved session configuration that can be applied when creating new sessions."""

    __tablename__ = "session_templates"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Snapshot of agent_configs (list of dicts: agent_type, agent_index, llm_provider,
    # llm_model, prompt_template_id, custom_prompt, temperature, max_tokens,
    # thinking_effort, enabled).
    agent_configs: Mapped[list[dict[str, Any]]] = mapped_column(JSON, nullable=False, default=list)

    # Session-level settings
    language: Mapped[str] = mapped_column(String(50), nullable=False, default="python")
    max_iterations: Mapped[int] = mapped_column(Integer, nullable=False, default=DEFAULT_MAX_ITERATIONS)
    auto_continue: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    enable_code_execution: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    execution_timeout: Mapped[int] = mapped_column(Integer, nullable=False, default=DEFAULT_EXECUTION_TIMEOUT_SEC)
    max_fix_attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=DEFAULT_MAX_FIX_ATTEMPTS)
    auto_install_deps: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    agent_timeout: Mapped[int] = mapped_column(Integer, nullable=False, default=DEFAULT_AGENT_TIMEOUT_SEC)
    request_timeout: Mapped[int] = mapped_column(Integer, nullable=False, default=DEFAULT_REQUEST_TIMEOUT_SEC)

    settings: Mapped[dict[str, Any] | None] = mapped_column(JSON, nullable=True)

    # Multi-tenancy: owner of this template (nullable for backwards-compat).
    user_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Webhook(Base):
    """User-configured webhook for event notifications."""

    __tablename__ = "webhooks"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    url: Mapped[str] = mapped_column(String(2048), nullable=False)

    # Type: "slack", "discord", "generic" — controls payload format
    webhook_type: Mapped[str] = mapped_column(String(32), default="generic", nullable=False)

    # Comma-separated event filters: "workflow_completed,workflow_error,awaiting_enhancement,workflow_cancelled"
    # Empty/null = all events
    event_filter: Mapped[str | None] = mapped_column(String(500), nullable=True)

    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # Optional: HMAC secret for signature header (HMAC-SHA256)
    secret: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # Stats
    last_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_status: Mapped[int | None] = mapped_column(Integer, nullable=True)  # HTTP status code
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    total_sent: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_failed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # Multi-tenancy: owner of this webhook (nullable for backwards-compat).
    user_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )


class WorkflowCheckpoint(Base):
    """Snapshot of workflow state at iteration boundaries. Used for crash recovery."""

    __tablename__ = "workflow_checkpoints"
    __table_args__ = (
        # One checkpoint per (session, iteration, phase)
        UniqueConstraint("session_id", "iteration", "phase", name="uq_checkpoint"),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    session_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    iteration: Mapped[int] = mapped_column(Integer, nullable=False)
    phase: Mapped[str] = mapped_column(String(50), nullable=False)  # "coding", "testing", "summarizing", etc.

    # Snapshot of WorkflowState as JSON (everything that's not in normal DB tables)
    state_json: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)

    # Metrics at this point
    total_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    total_cost_usd: Mapped[float] = mapped_column(
        Numeric(precision=12, scale=6), default=0, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


# ============================================================================
# Visual Review Models (Wave 1)
# ============================================================================


class CodeVersionScreenshot(Base):
    """A still frame captured from a visual code version during sandbox playback.

    Captured by the sandbox screenshot service when a session enters the
    AWAITING_VISUAL_REVIEW phase. Stored under
    ``STORAGE_ROOT/screenshots/<session_id>/<code_version_id>/frame_<n>.png``.
    """

    __tablename__ = "code_version_screenshots"
    __table_args__ = (
        UniqueConstraint(
            "code_version_id", "frame_index", name="uq_code_version_screenshot_frame"
        ),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    code_version_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("code_versions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    frame_index: Mapped[int] = mapped_column(Integer, nullable=False)
    t_seconds: Mapped[float] = mapped_column(Float, nullable=False)
    image_path: Mapped[str] = mapped_column(String(500), nullable=False)
    width: Mapped[int] = mapped_column(Integer, nullable=False)
    height: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # Relationships
    code_version: Mapped["CodeVersion"] = relationship(back_populates="screenshots")


class VisualReviewScore(Base):
    """User-submitted (or vision-LLM-generated) score for a code version's visual output.

    Scored 0-10. Source is ``'user'`` for human input or ``'vision_llm'`` for
    automated visual model evaluation. ``submitted_by`` is the user that
    submitted a 'user' score (nullable for vision_llm/system).
    """

    __tablename__ = "visual_review_scores"
    __table_args__ = (
        CheckConstraint("score >= 0 AND score <= 10", name="ck_visual_review_score_range"),
        CheckConstraint(
            "source IN ('user', 'vision_llm')",
            name="ck_visual_review_score_source",
        ),
        UniqueConstraint(
            "session_id", "code_version_id", "source",
            name="uq_visual_review_score",
        ),
    )

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=lambda: str(uuid4())
    )
    session_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("sessions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    code_version_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("code_versions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # КАО#VR-27 — half-step scores (0.5, 1.0, 1.5, ...) per frontend slider
    # step=0.5. Numeric(3,1) fits 0.0..10.0 exactly. Old rows (integers) load
    # as floats with .0 suffix — backward compatible.
    score: Mapped[float] = mapped_column(Numeric(3, 1), nullable=False)
    submitted_by: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False),
        ForeignKey("users.id", ondelete="SET NULL"),
        nullable=True,
    )
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="user")
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # Relationships
    session: Mapped["Session"] = relationship(back_populates="visual_review_scores")
    code_version: Mapped["CodeVersion"] = relationship(back_populates="visual_review_scores")


class OTPCode(Base):
    """One-time password sent via email for login verification."""

    __tablename__ = "otp_codes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, index=True)
    code_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used: Mapped[bool] = mapped_column(Boolean, default=False)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
