import { memo, useState, useEffect } from 'react'
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
} from 'lucide-react'

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
  // Countdown timer: unix timestamp (ms) when agent will timeout
  timeoutAt?: number
  // Edit callback for enhancer nodes
  onEditClick?: (event: React.MouseEvent) => void
  // Whether this enhancer agent is disabled (no config)
  disabled?: boolean
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

  // Countdown timer
  const [remainingSec, setRemainingSec] = useState<number | null>(null)
  useEffect(() => {
    if (!data.timeoutAt || !isActive) {
      setRemainingSec(null)
      return
    }
    const tick = () => {
      const left = Math.max(0, Math.ceil((data.timeoutAt! - Date.now()) / 1000))
      setRemainingSec(left)
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [data.timeoutAt, isActive])

  const formatCountdown = (sec: number) => {
    const m = Math.floor(sec / 60)
    const s = sec % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div
      className={`
        relative w-[200px] rounded-xl border-2 group
        ${isActive ? 'border-white/70' : data.status === 'timeout' ? 'border-amber-400' : data.status === 'error' ? 'border-red-400' : config.borderColor}
        ${selected ? 'ring-2 ring-white ring-offset-2 ring-offset-gray-900' : ''}
        ${isDisabled ? 'opacity-40 grayscale' : ''}
        transition-all duration-300 ease-out
        hover:scale-105 hover:shadow-xl
        cursor-pointer
      `}
      style={isDisabled ? undefined : isActive ? {
        animation: 'borderPulse 1.5s ease-in-out infinite',
        boxShadow: isFixing
          ? '0 0 20px rgba(249, 115, 22, 0.5), 0 0 40px rgba(249, 115, 22, 0.3)'
          : isExecuting
            ? '0 0 20px rgba(34, 197, 94, 0.5), 0 0 40px rgba(34, 197, 94, 0.3)'
            : '0 0 20px rgba(255, 255, 255, 0.5), 0 0 40px rgba(255, 255, 255, 0.3)',
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
              ? 'bg-gradient-to-r from-orange-500/30 via-orange-500/50 to-orange-500/30'
              : isExecuting
                ? 'bg-gradient-to-r from-green-500/30 via-green-500/50 to-green-500/30'
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
      <div className="relative p-4">
        {/* Header with icon and title */}
        <div className="flex items-center gap-3 mb-3">
          <div className={`
            p-2 rounded-lg bg-white/20 backdrop-blur-sm
            ${isActive ? 'animate-pulse' : ''}
          `}>
            <IconComponent className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-white text-sm truncate">
              {data.label}
            </h3>
            {data.llmModel && (
              <p className="text-xs text-white/70 truncate">
                {data.llmModel}
              </p>
            )}
          </div>
          {/* Settings icon for configurable nodes */}
          {data.onEditClick && (
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
          )}
        </div>
        
        {/* Status indicator */}
        <div className="flex items-center gap-2 mb-2">
          <StatusIcon className={`w-4 h-4 ${statusCfg.color} ${statusCfg.animation}`} />
          <span className={`text-xs font-medium ${statusCfg.color}`}>
            {statusLabel}
          </span>
          {remainingSec !== null && isActive && (
            <span className={`text-xs font-mono tabular-nums ${
              remainingSec < 60 ? 'text-red-300 animate-pulse font-bold' : remainingSec < 120 ? 'text-amber-300 font-semibold' : 'text-blue-200/90'
            }`}>
              {formatCountdown(remainingSec)}
            </span>
          )}
          {data.iteration !== undefined && data.iteration > 0 && (
            <span className="text-xs text-white/60 ml-auto">
              Iter {data.iteration}
            </span>
          )}
        </div>
        
        {/* Metrics row */}
        {(data.tokensUsed !== undefined || data.costUsd !== undefined || data.issuesFound !== undefined) && (
          <div className="flex items-center gap-3 pt-2 border-t border-white/20">
            {data.tokensUsed !== undefined && data.tokensUsed > 0 && (
              <div className="flex items-center gap-1">
                <Zap className="w-3 h-3 text-yellow-300" />
                <span className="text-xs text-white/80">
                  {data.tokensUsed.toLocaleString()}
                </span>
              </div>
            )}
            {data.costUsd !== undefined && data.costUsd > 0 && (
              <span className="text-xs text-white/80">
                ${data.costUsd.toFixed(4)}
              </span>
            )}
            {data.issuesFound !== undefined && (
              <span className="text-xs text-white/80 ml-auto">
                {data.issuesFound} issues
              </span>
            )}
          </div>
        )}
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
