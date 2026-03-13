import { 
  Zap, 
  DollarSign, 
  RefreshCw,
  CheckCircle2,
  XCircle,
  AlertTriangle
} from 'lucide-react'

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
}: MetricsPanelProps) {
  // Cap iteration display at maxIterations
  const displayIteration = Math.min(iteration, maxIterations)
  const progress = maxIterations > 0 ? (displayIteration / maxIterations) * 100 : 0
  
  // Total tests = coders * testers (each tester tests each coder's code)
  const totalTests = totalCoders > 0 && totalTesters > 0 ? totalCoders * totalTesters : 0

  return (
    <div className="bg-gray-800/90 backdrop-blur-sm border border-gray-700 rounded-xl p-4 space-y-4 min-w-[240px]">
      {/* Title */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white">Session Metrics</h3>
        <span className={`
          px-2 py-0.5 rounded-full text-xs font-medium
          ${status === 'running' ? 'bg-blue-500/20 text-blue-400 animate-pulse' : ''}
          ${status === 'completed' ? 'bg-green-500/20 text-green-400' : ''}
          ${status === 'failed' ? 'bg-red-500/20 text-red-400' : ''}
          ${status === 'paused' ? 'bg-yellow-500/20 text-yellow-400' : ''}
          ${status === 'created' ? 'bg-gray-500/20 text-gray-400' : ''}
        `}>
          {status}
        </span>
      </div>

      {/* Progress bar */}
      <div>
        <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
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
          <div className="text-xs text-gray-400">Agent Progress</div>
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
          <div className="text-xs text-gray-400 mb-2">Issues Found</div>
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
    </div>
  )
}
