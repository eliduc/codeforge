import { useState, useEffect, useMemo } from 'react'
import { X, Loader2, ArrowLeftRight, FileCode, AlertCircle, RotateCw } from 'lucide-react'
import {
  getSession,
  getFinalResult,
  getSessionMetrics,
} from '../services/api'
import type {
  SessionResponse,
  FinalResultResponse,
  SessionMetrics,
} from '../services/api'
import notify from './common/StyledToast'
// Улучшатели#1 P2·S — SessionCompareModal diff view + syntax highlighting.
import CodeBlock from './common/CodeBlock'

// Per-column character cap for the code preview (raised from 50k → 100k).
const CHAR_CAP = 100_000

type ViewMode = 'side' | 'unified' | 'raw'

interface SessionCompareModalProps {
  sessionAId: string
  sessionBId?: string
  availableSessions: Array<{ id: string; name: string }>
  onClose: () => void
}

export default function SessionCompareModal({
  sessionAId,
  sessionBId,
  availableSessions,
  onClose,
}: SessionCompareModalProps) {
  const [pickedB, setPickedB] = useState(sessionBId || '')
  const [sessionA, setSessionA] = useState<SessionResponse | null>(null)
  const [sessionB, setSessionB] = useState<SessionResponse | null>(null)
  const [resultA, setResultA] = useState<FinalResultResponse | null>(null)
  const [resultB, setResultB] = useState<FinalResultResponse | null>(null)
  const [metricsA, setMetricsA] = useState<SessionMetrics | null>(null)
  const [metricsB, setMetricsB] = useState<SessionMetrics | null>(null)
  const [loadingA, setLoadingA] = useState(false)
  const [loadingB, setLoadingB] = useState(false)
  // Улучшатели#2 P2·S — surface load errors inline instead of swallowing them.
  const [errorA, setErrorA] = useState<string | null>(null)
  const [errorB, setErrorB] = useState<string | null>(null)
  const [reloadA, setReloadA] = useState(0)
  const [reloadB, setReloadB] = useState(0)
  // Улучшатели#1 P2·S — view mode toggle. Default to side-by-side.
  const [viewMode, setViewMode] = useState<ViewMode>('side')

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoadingA(true)
      setErrorA(null)
      try {
        const [sA, mA] = await Promise.all([
          getSession(sessionAId),
          getSessionMetrics(sessionAId).catch(() => null),
        ])
        if (cancelled) return
        setSessionA(sA)
        setMetricsA(mA)
        try {
          const r = await getFinalResult(sessionAId)
          if (!cancelled) setResultA(r)
        } catch {
          // No final result — that's not a fatal error for the panel.
          if (!cancelled) setResultA(null)
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Failed to load session A'
          setErrorA(msg)
          notify.error('Failed to load session A')
        }
      } finally {
        if (!cancelled) setLoadingA(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [sessionAId, reloadA])

  useEffect(() => {
    if (!pickedB) {
      setSessionB(null)
      setResultB(null)
      setMetricsB(null)
      setErrorB(null)
      return
    }
    let cancelled = false
    async function load() {
      setLoadingB(true)
      setErrorB(null)
      try {
        const [sB, mB] = await Promise.all([
          getSession(pickedB),
          getSessionMetrics(pickedB).catch(() => null),
        ])
        if (cancelled) return
        setSessionB(sB)
        setMetricsB(mB)
        try {
          const r = await getFinalResult(pickedB)
          if (!cancelled) setResultB(r)
        } catch {
          if (!cancelled) setResultB(null)
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Failed to load session B'
          setErrorB(msg)
          notify.error('Failed to load session B')
        }
      } finally {
        if (!cancelled) setLoadingB(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [pickedB, reloadB])

  // Улучшатели#1 P2·S — compute unified-diff lines on demand. Tiny implementation
  // suitable for short-medium final-code blobs; for very large files we still rely
  // on the per-column character cap to keep render fast.
  const unifiedDiff = useMemo(() => {
    if (viewMode !== 'unified') return null
    const a = (resultA?.final_code || '').slice(0, CHAR_CAP)
    const b = (resultB?.final_code || '').slice(0, CHAR_CAP)
    return computeLineDiff(a, b)
  }, [viewMode, resultA, resultB])

  const language = sessionA?.language || sessionB?.language || undefined

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Session comparison"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div
        className="bg-cf-panel rounded-xl w-full max-w-7xl h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-cf-border flex items-center justify-between flex-shrink-0 gap-4 flex-wrap">
          <h3 className="text-lg font-semibold text-cf-text flex items-center gap-2">
            <ArrowLeftRight className="w-5 h-5" />
            Compare Sessions
          </h3>
          {/* Улучшатели#1 P2·S — view mode toggle (side-by-side / unified / raw). */}
          <div
            role="tablist"
            aria-label="Comparison view mode"
            className="inline-flex items-center gap-1 p-0.5 rounded-lg bg-cf-bg border border-cf-border"
          >
            {(['side', 'unified', 'raw'] as ViewMode[]).map((m) => {
              const labels: Record<ViewMode, string> = {
                side: 'Side-by-side',
                unified: 'Unified diff',
                raw: 'Raw',
              }
              const active = viewMode === m
              return (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setViewMode(m)}
                  className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                    active
                      ? 'bg-cf-primary text-white'
                      : 'text-cf-text-muted hover:text-cf-text hover:bg-cf-hover'
                  }`}
                >
                  {labels[m]}
                </button>
              )
            })}
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-cf-border rounded-lg"
            aria-label="Close"
          >
            <X className="w-5 h-5 text-cf-text-muted" />
          </button>
        </div>

        {viewMode === 'unified' ? (
          // Улучшатели#1 P2·S — unified diff view (single column spanning the modal).
          <div className="flex-1 overflow-auto p-4 min-h-0">
            <SessionHeaders
              sessionA={sessionA}
              sessionB={sessionB}
              metricsA={metricsA}
              metricsB={metricsB}
              pickedB={pickedB}
              setPickedB={setPickedB}
              sessionAId={sessionAId}
              sessionBId={sessionBId}
              availableSessions={availableSessions}
              errorA={errorA}
              errorB={errorB}
              onRetryA={() => setReloadA((n) => n + 1)}
              onRetryB={() => setReloadB((n) => n + 1)}
              loadingA={loadingA}
              loadingB={loadingB}
              onPickFromList={onClose}
            />
            <div className="mt-3">
              {unifiedDiff ? (
                <UnifiedDiffView diff={unifiedDiff} />
              ) : (
                <div className="text-cf-text-muted text-sm p-4">
                  No code to diff — at least one session has no final result.
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto p-4 min-h-0 grid grid-cols-2 gap-4">
            <ColumnView
              title="A"
              session={sessionA}
              result={resultA}
              metrics={metricsA}
              loading={loadingA}
              error={errorA}
              onRetry={() => setReloadA((n) => n + 1)}
              viewMode={viewMode}
              language={language}
            />
            <div>
              {!sessionBId && (
                <div className="mb-3">
                  <label className="text-sm text-cf-text-muted block mb-1" htmlFor="compare-session-select">
                    Select session to compare:
                  </label>
                  <select
                    id="compare-session-select"
                    value={pickedB}
                    onChange={(e) => setPickedB(e.target.value)}
                    aria-label="Select session to compare"
                    className="w-full px-3 py-2 bg-cf-bg border border-cf-border rounded-lg text-cf-text"
                  >
                    <option value="">— pick a session —</option>
                    {availableSessions
                      .filter((s) => s.id !== sessionAId)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </select>
                </div>
              )}
              <ColumnView
                title="B"
                session={sessionB}
                result={resultB}
                metrics={metricsB}
                loading={loadingB}
                error={errorB}
                onRetry={() => setReloadB((n) => n + 1)}
                viewMode={viewMode}
                language={language}
                emptyState={
                  !pickedB ? (
                    // Улучшатели#2 P2·S — helpful empty state with guidance + "Pick from list" link.
                    <div className="text-cf-text-muted text-sm p-4 space-y-2 bg-cf-bg/40 rounded-lg border border-dashed border-cf-border">
                      <p>
                        Pick another session to compare with this one. Click{' '}
                        <span className="font-medium text-cf-text">Compare</span> on any session
                        card to add it to column B.
                      </p>
                      <button
                        type="button"
                        onClick={onClose}
                        className="text-indigo-700 dark:text-cf-primary hover:underline text-sm font-medium"
                      >
                        Pick from list →
                      </button>
                    </div>
                  ) : undefined
                }
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

interface SessionHeadersProps {
  sessionA: SessionResponse | null
  sessionB: SessionResponse | null
  metricsA: SessionMetrics | null
  metricsB: SessionMetrics | null
  pickedB: string
  setPickedB: (v: string) => void
  sessionAId: string
  sessionBId?: string
  availableSessions: Array<{ id: string; name: string }>
  errorA: string | null
  errorB: string | null
  onRetryA: () => void
  onRetryB: () => void
  loadingA: boolean
  loadingB: boolean
  onPickFromList: () => void
}

// Compact two-column header used by the unified-diff view.
function SessionHeaders({
  sessionA,
  sessionB,
  metricsA,
  metricsB,
  pickedB,
  setPickedB,
  sessionAId,
  sessionBId,
  availableSessions,
  errorA,
  errorB,
  onRetryA,
  onRetryB,
  loadingA,
  loadingB,
  onPickFromList,
}: SessionHeadersProps) {
  return (
    <div className="grid grid-cols-2 gap-4">
      <SessionHeaderCard
        title="A"
        session={sessionA}
        metrics={metricsA}
        loading={loadingA}
        error={errorA}
        onRetry={onRetryA}
      />
      <div>
        {!sessionBId && (
          <div className="mb-2">
            <select
              value={pickedB}
              onChange={(e) => setPickedB(e.target.value)}
              aria-label="Select session to compare"
              className="w-full px-3 py-2 bg-cf-bg border border-cf-border rounded-lg text-cf-text text-sm"
            >
              <option value="">— pick a session —</option>
              {availableSessions
                .filter((s) => s.id !== sessionAId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </div>
        )}
        {pickedB || sessionB ? (
          <SessionHeaderCard
            title="B"
            session={sessionB}
            metrics={metricsB}
            loading={loadingB}
            error={errorB}
            onRetry={onRetryB}
          />
        ) : (
          <div className="text-cf-text-muted text-sm p-3 bg-cf-bg/40 rounded-lg border border-dashed border-cf-border space-y-1">
            <p>Pick another session to compare with this one.</p>
            <button
              type="button"
              onClick={onPickFromList}
              className="text-cf-primary hover:underline text-sm font-medium"
            >
              Pick from list →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

interface SessionHeaderCardProps {
  title: string
  session: SessionResponse | null
  metrics: SessionMetrics | null
  loading: boolean
  error: string | null
  onRetry: () => void
}

function SessionHeaderCard({
  title,
  session,
  metrics,
  loading,
  error,
  onRetry,
}: SessionHeaderCardProps) {
  if (loading) {
    return (
      <div className="bg-cf-bg/50 p-3 rounded-lg border border-cf-border flex items-center justify-center">
        <Loader2 className="w-4 h-4 animate-spin text-cf-primary" />
      </div>
    )
  }
  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/40 rounded-lg p-3 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 text-xs">
          <div className="text-red-300 font-medium">Failed to load session {title}</div>
          <div className="text-red-300/70">{error}</div>
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-red-200 hover:text-white bg-red-500/20 hover:bg-red-500/30 rounded transition-colors"
          >
            <RotateCw className="w-3 h-3" /> Try again
          </button>
        </div>
      </div>
    )
  }
  if (!session) {
    return null
  }
  return (
    <div className="bg-cf-bg/50 p-3 rounded-lg border border-cf-border">
      <div className="text-xs text-cf-text-muted">Session {title}</div>
      <div className="text-base font-semibold text-cf-text truncate">
        {session.name}
      </div>
      <div className="text-xs text-cf-text-muted mt-1">
        Status: {session.status} · Iter {session.current_iteration}/
        {session.max_iterations}
      </div>
      {metrics && (
        <div className="mt-2 text-xs grid grid-cols-2 gap-1">
          <div>
            <span className="text-cf-text-muted">Tokens:</span>{' '}
            <span className="text-cf-text">{(metrics.total_tokens ?? 0).toLocaleString()}</span>
          </div>
          <div>
            <span className="text-cf-text-muted">Cost:</span>{' '}
            <span className="text-cf-text">${(metrics.total_cost_usd ?? 0).toFixed(4)}</span>
          </div>
        </div>
      )}
    </div>
  )
}

interface ColumnViewProps {
  title: string
  session: SessionResponse | null
  result: FinalResultResponse | null
  metrics: SessionMetrics | null
  loading: boolean
  error: string | null
  onRetry: () => void
  viewMode: ViewMode
  language?: string
  emptyState?: React.ReactNode
}

function ColumnView({
  title,
  session,
  result,
  metrics,
  loading,
  error,
  onRetry,
  viewMode,
  language,
  emptyState,
}: ColumnViewProps) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-6 h-6 animate-spin text-cf-primary" />
      </div>
    )
  }
  if (error) {
    // Улучшатели#2 P2·S — surface load errors inline with a "Try again" button.
    return (
      <div className="bg-red-500/10 border border-red-500/40 rounded-lg p-4 flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <div className="text-red-300 font-medium text-sm">Failed to load session {title}</div>
          <div className="text-red-300/70 text-xs mt-1">{error}</div>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 inline-flex items-center gap-1 px-2 py-1 text-xs text-red-200 hover:text-white bg-red-500/20 hover:bg-red-500/30 rounded transition-colors"
          >
            <RotateCw className="w-3 h-3" /> Try again
          </button>
        </div>
      </div>
    )
  }
  if (!session) {
    return <>{emptyState ?? <div className="text-cf-text-muted text-sm p-4">No session selected</div>}</>
  }
  const code = result?.final_code || ''
  const truncated = code.length > CHAR_CAP
  const display = truncated ? code.slice(0, CHAR_CAP) + '\n\n... [truncated]' : code
  return (
    <div className="space-y-3">
      <div className="bg-cf-bg/50 p-3 rounded-lg border border-cf-border">
        <div className="text-xs text-cf-text-muted">Session {title}</div>
        <div className="text-base font-semibold text-cf-text truncate">
          {session.name}
        </div>
        <div className="text-xs text-cf-text-muted mt-1">
          Status: {session.status} · Iter {session.current_iteration}/
          {session.max_iterations}
        </div>
      </div>
      {metrics && (
        <div className="bg-cf-bg/50 p-3 rounded-lg border border-cf-border text-sm grid grid-cols-2 gap-2">
          <div>
            <span className="text-cf-text-muted">Tokens:</span>{' '}
            <span className="text-cf-text">
              {(metrics.total_tokens ?? 0).toLocaleString()}
            </span>
          </div>
          <div>
            <span className="text-cf-text-muted">Cost:</span>{' '}
            <span className="text-cf-text">
              ${(metrics.total_cost_usd ?? 0).toFixed(4)}
            </span>
          </div>
          <div>
            <span className="text-cf-text-muted">Requests:</span>{' '}
            <span className="text-cf-text">{metrics.total_requests ?? 0}</span>
          </div>
          <div>
            <span className="text-cf-text-muted">Latency:</span>{' '}
            <span className="text-cf-text">
              {Math.round((metrics.total_time_ms ?? 0) / 1000)}s
            </span>
          </div>
        </div>
      )}
      {code ? (
        <div>
          <div className="text-xs text-cf-text-muted mb-1 flex items-center gap-1">
            <FileCode className="w-3 h-3" /> Final code ({code.length} chars)
          </div>
          {/* Улучшатели#1 P2·S — Side-by-side mode uses CodeBlock (syntax highlight + line numbers).
              Raw mode falls back to plain <pre> for users who want to copy-paste verbatim. */}
          {viewMode === 'raw' ? (
            <pre className="bg-cf-bg p-3 rounded-lg text-xs text-cf-text font-mono whitespace-pre-wrap overflow-auto max-h-[60vh] border border-cf-border">
              {display}
            </pre>
          ) : (
            <CodeBlock
              code={display}
              language={language}
              maxHeightClass="max-h-[60vh]"
              showLineNumbers
              showCopy
            />
          )}
        </div>
      ) : (
        <div className="text-cf-text-muted text-sm">
          No final code (session not completed)
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Unified diff helpers — Улучшатели#1 P2·S
// ---------------------------------------------------------------------------

type DiffLine = { kind: 'context' | 'add' | 'del'; text: string; aNo?: number; bNo?: number }

/**
 * Compute a line-level diff using an LCS table. Suitable for the ~100k char
 * cap we already enforce. Returns a flat array of diff lines ready to render.
 */
function computeLineDiff(a: string, b: string): DiffLine[] {
  const aLines = a.length === 0 ? [] : a.split('\n')
  const bLines = b.length === 0 ? [] : b.split('\n')
  const m = aLines.length
  const n = bLines.length

  // LCS length table
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) {
        lcs[i][j] = lcs[i + 1][j + 1] + 1
      } else {
        lcs[i][j] = Math.max(lcs[i + 1][j], lcs[i][j + 1])
      }
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      out.push({ kind: 'context', text: aLines[i], aNo: i + 1, bNo: j + 1 })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: aLines[i], aNo: i + 1 })
      i++
    } else {
      out.push({ kind: 'add', text: bLines[j], bNo: j + 1 })
      j++
    }
  }
  while (i < m) {
    out.push({ kind: 'del', text: aLines[i], aNo: i + 1 })
    i++
  }
  while (j < n) {
    out.push({ kind: 'add', text: bLines[j], bNo: j + 1 })
    j++
  }
  return out
}

function UnifiedDiffView({ diff }: { diff: DiffLine[] }) {
  if (diff.length === 0) {
    return (
      <div className="text-cf-text-muted text-sm p-4 bg-cf-bg/40 rounded-lg border border-dashed border-cf-border">
        Both sides are empty.
      </div>
    )
  }
  const hasChanges = diff.some((l) => l.kind !== 'context')
  return (
    <div className="rounded-lg border border-cf-border bg-cf-bg overflow-hidden">
      {!hasChanges && (
        <div className="px-3 py-2 text-xs text-cf-text-muted border-b border-cf-border bg-cf-bg/60">
          Final code is identical.
        </div>
      )}
      <div className="overflow-auto max-h-[65vh]">
        <table className="w-full font-mono text-xs">
          <tbody>
            {diff.map((line, idx) => {
              const bgClass =
                line.kind === 'add'
                  ? 'bg-green-500/10'
                  : line.kind === 'del'
                    ? 'bg-red-500/10'
                    : ''
              const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
              const signColor =
                line.kind === 'add'
                  ? 'text-green-400'
                  : line.kind === 'del'
                    ? 'text-red-400'
                    : 'text-cf-text-muted'
              return (
                <tr key={idx} className={bgClass}>
                  <td className="select-none text-right px-2 text-cf-text-muted/70 border-r border-cf-border/40 align-top">
                    {line.aNo ?? ''}
                  </td>
                  <td className="select-none text-right px-2 text-cf-text-muted/70 border-r border-cf-border/40 align-top">
                    {line.bNo ?? ''}
                  </td>
                  <td className={`select-none px-2 ${signColor} align-top`}>{sign}</td>
                  <td className="whitespace-pre-wrap break-all py-0.5 pr-3 text-cf-text align-top">
                    {line.text}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
