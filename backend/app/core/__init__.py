"""Pydantic schemas for API requests and responses."""

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.db.models import AgentType, CodeVersionStatus, IssueSeverity, SessionStatus


# ============================================================================
# Enums
# ============================================================================


class LLMProvider(str, Enum):
    """Supported LLM providers."""

    OPENAI = "openai"
    ANTHROPIC = "anthropic"
    GOOGLE = "google"
    GROK = "grok"
    OLLAMA = "ollama"


# ============================================================================
# Base Schemas
# ============================================================================


class BaseSchema(BaseModel):
    """Base schema with common configuration."""

    model_config = ConfigDict(from_attributes=True)


# ============================================================================
# Agent Config Schemas
# ============================================================================


class AgentConfigCreate(BaseModel):
    """Schema for creating an agent configuration."""

    agent_type: AgentType
    agent_index: int = 0
    llm_provider: str
    llm_model: str
    prompt_template_id: int | None = None
    custom_prompt: str | None = None
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(default=16384, ge=1, le=128000)
    thinking_effort: str | None = None


class AgentConfigUpdate(BaseModel):
    """Schema for updating an agent configuration."""

    llm_provider: str | None = None
    llm_model: str | None = None
    prompt_template_id: int | None = None
    custom_prompt: str | None = None
    temperature: float | None = None
    max_tokens: int | None = None
    thinking_effort: str | None = None


class AgentConfigResponse(BaseSchema):
    """Schema for agent configuration response."""

    id: int
    session_id: str
    agent_type: AgentType
    agent_index: int
    llm_provider: str
    llm_model: str
    prompt_template_id: int | None
    custom_prompt: str | None
    temperature: float
    max_tokens: int
    thinking_effort: str | None = None


# ============================================================================
# Session Schemas
# ============================================================================


class SessionCreate(BaseModel):
    """Schema for creating a new session."""

    name: str = Field(min_length=1, max_length=255)
    specification: str = Field(min_length=1)
    initial_code: str | None = None
    initial_docs: str | None = None
    language: str = "python"
    max_iterations: int = Field(default=5, ge=1, le=20)
    execution_timeout_sec: int = Field(default=60, ge=10, le=600)
    auto_continue: bool = True
    settings: dict[str, Any] = Field(default_factory=dict)
    agent_configs: list[AgentConfigCreate] = Field(default_factory=list)


class SessionUpdate(BaseModel):
    """Schema for updating a session."""

    name: str | None = None
    specification: str | None = None
    initial_code: str | None = None
    initial_docs: str | None = None
    language: str | None = None
    max_iterations: int | None = None
    enable_code_execution: bool | None = None
    execution_timeout: int | None = None
    max_fix_attempts: int | None = None
    auto_install_deps: bool | None = None
    auto_continue: bool | None = None
    agent_timeout: int | None = None
    settings: dict[str, Any] | None = None


class SessionResponse(BaseSchema):
    """Schema for session response."""

    id: str
    name: str
    specification: str
    initial_code: str | None
    initial_docs: str | None
    language: str
    max_iterations: int
    current_iteration: int
    status: SessionStatus
    settings: dict[str, Any]
    created_at: datetime
    updated_at: datetime
    agent_configs: list[AgentConfigResponse] = []


class SessionListResponse(BaseSchema):
    """Schema for session list item."""

    id: str
    name: str
    language: str
    status: SessionStatus
    current_iteration: int
    max_iterations: int
    created_at: datetime
    updated_at: datetime


# ============================================================================
# Prompt Template Schemas
# ============================================================================


class PromptTemplateCreate(BaseModel):
    """Schema for creating a prompt template."""

    name: str = Field(min_length=1, max_length=255)
    agent_type: AgentType
    template_text: str = Field(min_length=10)
    is_default: bool = False
    description: str | None = None


class PromptTemplateUpdate(BaseModel):
    """Schema for updating a prompt template."""

    name: str | None = None
    template_text: str | None = None
    is_default: bool | None = None
    description: str | None = None


class PromptTemplateResponse(BaseSchema):
    """Schema for prompt template response."""

    id: int
    name: str
    agent_type: AgentType
    template_text: str
    is_default: bool
    description: str | None
    created_at: datetime
    updated_at: datetime


# ============================================================================
# Code Version Schemas
# ============================================================================


class CodeVersionResponse(BaseSchema):
    """Schema for code version response."""

    id: str
    session_id: str
    coder_index: int
    iteration: int
    code_content: str
    file_structure: dict[str, Any] | None
    analysis: str | None
    status: CodeVersionStatus
    created_at: datetime


class CodeVersionListResponse(BaseSchema):
    """Schema for code version list item."""

    id: str
    coder_index: int
    iteration: int
    status: CodeVersionStatus
    created_at: datetime


# ============================================================================
# Audit Schemas
# ============================================================================


class IssueSchema(BaseModel):
    """Schema for a code issue."""

    id: str
    severity: IssueSeverity
    category: str
    description: str
    location: str | None = None
    suggestion: str | None = None
    evidence: str | None = None
    testers_agreeing: list[int] = []


class AuditResponse(BaseSchema):
    """Schema for audit response."""

    id: str
    session_id: str
    code_version_id: str
    tester_index: int
    iteration: int
    audit_content: str
    overall_assessment: str | None
    issues: list[dict[str, Any]]
    positive_aspects: list[str]
    test_cases_needed: list[dict[str, Any]]
    created_at: datetime


class SummaryAuditResponse(BaseSchema):
    """Schema for summary audit response."""

    id: str
    session_id: str
    coder_index: int
    iteration: int
    summary_content: str
    critical_issues: list[dict[str, Any]]
    serious_issues: list[dict[str, Any]]
    minor_issues: list[dict[str, Any]]
    suggestions: list[dict[str, Any]]
    consensus_notes: str | None
    created_at: datetime


# ============================================================================
# Coder Response Schemas
# ============================================================================


class CoderResponseResponse(BaseSchema):
    """Schema for coder response to audits."""

    id: str
    session_id: str
    coder_index: int
    iteration: int
    accepted_issues: list[dict[str, Any]]
    partial_issues: list[dict[str, Any]]
    rejected_issues: list[dict[str, Any]]
    rejection_reasons: dict[str, str]
    created_at: datetime


# ============================================================================
# Code Execution Schemas
# ============================================================================


class CodeExecutionRequest(BaseModel):
    """Schema for code execution request."""

    command: str | None = None
    timeout: int = Field(default=60, ge=1, le=300)


class CodeExecutionResponse(BaseSchema):
    """Schema for code execution response."""

    id: str
    code_version_id: str
    executor_type: str
    command: str | None
    exit_code: int | None
    stdout: str | None
    stderr: str | None
    execution_time_ms: int | None
    memory_used_mb: float | None
    created_at: datetime


# ============================================================================
# LLM Request/Metrics Schemas
# ============================================================================


class LLMRequestResponse(BaseSchema):
    """Schema for LLM request record."""

    id: str
    session_id: str
    agent_type: AgentType
    agent_index: int
    iteration: int
    llm_provider: str
    llm_model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int
    success: bool
    error_message: str | None
    created_at: datetime


class SessionMetricsResponse(BaseModel):
    """Schema for session metrics."""

    session_id: str
    total_iterations: int
    total_llm_requests: int
    total_input_tokens: int
    total_output_tokens: int
    total_cost_usd: float
    average_latency_ms: float
    by_provider: dict[str, dict[str, Any]]
    by_agent_type: dict[str, dict[str, Any]]


class SessionMetrics(BaseModel):
    """Schema for detailed session metrics."""

    session_id: UUID
    total_tokens_input: int
    total_tokens_output: int
    total_tokens: int
    total_cost_usd: float
    total_requests: int
    total_time_ms: int
    iterations_completed: int
    by_agent: dict[str, dict[str, Any]]
    by_provider: dict[str, dict[str, Any]]


# ============================================================================
# Intervention Schemas
# ============================================================================


class InterventionCreate(BaseModel):
    """Schema for creating an intervention."""

    intervention_type: str = Field(min_length=1, max_length=50)
    target_agent_type: AgentType | None = None
    target_agent_index: int | None = None
    content: str = Field(min_length=1)


class InterventionResponse(BaseSchema):
    """Schema for intervention response."""

    id: str
    session_id: str
    iteration: int
    intervention_type: str
    target_agent_type: AgentType | None
    target_agent_index: int | None
    content: str
    applied: bool
    created_at: datetime


# ============================================================================
# Final Result Schemas
# ============================================================================


class FinalResultResponse(BaseSchema):
    """Schema for final result response."""

    id: str
    session_id: str
    selected_coder_index: int
    final_code: str
    file_structure: dict[str, Any] | None
    readme_content: str
    api_docs: str | None
    report_pdf_path: str | None
    selection_reasoning: str
    total_iterations: int
    total_tokens: int
    total_cost_usd: float
    known_limitations: list[str]
    verification_passed: bool | None = None
    verification_exit_code: int | None = None
    verification_stdout: str | None = None
    verification_stderr: str | None = None
    created_at: datetime


# ============================================================================
# Settings Schemas
# ============================================================================


class AppSettingResponse(BaseModel):
    """Schema for app setting response."""

    key: str
    value: dict[str, Any]
    description: str | None
    updated_at: datetime


class AppSettingUpdate(BaseModel):
    """Schema for updating an app setting."""

    value: dict[str, Any]
    description: str | None = None


class LLMProviderInfo(BaseModel):
    """Schema for LLM provider information."""

    name: str
    available: bool
    models: list[str]
    rate_limit: int


class LLMProvidersResponse(BaseModel):
    """Schema for LLM providers list."""

    providers: list[LLMProviderInfo]


class TestLLMRequest(BaseModel):
    """Schema for testing LLM connection."""

    provider: str
    model: str
    prompt: str = "Say 'Hello, CodeForge!' in one sentence."


class TestLLMResponse(BaseModel):
    """Schema for LLM test response."""

    success: bool
    response: str | None = None
    error: str | None = None
    message: str | None = None
    latency_ms: int | None = None


class LLMProviderSettings(BaseModel):
    """Schema for LLM provider settings."""

    provider: LLMProvider
    api_key_set: bool
    available_models: list[str]
    rate_limit: int


class AppSettingsResponse(BaseModel):
    """Schema for application settings response."""

    llm_providers: list[LLMProviderSettings]
    default_max_iterations: int
    default_timeout_sec: int
    sandbox_available: bool


# ============================================================================
# WebSocket Message Schemas
# ============================================================================


class WSMessage(BaseModel):
    """Base WebSocket message."""

    type: str
    data: dict[str, Any] = {}


class WSSubscribe(BaseModel):
    """WebSocket subscribe message."""

    type: str = "subscribe"
    session_id: str


class WSUnsubscribe(BaseModel):
    """WebSocket unsubscribe message."""

    type: str = "unsubscribe"
    session_id: str


class WSIntervention(BaseModel):
    """WebSocket intervention message."""

    type: str = "intervention"
    session_id: str
    intervention_type: str
    target_agent_type: AgentType | None = None
    target_agent_index: int | None = None
    content: str


# ============================================================================
# Graph/Visualization Schemas
# ============================================================================


class GraphNodeData(BaseModel):
    """Data for a graph node."""

    id: str
    type: str  # input, coder, tester, summarizer, finalizer, output
    label: str
    agent_type: AgentType | None = None
    agent_index: int | None = None
    llm_provider: str | None = None
    llm_model: str | None = None
    status: str = "idle"  # idle, working, done, error, waiting
    current_iteration: int | None = None
    tokens_used: int = 0
    cost_usd: float = 0.0
    last_updated: datetime | None = None


class GraphEdge(BaseModel):
    """A graph edge."""

    id: str
    source: str
    target: str
    animated: bool = False


class GraphState(BaseModel):
    """Complete graph state for visualization."""

    nodes: list[GraphNodeData]
    edges: list[GraphEdge]
    current_iteration: int
    session_status: SessionStatus
