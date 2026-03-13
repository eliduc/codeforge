// Types for CodeForge Frontend v1.1.0

// Generic paginated response
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  skip: number;
  limit: number;
}

// Enums
export type SessionStatus = 
  | 'created' 
  | 'running' 
  | 'paused' 
  | 'completed' 
  | 'failed' 
  | 'cancelled'
  | 'awaiting_enhancement'
  | 'enhancing'
  | 'awaiting_enhancement_review';

export type AgentType = 'coder' | 'tester' | 'summarizer' | 'finalizer';

export type AgentStatus = 'idle' | 'working' | 'done' | 'error' | 'waiting' | 'executing' | 'fixing';

export type IssueSeverity = 'critical' | 'serious' | 'minor' | 'suggestion';

export type InterventionType = 
  | 'comment' 
  | 'spec_change' 
  | 'force_accept' 
  | 'force_complete' 
  | 'pause' 
  | 'resume';

export type LLMProvider = 'openai' | 'anthropic' | 'google' | 'grok' | 'ollama';

// Data Types
export interface Issue {
  id: string;
  severity: IssueSeverity;
  category: string;
  description: string;
  location?: string;
  suggestion?: string;
  evidence?: string;
}

export interface AgentConfig {
  id: number;
  session_id: string;
  agent_type: AgentType;
  agent_index: number;
  llm_provider: LLMProvider;
  llm_model: string;
  prompt_template_id?: string;
  custom_prompt?: string | null;
  thinking_effort?: string | null;
  enabled: boolean;
  created_at: string;
}

// Attachment Types
export interface AttachmentFile {
  path: string;
  content: string;
  size: number;
}

export interface AttachmentInfo {
  type: 'file' | 'archive' | 'repo_url' | 'repo';
  filename?: string;
  content?: string;
  size?: number;
  url?: string;
  label?: string;
  branch?: string;
  commit?: string;
  repo_name?: string;
  file_count?: number;
  files?: AttachmentFile[];
}

export interface FileUploadResponse {
  attachments: AttachmentInfo[];
  errors: string[];
}

export interface FetchRepoRequest {
  url: string;
  branch?: string;
  token?: string;
}

export interface FetchRepoResponse {
  attachment: AttachmentInfo;
  errors: string[];
}

export interface CreatePRRequest {
  session_id: string;
  token: string;
  branch_name?: string;
  pr_title?: string;
  pr_body?: string;
}

export interface CreatePRResponse {
  pr_url: string;
  pr_number: number;
  branch: string;
  base_branch: string;
  status: string;
}

export interface FileStructureEntry {
  content?: string;
  action: 'modified' | 'created' | 'deleted';
}

export interface Session {
  id: string;
  name: string;
  specification: string;
  initial_code?: string;
  initial_docs?: string;
  attachments?: AttachmentInfo[];
  language: string;
  max_iterations: number;
  current_iteration: number;
  status: SessionStatus;
  // Code execution settings
  enable_code_execution: boolean;
  execution_timeout: number;
  max_fix_attempts: number;
  auto_install_deps: boolean;
  auto_continue: boolean;
  parent_session_id?: string;
  enhancement_round: number;
  created_at: string;
  updated_at: string;
  agent_configs: AgentConfig[];
}

export interface SessionListItem {
  id: string;
  name: string;
  status: SessionStatus;
  current_iteration: number;
  max_iterations: number;
  language: string;
  parent_session_id?: string;
  enhancement_round: number;
  created_at: string;
  updated_at: string;
}

export interface CodeVersion {
  id: string;
  session_id: string;
  coder_index: number;
  iteration: number;
  code_content: string;
  file_structure?: Record<string, string>;
  analysis?: string;
  status: AgentStatus;
  created_at: string;
}

export interface Audit {
  id: string;
  session_id: string;
  code_version_id: string;
  tester_index: number;
  iteration: number;
  audit_content: string;
  issues: Issue[];
  overall_assessment?: string;
  specification_compliance?: string;
  positive_aspects: string[];
  created_at: string;
}

export interface SummaryAudit {
  id: string;
  session_id: string;
  coder_index: number;
  iteration: number;
  summary_content: string;
  critical_issues: Issue[];
  serious_issues: Issue[];
  minor_issues: Issue[];
  suggestions: Issue[];
  consensus_notes?: string;
  created_at: string;
}

export interface FinalResult {
  id: string;
  session_id: string;
  selected_coder_index: number;
  final_code: string;
  file_structure?: Record<string, string>;
  readme_content?: string;
  api_docs?: string;
  report_pdf_path?: string;
  selection_reasoning?: string;
  total_iterations?: number;
  total_tokens?: number;
  total_cost_usd?: number;
  verification_passed?: boolean | null;
  verification_exit_code?: number | null;
  verification_stdout?: string | null;
  verification_stderr?: string | null;
  created_at: string;
}

export interface SessionMetrics {
  session_id: string;
  total_tokens_input: number;
  total_tokens_output: number;
  total_tokens: number;
  total_cost_usd: number;
  total_requests: number;
  total_time_ms: number;
  iterations_completed: number;
  by_agent: Record<string, AgentMetrics>;
  by_provider: Record<string, ProviderMetrics>;
}

export interface AgentMetrics {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
}

export interface ProviderMetrics {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface Intervention {
  id: string;
  session_id: string;
  iteration: number;
  intervention_type: string;
  target_agent_type?: AgentType;
  target_agent_index?: number;
  content?: string;
  created_at: string;
}

export interface PromptTemplate {
  id: string;
  name: string;
  agent_type: AgentType;
  template_text: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

// WebSocket Events
export interface WSMessage {
  type: string;
  data?: Record<string, unknown>;
}

export interface WSAgentStatusUpdate {
  agent_type: AgentType;
  agent_index?: number;
  status: AgentStatus;
  iteration: number;
  tokens_used?: number;
  cost_usd?: number;
}

// React Flow Node Types
export interface AgentNodeData {
  label: string;
  agentType: AgentType;
  agentIndex: number;
  llmProvider: LLMProvider;
  llmModel: string;
  status: AgentStatus;
  iteration: number;
  tokensUsed: number;
  costUsd: number;
  lastUpdated?: string;
  content?: string;
}

// API Request/Response Types
export interface CreateSessionRequest {
  name: string;
  specification: string;
  initial_code?: string;
  initial_docs?: string;
  attachments?: AttachmentInfo[];
  language?: string;
  max_iterations?: number;
  auto_continue?: boolean;
  // Code execution settings
  enable_code_execution?: boolean;
  execution_timeout?: number;
  max_fix_attempts?: number;
  auto_install_deps?: boolean;
  agent_timeout?: number;
  // Agent configs
  agent_configs?: Partial<AgentConfig>[];
  // Simplified config options
  num_coders?: number;
  num_testers?: number;
  coder_configs?: { provider: string; model: string }[];
  tester_configs?: { provider: string; model: string }[];
  summarizer_config?: { provider: string; model: string };
  finalizer_config?: { provider: string; model: string };
}

export interface CreateInterventionRequest {
  intervention_type: string;
  target_agent_type?: AgentType;
  target_agent_index?: number;
  content?: string;
}

export interface LLMProviderSettings {
  provider: LLMProvider;
  api_key_set: boolean;
  available_models: string[];
  rate_limit: number;
}

// Per-model capabilities
export interface ModelCapabilities {
  thinking_effort_options: string[];  // e.g. ["low","medium","high","max"]
  max_output_tokens?: number;         // max allowed output tokens for this model
}

// ProviderInfo for API responses
export interface ProviderInfo {
  name: string;
  available: boolean;
  configured: boolean;
  models: string[];
  model_capabilities?: Record<string, ModelCapabilities>;
  rate_limit: number;
}

export interface AppSettings {
  llm_providers: LLMProviderSettings[];
  default_max_iterations: number;
  default_timeout_sec: number;
  sandbox_available: boolean;
}

// Code Execution Types
export interface ExecutionResult {
  success: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  execution_time_ms: number;
  memory_used_mb?: number;
  timeout_exceeded: boolean;
  error?: string;
  installed_deps?: string[];
  warning?: string;
}

// Extended Agent Node Data for execution status
export interface AgentNodeDataExtended extends AgentNodeData {
  executionStatus?: 'idle' | 'executing' | 'fixing' | 'completed' | 'failed';
  fixAttempt?: number;
  maxFixAttempts?: number;
  executionResult?: ExecutionResult;
}

// Enhancement Types
export type EnhancerAgentType = 'enhancer_design' | 'enhancer_func' | 'enhancer_security';

export interface EnhancerAgentConfig {
  type: EnhancerAgentType;
  enabled: boolean;
  provider: string;
  model: string;
  recommendations?: string;
}

export interface EnhancerSummarizerConfig {
  provider: string;
  model: string;
}

export interface EnhanceRequest {
  enhancers: EnhancerAgentConfig[];
  summarizer: EnhancerSummarizerConfig;
}

export interface EnhanceResponse {
  enhancement_session_id: string;
  parent_session_id: string;
  enhancement_round: number;
  suggestions_count: number;
  message: string;
}

export interface EnhancementSuggestion {
  id: string;
  session_id: string;
  agent_type: string;
  content: string;
  user_recommendations?: string;
  llm_provider: string;
  llm_model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  created_at: string;
}

export interface CuratedSuggestion {
  title: string;
  category: string;
  subcategory?: string;
  priority: string;
  description: string;
  implementation?: string;
}

export interface ApplyEnhancementsResponse {
  new_session_id: string;
  parent_session_id: string;
  enhancement_round: number;
  suggestions_applied: number;
  message: string;
}

// Copy / Export / Import Types

export interface ImportDuplicateInfo {
  name: string;
  specification_preview: string;
  existing_session_id: string;
}

export interface ImportNewInfo {
  name: string;
  specification_preview: string;
}

export interface ImportCheckResponse {
  duplicates: ImportDuplicateInfo[];
  new_sessions: ImportNewInfo[];
  total: number;
  has_duplicates: boolean;
}

export interface ImportResponse {
  imported_count: number;
  session_ids: string[];
  message: string;
}
