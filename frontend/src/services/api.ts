// API service for CodeForge Frontend v1.1.0

const API_URL = import.meta.env.VITE_API_URL || ''
const WS_URL = import.meta.env.VITE_WS_URL || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`

import type {
  SessionListItem,
  PromptTemplate,
  PromptTemplateVersion,
  CreateSessionRequest,
  CreateInterventionRequest,
  ProviderInfo,
  AttachmentInfo,
  FileUploadResponse,
  FetchRepoRequest,
  FetchRepoResponse,
  CreatePRRequest,
  CreatePRResponse,
  EnhanceRequest,
  EnhanceResponse,
  EnhancementSuggestion,
  CuratedSuggestion,
  ApplyEnhancementsResponse,
  ImportCheckResponse,
  ImportResponse,
  ExecutionResult,
  PaginatedResponse,
  // КАО#VR-Wave1 Frontend — Visual Review API DTOs.
  VisualReviewCandidate,
} from '../types'

// Response types
export interface SessionResponse {
  id: string
  name: string
  specification: string
  initial_code?: string
  initial_docs?: string
  attachments?: AttachmentInfo[]
  language: string
  max_iterations: number
  current_iteration: number
  status: string
  execution_timeout: number
  enable_code_execution: boolean
  max_fix_attempts: number
  auto_install_deps: boolean
  auto_continue: boolean
  agent_timeout: number
  request_timeout: number
  parent_session_id?: string
  enhancement_round: number
  created_at: string
  updated_at: string
  agent_configs: AgentConfigResponse[]
  // Free-form per-session settings (e.g. { streaming: true })
  settings?: Record<string, unknown> | null
}

export interface AgentConfigResponse {
  id: string
  session_id: string
  agent_type: string
  agent_index: number
  llm_provider: string
  llm_model: string
  prompt_template_id?: string
  custom_prompt?: string | null
  thinking_effort?: string | null
  max_tokens?: number
  temperature?: number
  enabled: boolean
  created_at: string
}

export interface FinalResultResponse {
  id: string
  session_id: string
  selected_coder_index: number
  final_code: string
  file_structure?: Record<string, { content?: string; action: string }>
  readme_content?: string
  api_docs?: string
  report_pdf_path?: string
  selection_reasoning?: string
  total_iterations?: number
  total_tokens?: number
  total_cost_usd?: number
  verification_passed?: boolean | null
  verification_exit_code?: number | null
  verification_stdout?: string | null
  verification_stderr?: string | null
  created_at: string
}

export interface CodeVersionResponse {
  id: string
  session_id: string
  coder_index: number
  iteration: number
  code_content: string
  analysis?: string
  status: string
  created_at: string
}

export interface AuditResponse {
  id: string
  session_id: string
  code_version_id: string
  tester_index: number
  iteration: number
  audit_content: string
  issues: Array<{
    id: string
    severity: string
    category: string
    description: string
    suggestion?: string
  }>
  overall_score?: number
  specification_compliance?: number
  correctness?: number
  quality?: number
  overall_assessment?: string
  created_at: string
}

export interface SummaryAuditResponse {
  id: string
  session_id: string
  coder_index: number
  iteration: number
  summary_content: string
  critical_issues: Array<{
    id: string
    description: string
    suggestion?: string
  }>
  serious_issues: Array<{
    id: string
    description: string
    suggestion?: string
  }>
  minor_issues: Array<{
    id: string
    description: string
    suggestion?: string
  }>
  suggestions: Array<{
    id: string
    description: string
    suggestion?: string
  }>
  consensus_notes?: string
  created_at: string
}

export interface ProvidersResponse {
  providers: ProviderInfo[]
}

// ---------------------------------------------------------------------------
// Auth session helpers (КАО#SG1-selfxss)
// ---------------------------------------------------------------------------
// The JWT now lives in an httpOnly `codeforge_session` cookie set by the
// backend — JavaScript can NOT read it, so a same-origin XSS (e.g. a preview
// tab opened from generated code) can no longer exfiltrate it. The cookie is
// sent automatically on same-origin requests (REST + the WS handshake).
//
// We keep a single NON-sensitive hint flag in localStorage so the SPA knows
// whether to validate the session on startup (avoids a guaranteed 401 + its
// console noise on the anonymous /login page). The flag is just '1' — reading
// or forging it grants no access; only the httpOnly cookie does.
const AUTHED_HINT_KEY = 'codeforge_authed'
const LEGACY_TOKEN_KEY = 'codeforge_token'

export function setAuthedHint(): void {
  localStorage.setItem(AUTHED_HINT_KEY, '1')
}

export function getAuthedHint(): boolean {
  return localStorage.getItem(AUTHED_HINT_KEY) === '1'
}

export function clearAuthedHint(): void {
  localStorage.removeItem(AUTHED_HINT_KEY)
}

/** One-time migration: purge any legacy JWT left in localStorage by older
 *  builds so it can't be read by same-origin XSS. The cookie replaces it. */
export function clearLegacyToken(): void {
  localStorage.removeItem(LEGACY_TOKEN_KEY)
}

// Default request timeout (30 seconds)
const DEFAULT_TIMEOUT_MS = 30_000

// Raw fetch helper with timeout (returns Response, doesn't parse JSON)
async function apiFetchRaw(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const url = `${API_URL}${endpoint}`
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers: Record<string, string> = options.headers
      ? { ...(options.headers as Record<string, string>) }
      : { 'Content-Type': 'application/json' }

    // КАО#SG1-selfxss — auth now rides the httpOnly `codeforge_session` cookie,
    // sent automatically on same-origin requests. No Authorization header is
    // attached from JS (the token is no longer JS-readable). `credentials:
    // 'same-origin'` is the fetch default but set explicitly for clarity.
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers,
      credentials: 'same-origin',
    })

    // Handle 401 — clear the session hint and redirect to login. The httpOnly
    // cookie is already invalid/expired server-side and gets overwritten on the
    // next successful login. КАО#SG1-selfxss.
    if (response.status === 401 && !endpoint.startsWith('/api/auth/')) {
      clearAuthedHint()
      window.location.href = '/login'
      throw new Error('Session expired. Please log in again.')
    }

    if (!response.ok) {
      // КАО#R4-M21 — on a non-JSON error body keep detail empty so the fallback
      // below surfaces the real HTTP status ("API error: 503") instead of a
      // status-less "Unknown error" (which broke 5xx-vs-auth classification).
      const error = await response.json().catch(() => ({ detail: '' }))
      // КАО#VR-27 — FastAPI ValidationError responses look like
      //   { detail: [ { loc: [...], msg: 'Input should be a valid integer…', type: '…' }, … ] }
      // Naively passing an array to new Error() yields the message
      // "[object Object]" in the toast. Flatten to a human-readable string.
      const detail = (error as { detail?: unknown }).detail
      let msg: string
      if (Array.isArray(detail)) {
        msg = detail
          .map((d) => {
            if (d && typeof d === 'object') {
              const obj = d as { msg?: string; loc?: unknown[]; type?: string }
              const where = Array.isArray(obj.loc) ? obj.loc.join('.') : ''
              const what = obj.msg || obj.type || JSON.stringify(d)
              return where ? `${where}: ${what}` : what
            }
            return String(d)
          })
          .join('; ')
      } else if (typeof detail === 'string' && detail) {
        msg = detail
      } else if (detail) {
        msg = JSON.stringify(detail)
      } else {
        msg = `API error: ${response.status}`
      }
      throw new Error(msg)
    }

    return response
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeoutMs}ms: ${endpoint}`)
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}

// Helper function for API calls with timeout (parses JSON).
// Delegates to apiFetchRaw to avoid duplicating timeout/error logic (#91).
export async function apiFetch<T>(
  endpoint: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const merged: RequestInit = {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  }
  const response = await apiFetchRaw(endpoint, merged, timeoutMs)

  // Handle 204 No Content (e.g., DELETE responses).
  // Callers expecting void should use apiFetch<void>().
  if (response.status === 204) {
    return undefined as unknown as T
  }

  return response.json()
}

// Sessions API
export async function getSessions(skip = 0, limit = 50): Promise<PaginatedResponse<SessionListItem>> {
  return apiFetch<PaginatedResponse<SessionListItem>>(`/api/sessions/?skip=${skip}&limit=${limit}`)
}

export async function getSession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}`)
}

export interface SessionMetrics {
  session_id: string
  total_tokens: number
  total_tokens_input: number
  total_tokens_output: number
  total_cost_usd: number
  total_requests: number
  total_time_ms: number
  iterations_completed: number
}

export async function getSessionMetrics(sessionId: string): Promise<SessionMetrics | null> {
  try {
    return await apiFetch<SessionMetrics>(`/api/code/sessions/${sessionId}/metrics`)
  } catch {
    return null
  }
}

export interface CheckpointResponse {
  id: string
  session_id: string
  iteration: number
  phase: string
  total_tokens: number
  total_cost_usd: number
  created_at: string
}

export async function listCheckpoints(sessionId: string): Promise<CheckpointResponse[]> {
  return apiFetch<CheckpointResponse[]>(`/api/sessions/${sessionId}/checkpoints`)
}

// Dashboard aggregate stats
export interface DashboardStats {
  window_days: number
  sessions_by_status: Record<string, number>
  total_cost_usd: number
  total_tokens: number
  total_requests: number
  avg_iterations: number
  top_providers: Array<{ provider: string; requests: number; cost_usd: number }>
  top_models: Array<{ model: string; requests: number; cost_usd: number }>
  daily_cost: Array<{ date: string; cost_usd: number; requests: number }>
}

export async function getDashboardStats(days = 30): Promise<DashboardStats> {
  return apiFetch<DashboardStats>(`/api/code/dashboard/stats?days=${days}`)
}

export async function uploadFiles(files: File[]): Promise<FileUploadResponse> {
  const formData = new FormData()
  files.forEach(f => formData.append('files', f))

  const response = await apiFetchRaw('/api/sessions/upload-files', {
    method: 'POST',
    headers: {},  // Let browser set Content-Type with boundary for FormData
    body: formData,
  })
  return response.json()
}

export async function fetchRepo(request: FetchRepoRequest): Promise<FetchRepoResponse> {
  return apiFetch<FetchRepoResponse>('/api/sessions/fetch-repo', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

export async function downloadResultZip(sessionId: string): Promise<Blob> {
  const response = await apiFetchRaw(`/api/sessions/${sessionId}/download-zip`)
  return response.blob()
}

export async function createPullRequest(request: CreatePRRequest): Promise<CreatePRResponse> {
  return apiFetch<CreatePRResponse>('/api/sessions/create-pr', {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

// ── Git integration ──

export interface GitCommit {
  sha: string
  author_name: string
  author_email: string
  timestamp: number
  message: string
}

export interface GitDiffEntry {
  path: string
  action: 'added' | 'deleted' | 'modified'
  old_lines: number
  new_lines: number
}

export interface GitBranch {
  name: string
  sha: string
}

export interface PRStatus {
  pr_number?: number
  state?: string
  merged?: boolean
  mergeable?: boolean | null
  mergeable_state?: string
  draft?: boolean
  title?: string
  html_url?: string
  head_ref?: string
  base_ref?: string
  comments?: number
  review_comments?: number
  commits?: number
  additions?: number
  deletions?: number
  changed_files?: number
  created_at?: string
  updated_at?: string
  merged_at?: string | null
  closed_at?: string | null
}

export async function listRepoBranches(url: string, token?: string): Promise<{ branches: GitBranch[] }> {
  return apiFetch<{ branches: GitBranch[] }>('/api/sessions/list-branches', {
    method: 'POST',
    body: JSON.stringify({ url, token }),
  })
}

export async function getRepoCommits(
  sessionId: string,
  limit = 20,
): Promise<{ commits: GitCommit[]; branch?: string; url?: string; message?: string }> {
  return apiFetch<{ commits: GitCommit[]; branch?: string; url?: string; message?: string }>(
    `/api/sessions/${sessionId}/git/commits?limit=${limit}`,
  )
}

export async function getRepoDiff(
  sessionId: string,
): Promise<{ diff: GitDiffEntry[]; file_count?: number; message?: string }> {
  return apiFetch<{ diff: GitDiffEntry[]; file_count?: number; message?: string }>(
    `/api/sessions/${sessionId}/git/diff`,
  )
}

export async function getPullRequestStatus(prUrl: string, token?: string): Promise<PRStatus> {
  return apiFetch<PRStatus>('/api/sessions/pr-status', {
    method: 'POST',
    body: JSON.stringify({ pr_url: prUrl, token }),
  })
}

export async function createSession(data: CreateSessionRequest): Promise<SessionResponse> {
  return apiFetch<SessionResponse>('/api/sessions/', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateSession(
  sessionId: string,
  data: Partial<Pick<CreateSessionRequest, 'name' | 'specification' | 'initial_code' | 'initial_docs' | 'language' | 'max_iterations' | 'enable_code_execution' | 'execution_timeout' | 'max_fix_attempts' | 'auto_install_deps' | 'auto_continue' | 'agent_timeout' | 'request_timeout' | 'settings'>>
): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function addAgentConfig(
  sessionId: string,
  data: { agent_type: string; agent_index: number; llm_provider: string; llm_model: string; max_tokens?: number; thinking_effort?: string | null }
): Promise<AgentConfigResponse> {
  return apiFetch<AgentConfigResponse>(`/api/sessions/${sessionId}/agents`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateAgentConfig(
  sessionId: string,
  agentId: string | number,
  data: { llm_provider?: string; llm_model?: string; thinking_effort?: string | null; max_tokens?: number; temperature?: number; custom_prompt?: string | null; enabled?: boolean },
): Promise<AgentConfigResponse> {
  return apiFetch<AgentConfigResponse>(`/api/sessions/${sessionId}/agents/${agentId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteAgentConfig(
  sessionId: string,
  agentId: string | number,
): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}/agents/${agentId}`, {
    method: 'DELETE',
  })
}

export async function deleteSession(sessionId: string): Promise<void> {
  await apiFetch(`/api/sessions/${sessionId}`, {
    method: 'DELETE',
  })
}

export interface BulkDeleteResult {
  deleted_count: number
  failed_ids: string[]
}

/**
 * Delete multiple sessions via the dedicated bulk-delete endpoint.
 * Falls back to parallel single-delete calls if the bulk endpoint is unavailable.
 * Returns the count of successfully deleted sessions and the IDs that failed.
 */
export async function bulkDeleteSessions(sessionIds: string[]): Promise<BulkDeleteResult> {
  if (sessionIds.length === 0) {
    return { deleted_count: 0, failed_ids: [] }
  }
  try {
    return await apiFetch<BulkDeleteResult>('/api/sessions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ session_ids: sessionIds }),
    })
  } catch (err) {
    // Fallback: fan out parallel DELETE calls if bulk endpoint not available (older backend)
    const results = await Promise.allSettled(
      sessionIds.map(id => deleteSession(id).then(() => id)),
    )
    const failed_ids: string[] = []
    let deleted_count = 0
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        deleted_count++
      } else {
        failed_ids.push(sessionIds[idx])
      }
    })
    return { deleted_count, failed_ids }
  }
}

export async function startSession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}/start`, {
    method: 'POST',
  })
}

export async function pauseSession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}/pause`, {
    method: 'POST',
  })
}

export async function resumeSession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}/resume`, {
    method: 'POST',
  })
}

export async function cancelSession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}/cancel`, {
    method: 'POST',
  })
}

export async function resetSession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}/reset`, {
    method: 'POST',
  })
}

// КАО#VR-11 RestartFromScratch — purge all artifacts then re-run from iteration 0.
export async function restartSession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}/restart`, {
    method: 'POST',
  })
}

export async function refinalizeSession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}/re-finalize`, {
    method: 'POST',
  })
}

// Code API
export async function getFinalResult(sessionId: string): Promise<FinalResultResponse | null> {
  return apiFetch<FinalResultResponse | null>(`/api/code/sessions/${sessionId}/result`)
}

export async function getCodeVersions(
  sessionId: string,
  iteration?: number,
  coderIndex?: number
): Promise<CodeVersionResponse[]> {
  let url = `/api/code/sessions/${sessionId}/code`
  const params = new URLSearchParams()
  if (iteration !== undefined) params.append('iteration', String(iteration))
  if (coderIndex !== undefined) params.append('coder_index', String(coderIndex))
  if (params.toString()) url += `?${params.toString()}`
  return apiFetch<CodeVersionResponse[]>(url)
}

export async function getAudits(
  sessionId: string,
  iteration?: number,
  coderIndex?: number,
  testerIndex?: number
): Promise<AuditResponse[]> {
  let url = `/api/code/sessions/${sessionId}/audits`
  const params = new URLSearchParams()
  if (iteration !== undefined) params.append('iteration', String(iteration))
  if (coderIndex !== undefined) params.append('coder_index', String(coderIndex))
  if (testerIndex !== undefined) params.append('tester_index', String(testerIndex))
  if (params.toString()) url += `?${params.toString()}`
  return apiFetch<AuditResponse[]>(url)
}

export async function getSummaries(
  sessionId: string,
  iteration?: number,
  coderIndex?: number
): Promise<SummaryAuditResponse[]> {
  let url = `/api/code/sessions/${sessionId}/summaries`
  const params = new URLSearchParams()
  if (iteration !== undefined) params.append('iteration', String(iteration))
  if (coderIndex !== undefined) params.append('coder_index', String(coderIndex))
  if (params.toString()) url += `?${params.toString()}`
  return apiFetch<SummaryAuditResponse[]>(url)
}

// Re-export canonical ExecutionResult from types
export type { ExecutionResult } from '../types'

export interface BundleResult {
  success: boolean
  html?: string
  error?: string
  bundled_size_bytes: number
  build_time_ms: number
  warnings?: string[]
}

export async function runFinalCode(sessionId: string, timeoutSec: number = 60): Promise<ExecutionResult> {
  // Client-side timeout must exceed the sandbox timeout so we get a proper error
  // rather than a generic "Request timeout" from the AbortController.
  const clientTimeoutMs = (timeoutSec + 10) * 1000
  return apiFetch<ExecutionResult>(`/api/execution/sessions/${sessionId}/run?timeout_sec=${timeoutSec}`, {
    method: 'POST',
  }, clientTimeoutMs)
}

export async function bundleFinalCode(sessionId: string, timeoutSec: number = 60): Promise<BundleResult> {
  const clientTimeoutMs = (timeoutSec + 10) * 1000
  return apiFetch<BundleResult>(`/api/execution/sessions/${sessionId}/bundle?timeout_sec=${timeoutSec}`, {
    method: 'POST',
  }, clientTimeoutMs)
}

export async function runCodeVersion(versionId: string, timeoutSec: number = 60): Promise<ExecutionResult> {
  const clientTimeoutMs = (timeoutSec + 10) * 1000
  return apiFetch<ExecutionResult>(`/api/execution/code-versions/${versionId}/run?timeout_sec=${timeoutSec}`, {
    method: 'POST',
  }, clientTimeoutMs)
}

// Interventions API
export async function createIntervention(
  sessionId: string,
  data: CreateInterventionRequest
): Promise<void> {
  await apiFetch(`/api/code/sessions/${sessionId}/intervene`, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

// Prompts API
export async function getPromptTemplates(): Promise<PromptTemplate[]> {
  return apiFetch<PromptTemplate[]>('/api/prompts')
}

export async function getPromptTemplate(promptId: string): Promise<PromptTemplate> {
  return apiFetch<PromptTemplate>(`/api/prompts/${promptId}`)
}

export async function createPromptTemplate(data: Partial<PromptTemplate>): Promise<PromptTemplate> {
  return apiFetch<PromptTemplate>('/api/prompts', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updatePromptTemplate(
  promptId: string,
  data: Partial<PromptTemplate>
): Promise<PromptTemplate> {
  return apiFetch<PromptTemplate>(`/api/prompts/${promptId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deletePromptTemplate(promptId: string): Promise<void> {
  await apiFetch(`/api/prompts/${promptId}`, {
    method: 'DELETE',
  })
}

export async function listPromptVersions(
  promptId: string | number
): Promise<PromptTemplateVersion[]> {
  return apiFetch<PromptTemplateVersion[]>(`/api/prompts/${promptId}/versions`)
}

export async function rollbackPromptVersion(
  promptId: string | number,
  versionNumber: number
): Promise<PromptTemplate> {
  return apiFetch<PromptTemplate>(
    `/api/prompts/${promptId}/rollback/${versionNumber}`,
    { method: 'POST' }
  )
}

// Settings API
export async function getLLMProviders(): Promise<ProvidersResponse> {
  return apiFetch<ProvidersResponse>('/api/settings/providers')
}

export async function refreshModels(): Promise<{
  success: boolean
  message: string
  providers: Array<{
    provider: string
    success: boolean
    models: string[]
    error?: string
  }>
}> {
  return apiFetch('/api/settings/refresh-models', {
    method: 'POST',
  })
}

export async function testLLMProvider(provider: string): Promise<{ success: boolean; message: string }> {
  return apiFetch<{ success: boolean; message: string }>(`/api/settings/providers/${provider}/test`, {
    method: 'POST',
  })
}

// Enhancement API
export async function enhanceSession(sessionId: string, request: EnhanceRequest): Promise<EnhanceResponse> {
  return apiFetch<EnhanceResponse>(`/api/sessions/${sessionId}/enhance`, {
    method: 'POST',
    body: JSON.stringify(request),
  })
}

export async function getEnhancementSuggestions(sessionId: string): Promise<EnhancementSuggestion[]> {
  return apiFetch<EnhancementSuggestion[]>(`/api/sessions/${sessionId}/enhancement-suggestions`)
}

export async function applyEnhancements(
  sessionId: string,
  curatedSuggestions: CuratedSuggestion[]
): Promise<ApplyEnhancementsResponse> {
  return apiFetch<ApplyEnhancementsResponse>(`/api/sessions/${sessionId}/apply-enhancements`, {
    method: 'POST',
    body: JSON.stringify({ curated_suggestions: curatedSuggestions }),
  })
}

export async function completeSession(sessionId: string): Promise<{ status: string; session_id: string }> {
  return apiFetch<{ status: string; session_id: string }>(`/api/sessions/${sessionId}/complete`, {
    method: 'POST',
  })
}

// ============================================================================
// Copy / Export / Import
// ============================================================================

export async function copySession(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}/copy`, {
    method: 'POST',
  })
}

export async function copySessionStructure(sessionId: string): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/sessions/${sessionId}/copy-structure`, {
    method: 'POST',
  })
}

export async function exportSessions(sessionIds: string[]): Promise<Blob> {
  const response = await apiFetchRaw('/api/sessions/export', {
    method: 'POST',
    body: JSON.stringify({ session_ids: sessionIds }),
  })
  return response.blob()
}

export async function importSessionsCheck(file: File): Promise<ImportCheckResponse> {
  const formData = new FormData()
  formData.append('file', file)
  const response = await apiFetchRaw('/api/sessions/import', {
    method: 'POST',
    headers: {},
    body: formData,
  })
  return response.json()
}

export async function importSessionsConfirm(file: File): Promise<ImportResponse> {
  const formData = new FormData()
  formData.append('file', file)
  const response = await apiFetchRaw('/api/sessions/import?confirm=true', {
    method: 'POST',
    headers: {},
    body: formData,
  })
  return response.json()
}

// WebSocket wrapper that supports transparent reconnection.
// The returned object exposes the same interface as a native WebSocket
// but swaps the underlying connection on reconnect so callers (e.g.
// wsRef.current) keep working without re-assignment.

// Улучшатели#3 P0·M — WS reconnect UI: surface connection lifecycle state to
// consumers so they can render reconnect/disconnect indicators.
export type WSConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

export interface WSConnectionState {
  status: WSConnectionStatus
  /** 1-based attempt counter for the *next* reconnect when status === 'reconnecting'. */
  attempt: number
  /** Maximum reconnection attempts before giving up. */
  maxRetries: number
}

export interface ReconnectingWebSocket {
  /** Attach a handler that receives MessageEvent from the *current* connection. */
  set onmessage(handler: ((ev: MessageEvent) => void) | null)
  get onmessage(): ((ev: MessageEvent) => void) | null
  set onopen(handler: ((ev: Event) => void) | null)
  get onopen(): ((ev: Event) => void) | null
  set onerror(handler: ((ev: Event) => void) | null)
  get onerror(): ((ev: Event) => void) | null
  set onclose(handler: ((ev: CloseEvent) => void) | null)
  get onclose(): ((ev: CloseEvent) => void) | null
  /** Called after a successful reconnection (not on the initial connect). */
  set onreconnect(handler: (() => void) | null)
  get onreconnect(): (() => void) | null
  /** Improver#3 P0·M — WS reconnect UI: fires on any connection-state transition. */
  set onstatechange(handler: ((state: WSConnectionState) => void) | null)
  get onstatechange(): ((state: WSConnectionState) => void) | null
  readonly readyState: number
  /** Current connection lifecycle state (snapshot). */
  readonly connectionState: WSConnectionState
  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void
  close(code?: number, reason?: string): void
}

export function createWebSocket(
  sessionId: string,
  options?: { maxRetries?: number; baseDelayMs?: number },
): ReconnectingWebSocket {
  const { maxRetries = 5, baseDelayMs = 1000 } = options ?? {}
  let retryCount = 0
  let explicitlyClosed = false
  let hasConnectedOnce = false

  // User-supplied handlers — re-wired to each new underlying socket.
  let _onmessage: ((ev: MessageEvent) => void) | null = null
  let _onopen: ((ev: Event) => void) | null = null
  let _onerror: ((ev: Event) => void) | null = null
  let _onclose: ((ev: CloseEvent) => void) | null = null
  let _onreconnect: (() => void) | null = null
  // Улучшатели#3 P0·M — WS reconnect UI: state-change observer.
  let _onstatechange: ((state: WSConnectionState) => void) | null = null

  // Улучшатели#3 P0·M — WS reconnect UI: tracked connection state.
  let _state: WSConnectionState = { status: 'connecting', attempt: 0, maxRetries }

  function setState(next: Partial<WSConnectionState>) {
    _state = { ..._state, ...next }
    try {
      _onstatechange?.(_state)
    } catch (err) {
      console.error('WS onstatechange handler threw:', err)
    }
  }

  let current: WebSocket

  function wireHandlers(ws: WebSocket) {
    ws.onmessage = (ev) => _onmessage?.(ev)
    ws.onopen = (ev) => {
      const isReconnect = hasConnectedOnce
      hasConnectedOnce = true
      retryCount = 0
      // Улучшатели#3 P0·M — WS reconnect UI: announce successful connection.
      setState({ status: 'connected', attempt: 0 })
      _onopen?.(ev)
      // Fire reconnect callback after a successful re-open (not the first connect)
      if (isReconnect) {
        console.log('WebSocket reconnected — triggering state recovery')
        _onreconnect?.()
      }
    }
    ws.onerror = (ev) => _onerror?.(ev)
    ws.onclose = (ev) => {
      if (explicitlyClosed) {
        // Component-initiated close — keep the last state but mark disconnected silently.
        // We deliberately do NOT emit a 'disconnected' UI event here to avoid flashing
        // the pill during unmount/navigation.
        _onclose?.(ev)
        return
      }
      if (ev.code === 4001) {
        // Улучшатели#3 P0·M — WS reconnect UI: auth failure, not recoverable.
        setState({ status: 'disconnected', attempt: retryCount })
        _onclose?.(ev)
        return
      }
      if (retryCount < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, retryCount)
        retryCount++
        // Улучшатели#3 P0·M — WS reconnect UI: surface attempt counter.
        setState({ status: 'reconnecting', attempt: retryCount })
        console.warn(
          `WebSocket closed (code=${ev.code}). Reconnecting in ${delay}ms (attempt ${retryCount}/${maxRetries})...`,
        )
        setTimeout(() => {
          current = new WebSocket(buildWsUrl())
          wireHandlers(current)
        }, delay)
      } else {
        // Улучшатели#3 P0·M — WS reconnect UI: gave up after maxRetries.
        setState({ status: 'disconnected', attempt: retryCount })
        console.error(`WebSocket reconnection failed after ${maxRetries} attempts`)
        _onclose?.(ev)
      }
    }
  }

  function buildWsUrl() {
    // КАО#SG1-selfxss — the httpOnly session cookie is sent automatically on
    // the same-origin WS handshake, so the JWT no longer travels in the URL
    // (keeping it out of nginx access logs / browser history).
    return `${WS_URL}/ws/${sessionId}`
  }

  current = new WebSocket(buildWsUrl())
  wireHandlers(current)

  const wrapper: ReconnectingWebSocket = {
    get onmessage() { return _onmessage },
    set onmessage(h) { _onmessage = h },
    get onopen() { return _onopen },
    set onopen(h) { _onopen = h },
    get onerror() { return _onerror },
    set onerror(h) { _onerror = h },
    get onclose() { return _onclose },
    set onclose(h) { _onclose = h },
    get onreconnect() { return _onreconnect },
    set onreconnect(h) { _onreconnect = h },
    get onstatechange() { return _onstatechange },
    set onstatechange(h) {
      _onstatechange = h
      // Улучшатели#3 P0·M — WS reconnect UI: replay current state to new subscriber
      // so late-mounted UIs immediately reflect the lifecycle.
      if (h) {
        try { h(_state) } catch (err) { console.error('WS onstatechange handler threw:', err) }
      }
    },
    get readyState() { return current.readyState },
    get connectionState() { return _state },
    send(data) { current.send(data) },
    close(code?: number, reason?: string) {
      explicitlyClosed = true
      current.close(code, reason)
    },
  }

  return wrapper
}

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string
  email: string
  is_active: boolean
}

export async function requestOTP(email: string): Promise<{ message: string; not_allowed?: boolean }> {
  return apiFetch<{ message: string; not_allowed?: boolean }>('/api/auth/request-otp', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function requestAccess(email: string): Promise<{ message: string }> {
  return apiFetch<{ message: string }>('/api/auth/request-access', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export async function verifyOTP(
  email: string,
  code: string,
): Promise<{ access_token: string; token_type: string; user: AuthUser }> {
  return apiFetch<{ access_token: string; token_type: string; user: AuthUser }>(
    '/api/auth/verify-otp',
    {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    },
  )
}

export async function getCurrentUser(): Promise<AuthUser & { created_at: string; last_login_at: string | null }> {
  return apiFetch('/api/auth/me')
}

/** КАО#SG1-selfxss — clear the httpOnly session cookie on the server. */
export async function logoutApi(): Promise<void> {
  await apiFetch<void>('/api/auth/logout', { method: 'POST' })
}

/**
 * КАО#SR-4 Round 4 — Anonymous-safe variant used at app startup.
 *
 * On stage/prod the backend always requires auth, so calling /api/auth/me
 * without a token produces a 401 that the browser logs as a console.error.
 * For the anonymous /login page mount this is just noise — there is no real
 * error, the app is simply checking whether dev-mode is on (i.e. the backend
 * is configured to return a "dev" user without a token).
 *
 * This helper short-circuits when no token is stored AND we are running on a
 * non-localhost origin. On localhost we still probe (so dev-mode detection
 * keeps working). On stage/prod we just return null silently.
 */
export async function probeCurrentUserForDevMode(): Promise<
  (AuthUser & { created_at: string; last_login_at: string | null }) | null
> {
  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0'
    if (!isLocal) {
      return null
    }
  }
  try {
    return await apiFetch('/api/auth/me')
  } catch {
    return null
  }
}

// ============================================================================
// Session Templates API
// ============================================================================

export interface TemplateResponse {
  id: string
  name: string
  description?: string | null
  agent_configs: any[]
  language: string
  max_iterations: number
  auto_continue: boolean
  enable_code_execution: boolean
  execution_timeout: number
  max_fix_attempts: number
  auto_install_deps: boolean
  agent_timeout: number
  request_timeout: number
  settings?: Record<string, any> | null
  created_at: string
  updated_at: string
}

export async function listTemplates(): Promise<TemplateResponse[]> {
  return apiFetch<TemplateResponse[]>('/api/templates/')
}

export async function getTemplate(templateId: string): Promise<TemplateResponse> {
  return apiFetch<TemplateResponse>(`/api/templates/${templateId}`)
}

export async function createTemplateFromSession(
  sessionId: string,
  name: string,
  description?: string,
): Promise<TemplateResponse> {
  return apiFetch<TemplateResponse>(`/api/templates/from-session/${sessionId}`, {
    method: 'POST',
    body: JSON.stringify({ name, description: description || null }),
  })
}

export async function updateTemplate(
  templateId: string,
  data: { name?: string; description?: string | null },
): Promise<TemplateResponse> {
  return apiFetch<TemplateResponse>(`/api/templates/${templateId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteTemplate(templateId: string): Promise<void> {
  await apiFetch(`/api/templates/${templateId}`, { method: 'DELETE' })
}

export async function applyTemplate(
  templateId: string,
  specification: string,
  name: string,
): Promise<SessionResponse> {
  return apiFetch<SessionResponse>(`/api/templates/${templateId}/apply`, {
    method: 'POST',
    body: JSON.stringify({ name, specification }),
  })
}

// ============================================================================
// Spec Helper API
// ============================================================================

export interface SpecScoreIssue {
  severity: string
  description: string
  suggestion?: string
}

export interface SpecScoreResponse {
  overall_score: number
  issues: SpecScoreIssue[]
  estimated_complexity: 'trivial' | 'moderate' | 'complex'
  detected_keywords: string[]
  word_count: number
}

export interface CostEstimateResponse {
  estimated_tokens_per_iter: number
  estimated_total_tokens: number
  estimated_cost_usd: number
  estimated_time_seconds: number
  breakdown: Record<string, number>
}

export async function scoreSpec(specification: string, language?: string): Promise<SpecScoreResponse> {
  return apiFetch<SpecScoreResponse>('/api/spec-helper/spec-score', {
    method: 'POST',
    body: JSON.stringify({ specification, language }),
  })
}

export async function estimateCost(
  specification: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agent_configs: any[],
  max_iterations: number,
): Promise<CostEstimateResponse> {
  return apiFetch<CostEstimateResponse>('/api/spec-helper/cost-estimate', {
    method: 'POST',
    body: JSON.stringify({ specification, agent_configs, max_iterations }),
  })
}

// ============================================================================
// Share API
// ============================================================================

export interface ShareLinkResponse {
  share_token: string
  share_url: string
}

export interface SharedSessionResponse {
  name: string
  specification: string
  status: string
  final_code?: string
  language?: string
  created_at: string
}

export async function createShareLink(sessionId: string): Promise<ShareLinkResponse> {
  return apiFetch<ShareLinkResponse>(`/api/sessions/${sessionId}/share`, { method: 'POST' })
}

export async function revokeShareLink(sessionId: string): Promise<void> {
  await apiFetch<void>(`/api/sessions/${sessionId}/share`, { method: 'DELETE' })
}

export async function getSharedSession(token: string): Promise<SharedSessionResponse> {
  return apiFetch<SharedSessionResponse>(`/api/share/${token}`)
}

// ============================================================================
// Auto-generate (Tests / Docs) API
// ============================================================================

export interface GenerateTestsResponse {
  tests_code: string
  language: string
  stub?: boolean
}

export interface GenerateDocsResponse {
  readme: string
  api_docs?: string
  stub?: boolean
}

export async function generateTests(sessionId: string): Promise<GenerateTestsResponse> {
  return apiFetch<GenerateTestsResponse>(`/api/sessions/${sessionId}/generate-tests`, { method: 'POST' })
}

export async function generateDocs(sessionId: string): Promise<GenerateDocsResponse> {
  return apiFetch<GenerateDocsResponse>(`/api/sessions/${sessionId}/generate-docs`, { method: 'POST' })
}

// ============================================================================
// Deploy API (Feature #10) — Vercel one-click deploy for HTML/JS sessions
// ============================================================================

export interface VercelDeployResponse {
  deploy_url: string
  inspect_url?: string
  project_id?: string
  deployment_id?: string
}

export async function deployToVercel(
  sessionId: string,
  token: string,
  projectName?: string,
): Promise<VercelDeployResponse> {
  return apiFetch<VercelDeployResponse>(`/api/sessions/${sessionId}/deploy/vercel`, {
    method: 'POST',
    body: JSON.stringify({ token, project_name: projectName }),
  })
}

// ============================================================================
// КАО#VR-Wave1 Frontend — Visual Review API
// ============================================================================

export interface VisualReviewResponse {
  candidates: VisualReviewCandidate[]
  /** VR-41 — number of coder agents configured on the session. UI uses
      `total_configured_coders - candidates.length` to show a "N of M coders
      failed" warning when some agents didn't produce screenshots. */
  total_configured_coders?: number
  /** VR-41 — coder_index values that were configured but absent from
      candidates (failed mid-pipeline). Used to label the warning banner. */
  missing_coder_indices?: number[]
}

export interface VisualReviewScore {
  code_version_id: string
  score: number  // 0-10
}

/** Fetch the list of candidates plus their screenshots for the review session. */
export async function getVisualReview(sessionId: string): Promise<VisualReviewResponse> {
  return apiFetch<VisualReviewResponse>(`/api/sessions/${sessionId}/visual-review`)
}

/** Submit user scores and unblock the workflow (server proceeds to finalize). */
export async function submitVisualReviewScores(
  sessionId: string,
  scores: VisualReviewScore[],
): Promise<void> {
  await apiFetch<void>(`/api/sessions/${sessionId}/visual-review/scores`, {
    method: 'POST',
    body: JSON.stringify({ scores }),
  })
}

/** Skip user review entirely — server falls back to vision-LLM / auto pick. */
export async function skipVisualReview(sessionId: string): Promise<void> {
  await apiFetch<void>(`/api/sessions/${sessionId}/visual-review/skip`, {
    method: 'POST',
  })
}

/** Fetch a candidate's raw HTML for live preview inside an <iframe srcdoc>.
 *
 * Returns plain text (the HTML body), NOT JSON. The caller renders it via
 * srcdoc rather than src so the iframe loads from an in-process blob URL —
 * this is critical because the platform's nginx sets X-Frame-Options: DENY
 * on every response, which would block a src-based iframe load. КАО#VR-23.
 */
export async function getVisualReviewPreviewHtml(
  sessionId: string,
  codeVersionId: string,
): Promise<string> {
  const response = await apiFetchRaw(
    `/api/sessions/${sessionId}/visual-review/${codeVersionId}/preview`,
    { headers: { Accept: 'text/html' } },
  )
  if (!response.ok) {
    throw new Error(`Preview fetch failed: HTTP ${response.status}`)
  }
  return response.text()
}

// ============================================================================
// Webhooks API
// ============================================================================

export type WebhookType = 'slack' | 'discord' | 'generic'

export interface WebhookResponseT {
  id: string
  name: string
  url: string
  webhook_type: WebhookType
  event_filter: string | null
  enabled: boolean
  has_secret: boolean
  last_sent_at: string | null
  last_status: number | null
  last_error: string | null
  total_sent: number
  total_failed: number
  created_at: string
  updated_at: string
}

export interface WebhookCreateRequest {
  name: string
  url: string
  webhook_type: WebhookType
  event_filter?: string | null
  secret?: string | null
  enabled?: boolean
}

export interface WebhookUpdateRequest {
  name?: string
  url?: string
  webhook_type?: WebhookType
  event_filter?: string | null
  secret?: string | null
  enabled?: boolean
}

export interface WebhookTestResult {
  success: boolean
  status_code: number | null
  error: string | null
}

export async function listWebhooks(): Promise<WebhookResponseT[]> {
  return apiFetch<WebhookResponseT[]>('/api/webhooks/')
}

export async function createWebhook(data: WebhookCreateRequest): Promise<WebhookResponseT> {
  return apiFetch<WebhookResponseT>('/api/webhooks/', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateWebhook(
  webhookId: string,
  data: WebhookUpdateRequest,
): Promise<WebhookResponseT> {
  return apiFetch<WebhookResponseT>(`/api/webhooks/${webhookId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  })
}

export async function deleteWebhook(webhookId: string): Promise<void> {
  await apiFetch(`/api/webhooks/${webhookId}`, { method: 'DELETE' })
}

export async function testWebhook(webhookId: string): Promise<WebhookTestResult> {
  return apiFetch<WebhookTestResult>(`/api/webhooks/${webhookId}/test`, {
    method: 'POST',
  })
}
