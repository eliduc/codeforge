import { useState, useEffect, useRef } from 'react'
import {
  Palette,
  Cog,
  Shield,
  FileStack,
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
} from 'lucide-react'
import notify from '../common/StyledToast'
import { enhanceSession } from '../../services/api'
import type { EnhancerAgentConfig, EnhancerSummarizerConfig } from '../../types'
import { useProvidersStore } from '../../stores/providersStore'

// ============================================================================
// Types
// ============================================================================

interface EnhancerPanelProps {
  sessionId: string
  sessionStatus: string
  hasFinalResult: boolean
  parentSessionId?: string
  enhancementRound: number
  onEnhancementCreated: (newSessionId: string) => void
}

interface EnhancerState {
  design: EnhancerAgentConfig
  functionality: EnhancerAgentConfig
  security: EnhancerAgentConfig
  summarizer: EnhancerSummarizerConfig
}

type EnhancerStatus = 'idle' | 'running' | 'completed' | 'error'

// ============================================================================
// Constants
// ============================================================================

const enhancerMeta = {
  design: {
    icon: Palette,
    label: 'Design',
    description: 'UI/UX, layout, accessibility, visual design',
    gradient: 'from-pink-500 to-rose-600',
    border: 'border-pink-400/40',
    bg: 'bg-pink-500/5',
    text: 'text-pink-400',
    badge: 'bg-pink-500/20 text-pink-300',
  },
  functionality: {
    icon: Cog,
    label: 'Functionality',
    description: 'Features, edge cases, performance, code quality',
    gradient: 'from-cyan-500 to-blue-600',
    border: 'border-cyan-400/40',
    bg: 'bg-cyan-500/5',
    text: 'text-cyan-400',
    badge: 'bg-cyan-500/20 text-cyan-300',
  },
  security: {
    icon: Shield,
    label: 'Security',
    description: 'Vulnerabilities, input validation, secure coding',
    gradient: 'from-red-500 to-orange-600',
    border: 'border-red-400/40',
    bg: 'bg-red-500/5',
    text: 'text-red-400',
    badge: 'bg-red-500/20 text-red-300',
  },
}

const typeToKey: Record<string, string> = {
  enhancer_design: 'design',
  enhancer_func: 'functionality',
  enhancer_security: 'security',
}

// ============================================================================
// Component
// ============================================================================

export default function EnhancerPanel({
  sessionId,
  sessionStatus,
  hasFinalResult,
  parentSessionId,
  enhancementRound,
  onEnhancementCreated,
}: EnhancerPanelProps) {
  const { providers, fetchProviders, loaded: providersLoaded } = useProvidersStore()
  const [expanded, setExpanded] = useState(true)
  const [enhancerStatus, setEnhancerStatus] = useState<EnhancerStatus>('idle')
  
  const [state, setState] = useState<EnhancerState>(() => {
    // Restore from localStorage if available
    try {
      const saved = localStorage.getItem('codeforge_enhancer_state')
      if (saved) return JSON.parse(saved)
    } catch { /* ignore */ }
    return {
      design: { type: 'enhancer_design', enabled: true, provider: '', model: '', recommendations: '' },
      functionality: { type: 'enhancer_func', enabled: true, provider: '', model: '', recommendations: '' },
      security: { type: 'enhancer_security', enabled: true, provider: '', model: '', recommendations: '' },
      summarizer: { provider: '', model: '' },
    }
  })

  // Persist enhancer state to localStorage on change
  useEffect(() => {
    try {
      localStorage.setItem('codeforge_enhancer_state', JSON.stringify(state))
    } catch { /* ignore */ }
  }, [state])

  // Load providers from store
  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  // Set defaults when providers load
  useEffect(() => {
    if (providers.length === 0) return
    const dp = providers[0]
    const dm = dp.models[0] || ''
    setState(prev => ({
      design: { ...prev.design, provider: prev.design.provider || dp.name, model: prev.design.model || dm },
      functionality: { ...prev.functionality, provider: prev.functionality.provider || dp.name, model: prev.functionality.model || dm },
      security: { ...prev.security, provider: prev.security.provider || dp.name, model: prev.security.model || dm },
      summarizer: { provider: prev.summarizer.provider || dp.name, model: prev.summarizer.model || dm },
    }))
  }, [providers])

  const canEnhance =
    sessionStatus === 'completed' &&
    hasFinalResult &&
    enhancerStatus !== 'running' &&
    (state.design.enabled || state.functionality.enabled || state.security.enabled) &&
    // All enabled agents must have provider+model set
    [state.design, state.functionality, state.security]
      .filter(a => a.enabled)
      .every(a => a.provider && a.model) &&
    state.summarizer.provider && state.summarizer.model

  const handleEnhance = async () => {
    if (!canEnhance) return
    setEnhancerStatus('running')
    try {
      const enabledEnhancers = [state.design, state.functionality, state.security].filter(e => e.enabled)
      const result = await enhanceSession(sessionId, {
        enhancers: enabledEnhancers,
        summarizer: state.summarizer,
      })
      notify.success(result.message)
      // The new session ID will come via WebSocket event
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Enhancement failed'
      notify.error(msg)
      setEnhancerStatus('error')
    }
  }

  // Keep a stable ref for the callback to avoid re-subscribing event listeners
  const onEnhancementCreatedRef = useRef(onEnhancementCreated)
  useEffect(() => { onEnhancementCreatedRef.current = onEnhancementCreated }, [onEnhancementCreated])

  // Listen for WS events (parent page should pass these down or we can listen here)
  useEffect(() => {
    const handler = (e: CustomEvent) => {
      const { type, data } = e.detail || {}
      if (data?.session_id !== sessionId) return
      if (type === 'enhancement_session_created') {
        setEnhancerStatus('completed')
        if (data.new_session_id) {
          onEnhancementCreatedRef.current(data.new_session_id)
        }
      } else if (type === 'enhancer_error') {
        setEnhancerStatus('error')
        notify.error(data.error || 'Enhancement failed')
      }
    }
    window.addEventListener('enhancer_event' as any, handler as any)
    return () => window.removeEventListener('enhancer_event' as any, handler as any)
  }, [sessionId])

  const updateAgent = (key: 'design' | 'functionality' | 'security', field: string, value: unknown) => {
    setState(prev => ({
      ...prev,
      [key]: { ...prev[key], [field]: value },
    }))
  }

  return (
    <div className="mt-4 rounded-xl border-2 border-dashed border-purple-500/30 bg-gray-900/50 overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 bg-purple-500/10 cursor-pointer hover:bg-purple-500/15 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-purple-400" />
          <span className="text-sm font-semibold text-purple-300 uppercase tracking-wider">
            Enhancer
          </span>
          {enhancementRound > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300">
              Round {enhancementRound}
            </span>
          )}
          {parentSessionId && (
            <a
              href={`/sessions/${parentSessionId}`}
              className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1"
              onClick={e => e.stopPropagation()}
            >
              <ExternalLink className="w-3 h-3" />
              Parent session
            </a>
          )}
        </div>
        <div className="flex items-center gap-2">
          {enhancerStatus === 'running' && (
            <span className="flex items-center gap-1 text-xs text-yellow-400">
              <Loader2 className="w-3 h-3 animate-spin" />
              Enhancing...
            </span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-gray-400" /> : <ChevronDown className="w-4 h-4 text-gray-400" />}
        </div>
      </div>

      {expanded && (
        <div className="p-4 space-y-4">
          {!providersLoaded ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
              <span className="ml-2 text-sm text-gray-400">Loading configuration...</span>
            </div>
          ) : (
          <>
          {/* Reverse flow indicator */}
          <div className="text-xs text-gray-500 text-center">
            Finalizer → Enhancer Agents → Enhancement Summarizer → Coders (new session)
          </div>

          {/* Enhancer Agents */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(Object.entries(enhancerMeta) as [string, typeof enhancerMeta.design][]).map(([key, meta]) => {
              const agent = state[key as keyof typeof enhancerMeta] as EnhancerAgentConfig
              const Icon = meta.icon
              return (
                <div
                  key={key}
                  className={`rounded-lg border ${meta.border} ${meta.bg} p-3 transition-opacity ${
                    !agent.enabled ? 'opacity-40' : ''
                  }`}
                >
                  {/* Agent header with toggle */}
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Icon className={`w-4 h-4 ${meta.text}`} />
                      <span className={`text-sm font-medium ${meta.text}`}>{meta.label}</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={agent.enabled}
                        onChange={e => updateAgent(key as any, 'enabled', e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-8 h-4 bg-gray-700 rounded-full peer peer-checked:bg-purple-600 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-full" />
                    </label>
                  </div>
                  <p className="text-xs text-gray-500 mb-2">{meta.description}</p>

                  {agent.enabled && (
                    <>
                      {/* Provider (read-only — set in pipeline) */}
                      <div className="w-full mb-1.5 px-2 py-1 bg-gray-800/50 border border-gray-700/50 rounded text-xs text-gray-400 truncate">
                        {agent.provider || 'Not set'}
                      </div>

                      {/* Model (read-only — set in pipeline) */}
                      <div className="w-full mb-1.5 px-2 py-1 bg-gray-800/50 border border-gray-700/50 rounded text-xs text-gray-400 truncate">
                        {agent.model || 'Not set'}
                      </div>

                      {/* Recommendations */}
                      <textarea
                        value={agent.recommendations || ''}
                        onChange={e => updateAgent(key as any, 'recommendations', e.target.value)}
                        placeholder={`Recommendations for ${meta.label.toLowerCase()} improvements...`}
                        rows={2}
                        className="w-full px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300 placeholder-gray-600 resize-none"
                      />
                    </>
                  )}
                </div>
              )
            })}
          </div>

          {/* Enhancement Summarizer */}
          <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-3">
            <div className="flex items-center gap-2 mb-2">
              <FileStack className="w-4 h-4 text-purple-400" />
              <span className="text-sm font-medium text-purple-400">Enhancement Summarizer</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="px-2 py-1 bg-gray-800/50 border border-gray-700/50 rounded text-xs text-gray-400 truncate">
                {state.summarizer.provider || 'Not set'}
              </div>
              <div className="px-2 py-1 bg-gray-800/50 border border-gray-700/50 rounded text-xs text-gray-400 truncate">
                {state.summarizer.model || 'Not set'}
              </div>
            </div>
          </div>

          {/* Enhance Button */}
          <button
            onClick={handleEnhance}
            disabled={!canEnhance}
            className={`
              w-full py-2.5 rounded-lg font-medium text-sm transition-all flex items-center justify-center gap-2
              ${canEnhance
                ? 'bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white shadow-lg shadow-purple-500/25'
                : 'bg-gray-800 text-gray-500 cursor-not-allowed'
              }
            `}
          >
            {enhancerStatus === 'running' ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Enhancing...
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                Enhance
              </>
            )}
          </button>

          {!canEnhance && sessionStatus !== 'completed' && (
            <p className="text-xs text-gray-500 text-center">
              Enhancement available after session completes
            </p>
          )}
          </>
          )}
        </div>
      )}
    </div>
  )
}
