import { 
  Loader2,
  CheckCircle2,
  XCircle,
  Clock
} from 'lucide-react'

interface LegendPanelProps {
  compact?: boolean
}

const statusTypes = [
  { icon: Clock, label: 'Idle', color: 'text-gray-400', dotColor: 'bg-gray-500', animate: false },
  { icon: Loader2, label: 'Working', color: 'text-blue-400', dotColor: 'bg-blue-500', animate: true },
  { icon: CheckCircle2, label: 'Done', color: 'text-green-400', dotColor: 'bg-green-500', animate: false },
  { icon: XCircle, label: 'Error', color: 'text-red-400', dotColor: 'bg-red-500', animate: false },
]

export default function LegendPanel({ compact = false }: LegendPanelProps) {
  if (compact) {
    return (
      <div className="bg-gray-800/90 backdrop-blur-sm border border-gray-700 rounded-lg p-2 ml-12">
        <div className="flex flex-wrap gap-3">
          {statusTypes.map(({ label, dotColor, animate }) => (
            <div key={label} className="flex items-center gap-1">
              <div className={`w-2 h-2 rounded-full ${dotColor} ${animate ? 'animate-pulse' : ''}`} />
              <span className="text-xs text-gray-400">{label}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gray-800/90 backdrop-blur-sm border border-gray-700 rounded-xl p-4 space-y-4 min-w-[180px]">
      <h3 className="text-sm font-semibold text-white">Legend</h3>
      
      {/* Status types */}
      <div className="space-y-2">
        <div className="text-xs text-gray-400 uppercase tracking-wide">Status</div>
        {statusTypes.map(({ icon: Icon, label, color, dotColor, animate }) => (
          <div key={label} className="flex items-center gap-2">
            <div className={`w-3 h-3 rounded-full ${dotColor} ${animate ? 'animate-pulse' : ''}`} />
            <Icon className={`w-4 h-4 ${color} ${animate ? 'animate-spin' : ''}`} />
            <span className="text-xs text-gray-300">{label}</span>
          </div>
        ))}
      </div>

      {/* Artifact types */}
      <div className="space-y-2 border-t border-gray-700 pt-3">
        <div className="text-xs text-gray-400 uppercase tracking-wide">Artifacts</div>
        <div className="flex items-center gap-2">
          <span className="text-sm">📄</span>
          <span className="text-xs text-gray-300">Code Version</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm">🔍</span>
          <span className="text-xs text-gray-300">Audit Report</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm">📋</span>
          <span className="text-xs text-gray-300">Summary</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm">✅</span>
          <span className="text-xs text-gray-300">Final Result</span>
        </div>
      </div>
    </div>
  )
}
