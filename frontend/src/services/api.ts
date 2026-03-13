// API service for CodeForge Frontend v1.1.0

const API_URL = import.meta.env.VITE_API_URL || ''
const WS_URL = import.meta.env.VITE_WS_URL || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`

import type {
  SessionListItem,
  PromptTemplate,
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
  parent_session_id?: string
  enhancement_round: number
  created_at: string
  updated_at: string
  agent_configs: AgentConfigResponse[]
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
// Auth token helpers
// ---------------------------------------------------------------------------
const AUTH_TOKEN_KEY = 'codeforge_token'

export function getStoredToken(): string | null {
  return localStorage.getItem(AUTH_TOKEN_KEY)
}

export function setStoredToken(token: string): void {
  localStorage.setItem(AUTH_TOKEN_KEY, token)
}

export function clearStoredToken(): void {
  localStorage.removeItem(AUTH_TOKEN_KEY)
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

    // Attach Bearer token if available
    const token = getStoredToken()
    if (token && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${token}`
    }

    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers,
    })

    // Handle 401 — clear token and redirect to login
    if (response.status === 401 && !endpoint.startsWith('/api/auth/')) {
      clearStoredToken()
      window.location.href = '/login'
      throw new Error('Session expired. Please log in again.')
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Unknown error' }))
      throw new Error(error.detail || `API error: ${response.status}`)
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

export async function createSession(data: CreateSessionRequest): Promise<SessionResponse> {
  return apiFetch<SessionResponse>('/api/sessions/', {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateSession(
  sessionId: string,
  data: Partial<Pick<CreateSessionRequest, 'name' | 'specification' | 'initial_code' | 'initial_docs' | 'language' | 'max_iterations' | 'enable_code_execution' | 'execution_timeout' | 'max_fix_attempts' | 'auto_install_deps' | 'auto_continue' | 'agent_timeout'>>
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
  data: { llm_provider?: string; llm_model?: string; thinking_effort?: string | null; max_tokens?: number; custom_prompt?: string | null; enabled?: boolean },
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
  readonly readyState: number
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

  let current: WebSocket

  function wireHandlers(ws: WebSocket) {
    ws.onmessage = (ev) => _onmessage?.(ev)
    ws.onopen = (ev) => {
      const isReconnect = hasConnectedOnce
      hasConnectedOnce = true
      retryCount = 0
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
        _onclose?.(ev)
        return
      }
      if (ev.code === 4001) {
        _onclose?.(ev)
        return
      }
      if (retryCount < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, retryCount)
        retryCount++
        console.warn(
          `WebSocket closed (code=${ev.code}). Reconnecting in ${delay}ms (attempt ${retryCount}/${maxRetries})...`,
        )
        setTimeout(() => {
          current = new WebSocket(buildWsUrl())
          wireHandlers(current)
        }, delay)
      } else {
        console.error(`WebSocket reconnection failed after ${maxRetries} attempts`)
        _onclose?.(ev)
      }
    }
  }

  function buildWsUrl() {
    const token = getStoredToken()
    const base = `${WS_URL}/ws/${sessionId}`
    return token ? `${base}?token=${encodeURIComponent(token)}` : base
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
    get readyState() { return current.readyState },
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
