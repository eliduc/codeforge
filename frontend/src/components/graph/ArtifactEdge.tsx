import { memo } from 'react'
import { 
  BaseEdge, 
  getBezierPath,
  EdgeLabelRenderer,
  type EdgeProps,
} from '@xyflow/react'

export interface ArtifactEdgeData extends Record<string, unknown> {
  artifactType?: 'code' | 'audit' | 'summary' | 'final'
  label?: string
  animated?: boolean
  hasArtifact?: boolean
}

const artifactConfig = {
  code: {
    color: '#3B82F6', // blue
    label: 'Code',
    emoji: '📄',
  },
  audit: {
    color: '#F59E0B', // amber
    label: 'Audit',
    emoji: '🔍',
  },
  summary: {
    color: '#8B5CF6', // purple
    label: 'Summary',
    emoji: '📋',
  },
  final: {
    color: '#10B981', // emerald
    label: 'Final',
    emoji: '✅',
  },
}

function ArtifactEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  data,
  markerEnd,
}: EdgeProps) {
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  })

  const edgeData = data as ArtifactEdgeData | undefined
  const config = edgeData?.artifactType 
    ? artifactConfig[edgeData.artifactType] 
    : null

  const isAnimated = edgeData?.animated || false
  const hasArtifact = edgeData?.hasArtifact || false

  return (
    <>
      {/* Background edge for glow effect when active */}
      {isAnimated && (
        <BaseEdge
          path={edgePath}
          style={{
            ...style,
            stroke: config?.color || '#4B5563',
            strokeWidth: 6,
            opacity: 0.3,
            filter: 'blur(4px)',
          }}
        />
      )}
      
      {/* Main edge */}
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: config?.color || '#4B5563',
          strokeWidth: isAnimated ? 3 : 2,
          strokeDasharray: isAnimated ? '10 5' : undefined,
          animation: isAnimated ? 'flowAnimation 1s linear infinite' : undefined,
        }}
      />

      {/* Flowing dots animation when active */}
      {isAnimated && (
        <circle r="4" fill={config?.color || '#4B5563'}>
          <animateMotion dur="1.5s" repeatCount="indefinite" path={edgePath} />
        </circle>
      )}

      {/* Artifact badge */}
      {hasArtifact && config && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan"
          >
            <div 
              className={`
                px-2 py-1 rounded-full text-xs font-medium 
                flex items-center gap-1
                border-2 shadow-lg
                ${isAnimated ? 'animate-pulse' : ''}
              `}
              style={{
                backgroundColor: `${config.color}20`,
                borderColor: config.color,
                color: config.color,
              }}
            >
              <span>{config.emoji}</span>
              <span>{edgeData?.label || config.label}</span>
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export default memo(ArtifactEdge)
