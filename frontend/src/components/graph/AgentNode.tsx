import { memo, useState, useEffect, useRef } from 'react'
import { Handle, Position } from '@xyflow/react'
import {
  Code2,
  Search,
  FileStack,
  Trophy,
  FileInput,
  FileOutput,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  Palette,
  Cog,
  Shield,
  Sparkles,
  Settings2,
  Copy,
  Check,
  Maximize2,
  Info,
  Power,
} from 'lucide-react'
import notify from '../common/StyledToast'

export interface AgentNodeData extends Record<string, unknown> {
  label: string
  agentType: 'input' | 'coder' | 'tester' | 'summarizer' | 'finalizer' | 'output' | 'enhancer_design' | 'enhancer_func' | 'enhancer_security' | 'enhancer_summary'
  agentIndex?: number
  llmProvider?: string
  llmModel?: string
  status: 'idle' | 'working' | 'done' | 'error' | 'waiting' | 'executing' | 'fixing' | 'timeout'
  status_text?: string
  iteration?: number
  tokensUsed?: number
  costUsd?: number
  issuesFound?: number
  codeLines?: number
  content?: string
  // Code execution fields
  fixAttempt?: number
  maxFixAttempts?: number
  // VR-47 — persistent run→fix badge data, set when the coder finishes. Survives
  // a reload (populated from the code_version) and live runs (from WS events).
  runFixCount?: number      // number of run→fix attempts performed (1 = clean first try)
  runFixClean?: boolean     // true = code ran clean; false = hit max_fix_attempts
  // Countdown timers: unix timestamps (ms) when each timeout expires
  timeoutAt?: number              // legacy / generic (kept for compat)
  agentTimeoutAt?: number         // overall agent timeout (asyncio.wait_for)
  requestTimeoutAt?: number       // per-LLM-request httpx timeout
  sandboxTimeoutAt?: number       // sandbox execution timeout
  activeSince?: number            // unix ms when the node entered active state — for elapsed-time display
  // Edit callback for enhancer nodes
  onEditClick?: (event: React.MouseEvent) => void
  // Whether this enhancer agent is disabled (no config)
  disabled?: boolean
  // Улучшатели#3 P2·S — Disabled enhancer Enable callback. Optional —
  // when not wired by the parent we just log a warning + show a TODO.
  onEnable?: (agentType: AgentNodeData['agentType'], agentIndex?: number) => void
  // Streaming LLM output (Feature #1) - accumulated partial text from
  // `agent_streaming` WS events while session.settings.streaming === true
  streamingContent?: string
  isStreaming?: boolean
}

const agentConfig = {
  input: {
    icon: FileInput,
    gradient: 'from-slate-600 to-slate-700',
    borderColor: 'border-slate-500',
    glowColor: 'shadow-slate-500/20',
    label: 'Specification',
  },
  coder: {
    icon: Code2,
    gradient: 'from-blue-600 to-indigo-700',
    borderColor: 'border-blue-400',
    glowColor: 'shadow-blue-500/30',
    label: 'Coder',
  },
  tester: {
    icon: Search,
    gradient: 'from-amber-500 to-orange-600',
    borderColor: 'border-amber-400',
    glowColor: 'shadow-amber-500/30',
    label: 'Tester',
  },
  summarizer: {
    icon: FileStack,
    gradient: 'from-purple-600 to-violet-700',
    borderColor: 'border-purple-400',
    glowColor: 'shadow-purple-500/30',
    label: 'Summarizer',
  },
  finalizer: {
    icon: Trophy,
    gradient: 'from-emerald-500 to-teal-600',
    borderColor: 'border-emerald-400',
    glowColor: 'shadow-emerald-500/30',
    label: 'Finalizer',
  },
  output: {
    icon: FileOutput,
    gradient: 'from-green-600 to-emerald-700',
    borderColor: 'border-green-400',
    glowColor: 'shadow-green-500/30',
    label: 'Final Code',
  },
  enhancer_design: {
    icon: Palette,
    gradient: 'from-pink-500 to-rose-600',
    borderColor: 'border-pink-400',
    glowColor: 'shadow-pink-500/30',
    label: 'Design',
  },
  enhancer_func: {
    icon: Cog,
    gradient: 'from-cyan-500 to-blue-600',
    borderColor: 'border-cyan-400',
    glowColor: 'shadow-cyan-500/30',
    label: 'Functionality',
  },
  enhancer_security: {
    icon: Shield,
    gradient: 'from-red-500 to-orange-600',
    borderColor: 'border-red-400',
    glowColor: 'shadow-red-500/30',
    label: 'Security',
  },
  enhancer_summary: {
    icon: Sparkles,
    gradient: 'from-fuchsia-500 to-purple-600',
    borderColor: 'border-fuchsia-400',
    glowColor: 'shadow-fuchsia-500/30',
    label: 'Enh. Summarizer',
  },
}

const statusConfig = {
  idle: {
    indicator: Clock,
    color: 'text-gray-400',
    bgColor: 'bg-gray-500',
    label: 'Waiting...',
    animation: '',
  },
  working: {
    indicator: Loader2,
    color: 'text-blue-400',
    bgColor: 'bg-blue-500',
    label: 'Processing...',
    animation: 'animate-spin',
  },
  executing: {
    indicator: Loader2,
    color: 'text-green-400',
    bgColor: 'bg-green-500',
    label: 'Executing...',
    animation: 'animate-spin',
  },
  fixing: {
    indicator: Loader2,
    color: 'text-orange-400',
    bgColor: 'bg-orange-500',
    label: 'Fixing...',
    animation: 'animate-spin',
  },
  done: {
    indicator: CheckCircle2,
    color: 'text-green-400',
    bgColor: 'bg-green-500',
    label: 'Complete',
    animation: '',
  },
  error: {
    indicator: XCircle,
    color: 'text-red-400',
    bgColor: 'bg-red-500',
    label: 'Error',
    animation: '',
  },
  timeout: {
    indicator: Clock,
    color: 'text-amber-400',
    bgColor: 'bg-amber-500',
    label: 'Timed Out',
    animation: '',
  },
  waiting: {
    indicator: Clock,
    color: 'text-yellow-400',
    bgColor: 'bg-yellow-500',
    label: 'Waiting...',
    animation: '',
  },
}

// Action labels based on agent type when working
const workingLabels: Record<string, string> = {
  coder: 'Coding...',
  tester: 'Testing...',
  summarizer: 'Summarizing...',
  finalizer: 'Finalizing...',
  input: 'Processing...',
  output: 'Generating...',
  enhancer_design: 'Analyzing design...',
  enhancer_func: 'Analyzing functionality...',
  enhancer_security: 'Analyzing security...',
  enhancer_summary: 'Summarizing enhancements...',
}

interface AgentNodeProps {
  data: AgentNodeData
  selected?: boolean
}

function AgentNode({ data, selected }: AgentNodeProps) {
  if (!data) return null

  const config = agentConfig[data.agentType] || agentConfig.input
  const statusCfg = statusConfig[data.status] || statusConfig.idle
  const IconComponent = config.icon
  const StatusIcon = statusCfg.indicator

  const isWorking = data.status === 'working'
  const isExecuting = data.status === 'executing'
  const isFixing = data.status === 'fixing'
  const isActive = isWorking || isExecuting || isFixing
  const isWaiting = data.status === 'idle' || data.status === 'waiting'
  
  // Get appropriate status label based on agent type and status
  const getStatusLabel = () => {
    // Custom status_text takes priority (e.g. "Timed out (600s)")
    if (data.status_text) {
      return data.status_text
    }
    if (isExecuting) {
      // VR-47 — the coder's self-check is labeled "Checking" (distinct from the
      // separate Tester agents) and surfaces the run number when known.
      if (data.agentType === 'coder') {
        return (data.fixAttempt && data.maxFixAttempts)
          ? `Checking… (run ${data.fixAttempt}/${data.maxFixAttempts})`
          : 'Checking…'
      }
      return 'Executing...'
    }
    if (isFixing) {
      if (data.fixAttempt && data.maxFixAttempts) {
        return `Fixing (${data.fixAttempt}/${data.maxFixAttempts})...`
      }
      return 'Fixing code...'
    }
    if (isWorking) {
      return workingLabels[data.agentType] || 'Processing...'
    }
    return statusCfg.label
  }
  
  const isDisabled = !!data.disabled
  const statusLabel = isDisabled ? 'Disabled' : getStatusLabel()
  const isEnhancer = data.agentType.startsWith('enhancer_')

  // Multi-countdown timers
  const [agentSec, setAgentSec] = useState<number | null>(null)
  const [requestSec, setRequestSec] = useState<number | null>(null)
  const [sandboxSec, setSandboxSec] = useState<number | null>(null)
  const [elapsedSec, setElapsedSec] = useState<number | null>(null)
  // Улучшатели#3 wave 2 #4 — expandable streaming preview with copy.
  const [streamExpanded, setStreamExpanded] = useState(false)
  const [streamCopied, setStreamCopied] = useState(false)
  // Auto-collapse when streaming stops so a stale popover doesn't linger.
  useEffect(() => {
    if (!data.isStreaming && streamExpanded) {
      setStreamExpanded(false)
    }
  }, [data.isStreaming, streamExpanded])
  // Fallback "active since" timestamp captured client-side when the node first
  // becomes active — used if data.activeSince is absent (e.g. agent started
  // before the activeSince feature was deployed, or for nodes whose backend
  // event didn't carry the field).
  const activeSinceFallbackRef = useRef<number | null>(null)

  useEffect(() => {
    if (!isActive) {
      setAgentSec(null)
      setRequestSec(null)
      setSandboxSec(null)
      setElapsedSec(null)
      activeSinceFallbackRef.current = null  // reset for next active cycle
      return
    }
    // Capture local fallback on first tick of active state
    if (activeSinceFallbackRef.current === null) {
      activeSinceFallbackRef.current = Date.now()
    }
    const tick = () => {
      const now = Date.now()
      // Agent timeout (overall)
      const aAt = data.agentTimeoutAt
      setAgentSec(aAt ? Math.max(0, Math.ceil((aAt - now) / 1000)) : null)
      // Request/httpx timeout (per LLM call)
      const rAt = data.requestTimeoutAt
      setRequestSec(rAt ? Math.max(0, Math.ceil((rAt - now) / 1000)) : null)
      // Sandbox timeout
      const sAt = data.sandboxTimeoutAt
      setSandboxSec(sAt ? Math.max(0, Math.ceil((sAt - now) / 1000)) : null)
      // Legacy fallback: if only timeoutAt is set (no new fields), show as agent timer
      if (!aAt && !rAt && !sAt && data.timeoutAt) {
        setAgentSec(Math.max(0, Math.ceil((data.timeoutAt - now) / 1000)))
      }
      // Elapsed time since the node entered active state (prefer backend
      // timestamp, fall back to client-captured one)
      const startedAt = data.activeSince ?? activeSinceFallbackRef.current
      setElapsedSec(startedAt ? Math.max(0, Math.floor((now - startedAt) / 1000)) : null)
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [data.agentTimeoutAt, data.requestTimeoutAt, data.sandboxTimeoutAt, data.timeoutAt, data.activeSince, isActive])

  const formatCountdown = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  const timerColor = (sec: number) =>
    sec < 60 ? 'text-red-300 animate-pulse font-bold' :
    sec < 120 ? 'text-amber-300 font-semibold' :
    'text-blue-200/90'

  // tour-anchor flags — the orchestrator queries these selectors for Tours 2-4.
  // We mark exactly one active coder (the first one currently working) and the
  // Final Code output node, so the tour highlights the right thing without
  // having to import this component's tree.
  const tourAttrs: Record<string, string> = {}
  if (data.agentType === 'input') {
    tourAttrs['data-tour'] = 'spec-field'
  }
  if (data.agentType === 'coder' && isActive) {
    tourAttrs['data-tour-candidate'] = 'active-coder'
  }
  if (data.agentType === 'output') {
    tourAttrs['data-tour'] = 'final-code'
  }

  // Улучшатели#3 P2·S — Specification-node click affordance. Only the input
  // (Specification) node opens SpecificationsDialog on click; expose `cursor-help`
  // and a body-level title so users discover the interaction.
  const isSpecificationNode = data.agentType === 'input'

  return (
    <div
      {...tourAttrs}
      title={isSpecificationNode ? 'Click to view full specification' : undefined}
      className={`
        relative w-[220px] rounded-xl border-2 group
        ${isActive ? 'border-white/70' : data.status === 'timeout' ? 'border-amber-400' : data.status === 'error' ? 'border-red-400' : config.borderColor}
        ${selected ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900' : ''}
        ${isDisabled ? 'opacity-60' : ''}
        transition-all duration-300 ease-out
        hover:scale-105 hover:shadow-xl
        ${isSpecificationNode ? 'cursor-help' : 'cursor-pointer'}
      `}
      style={isDisabled ? undefined : isActive ? {
        animation: 'borderPulse 1.5s ease-in-out infinite',
        boxShadow: isFixing
          ? '0 0 25px rgba(249, 115, 22, 0.6), 0 0 50px rgba(249, 115, 22, 0.4)'
          : isExecuting
            ? '0 0 20px rgba(34, 197, 94, 0.5), 0 0 40px rgba(34, 197, 94, 0.3)'
            : '0 0 15px rgba(255, 255, 255, 0.4), 0 0 30px rgba(255, 255, 255, 0.2)',
      } : data.status === 'timeout' ? {
        boxShadow: '0 0 15px rgba(251, 191, 36, 0.4), 0 0 30px rgba(251, 191, 36, 0.2)',
      } : data.status === 'error' ? {
        boxShadow: '0 0 15px rgba(248, 113, 113, 0.4), 0 0 30px rgba(248, 113, 113, 0.2)',
      } : undefined}
    >
      {/* Animated outer glow for active state */}
      {isActive && (
        <div 
          className={`absolute -inset-1 rounded-xl ${
            isFixing
              ? 'bg-gradient-to-r from-orange-500/40 via-orange-500/70 to-orange-500/40'
              : isExecuting
                ? 'bg-gradient-to-r from-green-500/40 via-green-500/70 to-green-500/40'
                : 'bg-gradient-to-r from-white/30 via-white/50 to-white/30'
          }`}
          style={{
            animation: 'borderGlow 1.5s ease-in-out infinite',
            filter: 'blur(4px)',
          }}
        />
      )}
      
      {/* Background with gradient */}
      <div className={`absolute inset-0 bg-gradient-to-br ${config.gradient} rounded-xl opacity-90`} />
      
      {/* Active pulse effect */}
      {isActive && (
        <div className={`absolute inset-0 bg-gradient-to-br ${config.gradient} rounded-xl animate-pulse opacity-50`} />
      )}
      
      {/* Content */}
      <div className="relative p-4 min-h-[140px] flex flex-col">
        {/* Header with icon and title */}
        <div className="flex items-center gap-3 mb-3">
          <div className={`
            p-2 rounded-lg bg-white/20 backdrop-blur-sm
            ${isActive ? 'animate-pulse' : ''}
          `}>
            <IconComponent className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-bold text-white text-sm leading-tight">
              {data.label}
            </h3>
            {data.llmModel && (
              <p className="text-xs text-white/80 font-medium truncate">
                {data.llmModel}
              </p>
            )}
          </div>
          {/* Settings icon for configurable nodes */}
          {data.onEditClick && (
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  data.onEditClick!(e)
                }}
                className="p-1.5 rounded-lg bg-white/10 hover:bg-white/30 transition-all"
                title="Edit configuration"
              >
                <Settings2 className="w-[18px] h-[18px] text-white" />
              </button>
              {data.disabled && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
              )}
            </div>
          )}
          {/* Улучшатели#3 P2·S — Specification-node Info affordance. Hidden
              corner indicator that becomes fully opaque on hover so the
              click target is discoverable without crowding the node body. */}
          {isSpecificationNode && (
            <div
              className="absolute top-2 right-2 opacity-50 group-hover:opacity-100 transition-opacity pointer-events-none"
              aria-hidden="true"
              title="Click to view full specification"
            >
              <Info className="w-4 h-4 text-white" />
            </div>
          )}
        </div>

        {/* Улучшатели#3 P2·S — Disabled enhancer accessibility.
            Opacity 60 (was 40) + explicit "Disabled" badge using muted
            theme colors and an in-place Enable button that surfaces on hover.
            WCAG contrast: bg-cf-text-muted text-white passes for ≥ AA. */}
        {isDisabled && (
          <div className="flex items-center gap-2 mb-2">
            <span
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider bg-cf-text-muted text-white border border-cf-text-muted"
              title="This agent is disabled and will be skipped in the next run."
            >
              Disabled
            </span>
            {/* КАО#R1-08 — only render the Enable button when a handler is wired,
                so it is never a dead control. The working path to re-enable an
                agent is the gear icon → AgentConfigPopup 'enabled' toggle. */}
            {data.onEnable && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  data.onEnable!(data.agentType, data.agentIndex)
                }}
                className="hidden group-hover:inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-600/80 hover:bg-emerald-500 text-white transition-colors"
                title="Enable this agent for the next run"
                aria-label="Enable agent"
              >
                <Power className="w-3 h-3" />
                Enable
              </button>
            )}
          </div>
        )}
        
        {/* Status indicator */}
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <StatusIcon className={`w-4 h-4 ${statusCfg.color} ${statusCfg.animation}`} />
          <span className={`text-xs font-medium ${statusCfg.color}`}>
            {statusLabel}
          </span>
          {/* Улучшатели#3 P2·S — Countdown chip layout polish.
              - Wrap-friendly grid with consistent row-gap (no jaggy wrap).
              - Full tooltips spell out what each letter means.
              - On narrow widths the least-important chip (A = total agent
                timeout) is hidden via `hidden min-[200px]:inline-flex` and
                a "…" indicator surfaces it on hover. */}
          {isActive && (elapsedSec !== null || requestSec !== null || agentSec !== null || sandboxSec !== null) && (
            <div
              className="flex flex-wrap items-center gap-x-1.5 gap-y-1 ml-auto"
              data-tour-candidate="timer-chips" /* tour-anchor: countdown timers row (Tour 3, step 3) */
            >
              {elapsedSec !== null && (
                <span
                  className="inline-flex items-center text-[10px] font-mono tabular-nums text-white/85"
                  title="T = Time elapsed since the agent became active"
                  aria-label={`Time elapsed: ${formatCountdown(elapsedSec)}`}
                >
                  T:{formatCountdown(elapsedSec)}
                </span>
              )}
              {requestSec !== null && (
                <span
                  className={`inline-flex items-center text-[10px] font-mono tabular-nums ${timerColor(requestSec)}`}
                  title="R = Remaining time on the current LLM request (httpx timeout)"
                  aria-label={`LLM request timeout in: ${formatCountdown(requestSec)}`}
                >
                  R:{formatCountdown(requestSec)}
                </span>
              )}
              {sandboxSec !== null && (
                <span
                  className={`inline-flex items-center text-[10px] font-mono tabular-nums ${timerColor(sandboxSec)}`}
                  title="S = Sandbox (code execution) timeout countdown"
                  aria-label={`Sandbox timeout in: ${formatCountdown(sandboxSec)}`}
                >
                  S:{formatCountdown(sandboxSec)}
                </span>
              )}
              {agentSec !== null && (
                <>
                  <span
                    className={`hidden min-[200px]:inline-flex items-center text-[10px] font-mono tabular-nums ${timerColor(agentSec)}`}
                    title="A = Overall agent timeout (asyncio.wait_for) — total time the agent has before being killed"
                    aria-label={`Agent total timeout in: ${formatCountdown(agentSec)}`}
                  >
                    A:{formatCountdown(agentSec)}
                  </span>
                  {/* Collapsed indicator on very narrow viewports (hidden when
                      the chip itself is visible at ≥200px). */}
                  <span
                    className={`inline-flex items-center min-[200px]:hidden text-[10px] font-mono tabular-nums ${timerColor(agentSec)} cursor-help`}
                    title={`A = Overall agent timeout: ${formatCountdown(agentSec)} remaining`}
                    aria-label={`Agent total timeout: ${formatCountdown(agentSec)} remaining (hidden on narrow view)`}
                  >
                    …
                  </span>
                </>
              )}
            </div>
          )}
          {data.iteration !== undefined && data.iteration > 0 && (
            <span className="text-xs text-white/60 ml-auto">
              Iter {data.iteration}
            </span>
          )}
        </div>
        
        {/* VR-47 — persistent run→fix badge. Stays on the Coder node after it
            finishes so you can see how many run→fix iterations the code needed
            to become error-free. Green = ran clean; yellow = hit the
            max_fix_attempts limit (code still failing). */}
        {data.agentType === 'coder' && data.status === 'done' && typeof data.runFixCount === 'number' && data.runFixCount > 0 && (
          <div className="mb-2">
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold border ${
                data.runFixClean
                  ? 'bg-green-500/20 text-green-300 border-green-500/40'
                  : 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40'
              }`}
              data-testid="runfix-badge"
              data-clean={data.runFixClean ? 'true' : 'false'}
              title={data.runFixClean
                ? `Code ran clean after ${data.runFixCount} run${data.runFixCount > 1 ? 's' : ''}`
                : `Reached the fix limit (${data.runFixCount}/${data.maxFixAttempts ?? data.runFixCount}) — code still failing`}
            >
              {data.runFixClean
                ? `✓ ${data.runFixCount} run${data.runFixCount > 1 ? 's' : ''}`
                : `⚠ ${data.runFixCount}/${data.maxFixAttempts ?? data.runFixCount}`}
            </span>
          </div>
        )}

        {/* Streaming LLM output — Улучшатели#3 wave 2 #4.
            Decision (documented inline per spec): a node is too tiny to host
            scroll/copy ergonomically inline, and adding a DetailPanel round-trip
            for every glance is too heavy. We add a small "expand" icon that
            pops out an overlay (~2000 chars, scrollable, with Copy). The 200-
            char inline preview stays as a glanceable signal. */}
        {data.isStreaming && data.streamingContent && (
          <div
            className="mt-2 mb-2 px-2 py-1.5 rounded bg-black/40 border border-white/20 max-h-24 overflow-hidden relative"
            data-tour-candidate="streaming-preview" /* tour-anchor: streaming preview (Tour 3, step 2) */
          >
            <div className="text-[10px] uppercase tracking-wider text-white/60 mb-1 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              streaming
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setStreamExpanded(true)
                }}
                className="ml-auto p-0.5 rounded hover:bg-white/20 transition-colors"
                title="Expand stream (full ~2000 chars + copy)"
                aria-label="Expand streaming output"
              >
                <Maximize2 className="w-3 h-3 text-white/70" />
              </button>
            </div>
            <pre className="text-[10px] text-white/85 font-mono whitespace-pre-wrap break-words leading-snug">
              {data.streamingContent.slice(-200)}
              <span className="inline-block w-1.5 h-3 bg-emerald-400 ml-0.5 align-middle animate-pulse" />
            </pre>
          </div>
        )}

        {/* Expanded streaming popover — overlays the node when toggled. */}
        {streamExpanded && data.streamingContent && (
          <div
            className="absolute z-30 left-2 right-2 top-12 bg-gray-900/95 border border-white/30 rounded-lg shadow-2xl p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-[10px] uppercase tracking-wider text-white/70">stream tail</span>
              <span className="text-[10px] text-white/40 font-mono">
                {Math.min(data.streamingContent.length, 2000).toLocaleString()} / {data.streamingContent.length.toLocaleString()} chars
              </span>
              <button
                type="button"
                onClick={async (e) => {
                  e.stopPropagation()
                  try {
                    await navigator.clipboard.writeText(data.streamingContent || '')
                    setStreamCopied(true)
                    notify.success('Streaming output copied')
                    setTimeout(() => setStreamCopied(false), 2000)
                  } catch {
                    notify.error('Copy failed')
                  }
                }}
                className="ml-auto flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-white/85 bg-white/10 hover:bg-white/20 rounded transition-colors"
                title="Copy full stream"
              >
                {streamCopied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {streamCopied ? 'Copied' : 'Copy'}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setStreamExpanded(false)
                }}
                className="p-0.5 rounded hover:bg-white/20 transition-colors"
                title="Close expanded view"
                aria-label="Close expanded streaming output"
              >
                <XCircle className="w-3 h-3 text-white/70" />
              </button>
            </div>
            <pre className="text-[10px] text-white/90 font-mono whitespace-pre-wrap break-words leading-snug max-h-48 overflow-y-auto">
              {data.streamingContent.slice(-2000)}
            </pre>
          </div>
        )}

        {/* Metrics row. While streaming we estimate tokens from streamingContent
            length (~4 chars per token) so the user sees a live count instead of
            waiting for agent_completed. Once the agent finishes, tokensUsed
            from the WS event takes over. */}
        {(() => {
          const streamingTokens = (data.isStreaming && data.streamingContent && (data.tokensUsed === undefined || data.tokensUsed === 0))
            ? Math.max(1, Math.round(data.streamingContent.length / 4))
            : 0
          const displayTokens = (data.tokensUsed !== undefined && data.tokensUsed > 0) ? data.tokensUsed : streamingTokens
          const showRow = displayTokens > 0 || data.costUsd !== undefined || data.issuesFound !== undefined
          if (!showRow) return null
          return (
          <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-white/20">
            {displayTokens > 0 && (
              <div className="flex items-center gap-1 bg-white/5 rounded px-1.5 py-0.5" title={streamingTokens > 0 && !data.tokensUsed ? 'Estimated from streaming output (~4 chars/token)' : 'Tokens used'}>
                <Zap className="w-3.5 h-3.5 text-yellow-300" />
                <span className="text-xs text-white/90">
                  {streamingTokens > 0 && !data.tokensUsed ? '~' : ''}{displayTokens.toLocaleString()}
                </span>
              </div>
            )}
            {data.costUsd !== undefined && data.costUsd > 0 && (
              <div className="flex items-center gap-1 bg-white/5 rounded px-1.5 py-0.5">
                <span className="text-xs text-white/90">
                  ${data.costUsd.toFixed(4)}
                </span>
              </div>
            )}
            {data.issuesFound !== undefined && (
              <div className="flex items-center gap-1 bg-white/5 rounded px-1.5 py-0.5 ml-auto">
                <span className="text-xs text-white/90">
                  {data.issuesFound} issues
                </span>
              </div>
            )}
          </div>
          )
        })()}
      </div>
      
      {/* Connection handles — standard */}
      {data.agentType !== 'input' && (
        <Handle
          type="target"
          position={Position.Left}
          id="left-target"
          className="!w-3 !h-3 !bg-white !border-2 !border-gray-700"
        />
      )}
      {data.agentType !== 'output' && (
        <Handle
          type="source"
          position={Position.Right}
          id="right-source"
          className="!w-3 !h-3 !bg-white !border-2 !border-gray-700"
        />
      )}

      {/* Extra handles for enhancer flow */}
      {data.agentType === 'output' && (
        <Handle type="source" position={Position.Bottom} id="bottom-source" className="!w-3 !h-3 !bg-purple-400 !border-2 !border-gray-700" />
      )}
      {data.agentType === 'coder' && (
        <Handle type="target" position={Position.Bottom} id="bottom-target" className="!w-3 !h-3 !bg-purple-400 !border-2 !border-gray-700" />
      )}
      {isEnhancer && (
        <>
          <Handle type="target" position={Position.Right} id="right-target" className="!w-3 !h-3 !bg-purple-400 !border-2 !border-gray-700" />
          <Handle type="source" position={Position.Left} id="left-source" className="!w-3 !h-3 !bg-purple-400 !border-2 !border-gray-700" />
        </>
      )}
    </div>
  )
}

export default memo(AgentNode)
