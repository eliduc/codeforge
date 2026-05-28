import { create } from 'zustand'
import type {
  Session,
  AgentStatus,
  CodeVersion,
  SummaryAudit,
  FinalResult,
  SessionMetrics,
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
  
  reset: () => set(initialState),
}))
