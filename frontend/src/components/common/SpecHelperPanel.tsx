/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react'
import {
  Loader2,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  AlertCircle,
  Info,
  CheckCircle2,
  Clock,
  Coins,
  DollarSign,
} from 'lucide-react'
import {
  scoreSpec,
  estimateCost,
  type SpecScoreResponse,
  type CostEstimateResponse,
} from '../../services/api'

interface SpecHelperPanelProps {
  specification: string
  language?: string
  agentConfigs?: any[]
  maxIterations?: number
  /** Minimum spec length before triggering analysis (default 50). */
  minLength?: number
  /** Debounce delay in ms (default 500). */
  debounceMs?: number
}

function severityIcon(sev: string) {
  const s = sev.toLowerCase()
  if (s === 'error' || s === 'critical' || s === 'high')
    return <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
  if (s === 'warning' || s === 'medium')
    return <AlertTriangle className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
  return <Info className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
}

function scoreBadgeClasses(score: number): string {
  if (score >= 80) return 'bg-green-500/20 text-green-300 border-green-500/40'
  if (score >= 50) return 'bg-amber-500/20 text-amber-300 border-amber-500/40'
  return 'bg-red-500/20 text-red-300 border-red-500/40'
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.floor(seconds / 60)
  const secs = Math.round(seconds % 60)
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  const hrs = Math.floor(mins / 60)
  const remMins = mins % 60
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(Math.round(n))
}

export default function SpecHelperPanel({
  specification,
  language,
  agentConfigs,
  maxIterations,
  minLength = 50,
  debounceMs = 500,
}: SpecHelperPanelProps) {
  const [open, setOpen] = useState(true)
  const [score, setScore] = useState<SpecScoreResponse | null>(null)
  const [cost, setCost] = useState<CostEstimateResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showIssues, setShowIssues] = useState(false)
  const lastReqIdRef = useRef(0)

  const tooShort = specification.trim().length <= minLength

  useEffect(() => {
    if (tooShort) {
      setScore(null)
      setCost(null)
      setError(null)
      return
    }

    const timer = setTimeout(async () => {
      const reqId = ++lastReqIdRef.current
      setLoading(true)
      setError(null)
      try {
        const tasks: Promise<unknown>[] = [scoreSpec(specification, language)]
        if (agentConfigs && agentConfigs.length > 0 && maxIterations) {
          tasks.push(estimateCost(specification, agentConfigs, maxIterations))
        }
        const results = await Promise.allSettled(tasks)
        if (reqId !== lastReqIdRef.current) return  // stale

        const scoreRes = results[0]
        if (scoreRes.status === 'fulfilled') {
          setScore(scoreRes.value as SpecScoreResponse)
        } else {
          setError((scoreRes.reason as Error)?.message || 'Failed to score spec')
        }

        if (results.length > 1) {
          const costRes = results[1]
          if (costRes.status === 'fulfilled') {
            setCost(costRes.value as CostEstimateResponse)
          } else {
            // Cost is best-effort; just clear it
            setCost(null)
          }
        } else {
          setCost(null)
        }
      } catch (err) {
        if (reqId !== lastReqIdRef.current) return
        setError(err instanceof Error ? err.message : 'Analysis failed')
      } finally {
        if (reqId === lastReqIdRef.current) {
          setLoading(false)
        }
      }
    }, debounceMs)

    return () => clearTimeout(timer)
  }, [specification, language, agentConfigs, maxIterations, debounceMs, tooShort])

  if (tooShort) {
    return (
      <div className="text-xs text-gray-500 italic">
        Type at least {minLength + 1} characters to get a quality score and cost estimate.
      </div>
    )
  }

  return (
    <div className="bg-gray-900/60 border border-gray-700 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-gray-800/60 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm text-gray-200">
          {open ? (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400" />
          )}
          <span className="font-medium">Spec analysis</span>
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />}
          {!loading && score && (
            <span
              className={`inline-flex items-center px-2 py-0.5 text-xs font-semibold rounded-full border ${scoreBadgeClasses(
                score.overall_score,
              )}`}
            >
              {score.overall_score}/100
            </span>
          )}
        </div>
        {!loading && score && (
          <div className="flex items-center gap-3 text-xs text-gray-400">
            <span className="capitalize">{score.estimated_complexity}</span>
            {cost && (
              <span className="flex items-center gap-1 text-gray-300">
                <DollarSign className="w-3 h-3" />
                {cost.estimated_cost_usd.toFixed(4)}
              </span>
            )}
          </div>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 pt-1 border-t border-gray-700/50">
          {error && (
            <div className="text-xs text-red-400 mb-2 flex items-start gap-1">
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {!score && loading && (
            <div className="flex items-center gap-2 text-xs text-gray-400 py-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Analyzing specification...
            </div>
          )}

          {score && (
            <div className="space-y-3">
              {/* Stats row */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div className="bg-gray-800/60 rounded px-2 py-1.5">
                  <div className="text-gray-500">Words</div>
                  <div className="text-gray-200 font-semibold">{score.word_count}</div>
                </div>
                <div className="bg-gray-800/60 rounded px-2 py-1.5">
                  <div className="text-gray-500">Issues</div>
                  <div className="text-gray-200 font-semibold">{score.issues.length}</div>
                </div>
                {cost && (
                  <>
                    <div className="bg-gray-800/60 rounded px-2 py-1.5">
                      <div className="text-gray-500 flex items-center gap-1">
                        <Coins className="w-3 h-3" /> Tokens
                      </div>
                      <div className="text-gray-200 font-semibold">
                        {formatTokens(cost.estimated_total_tokens)}
                      </div>
                    </div>
                    <div className="bg-gray-800/60 rounded px-2 py-1.5">
                      <div className="text-gray-500 flex items-center gap-1">
                        <Clock className="w-3 h-3" /> Time
                      </div>
                      <div className="text-gray-200 font-semibold">
                        ~{formatTime(cost.estimated_time_seconds)}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {/* Detected keywords */}
              {score.detected_keywords && score.detected_keywords.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {score.detected_keywords.slice(0, 12).map((kw) => (
                    <span
                      key={kw}
                      className="text-xs px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30"
                    >
                      {kw}
                    </span>
                  ))}
                </div>
              )}

              {/* Issues toggle */}
              {score.issues.length > 0 ? (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowIssues(!showIssues)}
                    className="flex items-center gap-1 text-xs text-gray-300 hover:text-white transition-colors"
                  >
                    {showIssues ? (
                      <ChevronDown className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5" />
                    )}
                    {score.issues.length} issue{score.issues.length === 1 ? '' : 's'} found
                  </button>
                  {showIssues && (
                    <ul className="mt-2 space-y-1.5 pl-1">
                      {score.issues.map((iss, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs">
                          {severityIcon(iss.severity)}
                          <div className="flex-1 min-w-0">
                            <div className="text-gray-200">{iss.description}</div>
                            {iss.suggestion && (
                              <div className="text-gray-500 mt-0.5">→ {iss.suggestion}</div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-xs text-green-400">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  No issues detected
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
