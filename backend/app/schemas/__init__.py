"""Pydantic schemas for API requests and responses. v1.1.0"""

import logging
from datetime import datetime
from enum import Enum
from typing import Any, ClassVar, Generic, TypeVar
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.db.models import AgentType, CodeVersionStatus, IssueSeverity, SessionStatus

_schemas_logger = logging.getLogger(__name__)


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


T = TypeVar("T")


class PaginatedResponse(BaseModel, Generic[T]):
    """Generic paginated response wrapper."""

    items: list[T]
    total: int
    skip: int
    limit: int


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
    custom_prompt: str | None = Field(default=None, max_length=50000)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(default=4096, ge=1, le=200000)
    thinking_effort: str | None = None
    enabled: bool = True

    @field_validator("llm_provider")
    @classmethod
    def validate_provider(cls, v: str) -> str:
        valid = {"openai", "anthropic", "google", "grok", "ollama"}
        if v.lower() not in valid:
            raise ValueError(f"Unknown LLM provider: {v}. Must be one of: {valid}")
        return v.lower()


class AgentConfigUpdate(BaseModel):
    """Schema for updating an agent configuration."""

    llm_provider: str | None = None
    llm_model: str | None = None
    prompt_template_id: int | None = None
    custom_prompt: str | None = Field(default=None, max_length=50000)
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=200000)
    thinking_effort: str | None = None
    enabled: bool | None = None


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
    enabled: bool = True


# ============================================================================
# Attachment Schemas
# ============================================================================


class AttachmentFile(BaseModel):
    """A single file within an attachment."""

    path: str
    content: str
    size: int = 0


class AttachmentInfo(BaseModel):
    """Schema for a session attachment (file, archive, or repo)."""

    type: str = Field(description="file | archive | repo_url | repo")
    filename: str | None = None
    content: str | None = None
    size: int = 0
    url: str | None = None
    label: str | None = None
    branch: str | None = None
    commit: str | None = None
    repo_name: str | None = None
    file_count: int = 0
    files: list[AttachmentFile] = Field(default_factory=list)


class FileUploadResponse(BaseModel):
    """Response from file upload endpoint."""

    attachments: list[AttachmentInfo]
    errors: list[str] = Field(default_factory=list)


class FetchRepoRequest(BaseModel):
    """Request to fetch a git repository."""

    url: str = Field(min_length=5)
    branch: str | None = None
    token: str | None = None

    @field_validator("url")
    @classmethod
    def validate_url_scheme(cls, v: str) -> str:
        if not v.startswith(("http://", "https://", "git@")):
            raise ValueError("URL must start with http://, https://, or git@")
        return v


class FetchRepoResponse(BaseModel):
    """Response from repo fetch endpoint."""

    attachment: AttachmentInfo
    errors: list[str] = Field(default_factory=list)


class CreatePRRequest(BaseModel):
    """Request to create a Pull Request with session results."""

    session_id: str
    token: str = Field(description="GitHub personal access token")
    branch_name: str = Field(default="codeforge/improvements")
    pr_title: str = Field(default="CodeForge: Code Improvements")
    pr_body: str = Field(default="")


class CreatePRResponse(BaseModel):
    """Response from PR creation endpoint."""

    pr_url: str
    pr_number: int
    branch: str
    base_branch: str
    status: str


# ============================================================================
# Session Settings Schema
# ============================================================================


class SessionSettings(BaseModel):
    """Typed settings for a session. Replaces bare dict to prevent arbitrary data."""

    model_config = ConfigDict(extra="forbid")

    # Add known setting fields here as the application evolves.
    # Using Optional fields so the model works with empty dicts from existing data.
    theme: str | None = None
    notes: str | None = None
    custom_flags: list[str] = Field(default_factory=list, max_length=50)


# ============================================================================
# Session Schemas
# ============================================================================


class SessionCreate(BaseModel):
    """Schema for creating a new session."""

    name: str = Field(min_length=1, max_length=255)
    specification: str = Field(min_length=1, max_length=100000)
    initial_code: str | None = Field(default=None, max_length=500000)
    initial_docs: str | None = Field(default=None, max_length=100000)
    attachments: list[AttachmentInfo] = Field(default_factory=list)
    language: str = "python"

    _KNOWN_LANGUAGES: ClassVar[set[str]] = {"python", "javascript", "typescript", "java", "go", "rust", "c", "cpp", "csharp", "ruby", "php", "swift", "kotlin", "html", "css", "sql", "bash", "shell", "r", "scala", "dart", "lua", "zig", "nim", "elixir", "haskell"}

    @field_validator("language")
    @classmethod
    def normalize_language(cls, v: str) -> str:
        normalized = v.strip().lower()
        if normalized not in cls._KNOWN_LANGUAGES:
            _schemas_logger.warning(f"Unknown language '{normalized}' — not in known set. Allowing anyway.")
        return normalized
    max_iterations: int = Field(default=5, ge=1, le=50)
    auto_continue: bool = True

    # Code execution settings
    enable_code_execution: bool = Field(default=True, description="Enable code execution for validation")
    execution_timeout: int = Field(default=60, ge=10, le=300, description="Execution timeout in seconds")
    max_fix_attempts: int = Field(default=3, ge=1, le=10, description="Max attempts to fix failing code per iteration")
    auto_install_deps: bool = Field(default=True, description="Auto-install missing dependencies")
    agent_timeout: int = Field(default=300, ge=60, le=1800, description="LLM API call timeout per agent in seconds")

    settings: SessionSettings = Field(default_factory=SessionSettings)
    agent_configs: list[AgentConfigCreate] = Field(default_factory=list)


class SessionUpdate(BaseModel):
    """Schema for updating a session."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    specification: str | None = Field(default=None, max_length=100000)
    initial_code: str | None = Field(default=None, max_length=500000)
    initial_docs: str | None = Field(default=None, max_length=100000)
    attachments: list[AttachmentInfo] | None = None
    language: str | None = None
    max_iterations: int | None = Field(default=None, ge=1, le=50)
    enable_code_execution: bool | None = None
    execution_timeout: int | None = Field(default=None, ge=10, le=300)
    max_fix_attempts: int | None = Field(default=None, ge=1, le=10)
    auto_install_deps: bool | None = None
    auto_continue: bool | None = None
    agent_timeout: int | None = Field(default=None, ge=60, le=1800)
    settings: SessionSettings | None = None


class SessionResponse(BaseSchema):
    """Schema for session response."""

    id: str
    name: str
    specification: str
    initial_code: str | None
    initial_docs: str | None
    attachments: list[AttachmentInfo] = []
    language: str
    max_iterations: int
    current_iteration: int
    auto_continue: bool = True

    # Code execution settings (from settings JSON or defaults)
    enable_code_execution: bool = True
    execution_timeout: int = 60
    max_fix_attempts: int = 3
    auto_install_deps: bool = True
    agent_timeout: int = 300

    status: SessionStatus
    settings: dict[str, Any]

    # Enhancement chain
    parent_session_id: str | None = None
    enhancement_round: int = 0

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
    parent_session_id: str | None = None
    enhancement_round: int = 0
    created_at: datetime
    updated_at: datetime


# ============================================================================
# Prompt Template Schemas
# ============================================================================


class PromptTemplateCreate(BaseModel):
    """Schema for creating a prompt template."""

    name: str = Field(min_length=1, max_length=255)
    agent_type: AgentType
    template_text: str = Field(min_length=10, max_length=100000)
    is_default: bool = False
    description: str | None = None


class PromptTemplateUpdate(BaseModel):
    """Schema for updating a prompt template."""

    name: str | None = Field(default=None, min_length=1, max_length=200)
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
    content: str = Field(min_length=1, max_length=50000)


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
# Enhancement Schemas
# ============================================================================


class EnhancerAgentConfig(BaseModel):
    """Configuration for a single enhancer agent."""

    type: str = Field(
        pattern=r'^enhancer_(design|func|security)$',
        description="enhancer_design | enhancer_func | enhancer_security",
    )
    enabled: bool = True
    provider: str
    model: str
    recommendations: str | None = Field(default=None, description="User recommendations for this enhancer")


class EnhancerSummarizerConfig(BaseModel):
    """Configuration for the enhancement summarizer."""

    provider: str
    model: str


class EnhanceRequest(BaseModel):
    """Request to start enhancement process on a completed session."""

    enhancers: list[EnhancerAgentConfig] = Field(min_length=1)
    summarizer: EnhancerSummarizerConfig


class EnhancementSuggestionResponse(BaseSchema):
    """Response for an enhancement suggestion."""

    id: str
    session_id: str
    agent_type: str
    content: str
    user_recommendations: str | None
    llm_provider: str
    llm_model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float
    latency_ms: int
    created_at: datetime


class EnhanceResponse(BaseModel):
    """Response from enhancement process."""

    enhancement_session_id: str
    parent_session_id: str
    enhancement_round: int
    suggestions_count: int
    message: str


class CuratedSuggestion(BaseModel):
    """A single curated enhancement suggestion selected/edited by the user."""

    title: str
    category: str  # security, functionality, design
    priority: str = "medium"  # critical, high, medium, low
    description: str
    implementation: str | None = None


class ApplyEnhancementsRequest(BaseModel):
    """Request to apply curated enhancement suggestions and create a new session."""

    curated_suggestions: list[CuratedSuggestion] = Field(min_length=1)


class ApplyEnhancementsResponse(BaseModel):
    """Response from applying enhancements."""

    new_session_id: str
    parent_session_id: str
    enhancement_round: int
    suggestions_applied: int
    message: str


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


# ============================================================================
# Copy / Export / Import Schemas
# ============================================================================


class SessionExportData(BaseModel):
    """Full session data for export, including all child records."""

    session: dict[str, Any]
    agent_configs: list[dict[str, Any]]
    code_versions: list[dict[str, Any]]
    audits: list[dict[str, Any]]
    summary_audits: list[dict[str, Any]]
    coder_responses: list[dict[str, Any]]
    llm_requests: list[dict[str, Any]]
    interventions: list[dict[str, Any]]
    final_result: dict[str, Any] | None
    enhancement_suggestions: list[dict[str, Any]]
    code_executions: list[dict[str, Any]]


class ExportFile(BaseModel):
    """Top-level envelope for the exported JSON file."""

    version: str = "1.0"
    exported_at: str
    sessions: list[SessionExportData]


class ImportDuplicateInfo(BaseModel):
    """Info about a duplicate session found during import."""

    name: str
    specification_preview: str
    existing_session_id: str


class ImportNewInfo(BaseModel):
    """Info about a new (non-duplicate) session during import."""

    name: str
    specification_preview: str


class ImportCheckResponse(BaseModel):
    """Response after initial import parse: reports duplicates."""

    duplicates: list[ImportDuplicateInfo]
    new_sessions: list[ImportNewInfo]
    total: int
    has_duplicates: bool


class ImportResponse(BaseModel):
    """Response after import completes."""

    imported_count: int
    session_ids: list[str]
    message: str
