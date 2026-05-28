import { memo } from 'react'
import {
  BaseEdge,
  getBezierPath,
  EdgeLabelRenderer,
  useReactFlow,
  type EdgeProps,
} from '@xyflow/react'

export interface ArtifactEdgeData extends Record<string, unknown> {
  artifactType?: 'code' | 'audit' | 'summary' | 'final' | 'enhancement'
  label?: string
  animated?: boolean
  hasArtifact?: boolean
  /** Optional iteration number for the artifact carried over this edge. */
  iteration?: number
  /** Optional precomputed tooltip override. */
  tooltip?: string
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
  enhancement: {
    color: '#A855F7', // purple
    label: 'Enhancement',
    emoji: '✨',
  },
}

// Улучшатели#3 P2·S — Edge artifact tooltips & stacking.
// Resolve a human-readable label for a node id (e.g. "coder-0" → "Coder 1").
function nodeIdToLabel(id: string): string {
  if (!id) return ''
  if (id === 'input') return 'Specification'
  if (id === 'output') return 'Final Code'
  if (id === 'summarizer') return 'Summarizer'
  if (id === 'finalizer') return 'Finalizer'
  if (id.startsWith('coder-')) {
    const i = parseInt(id.split('-')[1] || '0', 10)
    return `Coder ${i + 1}`
  }
  if (id.startsWith('tester-')) {
    const i = parseInt(id.split('-')[1] || '0', 10)
    return `Tester ${i + 1}`
  }
  if (id.startsWith('enhancer-')) {
    // enhancer-design, enhancer-func, enhancer-security, enhancer-summary…
    const rest = id.slice('enhancer-'.length)
    return `Enhancer (${rest})`
  }
  return id
}

function ArtifactEdge({
  id,
  source,
  target,
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

  // Улучшатели#3 P2·S — Edge artifact tooltips & stacking.
  // Compute a descriptive tooltip from the edge data + source/target ids.
  // Example: "Code (iter 2) from Coder 1 → Tester 2"
  const flow = useReactFlow()
  const tooltipText: string = (() => {
    if (edgeData?.tooltip) return edgeData.tooltip
    const kind = edgeData?.label || config?.label || 'Artifact'
    const iter = edgeData?.iteration
    const srcLabel = nodeIdToLabel(source)
    const tgtLabel = nodeIdToLabel(target)
    const iterPart = typeof iter === 'number' && iter > 0 ? ` (iter ${iter})` : ''
    return `${kind}${iterPart} from ${srcLabel} → ${tgtLabel}`
  })()

  // Улучшатели#3 P2·S — Edge artifact tooltips & stacking.
  // When multiple artifact-bearing edges share a similar label anchor point
  // (e.g. multiple coder→tester edges that all converge on the same tester),
  // we stack their badges vertically with a 4px gap instead of overlapping
  // horizontally. We detect collisions by counting how many other artifact
  // edges target the same node id and offsetting by our index in that group.
  let stackOffsetY = 0
  try {
    const edges = flow.getEdges() as Array<{ id: string; target: string; data?: ArtifactEdgeData }>
    const siblings = edges
      .filter(e => e.target === target && (e.data?.hasArtifact))
      .sort((a, b) => a.id.localeCompare(b.id))
    const idx = siblings.findIndex(e => e.id === id)
    if (idx >= 0 && siblings.length > 1) {
      // Center the stack around labelY: shift each badge by ~28px (badge height
      // including border + 4px gap) × (idx − (n-1)/2)
      const ROW = 28
      stackOffsetY = (idx - (siblings.length - 1) / 2) * ROW
    }
  } catch {
    // If useReactFlow isn't available in some test/edge context, fall back to 0.
    stackOffsetY = 0
  }

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

      {/* Artifact badge — Улучшатели#3 P2·S: now carries a descriptive
          tooltip and stacks vertically (4px gap) instead of overlapping
          when multiple badges share the same anchor. Iteration is shown
          as a small superscript inside the badge. */}
      {hasArtifact && config && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + stackOffsetY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan"
            title={tooltipText}
          >
            <div
              className={`
                px-2.5 py-1 rounded-full text-xs font-bold
                flex items-center gap-1
                border-2 shadow-md
                ${isAnimated ? 'animate-pulse' : ''}
              `}
              style={{
                backgroundColor: `${config.color}20`,
                borderColor: config.color,
                color: config.color,
              }}
              aria-label={tooltipText}
            >
              <span aria-hidden="true">{config.emoji}</span>
              <span>{edgeData?.label || config.label}</span>
              {typeof edgeData?.iteration === 'number' && edgeData.iteration > 0 && (
                <sup
                  className="text-[9px] font-bold ml-0.5 leading-none"
                  style={{ color: config.color }}
                >
                  {edgeData.iteration}
                </sup>
              )}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export default memo(ArtifactEdge)
