import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import {
  Code2,
  Search,
  FileStack,
  Trophy,
  FileInput,
  FileOutput,
  Plus,
  Minus,
  X,
  ChevronRight,
  ChevronLeft,
  Copy,
  Palette,
  Cog,
  Shield,
  Sparkles,
} from 'lucide-react'
import type { ProviderInfo } from '../types'

// ============================================================================
// Types
// ============================================================================

export interface AgentConfig {
  provider: string
  model: string
}

export interface EnhancerConfig {
  enabled: boolean
  provider: string
  model: string
}

interface PipelineBuilderProps {
  coderConfigs: AgentConfig[]
  testerConfigs: AgentConfig[]
  summarizerConfig: AgentConfig
  finalizerConfig: AgentConfig
  setCoderConfigs: React.Dispatch<React.SetStateAction<AgentConfig[]>>
  setTesterConfigs: React.Dispatch<React.SetStateAction<AgentConfig[]>>
  setSummarizerConfig: React.Dispatch<React.SetStateAction<AgentConfig>>
  setFinalizerConfig: React.Dispatch<React.SetStateAction<AgentConfig>>
  enhancerDesign?: EnhancerConfig
  enhancerFunc?: EnhancerConfig
  enhancerSecurity?: EnhancerConfig
  enhancerSummarizer?: AgentConfig
  setEnhancerDesign?: React.Dispatch<React.SetStateAction<EnhancerConfig>>
  setEnhancerFunc?: React.Dispatch<React.SetStateAction<EnhancerConfig>>
  setEnhancerSecurity?: React.Dispatch<React.SetStateAction<EnhancerConfig>>
  setEnhancerSummarizer?: React.Dispatch<React.SetStateAction<AgentConfig>>
  providers: ProviderInfo[]
  hasProviders: boolean
  onSpecificationClick?: () => void
}

type SelectedNode = {
  type: 'coder' | 'tester' | 'summarizer' | 'finalizer' | 'enhancer_design' | 'enhancer_func' | 'enhancer_security' | 'enhancer_summary'
  index: number
} | null

// ============================================================================
// Styles
// ============================================================================

const nodeStyles = {
  coder: {
    icon: Code2,
    gradient: 'from-blue-500 to-indigo-600',
    glow: 'shadow-blue-500/20',
    borderSelected: 'ring-2 ring-blue-400',
  },
  tester: {
    icon: Search,
    gradient: 'from-amber-500 to-orange-600',
    glow: 'shadow-amber-500/20',
    borderSelected: 'ring-2 ring-amber-400',
  },
  summarizer: {
    icon: FileStack,
    gradient: 'from-purple-500 to-violet-600',
    glow: 'shadow-purple-500/20',
    borderSelected: 'ring-2 ring-purple-400',
  },
  finalizer: {
    icon: Trophy,
    gradient: 'from-emerald-500 to-teal-600',
    glow: 'shadow-emerald-500/20',
    borderSelected: 'ring-2 ring-emerald-400',
  },
  enhancer_design: {
    icon: Palette,
    gradient: 'from-pink-500 to-rose-600',
    glow: 'shadow-pink-500/20',
    borderSelected: 'ring-2 ring-pink-400',
  },
  enhancer_func: {
    icon: Cog,
    gradient: 'from-cyan-500 to-blue-600',
    glow: 'shadow-cyan-500/20',
    borderSelected: 'ring-2 ring-cyan-400',
  },
  enhancer_security: {
    icon: Shield,
    gradient: 'from-red-500 to-orange-600',
    glow: 'shadow-red-500/20',
    borderSelected: 'ring-2 ring-red-400',
  },
  enhancer_summary: {
    icon: Sparkles,
    gradient: 'from-fuchsia-500 to-purple-600',
    glow: 'shadow-fuchsia-500/20',
    borderSelected: 'ring-2 ring-fuchsia-400',
  },
}

const groupStyles = {
  coding: {
    border: 'border-blue-500/25',
    bg: 'bg-blue-500/5',
    title: 'text-blue-400',
    badge: 'bg-blue-500/20 text-blue-300',
  },
  testing: {
    border: 'border-amber-500/25',
    bg: 'bg-amber-500/5',
    title: 'text-amber-400',
    badge: 'bg-amber-500/20 text-amber-300',
  },
}

function shortModel(model: string): string {
  if (!model) return 'none'
  const parts = model.split('/')
  const name = parts[parts.length - 1]
  return name.length > 18 ? name.substring(0, 16) + '…' : name
}

// ============================================================================
// Sub-components
// ============================================================================

function Connector() {
  return (
    <div className="flex items-center px-1 shrink-0 self-center">
      <div className="w-6 h-0.5 bg-gray-600" />
      <ChevronRight className="w-4 h-4 text-gray-500 -ml-1" />
    </div>
  )
}

function ReverseConnector() {
  return (
    <div className="flex items-center px-1 shrink-0 self-center">
      <ChevronLeft className="w-4 h-4 text-gray-500 -mr-1" />
      <div className="w-6 h-0.5 bg-purple-500/40" />
    </div>
  )
}

function StaticNode({
  icon: Icon,
  label,
  gradient,
  onClick,
}: {
  icon: React.ElementType
  label: string
  gradient: string
  onClick?: () => void
}) {
  return (
    <div className="shrink-0 self-center">
      <div
        className={`bg-gradient-to-br ${gradient} rounded-lg px-4 py-3 border border-white/10 shadow-lg min-w-[120px] ${onClick ? 'cursor-pointer hover:scale-105 hover:shadow-xl transition-all duration-200' : ''}`}
        onClick={onClick}
      >
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-white/80" />
          <span className="text-sm font-medium text-white">{label}</span>
        </div>
      </div>
    </div>
  )
}

function AgentCard({
  type,
  index,
  label,
  model,
  isSelected,
  canRemove,
  onClick,
  onRemove,
}: {
  type: keyof typeof nodeStyles
  index: number
  label: string
  model: string
  isSelected: boolean
  canRemove: boolean
  onClick: () => void
  onRemove?: () => void
}) {
  const style = nodeStyles[type]
  const Icon = style.icon

  return (
    <div
      onClick={onClick}
      className={`
        relative group cursor-pointer transition-all duration-150
        bg-gradient-to-br ${style.gradient} rounded-lg px-3 py-2.5
        border border-white/10 shadow-lg ${style.glow}
        hover:scale-[1.02] hover:shadow-xl
        ${isSelected ? style.borderSelected : ''}
        min-w-[150px]
      `}
    >
      {canRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove?.() }}
          className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-500 hover:bg-red-400 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
        >
          <X className="w-3 h-3 text-white" />
        </button>
      )}
      
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4 text-white/80" />
        <span className="text-sm font-medium text-white">{label}</span>
      </div>
      <div className="text-xs text-white/50 font-mono truncate max-w-[140px]" title={model}>
        {shortModel(model)}
      </div>
    </div>
  )
}

function AgentGroup({
  title,
  type,
  configs,
  agentType,
  selectedNode,
  onSelectNode,
  onAdd,
  onRemove,
  maxAgents = 5,
}: {
  title: string
  type: 'coding' | 'testing'
  configs: AgentConfig[]
  agentType: 'coder' | 'tester'
  selectedNode: SelectedNode
  onSelectNode: (node: SelectedNode) => void
  onAdd: () => void
  onRemove: (index: number) => void
  maxAgents?: number
}) {
  const gs = groupStyles[type]
  const agentLabel = agentType === 'coder' ? 'Coder' : 'Tester'

  return (
    <div className={`shrink-0 self-center rounded-xl border-2 border-dashed ${gs.border} ${gs.bg} p-3 min-w-[180px]`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold uppercase tracking-wider ${gs.title}`}>
            {title}
          </span>
          <span className={`text-xs px-1.5 py-0.5 rounded-full ${gs.badge}`}>
            {configs.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => { if (configs.length > 1) onRemove(configs.length - 1) }}
            disabled={configs.length <= 1}
            className="p-0.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Minus className="w-3.5 h-3.5 text-gray-400" />
          </button>
          <button
            type="button"
            onClick={onAdd}
            disabled={configs.length >= maxAgents}
            className="p-0.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <Plus className="w-3.5 h-3.5 text-gray-400" />
          </button>
        </div>
      </div>

      <div className="space-y-2">
        {configs.map((config, index) => (
          <AgentCard
            key={`${agentType}-${index}-${config.provider}-${config.model}`}
            type={agentType}
            index={index}
            label={`${agentLabel} ${index + 1}`}
            model={config.model}
            isSelected={selectedNode?.type === agentType && selectedNode?.index === index}
            canRemove={configs.length > 1}
            onClick={() => onSelectNode({ type: agentType, index })}
            onRemove={() => onRemove(index)}
          />
        ))}
      </div>

      {configs.length < maxAgents && (
        <button
          type="button"
          onClick={onAdd}
          className="mt-2 w-full flex items-center justify-center gap-1 py-1.5 rounded-lg border border-dashed border-gray-600 hover:border-gray-400 text-gray-500 hover:text-gray-300 text-xs transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add {agentLabel}
        </button>
      )}
    </div>
  )
}

// ============================================================================
// Config Panel (right side)
// ============================================================================

function ConfigPanel({
  selectedNode,
  config,
  providers,
  hasProviders,
  onUpdateProvider,
  onUpdateModel,
  onApplyToAll,
  showApplyAll,
  onClose,
  enabled,
  onToggleEnabled,
}: {
  selectedNode: NonNullable<SelectedNode>
  config: AgentConfig
  providers: ProviderInfo[]
  hasProviders: boolean
  onUpdateProvider: (provider: string) => void
  onUpdateModel: (model: string) => void
  onApplyToAll?: () => void
  showApplyAll: boolean
  onClose: () => void
  enabled?: boolean
  onToggleEnabled?: (enabled: boolean) => void
}) {
  const style = nodeStyles[selectedNode.type]
  const Icon = style.icon
  const labels: Record<string, string> = {
    coder: 'Coder',
    tester: 'Tester',
    summarizer: 'Summarizer',
    finalizer: 'Finalizer',
    enhancer_design: 'Design Enhancer',
    enhancer_func: 'Func Enhancer',
    enhancer_security: 'Security Enhancer',
    enhancer_summary: 'Enh. Summarizer',
  }
  const singleTypes = ['summarizer', 'finalizer', 'enhancer_design', 'enhancer_func', 'enhancer_security', 'enhancer_summary']
  const label = `${labels[selectedNode.type] || selectedNode.type} ${singleTypes.includes(selectedNode.type) ? '' : selectedNode.index + 1}`

  const configuredProviders = useMemo(() => {
    const configured = providers.filter(p => p.configured)
    return configured.length > 0 ? configured : providers
  }, [providers])

  const modelsForProvider = useMemo(() => {
    const provider = providers.find(p => p.name === config.provider)
    return provider?.models || []
  }, [providers, config.provider])

  return (
    <div className="w-52 bg-gray-800 border border-gray-600 rounded-xl p-3 flex flex-col gap-2.5 shadow-xl shadow-black/40 self-start relative z-20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`p-1 rounded-lg bg-gradient-to-br ${style.gradient}`}>
            <Icon className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-sm font-semibold text-white">{label}</span>
        </div>
        <button type="button" onClick={onClose} className="p-0.5 rounded hover:bg-gray-700 transition-colors">
          <X className="w-3.5 h-3.5 text-gray-400" />
        </button>
      </div>

      {/* Enabled toggle (for enhancer agents) */}
      {onToggleEnabled !== undefined && enabled !== undefined && (
        <label className="flex items-center justify-between cursor-pointer py-1">
          <span className="text-xs font-medium text-gray-400">Enabled</span>
          <div className="relative">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => onToggleEnabled(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-8 h-4 bg-gray-700 rounded-full peer peer-checked:bg-purple-600 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-[16px]" />
          </div>
        </label>
      )}

      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Provider</label>
        <select
          value={config.provider}
          onChange={(e) => onUpdateProvider(e.target.value)}
          disabled={!hasProviders}
          className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          {configuredProviders.length === 0 ? (
            <option value="">No providers</option>
          ) : (
            configuredProviders.map(p => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))
          )}
        </select>
      </div>

      <div>
        <label className="block text-xs font-medium text-gray-400 mb-1">Model</label>
        <select
          value={config.model}
          onChange={(e) => onUpdateModel(e.target.value)}
          disabled={!hasProviders}
          className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          {modelsForProvider.length === 0 ? (
            <option value="">No models</option>
          ) : (
            modelsForProvider.map(m => (
              <option key={m} value={m}>{m}</option>
            ))
          )}
        </select>
      </div>

      {showApplyAll && onApplyToAll && (
        <button
          type="button"
          onClick={onApplyToAll}
          className="flex items-center justify-center gap-1.5 px-2 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs text-gray-300 hover:text-white transition-colors"
        >
          <Copy className="w-3 h-3" />
          Apply to all {selectedNode.type === 'coder' ? 'coders' : 'testers'}
        </button>
      )}

      {/* OK button */}
      <button
        type="button"
        onClick={onClose}
        className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-xs font-medium text-white transition-colors"
      >
        OK
      </button>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export default function PipelineBuilder({
  coderConfigs,
  testerConfigs,
  summarizerConfig,
  finalizerConfig,
  setCoderConfigs,
  setTesterConfigs,
  setSummarizerConfig,
  setFinalizerConfig,
  enhancerDesign,
  enhancerFunc,
  enhancerSecurity,
  enhancerSummarizer,
  setEnhancerDesign,
  setEnhancerFunc,
  setEnhancerSecurity,
  setEnhancerSummarizer,
  providers,
  hasProviders,
  onSpecificationClick,
}: PipelineBuilderProps) {
  const [selectedNode, setSelectedNode] = useState<SelectedNode>(null)

  // ---- Get config for selected node ----
  const selectedConfig = useMemo(() => {
    if (!selectedNode) return null
    switch (selectedNode.type) {
      case 'coder': return coderConfigs[selectedNode.index]
      case 'tester': return testerConfigs[selectedNode.index]
      case 'summarizer': return summarizerConfig
      case 'finalizer': return finalizerConfig
      case 'enhancer_design': return enhancerDesign ? { provider: enhancerDesign.provider, model: enhancerDesign.model } : null
      case 'enhancer_func': return enhancerFunc ? { provider: enhancerFunc.provider, model: enhancerFunc.model } : null
      case 'enhancer_security': return enhancerSecurity ? { provider: enhancerSecurity.provider, model: enhancerSecurity.model } : null
      case 'enhancer_summary': return enhancerSummarizer || null
    }
  }, [selectedNode, coderConfigs, testerConfigs, summarizerConfig, finalizerConfig, enhancerDesign, enhancerFunc, enhancerSecurity, enhancerSummarizer])

  // ---- Handlers ----
  const getDefaultConfig = (): AgentConfig => {
    const configured = providers.filter(p => p.configured)
    const available = configured.length > 0 ? configured : providers
    if (available.length > 0) {
      return { provider: available[0].name, model: available[0].models[0] || '' }
    }
    return { provider: '', model: '' }
  }

  const addCoder = () => {
    if (coderConfigs.length < 5) setCoderConfigs(prev => [...prev, getDefaultConfig()])
  }
  const removeCoder = (index: number) => {
    if (coderConfigs.length > 1) {
      setCoderConfigs(prev => prev.filter((_, i) => i !== index))
      if (selectedNode?.type === 'coder' && selectedNode.index === index) setSelectedNode(null)
      else if (selectedNode?.type === 'coder' && selectedNode.index > index) setSelectedNode({ type: 'coder', index: selectedNode.index - 1 })
    }
  }
  const addTester = () => {
    if (testerConfigs.length < 5) setTesterConfigs(prev => [...prev, getDefaultConfig()])
  }
  const removeTester = (index: number) => {
    if (testerConfigs.length > 1) {
      setTesterConfigs(prev => prev.filter((_, i) => i !== index))
      if (selectedNode?.type === 'tester' && selectedNode.index === index) setSelectedNode(null)
      else if (selectedNode?.type === 'tester' && selectedNode.index > index) setSelectedNode({ type: 'tester', index: selectedNode.index - 1 })
    }
  }

  const handleUpdateProvider = (provider: string) => {
    if (!selectedNode) return
    const models = providers.find(p => p.name === provider)?.models || []
    const newModel = models[0] || ''
    switch (selectedNode.type) {
      case 'coder': setCoderConfigs(prev => { const u = [...prev]; u[selectedNode.index] = { provider, model: newModel }; return u }); break
      case 'tester': setTesterConfigs(prev => { const u = [...prev]; u[selectedNode.index] = { provider, model: newModel }; return u }); break
      case 'summarizer': setSummarizerConfig({ provider, model: newModel }); break
      case 'finalizer': setFinalizerConfig({ provider, model: newModel }); break
      case 'enhancer_design': setEnhancerDesign?.(prev => ({ ...prev, provider, model: newModel })); break
      case 'enhancer_func': setEnhancerFunc?.(prev => ({ ...prev, provider, model: newModel })); break
      case 'enhancer_security': setEnhancerSecurity?.(prev => ({ ...prev, provider, model: newModel })); break
      case 'enhancer_summary': setEnhancerSummarizer?.({ provider, model: newModel }); break
    }
  }

  const handleUpdateModel = (model: string) => {
    if (!selectedNode) return
    switch (selectedNode.type) {
      case 'coder': setCoderConfigs(prev => { const u = [...prev]; u[selectedNode.index] = { ...u[selectedNode.index], model }; return u }); break
      case 'tester': setTesterConfigs(prev => { const u = [...prev]; u[selectedNode.index] = { ...u[selectedNode.index], model }; return u }); break
      case 'summarizer': setSummarizerConfig(prev => ({ ...prev, model })); break
      case 'finalizer': setFinalizerConfig(prev => ({ ...prev, model })); break
      case 'enhancer_design': setEnhancerDesign?.(prev => ({ ...prev, model })); break
      case 'enhancer_func': setEnhancerFunc?.(prev => ({ ...prev, model })); break
      case 'enhancer_security': setEnhancerSecurity?.(prev => ({ ...prev, model })); break
      case 'enhancer_summary': setEnhancerSummarizer?.(prev => ({ ...prev, model })); break
    }
  }

  const handleApplyToAll = () => {
    if (!selectedNode || !selectedConfig) return
    if (selectedNode.type === 'coder') setCoderConfigs(prev => prev.map(() => ({ ...selectedConfig })))
    else if (selectedNode.type === 'tester') setTesterConfigs(prev => prev.map(() => ({ ...selectedConfig })))
  }

  const showApplyAll = selectedNode !== null && ((selectedNode.type === 'coder' && coderConfigs.length > 1) || (selectedNode.type === 'tester' && testerConfigs.length > 1))

  const renderConfigPanel = (type: string) => {
    if (!selectedNode || selectedNode.type !== type || !selectedConfig) return null
    const enhancerEnabled = type === 'enhancer_design' ? enhancerDesign?.enabled : type === 'enhancer_func' ? enhancerFunc?.enabled : type === 'enhancer_security' ? enhancerSecurity?.enabled : undefined
    const handleToggle = type === 'enhancer_design' ? (v: boolean) => setEnhancerDesign?.(prev => ({ ...prev, enabled: v })) : type === 'enhancer_func' ? (v: boolean) => setEnhancerFunc?.(prev => ({ ...prev, enabled: v })) : type === 'enhancer_security' ? (v: boolean) => setEnhancerSecurity?.(prev => ({ ...prev, enabled: v })) : undefined
    return (
      <div className="ml-3 shrink-0">
        <ConfigPanel
          selectedNode={selectedNode}
          config={selectedConfig}
          providers={providers}
          hasProviders={hasProviders}
          onUpdateProvider={handleUpdateProvider}
          onUpdateModel={handleUpdateModel}
          onApplyToAll={showApplyAll ? handleApplyToAll : undefined}
          showApplyAll={showApplyAll}
          onClose={() => setSelectedNode(null)}
          enabled={enhancerEnabled}
          onToggleEnabled={handleToggle}
        />
      </div>
    )
  }

  const showEnhancer = !!(enhancerDesign && setEnhancerDesign && enhancerFunc && setEnhancerFunc && enhancerSecurity && setEnhancerSecurity && enhancerSummarizer && setEnhancerSummarizer)

  // ---- Refs for SVG arrow positioning ----
  const containerRef = useRef<HTMLDivElement>(null)
  const codingRef = useRef<HTMLDivElement>(null)
  const finalCodeRef = useRef<HTMLDivElement>(null)
  const enhSummRef = useRef<HTMLDivElement>(null)
  const designRef = useRef<HTMLDivElement>(null)
  const funcRef = useRef<HTMLDivElement>(null)
  const securityRef = useRef<HTMLDivElement>(null)
  const [svgPaths, setSvgPaths] = useState<string[]>([])
  const [svgSize, setSvgSize] = useState({ w: 0, h: 0 })

  const calcPaths = useCallback(() => {
    const c = containerRef.current
    if (!c) return
    const coding = codingRef.current
    const fc = finalCodeRef.current
    const es = enhSummRef.current
    const d = designRef.current
    const f = funcRef.current
    const s = securityRef.current
    if (!coding || !fc || !es || !d || !f || !s) return

    const cr = c.getBoundingClientRect()
    setSvgSize({ w: c.scrollWidth, h: c.scrollHeight })

    // Helper: get element rect relative to container
    const rel = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      return {
        left: r.left - cr.left + c.scrollLeft,
        top: r.top - cr.top + c.scrollTop,
        right: r.right - cr.left + c.scrollLeft,
        bottom: r.bottom - cr.top + c.scrollTop,
        cx: r.left - cr.left + c.scrollLeft + r.width / 2,
        cy: r.top - cr.top + c.scrollTop + r.height / 2,
        w: r.width,
        h: r.height,
      }
    }

    const codingR = rel(coding)
    const fcR = rel(fc)
    const esR = rel(es)
    const dR = rel(d)
    const fR = rel(f)
    const sR = rel(s)

    const paths: string[] = []

    // Path 1: L-shape from ES left-center → left → up → Coding bottom-center
    // Start: left side of ES, vertically centered
    const p1sx = esR.left
    const p1sy = esR.cy
    // End: bottom center of Coding
    const p1ex = codingR.cx
    const p1ey = codingR.bottom
    // L: go left to align with Coding center X, then go up
    paths.push(`M ${p1sx} ${p1sy} L ${p1ex} ${p1sy} L ${p1ex} ${p1ey}`)

    // Path 2: From Final Code bottom-center → down → then split into 3 horizontals to D/F/S right-centers
    const p2sx = fcR.cx
    const p2sy = fcR.bottom
    // Go down to the Y level of Functionality (middle agent)
    const splitX = fcR.cx
    // 3 endpoints: right side of Design, Func, Security
    const targets = [dR, fR, sR]
    // Vertical trunk: from Final Code bottom to furthest Y needed
    const maxY = Math.max(dR.cy, fR.cy, sR.cy)
    const minY = Math.min(dR.cy, fR.cy, sR.cy)
    // Trunk goes from FC bottom to the full range
    paths.push(`M ${p2sx} ${p2sy} L ${p2sx} ${maxY}`)
    // 3 horizontal branches from trunk to each target's right side
    targets.forEach(t => {
      paths.push(`M ${splitX} ${t.cy} L ${t.right} ${t.cy}`)
    })

    setSvgPaths(paths)
  }, [])

  useEffect(() => {
    if (!showEnhancer) return
    // Delay to let layout settle
    const raf = requestAnimationFrame(() => {
      calcPaths()
    })
    const observer = new ResizeObserver(calcPaths)
    if (containerRef.current) observer.observe(containerRef.current)
    return () => { cancelAnimationFrame(raf); observer.disconnect() }
  }, [showEnhancer, coderConfigs.length, testerConfigs.length, calcPaths])

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <div ref={containerRef} className="rounded-xl border border-gray-700 bg-gray-900/50 overflow-x-auto relative" style={{ minHeight: 220 }}>

      {/* SVG overlay for arrows */}
      {showEnhancer && svgPaths.length > 0 && (
        <svg
          className="absolute top-0 left-0 pointer-events-none"
          width={svgSize.w}
          height={svgSize.h}
          style={{ zIndex: 10 }}
        >
          <defs>
            <marker id="arrow-blue" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(96,165,250)" fillOpacity="0.6" />
            </marker>
            <marker id="arrow-green" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="rgb(52,211,153)" fillOpacity="0.6" />
            </marker>
          </defs>
          {/* Path 0: ES → Coding (blue, dashed) */}
          {svgPaths[0] && (
            <path d={svgPaths[0]} fill="none" stroke="rgb(96,165,250)" strokeOpacity="0.5" strokeWidth="2" strokeDasharray="6 3" markerEnd="url(#arrow-blue)" />
          )}
          {/* Path 1: Final Code trunk (green, dashed) */}
          {svgPaths[1] && (
            <path d={svgPaths[1]} fill="none" stroke="rgb(52,211,153)" strokeOpacity="0.5" strokeWidth="2" strokeDasharray="6 3" />
          )}
          {/* Paths 2,3,4: horizontal branches to D/F/S (green, dashed, with arrows) */}
          {svgPaths.slice(2).map((p, i) => (
            <path key={i} d={p} fill="none" stroke="rgb(52,211,153)" strokeOpacity="0.5" strokeWidth="2" strokeDasharray="6 3" markerEnd="url(#arrow-green)" />
          ))}
        </svg>
      )}

      <div className="inline-block min-w-full p-5" onClick={(e) => { if (e.target === e.currentTarget) setSelectedNode(null) }}>

        {/* ── Main Pipeline Row ── */}
        <div className="flex items-center gap-0">
          <StaticNode icon={FileInput} label="Specification" gradient="from-slate-600 to-slate-700" onClick={onSpecificationClick} />
          <Connector />
          <div className="flex items-center shrink-0">
            <div ref={codingRef}>
              <AgentGroup title="Coding" type="coding" configs={coderConfigs} agentType="coder" selectedNode={selectedNode} onSelectNode={setSelectedNode} onAdd={addCoder} onRemove={removeCoder} />
            </div>
            {renderConfigPanel('coder')}
          </div>
          <Connector />
          <div className="flex items-center shrink-0">
            <AgentGroup title="Testing" type="testing" configs={testerConfigs} agentType="tester" selectedNode={selectedNode} onSelectNode={setSelectedNode} onAdd={addTester} onRemove={removeTester} />
            {renderConfigPanel('tester')}
          </div>
          <Connector />
          <div className="flex items-center shrink-0">
            <AgentCard type="summarizer" index={0} label="Summarizer" model={summarizerConfig.model} isSelected={selectedNode?.type === 'summarizer'} canRemove={false} onClick={() => setSelectedNode({ type: 'summarizer', index: 0 })} />
            {renderConfigPanel('summarizer')}
          </div>
          <Connector />
          <div className="flex items-center shrink-0">
            <AgentCard type="finalizer" index={0} label="Finalizer" model={finalizerConfig.model} isSelected={selectedNode?.type === 'finalizer'} canRemove={false} onClick={() => setSelectedNode({ type: 'finalizer', index: 0 })} />
            {renderConfigPanel('finalizer')}
          </div>
          <Connector />
          <div ref={finalCodeRef}>
            <StaticNode icon={FileOutput} label="Final Code" gradient="from-green-600 to-emerald-700" />
          </div>
        </div>

        {/* ── Enhancement Loop ── */}
        {showEnhancer && (
          <div className="mt-6">
            {/* Centered separator */}
            <div className="flex items-center gap-3 mb-4">
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-purple-500/30 to-transparent" />
              <div className="flex items-center gap-2 px-3 py-1 rounded-full border border-purple-500/20 bg-purple-500/5">
                <Sparkles className="w-3 h-3 text-purple-400" />
                <span className="text-[10px] font-semibold uppercase tracking-widest text-purple-400">Enhancement Loop</span>
              </div>
              <div className="h-px flex-1 bg-gradient-to-r from-transparent via-purple-500/30 to-transparent" />
            </div>

            {/* Centered enhancer row: [ES] ← [EB box] */}
            <div className="flex items-center justify-center gap-0">
              {/* Enh. Summarizer */}
              <div className="flex items-center shrink-0">
                <div ref={enhSummRef}>
                  <AgentCard type="enhancer_summary" index={0} label="Enh. Summarizer" model={enhancerSummarizer!.model} isSelected={selectedNode?.type === 'enhancer_summary'} canRemove={false} onClick={() => setSelectedNode({ type: 'enhancer_summary', index: 0 })} />
                </div>
                {renderConfigPanel('enhancer_summary')}
              </div>

              <ReverseConnector />

              {/* Enhancement Agents box */}
              <div className="shrink-0 rounded-xl border-2 border-dashed border-purple-500/25 bg-purple-500/5 p-3">
                <div className="space-y-2">
                  <div ref={designRef} className={`transition-opacity ${!enhancerDesign!.enabled ? 'opacity-40' : ''}`}>
                    <AgentCard type="enhancer_design" index={0} label="Design" model={enhancerDesign!.enabled ? enhancerDesign!.model : 'disabled'} isSelected={selectedNode?.type === 'enhancer_design'} canRemove={false} onClick={() => setSelectedNode({ type: 'enhancer_design', index: 0 })} />
                  </div>
                  <div ref={funcRef} className={`transition-opacity ${!enhancerFunc!.enabled ? 'opacity-40' : ''}`}>
                    <AgentCard type="enhancer_func" index={0} label="Functionality" model={enhancerFunc!.enabled ? enhancerFunc!.model : 'disabled'} isSelected={selectedNode?.type === 'enhancer_func'} canRemove={false} onClick={() => setSelectedNode({ type: 'enhancer_func', index: 0 })} />
                  </div>
                  <div ref={securityRef} className={`transition-opacity ${!enhancerSecurity!.enabled ? 'opacity-40' : ''}`}>
                    <AgentCard type="enhancer_security" index={0} label="Security" model={enhancerSecurity!.enabled ? enhancerSecurity!.model : 'disabled'} isSelected={selectedNode?.type === 'enhancer_security'} canRemove={false} onClick={() => setSelectedNode({ type: 'enhancer_security', index: 0 })} />
                  </div>
                </div>
              </div>

              {/* Config panels for enhancer agents (outside box) */}
              {renderConfigPanel('enhancer_design')}
              {renderConfigPanel('enhancer_func')}
              {renderConfigPanel('enhancer_security')}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
