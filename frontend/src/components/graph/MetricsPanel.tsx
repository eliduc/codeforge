import {
  Zap,
  DollarSign,
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Save
} from 'lucide-react'

export interface CheckpointSummary {
  id: string
  iteration: number
  phase: string
  created_at: string
  total_tokens: number
}

// Улучшатели#3 P1·S #10 — humanize raw status enum for the badge.
// Mirrors getStatusLabel in SessionDetailPage (kept in sync intentionally so
// MetricsPanel renders standalone without importing from a page module).
function humanizeStatus(status: string): string {
  const labels: Record<string, string> = {
    awaiting_enhancement: 'Awaiting Enhancement',
    enhancing: 'Enhancing…',
    awaiting_enhancement_review: 'Enhancement Review',
    awaiting_visual_review: 'Visual Review',  // КАО#R3-01
    created: 'Created',
    running: 'Running',
    paused: 'Paused',
    completed: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  }
  return labels[status] || status
}

interface MetricsPanelProps {
  iteration: number
  maxIterations: number
  totalTokens: number
  totalCost: number
  status: string
  criticalIssues?: number
  seriousIssues?: number
  codersDone?: number
  totalCoders?: number
  testersDone?: number
  totalTesters?: number
  checkpoints?: CheckpointSummary[]
}

export default function MetricsPanel({
  iteration,
  maxIterations,
  totalTokens,
  totalCost,
  status,
  criticalIssues = 0,
  seriousIssues = 0,
  codersDone = 0,
  totalCoders = 0,
  testersDone = 0,
  totalTesters = 0,
  checkpoints,
}: MetricsPanelProps) {
  // Cap iteration display at maxIterations
  const displayIteration = Math.min(iteration, maxIterations)
  const progress = maxIterations > 0 ? (displayIteration / maxIterations) * 100 : 0
  
  // Total tests = coders * testers (each tester tests each coder's code)
  const totalTests = totalCoders > 0 && totalTesters > 0 ? totalCoders * totalTesters : 0

  // КАО#W4-FIX-02 — `pointer-events-auto` re-enables interaction on the visible
  // card. The parent React Flow <Panel> wrapper carries `pointer-events-none`
  // (see SessionDetailPage.tsx) so that the panel's positioning box does NOT
  // intercept clicks on the Spec node that sits at the canvas top-left behind
  // it. Without this, clicks on the visible portion of the Spec node land on
  // the empty area of the panel's outer wrapper and never reach the canvas.
  return (
    <div
      className="bg-gray-800/90 backdrop-blur-sm border border-gray-700 rounded-xl p-4 space-y-4 min-w-[240px] pointer-events-auto"
      data-tour="metrics-panel" /* tour-anchor: live metrics panel (Tour 3, step 4) */
    >
      {/* Title */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Session Metrics</h3>
        {/* Улучшатели#3 P1·S #10 — humanize the enum (was raw "awaiting_enhancement_review"). */}
        <span className={`
          px-2 py-0.5 rounded-full text-xs font-medium
          ${status === 'running' ? 'bg-blue-500/20 text-blue-400 animate-pulse' : ''}
          ${status === 'completed' ? 'bg-green-500/20 text-green-400' : ''}
          ${status === 'failed' ? 'bg-red-500/20 text-red-400' : ''}
          ${status === 'paused' ? 'bg-yellow-500/20 text-yellow-400' : ''}
          ${status === 'created' ? 'bg-gray-500/20 text-gray-300' : ''}
          ${status === 'enhancing' ? 'bg-purple-500/20 text-purple-300 animate-pulse' : ''}
          ${status === 'awaiting_enhancement' || status === 'awaiting_enhancement_review' || status === 'awaiting_visual_review' ? 'bg-amber-500/20 text-amber-300' : ''}
        `}>
          {humanizeStatus(status)}
        </span>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between text-xs text-gray-300 mb-1">
          <span className="flex items-center gap-1">
            <RefreshCw className="w-3 h-3" />
            Iteration
          </span>
          <span>{displayIteration} / {maxIterations}</span>
        </div>
        <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
          <div 
            className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 gap-3">
        {/* Tokens */}
        <div className="bg-gray-900/50 rounded-lg p-2">
          <div className="flex items-center gap-1 text-yellow-400 mb-1">
            <Zap className="w-3 h-3" />
            <span className="text-xs">Tokens</span>
          </div>
          <div className="text-sm font-semibold text-white">
            {totalTokens.toLocaleString()}
          </div>
        </div>

        {/* Cost */}
        <div className="bg-gray-900/50 rounded-lg p-2">
          <div className="flex items-center gap-1 text-green-400 mb-1">
            <DollarSign className="w-3 h-3" />
            <span className="text-xs">Cost</span>
          </div>
          <div className="text-sm font-semibold text-white">
            ${totalCost.toFixed(4)}
          </div>
        </div>
      </div>

      {/* Agent progress */}
      {(totalCoders > 0 || totalTesters > 0) && (
        <div className="space-y-2">
          <div className="text-xs text-gray-300">Agent Progress</div>
          <div className="flex items-center gap-4">
            {totalCoders > 0 && (
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-xs text-gray-300">
                  Coders: {codersDone}/{totalCoders}
                </span>
              </div>
            )}
            {totalTests > 0 && (
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-amber-500" />
                <span className="text-xs text-gray-300">
                  Tests: {testersDone}/{totalTests}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Issues summary */}
      {(criticalIssues > 0 || seriousIssues > 0) && (
        <div className="border-t border-gray-700 pt-3">
          <div className="text-xs text-gray-300 mb-2">Issues Found</div>
          <div className="flex items-center gap-3">
            {criticalIssues > 0 && (
              <div className="flex items-center gap-1 text-red-400">
                <XCircle className="w-3 h-3" />
                <span className="text-xs font-medium">{criticalIssues} critical</span>
              </div>
            )}
            {seriousIssues > 0 && (
              <div className="flex items-center gap-1 text-orange-400">
                <AlertTriangle className="w-3 h-3" />
                <span className="text-xs font-medium">{seriousIssues} serious</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Status indicator */}
      {status === 'completed' && (
        <div className="flex items-center gap-2 p-2 bg-green-500/10 rounded-lg border border-green-500/30">
          <CheckCircle2 className="w-4 h-4 text-green-400" />
          <span className="text-xs text-green-400 font-medium">
            Workflow Complete
          </span>
        </div>
      )}

      {/* VR-43 — Checkpoints panel removed: crash-recovery snapshots are
          an internal mechanism the user shouldn't need to inspect. The
          `checkpoints` prop is still accepted (no API churn) but unused. */}
    </div>
  )
}
