/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef } from 'react'
import {
  X,
  Code2,
  FileText,
  AlertTriangle,
  AlertCircle,
  Info,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  Download,
  Clock,
  CheckCircle2,
  Loader2,
  Eye,
  List,
  GitBranch,
  FolderOpen,
  ExternalLink,
  Archive,
  FilePlus,
  FileX,
  FileEdit,
  Palette,
  Cog,
  Shield,
  Sparkles,
  Play,
  FileCode,
  Globe,
} from 'lucide-react'
import notify from '../common/StyledToast'
import ResultActionsExtras from '../common/ResultActionsExtras'
// Улучшатели#3 wave 2 #5 — shared syntax-highlighted code viewer.
import CodeBlock from '../common/CodeBlock'
import {
  getCodeVersions,
  getAudits,
  getSummaries,
  getFinalResult,
  downloadResultZip,
  createPullRequest,
  getEnhancementSuggestions,
  runFinalCode,
  type CodeVersionResponse,
  type AuditResponse,
  type SummaryAuditResponse,
  type FinalResultResponse,
  type ExecutionResult,
} from '../../services/api'
import type { EnhancementSuggestion } from '../../types'
import { useFetchData } from '../../hooks/useFetchData'

interface DetailPanelProps {
  nodeId: string
  nodeType: string
  agentIndex?: number
  sessionId: string
  title: string
  llmModel?: string
  language: string
  currentIteration: number
  maxIterations: number
  sessionStatus: string
  specification?: string
  onClose: () => void
  onRunCodeVersion?: (versionId: string, title: string) => void
  /** Улучшатели#3 wave 2 #2 — current node runtime status (error/timeout drives Retry affordance). */
  nodeStatus?: string
  /** Улучшатели#3 wave 2 #2 — invoked when the user clicks "Retry agent". */
  onRetryAgent?: (agentType: string, agentIndex?: number) => void
  /** VR-35 — run the finalized code from the Output node panel. */
  onRunCode?: () => void
  /** VR-35 — true while the code is currently executing (disables button + spinner). */
  isRunningCode?: boolean
}

// Code viewer modal
function CodeViewerModal({
  code, 
  title, 
  language,
  onClose 
}: { 
  code: string
  title: string
  language: string
  onClose: () => void 
}) {
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => { clearTimeout(copyTimerRef.current) }, [])

  const handleCopy = () => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    notify.success('Copied to clipboard')
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const ext = language === 'python' ? 'py' : language === 'javascript' ? 'js' : language === 'typescript' ? 'ts' : 'txt'
    const blob = new Blob([code], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `code.${ext}`
    a.click()
    URL.revokeObjectURL(url)
    notify.success('File downloaded')
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
    >
      <div 
        className="bg-gray-800 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-700 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm transition-colors"
            >
              <Download className="w-4 h-4" />
              Download
            </button>
            <button onClick={onClose} className="p-2 hover:bg-gray-700 rounded-lg">
              <X className="w-5 h-5 text-gray-300" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4 min-h-0">
          {/* Улучшатели#3 wave 2 #5 — syntax-highlighted via CodeBlock. */}
          <CodeBlock code={code} language={language} maxHeightClass="max-h-full" showCopy={false} />
        </div>
      </div>
    </div>
  )
}

// Audit viewer modal
function AuditViewerModal({ 
  audit, 
  onClose 
}: { 
  audit: AuditResponse | SummaryAuditResponse
  onClose: () => void 
}) {
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => { clearTimeout(copyTimerRef.current) }, [])
  const content = 'audit_content' in audit ? audit.audit_content : audit.summary_content

  const handleCopy = () => {
    navigator.clipboard.writeText(content)
    setCopied(true)
    notify.success('Copied to clipboard')
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit_iter${audit.iteration}.txt`
    a.click()
    URL.revokeObjectURL(url)
    notify.success('File downloaded')
  }

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Audit iteration ${audit.iteration}`}
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
    >
      <div 
        className="bg-gray-800 rounded-xl w-full max-w-4xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-700 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-white">
            Audit - Iteration {audit.iteration}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
            >
              {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={handleDownload}
              className="flex items-center gap-1 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm transition-colors"
            >
              <Download className="w-4 h-4" />
              Download
            </button>
            <button onClick={onClose} className="p-2 hover:bg-gray-700 rounded-lg">
              <X className="w-5 h-5 text-gray-300" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4 min-h-0">
          {'issues' in audit && audit.issues && (
            <div className="mb-4 p-3 bg-gray-700/50 rounded-lg">
              <div className="text-sm font-medium text-gray-300">
                Scores: Spec {audit.specification_compliance}/10 | Correctness {audit.correctness}/10 | Quality {audit.quality}/10
              </div>
            </div>
          )}
          <pre className="bg-gray-900 p-4 rounded-lg text-sm text-gray-300 font-mono whitespace-pre-wrap overflow-x-auto">
            {content}
          </pre>
        </div>
      </div>
    </div>
  )
}

// Diff viewer modal — side-by-side comparison of two code versions
function DiffViewerModal({
  previous,
  current,
  language,
  onClose,
}: {
  previous: { code: string; label: string }
  current: { code: string; label: string }
  language: string
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useState<'side-by-side' | 'previous' | 'current'>('side-by-side')

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Compare code versions"
      onClick={onClose}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}
    >
      <div
        className="bg-gray-800 rounded-xl w-full max-w-7xl max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-700 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-white flex items-center gap-2">
            <FileCode className="w-5 h-5 text-indigo-400" />
            Compare Versions
          </h3>
          <div className="flex items-center gap-2">
            <div className="flex bg-gray-700 rounded-lg p-0.5">
              {(['side-by-side', 'previous', 'current'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                    activeTab === tab
                      ? 'bg-indigo-600 text-white'
                      : 'text-gray-300 hover:text-gray-200'
                  }`}
                >
                  {tab === 'side-by-side' ? 'Side by Side' : tab === 'previous' ? 'Previous' : 'Current'}
                </button>
              ))}
            </div>
            <button onClick={onClose} className="p-2 hover:bg-gray-700 rounded-lg">
              <X className="w-5 h-5 text-gray-300" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4 min-h-0">
          {/* Улучшатели#3 wave 2 #5 — diff view uses CodeBlock with variant
              tinting so the red/green columns keep their colour cues. */}
          {activeTab === 'side-by-side' ? (
            <div className="grid grid-cols-2 gap-3 h-full">
              <div>
                <div className="text-xs font-medium text-red-400 mb-2 flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-red-500" />
                  {previous.label}
                </div>
                <CodeBlock
                  code={previous.code}
                  language={language}
                  variant="previous"
                  maxHeightClass="max-h-[70vh]"
                />
              </div>
              <div>
                <div className="text-xs font-medium text-green-400 mb-2 flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500" />
                  {current.label}
                </div>
                <CodeBlock
                  code={current.code}
                  language={language}
                  variant="current"
                  maxHeightClass="max-h-[70vh]"
                />
              </div>
            </div>
          ) : (
            <div>
              <div className={`text-xs font-medium mb-2 flex items-center gap-1 ${
                activeTab === 'previous' ? 'text-red-400' : 'text-green-400'
              }`}>
                <span className={`inline-block w-2 h-2 rounded-full ${
                  activeTab === 'previous' ? 'bg-red-500' : 'bg-green-500'
                }`} />
                {activeTab === 'previous' ? previous.label : current.label}
              </div>
              <CodeBlock
                code={activeTab === 'previous' ? previous.code : current.code}
                language={language}
                variant={activeTab === 'previous' ? 'previous' : 'current'}
                maxHeightClass="max-h-[75vh]"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Coder panel - shows all code versions
function CoderPanel({
  sessionId,
  coderIndex,
  language,
  currentIteration,
  maxIterations,
  sessionStatus,
  onRunCodeVersion,
}: {
  sessionId: string
  coderIndex: number
  language: string
  currentIteration: number
  maxIterations: number
  sessionStatus: string
  onRunCodeVersion?: (versionId: string, title: string) => void
}) {
  const [versions, setVersions] = useState<CodeVersionResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedVersion, setSelectedVersion] = useState<CodeVersionResponse | null>(null)
  const [diffPair, setDiffPair] = useState<{ previous: CodeVersionResponse; current: CodeVersionResponse } | null>(null)
  const loadSeqRef = useRef(0)

  useEffect(() => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    getCodeVersions(sessionId, undefined, coderIndex)
      .then((data) => {
        if (seq !== loadSeqRef.current) return // stale — discard
        setVersions(data)
      })
      .catch((err) => {
        if (seq !== loadSeqRef.current) return
        console.error('Failed to load code versions:', err)
      })
      .finally(() => {
        if (seq === loadSeqRef.current) setLoading(false)
      })
  }, [sessionId, coderIndex])

  // Determine stop reason
  const getStopReason = () => {
    if (sessionStatus !== 'completed') return null
    if (currentIteration >= maxIterations) {
      return { type: 'max_iterations', text: 'Stopped: Max iterations reached', color: 'text-yellow-400', bg: 'bg-yellow-500/20 border-yellow-500/50' }
    }
    return { type: 'no_issues', text: 'Stopped: No critical/serious issues', color: 'text-green-400', bg: 'bg-green-500/20 border-green-500/50' }
  }

  const stopReason = getStopReason()

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
      </div>
    )
  }

  return (
    <div>
      {/* Stop reason banner */}
      {stopReason && (
        <div className={`mb-4 p-3 rounded-lg border ${stopReason.bg}`}>
          <div className="flex items-center gap-2">
            {stopReason.type === 'max_iterations' ? (
              <Clock className="w-4 h-4 text-yellow-400" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-green-400" />
            )}
            <span className={`text-sm font-medium ${stopReason.color}`}>{stopReason.text}</span>
          </div>
        </div>
      )}

      <h4 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
        <List className="w-4 h-4" />
        Code Versions ({versions.length})
      </h4>
      
      {versions.length === 0 ? (
        <div className="text-gray-400 text-sm">No code versions yet</div>
      ) : (
        <div className="space-y-2">
          {versions.map((version) => {
            // Find the previous version (sorted by iteration ascending)
            const sortedVersions = [...versions].sort((a, b) => a.iteration - b.iteration)
            const sortedIdx = sortedVersions.findIndex(v => v.id === version.id)
            const prevVersion = sortedIdx > 0 ? sortedVersions[sortedIdx - 1] : null

            return (
              <div
                key={version.id}
                className="p-3 bg-gray-700/50 hover:bg-gray-700 rounded-lg cursor-pointer transition-colors border border-gray-600"
                onClick={() => setSelectedVersion(version)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Code2 className="w-4 h-4 text-blue-400" />
                    <span className="text-sm font-medium text-white">
                      Iteration {version.iteration}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-300">
                      {version.code_content?.split('\n').length || 0} lines
                    </span>
                    {prevVersion && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          setDiffPair({ previous: prevVersion, current: version })
                        }}
                        className="p-1 text-gray-300 hover:text-indigo-400 hover:bg-indigo-500/10 rounded transition-colors"
                        title="Compare with previous iteration"
                      >
                        <FileCode className="w-4 h-4" />
                      </button>
                    )}
                    {onRunCodeVersion && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation()
                          onRunCodeVersion(version.id, `Coder ${coderIndex + 1} — Iteration ${version.iteration}`)
                        }}
                        className="p-1 text-gray-300 hover:text-emerald-400 hover:bg-emerald-500/10 rounded transition-colors"
                        title="Run this code"
                      >
                        <Play className="w-4 h-4" />
                      </button>
                    )}
                    <Eye className="w-4 h-4 text-gray-300" />
                  </div>
                </div>
                <div className="mt-1 text-xs text-gray-400">
                  {new Date(version.created_at).toLocaleString()}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {selectedVersion && (
        <CodeViewerModal
          code={selectedVersion.code_content}
          title={`Coder ${coderIndex + 1} - Iteration ${selectedVersion.iteration}`}
          language={language}
          onClose={() => setSelectedVersion(null)}
        />
      )}

      {diffPair && (
        <DiffViewerModal
          previous={{
            code: diffPair.previous.code_content,
            label: `Iteration ${diffPair.previous.iteration}`,
          }}
          current={{
            code: diffPair.current.code_content,
            label: `Iteration ${diffPair.current.iteration}`,
          }}
          language={language}
          onClose={() => setDiffPair(null)}
        />
      )}
    </div>
  )
}

// Tester panel - shows audit matrix
function TesterPanel({ 
  sessionId, 
  testerIndex,
}: { 
  sessionId: string
  testerIndex: number
}) {
  const [audits, setAudits] = useState<AuditResponse[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedAudit, setSelectedAudit] = useState<AuditResponse | null>(null)
  const loadSeqRef = useRef(0)

  useEffect(() => {
    const seq = ++loadSeqRef.current
    setLoading(true)
    getAudits(sessionId, undefined, undefined, testerIndex)
      .then((data) => {
        if (seq !== loadSeqRef.current) return
        setAudits(data)
      })
      .catch((err) => {
        if (seq !== loadSeqRef.current) return
        console.error('Failed to load audits:', err)
      })
      .finally(() => {
        if (seq === loadSeqRef.current) setLoading(false)
      })
  }, [sessionId, testerIndex])

  // Group audits by iteration (newest first)
  const groupedAudits: Record<number, AuditResponse[]> = {}
  audits.forEach(audit => {
    if (!groupedAudits[audit.iteration]) {
      groupedAudits[audit.iteration] = []
    }
    groupedAudits[audit.iteration].push(audit)
  })

  const iterations = Object.keys(groupedAudits).map(Number).sort((a, b) => b - a)

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
      </div>
    )
  }

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
        <AlertTriangle className="w-4 h-4" />
        Audits by Iteration ({audits.length})
      </h4>
      
      {audits.length === 0 ? (
        <div className="text-gray-400 text-sm">No audits yet</div>
      ) : (
        <div className="space-y-4">
          {iterations.map((iteration) => (
            <div key={iteration}>
              <div className="text-xs font-medium text-gray-300 mb-2">Iteration {iteration}</div>
              <div className="space-y-2">
                {groupedAudits[iteration].map((audit) => (
                  <div 
                    key={audit.id}
                    className="p-3 bg-gray-700/50 hover:bg-gray-700 rounded-lg cursor-pointer transition-colors border border-gray-600"
                    onClick={() => setSelectedAudit(audit)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-400" />
                        <span className="text-sm text-white">
                          {audit.issues?.length || 0} issues found
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs text-gray-300">
                        <span>Spec: {audit.specification_compliance}/10</span>
                        <span>Corr: {audit.correctness}/10</span>
                        <span>Qual: {audit.quality}/10</span>
                      </div>
                    </div>
                    {audit.overall_assessment && (
                      <div className="mt-1 text-xs text-gray-300 truncate">
                        {audit.overall_assessment}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedAudit && (
        <AuditViewerModal
          audit={selectedAudit}
          onClose={() => setSelectedAudit(null)}
        />
      )}
    </div>
  )
}

// Summarizer panel - shows summary matrix
function SummarizerPanel({
  sessionId,
}: {
  sessionId: string
}) {
  const { data: summariesData, loading } = useFetchData<SummaryAuditResponse[]>(
    () => getSummaries(sessionId),
    [sessionId],
    { onError: (err) => console.error('Failed to load summaries:', err) }
  )
  const summaries = summariesData ?? []
  const [selectedSummary, setSelectedSummary] = useState<SummaryAuditResponse | null>(null)

  // Group by coder
  const byCoderAndIteration: Record<number, SummaryAuditResponse[]> = {}
  summaries.forEach(s => {
    if (!byCoderAndIteration[s.coder_index]) {
      byCoderAndIteration[s.coder_index] = []
    }
    byCoderAndIteration[s.coder_index].push(s)
  })

  // Sort each coder's summaries by iteration desc
  Object.keys(byCoderAndIteration).forEach(key => {
    byCoderAndIteration[Number(key)].sort((a, b) => b.iteration - a.iteration)
  })

  const coderIndices = Object.keys(byCoderAndIteration).map(Number).sort()

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
      </div>
    )
  }

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
        <FileText className="w-4 h-4" />
        Summary Audits ({summaries.length})
      </h4>
      
      {summaries.length === 0 ? (
        <div className="text-gray-400 text-sm">No summaries yet</div>
      ) : (
        <div className="space-y-4">
          {coderIndices.map((coderIndex) => (
            <div key={coderIndex}>
              <div className="text-xs font-medium text-gray-300 mb-2">Coder {coderIndex + 1}</div>
              <div className="space-y-2">
                {byCoderAndIteration[coderIndex].map((summary) => {
                  const totalIssues = 
                    (summary.critical_issues?.length || 0) +
                    (summary.serious_issues?.length || 0) +
                    (summary.minor_issues?.length || 0)
                  
                  return (
                    <div 
                      key={summary.id}
                      className="p-3 bg-gray-700/50 hover:bg-gray-700 rounded-lg cursor-pointer transition-colors border border-gray-600"
                      onClick={() => setSelectedSummary(summary)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <FileText className="w-4 h-4 text-purple-400" />
                          <span className="text-sm text-white">
                            Iteration {summary.iteration}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 text-xs">
                          {(summary.critical_issues?.length || 0) > 0 && (
                            <span className="text-red-400">{summary.critical_issues.length} crit</span>
                          )}
                          {(summary.serious_issues?.length || 0) > 0 && (
                            <span className="text-orange-400">{summary.serious_issues.length} ser</span>
                          )}
                          {(summary.minor_issues?.length || 0) > 0 && (
                            <span className="text-yellow-400">{summary.minor_issues.length} min</span>
                          )}
                          {totalIssues === 0 && (
                            <span className="text-green-400">No issues</span>
                          )}
                        </div>
                      </div>
                      {summary.consensus_notes && (
                        <div className="mt-1 text-xs text-gray-300 truncate">
                          {summary.consensus_notes}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedSummary && (
        <AuditViewerModal
          audit={selectedSummary}
          onClose={() => setSelectedSummary(null)}
        />
      )}
    </div>
  )
}

// Finalizer panel - shows final code
function FinalizerPanel({ 
  sessionId,
  language,
}: { 
  sessionId: string
  language: string
}) {
  const [result, setResult] = useState<FinalResultResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [showCode, setShowCode] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => { clearTimeout(copyTimerRef.current) }, [])
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [showPRModal, setShowPRModal] = useState(false)
  const [prToken, setPRToken] = useState('')
  const [prBranch, setPRBranch] = useState('codeforge/improvements')
  const [prTitle, setPRTitle] = useState('CodeForge: Code Improvements')
  const [prLoading, setPRLoading] = useState(false)
  const [prResult, setPRResult] = useState<{ pr_url: string; pr_number: number } | null>(null)
  const [downloadingZip, setDownloadingZip] = useState(false)

  useEffect(() => {
    loadResult()
  }, [sessionId])

  async function loadResult() {
    try {
      const data = await getFinalResult(sessionId)
      setResult(data)
    } catch (err) {
      console.error('Failed to load final result:', err)
    } finally {
      setLoading(false)
    }
  }

  const hasFileStructure = result?.file_structure && Object.keys(result.file_structure).length > 0

  const handleCopy = async () => {
    if (result?.final_code) {
      try {
        await navigator.clipboard.writeText(result.final_code)
        setCopied(true)
        notify.success('Copied to clipboard')
        copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
      } catch {
        notify.error('Failed to copy to clipboard')
      }
    }
  }

  const handleDownloadZip = async () => {
    setDownloadingZip(true)
    try {
      const blob = await downloadResultZip(sessionId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `codeforge-result.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      notify.success('ZIP downloaded')
    } catch (err) {
      console.error(err)
      notify.error('Failed to download ZIP')
    } finally {
      setDownloadingZip(false)
    }
  }

  const handleDownloadFile = () => {
    if (result?.final_code) {
      const ext = language === 'python' ? 'py' : language === 'javascript' ? 'js' : language === 'typescript' ? 'ts' : 'txt'
      const blob = new Blob([result.final_code], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `final_code.${ext}`
      a.click()
      URL.revokeObjectURL(url)
      notify.success('File downloaded')
    }
  }

  const handleExportHtml = () => {
    if (!result?.final_code) return
    const isHtml = result.final_code.trim().startsWith('<!DOCTYPE') || result.final_code.trim().startsWith('<html')
    const html = isHtml ? result.final_code : `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>CodeForge Result</title>
<style>body{font-family:monospace;background:#1a1a2e;color:#e0e0e0;padding:2rem;margin:0}
pre{background:#16213e;padding:1.5rem;border-radius:8px;overflow-x:auto;line-height:1.5}</style>
</head><body><h1>CodeForge Result</h1><pre>${result.final_code.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></body></html>`
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'codeforge-result.html'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    notify.success('HTML exported')
  }

  const handleCreatePR = async () => {
    if (!prToken.trim()) {
      notify.error('GitHub token is required')
      return
    }
    setPRLoading(true)
    try {
      const res = await createPullRequest({
        session_id: sessionId,
        token: prToken,
        branch_name: prBranch,
        pr_title: prTitle,
      })
      setPRResult({ pr_url: res.pr_url, pr_number: res.pr_number })
      notify.success(`PR #${res.pr_number} created!`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to create PR'
      notify.error(msg)
    } finally {
      setPRLoading(false)
    }
  }

  const toggleFile = (path: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
      </div>
    )
  }

  if (!result) {
    return (
      <div className="text-gray-400 text-sm">No final result yet</div>
    )
  }

  // Count file changes
  const fileEntries = result.file_structure ? Object.entries(result.file_structure) : []
  const modifiedCount = fileEntries.filter(([, v]) => v.action === 'modified').length
  const createdCount = fileEntries.filter(([, v]) => v.action === 'created').length
  const deletedCount = fileEntries.filter(([, v]) => v.action === 'deleted').length

  return (
    <div>
      <div className="mb-4 p-3 bg-green-500/20 border border-green-500/50 rounded-lg">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <span className="text-sm font-medium text-green-400">
            Selected Coder {result.selected_coder_index + 1}
          </span>
        </div>
        {result.selection_reasoning && (
          <p className="mt-2 text-xs text-gray-300">{result.selection_reasoning}</p>
        )}
      </div>

      <div className="mb-4 grid grid-cols-3 gap-3">
        <div className="bg-gray-700/50 rounded-lg p-3">
          <div className="text-xs text-gray-300">Iterations</div>
          <div className="text-lg font-semibold text-white">{result.total_iterations || 1}</div>
        </div>
        <div className="bg-gray-700/50 rounded-lg p-3">
          <div className="text-xs text-gray-300">Tokens</div>
          <div className="text-lg font-semibold text-white">{(result.total_tokens || 0).toLocaleString()}</div>
        </div>
        <div className="bg-gray-700/50 rounded-lg p-3">
          <div className="text-xs text-gray-300">Cost</div>
          <div className="text-lg font-semibold text-white">${(result.total_cost_usd || 0).toFixed(4)}</div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={handleCopy}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
        >
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copied' : 'Copy Code'}
        </button>
        <button
          onClick={handleDownloadZip}
          disabled={downloadingZip}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded-lg text-sm transition-colors"
        >
          {downloadingZip ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
          Download ZIP
        </button>
        <button
          onClick={handleExportHtml}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-lg text-sm transition-colors"
        >
          <Globe className="w-4 h-4" />
          Export HTML
        </button>
        {hasFileStructure && (
          <button
            onClick={() => setShowPRModal(!showPRModal)}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm transition-colors"
          >
            <GitBranch className="w-4 h-4" />
            Create PR
          </button>
        )}
      </div>

      <ResultActionsExtras sessionId={sessionId} language={language} />

      {/* PR Creation Modal */}
      {showPRModal && (
        <div className="mb-4 p-4 bg-purple-900/30 border border-purple-500/50 rounded-lg">
          {prResult ? (
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
              <span className="text-sm text-green-400">PR #{prResult.pr_number} created</span>
              <a
                href={prResult.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1 text-sm text-purple-400 hover:text-purple-300"
              >
                Open on GitHub <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          ) : (
            <>
              <h4 className="text-sm font-medium text-purple-300 mb-3 flex items-center gap-2">
                <GitBranch className="w-4 h-4" />
                Create Pull Request on GitHub
              </h4>
              <div className="space-y-2">
                <input
                  type="password"
                  value={prToken}
                  onChange={(e) => setPRToken(e.target.value)}
                  placeholder="GitHub Personal Access Token"
                  className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={prBranch}
                    onChange={(e) => setPRBranch(e.target.value)}
                    placeholder="Branch name"
                    className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                  <input
                    type="text"
                    value={prTitle}
                    onChange={(e) => setPRTitle(e.target.value)}
                    placeholder="PR title"
                    className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                  />
                </div>
                <button
                  onClick={handleCreatePR}
                  disabled={prLoading || !prToken.trim()}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded text-sm transition-colors"
                >
                  {prLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
                  {prLoading ? 'Creating PR...' : 'Create Pull Request'}
                </button>
                <p className="text-xs text-gray-400">
                  Token needs <code>repo</code> scope. Never stored — used once for PR creation.
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {/* File Structure (repo mode) */}
      {hasFileStructure && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <FolderOpen className="w-4 h-4 text-purple-400" />
            <span className="text-sm font-medium text-white">Modified Files</span>
            <span className="text-xs text-gray-400">
              {modifiedCount > 0 && `${modifiedCount} modified`}
              {createdCount > 0 && `${modifiedCount > 0 ? ', ' : ''}${createdCount} created`}
              {deletedCount > 0 && `${(modifiedCount + createdCount) > 0 ? ', ' : ''}${deletedCount} deleted`}
            </span>
          </div>
          <div className="space-y-1">
            {fileEntries.map(([path, info]) => (
              <div key={path}>
                <button
                  onClick={() => info.content ? toggleFile(path) : undefined}
                  className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-700/50 hover:bg-gray-700 rounded text-sm transition-colors"
                >
                  {info.action === 'deleted' ? (
                    <X className="w-3 h-3 text-red-400 shrink-0" />
                  ) : info.action === 'created' ? (
                    <Check className="w-3 h-3 text-green-400 shrink-0" />
                  ) : (
                    <Code2 className="w-3 h-3 text-blue-400 shrink-0" />
                  )}
                  <span className={`truncate text-left flex-1 ${info.action === 'deleted' ? 'text-red-400 line-through' : 'text-gray-200'}`}>
                    {path}
                  </span>
                  <span className={`text-xs shrink-0 ${
                    info.action === 'deleted' ? 'text-red-500' : 
                    info.action === 'created' ? 'text-green-500' : 'text-blue-500'
                  }`}>
                    {info.action}
                  </span>
                  {info.content && (
                    expandedFiles.has(path) ? 
                      <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" /> : 
                      <ChevronRight className="w-3 h-3 text-gray-400 shrink-0" />
                  )}
                </button>
                {expandedFiles.has(path) && info.content && (
                  <pre className="mt-1 ml-5 bg-gray-900 p-3 rounded text-xs text-gray-300 font-mono whitespace-pre-wrap overflow-x-auto max-h-64">
                    {info.content}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Code View (standard mode or fallback) */}
      <div>
        <button
          onClick={() => setShowCode(!showCode)}
          className="w-full flex items-center justify-between p-3 bg-gray-700/50 hover:bg-gray-700 rounded-lg transition-colors"
        >
          <div className="flex items-center gap-2">
            <Code2 className="w-4 h-4 text-green-400" />
            <span className="text-sm text-white">{hasFileStructure ? 'Combined Code' : 'Final Code'}</span>
            <span className="text-xs text-gray-300">
              ({result.final_code?.split('\n').length || 0} lines)
            </span>
          </div>
          {showCode ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        {showCode && (
          /* Улучшатели#3 wave 2 #5 — syntax-highlighted code. */
          <div className="mt-2">
            <CodeBlock
              code={result.final_code || ''}
              language={language}
              maxHeightClass="max-h-96"
            />
          </div>
        )}
      </div>

      {result.readme_content && (
        <div className="mt-4">
          <h4 className="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
            <FileText className="w-4 h-4" />
            README
          </h4>
          <div className="bg-gray-900 p-4 rounded-lg text-sm text-gray-300 whitespace-pre-wrap max-h-64 overflow-auto">
            {result.readme_content}
          </div>
        </div>
      )}
    </div>
  )
}

// Specification panel - shows the task specification
function SpecificationPanel({ 
  specification,
}: { 
  specification: string
}) {
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => { clearTimeout(copyTimerRef.current) }, [])

  const handleCopy = () => {
    navigator.clipboard.writeText(specification)
    setCopied(true)
    notify.success('Copied to clipboard')
    copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const blob = new Blob([specification], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'specification.txt'
    a.click()
    URL.revokeObjectURL(url)
    notify.success('File downloaded')
  }

  return (
    <div>
      <h4 className="text-sm font-medium text-gray-300 mb-3 flex items-center gap-2">
        <FileText className="w-4 h-4" />
        Task Specification
      </h4>

      <div className="flex items-center gap-2 mb-3">
        <button
          onClick={handleCopy}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
        >
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          onClick={handleDownload}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm transition-colors"
        >
          <Download className="w-4 h-4" />
          Download
        </button>
      </div>

      <div className="bg-gray-900 p-4 rounded-lg text-sm text-gray-300 whitespace-pre-wrap max-h-[60vh] overflow-auto">
        {specification}
      </div>
    </div>
  )
}

// REPLPreview - runs the final code via the existing execution endpoint
// and shows stdout / stderr / exit_code / execution_time in a console-styled panel.
// Useful especially for Python where we can't render the result in an iframe.
function REPLPreview({ sessionId, language }: { sessionId: string; language: string }) {
  const [output, setOutput] = useState<
    | (Partial<ExecutionResult> & { error?: string })
    | null
  >(null)
  const [running, setRunning] = useState(false)

  const handleRun = async () => {
    setRunning(true)
    setOutput(null)
    try {
      const result = await runFinalCode(sessionId)
      setOutput(result)
    } catch (err) {
      setOutput({ error: err instanceof Error ? err.message : String(err) })
    } finally {
      setRunning(false)
    }
  }

  const isPython = language === 'python'

  return (
    <div className="mt-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Play className="w-4 h-4 text-green-400" />
          <span className="text-sm font-medium text-gray-200">Run Output</span>
          {isPython && (
            <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-green-500/15 text-green-300 border border-green-500/30">
              Python REPL
            </span>
          )}
        </div>
        <button
          onClick={handleRun}
          disabled={running}
          className="flex items-center gap-2 px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg text-sm text-white transition-colors"
        >
          {running ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Running...
            </>
          ) : (
            <>
              <Play className="w-4 h-4" />
              {/* КАО#VR-35 — disambiguate Run Code labels (REPL vs Final):
                  this button feeds the inline stdout/stderr console below,
                  the OutputPanel "Run Code" launches the full execution UI. */}
              Run in REPL
            </>
          )}
        </button>
      </div>

      {output && (
        <div className="bg-black border border-green-700/60 rounded-lg p-4 font-mono text-sm">
          {output.stdout && (
            <pre className="text-green-400 whitespace-pre-wrap break-words">{output.stdout}</pre>
          )}
          {output.stderr && (
            <pre className="text-red-400 whitespace-pre-wrap break-words">{output.stderr}</pre>
          )}
          {output.error && (
            <pre className="text-red-400 whitespace-pre-wrap break-words">{output.error}</pre>
          )}
          {!output.stdout && !output.stderr && !output.error && (
            <pre className="text-gray-500 italic">(no output)</pre>
          )}
          <div className="text-xs text-gray-400 mt-2 border-t border-gray-700 pt-2 flex flex-wrap gap-x-4 gap-y-1">
            {output.exit_code !== undefined && <span>exit_code: <span className={output.exit_code === 0 ? 'text-green-400' : 'text-red-400'}>{output.exit_code}</span></span>}
            {output.execution_time_ms !== undefined && <span>{output.execution_time_ms}ms</span>}
            {output.success !== undefined && <span>success: {String(output.success)}</span>}
          </div>
        </div>
      )}
    </div>
  )
}

// Output panel - shows final code result
function OutputPanel({
  sessionId,
  language,
  onRunCode,
  isRunningCode,
}: {
  sessionId: string
  language: string
  /** VR-35 — invoked when the user clicks Run Code from inside the Final Code panel. */
  onRunCode?: () => void
  /** VR-35 — true while code is currently executing. */
  isRunningCode?: boolean
}) {
  const [result, setResult] = useState<FinalResultResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => () => { clearTimeout(copyTimerRef.current) }, [])
  const [showPRModal, setShowPRModal] = useState(false)
  const [prToken, setPRToken] = useState('')
  const [prBranch, setPRBranch] = useState('codeforge/improvements')
  const [prTitle, setPRTitle] = useState('CodeForge: Code Improvements')
  const [prLoading, setPRLoading] = useState(false)
  const [prResult, setPRResult] = useState<{ pr_url: string; pr_number: number } | null>(null)

  useEffect(() => {
    loadResult()
  }, [sessionId])

  async function loadResult() {
    try {
      const data = await getFinalResult(sessionId)
      setResult(data)
    } catch (err) {
      console.error('Failed to load final result:', err)
    } finally {
      setLoading(false)
    }
  }

  const hasFileStructure = result?.file_structure && Object.keys(result.file_structure).length > 0

  const handleCopy = async () => {
    if (result?.final_code) {
      try {
        await navigator.clipboard.writeText(result.final_code)
        setCopied(true)
        notify.success('Copied to clipboard')
        copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
      } catch {
        notify.error('Failed to copy to clipboard')
      }
    }
  }

  const handleDownload = async () => {
    try {
      const blob = await downloadResultZip(sessionId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `codeforge-result.zip`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      notify.success('ZIP downloaded')
    } catch (err) {
      // Fallback to single file download — notify user about degraded result
      notify.warning('ZIP download failed, falling back to single file')
      if (result?.final_code) {
        const ext = language === 'python' ? 'py' : language === 'javascript' ? 'js' : language === 'typescript' ? 'ts' : 'txt'
        const blob = new Blob([result.final_code], { type: 'text/plain' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `final_code.${ext}`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
        notify.success('File downloaded')
      }
    }
  }

  const handleExportHtml = () => {
    if (!result?.final_code) return
    const isHtml = result.final_code.trim().startsWith('<!DOCTYPE') || result.final_code.trim().startsWith('<html')
    const html = isHtml ? result.final_code : `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>CodeForge Result</title>
<style>body{font-family:monospace;background:#1a1a2e;color:#e0e0e0;padding:2rem;margin:0}
pre{background:#16213e;padding:1.5rem;border-radius:8px;overflow-x:auto;line-height:1.5}</style>
</head><body><h1>CodeForge Result</h1><pre>${result.final_code.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre></body></html>`
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'codeforge-result.html'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    notify.success('HTML exported')
  }

  const handleCreatePR = async () => {
    setPRLoading(true)
    try {
      const res = await createPullRequest({
        session_id: sessionId,
        token: prToken,
        branch_name: prBranch,
        pr_title: prTitle,
      })
      setPRResult(res)
      notify.success(`PR #${res.pr_number} created!`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create PR'
      notify.error(msg)
    } finally {
      setPRLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
      </div>
    )
  }

  if (!result) {
    return (
      <div className="text-gray-400 text-sm text-center py-8">
        <Code2 className="w-8 h-8 mx-auto mb-2 opacity-50" />
        <p>No final code yet</p>
        <p className="text-xs mt-1">Complete the workflow to see the result</p>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 p-3 bg-green-500/20 border border-green-500/50 rounded-lg">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <span className="text-sm font-medium text-green-400">
            Final Code Ready
          </span>
        </div>
        <p className="mt-1 text-xs text-gray-300">
          Selected from Coder {result.selected_coder_index + 1}
        </p>
      </div>

      <div className="mb-4 grid grid-cols-3 gap-3">
        <div className="bg-gray-700/50 rounded-lg p-3">
          <div className="text-xs text-gray-300">Lines</div>
          <div className="text-lg font-semibold text-white">{result.final_code?.split('\n').length || 0}</div>
        </div>
        <div className="bg-gray-700/50 rounded-lg p-3">
          <div className="text-xs text-gray-300">Tokens</div>
          <div className="text-lg font-semibold text-white">{(result.total_tokens || 0).toLocaleString()}</div>
        </div>
        <div className="bg-gray-700/50 rounded-lg p-3">
          <div className="text-xs text-gray-300">Cost</div>
          <div className="text-lg font-semibold text-white">${(result.total_cost_usd || 0).toFixed(4)}</div>
        </div>
      </div>

      {/* VR-35 — Run Code is the primary action on the Final Code panel.
          Rendered above the secondary row so it stays visible and prominent
          even on narrow side-panel widths where the lower row may wrap. */}
      {onRunCode && (
        <div className="mb-3">
          <button
            onClick={onRunCode}
            disabled={isRunningCode}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:cursor-not-allowed rounded-lg text-sm font-medium text-white transition-colors"
          >
            {isRunningCode ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <Play className="w-4 h-4" />
                {/* КАО#VR-35 — disambiguate Run Code labels (REPL vs Final):
                    primary "Run Code" launches finalized execution via the
                    parent's handleRunCode (full execution UI); the REPLPreview
                    button below is labelled "Run in REPL" for inline output. */}
                Run Code
              </>
            )}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <button
          onClick={handleCopy}
          className="flex-1 min-w-[120px] flex items-center justify-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm transition-colors"
        >
          {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
          {copied ? 'Copied' : 'Copy Code'}
        </button>
        <button
          onClick={handleDownload}
          className="flex-1 min-w-[120px] flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-sm transition-colors"
        >
          <Archive className="w-4 h-4" />
          Download ZIP
        </button>
        <button
          onClick={handleExportHtml}
          className="flex-1 min-w-[120px] flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 rounded-lg text-sm transition-colors"
        >
          <Globe className="w-4 h-4" />
          Export HTML
        </button>
        {hasFileStructure && (
          <button
            onClick={() => setShowPRModal(!showPRModal)}
            className="flex-1 min-w-[120px] flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 rounded-lg text-sm transition-colors"
          >
            <GitBranch className="w-4 h-4" />
            Create PR
          </button>
        )}
      </div>

      <ResultActionsExtras sessionId={sessionId} language={language} />

      {/* PR Creation Modal */}
      {showPRModal && (
        <div className="mb-4 p-4 bg-purple-900/30 border border-purple-500/50 rounded-lg">
          {prResult ? (
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-green-400" />
              <span className="text-sm text-green-400">PR #{prResult.pr_number} created</span>
              <a
                href={prResult.pr_url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto flex items-center gap-1 text-sm text-purple-400 hover:text-purple-300"
              >
                Open on GitHub <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          ) : (
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-purple-300 flex items-center gap-2">
                <GitBranch className="w-4 h-4" />
                Create Pull Request on GitHub
              </h4>
              <input
                type="password"
                value={prToken}
                onChange={(e) => setPRToken(e.target.value)}
                placeholder="GitHub Personal Access Token"
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <div className="flex gap-2">
                <input
                  type="text"
                  value={prBranch}
                  onChange={(e) => setPRBranch(e.target.value)}
                  placeholder="Branch name"
                  className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
                <input
                  type="text"
                  value={prTitle}
                  onChange={(e) => setPRTitle(e.target.value)}
                  placeholder="PR title"
                  className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
              </div>
              <button
                onClick={handleCreatePR}
                disabled={prLoading || !prToken.trim()}
                className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded text-sm transition-colors"
              >
                {prLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
                {prLoading ? 'Creating PR...' : 'Create Pull Request'}
              </button>
              <p className="text-xs text-gray-400">
                Token needs <code>repo</code> scope. Never stored — used once for PR creation.
              </p>
            </div>
          )}
        </div>
      )}

      {/* File Structure (repo mode) */}
      {hasFileStructure && (
        <div className="mb-4">
          <div className="flex items-center gap-2 mb-2">
            <FolderOpen className="w-4 h-4 text-purple-400" />
            <span className="text-sm font-medium text-white">Modified Files</span>
          </div>
          <div className="space-y-1">
            {Object.entries(result.file_structure!).map(([path, info]) => {
              const action = typeof info === 'object' && info !== null ? (info as Record<string, string>).action : 'modified'
              return (
                <div key={path} className="flex items-center gap-2 px-3 py-1.5 bg-gray-700/50 rounded text-sm">
                  {action === 'created' ? (
                    <FilePlus className="w-4 h-4 text-green-400" />
                  ) : action === 'deleted' ? (
                    <FileX className="w-4 h-4 text-red-400" />
                  ) : action === 'modified' ? (
                    <FileEdit className="w-4 h-4 text-yellow-400" />
                  ) : (
                    <FileText className="w-4 h-4 text-gray-300" />
                  )}
                  <span className="text-gray-300 font-mono text-xs">{path}</span>
                  <span className={`ml-auto text-xs ${
                    action === 'created' ? 'text-green-400' :
                    action === 'deleted' ? 'text-red-400' :
                    action === 'modified' ? 'text-yellow-400' :
                    'text-gray-400'
                  }`}>
                    {action}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Улучшатели#3 wave 2 #5 — syntax-highlighted code. */}
      <CodeBlock
        code={result.final_code || ''}
        language={language}
        maxHeightClass="max-h-[50vh]"
      />

      {/* Live REPL preview - runs the final code and shows stdout/stderr.
          Especially useful for Python where the iframe preview cannot help. */}
      <REPLPreview sessionId={sessionId} language={language} />

      {result.readme_content && (
        <div className="mt-4">
          <h4 className="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
            <FileText className="w-4 h-4" />
            README
          </h4>
          <div className="bg-gray-900 p-4 rounded-lg text-sm text-gray-300 whitespace-pre-wrap max-h-48 overflow-auto">
            {result.readme_content}
          </div>
        </div>
      )}
    </div>
  )
}

// Enhancer Results Panel — shows parsed enhancement suggestions as readable cards
const enhancerMeta: Record<string, { icon: React.ElementType; label: string; description: string; color: string }> = {
  enhancer_design: { icon: Palette, label: 'Design Enhancer', description: 'UI/UX, layout, accessibility, visual design', color: 'text-pink-400' },
  enhancer_func: { icon: Cog, label: 'Functionality Enhancer', description: 'Features, edge cases, performance, code quality', color: 'text-cyan-400' },
  enhancer_security: { icon: Shield, label: 'Security Enhancer', description: 'Vulnerabilities, input validation, secure coding', color: 'text-red-400' },
  enhancer_summary: { icon: Sparkles, label: 'Enhancement Summarizer', description: 'Aggregates enhancement recommendations', color: 'text-fuchsia-400' },
}

interface ParsedSuggestion {
  title: string
  category: string
  priority: string
  description: string
  implementation?: string
}

function stripCodeFence(raw: string): string {
  let c = raw.trim()
  if (c.startsWith('```')) {
    const nl = c.indexOf('\n')
    if (nl >= 0) c = c.slice(nl + 1)
  }
  if (c.endsWith('```')) c = c.slice(0, -3)
  return c.trim()
}

function parseEnhancementContent(suggestions: EnhancementSuggestion[]): ParsedSuggestion[] {
  const items: ParsedSuggestion[] = []
  for (const s of suggestions) {
    try {
      const cleaned = stripCodeFence(s.content)
      const parsed = JSON.parse(cleaned)

      // Handle summarizer consolidated_improvements structure
      if (parsed.consolidated_improvements && typeof parsed.consolidated_improvements === 'object') {
        for (const [category, catItems] of Object.entries(parsed.consolidated_improvements)) {
          if (Array.isArray(catItems)) {
            for (const item of catItems as any[]) {
              items.push({
                title: item.title || item.name || 'Untitled',
                category,
                priority: item.priority || item.severity || 'medium',
                description: item.description || item.detail || '',
                implementation: item.implementation || item.how || undefined,
              })
            }
          }
        }
        continue
      }

      const suggList = Array.isArray(parsed) ? parsed : (parsed.suggestions || parsed.items || [parsed])
      for (const item of suggList) {
        items.push({
          title: item.title || item.name || 'Untitled',
          category: item.category || s.agent_type.replace('enhancer_', ''),
          priority: item.priority || item.severity || 'medium',
          description: item.description || item.detail || '',
          implementation: item.implementation || item.how || undefined,
        })
      }
    } catch {
      items.push({
        title: `${s.agent_type.replace('enhancer_', '').replace('_', ' ')} suggestion`,
        category: s.agent_type.replace('enhancer_', ''),
        priority: 'medium',
        description: s.content,
      })
    }
  }
  return items
}

function EnhancerResultsPanel({ sessionId, nodeType }: { sessionId: string; nodeType: string }) {
  const meta = enhancerMeta[nodeType]
  const [items, setItems] = useState<ParsedSuggestion[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  useEffect(() => {
    setLoading(true)
    getEnhancementSuggestions(sessionId)
      .then((suggestions) => {
        // For individual enhancer blocks, filter by agent_type; for summary show all
        const filtered = nodeType === 'enhancer_summary'
          ? suggestions
          : suggestions.filter(s => s.agent_type === nodeType)
        setItems(parseEnhancementContent(filtered))
      })
      .catch((err) => {
        console.error('Failed to load enhancement suggestions:', err)
      })
      .finally(() => setLoading(false))
  }, [sessionId, nodeType])

  if (!meta) return <div className="text-gray-300 text-sm">Unknown enhancer type</div>

  const Icon = meta.icon

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-purple-400" />
        <span className="ml-2 text-sm text-gray-300">Loading results...</span>
      </div>
    )
  }

  const toggleExpand = (idx: number) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      return next
    })
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 p-3 bg-gray-700/30 rounded-lg">
        <Icon className={`w-5 h-5 ${meta.color}`} />
        <div>
          <div className={`text-sm font-medium ${meta.color}`}>{meta.label}</div>
          <div className="text-xs text-gray-400">{meta.description}</div>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="text-gray-400 text-sm text-center py-8">No enhancement results yet</div>
      ) : (
        <div className="space-y-3">
          <h4 className="text-sm font-medium text-gray-300 flex items-center gap-2">
            <Sparkles className="w-4 h-4" />
            Suggestions ({items.length})
          </h4>
          {items.map((item, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-gray-600 bg-gray-700/50 p-3"
            >
              <div className="flex items-center gap-2 mb-1.5">
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${
                  item.priority === 'critical' ? 'bg-red-500/20 text-red-400' :
                  item.priority === 'high' ? 'bg-orange-500/20 text-orange-400' :
                  item.priority === 'medium' ? 'bg-yellow-500/20 text-yellow-400' :
                  'bg-gray-500/20 text-gray-300'
                }`}>
                  {item.priority}
                </span>
                <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                  item.category === 'security' ? 'bg-red-900/30 text-red-300' :
                  item.category === 'functionality' || item.category === 'func' ? 'bg-blue-900/30 text-blue-300' :
                  'bg-purple-900/30 text-purple-300'
                }`}>
                  {item.category}
                </span>
              </div>
              <h5 className="text-sm font-medium text-white mb-1">{item.title}</h5>
              <p className="text-xs text-gray-300 whitespace-pre-wrap">{item.description}</p>
              {item.implementation && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => toggleExpand(idx)}
                    className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 transition-colors"
                  >
                    {expanded.has(idx) ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronRight className="w-3 h-3" />
                    )}
                    Implementation details
                  </button>
                  {expanded.has(idx) && (
                    <p className="mt-1 text-xs text-gray-300 whitespace-pre-wrap bg-gray-800/50 p-2 rounded">
                      {item.implementation}
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Main DetailPanel component
export default function DetailPanel({
  nodeType,
  agentIndex,
  sessionId,
  title,
  llmModel,
  language,
  currentIteration,
  maxIterations,
  sessionStatus,
  specification,
  onClose,
  onRunCodeVersion,
  nodeStatus,
  onRetryAgent,
  onRunCode,
  isRunningCode,
}: DetailPanelProps) {
  const isEnhancer = nodeType.startsWith('enhancer_')
  // Улучшатели#3 wave 2 #2 — show a Retry affordance when the agent is in a
  // recoverable failure state (error or timeout). Wire to parent handler.
  const canRetryAgent =
    !!onRetryAgent &&
    (nodeStatus === 'error' || nodeStatus === 'timeout') &&
    nodeType !== 'input' && nodeType !== 'output'

  return (
    <div className="w-[500px] bg-gray-800 border-l border-gray-700 flex flex-col h-full animate-slideIn">
      {/* Header */}
      <div className="p-4 border-b border-gray-700 flex items-center justify-between bg-gray-800/80 backdrop-blur-sm sticky top-0 z-10 flex-shrink-0">
        <div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          {llmModel && (
            <p className="text-sm text-gray-300">{llmModel}</p>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-2 hover:bg-gray-700 rounded-lg transition-colors"
        >
          <X className="w-5 h-5 text-gray-300" />
        </button>
      </div>

      {/* Улучшатели#3 wave 2 #2 — retry-agent affordance for error/timeout. */}
      {canRetryAgent && (
        <div className="px-4 pt-3 pb-2 border-b border-gray-700 bg-amber-500/10">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-amber-300">
              This agent finished with {nodeStatus === 'timeout' ? 'a timeout' : 'an error'}.
            </span>
            <button
              type="button"
              onClick={() => onRetryAgent && onRetryAgent(nodeType, agentIndex)}
              className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white rounded-md transition-colors"
              title="Retry this agent"
            >
              <span aria-hidden="true">↻</span>
              Retry agent
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {nodeType === 'input' && (
          <SpecificationPanel specification={specification || 'No specification available'} />
        )}

        {nodeType === 'coder' && agentIndex !== undefined && (
          <CoderPanel
            sessionId={sessionId}
            coderIndex={agentIndex}
            language={language}
            currentIteration={currentIteration}
            maxIterations={maxIterations}
            sessionStatus={sessionStatus}
            onRunCodeVersion={onRunCodeVersion}
          />
        )}

        {nodeType === 'tester' && agentIndex !== undefined && (
          <TesterPanel 
            sessionId={sessionId} 
            testerIndex={agentIndex}
          />
        )}

        {nodeType === 'summarizer' && (
          <SummarizerPanel sessionId={sessionId} />
        )}

        {nodeType === 'finalizer' && (
          <FinalizerPanel 
            sessionId={sessionId}
            language={language}
          />
        )}

        {nodeType === 'output' && (
          <OutputPanel
            sessionId={sessionId}
            language={language}
            onRunCode={onRunCode}
            isRunningCode={isRunningCode}
          />
        )}

        {isEnhancer && (
          <EnhancerResultsPanel sessionId={sessionId} nodeType={nodeType} />
        )}
      </div>
    </div>
  )
}
