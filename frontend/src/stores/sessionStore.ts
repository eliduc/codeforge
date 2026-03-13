import { create } from 'zustand'
import type { 
  Session, 
  AgentStatus, 
  CodeVersion, 
  SummaryAudit, 
  FinalResult,
  SessionMetrics,
  WSMessage 
} from '../types'

interface AgentState {
  status: AgentStatus
  tokens_used: number
  cost_usd: number
  message?: string
}

interface SessionState {
  // Current session data
  session: Session | null
  metrics: SessionMetrics | null
  
  // Agent states (keyed by "type_index", e.g. "coder_0")
  agentStates: Record<string, AgentState>
  
  // Code versions by iteration
  codeVersions: Record<number, CodeVersion[]>
  
  // Summaries by iteration
  summaries: Record<number, SummaryAudit[]>
  
  // Final result
  finalResult: FinalResult | null
  
  // UI state
  selectedIteration: number
  selectedCoderIndex: number | null
  selectedContent: 'code' | 'audit' | 'summary' | 'final'
  
  // Loading states
  loading: boolean
  error: string | null
  
  // Actions
  setSession: (session: Session | null) => void
  setMetrics: (metrics: SessionMetrics | null) => void
  updateAgentState: (agentType: string, agentIndex: number, state: Partial<AgentState>) => void
  addCodeVersion: (iteration: number, version: CodeVersion) => void
  addSummary: (iteration: number, summary: SummaryAudit) => void
  setFinalResult: (result: FinalResult | null) => void
  setSelectedIteration: (iteration: number) => void
  setSelectedCoderIndex: (index: number | null) => void
  setSelectedContent: (content: 'code' | 'audit' | 'summary' | 'final') => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  handleWSMessage: (message: WSMessage) => void
  reset: () => void
}

const initialState = {
  session: null,
  metrics: null,
  agentStates: {},
  codeVersions: {},
  summaries: {},
  finalResult: null,
  selectedIteration: 1,
  selectedCoderIndex: null,
  selectedContent: 'code' as const,
  loading: false,
  error: null,
}

export const useSessionStore = create<SessionState>((set, get) => ({
  ...initialState,
  
  setSession: (session) => set({ session }),
  
  setMetrics: (metrics) => set({ metrics }),
  
  updateAgentState: (agentType, agentIndex, state) => set((prev) => ({
    agentStates: {
      ...prev.agentStates,
      [`${agentType}_${agentIndex}`]: {
        ...prev.agentStates[`${agentType}_${agentIndex}`],
        ...state,
      },
    },
  })),
  
  addCodeVersion: (iteration, version) => set((prev) => ({
    codeVersions: {
      ...prev.codeVersions,
      [iteration]: [...(prev.codeVersions[iteration] || []), version],
    },
  })),
  
  addSummary: (iteration, summary) => set((prev) => ({
    summaries: {
      ...prev.summaries,
      [iteration]: [...(prev.summaries[iteration] || []), summary],
    },
  })),
  
  setFinalResult: (result) => set({ finalResult: result }),
  
  setSelectedIteration: (iteration) => set({ selectedIteration: iteration }),
  
  setSelectedCoderIndex: (index) => set({ selectedCoderIndex: index }),
  
  setSelectedContent: (content) => set({ selectedContent: content }),
  
  setLoading: (loading) => set({ loading }),
  
  setError: (error) => set({ error }),
  
  handleWSMessage: (message) => {
    const { type, data } = message
    
    switch (type) {
      case 'agent_status': {
        const { agent_type, agent_index, status, tokens_used, cost_usd } = data as {
          agent_type: string
          agent_index: number
          status: AgentStatus
          tokens_used: number
          cost_usd: number
        }
        get().updateAgentState(agent_type, agent_index ?? 0, {
          status,
          tokens_used,
          cost_usd,
        })
        break
      }
      
      case 'iteration_start': {
        const { iteration } = data as { iteration: number }
        set({ selectedIteration: iteration })
        break
      }
      
      case 'code_generated': {
        const cgData = data as {
          iteration?: number
          coder_index?: number
          code_version?: CodeVersion
        }
        if (cgData.code_version && cgData.iteration !== undefined) {
          get().addCodeVersion(cgData.iteration, cgData.code_version)
        }
        break
      }

      case 'summary_ready': {
        const srData = data as {
          iteration?: number
          coder_index?: number
          summary?: SummaryAudit
        }
        if (srData.summary && srData.iteration !== undefined) {
          get().addSummary(srData.iteration, srData.summary)
        }
        break
      }
      
      case 'workflow_completed':
      case 'workflow_complete': {
        set((prev) => ({
          session: prev.session ? { ...prev.session, status: 'completed' } : null,
        }))
        break
      }
      
      case 'workflow_error': {
        const { error } = data as { error: string }
        set((prev) => ({
          error,
          session: prev.session ? { ...prev.session, status: 'failed' } : null,
        }))
        break
      }

      case 'workflow_cancelled': {
        set((prev) => ({
          session: prev.session ? { ...prev.session, status: 'cancelled' } : null,
        }))
        break
      }

      case 'workflow_paused': {
        set((prev) => ({
          session: prev.session ? { ...prev.session, status: 'paused' } : null,
        }))
        break
      }
      
      case 'metrics_update': {
        const { total_tokens, total_cost_usd } = data as {
          total_tokens: number
          total_cost_usd: number
        }
        set((prev) => ({
          metrics: prev.metrics
            ? { ...prev.metrics, total_tokens, total_cost_usd }
            : {
                session_id: '',
                total_tokens_input: 0,
                total_tokens_output: 0,
                total_tokens,
                total_cost_usd,
                total_requests: 0,
                total_time_ms: 0,
                iterations_completed: 0,
                by_agent: {},
                by_provider: {},
              },
        }))
        break
      }
    }
  },
  
  reset: () => set(initialState),
}))
