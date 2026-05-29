/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useViewport,
  useReactFlow,
  Panel,
  ConnectionMode,
  MarkerType,
  type NodeTypes,
  type EdgeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Play,
  Pause,
  Square,
  Download,
  MessageSquare,
  ChevronLeft,
  Loader2,
  Code,
  FileText,
  CheckCircle,
  X,
  Send,
  Eye,
  Terminal,
  Globe,
  RefreshCw,
  ExternalLink,
  GitBranch,
  Archive,
  FolderOpen,
  FilePlus,
  FileX,
  FileEdit,
  Palette,
  Cog as CogIcon,
  Shield,
  Sparkles,
  Copy,
  Wand2,
  ListChecks,
  Trash2,
  Edit3,
  Code2,
  Search,
  FileStack,
  Trophy,
  Check,
  Pencil,
  Plus,
  RotateCcw,
  Settings,
  UserPlus,
  XCircle,
  ChevronDown,
  ChevronRight,
  Maximize2,
  MoreHorizontal,
  BookmarkPlus,
  Lock,
  Unlock,
  HelpCircle,
  History,
  // КАО#VR-Wave1 Frontend — Visual Review skip-action icon.
  SkipForward,
} from 'lucide-react'
import notify from '../components/common/StyledToast'
// Улучшатели#3 wave 2 primitives + CodeBlock
import Modal from '../components/common/Modal'
import Button from '../components/common/Button'
import CodeBlock from '../components/common/CodeBlock'
import {
  getSession,
  startSession,
  pauseSession,
  resumeSession,
  cancelSession,
  getFinalResult,
  runFinalCode,
  bundleFinalCode,
  createWebSocket,
  downloadResultZip,
  createPullRequest,
  enhanceSession,
  getEnhancementSuggestions,
  applyEnhancements,
  completeSession,
  updateSession,
  resetSession,
  // КАО#VR-11 RestartFromScratch
  restartSession,
  refinalizeSession,
  addAgentConfig,
  updateAgentConfig,
  deleteAgentConfig,
  createIntervention,
  runCodeVersion,
  getSessionMetrics,
  listCheckpoints,
  createTemplateFromSession,
  // КАО#VR-Wave1 Frontend — Visual Review API.
  skipVisualReview,
  // VR-39 — per-enhancement attachments reuse the Specification upload pipeline.
  uploadFiles,
  fetchRepo,
} from '../services/api'
import type { CheckpointResponse } from '../services/api'
import type { SessionResponse, AgentConfigResponse, FinalResultResponse, ExecutionResult, ReconnectingWebSocket, WSConnectionState } from '../services/api'
import type { EnhancementSuggestion, CuratedSuggestion, EnhancerAgentConfig, EnhancerSummarizerConfig, EnhanceRequest, AttachmentInfo } from '../types'
import { useProvidersStore } from '../stores/providersStore'
import SpecificationsDialog from '../components/common/SpecificationsDialog'
import ConfirmDialog from '../components/common/ConfirmDialog'
import {
  setOnboardingSessionStatus,
  setOnboardingAgentStarted,
} from '../components/onboarding/OnboardingTour'
import {
  AgentNode,
  ArtifactEdge,
  DetailPanel,
  MetricsPanel,
  CompletionBanner,
  LegendPanel,
  GitPanel,
  // КАО#VR-Wave1 Frontend — Visual Review side-panel.
  VisualReviewPanel,
  type AgentNodeData,
} from '../components/graph'

// ── Viewport Bridge ──
// Reads viewport state inside <ReactFlow> and reports it up via a callback.
function ViewportBridge({ onChange }: { onChange: (vp: { x: number; y: number; zoom: number }) => void }) {
  const vp = useViewport()
  useEffect(() => {
    onChange(vp)
  }, [vp.x, vp.y, vp.zoom]) // eslint-disable-line react-hooks/exhaustive-deps
  return null
}

// ── Collapsible Settings Section ──
function SettingsSection({ title, defaultOpen = true, children }: { title: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden mb-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 bg-gray-700/50 hover:bg-gray-700 transition-colors"
      >
        <span className="text-sm font-medium text-gray-200">{title}</span>
        <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && <div className="px-3 py-2 space-y-3">{children}</div>}
    </div>
  )
}

// ── ReactFlow Instance Bridge ──
// Exposes the ReactFlow instance (setCenter, getNode, etc.) to the parent via a ref.
function ReactFlowBridge({ instanceRef }: { instanceRef: React.MutableRefObject<ReturnType<typeof useReactFlow> | null> }) {
  const instance = useReactFlow()
  useEffect(() => {
    instanceRef.current = instance
  }, [instance, instanceRef])
  return null
}

// ── WS Status Pill ──
// Улучшатели#3 P0·M — WS reconnect UI: small floating indicator that surfaces
// the live-feed connection state. Hidden when steady-connected; shown for
// connecting / reconnecting (with attempt counter) / disconnected (with retry).
function WSStatusPill({
  state,
  recentlyRecovered,
}: {
  state: WSConnectionState
  recentlyRecovered: boolean
}) {
  // Hide entirely when steady-connected (except for the brief recovery flash).
  if (state.status === 'connected' && !recentlyRecovered) return null

  // Position: top-right inside the graph container. z-20 keeps it above
  // the graph but below modals (z-50+). pointer-events on the wrapper are
  // disabled so the pane underneath remains draggable; only the pill itself
  // and its retry button accept clicks.
  const baseWrapper =
    'absolute top-3 right-3 z-20 pointer-events-none flex items-center'

  if (state.status === 'connected' && recentlyRecovered) {
    return (
      <div className={baseWrapper}>
        <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-cf-success/15 border border-cf-success/40 px-3 py-1.5 text-xs font-medium text-cf-success shadow-lg transition-opacity duration-200">
          <span className="inline-block w-2 h-2 rounded-full bg-cf-success" />
          <span>Connected</span>
        </div>
      </div>
    )
  }

  if (state.status === 'connecting') {
    return (
      <div className={baseWrapper}>
        <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-cf-panel/90 border border-cf-border px-3 py-1.5 text-xs font-medium text-cf-text-muted shadow-lg backdrop-blur">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>Connecting…</span>
        </div>
      </div>
    )
  }

  if (state.status === 'reconnecting') {
    const max = state.maxRetries
    // Use ∞ if the cap is very high; otherwise show the cap.
    const maxLabel = max >= 999 ? '∞' : String(max)
    return (
      <div className={baseWrapper}>
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-auto flex items-center gap-2 rounded-full bg-cf-warning/15 border border-cf-warning/50 px-3 py-1.5 text-xs font-medium text-cf-warning shadow-lg backdrop-blur"
        >
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>Reconnecting (attempt {state.attempt}/{maxLabel})…</span>
        </div>
      </div>
    )
  }

  // disconnected — terminal: invite user to refresh.
  return (
    <div className={baseWrapper}>
      <div
        role="alert"
        className="pointer-events-auto flex items-center gap-2 rounded-full bg-cf-error/15 border border-cf-error/50 px-3 py-1.5 text-xs font-medium text-cf-error shadow-lg backdrop-blur"
      >
        <XCircle className="w-3.5 h-3.5" />
        <span>Live feed disconnected</span>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="ml-1 inline-flex items-center gap-1 rounded-full bg-cf-error/25 hover:bg-cf-error/40 border border-cf-error/60 px-2 py-0.5 text-[11px] font-semibold text-cf-error transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      </div>
    </div>
  )
}

// ── Group Frames Overlay ──
// Rendered OUTSIDE <ReactFlow> so buttons aren't blocked by the pane grab handler.
function GroupFramesLayer({ viewport, nodes: allNodes, onAddCoder, onAddTester, onRemoveCoder, onRemoveTester, canModify, onGroupDragStart }: {
  viewport: { x: number; y: number; zoom: number }
  nodes: any[]
  onAddCoder: () => void
  onAddTester: () => void
  onRemoveCoder: () => void
  onRemoveTester: () => void
  canModify: boolean
  onGroupDragStart: (groupPrefix: string, e: React.MouseEvent) => void
}) {
  const { x: vx, y: vy, zoom } = viewport

  // PADDING must exceed AgentNode active-state glow extent (≤50px outside node bounds)
  // so the dashed frame visually encompasses the glow halo, not bisects it.
  const PADDING = 56
  const AGENT_NODE_W = 220
  const AGENT_NODE_H = 140

  const groups: { label: string; color: string; nodePrefix: string; showCount?: boolean; onAdd?: () => void; onRemove?: () => void; minCount?: number }[] = [
    { label: 'Coders', color: '#3B82F6', nodePrefix: 'coder-', showCount: true, onAdd: onAddCoder, onRemove: onRemoveCoder, minCount: 1 },
    { label: 'Testers', color: '#F59E0B', nodePrefix: 'tester-', showCount: true, onAdd: onAddTester, onRemove: onRemoveTester, minCount: 1 },
    { label: 'Enhancers', color: '#A855F7', nodePrefix: 'enhancer-' },
  ]

  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5, overflow: 'visible' }}>
      {groups.map(({ label, color, nodePrefix, showCount, onAdd, onRemove, minCount }) => {
        const groupNodes = allNodes.filter((n: any) => n.id.startsWith(nodePrefix))
        if (groupNodes.length === 0) return null

        const canRemove = minCount !== undefined && groupNodes.length > minCount
        const hasButtons = canModify && onAdd && onRemove

        // Compute bounding box in flow coordinates
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of groupNodes) {
          const nx = n.position.x
          const ny = n.position.y
          if (nx < minX) minX = nx
          if (ny < minY) minY = ny
          if (nx + AGENT_NODE_W > maxX) maxX = nx + AGENT_NODE_W
          if (ny + AGENT_NODE_H > maxY) maxY = ny + AGENT_NODE_H
        }

        // Add padding (in flow coordinates)
        minX -= PADDING
        minY -= PADDING
        maxX += PADDING
        maxY += PADDING

        // Convert to screen coordinates within the container
        const screenX = minX * zoom + vx
        const screenY = minY * zoom + vy
        const screenW = (maxX - minX) * zoom
        const screenH = (maxY - minY) * zoom

        const btnStyle = {
          backgroundColor: 'var(--cf-bg)',
          borderColor: `${color}50`,
          color,
          fontSize: Math.max(11 * zoom, 8),
          zIndex: 10,
        }

        // Build "drag handle" strips that cover empty space inside the frame
        // (between the dashed border and the nodes). Each strip catches mousedown
        // and triggers a whole-group drag, while leaving the nodes themselves
        // freely clickable / individually draggable.
        const sortedByY = [...groupNodes].sort((a, b) => a.position.y - b.position.y)
        const colLeft = (sortedByY[0].position.x - minX) * zoom
        const colRight = colLeft + AGENT_NODE_W * zoom
        const nodeYsRel = sortedByY.map(n => (n.position.y - minY) * zoom)
        const nodeHpx = AGENT_NODE_H * zoom

        const handleStripMouseDown = (e: React.MouseEvent) => {
          if (e.button !== 0) return  // left-click only
          e.preventDefault()
          e.stopPropagation()
          onGroupDragStart(nodePrefix, e)
        }
        const stripCommonStyle: React.CSSProperties = {
          pointerEvents: 'auto',
          cursor: 'grab',
        }

        // Edge-band width: thin slivers along the frame border. Bounded by the
        // PADDING zone so they never overlap any node (regardless of which
        // column the node sits in — fixes Enh. Summarizer being un-draggable
        // because its X column differs from D/F/S).
        const edgeBand = Math.max(8, Math.min(PADDING * zoom * 0.5, 28))

        // Strips: thin edges around the frame + column-bound top/bottom/between
        const strips: { key: string; style: React.CSSProperties }[] = [
          // Left edge band (thin sliver, not full-padding) — doesn't overlap
          // any node, leaves left-of-column space (where multi-column nodes
          // like Enh. Summarizer can sit) free for direct node drag.
          { key: 'L', style: { left: 0, top: 0, width: edgeBand, height: screenH } },
          // Right edge band
          { key: 'R', style: { left: screenW - edgeBand, top: 0, width: edgeBand, height: screenH } },
          // Above the first node, within the node column
          { key: 'T', style: { left: colLeft, top: 0, width: colRight - colLeft, height: nodeYsRel[0] } },
          // Below the last node, within the node column
          {
            key: 'B',
            style: {
              left: colLeft,
              top: nodeYsRel[nodeYsRel.length - 1] + nodeHpx,
              width: colRight - colLeft,
              height: screenH - (nodeYsRel[nodeYsRel.length - 1] + nodeHpx),
            },
          },
        ]
        for (let i = 0; i < sortedByY.length - 1; i++) {
          const top = nodeYsRel[i] + nodeHpx
          const bottom = nodeYsRel[i + 1]
          strips.push({
            key: `G${i}`,
            style: { left: colLeft, top, width: colRight - colLeft, height: bottom - top },
          })
        }

        // tour-anchor: tag frame so Tour 2 can highlight Coders / Testers groups.
        const tourAttr =
          nodePrefix === 'coder-' ? { 'data-tour': 'coders-group' }
            : nodePrefix === 'tester-' ? { 'data-tour': 'testers-group' }
            : {}

        return (
          <div
            key={label}
            className="absolute"
            style={{
              left: screenX,
              top: screenY,
              width: screenW,
              height: screenH,
            }}
            {...tourAttr}
          >
            {/* Drag strips (grab the group via click-and-hold on empty space) */}
            {strips.map(({ key, style }) => (
              <div
                key={key}
                className="absolute"
                style={{ ...stripCommonStyle, ...style }}
                onMouseDown={handleStripMouseDown}
                title="Drag to move group"
              />
            ))}
            {/* Frame border */}
            <div
              className="absolute inset-0 rounded-xl border-2 border-dashed pointer-events-none"
              style={{ borderColor: `${color}40` }}
            />
            {/* Label at top */}
            <div
              className="absolute left-3 px-2 text-xs font-bold uppercase tracking-wider pointer-events-none"
              style={{
                color,
                backgroundColor: 'var(--cf-bg)',
                top: -Math.min(10 * zoom, 10),
                fontSize: Math.max(10 * zoom, 8),
              }}
            >
              {label}{showCount && <span className="font-normal opacity-60"> ({groupNodes.length})</span>}
            </div>
            {/* + / − buttons at bottom (only for groups with add/remove) */}
            {hasButtons && (
              <div
                className="pointer-events-auto absolute left-1/2 -translate-x-1/2 flex items-center gap-1"
                style={{ bottom: -Math.min(12 * zoom, 12) }}
              >
                <button
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); onRemove!() }}
                  disabled={!canRemove}
                  className="flex items-center justify-center w-6 h-6 rounded-full font-bold transition-all duration-200 hover:scale-110 border cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:scale-100"
                  style={btnStyle}
                  title={`Remove last ${label.slice(0, -1).toLowerCase()}`}
                >
                  −
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); onAdd!() }}
                  className="flex items-center justify-center w-6 h-6 rounded-full font-bold transition-all duration-200 hover:scale-110 border cursor-pointer"
                  style={btnStyle}
                  title={`Add ${label.slice(0, -1).toLowerCase()}`}
                >
                  +
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Register custom node and edge types
const nodeTypes: NodeTypes = {
  agentNode: AgentNode,
}

const edgeTypes: EdgeTypes = {
  artifactEdge: ArtifactEdge,
}

// Graph layout constants
const NODE_WIDTH = 220
// HORIZONTAL_GAP must be > 2 * GroupFramesLayer.PADDING (56) so adjacent
// group frames don't overlap each other. 160px gives ~48px margin between frames.
const HORIZONTAL_GAP = 160
// VERTICAL_GAP between successive nodes in the same column (= spacing between
// their top-left corners). AgentNode height is 140px, so the visible gap
// between node edges = VERTICAL_GAP - 140. 160 → 20px gap (compact but legible).
const VERTICAL_GAP = 160
const START_X = 80
const START_Y = 100

// --- Browser execution helpers ---
const BROWSER_LANGUAGES = new Set(['javascript_browser', 'typescript_browser', 'javascript', 'typescript', 'html', 'htm'])

function isBrowserRunnable(language: string): boolean {
  return BROWSER_LANGUAGES.has(language?.toLowerCase?.() || '')
}

// Detect Node.js code that cannot run in a browser
function isNodeJsCode(code: string): boolean {
  // Check for common Node.js patterns
  const nodePatterns = [
    /\brequire\s*\(\s*['"][^'"]*['"]\s*\)/,        // require('...')
    /\bmodule\.exports\b/,                           // module.exports
    /\bprocess\.\w+/,                                // process.* (any property)
    /\bfs\.(read|write|exists|mkdir|unlink|stat)/,   // fs.*
    /\bpath\.(join|resolve|dirname|basename)\b/,     // path.*
    /\b__dirname\b/,                                 // __dirname
    /\b__filename\b/,                                // __filename
    /^#!\/usr\/bin\/env\s+node/m,                    // shebang
    /\bsetImmediate\b/,                              // Node.js global
    /\bBuffer\.(from|alloc|concat)\b/,               // Buffer API
    /\bchild_process\b/,                             // child_process module
    /\bhttp\.(createServer|request|get)\b/,          // http module
    /\bnet\.(createServer|createConnection)\b/,      // net module
  ]
  return nodePatterns.some(p => p.test(code))
}

// Detect browser/DOM code — even if it also has Node.js patterns
function isBrowserDomCode(code: string): boolean {
  const browserPatterns = [
    /\bdocument\.(getElementById|querySelector|createElement|body|head)\b/,
    /\bwindow\.(addEventListener|innerWidth|innerHeight|requestAnimationFrame)\b/,
    /\bcanvas\b/i,
    /\bgetContext\s*\(\s*['"]2d['"]\s*\)/,
    /\bgetContext\s*\(\s*['"]webgl['"]\s*\)/i,
    /\brequestAnimationFrame\b/,
    /\baddEventListener\b/,
    /\binnerHTML\b/,
    /\bclassList\b/,
    /\bstyle\.\w/,
    /\bTHREE\b/,
    /\bp5\b/,
    /\bd3\.\w/,
  ]
  const matchCount = browserPatterns.filter(p => p.test(code)).length
  return matchCount >= 2
}

// Detect terminal-only code (ANSI animations, raw terminal I/O)
// These programs are designed for interactive terminals and cannot produce
// meaningful output when run headless in a sandbox.
function isTerminalAnimationCode(code: string): boolean {
  const ansiEscape = /\\x1b\[|\\033\[|\\u001b\[/    // ANSI escape sequences
  const cursorControl = /\?(25|47|1049)[hl]/          // hide/show cursor, alt screen
  const rawMode = /setRawMode\s*\(\s*true\s*\)/       // stdin raw mode
  const stdoutWrite = /process\.stdout\.write/         // direct terminal writes
  const terminalSize = /process\.stdout\.(columns|rows)/ // terminal size queries
  const brailleChars = /[\u2800-\u28FF]|BRAILLE/i     // braille unicode for terminal graphics

  const signals = [
    ansiEscape.test(code),
    cursorControl.test(code),
    rawMode.test(code),
    stdoutWrite.test(code),
    terminalSize.test(code),
    brailleChars.test(code),
  ]
  // If 2+ terminal-specific signals and no browser DOM → terminal animation
  return signals.filter(Boolean).length >= 2
}

// Build an informative page for terminal animation code
function buildTerminalAnimationHtml(code: string): string {
  // Try to extract a description from comments
  const commentMatch = code.match(/\/\*\*?\s*\n?\s*\*?\s*(.+?)(?:\n|\*\/)/)?.[1]?.trim() || ''
  const desc = commentMatch
    ? commentMatch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    : 'Interactive terminal visualization'

  // Detect features
  const features: string[] = []
  if (/setInterval|setTimeout|setImmediate/.test(code)) features.push('Real-time animation loop')
  if (/process\.stdout\.write/.test(code)) features.push('Direct terminal rendering')
  if (/BRAILLE|[\u2800-\u28FF]/.test(code)) features.push('Braille character graphics')
  if (/setRawMode/.test(code)) features.push('Keyboard input handling')
  if (/\\x1b\[|\\033\[/.test(code)) features.push('ANSI color & cursor control')
  if (/process\.stdout\.(columns|rows)/.test(code)) features.push('Adaptive terminal sizing')

  const featureList = features.map(f =>
    `<li style="margin:6px 0;padding-left:8px;color:#d1d5db;">
      <span style="color:#a78bfa;margin-right:8px;">&#x2713;</span>${f}
    </li>`
  ).join('')

  const lines = code.split('\n').length

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f172a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #e2e8f0; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { max-width: 520px; width: 90%; padding: 40px; text-align: center; }
  .icon { font-size: 56px; margin-bottom: 16px; }
  .title { font-size: 20px; font-weight: 700; color: #f8fafc; margin-bottom: 8px; }
  .subtitle { font-size: 14px; color: #94a3b8; margin-bottom: 24px; line-height: 1.5; }
  .desc { font-size: 13px; color: #a78bfa; margin-bottom: 20px; font-style: italic; }
  .features { text-align: left; list-style: none; padding: 16px 20px; background: #1e293b; border-radius: 12px; margin-bottom: 24px; border: 1px solid #334155; }
  .features-title { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #64748b; margin-bottom: 8px; font-weight: 600; }
  .run-cmd { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 12px 16px; font-family: 'SF Mono', Consolas, monospace; font-size: 13px; color: #a5f3fc; text-align: left; margin-bottom: 8px; }
  .hint { font-size: 12px; color: #64748b; margin-top: 4px; }
  .badge { display: inline-block; background: linear-gradient(135deg, #7c3aed, #a855f7); padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 600; color: white; margin-bottom: 16px; letter-spacing: 0.5px; }
  .meta { font-size: 12px; color: #475569; margin-top: 16px; }
</style>
</head><body>
  <div class="card">
    <div class="icon">🖥️</div>
    <div class="badge">TERMINAL APPLICATION</div>
    <div class="title">This code is a terminal animation</div>
    <div class="subtitle">It uses ANSI escape codes and direct terminal I/O to render graphics in a terminal window. It cannot display output in a browser preview.</div>
    ${desc ? `<div class="desc">"${desc}"</div>` : ''}
    ${featureList ? `<div class="features"><div class="features-title">Detected Features</div><ul>${featureList}</ul></div>` : ''}
    <div style="font-size:13px;color:#94a3b8;margin-bottom:12px;">To run this code, download it and execute in a terminal:</div>
    <div class="run-cmd">
      <span style="color:#64748b;">$</span> node script.js
    </div>
    <div class="hint">Use the download button (↓) to save the code file</div>
    <div class="meta">${lines} lines of code</div>
  </div>
</body></html>`
}

// Build a nice HTML page to display execution output
function buildOutputHtml(stdout: string, stderr: string, loading = false, result?: any): string {
  const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

  // Simple Markdown → HTML renderer
  function renderMarkdown(text: string): string {
    let html = escHtml(text)

    // Code blocks (``` ... ```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
      `<pre style="background:#1e1e2e;color:#cdd6f4;padding:12px 16px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.5;margin:12px 0;">${code.trim()}</pre>`)

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code style="background:#e2e8f0;color:#1e293b;padding:2px 6px;border-radius:4px;font-size:0.9em;">$1</code>')

    // Headings
    html = html.replace(/^### (.+)$/gm, '<h3 style="font-size:16px;font-weight:600;color:#1e293b;margin:20px 0 8px 0;border-bottom:1px solid #e2e8f0;padding-bottom:4px;">$1</h3>')
    html = html.replace(/^## (.+)$/gm, '<h2 style="font-size:18px;font-weight:700;color:#0f172a;margin:24px 0 10px 0;border-bottom:2px solid #e2e8f0;padding-bottom:6px;">$1</h2>')
    html = html.replace(/^# (.+)$/gm, '<h1 style="font-size:22px;font-weight:800;color:#0f172a;margin:28px 0 12px 0;border-bottom:2px solid #3b82f6;padding-bottom:8px;">$1</h1>')

    // Bold and italic
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')

    // Unordered lists
    html = html.replace(/^- (.+)$/gm, '<li style="margin:4px 0;padding-left:4px;">$1</li>')
    html = html.replace(/(<li[^>]*>.*<\/li>\n?)+/g, (match) =>
      `<ul style="margin:8px 0;padding-left:20px;list-style:disc;">${match}</ul>`)

    // Horizontal rules
    html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0;">')

    // Paragraphs (double newlines)
    html = html.replace(/\n\n/g, '</p><p style="margin:8px 0;line-height:1.6;">')

    // Single newlines within paragraphs
    html = html.replace(/\n/g, '<br>')

    return `<p style="margin:8px 0;line-height:1.6;">${html}</p>`
  }

  const statusLabel = result
    ? result.success
      ? 'Success'
      : result.timeout_exceeded
        ? 'Timed Out'
        : 'Failed'
    : ''

  const statusBar = result ? `
    <div style="display:flex;align-items:center;gap:16px;padding:8px 20px;background:${result.success ? '#f0fdf4' : result.timeout_exceeded ? '#fffbeb' : '#fef2f2'};border-bottom:1px solid ${result.success ? '#bbf7d0' : result.timeout_exceeded ? '#fde68a' : '#fecaca'};font-size:12px;flex-wrap:wrap;">
      <span style="color:${result.success ? '#16a34a' : result.timeout_exceeded ? '#d97706' : '#dc2626'};font-weight:600;">● ${statusLabel} (exit ${result.exit_code})</span>
      ${result.execution_time_ms ? `<span style="color:#6b7280">⏱ ${(result.execution_time_ms / 1000).toFixed(1)}s</span>` : ''}
      ${result.memory_used_mb ? `<span style="color:#6b7280">💾 ${result.memory_used_mb.toFixed(1)}MB</span>` : ''}
      ${result.error ? `<span style="color:#dc2626;font-style:italic;">${escHtml(result.error)}</span>` : ''}
    </div>` : ''

  // Render stdout as markdown document
  const stdoutSection = stdout && !loading ? renderMarkdown(stdout) : (loading ? '' : '')

  const stderrSection = stderr ? `
    <div style="margin-top:16px;padding:12px 16px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;">
      <div style="color:#dc2626;font-size:11px;font-weight:600;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">stderr</div>
      <pre style="margin:0;color:#991b1b;white-space:pre-wrap;word-break:break-word;font-size:13px;font-family:'SF Mono',Consolas,monospace;">${escHtml(stderr)}</pre>
    </div>` : ''

  const loadingHtml = loading ? `
    <div style="padding:60px 40px;text-align:center;">
      <div style="font-size:32px;margin-bottom:12px;">⏳</div>
      <div style="color:#6b7280;font-size:15px;">${escHtml(stdout || 'Executing in sandbox...')}</div>
    </div>` : ''

  const emptyMessage = result?.timeout_exceeded
    ? 'Execution timed out — the program may contain an infinite loop or long-running operation.'
    : result && !result.success
      ? result.error || 'No output (program exited with an error)'
      : 'No output'

  const emptyHtml = !loading && !stdout && !stderr ? `
    <div style="padding:60px 40px;text-align:center;">
      <div style="font-size:32px;margin-bottom:12px;">${result?.timeout_exceeded ? '⏱️' : result && !result.success ? '⚠️' : '📭'}</div>
      <div style="color:#9ca3af;font-size:15px;">${escHtml(emptyMessage)}</div>
    </div>` : ''

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #ffffff; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 14px; color: #334155; }
  .content { padding: 20px 24px; max-width: 100%; }
</style>
</head><body>${statusBar}${loadingHtml}<div class="content">${stdoutSection}${stderrSection}${emptyHtml}</div></body></html>`
}

function wrapCodeForBrowser(code: string, language: string): string {
  const trimmed = code.trim()

  // Already a complete HTML page — use as-is
  if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) {
    return trimmed
  }

  const lang = language.toLowerCase()

  // Escape code so </script> inside user code doesn't break the HTML parser
  // Replace </script with <\/script in string context
  const safeCode = code.replace(/<\/script/gi, '<\\/script')

  // Console capture + error display (injected BEFORE user code so it intercepts everything)
  const consoleCaptureInline = `
(function() {
  var el = document.getElementById('__console');
  var hasDOM = false;
  var lines = [];
  function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function fmt(args) {
    return Array.from(args).map(function(a) {
      if (a === null) return 'null';
      if (a === undefined) return 'undefined';
      if (typeof a === 'object') { try { return JSON.stringify(a, null, 2); } catch(e) { return String(a); } }
      return String(a);
    }).join(' ');
  }
  function addLine(text, color) {
    lines.push('<span style="color:' + color + '">' + esc(text) + '<\\/span>');
    if (!hasDOM) { el.style.display = 'block'; }
    el.innerHTML = lines.join('\\n');
    el.scrollTop = el.scrollHeight;
  }
  var orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log = function() { orig.log.apply(console, arguments); addLine(fmt(arguments), '#cdd6f4'); };
  console.warn = function() { orig.warn.apply(console, arguments); addLine(fmt(arguments), '#f9e2af'); };
  console.error = function() { orig.error.apply(console, arguments); addLine(fmt(arguments), '#f38ba8'); };
  console.info = function() { orig.info.apply(console, arguments); addLine(fmt(arguments), '#89b4fa'); };
  window.onerror = function(msg, src, line, col, err) {
    addLine('Error: ' + msg + (line ? ' (line ' + line + ')' : ''), '#f38ba8');
  };
  window.addEventListener('unhandledrejection', function(e) {
    addLine('Unhandled Promise: ' + (e.reason || e), '#f38ba8');
  });
  setTimeout(function() {
    var body = document.body;
    var children = body.children;
    for (var i = 0; i < children.length; i++) {
      if (children[i].id === '__console') continue;
      if (children[i].id === 'root' || children[i].id === 'app') {
        if (children[i].innerHTML.trim()) { hasDOM = true; break; }
        continue;
      }
      hasDOM = true; break;
    }
    if (hasDOM && lines.length > 0) {
      el.style.display = 'block';
      el.style.height = 'auto';
      el.style.maxHeight = '300px';
      el.style.borderTop = '1px solid #45475a';
    } else if (hasDOM) {
      el.style.display = 'none';
    }
  }, 500);
})();`

  // For Node.js-style code: detect require/process/module.exports and show helpful message
  const nodeDetect = `
try {
  if (typeof require === 'undefined') {
    window.require = function(mod) {
      console.error('require("' + mod + '") is not available in browser. Use "Run Headless" for Node.js code.');
      return {};
    };
  }
  if (typeof process === 'undefined') {
    window.process = { argv: [], env: {}, exit: function() {}, stdout: { write: function(s) { console.log(s); } } };
  }
} catch(e) {}`

  // TypeScript — use Babel standalone to transpile in-browser
  if (lang === 'typescript') {
    return [
      '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '<title>CodeForge Preview</title>',
      '<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif}#root,#app{width:100%}</style>',
      '<script src="https://unpkg.com/@babel/standalone@7/babel.min.js"></scr' + 'ipt>',
      '</head><body>',
      '<div id="root"></div><div id="app"></div>',
      '<div id="__console" style="display:none;font-family:\'SF Mono\',Consolas,monospace;font-size:13px;padding:16px;background:#1e1e2e;color:#cdd6f4;white-space:pre-wrap;word-break:break-word;line-height:1.6;overflow:auto;height:100vh;margin:0"></div>',
      '<script>' + consoleCaptureInline + '</scr' + 'ipt>',
      '<script>' + nodeDetect + '</scr' + 'ipt>',
      '<script type="text/babel" data-presets="typescript">' + safeCode + '</scr' + 'ipt>',
      '</body></html>'
    ].join('\n')
  }

  // JavaScript — wrapper with console capture
  if (lang === 'javascript') {
    return [
      '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      '<title>CodeForge Preview</title>',
      '<style>*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,sans-serif}#root,#app{width:100%}</style>',
      '</head><body>',
      '<div id="root"></div><div id="app"></div>',
      '<div id="__console" style="display:none;font-family:\'SF Mono\',Consolas,monospace;font-size:13px;padding:16px;background:#1e1e2e;color:#cdd6f4;white-space:pre-wrap;word-break:break-word;line-height:1.6;overflow:auto;height:100vh;margin:0"></div>',
      '<script>' + consoleCaptureInline + '</scr' + 'ipt>',
      '<script>' + nodeDetect + '</scr' + 'ipt>',
      '<script>' + safeCode + '</scr' + 'ipt>',
      '</body></html>'
    ].join('\n')
  }

  // Fallback — treat as HTML fragment
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CodeForge Preview</title>
</head>
<body>
${code}
</body>
</html>`
}

interface WorkflowState {
  iteration: number
  phase: string
  codersDone: number
  testersDone: number
  totalTokens: number
  totalCost: number
  criticalIssues: number
  seriousIssues: number
  codeVersions: Record<number, string>
  finishedCoders: Set<number>  // Coders that finished (no issues or max iterations)
  coderIterations: Record<number, number>  // Per-coder iteration counts
  coderFinishReasons: Record<number, string>  // Why each coder finished
  activeCoderCount: number  // Number of active coders being tested (for tester completion tracking)
  testerCompletions: Record<number, number>  // Per-tester: how many coder audits completed
}

// Agent metadata for config popup
const agentPopupMeta: Record<string, { icon: React.ElementType; label: string; gradient: string }> = {
  coder: { icon: Code2, label: 'Coder', gradient: 'from-blue-600 to-indigo-700' },
  tester: { icon: Search, label: 'Tester', gradient: 'from-amber-500 to-orange-600' },
  summarizer: { icon: FileStack, label: 'Summarizer', gradient: 'from-purple-600 to-violet-700' },
  finalizer: { icon: Trophy, label: 'Finalizer', gradient: 'from-emerald-500 to-teal-600' },
  enhancer_design: { icon: Palette, label: 'Design', gradient: 'from-pink-500 to-rose-600' },
  enhancer_func: { icon: CogIcon, label: 'Functionality', gradient: 'from-cyan-500 to-blue-600' },
  enhancer_security: { icon: Shield, label: 'Security', gradient: 'from-red-500 to-orange-600' },
  enhancer_summary: { icon: Sparkles, label: 'Enh. Summarizer', gradient: 'from-fuchsia-500 to-purple-600' },
}

// Floating config popup for agent nodes (provider/model selector)
const THINKING_EFFORT_OPTIONS = [
  { value: '', label: 'Auto' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

function AgentConfigPopup({ agentType, x, y, existingConfig, onClose, onSave }: {
  agentType: string; x: number; y: number;
  existingConfig?: { llm_provider: string; llm_model: string; thinking_effort?: string | null; custom_prompt?: string | null; enabled?: boolean; temperature?: number; max_tokens?: number };
  onClose: () => void;
  onSave?: (config: { provider: string; model: string; thinkingEffort: string; enabled: boolean; instruction: string; temperature: number; maxTokens: number }) => void
}) {
  const meta = agentPopupMeta[agentType]
  const isEnhancerAgent = agentType.startsWith('enhancer_') && agentType !== 'enhancer_summary'
  const Icon = meta?.icon || Sparkles

  const { providers, loading: storeLoading, fetchProviders } = useProvidersStore()
  // For enhancer agents: enabled state comes from the DB field (defaults to true)
  const [enabled, setEnabled] = useState(existingConfig?.enabled !== false)
  const [provider, setProvider] = useState(existingConfig?.llm_provider || '')
  const [model, setModel] = useState(existingConfig?.llm_model || '')
  const [thinkingEffort, setThinkingEffort] = useState(existingConfig?.thinking_effort || '')
  const [instruction, setInstruction] = useState(existingConfig?.custom_prompt || '')
  const [temperature, setTemperature] = useState<number>(
    typeof existingConfig?.temperature === 'number' ? existingConfig.temperature : 0.7
  )
  const [maxTokens, setMaxTokens] = useState<number>(
    typeof existingConfig?.max_tokens === 'number' ? existingConfig.max_tokens : 4096
  )
  const loading = storeLoading && providers.length === 0

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  // Set initial provider/model when providers load (only if not pre-populated)
  useEffect(() => {
    if (providers.length > 0 && !provider) {
      setProvider(providers[0].name)
      setModel(providers[0].models[0] || '')
    }
  }, [providers, provider])

  const currentProvider = providers.find(p => p.name === provider)
  const modelsForProvider = currentProvider?.models || []

  // Get thinking effort options for selected model from provider capabilities
  const modelCaps = currentProvider?.model_capabilities?.[model]
  const supportedEfforts = modelCaps?.thinking_effort_options || []
  const effortOptions = [
    { value: '', label: 'Auto' },
    ...THINKING_EFFORT_OPTIONS.filter(o => o.value && supportedEfforts.includes(o.value)),
  ]
  // If no efforts supported, show only "None"
  const finalEffortOptions = supportedEfforts.length > 0
    ? effortOptions
    : [{ value: '', label: 'N/A' }]

  // Auto-reposition if popup overflows the container (run once on mount)
  const popupRef = useRef<HTMLDivElement>(null)
  const repositioned = useRef(false)

  useEffect(() => {
    if (repositioned.current) return
    const el = popupRef.current
    if (!el) return
    repositioned.current = true
    const parent = el.offsetParent as HTMLElement | null
    if (!parent) return
    const parentRect = parent.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    let newTop = y
    let newLeft = x
    if (elRect.bottom > parentRect.bottom - 8) {
      newTop = Math.max(8, parentRect.height - elRect.height - 8)
    }
    if (elRect.right > parentRect.right - 8) {
      newLeft = Math.max(8, parentRect.width - elRect.width - 8)
    }
    if (newTop !== y || newLeft !== x) {
      el.style.left = newLeft + 'px'
      el.style.top = newTop + 'px'
    }
  }, [])  // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={popupRef}
      className="absolute z-50 w-72 bg-gray-800 border border-gray-600 rounded-xl p-3 flex flex-col gap-2.5 shadow-xl shadow-black/40 max-h-[calc(100vh-80px)] overflow-y-auto"
      style={{ left: x, top: y }}
      onClick={e => e.stopPropagation()}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`p-1 rounded-lg bg-gradient-to-br ${meta?.gradient || 'from-purple-500 to-purple-700'}`}>
            <Icon className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="text-sm font-semibold text-white">{meta?.label || 'Agent'}</span>
        </div>
        <button onClick={onClose} className="p-0.5 rounded hover:bg-gray-700 transition-colors">
          <X className="w-3.5 h-3.5 text-gray-400" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-3">
          <Loader2 className="w-4 h-4 animate-spin text-purple-400" />
        </div>
      ) : (
        <>
          {/* Enabled toggle */}
          {isEnhancerAgent && (
            <label className="flex items-center justify-between cursor-pointer py-1">
              <span className="text-xs font-medium text-gray-400">Enabled</span>
              <div className="relative">
                <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="sr-only peer" />
                <div className="w-8 h-4 bg-gray-700 rounded-full peer peer-checked:bg-purple-600 transition-colors after:content-[''] after:absolute after:top-0.5 after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-[16px]" />
              </div>
            </label>
          )}

          {/* Provider */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1" htmlFor="agent-provider-select">Provider</label>
            <select
              id="agent-provider-select"
              value={provider}
              onChange={e => {
                const p = e.target.value
                setProvider(p)
                const prov = providers.find(pr => pr.name === p)
                const models = prov?.models || []
                const firstModel = models[0] || ''
                setModel(firstModel)
                // Reset thinking effort to Auto when switching provider
                setThinkingEffort('')
              }}
              aria-label="LLM provider"
              className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
            >
              {providers.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1" htmlFor="agent-model-select">Model</label>
            <select
              id="agent-model-select"
              value={model}
              onChange={e => {
                setModel(e.target.value)
                // Reset thinking effort when model changes
                setThinkingEffort('')
              }}
              aria-label="LLM model"
              className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
            >
              {modelsForProvider.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* Thinking Effort */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1" htmlFor="agent-thinking-effort-select">Thinking Effort</label>
            <select
              id="agent-thinking-effort-select"
              value={thinkingEffort}
              onChange={e => setThinkingEffort(e.target.value)}
              disabled={supportedEfforts.length === 0}
              aria-label="Thinking effort"
              className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {finalEffortOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            {thinkingEffort === 'max' && !/opus/i.test(model) && (
              <div className="mt-1 text-[10px] text-amber-400 leading-tight">
                Max effort only supported on Opus models
              </div>
            )}
          </div>

          {/* Temperature & Max Tokens */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Temperature</label>
              <input
                type="number"
                min={0}
                max={1}
                step={0.1}
                value={temperature}
                onChange={e => {
                  const v = parseFloat(e.target.value)
                  setTemperature(Number.isFinite(v) ? v : 0.7)
                }}
                className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Max Tokens</label>
              <input
                type="number"
                min={1000}
                max={128000}
                step={1000}
                value={maxTokens}
                onChange={e => {
                  const v = parseInt(e.target.value, 10)
                  setMaxTokens(Number.isFinite(v) ? v : 4096)
                }}
                className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
          </div>

          {/* Custom Prompt (all agents) */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">
              {isEnhancerAgent ? 'Instructions' : 'Custom Prompt (optional)'}
            </label>
            <textarea
              value={instruction}
              onChange={e => setInstruction(e.target.value)}
              placeholder={isEnhancerAgent ? 'Custom instructions...' : 'Override default system prompt (leave empty to use default)'}
              rows={isEnhancerAgent ? 3 : 5}
              className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-xs text-white placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500"
            />
          </div>

          {/* OK button */}
          <button
            onClick={() => {
              onSave?.({ provider, model, thinkingEffort, enabled, instruction, temperature, maxTokens })
              onClose()
            }}
            className="w-full py-1.5 bg-indigo-600 hover:bg-indigo-700 rounded-lg text-xs font-medium text-white transition-colors"
          >
            OK
          </button>
        </>
      )}
    </div>
  )
}

/** Format agent type + index into a human-readable label, e.g. "Coder 1" */
function formatAgentLabel(agentType: string, agentIndex?: number): string {
  const names: Record<string, string> = {
    coder: 'Coder',
    tester: 'Tester',
    summarizer: 'Summarizer',
    finalizer: 'Finalizer',
    enhancer_design: 'Design Enhancer',
    enhancer_func: 'Functional Enhancer',
    enhancer_security: 'Security Enhancer',
    enhancer_summary: 'Enhancement Summarizer',
  }
  const name = names[agentType] || agentType.charAt(0).toUpperCase() + agentType.slice(1)
  return agentIndex != null ? `${name} ${agentIndex + 1}` : name
}

/** Shorten raw API error messages for toast display */
function formatErrorForToast(raw: string, maxLen = 150): string {
  if (!raw) return 'Unknown error'

  // Extract the core message from common error patterns
  // e.g. "Error code: 404 - {'error': {'message': 'This is not a chat model...', ...}}"
  const jsonMatch = raw.match(/'message':\s*'([^']+)'/)
  if (jsonMatch) return jsonMatch[1].slice(0, maxLen)

  // JSON "message" field: {"error": {"message": "..."}}
  const jsonQuoteMatch = raw.match(/"message":\s*"([^"]+)"/)
  if (jsonQuoteMatch) return jsonQuoteMatch[1].slice(0, maxLen)

  // "Model 'xxx' not supported by provider 'yyy'. Available: [...]"
  const modelMatch = raw.match(/Model '([^']+)' not supported by provider '([^']+)'/)
  if (modelMatch) return `Model "${modelMatch[1]}" is not available for ${modelMatch[2]}. Check agent settings.`

  // Credit / billing errors
  if (/credit|balance|billing|payment|quota/i.test(raw)) {
    const providerMatch = raw.match(/(anthropic|openai|google|grok|xai)/i)
    const provider = providerMatch ? providerMatch[1] : 'API'
    return `Insufficient ${provider} credit. Please check your billing settings at the provider's dashboard.`
  }

  // Rate limit
  if (/rate.?limit|too many requests|429/i.test(raw)) {
    return 'Rate limit reached. Please wait a moment and try again.'
  }

  // Overloaded / 529
  if (/overloaded|529|capacity/i.test(raw)) {
    return 'API server is overloaded. Please try again in a few minutes.'
  }

  // Timeout
  if (/timed?\s*out|timeout/i.test(raw)) {
    return 'Request timed out. Try reducing thinking effort or max tokens.'
  }

  // Connection error
  if (/connect|network|ECONNREFUSED|ENOTFOUND/i.test(raw)) {
    return 'Connection failed. Check your network and API settings.'
  }

  // Strip JSON objects, error codes, and excessive whitespace
  const cleaned = raw
    .replace(/Error code:\s*\d+\s*-?\s*/g, '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned
}

// КАО#VR-26 — Workflow-phase back-fill map. Exported so the regression suite
// (kao_vr25_to_27.test.tsx) can runtime-validate the agent_type → phase pairs
// instead of relying on fragile static greps. Used inside the `agent_started`
// WebSocket handler below to recover the phase pill when `phase_started` was
// dropped (e.g. WS disconnect during the Visual Review pause).
export const PHASE_BY_AGENT = {
  coder: 'coding',
  tester: 'testing',
  summarizer: 'summarizing',
  finalizer: 'finalizing',
  enhancer: 'enhancing',
  enhancer_summarizer: 'enhancing',
} as const

export default function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const wsRef = useRef<ReconnectingWebSocket | null>(null)
  const reactFlowContainerRef = useRef<HTMLDivElement>(null)
  const reactFlowInstanceRef = useRef<ReturnType<typeof useReactFlow> | null>(null)

  const [session, setSession] = useState<SessionResponse | null>(null)
  const [loading, setLoading] = useState(true)

  // Publish session status to the onboarding tour orchestrator so it can
  // pick the right tour (anatomy / live / done). Inert if no tour is pending.
  useEffect(() => {
    if (session) {
      setOnboardingSessionStatus(session.status as any)
    } else {
      setOnboardingSessionStatus(null)
    }
    return () => {
      // Clear when leaving the page so the welcome tour on /sessions doesn't
      // get tripped by a stale session_anatomy hint.
      setOnboardingSessionStatus(null)
    }
  }, [session?.status, session?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const [actionLoading, setActionLoading] = useState(false)
  const [finalResult, setFinalResult] = useState<FinalResultResponse | null>(null)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  // Save-as-template dialog state
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [templateDescription, setTemplateDescription] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const [showRefinalizeConfirm, setShowRefinalizeConfirm] = useState(false)
  // КАО#VR-11 RestartFromScratch — confirm dialog for the "restart from scratch" action.
  const [showRestartConfirm, setShowRestartConfirm] = useState(false)

  // UI state
  const [showCode, setShowCode] = useState(false)
  const [showPRModal, setShowPRModal] = useState(false)
  const [prToken, setPRToken] = useState('')
  const [prBranch, setPRBranch] = useState('codeforge/improvements')
  const [prTitle, setPRTitle] = useState('CodeForge: Code Improvements')
  const [prLoading, setPRLoading] = useState(false)
  const [prResult, setPRResult] = useState<{ pr_url: string; pr_number: number } | null>(null)
  const [showGitPanel, setShowGitPanel] = useState(false)
  const [showIntervention, setShowIntervention] = useState(false)
  const [interventionText, setInterventionText] = useState('')
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [selectedNodeData, setSelectedNodeData] = useState<AgentNodeData | null>(null)
  const [agentConfigPopup, setAgentConfigPopup] = useState<{ nodeId: string; agentType: string; agentIndex?: number; x: number; y: number } | null>(null)

  // Settings modal state
  const [showSettings, setShowSettings] = useState(false)

  // Execution state (Run Code feature)
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null)
  const [showExecution, setShowExecution] = useState(false)
  const [executing, setExecuting] = useState(false)

  // Browser preview state (Run in Browser)
  const [showBrowserPreview, setShowBrowserPreview] = useState(false)
  const [browserPreviewHtml, setBrowserPreviewHtml] = useState<string>('')
  const [browserPreviewKey, setBrowserPreviewKey] = useState(0) // for iframe refresh
  const sandboxIframeRef = useRef<HTMLIFrameElement | null>(null)

  // Enhancement workflow state
  const [showEnhancementReview, setShowEnhancementReview] = useState(false)
  const [enhancementSuggestions, setEnhancementSuggestions] = useState<EnhancementSuggestion[]>([])
  const [curatedItems, setCuratedItems] = useState<(CuratedSuggestion & { selected: boolean; editing: boolean })[]>([])
  const [enhancementLoading, setEnhancementLoading] = useState(false)
  // VR-36 — ref-guard against duplicate Enhance clicks (covers the 16 ms gap
  // between onClick fire and React applying setEnhancementLoading(true)).
  const enhancementInflightRef = useRef(false)

  // Workflow tracking state
  const [workflowState, setWorkflowState] = useState<WorkflowState>({
    iteration: 0,
    phase: 'idle',
    codersDone: 0,
    testersDone: 0,
    totalTokens: 0,
    totalCost: 0,
    criticalIssues: 0,
    seriousIssues: 0,
    codeVersions: {},
    finishedCoders: new Set(),
    coderIterations: {},
    coderFinishReasons: {},
    activeCoderCount: 0,
    testerCompletions: {},
  })

  // Crash-recovery checkpoints (read-only listing)
  const [checkpoints, setCheckpoints] = useState<CheckpointResponse[]>([])

  // Editable title state
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Specifications dialog state
  const [showSpecificationsDialog, setShowSpecificationsDialog] = useState(false)

  // Улучшатели#3 P0·M — WS reconnect UI: live WebSocket connection state.
  // Drives the status pill + dimmed overlay so users know the live feed
  // is reconnecting/dead (previously only logged to console).
  const [wsState, setWsState] = useState<WSConnectionState>({
    status: 'connecting',
    attempt: 0,
    maxRetries: 5,
  })
  // Brief "Connected" success flash after a recovery, then auto-hide.
  const [wsRecentlyRecovered, setWsRecentlyRecovered] = useState(false)
  const wsRecoveryTimerRef = useRef<number | null>(null)

  // Улучшатели#3 wave 2 #3 — Lock viewport toggle. When locked all programmatic
  // panToGroup / setCenter calls are no-ops so the user's manual viewport sticks.
  // Persisted to localStorage so the preference survives reloads.
  const [lockViewport, setLockViewport] = useState<boolean>(() => {
    try {
      return localStorage.getItem('codeforge.session.lockViewport') === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('codeforge.session.lockViewport', lockViewport ? '1' : '0')
    } catch { /* localStorage unavailable */ }
  }, [lockViewport])

  // Улучшатели#3 wave 2 #7 — Keyboard-shortcut help modal.
  const [shortcutsHelpOpen, setShortcutsHelpOpen] = useState(false)

  // Улучшатели#3 P3·S — Header overflow menu (responsive).
  // Below md (768px) the secondary actions collapse into a ⋯ menu.
  const [headerOverflowOpen, setHeaderOverflowOpen] = useState(false)
  const headerOverflowRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!headerOverflowOpen) return
    const handler = (e: MouseEvent) => {
      if (
        headerOverflowRef.current &&
        !headerOverflowRef.current.contains(e.target as Node)
      ) {
        setHeaderOverflowOpen(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [headerOverflowOpen])

  // Улучшатели#3 P2·S — Final Result fullscreen + wrap toggle.
  // Tracks whether the user expanded the Generated Code into a Modal viewer
  // and whether long lines should wrap (default no-wrap to match an editor).
  const [finalCodeFullscreen, setFinalCodeFullscreen] = useState(false)
  const [finalCodeWrap, setFinalCodeWrap] = useState(false)

  // Улучшатели#3 P2·M — Side-panel history breadcrumb.
  // Tracks the last few panels the user opened so they can hop back without
  // having to re-trigger an action. Push on open, dedup adjacents, cap to 3.
  // КАО#VR-Wave1 Frontend — Visual Review: add a 'visualReview' panel key.
  type PanelKey = 'detail' | 'code' | 'intervention' | 'execution' | 'browser' | 'enhancement' | 'visualReview'
  const PANEL_LABELS: Record<PanelKey, string> = {
    detail: 'Detail',
    code: 'Result',
    intervention: 'Intervene',
    execution: 'Execution',
    browser: 'Run',
    enhancement: 'Enhance',
    visualReview: 'Visual Review',
  }
  const [panelHistory, setPanelHistory] = useState<PanelKey[]>([])
  const pushPanel = useCallback((key: PanelKey) => {
    setPanelHistory(prev => {
      const next = [...prev.filter(k => k !== key), key]
      return next.slice(-3)
    })
  }, [])
  // КАО#VR-Wave1 Frontend — Visual Review: side-panel visibility state.
  const [showVisualReview, setShowVisualReview] = useState(false)
  // Track whether we've auto-opened the panel this cycle so we don't re-open
  // it after the user manually closes it while still in `awaiting_visual_review`.
  const visualReviewAutoOpenedRef = useRef<string | null>(null)
  const switchToPanel = useCallback((key: PanelKey) => {
    // Close all panels first then open the requested one.
    setShowCode(false)
    setShowIntervention(false)
    setShowExecution(false)
    setShowBrowserPreview(false)
    setShowEnhancementReview(false)
    setShowVisualReview(false)
    if (key !== 'detail') {
      setSelectedNode(null)
      setSelectedNodeData(null)
    }
    switch (key) {
      case 'code': setShowCode(true); break
      case 'intervention': setShowIntervention(true); break
      case 'execution': setShowExecution(true); break
      case 'browser': setShowBrowserPreview(true); break
      case 'enhancement': setShowEnhancementReview(true); break
      case 'visualReview': setShowVisualReview(true); break
      case 'detail': /* Detail panel relies on selectedNode, can't restore without id */ break
    }
  }, [])

  // Улучшатели#3 wave 2 #6 — Intervention history. Each entry is what we sent
  // to the API + its delivery state. We don't have a backend WS event for
  // "consumed by agent X at iter N" yet, so the status flips to "delivered"
  // once the POST resolves. TODO(backend): wire an `intervention_acknowledged`
  // WS event to flip status to 'consumed' with agent/iteration metadata.
  type InterventionStatus = 'pending' | 'delivered' | 'consumed' | 'failed'
  interface InterventionHistoryEntry {
    id: string
    content: string
    sentAt: number
    status: InterventionStatus
    consumedBy?: string  // e.g. "coder_0 at iter 2" — backend TODO
  }
  const [interventionHistory, setInterventionHistory] = useState<InterventionHistoryEntry[]>([])

  // Providers store (for adding new agents)
  const { providers } = useProvidersStore()

  // React Flow state — typed with Node/Edge generics
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [nodes, setNodes, onNodesChange] = useNodesState<any>([])
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([])
  const [flowViewport, setFlowViewport] = useState({ x: 0, y: 0, zoom: 1 })

  // Ref to always hold the latest handleWSMessage to avoid stale closures in WS callback
  const handleWSMessageRef = useRef<(msg: { type: string; data?: Record<string, unknown> }) => void>(() => {})
  // Guard against concurrent loadSession calls (race condition)
  const loadSessionSeqRef = useRef(0)
  // Track deferred timeouts for cleanup on unmount
  const pendingTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set())
  // Refs to avoid stale closures in handleWSMessage
  const finishedCodersRef = useRef<Set<number>>(new Set())
  const agentTimeoutRef = useRef<number>(300)
  const requestTimeoutRef = useRef<number>(300)   // httpx timeout for LLM requests
  const executionTimeoutRef = useRef<number>(60)
  // Skip auto-pan-to-node for the very FIRST agent_started after workflow_started
  // (user complained that pressing "Start" zooms into coders unexpectedly).
  // Set true on workflow_started, cleared after first agent_started.
  const skipNextAutoPanRef = useRef<boolean>(false)
  // Улучшатели#3 wave 2 #3 — mirror lockViewport into a ref so panToGroup
  // (called via stale WS-message closures) reads the current value.
  const lockViewportRef = useRef<boolean>(false)
  useEffect(() => { lockViewportRef.current = lockViewport }, [lockViewport])

  // Keep refs in sync with state
  useEffect(() => {
    finishedCodersRef.current = workflowState.finishedCoders
  }, [workflowState.finishedCoders])

  useEffect(() => {
    agentTimeoutRef.current = session?.agent_timeout ?? 600
    requestTimeoutRef.current = session?.request_timeout ?? 300
    executionTimeoutRef.current = session?.execution_timeout ?? 60
  }, [session?.agent_timeout, session?.request_timeout, session?.execution_timeout])

  // КАО#VR-35 — re-fetch final_result whenever the session lands in a
  // "code-ready" state. The original code only loaded it once inside
  // loadSession(); any other code path that cleared `finalResult` (e.g. a
  // race between a WS reset event and the actual reset action) left the UI
  // permanently without a Run Code button until a hard refresh. This effect
  // is idempotent: if the backend says final_result exists, we surface it.
  useEffect(() => {
    if (!sessionId || !session) return
    const status = session.status
    if (status !== 'completed' && status !== 'awaiting_enhancement' &&
        status !== 'awaiting_enhancement_review' && status !== 'enhancing') {
      return
    }
    // Only fetch if we don't already have it for this session.
    if (finalResult && finalResult.session_id === sessionId) return
    let cancelled = false
    ;(async () => {
      try {
        const result = await getFinalResult(sessionId)
        if (!cancelled && result) setFinalResult(result)
      } catch (err) {
        // Silent — loadSession's own catch handled the initial attempt.
        console.warn('VR-35 finalResult refetch failed:', err)
      }
    })()
    return () => { cancelled = true }
  }, [session?.id, session?.status, sessionId, finalResult?.session_id]) // eslint-disable-line react-hooks/exhaustive-deps

  // КАО#VR-Wave1 Frontend — Visual Review: auto-open the panel when the
  // session flips to `awaiting_visual_review`. Only fires once per session id
  // entering that status (tracked via visualReviewAutoOpenedRef) so the user
  // can dismiss the panel without it springing back open.
  useEffect(() => {
    if (!session) return
    if (session.status === 'awaiting_visual_review') {
      if (visualReviewAutoOpenedRef.current !== session.id) {
        visualReviewAutoOpenedRef.current = session.id
        switchToPanel('visualReview')
        pushPanel('visualReview')
      }
    } else {
      // Reset the latch so a subsequent re-entry (e.g. after Apply) re-opens.
      if (visualReviewAutoOpenedRef.current === session.id) {
        visualReviewAutoOpenedRef.current = null
      }
    }
  }, [session?.id, session?.status, switchToPanel, pushPanel])

  // Setup WebSocket connection — use ref to avoid stale closure
  useEffect(() => {
    if (!sessionId) return

    const ws = createWebSocket(sessionId)
    wsRef.current = ws

    // Улучшатели#3 P0·M — WS reconnect UI: subscribe to lifecycle transitions
    // so the status pill + overlay reflect connecting/reconnecting/disconnected.
    ws.onstatechange = (state) => {
      setWsState(prev => {
        // Flash "Connected" briefly after recovering from reconnect/disconnect.
        if (state.status === 'connected' && prev.status !== 'connected' && prev.status !== 'connecting') {
          setWsRecentlyRecovered(true)
          if (wsRecoveryTimerRef.current !== null) {
            window.clearTimeout(wsRecoveryTimerRef.current)
          }
          wsRecoveryTimerRef.current = window.setTimeout(() => {
            setWsRecentlyRecovered(false)
            wsRecoveryTimerRef.current = null
          }, 1500)
        }
        return state
      })
    }

    ws.onopen = () => {
      console.log('WebSocket connected for session:', sessionId)
    }

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        handleWSMessageRef.current(message)
      } catch (err) {
        console.error('Failed to parse WS message:', err)
      }
    }

    ws.onerror = (error) => {
      console.error('WebSocket error:', error)
    }

    ws.onclose = () => {
      console.log('WebSocket disconnected')
    }

    // On reconnect, reload session state to recover from missed events
    ws.onreconnect = () => {
      console.log('WebSocket reconnected — reloading session state')
      loadSession()
    }

    return () => {
      ws.close()
      // Улучшатели#3 P0·M — WS reconnect UI: clear flash timer on unmount.
      if (wsRecoveryTimerRef.current !== null) {
        window.clearTimeout(wsRecoveryTimerRef.current)
        wsRecoveryTimerRef.current = null
      }
    }
  }, [sessionId])  // eslint-disable-line react-hooks/exhaustive-deps

  // VR-37 — UI ↔ backend state synchronization safety net.
  // The WS-driven model is the primary path, but WS events can be missed
  // (network blips, backgrounded tabs throttling timers, browser sleep).
  // This effect adds three independent fallbacks so the rendered UI never
  // drifts more than ~30 s from the authoritative DB state:
  //   1. visibilitychange  — refetch the moment the tab regains focus
  //   2. window focus      — refetch when the window itself gains focus
  //                          (covers alt-tab on Linux/Windows where the
  //                          visibilitychange event does NOT fire)
  //   3. interval poll     — refetch every 30 s as a defence-in-depth net
  //                          for silent WS breakages that don't trigger
  //                          onreconnect (e.g. zombie sockets that the OS
  //                          thinks are still open).
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false

    const refresh = (reason: string) => {
      if (cancelled || document.hidden) return
      // Don't spam network when the page isn't visible — visibilitychange
      // will re-trigger refresh when the tab comes back.
      console.debug(`[VR-37] State sync refresh: ${reason}`)
      loadSession()
    }

    const onVisibility = () => {
      if (!document.hidden) refresh('visibilitychange')
    }
    const onFocus = () => refresh('window-focus')

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)

    const intervalId = window.setInterval(() => refresh('30s-poll'), 30_000)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.clearInterval(intervalId)
    }
  }, [sessionId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Helper: schedule a timeout that is automatically cleaned up on unmount
  const scheduleTimeout = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      pendingTimeoutsRef.current.delete(id)
      fn()
    }, ms)
    pendingTimeoutsRef.current.add(id)
    return id
  }, [])

  const loadSession = useCallback(async function loadSession() {
    // Increment sequence to detect stale responses
    const seq = ++loadSessionSeqRef.current
    try {
      const data = await getSession(sessionId!)
      // If a newer loadSession call was started while we were fetching, discard this result
      if (seq !== loadSessionSeqRef.current) return
      setSession(data)
      buildGraph(data)
      
      // Initialize / reconcile workflowState from server-of-truth session data.
      // On reconnect / page-refresh, server's current_iteration must override
      // the local optimistic value (otherwise dropped WS iteration_started
      // events leave the UI stuck on the old iteration). Also clear counters
      // that only WS events can populate — those are stale after a reconnect.
      setWorkflowState(prev => {
        const fromServer = data.current_iteration ?? 0
        const fromLocal = prev.iteration ?? 0
        const reconciledIter = Math.max(fromServer, fromLocal) || 1
        const isLive = data.status === 'running' || data.status === 'enhancing'
        return {
          ...prev,
          iteration: reconciledIter,
          phase: data.status === 'running' ? 'coding' :
                 data.status === 'completed' ? 'completed' :
                 data.status === 'enhancing' ? 'coding' :
                 data.status === 'awaiting_enhancement' ? 'completed' :
                 data.status === 'awaiting_enhancement_review' ? 'completed' : 'idle',
          // For live sessions we don't know exact counts after reconnect —
          // events for current iteration may have been dropped. Reset and let
          // upcoming agent_completed events refill. For terminal states keep
          // whatever metrics we accumulated.
          codersDone: isLive && fromServer > fromLocal ? 0 : prev.codersDone,
          testersDone: isLive && fromServer > fromLocal ? 0 : prev.testersDone,
          testerCompletions: isLive && fromServer > fromLocal ? {} : prev.testerCompletions,
        }
      })

      // Fetch real metrics from DB (tokens/cost are only accumulated via WS during live runs)
      const metrics = await getSessionMetrics(sessionId!)
      if (metrics && seq === loadSessionSeqRef.current) {
        setWorkflowState(prev => ({
          ...prev,
          totalTokens: metrics.total_tokens || prev.totalTokens,
          totalCost: metrics.total_cost_usd || prev.totalCost,
        }))
      }

      // Fetch crash-recovery checkpoints (best-effort — non-fatal if endpoint missing)
      try {
        const cps = await listCheckpoints(sessionId!)
        if (seq === loadSessionSeqRef.current) {
          setCheckpoints(cps)
        }
      } catch {
        // Ignore — checkpoints are an auxiliary feature
      }

      // Recover node statuses based on session status
      if (data.status === 'running') {
        // Coding workflow in progress — set coders to working with animation.
        // Real-time WS events will refine individual agent statuses as they arrive.
        scheduleTimeout(() => {
          setNodes((nds: any[]) =>
            nds.map((node: any) => {
              if (node.id.startsWith('coder-')) {
                return {
                  ...node,
                  data: {
                    ...node.data,
                    status: 'working',
                    iteration: data.current_iteration || 1,
                  },
                }
              }
              return node
            })
          )

          // Animate edges from input to coders
          setEdges((eds: any[]) =>
            eds.map((edge: any) => {
              if (edge.source === 'input' && edge.target.startsWith('coder-')) {
                return {
                  ...edge,
                  data: {
                    ...edge.data,
                    animated: true,
                    hasArtifact: true,
                  },
                }
              }
              return edge
            })
          )
        }, 100)
      } else if (data.status === 'enhancing') {
        // Enhancement analysis in progress — mark main pipeline as done,
        // enhancer nodes as working. WS events will update individual enhancers.
        scheduleTimeout(() => {
          setNodes((nds: any[]) =>
            nds.map((node: any) => {
              // Main pipeline nodes (coders, testers, summarizer, finalizer) → done
              if (node.id.startsWith('coder-') || node.id.startsWith('tester-') ||
                  node.id === 'summarizer' || node.id === 'finalizer' || node.id === 'output') {
                return {
                  ...node,
                  data: {
                    ...node.data,
                    status: 'done',
                    iteration: data.current_iteration ?? node.data.iteration,
                  },
                }
              }
              // Enhancer nodes — VR-44 fix.
              // Pulse continuity guarantee: while session.status === 'enhancing'
              // there MUST be at least one pulsing block (user's spec).
              //
              // The previous check looked up enabled enhancer configs in
              // `data.agent_configs`. But for many sessions the enhancer
              // configs aren't persisted to AgentConfig — they're created
              // transiently when the user clicks Enhance — so the check
              // returned false and every D/F/S stayed `idle`.
              //
              // New rule (no agent_configs dependency):
              //   1. If a node is already done/error/timeout/working, preserve
              //      it (VR-40 — don't clobber WS-driven transitions).
              //   2. Else if any D/F/S sibling is already 'done', that means
              //      enhancer agents have finished and Summarizer is the
              //      active phase — pulse Summarizer; keep others as-is.
              //   3. Else D/F/S phase is still active — pulse all non-disabled
              //      D/F/S; Summarizer stays idle.
              if (node.id.startsWith('enhancer-')) {
                const preserveExisting =
                  node.data.status === 'done' ||
                  node.data.status === 'error' ||
                  node.data.status === 'timeout' ||
                  node.data.status === 'working'
                if (preserveExisting) {
                  return node
                }
                // Look at sibling D/F/S statuses to decide which sub-phase
                // we're in (D/F/S vs Summarizer).
                const dfsSiblings = nds.filter((n: any) =>
                  n.id.startsWith('enhancer-') && n.id !== 'enhancer-summarizer')
                const anyDfsDone = dfsSiblings.some((n: any) =>
                  n.data?.status === 'done' || n.data?.status === 'error' || n.data?.status === 'timeout')
                if (node.id === 'enhancer-summarizer') {
                  // Summarizer pulses iff D/F/S sub-phase is over.
                  return {
                    ...node,
                    data: { ...node.data, status: anyDfsDone ? 'working' : 'idle' },
                  }
                }
                // D/F/S node. Pulse unless explicitly disabled in agent_configs.
                // Treat absent config as enabled (matches rebuildGraph default).
                const isDisabled = node.data?.disabled === true
                return {
                  ...node,
                  data: { ...node.data, status: isDisabled ? 'idle' : 'working' },
                }
              }
              return node
            })
          )
        }, 100)
      } else if (data.status === 'completed' || data.status === 'awaiting_enhancement' || data.status === 'awaiting_enhancement_review') {
        // Session is done — mark all pipeline nodes as done
        scheduleTimeout(() => {
          setNodes((nds: any[]) =>
            nds.map((node: any) => {
              // VR-46 — only the Specification (input) node is exempt here; the
              // Final Code (output) node must also flip to "done" in these
              // post-finalization states (it used to be skipped, leaving a
              // misleading grey "Waiting…" even though the code was ready).
              if (node.id === 'input') return node
              return {
                ...node,
                data: {
                  ...node.data,
                  status: 'done',
                  iteration: data.current_iteration ?? node.data.iteration,
                },
              }
            })
          )
          // Show all edges as completed (not animated, but with artifact)
          setEdges((eds: any[]) =>
            eds.map((edge: any) => ({
              ...edge,
              data: {
                ...edge.data,
                animated: false,
                hasArtifact: true,
              },
            }))
          )
        }, 100)
      } else if (data.status === 'failed') {
        // Session failed — mark coder nodes as error so user sees failure (not idle)
        scheduleTimeout(() => {
          setNodes((nds: any[]) =>
            nds.map((node: any) => {
              if (node.id.startsWith('coder-')) {
                return {
                  ...node,
                  data: {
                    ...node.data,
                    status: 'error',
                    status_text: 'Session failed',
                  },
                }
              }
              return node
            })
          )
        }, 100)
      }

      // Always attempt to load final result (copied sessions keep code but have status=created)
      try {
        const result = await getFinalResult(sessionId!)
        setFinalResult(result)
      } catch {
        setFinalResult(null)
      }
    } catch (err) {
      if (seq !== loadSessionSeqRef.current) return  // stale — ignore errors too
      notify.error('Failed to load session')
      console.error(err)
    } finally {
      if (seq === loadSessionSeqRef.current) setLoading(false)
    }
  }, [sessionId])  // eslint-disable-line react-hooks/exhaustive-deps

  // Load session data
  useEffect(() => {
    if (!sessionId) return
    loadSession()
  }, [sessionId, loadSession])

  // Handler for adding a new coder or tester agent
  async function handleAddAgent(agentType: 'coder' | 'tester') {
    if (!session || !sessionId) return
    if (session.status !== 'created') {
      notify.error('Can only add agents before the session is started')
      return
    }

    // Figure out the next agent_index
    const existingOfType = session.agent_configs.filter(a => a.agent_type === agentType)
    const nextIndex = existingOfType.length > 0
      ? Math.max(...existingOfType.map(a => a.agent_index)) + 1
      : 0

    // Pick a default provider/model from existing agents of same type, or fall back to first configured provider
    const existingAgent = existingOfType[0]
    let llmProvider = existingAgent?.llm_provider || ''
    let llmModel = existingAgent?.llm_model || ''

    if (!llmProvider && providers.length > 0) {
      const configured = providers.find(p => p.configured) || providers[0]
      llmProvider = configured.name
      llmModel = configured.models[0] || ''
    }

    try {
      await addAgentConfig(sessionId, {
        agent_type: agentType,
        agent_index: nextIndex,
        llm_provider: llmProvider,
        llm_model: llmModel,
        max_tokens: 64000,
      })
      notify.success(`Added ${agentType} ${nextIndex + 1}`)
      // Reload session to rebuild the graph with the new agent
      await loadSession()
    } catch (err) {
      console.error(err)
      notify.error(`Failed to add ${agentType}`)
    }
  }

  // Handler for removing the last coder or tester agent
  async function handleRemoveAgent(agentType: 'coder' | 'tester') {
    if (!session || !sessionId) return
    if (session.status !== 'created') {
      notify.error('Can only remove agents before the session is started')
      return
    }

    const existingOfType = session.agent_configs.filter(a => a.agent_type === agentType)
    if (existingOfType.length <= 1) {
      notify.error(`Must keep at least one ${agentType}`)
      return
    }

    // Remove the one with the highest agent_index
    const toRemove = existingOfType.reduce((a, b) => a.agent_index > b.agent_index ? a : b)

    try {
      await deleteAgentConfig(sessionId, toRemove.id)
      notify.success(`Removed ${agentType} ${toRemove.agent_index + 1}`)
      await loadSession()
    } catch (err) {
      console.error(err)
      notify.error(`Failed to remove ${agentType}`)
    }
  }

  function buildGraph(sessionData: SessionResponse) {
    const newNodes: any[] = []
    const newEdges: any[] = []

    // КАО#VR-13 NodeCountFix — derive node counts from agent_configs filtered by
    // BOTH agent_type AND enabled. Previously, disabled coder/tester rows still
    // produced React Flow nodes (e.g. 3 boxes when only 1 actually runs),
    // creating a UI/DB mismatch. Legacy sessions with empty agent_configs fall
    // back to the original (unfiltered) behavior with a console warning so we
    // don't silently render zero nodes for old data.
    const allConfigs = sessionData.agent_configs || []
    const hasAnyConfigs = allConfigs.length > 0
    if (!hasAnyConfigs) {
      console.warn('[КАО#VR-13 NodeCountFix] Session has empty agent_configs — falling back to legacy unfiltered behavior')
    }
    const isActive = (a: AgentConfigResponse) => a.enabled !== false
    // КАО#VR-20 NodeOrder — sort by agent_index so coder_0/tester_0 always render
    // above coder_1/tester_1, regardless of DB row insertion order (which can be
    // shuffled when agent_configs are recreated via /restart).
    const coders = allConfigs
      .filter(a => a.agent_type === 'coder' && (hasAnyConfigs ? isActive(a) : true))
      .sort((a, b) => a.agent_index - b.agent_index) // КАО#VR-20 NodeOrder
    const testers = allConfigs
      .filter(a => a.agent_type === 'tester' && (hasAnyConfigs ? isActive(a) : true))
      .sort((a, b) => a.agent_index - b.agent_index) // КАО#VR-20 NodeOrder
    const summarizer = allConfigs.find(a => a.agent_type === 'summarizer' && isActive(a))
    const finalizer = allConfigs.find(a => a.agent_type === 'finalizer' && isActive(a))
    // Enhancer count is per-type (each enhancer_* counted separately); enabled
    // filter is applied at render time below (lines ~2071-2073) so disabled
    // enhancers still render as visibly-greyed-out nodes — preserve that.
    // КАО#VR-20 NodeOrder — sort enhancers alphabetically by agent_type
    // (design, func, security) for stable vertical ordering; tiebreak by
    // agent_index for future multi-instance enhancer support.
    const enhancerConfigs = allConfigs
      .filter(a => ['enhancer_design', 'enhancer_func', 'enhancer_security'].includes(a.agent_type))
      .sort((a, b) => {
        const t = a.agent_type.localeCompare(b.agent_type)
        return t !== 0 ? t : a.agent_index - b.agent_index
      }) // КАО#VR-20 NodeOrder

    // Calculate vertical center for each column
    const maxAgents = Math.max(coders.length, testers.length)
    const centerY = START_Y + (maxAgents - 1) * VERTICAL_GAP / 2

    // Column X positions
    const inputX = START_X
    const codersX = START_X + NODE_WIDTH + HORIZONTAL_GAP
    const testersX = codersX + NODE_WIDTH + HORIZONTAL_GAP
    const summarizerX = testersX + NODE_WIDTH + HORIZONTAL_GAP
    const finalizerX = summarizerX + NODE_WIDTH + HORIZONTAL_GAP
    const outputX = finalizerX + NODE_WIDTH + HORIZONTAL_GAP

    // Edit handler for agent config popup (shared by all configurable nodes)
    const makeEditHandler = (nodeId: string, agentType: string, agentIndex?: number) => (event: React.MouseEvent) => {
      const container = reactFlowContainerRef.current
      if (!container) return
      const rect = container.getBoundingClientRect()
      setAgentConfigPopup({
        nodeId,
        agentType,
        agentIndex,
        x: event.clientX - rect.left + 16,
        y: event.clientY - rect.top - 40,
      })
    }

    // 1. Input node (Specification)
    newNodes.push({
      id: 'input',
      type: 'agentNode',
      position: { x: inputX, y: centerY },
      data: {
        label: 'Specification',
        agentType: 'input',
        status: 'done',
      },
    })

    // 2. Coder nodes
    coders.forEach((coder, i) => {
      const y = START_Y + i * VERTICAL_GAP
      const nodeId = `coder-${coder.agent_index}`

      // VR-47 — run→fix badge data from the latest persisted code_version for
      // this coder (reload-safe; live runs also refresh it via WS events).
      const coderCVs = (((sessionData as any).code_versions ?? []) as Array<{
        coder_index: number; iteration: number; status: string; fix_attempts?: number
      }>).filter(cv => cv.coder_index === coder.agent_index)
      const latestCV = coderCVs.length
        ? coderCVs.reduce((a, b) => ((b.iteration ?? 0) >= (a.iteration ?? 0) ? b : a))
        : null
      const coderRunFixCount = latestCV?.fix_attempts ?? 0
      const coderCvStatus = latestCV ? String(latestCV.status) : ''
      const coderRunFixClean = coderCvStatus === 'tested' || coderCvStatus === 'finalized'
      
      newNodes.push({
        id: nodeId,
        type: 'agentNode',
        position: { x: codersX, y },
        data: {
          label: `Coder ${coder.agent_index + 1}`,
          agentType: 'coder',
          agentIndex: coder.agent_index,
          llmProvider: coder.llm_provider,
          llmModel: coder.llm_model,
          status: 'idle',
          iteration: sessionData.current_iteration,
          tokensUsed: 0,
          costUsd: 0,
          // VR-47 — run→fix badge (persistent on the finished node).
          runFixCount: coderRunFixCount,
          runFixClean: coderRunFixClean,
          maxFixAttempts: sessionData.max_fix_attempts,
          onEditClick: makeEditHandler(nodeId, 'coder', coder.agent_index),
        },
      })

      // Edge from input to coder
      newEdges.push({
        id: `input-${nodeId}`,
        source: 'input',
        target: nodeId,
        type: 'artifactEdge',
        data: {
          artifactType: 'code',
          animated: false,
          hasArtifact: false,
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#4B5563' },
      })
    })

    // 3. Tester nodes
    testers.forEach((tester, i) => {
      const y = START_Y + i * VERTICAL_GAP
      const nodeId = `tester-${tester.agent_index}`
      
      newNodes.push({
        id: nodeId,
        type: 'agentNode',
        position: { x: testersX, y },
        data: {
          label: `Tester ${tester.agent_index + 1}`,
          agentType: 'tester',
          agentIndex: tester.agent_index,
          llmProvider: tester.llm_provider,
          llmModel: tester.llm_model,
          status: 'idle',
          iteration: sessionData.current_iteration,
          tokensUsed: 0,
          costUsd: 0,
          issuesFound: 0,
          onEditClick: makeEditHandler(nodeId, 'tester', tester.agent_index),
        },
      })

      // Edges from each coder to this tester
      coders.forEach(coder => {
        newEdges.push({
          id: `coder-${coder.agent_index}-${nodeId}`,
          source: `coder-${coder.agent_index}`,
          target: nodeId,
          type: 'artifactEdge',
          data: {
            artifactType: 'code',
            animated: false,
            hasArtifact: false,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#4B5563' },
        })
      })
    })

    // 4. Summarizer node
    if (summarizer) {
      newNodes.push({
        id: 'summarizer',
        type: 'agentNode',
        position: { x: summarizerX, y: centerY },
        data: {
          label: 'Summarizer',
          agentType: 'summarizer',
          llmProvider: summarizer.llm_provider,
          llmModel: summarizer.llm_model,
          status: 'idle',
          iteration: sessionData.current_iteration,
          tokensUsed: 0,
          costUsd: 0,
          onEditClick: makeEditHandler('summarizer', 'summarizer'),
        },
      })

      // Edges from testers to summarizer
      testers.forEach(tester => {
        newEdges.push({
          id: `tester-${tester.agent_index}-summarizer`,
          source: `tester-${tester.agent_index}`,
          target: 'summarizer',
          type: 'artifactEdge',
          data: {
            artifactType: 'audit',
            animated: false,
            hasArtifact: false,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#4B5563' },
        })
      })
    }

    // 5. Finalizer node
    if (finalizer) {
      newNodes.push({
        id: 'finalizer',
        type: 'agentNode',
        position: { x: finalizerX, y: centerY },
        data: {
          label: 'Finalizer',
          agentType: 'finalizer',
          llmProvider: finalizer.llm_provider,
          llmModel: finalizer.llm_model,
          status: 'idle',
          iteration: sessionData.current_iteration,
          tokensUsed: 0,
          costUsd: 0,
          onEditClick: makeEditHandler('finalizer', 'finalizer'),
        },
      })

      // Edge from summarizer to finalizer
      if (summarizer) {
        newEdges.push({
          id: 'summarizer-finalizer',
          source: 'summarizer',
          target: 'finalizer',
          type: 'artifactEdge',
          data: {
            artifactType: 'summary',
            animated: false,
            hasArtifact: false,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#4B5563' },
        })
      }
    }

    // 6. Output node (Final Code)
    newNodes.push({
      id: 'output',
      type: 'agentNode',
      position: { x: outputX, y: centerY },
      data: {
        label: 'Final Code',
        agentType: 'output',
        // VR-46 — the Final Code artifact exists from finalization onward, so the
        // output node reads "Complete" for every post-finalization state, not just
        // `completed`. It used to sit at idle ("Waiting…") during
        // awaiting_enhancement / _review / enhancing even though the code was ready.
        status: ['completed', 'awaiting_enhancement', 'awaiting_enhancement_review', 'enhancing'].includes(sessionData.status) ? 'done' : 'idle',
      },
    })

    // Edge from finalizer to output
    if (finalizer) {
      newEdges.push({
        id: 'finalizer-output',
        source: 'finalizer',
        target: 'output',
        type: 'artifactEdge',
        data: {
          artifactType: 'final',
          animated: false,
          // VR-46 — surface the final artifact on the edge for all post-finalization states.
          hasArtifact: ['completed', 'awaiting_enhancement', 'awaiting_enhancement_review', 'enhancing'].includes(sessionData.status),
        },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#4B5563' },
      })
    }

    // Add feedback loop edges (summarizer back to coders) - dashed
    if (summarizer) {
      coders.forEach(coder => {
        newEdges.push({
          id: `summarizer-coder-${coder.agent_index}-feedback`,
          source: 'summarizer',
          target: `coder-${coder.agent_index}`,
          type: 'artifactEdge',
          style: { strokeDasharray: '8 4' },
          data: {
            artifactType: 'summary',
            label: 'Feedback',
            animated: false,
            hasArtifact: false,
          },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#8B5CF6' },
        })
      })
    }

    // 7. Enhancement Loop nodes — below the main pipeline
    // Layout: ES (left) ← [D/F/S stacked vertically] (right) ← Final Code (top)
    // Inter-row gap must be > 2 * GroupFramesLayer.PADDING (56) so the CODERS/TESTERS
    // frame bottom doesn't overlap with the ENHANCERS frame top.
    // 130px extra (was 20) gives ~74px margin between frames.
    const enhancerY = centerY + Math.max(coders.length, testers.length) * VERTICAL_GAP / 2 + VERTICAL_GAP + 130
    const enhAgentNames = ['design', 'functionality', 'security']
    const enhAgentLabels = ['Design', 'Functionality', 'Security']
    const enhAgentTypes = ['enhancer_design', 'enhancer_func', 'enhancer_security']
    const enhAgentsX = finalizerX  // D/F/S column — below Finalizer
    const enhVerticalGap = VERTICAL_GAP  // same gap as coders/testers (180) — node height is 140, so 40px visible gap
    const esX = codersX  // ES — below Coders

    // D/F/S stacked vertically
    enhAgentNames.forEach((name, i) => {
      const nodeId = `enhancer-${name}`
      const nodeY = enhancerY + i * enhVerticalGap
      const enhConfig = enhancerConfigs.find(c => c.agent_type === enhAgentTypes[i])
      // Enabled if: no config for this agent (default=enabled) OR config exists and is enabled
      const isEnabled = !enhConfig || enhConfig.enabled !== false
      newNodes.push({
        id: nodeId,
        type: 'agentNode',
        position: { x: enhAgentsX, y: nodeY },
        data: {
          label: enhAgentLabels[i],
          agentType: enhAgentTypes[i],
          status: 'idle',
          disabled: !isEnabled,
          onEditClick: makeEditHandler(nodeId, enhAgentTypes[i]),
        },
      })

      // Edge: output (Final Code) bottom → enhancer agent top (dashed, purple)
      newEdges.push({
        id: `output-${nodeId}`,
        source: 'output',
        sourceHandle: 'bottom-source',
        target: nodeId,
        targetHandle: 'right-target',
        type: 'artifactEdge',
        style: { strokeDasharray: '6 3' },
        data: { artifactType: 'enhancement', animated: false, hasArtifact: false },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#A855F7' },
      })

      // Edge: enhancer agent left → ES right
      newEdges.push({
        id: `${nodeId}-summarizer`,
        source: nodeId,
        sourceHandle: 'left-source',
        target: 'enhancer-summarizer',
        targetHandle: 'right-target',
        type: 'artifactEdge',
        style: { strokeDasharray: '6 3' },
        data: { artifactType: 'enhancement', animated: false, hasArtifact: false },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#A855F7' },
      })
    })

    // Enhancement Summarizer node — to the left
    newNodes.push({
      id: 'enhancer-summarizer',
      type: 'agentNode',
      position: { x: esX, y: enhancerY + enhVerticalGap },  // vertically centered with D/F/S
      data: {
        label: 'Enh. Summarizer',
        agentType: 'enhancer_summary',
        status: 'idle',
        onEditClick: makeEditHandler('enhancer-summarizer', 'enhancer_summary'),
      },
    })

    // Edge: ES left → Coders bottom (feedback loop)
    coders.forEach(coder => {
      newEdges.push({
        id: `enhancer-summarizer-coder-${coder.agent_index}`,
        source: 'enhancer-summarizer',
        sourceHandle: 'left-source',
        target: `coder-${coder.agent_index}`,
        targetHandle: 'bottom-target',
        type: 'artifactEdge',
        style: { strokeDasharray: '6 3' },
        data: { artifactType: 'enhancement', label: 'New Session', animated: false, hasArtifact: false },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#A855F7' },
      })
    })

    setNodes(newNodes)
    setEdges(newEdges)
  }

  // Keep the ref pointing at the latest handleWSMessage to avoid stale closures.
  // Intentionally no dependency array — must run on every render to capture latest closure.
  handleWSMessageRef.current = handleWSMessage

  // Cleanup all tracked timeouts on unmount
  useEffect(() => {
    return () => {
      for (const id of pendingTimeoutsRef.current) {
        clearTimeout(id)
      }
      pendingTimeoutsRef.current.clear()
    }
  }, [])

  // Send HTML content to sandbox iframe via postMessage.
  // sandbox-frame.html is served by nginx with a permissive CSP (script-src *)
  // and renders the HTML in a child <iframe srcdoc="...">. The child inherits
  // the permissive CSP, so external CDN scripts (Three.js, D3, etc.) load freely.
  useEffect(() => {
    if (!browserPreviewHtml || !showBrowserPreview) return

    const iframe = sandboxIframeRef.current
    if (!iframe) return

    function sendHtml() {
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage(
          { type: 'codeforge-preview', html: browserPreviewHtml },
          '*'  // Same-origin sandbox iframe — wildcard is safe here
        )
      }
    }

    // Listen for the sandbox-frame's "ready" signal (fires after it loads)
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === 'codeforge-sandbox-ready') {
        sendHtml()
      }
    }

    window.addEventListener('message', handleMessage)

    // Also try sending immediately — if sandbox-frame.html is already loaded
    // (e.g. from cache or when only browserPreviewHtml changed), its message
    // listener is still active and will handle this. If it hasn't loaded yet,
    // the message is silently dropped and the ready signal above handles it.
    sendHtml()

    return () => {
      window.removeEventListener('message', handleMessage)
    }
  }, [browserPreviewHtml, browserPreviewKey, showBrowserPreview])

  // Keyboard shortcuts
  // Улучшатели#3 wave 2 #7 — wire `?`, add space/c/i, document existing.
  // Existing: Esc (close panels), p (toggle preview).
  // New: ? (open shortcuts help modal), space (toggle pause/resume on
  // running/paused), c (focus most-recent code viewer), i (open intervention).
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't fire shortcuts when typing in inputs/textareas
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // contenteditable surfaces (e.g. react-flow node labels) — bail out too
      if ((e.target as HTMLElement)?.isContentEditable) return

      switch (e.key) {
        case 'Escape':
          // Close panels/modals
          if (shortcutsHelpOpen) setShortcutsHelpOpen(false)
          else if (showBrowserPreview) setShowBrowserPreview(false)
          else if (selectedNode) setSelectedNode(null)
          break
        case 'p':
          // Toggle preview
          if (!e.ctrlKey && !e.metaKey) {
            setShowBrowserPreview(prev => !prev)
          }
          break
        case '?':
          // Show shortcuts help modal (Улучшатели#3 wave 2 #7)
          e.preventDefault()
          setShortcutsHelpOpen(prev => !prev)
          break
        case ' ':
        case 'Spacebar':
          // Улучшатели#3 wave 2 #7 — space toggles pause/resume on running/paused.
          // Read session via ref-free state pointer; we already have `session` in deps.
          if (!e.ctrlKey && !e.metaKey && !e.altKey) {
            if (session?.status === 'running') {
              e.preventDefault()
              handlePause()
            } else if (session?.status === 'paused') {
              e.preventDefault()
              handleResume()
            }
          }
          break
        case 'c':
          // Улучшатели#3 wave 2 #7 — focus most-recent code viewer.
          // We prefer the View Result panel when a final result exists,
          // else fall back to opening the DetailPanel for the most-recent
          // working/done coder node.
          if (!e.ctrlKey && !e.metaKey) {
            if (finalResult) {
              setShowCode(true)
            } else {
              // Find the highest-numbered coder node that's done or working
              const candidate = [...nodes]
                .filter((n: any) => n.id.startsWith('coder-'))
                .sort((a: any, b: any) => {
                  const ai = parseInt(a.id.split('-')[1] || '0', 10)
                  const bi = parseInt(b.id.split('-')[1] || '0', 10)
                  return bi - ai
                })
                .find((n: any) => n.data?.status === 'done' || n.data?.status === 'working')
              if (candidate) {
                setSelectedNode(candidate.id)
                setSelectedNodeData(candidate.data)
              }
            }
          }
          break
        case 'i':
          // Улучшатели#3 wave 2 #7 — open the intervention panel.
          if (!e.ctrlKey && !e.metaKey) {
            setShowIntervention(true)
            // КАО#W4-FIX-03 — match the header Intervene button (line ~4517)
            // so the side-panel breadcrumb (Wave 3 P2·M) records keyboard
            // openings too. Without this the breadcrumb only tracked
            // header-button openings, silently missing shortcut paths.
            pushPanel('intervention')
          }
          break
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBrowserPreview, selectedNode, shortcutsHelpOpen, session?.status, finalResult, nodes])

  function handleWSMessage(message: { type: string; data?: Record<string, unknown> }) {
    const { type, data } = message

    switch (type) {
      case 'workflow_started':
        // Suppress the auto-zoom-to-coder that fires on the first agent_started
        // event right after Start. Subsequent agent transitions still pan as usual.
        skipNextAutoPanRef.current = true
        // Reset base auto-pan zoom: next pan will re-capture user's current
        // viewport zoom (so the +10% target tracks any manual zoom they did).
        autoPanBaseZoomRef.current = null
        if (data?.re_finalize) {
          // Re-finalize: skip coding phase, go straight to finalizing
          setWorkflowState(prev => ({
            ...prev,
            phase: 'finalizing',
          }))
          scheduleTimeout(() => {
            updateNodeStatus('finalizer', undefined, 'working')
          }, 100)
        } else {
          notify.success('Workflow started!')
          setWorkflowState(prev => ({
            ...prev,
            phase: 'coding',
            iteration: 1,
            codersDone: 0,
            testersDone: 0,
            finishedCoders: new Set(),  // Reset finished coders
            coderIterations: {},
            coderFinishReasons: {},
            activeCoderCount: 0,
            testerCompletions: {},
          }))
          // Activate coders on workflow start (first iteration)
          scheduleTimeout(() => {
            updateAllAgentStatuses('coder', 'working')
            // Animate edges from input (and enhancer-summarizer for enhancement sessions) to all coders
            const isEnhancementSession = !!session?.parent_session_id
            setEdges((eds: any[]) =>
              eds.map((edge: any) => {
                if (edge.source === 'input' || (isEnhancementSession && edge.source === 'enhancer-summarizer')) {
                  return {
                    ...edge,
                    data: {
                      ...edge.data,
                      animated: true,
                      hasArtifact: true,
                    },
                  }
                }
                return edge
              })
            )
          }, 100) // Small delay to ensure graph is rendered
        }
        break

      case 'iteration_started':
        if (data) {
          const activeCoders = (data.active_coders as number[]) || []
          // Notification only for iteration 2+; iteration 1 is covered by workflow_started
          if ((data.iteration as number) > 1) {
            notify.success(`Starting iteration ${data.iteration}`)
          }
          setWorkflowState(prev => ({
            ...prev,
            iteration: data.iteration as number,
            phase: 'coding',
            codersDone: 0,
            testersDone: 0,
            activeCoderCount: 0,
            testerCompletions: {},
          }))
          // Only set active (non-finished) coders to working
          setNodes((nds: any[]) =>
            nds.map((node: any) => {
              if (node.id.startsWith('coder-')) {
                const coderIndex = parseInt(node.id.split('-')[1])
                // If activeCoders list is provided, use it; otherwise check finishedCoders
                const isActive = activeCoders.length > 0
                  ? activeCoders.includes(coderIndex)
                  : !finishedCodersRef.current.has(coderIndex)
                return {
                  ...node,
                  data: {
                    ...node.data,
                    status: isActive ? 'working' : 'done',
                  },
                }
              }
              return node
            })
          )
          // Animate edges from input (and enhancer-summarizer for enhancement sessions) to active coders only
          const isEnhancementSession = !!session?.parent_session_id
          setEdges((eds: any[]) =>
            eds.map((edge: any) => {
              if (edge.source === 'input' || (isEnhancementSession && edge.source === 'enhancer-summarizer')) {
                const targetCoderIndex = parseInt(edge.target.split('-')[1])
                const isActive = activeCoders.length > 0
                  ? activeCoders.includes(targetCoderIndex)
                  : !finishedCodersRef.current.has(targetCoderIndex)
                return {
                  ...edge,
                  data: {
                    ...edge.data,
                    animated: isActive,
                    hasArtifact: isActive,
                  },
                }
              }
              return edge
            })
          )
        }
        break

      case 'phase_started':
        if (data) {
          const phase = data.phase as string
          setWorkflowState(prev => ({ ...prev, phase }))
          
          if (phase === 'testing') {
            // All coders are done coding, now waiting for test results
            updateAllAgentStatuses('coder', 'waiting')
            // Track active coder count for tester completion logic
            const activeCoders = (data.active_coders as number[]) || []
            setWorkflowState(prev => ({
              ...prev, phase,
              activeCoderCount: activeCoders.length || 1,
              testerCompletions: {},  // Reset per-tester completion counts
            }))
            // VR-43 — Start pulsing testers immediately. Without this there's
            // a visible gap between phase_started('testing') and the first
            // per-tester `agent_started` event (during which coders are
            // 'waiting' and testers haven't begun yet — nothing pulses).
            // Individual `agent_started` events still arrive to refine
            // timeouts; this just bridges the visual gap.
            updateAllAgentStatuses('tester', 'working')
          } else if (phase === 'summarizing') {
            // All testers are done — set them all to 'done' (catch-all)
            updateAllAgentStatuses('tester', 'done')
            updateNodeStatus('summarizer', undefined, 'working', {
              agentTimeoutAt: Date.now() + agentTimeoutRef.current * 1000,
              requestTimeoutAt: Date.now() + requestTimeoutRef.current * 1000,
            })
            animateEdgesToNode('summarizer', undefined)
            panToGroup('summarizer')
          } else if (phase === 'finalizing') {
            updateNodeStatus('finalizer', undefined, 'working', {
              agentTimeoutAt: Date.now() + agentTimeoutRef.current * 1000,
              requestTimeoutAt: Date.now() + requestTimeoutRef.current * 1000,
            })
            animateEdgesToNode('finalizer', undefined)
            panToGroup('finalizer')
          }
        }
        break

      case 'agent_started':
        if (data) {
          const agentType = data.agent_type as string
          const agentIndex = data.agent_index as number | undefined
          const coderIndex = data.coder_index as number | undefined

          // КАО#VR-26 — back-fill workflow phase from agent_type when
          // `phase_started` events were dropped (e.g. WS disconnect during
          // the Visual Review pause meant the resume's phase_started("finalizing")
          // never reached us, so the top-of-canvas pill stayed at
          // "Coding (iteration N)" while the Finalizer node was clearly Executing).
          // PHASE_BY_AGENT lives at module scope (above) so tests can import it.
          const derivedPhase = (PHASE_BY_AGENT as Record<string, string>)[agentType]
          if (derivedPhase) {
            setWorkflowState(prev => prev.phase === derivedPhase ? prev : { ...prev, phase: derivedPhase })
          }

          // Notify the onboarding tour that we have a real working agent on
          // screen — Tour 3 (Live multi-agent view) waits for this so its
          // highlights have something to point at.
          setOnboardingAgentStarted()

          updateNodeStatus(agentType, agentIndex, 'working', {
            agentTimeoutAt: Date.now() + agentTimeoutRef.current * 1000,
            requestTimeoutAt: Date.now() + requestTimeoutRef.current * 1000,
            sandboxTimeoutAt: undefined,
            activeSince: Date.now(),  // for elapsed-time display in AgentNode
          })
          animateEdgesToNode(agentType, agentIndex, coderIndex)
          // Auto-scroll to the agent that just started working — but skip the
          // very first one after workflow_started (user prefers manual viewport
          // on Start; subsequent transitions still pan).
          if (skipNextAutoPanRef.current) {
            skipNextAutoPanRef.current = false
          } else {
            // Center on the GROUP containing this agent, not just the node
            // (e.g. when Coder 1 starts, frame the whole Coders group).
            panToGroup(agentType, agentIndex)
          }
        }
        break

      case 'agent_completed':
        if (data) {
          const agentType = data.agent_type as string
          const agentIndex = data.agent_index as number | undefined

          if (agentType === 'tester' && agentIndex !== undefined) {
            // Testers have one task per active coder (T×C matrix). Only show
            // "done" when ALL coder audits for this tester are complete —
            // otherwise the UI misleadingly shows "Complete" while the
            // asyncio.gather is still waiting for remaining tasks.
            setWorkflowState(prev => {
              const completions = { ...prev.testerCompletions }
              completions[agentIndex] = (completions[agentIndex] || 0) + 1
              const allDone = completions[agentIndex] >= prev.activeCoderCount
              if (allDone) {
                updateNodeStatus('tester', agentIndex, 'done', { ...data, timeoutAt: undefined, agentTimeoutAt: undefined, requestTimeoutAt: undefined, sandboxTimeoutAt: undefined })
                stopEdgesForAgent('tester', agentIndex)
              }
              return {
                ...prev,
                testersDone: prev.testersDone + 1,
                testerCompletions: completions,
                totalTokens: prev.totalTokens + ((data.tokens as number) || 0),
                totalCost: prev.totalCost + ((data.cost as number) || 0),
              }
            })
          } else {
            // Non-tester agents: show 'done' immediately
            updateNodeStatus(agentType, agentIndex, 'done', { ...data, timeoutAt: undefined, agentTimeoutAt: undefined, requestTimeoutAt: undefined, sandboxTimeoutAt: undefined })
            stopEdgesForAgent(agentType, agentIndex)

            setWorkflowState(prev => ({
              ...prev,
              codersDone: agentType === 'coder' ? prev.codersDone + 1 : prev.codersDone,
              totalTokens: prev.totalTokens + ((data.tokens as number) || 0),
              totalCost: prev.totalCost + ((data.cost as number) || 0),
            }))
          }

          // Animate outgoing edges appropriately
          // - Summarizer: only animate feedback edges back to coders (not edge to finalizer)
          // - Finalizer: animate edge to output
          // (coders' outgoing edges are animated when testers start)
          if (agentType === 'summarizer') {
            // Only animate feedback edges, not the edge to finalizer
            animateFeedbackEdges()
          } else if (agentType === 'finalizer') {
            animateEdgesFromNode(agentType, agentIndex)
          }
        }
        break

      case 'agent_error':
        if (data) {
          const errorStr = (data.error as string) || ''
          const isTimeout = /timed?\s*out/i.test(errorStr)
          // Extract timeout seconds from error message like "Coder timed out after 600s"
          const timeoutMatch = errorStr.match(/(\d+)\s*s/)
          const timeoutSec = timeoutMatch ? timeoutMatch[1] : null

          updateNodeStatus(
            data.agent_type as string,
            data.agent_index as number | undefined,
            isTimeout ? 'timeout' : 'error',
            {
              timeoutAt: undefined, agentTimeoutAt: undefined, requestTimeoutAt: undefined, sandboxTimeoutAt: undefined,
              ...(isTimeout && timeoutSec ? { status_text: `Timed out (${timeoutSec}s)` } : {}),
            },
          )
          // Stop edge animations for this agent
          stopEdgesForAgent(data.agent_type as string, data.agent_index as number | undefined)

          if (isTimeout) {
            notify.warning(formatErrorForToast(errorStr), {
              title: formatAgentLabel(data.agent_type as string, data.agent_index as number | undefined),
            })
          } else {
            notify.error(formatErrorForToast(errorStr), {
              title: formatAgentLabel(data.agent_type as string, data.agent_index as number | undefined),
            })
          }
        }
        break

      case 'agent_retry':
        if (data) {
          const agentType = data.agent_type as string
          const agentIndex = data.agent_index as number | undefined
          const attempt = data.attempt as number
          const maxAttempts = data.max_attempts as number
          const delay = data.delay as number
          
          // Keep working status but show retry info
          updateNodeStatus(agentType, agentIndex, 'working', { 
            status_text: `Retry ${attempt}/${maxAttempts}...` 
          })
          notify.warning(`API overloaded, retrying in ${delay}s...`, {
            title: formatAgentLabel(agentType, agentIndex),
            duration: 5000,
          })
        }
        break

      case 'agent_fallback':
        if (data) {
          const agentType = data.agent_type as string
          const agentIndex = data.agent_index as number | undefined
          const reason = data.reason as string
          
          // Show warning status (yellow) - using previous code
          updateNodeStatus(agentType, agentIndex, 'waiting', { 
            status_text: 'Using previous code' 
          })
          notify.warning(`${reason}. Using previous iteration code.`, {
            title: formatAgentLabel(agentType, agentIndex),
            duration: 5000,
          })
        }
        break

      // Code execution events
      case 'code_execution_started':
        if (data) {
          const coderIndex = data.coder_index as number
          const attempt = data.attempt as number
          const maxAttempts = data.max_attempts as number

          updateNodeStatus('coder', coderIndex, 'executing', {
            fixAttempt: attempt,
            maxFixAttempts: maxAttempts,
            sandboxTimeoutAt: Date.now() + executionTimeoutRef.current * 1000,
            requestTimeoutAt: undefined,
          })
        }
        break

      case 'code_execution_completed':
        if (data) {
          const coderIndex = data.coder_index as number
          const success = data.success as boolean
          
          if (success) {
            // Execution succeeded, go back to done state.
            // VR-47 — record the run→fix outcome for the persistent green badge.
            updateNodeStatus('coder', coderIndex, 'done', {
              runFixCount: data.attempt as number,
              runFixClean: true,
            })
          }
          // If not success, fixing_started will follow
        }
        break

      case 'code_fixing_started':
        if (data) {
          const coderIndex = data.coder_index as number
          const attempt = data.attempt as number

          // Use updateNodeStatus (not WithFix) to set timeouts for the fixing LLM call
          updateNodeStatus('coder', coderIndex, 'fixing', {
            fixAttempt: attempt,
            agentTimeoutAt: Date.now() + agentTimeoutRef.current * 1000,
            requestTimeoutAt: Date.now() + requestTimeoutRef.current * 1000,
            sandboxTimeoutAt: undefined,
          })

          notify.info(`Fixing execution error (attempt ${attempt})`, {
            title: `Coder ${coderIndex + 1}`,
            duration: 3000,
          })
        }
        break

      case 'code_fixing_completed':
        if (data) {
          const coderIndex = data.coder_index as number
          const fixDescription = data.fix_description as string
          
          // Code was fixed, will try execution again
          if (fixDescription) {
            notify.success(`Coder ${coderIndex + 1}: ${fixDescription.slice(0, 100)}`)
          }
        }
        break

      case 'code_fixing_failed':
        if (data) {
          const coderIndex = data.coder_index as number
          const error = data.error as string
          
          notify.error(formatErrorForToast(error || 'Fix attempt failed'), { title: `Coder ${coderIndex + 1} — Fix Failed` })
        }
        break

      case 'finalizer_executing_code':
        if (data) {
          const coderIndex = data.coder_index as number

          // Show finalizer is executing code from a specific coder
          updateNodeStatus('finalizer', undefined, 'executing')
          notify.info(`Executing Coder ${coderIndex + 1}'s code...`, {
            title: 'Finalizer',
            duration: 2000,
          })
        }
        break

      case 'finalizer_verifying_code':
        updateNodeStatus('finalizer', undefined, 'executing')
        notify.info('Verifying final code...', { title: 'Finalizer', duration: 3000 })
        break

      case 'finalizer_verification_complete':
        if (data) {
          const passed = data.passed as boolean
          if (passed) {
            notify.success('Final code verification passed!', { title: 'Finalizer' })
          } else {
            notify.warning(`Final code verification failed (exit code: ${data.exit_code})`, { title: 'Finalizer' })
          }
        }
        break

      // Tester execution events — node status change provides visual feedback,
      // no toast needed (with N coders × M testers it creates too much noise)
      case 'tester_executing_code':
        if (data) {
          const testerIndex = data.tester_index as number
          updateNodeStatus('tester', testerIndex, 'executing')
        }
        break

      case 'tester_execution_completed':
        if (data) {
          const testerIndex = data.tester_index as number
          const success = data.success as boolean
          
          // Return to working status (tester continues with analysis)
          updateNodeStatus('tester', testerIndex, 'working')
          
          if (!success) {
            notify.warning('Code execution failed', {
              title: `Tester ${testerIndex + 1}`,
              duration: 3000,
            })
          }
        }
        break

      case 'iteration_completed':
        stopAllEdgeAnimations()
        // Refresh checkpoints after each iteration (orchestrator saves one per iter)
        if (sessionId) {
          listCheckpoints(sessionId)
            .then(setCheckpoints)
            .catch(() => { /* non-fatal */ })
        }
        break

      case 'coder_finished':
        if (data) {
          const coderIndex = data.coder_index as number
          const reason = data.reason as string
          const coderIteration = data.iteration as number
          
          // Mark coder as finished with 'done' status
          updateNodeStatus('coder', coderIndex, 'done', { iteration: coderIteration })
          
          setWorkflowState(prev => {
            const newFinished = new Set(prev.finishedCoders)
            newFinished.add(coderIndex)
            return {
              ...prev,
              finishedCoders: newFinished,
              coderIterations: {
                ...prev.coderIterations,
                [coderIndex]: coderIteration,
              },
              coderFinishReasons: {
                ...prev.coderFinishReasons,
                [coderIndex]: reason,
              },
            }
          })
          
          const reasonText = reason === 'no_issues' 
            ? 'No critical/serious issues' 
            : 'Max iterations reached'
          notify.success(`Coder ${coderIndex + 1} finished: ${reasonText}`)
        }
        break

      case 'workflow_completed':
        loadSession()
        notify.success(data?.re_finalize ? 'Re-finalization complete!' : 'Workflow completed!')
        setWorkflowState(prev => ({ ...prev, phase: 'completed' }))
        updateNodeStatus('output', undefined, 'done')
        break

      // Enhancement events — update node status and session
      case 'enhancer_started':
        // Update session status without full graph rebuild (loadSession would
        // reset all node statuses to idle, wiping pipeline "done" states).
        setSession(prev => prev ? { ...prev, status: 'enhancing' } : prev)
        setWorkflowState(prev => ({ ...prev, phase: 'enhancing' }))
        // VR-43 — Mark main pipeline as done AND start pulsing the enabled
        // D/F/S enhancers immediately. Without this we get a visible pulse
        // gap between `enhancer_started` (phase=enhancing) and the first
        // per-agent `enhancer_agent_started`: the user sees "phase active
        // but nothing is pulsing", which looks like the process is stuck
        // waiting on user input. Per-agent timeouts are filled in later by
        // the individual `enhancer_agent_started` events.
        {
          const enabledEnhancerTypes = new Set(
            (session?.agent_configs || [])
              .filter((c: any) => c.agent_type?.startsWith('enhancer_')
                && c.agent_type !== 'enhancer_summary'
                && c.enabled !== false)
              .map((c: any) => c.agent_type as string)
          )
          setNodes((nds: any[]) =>
            nds.map((node: any) => {
              // Main pipeline → done (coding finished)
              if (node.id.startsWith('coder-') || node.id.startsWith('tester-') ||
                  node.id === 'summarizer' || node.id === 'finalizer' || node.id === 'output') {
                return { ...node, data: { ...node.data, status: 'done' } }
              }
              // Enabled D/F/S enhancers → start pulsing immediately
              if (node.id.startsWith('enhancer-') && node.id !== 'enhancer-summarizer') {
                if (enabledEnhancerTypes.has(node.data.agentType)) {
                  return { ...node, data: { ...node.data, status: 'working' } }
                }
              }
              return node
            })
          )
        }
        // Stop all main pipeline edge animations
        setEdges((eds: any[]) =>
          eds.map((edge: any) => {
            // Only stop animations on non-enhancer edges
            if (!edge.target?.startsWith('enhancer-')) {
              return { ...edge, data: { ...edge.data, animated: false, hasArtifact: true } }
            }
            return edge
          })
        )
        break

      case 'enhancer_agent_started': {
        const enhNodeId = enhancerTypeToNodeId(String(data?.agent_type || ''))
        if (enhNodeId) {
          updateEnhancerNode(enhNodeId, 'working', {
            agentTimeoutAt: Date.now() + agentTimeoutRef.current * 1000,
            requestTimeoutAt: Date.now() + requestTimeoutRef.current * 1000,
          })
          // Animate edges flowing into this enhancement node
          setEdges((eds: any[]) =>
            eds.map((edge: any) => {
              if (edge.target === enhNodeId) {
                return { ...edge, data: { ...edge.data, animated: true, hasArtifact: true } }
              }
              return edge
            })
          )
          // Auto-scroll: center on the enhancer's group (Design/Func/Security
          // siblings) for a contextual frame, not just the single node.
          panToGroup(String(data?.agent_type || ''))
        }
        break
      }

      case 'enhancer_agent_completed': {
        const enhNodeId = enhancerTypeToNodeId(String(data?.agent_type || ''))
        if (enhNodeId) {
          // VR-40 — keep the enhancer node in `working` state (pulse stays on)
          // even after this individual agent finished. The "Enhancement phase"
          // isn't over until the Summarizer starts, so the visual pulse must
          // continue until then. We DO clear timeouts and stash a per-agent
          // "finished" marker so the AgentNode can render a small completion
          // badge (suggestions count) without dropping the pulse animation.
          const suggestionsCount = Number(data?.suggestions_count ?? 0)
          updateEnhancerNode(enhNodeId, 'working', {
            agentTimeoutAt: undefined,
            requestTimeoutAt: undefined,
            timeoutAt: undefined,
            agentFinishedAt: Date.now(),
            status_text: suggestionsCount > 0
              ? `✓ ${suggestionsCount} suggestion${suggestionsCount === 1 ? '' : 's'} ready`
              : '✓ Complete',
          })
          // Stop incoming edge animations, animate outgoing edges. The node
          // itself keeps pulsing but its in-flow is no longer active.
          setEdges((eds: any[]) =>
            eds.map((edge: any) => {
              if (edge.target === enhNodeId) {
                return { ...edge, data: { ...edge.data, animated: false } }
              }
              if (edge.source === enhNodeId) {
                return { ...edge, data: { ...edge.data, animated: true, hasArtifact: true } }
              }
              return edge
            })
          )
        }
        break
      }

      case 'enhancer_agent_error': {
        const enhNodeId = enhancerTypeToNodeId(String(data?.agent_type || ''))
        if (enhNodeId) {
          const errorStr = String(data?.error || '')
          const isTimeout = /timed?\s*out/i.test(errorStr)
          const timeoutMatch = errorStr.match(/(\d+)\s*s/)
          const timeoutSec = timeoutMatch ? timeoutMatch[1] : null

          updateEnhancerNode(enhNodeId, isTimeout ? 'timeout' : 'error', {
            timeoutAt: undefined, agentTimeoutAt: undefined, requestTimeoutAt: undefined,
            ...(isTimeout && timeoutSec ? { status_text: `Timed out (${timeoutSec}s)` } : {}),
          })
          setEdges((eds: any[]) =>
            eds.map((edge: any) => {
              if (edge.target === enhNodeId) {
                return { ...edge, data: { ...edge.data, animated: false } }
              }
              return edge
            })
          )

          const label = data?.agent_type
            ? String(data.agent_type).replace('enhancer_', '').replace('_', ' ')
            : 'Enhancer'
          if (isTimeout) {
            notify.warning(formatErrorForToast(errorStr), { title: `Enhancement ${label}` })
          } else {
            notify.error(formatErrorForToast(errorStr), { title: `Enhancement ${label}` })
          }
        }
        break
      }

      case 'enhancer_summarizer_started':
        // VR-40 — Enhancement phase (D/F/S agents) is officially over now;
        // mark them as 'done' so their pulse stops and the visual phase
        // baton hand-off is clean: D/F/S → idle, Summarizer → working.
        setNodes((nds: any[]) =>
          nds.map((node: any) => {
            if (node.id.startsWith('enhancer-') && node.id !== 'enhancer-summarizer') {
              return {
                ...node,
                data: {
                  ...node.data,
                  status: 'done',
                  agentTimeoutAt: undefined,
                  requestTimeoutAt: undefined,
                  timeoutAt: undefined,
                },
              }
            }
            return node
          })
        )
        updateEnhancerNode('enhancer-summarizer', 'working', {
          agentTimeoutAt: Date.now() + agentTimeoutRef.current * 1000,
          requestTimeoutAt: Date.now() + requestTimeoutRef.current * 1000,
        })
        setEdges((eds: any[]) =>
          eds.map((edge: any) => {
            if (edge.target === 'enhancer-summarizer') {
              return { ...edge, data: { ...edge.data, animated: true, hasArtifact: true } }
            }
            return edge
          })
        )
        // Auto-scroll to the Enhancers group (summarizer is the final stage)
        panToGroup('enhancer_summary')
        break

      case 'enhancer_summarizer_completed':
        // VR-40 — keep the Summarizer node pulsing until the session
        // transitions to `awaiting_enhancement_review`. Between this event
        // and the review event there's a DB commit (line 2885-2891 in
        // backend) plus broadcast latency; the pulse must not die during
        // that gap. We only update the status_text + outgoing-edge anim.
        updateEnhancerNode('enhancer-summarizer', 'working', {
          agentTimeoutAt: undefined,
          requestTimeoutAt: undefined,
          timeoutAt: undefined,
          agentFinishedAt: Date.now(),
          status_text: '✓ Summary ready',
        })
        setEdges((eds: any[]) =>
          eds.map((edge: any) => {
            if (edge.target === 'enhancer-summarizer') {
              return { ...edge, data: { ...edge.data, animated: false } }
            }
            if (edge.source === 'enhancer-summarizer') {
              return { ...edge, data: { ...edge.data, animated: true, hasArtifact: true } }
            }
            return edge
          })
        )
        break

      case 'enhancer_summarizer_error': {
        const errorStr = String(data?.error || '')
        const isTimeout = /timed?\s*out/i.test(errorStr)
        const timeoutMatch = errorStr.match(/(\d+)\s*s/)
        const timeoutSec = timeoutMatch ? timeoutMatch[1] : null

        updateEnhancerNode('enhancer-summarizer', isTimeout ? 'timeout' : 'error', {
          timeoutAt: undefined, agentTimeoutAt: undefined, requestTimeoutAt: undefined,
          ...(isTimeout && timeoutSec ? { status_text: `Timed out (${timeoutSec}s)` } : {}),
        })
        setEdges((eds: any[]) =>
          eds.map((edge: any) => {
            if (edge.target === 'enhancer-summarizer') {
              return { ...edge, data: { ...edge.data, animated: false } }
            }
            return edge
          })
        )

        if (isTimeout) {
          notify.warning(formatErrorForToast(errorStr), { title: 'Enhancement Summarizer' })
        } else {
          notify.error(formatErrorForToast(errorStr), { title: 'Enhancement Summarizer' })
        }
        break
      }

      case 'enhancer_error':
        notify.error(formatErrorForToast((data?.error as string) || 'Unknown'), { title: 'Enhancement Error' })
        loadSession()
        break

      case 'awaiting_enhancement':
        notify.success(data?.re_finalize ? 'Re-finalization complete!' : 'Final code ready — configure enhancement agents')
        loadSession()
        break

      case 'awaiting_enhancement_review':
        notify.success('Enhancement analysis complete — review suggestions')
        // VR-40 — phase is officially over now: stop the Summarizer pulse
        // (we deferred it from `enhancer_summarizer_completed` so the pulse
        // bridges the DB-commit gap between completion and this event).
        // Also defensively mark D/F/S as 'done' in case the
        // `enhancer_summarizer_started` handler somehow missed them.
        setNodes((nds: any[]) =>
          nds.map((node: any) => {
            if (node.id.startsWith('enhancer-')) {
              return {
                ...node,
                data: {
                  ...node.data,
                  status: 'done',
                  agentTimeoutAt: undefined,
                  requestTimeoutAt: undefined,
                  timeoutAt: undefined,
                },
              }
            }
            return node
          })
        )
        loadSession()
        break

      // КАО#VR-Wave1 Frontend — Visual Review: backend emits this when
      // candidate screenshots are ready and the workflow has paused for
      // user scoring. We refresh session state (status flips to
      // 'awaiting_visual_review') which triggers the auto-open effect.
      case 'visual_review_ready':
        notify.success('Visual review ready — score the candidates')
        loadSession()
        break

      // КАО#VR-11 RestartFromScratch — server flushed all artifacts and is
      // re-running from iteration 0. Close every results / review panel so
      // stale data doesn't linger, then reload the session so the graph
      // rebuilds against the fresh state.
      case 'session_restarted':
        notify.info('Session restarted from scratch')
        setFinalResult(null)
        setExecutionResult(null)
        setShowExecution(false)
        setShowCode(false)
        setShowBrowserPreview(false)
        setBrowserPreviewHtml('')
        setShowEnhancementReview(false)
        setEnhancementSuggestions([])
        setCuratedItems([])
        setShowVisualReview(false)
        setSelectedNode(null)
        setSelectedNodeData(null)
        setPRResult(null)
        loadSession()
        break

      case 'enhancement_session_created':
        if (data?.new_session_id) {
          notify.success('Enhancement session created! Redirecting...')
        }
        break

      case 'workflow_error':
      case 'workflow_failed':
        if (data) {
          notify.error(formatErrorForToast(data.error as string), { title: 'Workflow Failed' })
        }
        // Stop all edge animations immediately
        setEdges((eds: any[]) =>
          eds.map((edge: any) => ({
            ...edge,
            data: { ...edge.data, animated: false },
          }))
        )
        // Mark any still-working nodes as error (safety net)
        setNodes((nds: any[]) =>
          nds.map((node: any) => {
            if (node.data?.status === 'working') {
              return { ...node, data: { ...node.data, status: 'error', timeoutAt: undefined, agentTimeoutAt: undefined, requestTimeoutAt: undefined, sandboxTimeoutAt: undefined } }
            }
            return node
          })
        )
        setWorkflowState(prev => ({ ...prev, phase: 'idle' }))
        // Refresh session data WITHOUT rebuilding graph (preserves timeout/error node statuses)
        getSession(sessionId!).then(freshData => {
          setSession(freshData)
          getFinalResult(sessionId!).then(result => setFinalResult(result)).catch(() => {})
        }).catch(() => {
          loadSession()
        })
        break

      case 'agent_streaming': {
        // Feature #1: backend emits incremental LLM output when
        // session.settings.streaming === true. Append partial text to the
        // matching node and toggle isStreaming based on is_final.
        if (!data) break
        const agent_type = data.agent_type as string
        const agent_index = data.agent_index as number | undefined
        const partial_content = (data.partial_content as string) || ''
        const is_final = data.is_final === true
        setNodes((nds: any[]) =>
          nds.map((n: any) => {
            const matches =
              n.data?.agentType === agent_type &&
              n.data?.agentIndex === agent_index
            if (!matches) return n
            const prevText = (n.data.streamingContent as string | undefined) || ''
            return {
              ...n,
              data: {
                ...n.data,
                streamingContent: prevText + partial_content,
                isStreaming: !is_final,
              },
            }
          })
        )
        break
      }

      case 'workflow_cancelled':
        notify.info('Workflow cancelled')
        // КАО#VR-31 — clear streaming overlays on cancel/reset. Without
        // this, a coder node that was mid-stream when the user clicked
        // Cancel keeps its STREAMING badge + last partial code forever,
        // even after the session is reset back to 'created'.
        setNodes((nds: any[]) =>
          nds.map((n: any) => ({
            ...n,
            data: {
              ...n.data,
              isStreaming: false,
              streamingContent: undefined,
            },
          }))
        )
        loadSession()
        break

      case 'session_reset':
        // КАО#VR-31 — same cleanup as workflow_cancelled. The /reset
        // endpoint (КАО#VR-19) emits session_reset after dropping
        // artifacts; mirror its behavior in the UI to avoid stale streams.
        setNodes((nds: any[]) =>
          nds.map((n: any) => ({
            ...n,
            data: {
              ...n.data,
              isStreaming: false,
              streamingContent: undefined,
            },
          }))
        )
        loadSession()
        break
    }
  }

  function updateNodeStatus(
    agentType: string,
    agentIndex: number | undefined,
    status: string,
    data?: Record<string, unknown>
  ) {
    setNodes((nds: any[]) =>
      nds.map((node: any) => {
        const nodeId = agentIndex !== undefined
          ? `${agentType}-${agentIndex}`
          : agentType

        if (node.id === nodeId) {
          return {
            ...node,
            data: {
              ...node.data,
              status,
              status_text: (data?.status_text as string) || undefined,
              iteration: (data?.iteration as number) ?? node.data.iteration,
              tokensUsed: (data?.tokens as number) ?? node.data.tokensUsed,
              costUsd: (data?.cost as number) ?? node.data.costUsd,
              issuesFound: (data?.issues_found as number) ?? node.data.issuesFound,
              fixAttempt: (data?.fixAttempt as number) ?? node.data.fixAttempt,
              maxFixAttempts: (data?.maxFixAttempts as number) ?? node.data.maxFixAttempts,
              // VR-47 — run→fix badge data; preserved across updates unless set.
              runFixCount: (data?.runFixCount as number) ?? node.data.runFixCount,
              runFixClean: (data && 'runFixClean' in data) ? (data.runFixClean as boolean) : node.data.runFixClean,
              // Preserve timeout fields unless explicitly set in data (even to undefined = clear)
              timeoutAt: data && 'timeoutAt' in data
                ? (data.timeoutAt as number | undefined)
                : node.data.timeoutAt,
              agentTimeoutAt: data && 'agentTimeoutAt' in data
                ? (data.agentTimeoutAt as number | undefined)
                : node.data.agentTimeoutAt,
              requestTimeoutAt: data && 'requestTimeoutAt' in data
                ? (data.requestTimeoutAt as number | undefined)
                : node.data.requestTimeoutAt,
              sandboxTimeoutAt: data && 'sandboxTimeoutAt' in data
                ? (data.sandboxTimeoutAt as number | undefined)
                : node.data.sandboxTimeoutAt,
            },
          }
        }
        return node
      })
    )
  }

  // Map enhancer agent_type to ReactFlow node ID
  function enhancerTypeToNodeId(agentType: string): string | null {
    const map: Record<string, string> = {
      enhancer_design: 'enhancer-design',
      enhancer_func: 'enhancer-functionality',
      enhancer_security: 'enhancer-security',
      enhancer_summary: 'enhancer-summarizer',
    }
    return map[agentType] || null
  }

  function updateEnhancerNode(nodeId: string, status: string, extraData?: Record<string, unknown>) {
    setNodes((nds: any[]) =>
      nds.map((node: any) => {
        if (node.id === nodeId) {
          // If backend is actively running/completed this agent, ensure it's not shown as disabled
          const clearDisabled = status === 'working' || status === 'done'
          return { ...node, data: { ...node.data, status, ...(clearDisabled ? { disabled: false } : {}), ...extraData } }
        }
        return node
      })
    )
  }

  // Group drag — click-and-hold on empty space inside a group frame, then drag
  // → moves the entire group together (preserves relative positions).
  // Individual node drag (clicking on a node itself) still works as React Flow default.
  const onGroupDragStart = useCallback((groupPrefix: string, startEvent: React.MouseEvent) => {
    const startClientX = startEvent.clientX
    const startClientY = startEvent.clientY
    const zoom = reactFlowInstanceRef.current?.getViewport?.()?.zoom ?? 1

    // Snapshot all nodes in this group at drag start
    const snapshot = nodes
      .filter((n: any) => n.id.startsWith(groupPrefix))
      .map((n: any) => ({ id: n.id, x: n.position.x, y: n.position.y }))
    if (snapshot.length === 0) return

    let lastDx = NaN, lastDy = NaN

    const onMove = (e: MouseEvent) => {
      const dx = (e.clientX - startClientX) / zoom
      const dy = (e.clientY - startClientY) / zoom
      if (dx === lastDx && dy === lastDy) return
      lastDx = dx; lastDy = dy
      setNodes((curr: any[]) =>
        curr.map((n: any) => {
          const snap = snapshot.find(s => s.id === n.id)
          if (snap) return { ...n, position: { x: snap.x + dx, y: snap.y + dy } }
          return n
        })
      )
    }

    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }

    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'grabbing'
  }, [nodes, setNodes])

  // Auto-pan target zoom: capture the user's current viewport zoom at the FIRST
  // auto-pan, then always pan to baseZoom * 1.1 (so every transition produces
  // the same ~10% zoom-in and we never drift up across many phases).
  const autoPanBaseZoomRef = useRef<number | null>(null)
  function getZoomedInLevel(): number {
    const rf = reactFlowInstanceRef.current
    if (!rf) return 1.0
    if (autoPanBaseZoomRef.current === null) {
      const current = rf.getViewport?.()?.zoom ?? 1.0
      autoPanBaseZoomRef.current = current
    }
    return autoPanBaseZoomRef.current * 1.25
  }

  // Auto-scroll: smoothly pan the graph to center on the given node (legacy,
  // kept for single-target fallback). +10% relative zoom-in.
  // Улучшатели#3 wave 2 #3 — respect the lockViewport toggle; bail out when locked.
  function panToNode(nodeId: string) {
    if (lockViewportRef.current) return
    const rf = reactFlowInstanceRef.current
    if (!rf) return
    const node = rf.getNode(nodeId)
    if (node) {
      rf.setCenter(node.position.x + 110, node.position.y + 70, { zoom: getZoomedInLevel(), duration: 500 })
    }
  }

  // Auto-scroll: smoothly pan/zoom to center the GROUP containing the active
  // agent (Coders, Testers, Enhancers, etc.). Light ~10% zoom-in so the group
  // is highlighted but the rest of the graph stays in view.
  // Maps agent identifier → set of nodes that form the group.
  function panToGroup(agentType: string, agentIndex?: number) {
    // Улучшатели#3 wave 2 #3 — respect the lockViewport toggle; bail out when locked.
    if (lockViewportRef.current) return
    const rf = reactFlowInstanceRef.current
    if (!rf) return

    // Pick the group node id prefix (or single-node id) based on agent type
    let prefix: string | null = null
    let singleId: string | null = null
    if (agentType === 'coder') prefix = 'coder-'
    else if (agentType === 'tester') prefix = 'tester-'
    else if (agentType === 'summarizer') singleId = 'summarizer'
    else if (agentType === 'finalizer') singleId = 'finalizer'
    // All enhancer_* agents belong to the Enhancers group (frame covers
    // design/func/security AND the enhancer-summarizer below them).
    else if (agentType.startsWith('enhancer')) prefix = 'enhancer-'

    // Helper to center on a bbox
    const NODE_W = 220, NODE_H = 140
    const centerOnBbox = (minX: number, minY: number, maxX: number, maxY: number) => {
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      // ~10% relative zoom-in on top of the user's current viewport zoom
      rf.setCenter(cx, cy, { zoom: getZoomedInLevel(), duration: 500 })
    }

    // Single-node group → behave like panToNode but with a richer bbox
    if (singleId) {
      const n = rf.getNode(singleId)
      if (n) centerOnBbox(n.position.x, n.position.y, n.position.x + NODE_W, n.position.y + NODE_H)
      return
    }

    if (prefix) {
      // For enhancer types, also include design/func/security siblings as a group
      const allNodes = rf.getNodes()
      const groupNodes = allNodes.filter((n: any) => n.id.startsWith(prefix!))
      if (groupNodes.length === 0) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of groupNodes) {
        if (n.position.x < minX) minX = n.position.x
        if (n.position.y < minY) minY = n.position.y
        if (n.position.x + NODE_W > maxX) maxX = n.position.x + NODE_W
        if (n.position.y + NODE_H > maxY) maxY = n.position.y + NODE_H
      }
      centerOnBbox(minX, minY, maxX, maxY)
      return
    }

    // Fallback: single-node pan
    const fallbackId = agentIndex !== undefined ? `${agentType}-${agentIndex}` : agentType
    panToNode(fallbackId)
  }

  function updateAllAgentStatuses(agentType: string, status: string) {
    setNodes((nds: any[]) =>
      nds.map((node: any) => {
        if (node.id.startsWith(`${agentType}-`)) {
          return {
            ...node,
            data: {
              ...node.data,
              status,
            },
          }
        }
        return node
      })
    )
  }

  function animateEdgesToNode(agentType: string, agentIndex: number | undefined, coderIndex?: number) {
    const targetId = agentIndex !== undefined ? `${agentType}-${agentIndex}` : agentType

    setEdges((eds: any[]) =>
      eds.map((edge: any) => {
        // For testers, only animate edge from the specific coder being tested
        if (agentType === 'tester' && coderIndex !== undefined) {
          const expectedEdgeId = `coder-${coderIndex}-${targetId}`
          if (edge.id === expectedEdgeId) {
            return {
              ...edge,
              data: {
                ...edge.data,
                animated: true,
                hasArtifact: true,
              },
            }
          }
          return edge
        }

        // For coders, skip feedback/enhancer edges — those are animated
        // explicitly by animateFeedbackEdges() / enhancer events
        if (agentType === 'coder' && edge.target === targetId) {
          if (edge.id.includes('feedback') || edge.source === 'enhancer-summarizer') {
            return edge  // Don't animate these here
          }
          return {
            ...edge,
            data: {
              ...edge.data,
              animated: true,
              hasArtifact: true,
            },
          }
        }

        // For other agents, animate all incoming edges
        if (edge.target === targetId) {
          return {
            ...edge,
            data: {
              ...edge.data,
              animated: true,
              hasArtifact: true,
            },
          }
        }
        return edge
      })
    )
  }

  function animateEdgesFromNode(agentType: string, agentIndex: number | undefined) {
    const sourceId = agentIndex !== undefined ? `${agentType}-${agentIndex}` : agentType
    
    setEdges((eds: any[]) =>
      eds.map((edge: any) => {
        if (edge.source === sourceId && !edge.id.includes('feedback')) {
          return {
            ...edge,
            data: {
              ...edge.data,
              animated: true,
              hasArtifact: true,
            },
          }
        }
        return edge
      })
    )
  }

  // Animate only feedback edges from summarizer back to coders (for next iteration)
  function animateFeedbackEdges() {
    setEdges((eds: any[]) =>
      eds.map((edge: any) => {
        if (edge.id.includes('feedback')) {
          return {
            ...edge,
            data: {
              ...edge.data,
              animated: true,
              hasArtifact: true,
            },
          }
        }
        return edge
      })
    )
  }

  function stopEdgesForAgent(agentType: string, agentIndex: number | undefined) {
    const nodeId = agentIndex !== undefined ? `${agentType}-${agentIndex}` : agentType
    
    setEdges((eds: any[]) =>
      eds.map((edge: any) => {
        // Stop edges going TO this node
        if (edge.target === nodeId) {
          return {
            ...edge,
            data: {
              ...edge.data,
              animated: false,
            },
          }
        }
        return edge
      })
    )
  }

  function stopAllEdgeAnimations() {
    setEdges((eds: any[]) =>
      eds.map((edge: any) => ({
        ...edge,
        data: {
          ...edge.data,
          animated: false,
        },
      }))
    )
  }

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: any) => {
    setAgentConfigPopup(null)
    const data = node.data as AgentNodeData
    // Open Specifications dialog when clicking on the input/Specification node
    if (data.agentType === 'input') {
      setShowSpecificationsDialog(true)
      return
    }
    setSelectedNode(node.id)
    setSelectedNodeData(data)
    // Улучшатели#3 P2·M — record in panel history.
    pushPanel('detail')
  }, [pushPanel])

  async function handleStart() {
    setActionLoading(true)
    try {
      await startSession(sessionId!)
      loadSession()
    } catch (err) {
      notify.error('Failed to start session')
    } finally {
      setActionLoading(false)
    }
  }

  function handleOpenSaveTemplate() {
    setTemplateName(session?.name ? `${session.name} template` : '')
    setTemplateDescription('')
    setShowSaveTemplate(true)
  }

  async function handleSaveTemplate() {
    const name = templateName.trim()
    if (!name) {
      notify.error('Template name is required')
      return
    }
    setSavingTemplate(true)
    try {
      await createTemplateFromSession(sessionId!, name, templateDescription.trim() || undefined)
      notify.success('Template saved')
      setShowSaveTemplate(false)
      setTemplateName('')
      setTemplateDescription('')
    } catch (err: any) {
      notify.error(err?.message || 'Failed to save template')
    } finally {
      setSavingTemplate(false)
    }
  }

  async function handlePause() {
    // Улучшатели#3 wave 2 #1 — surface backend error message verbatim so the
    // user sees "session status is not pauseable" when status mismatches
    // (e.g. trying to pause `enhancing` if the backend hasn't wired that yet).
    setActionLoading(true)
    try {
      await pauseSession(sessionId!)
      notify.success('Session paused')
      loadSession()
    } catch (err: any) {
      const msg = err?.message || err?.response?.data?.detail || 'Failed to pause session'
      notify.error(formatErrorForToast(String(msg)))
    } finally {
      setActionLoading(false)
    }
  }

  // Улучшатели#3 wave 2 #2 — Retry from failed step. No backend endpoint yet
  // (services/api.ts has no retrySession / retryAgent helpers). Scaffolded UI
  // wires to a placeholder so the affordance exists for design review and the
  // wiring is one obvious change away once the backend route lands.
  async function handleRetryFromFailed() {
    // TODO(backend): wire to POST /api/sessions/:id/retry-from-failed once the
    // route exists. For now we resume + toast so the user gets feedback.
    setActionLoading(true)
    try {
      // Best-effort: try the existing resume path. The backend may reject this
      // for `failed` sessions; if it does we explain and surface the error.
      await resumeSession(sessionId!)
      notify.success('Retry requested')
      loadSession()
    } catch (err: any) {
      const msg = err?.message || err?.response?.data?.detail || 'Retry not supported yet — backend wiring pending'
      notify.warning(formatErrorForToast(String(msg)), { title: 'Retry' })
    } finally {
      setActionLoading(false)
    }
  }

  // Улучшатели#3 wave 2 #2 — Retry an individual agent (from the side panel /
  // node-level affordance shown when status is error/timeout). No backend
  // endpoint yet; scaffolded with TODO so wiring is a one-shot follow-up.
  async function handleRetryAgent(agentType: string, agentIndex?: number) {
    // TODO(backend): wire to POST /api/sessions/:id/agents/:type/:index/retry.
    // Until then, just toast so users know the button is provisional.
    notify.info(
      `Retry for ${agentType}${agentIndex !== undefined ? ` ${agentIndex + 1}` : ''} requested — backend wiring pending`,
      { title: 'Retry agent' },
    )
  }

  async function handleResume() {
    setActionLoading(true)
    try {
      await resumeSession(sessionId!)
      notify.success('Session resumed')
      loadSession()
    } catch (err) {
      notify.error('Failed to resume session')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleCancel() {
    // Улучшатели#3 wave 2 #1 — surface backend error verbatim (status mismatch).
    setActionLoading(true)
    try {
      await cancelSession(sessionId!)
      notify.success('Session cancelled')
      loadSession()
    } catch (err: any) {
      const msg = err?.message || err?.response?.data?.detail || 'Failed to cancel session'
      notify.error(formatErrorForToast(String(msg)))
    } finally {
      setActionLoading(false)
    }
  }

  function handleReset() {
    setShowResetConfirm(true)
  }

  async function handleResetConfirmed() {
    setShowResetConfirm(false)
    setActionLoading(true)
    try {
      await resetSession(sessionId!)
      // Clear all session-related state so UI reflects "just created"
      setFinalResult(null)
      setExecutionResult(null)
      setShowExecution(false)
      setShowCode(false)
      setShowBrowserPreview(false)
      setBrowserPreviewHtml('')
      setShowEnhancementReview(false)
      setEnhancementSuggestions([])
      setCuratedItems([])
      setEnhancementLoading(false)
      setShowIntervention(false)
      setInterventionText('')
      setSelectedNode(null)
      setSelectedNodeData(null)
      setAgentConfigPopup(null)
      setPRResult(null)
      setWorkflowState({
        iteration: 0,
        phase: 'idle',
        codersDone: 0,
        testersDone: 0,
        totalTokens: 0,
        totalCost: 0,
        criticalIssues: 0,
        seriousIssues: 0,
        codeVersions: {},
        finishedCoders: new Set(),
        coderIterations: {},
        coderFinishReasons: {},
        activeCoderCount: 0,
        testerCompletions: {},
      })
      notify.success('Session reset')
      loadSession()
    } catch (err) {
      notify.error('Failed to reset session')
    } finally {
      setActionLoading(false)
    }
  }

  function handleRefinalize() {
    setShowRefinalizeConfirm(true)
  }

  async function handleRefinalizeConfirmed() {
    setShowRefinalizeConfirm(false)
    setActionLoading(true)
    try {
      await refinalizeSession(sessionId!)
      // Clear old final result so UI reflects re-finalization in progress
      setFinalResult(null)
      setExecutionResult(null)
      setShowExecution(false)
      setShowEnhancementReview(false)
      setEnhancementSuggestions([])
      setCuratedItems([])
      setPRResult(null)
      loadSession()
    } catch (err) {
      notify.error('Failed to start re-finalization')
    } finally {
      setActionLoading(false)
    }
  }

  // КАО#VR-11 RestartFromScratch — open the confirm dialog before nuking results.
  function handleRestart() {
    setShowRestartConfirm(true)
  }

  // КАО#VR-11 RestartFromScratch — actually call the backend after the user
  // confirms. Closes every results panel so the UI returns to a "fresh run"
  // state immediately rather than waiting for the WS event to arrive.
  async function handleRestartConfirmed() {
    setShowRestartConfirm(false)
    setActionLoading(true)
    try {
      await restartSession(sessionId!)
      // Wipe local result state so the page reflects iteration 0.
      setFinalResult(null)
      setExecutionResult(null)
      setShowExecution(false)
      setShowCode(false)
      setShowBrowserPreview(false)
      setBrowserPreviewHtml('')
      setShowEnhancementReview(false)
      setEnhancementSuggestions([])
      setCuratedItems([])
      setEnhancementLoading(false)
      setShowVisualReview(false)
      setShowIntervention(false)
      setInterventionText('')
      setSelectedNode(null)
      setSelectedNodeData(null)
      setAgentConfigPopup(null)
      setPRResult(null)
      setWorkflowState({
        iteration: 0,
        phase: 'idle',
        codersDone: 0,
        testersDone: 0,
        totalTokens: 0,
        totalCost: 0,
        criticalIssues: 0,
        seriousIssues: 0,
        codeVersions: {},
        finishedCoders: new Set(),
        coderIterations: {},
        coderFinishReasons: {},
        activeCoderCount: 0,
        testerCompletions: {},
      })
      notify.success('Session restarted from scratch')
      loadSession()
    } catch (err: any) {
      const msg = err?.message || err?.response?.data?.detail || 'Failed to restart session'
      notify.error(formatErrorForToast(String(msg)))
    } finally {
      setActionLoading(false)
    }
  }

  async function handleRunEnhancement() {
    if (!session) return
    // VR-36 — Ref-guard against double-click race. React batches setState so
    // two rapid clicks both see enhancementLoading=false on entry; the ref is
    // synchronous and blocks the second call instantly.
    if (enhancementInflightRef.current) return
    // VR-36 — Pre-check status. Backend CAS only accepts COMPLETED,
    // AWAITING_ENHANCEMENT, CREATED. If the local state has drifted into
    // ENHANCING / AWAITING_ENHANCEMENT_REVIEW (the previous run already
    // finished, but WS event was missed), refetch silently and skip the call
    // — we'd otherwise hit a 409 that produced a scary error toast.
    const validStartStates = ['completed', 'awaiting_enhancement', 'created']
    if (!validStartStates.includes(session.status)) {
      notify.info('Session state changed — refreshing…')
      try { await loadSession() } catch { /* surfaced by loadSession itself */ }
      return
    }
    enhancementInflightRef.current = true
    setEnhancementLoading(true)
    try {
      // Build enhance request from session's enhancer agent_configs
      const enhancerConfigs = session.agent_configs.filter(
        c => ['enhancer_design', 'enhancer_func', 'enhancer_security'].includes(c.agent_type)
      )
      const summarizerConfig = session.agent_configs.find(c => c.agent_type === 'enhancer_summary')

      // Use session's tester model as fallback when no enhancer-specific config
      const testerConfig = session.agent_configs.find(c => c.agent_type === 'tester')
      const fallbackProvider = testerConfig?.llm_provider || 'anthropic'
      const fallbackModel = testerConfig?.llm_model || 'claude-sonnet-4-20250514'

      const enhancers: EnhancerAgentConfig[] = ['enhancer_design', 'enhancer_func', 'enhancer_security'].map(t => {
        const cfg = enhancerConfigs.find(c => c.agent_type === t)
        return {
          type: t as EnhancerAgentConfig['type'],
          // Use the enabled field from the DB config (defaults to true if no config)
          enabled: cfg ? cfg.enabled !== false : true,
          provider: cfg?.llm_provider || fallbackProvider,
          model: cfg?.llm_model || fallbackModel,
          recommendations: cfg?.custom_prompt || undefined,
        }
      })

      // Use enhancer_summary agent config if available, else fall back to first enabled enhancer's model
      const firstEnabledEnhancer = enhancers.find(e => e.enabled)
      const summarizer: EnhancerSummarizerConfig = {
        provider: summarizerConfig?.llm_provider || firstEnabledEnhancer?.provider || 'anthropic',
        model: summarizerConfig?.llm_model || firstEnabledEnhancer?.model || 'claude-sonnet-4-20250514',
      }

      const request: EnhanceRequest = { enhancers, summarizer }
      await enhanceSession(sessionId!, request)
      notify.success('Enhancement started')
      // Don't call loadSession() — WS events (enhancer_started, enhancer_agent_started)
      // handle the state transition. Calling loadSession() would rebuild the graph
      // and reset enhancer nodes to idle, killing their breathing animations.
    } catch (err) {
      // VR-36 — distinguish 409 "state changed" from other failures. On 409 we
      // silently refresh; on real errors we keep the scary toast.
      const errMsg = err instanceof Error ? err.message : String(err)
      if (errMsg.includes('409') || errMsg.includes('already being enhanced') || errMsg.includes('changed state')) {
        notify.info('Session state changed — refreshing…')
        try { await loadSession() } catch { /* loadSession surfaces its own errors */ }
      } else {
        notify.error(`Failed to start enhancement: ${errMsg}`)
      }
    } finally {
      enhancementInflightRef.current = false
      setEnhancementLoading(false)
    }
  }

  // Helper: strip markdown code fences (```json ... ```)
  function stripCodeFence(raw: string): string {
    let c = raw.trim()
    if (c.startsWith('```')) {
      const nl = c.indexOf('\n')
      if (nl >= 0) c = c.slice(nl + 1)
    }
    if (c.endsWith('```')) c = c.slice(0, -3)
    return c.trim()
  }

  // VR-39 — per-item attachment helpers for user-authored enhancements.
  // The state lives inside each curatedItems[idx].attachments. These wrap
  // the same uploadFiles / fetchRepo APIs the Specification dialog uses,
  // so file size + URL validation stay consistent across the app.
  const [repoUrlByIdx, setRepoUrlByIdx] = useState<Record<number, string>>({})
  const [busyAttachIdx, setBusyAttachIdx] = useState<number | null>(null)

  const handleEnhUploadFiles = async (idx: number, files: FileList | null) => {
    if (!files || files.length === 0) return
    setBusyAttachIdx(idx)
    try {
      const arr = Array.from(files)
      const result = await uploadFiles(arr)
      if (result.attachments && result.attachments.length > 0) {
        const updated = [...curatedItems]
        const existing = (updated[idx].attachments ?? []) as AttachmentInfo[]
        updated[idx] = { ...updated[idx], attachments: [...existing, ...result.attachments] }
        setCuratedItems(updated)
        notify.success(`Attached ${result.attachments.length} file(s)`)
      }
      if (result.errors && result.errors.length > 0) {
        notify.error(result.errors.join('\n'))
      }
    } catch (err) {
      notify.error(`File upload failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyAttachIdx(null)
    }
  }

  const handleEnhFetchRepo = async (idx: number) => {
    const raw = (repoUrlByIdx[idx] || '').trim()
    if (!raw) {
      notify.error('Enter a git repo URL first')
      return
    }
    setBusyAttachIdx(idx)
    try {
      const result = await fetchRepo({ url: raw })
      if (result.attachment) {
        const updated = [...curatedItems]
        const existing = (updated[idx].attachments ?? []) as AttachmentInfo[]
        updated[idx] = { ...updated[idx], attachments: [...existing, result.attachment] }
        setCuratedItems(updated)
        setRepoUrlByIdx({ ...repoUrlByIdx, [idx]: '' })
        notify.success(`Attached repo ${result.attachment.repo_name || raw}`)
      }
      if (result.errors && result.errors.length > 0) {
        notify.error(result.errors.join('\n'))
      }
    } catch (err) {
      notify.error(`Repo fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusyAttachIdx(null)
    }
  }

  const handleEnhRemoveAttachment = (idx: number, attIdx: number) => {
    const updated = [...curatedItems]
    const existing = (updated[idx].attachments ?? []) as AttachmentInfo[]
    updated[idx] = { ...updated[idx], attachments: existing.filter((_, i) => i !== attIdx) }
    setCuratedItems(updated)
  }

  // Parse raw EnhancementSuggestion[] into CuratedSuggestion[]
  function parseSuggestionsToCurated(suggestions: EnhancementSuggestion[]): CuratedSuggestion[] {
    const items: CuratedSuggestion[] = []
    for (const s of suggestions) {
      const cat = s.agent_type.replace('enhancer_', '')
      try {
        const cleaned = stripCodeFence(s.content)
        const parsed = JSON.parse(cleaned)

        // Summarizer returns { consolidated_improvements: { security: [...], functionality: [...], design: [...] } }
        if (parsed.consolidated_improvements && typeof parsed.consolidated_improvements === 'object') {
          for (const [category, catItems] of Object.entries(parsed.consolidated_improvements)) {
            if (!Array.isArray(catItems)) continue
            for (const item of catItems as Record<string, unknown>[]) {
              items.push({
                title: (item.title as string) || 'Untitled',
                category: category === 'func' ? 'functionality' : category,
                priority: (item.priority as string) || 'medium',
                description: (item.description as string) || '',
                implementation: (item.implementation as string) || undefined,
              })
            }
          }
          continue  // skip to next suggestion — summarizer handled
        }

        // Enhancer agents return { suggestions: [...] }
        const suggList = Array.isArray(parsed) ? parsed : (parsed.suggestions || parsed.items || [parsed])
        const groupCat = cat === 'func' ? 'functionality' : cat
        for (const item of suggList) {
          items.push({
            title: item.title || item.name || 'Untitled',
            category: groupCat,
            subcategory: item.category || undefined,
            priority: item.priority || item.severity || 'medium',
            description: item.description || item.detail || '',
            implementation: item.implementation || item.how || undefined,
          })
        }
      } catch {
        // Couldn't parse JSON — skip empty content
        if (!s.content || !s.content.trim()) continue
        const groupCat = cat === 'func' ? 'functionality' : cat
        const catLabel = groupCat.charAt(0).toUpperCase() + groupCat.slice(1)
        items.push({
          title: `${catLabel} Suggestion`,
          category: groupCat,
          priority: 'medium',
          description: s.content,
        })
      }
    }
    return items
  }

  async function handleOpenReview() {
    if (!session) return
    setEnhancementLoading(true)
    try {
      const suggestions = await getEnhancementSuggestions(sessionId!)
      setEnhancementSuggestions(suggestions)

      const parsed = parseSuggestionsToCurated(suggestions)
      const items = parsed.map(item => ({ ...item, selected: true, editing: false }))

      setCuratedItems(items)
      setShowEnhancementReview(true)
      setShowCode(false)
      setShowIntervention(false)
      setShowBrowserPreview(false)
      setShowExecution(false)
      setSelectedNode(null)
      setSelectedNodeData(null)
      // Улучшатели#3 P2·M — record in panel history.
      pushPanel('enhancement')
    } catch (err) {
      notify.error('Failed to load enhancement suggestions')
    } finally {
      setEnhancementLoading(false)
    }
  }

  async function handleApplyEnhancements() {
    const selected = curatedItems.filter(i => i.selected)
    if (selected.length === 0) {
      notify.error('Select at least one suggestion')
      return
    }
    setEnhancementLoading(true)
    setShowEnhancementReview(false)
    try {
      const curated: CuratedSuggestion[] = selected.map(({ selected: _s, editing: _e, ...rest }) => rest)
      const result = await applyEnhancements(sessionId!, curated)
      notify.success(`Enhancement session created with ${result.suggestions_applied} improvements`)
      navigate(`/sessions/${result.new_session_id}`)
    } catch (err) {
      notify.error(`Failed to apply enhancements: ${err}`)
    } finally {
      setEnhancementLoading(false)
    }
  }

  // Apply ALL enhancements immediately without opening the review panel
  async function handleApplyAllEnhancements() {
    if (!session) return
    setEnhancementLoading(true)
    try {
      const suggestions = await getEnhancementSuggestions(sessionId!)
      if (!suggestions || suggestions.length === 0) {
        notify.error('No enhancement suggestions found')
        return
      }
      const curated = parseSuggestionsToCurated(suggestions)
      if (curated.length === 0) {
        notify.error('Could not parse any enhancement suggestions')
        return
      }
      const result = await applyEnhancements(sessionId!, curated)
      notify.success(`Enhancement session created with ${result.suggestions_applied} improvements`)
      navigate(`/sessions/${result.new_session_id}`)
    } catch (err) {
      notify.error(`Failed to apply enhancements: ${err}`)
    } finally {
      setEnhancementLoading(false)
    }
  }

  async function handleCompleteSession() {
    setActionLoading(true)
    try {
      await completeSession(sessionId!)
      notify.success('Session marked as completed')
      loadSession()
    } catch (err) {
      notify.error('Failed to complete session')
    } finally {
      setActionLoading(false)
    }
  }

  // Run Code feature - execute code and show results in Browser Preview
  async function handleRunCode() {
    if (!finalResult || !session) return

    // Browser-runnable languages (JS/TS/HTML) — try bundle for browser preview first
    if (isBrowserRunnable(session.language)) {
      handleRunInBrowser()
      return
    }

    // All other languages (Python, etc.) — execute via sandbox, show in Browser Preview
    setExecuting(true)
    setShowBrowserPreview(true)
    setShowExecution(false)
    setShowCode(false)
    setShowIntervention(false)
    setSelectedNode(null)
    setSelectedNodeData(null)
    // Улучшатели#3 P2·M — record in panel history when Run opens a new panel.
    pushPanel('browser')
    setBrowserPreviewHtml(buildOutputHtml('⏳ Executing in sandbox...', '', true))
    setBrowserPreviewKey(k => k + 1)
    setExecutionResult(null)

    try {
      const result = await runFinalCode(sessionId!, 30)
      setExecutionResult(result)
      const html = buildOutputHtml(result.stdout, result.stderr, false, result)
      setBrowserPreviewHtml(html)
      setBrowserPreviewKey(k => k + 1)
      if (result.success) {
        notify.success('Code executed successfully')
      } else if (result.timeout_exceeded) {
        notify.warning('Execution timed out', { title: 'Timeout' })
      } else {
        notify.error(result.error || 'Code execution failed')
      }
    } catch (err) {
      notify.error('Failed to execute code')
      const errResult = {
        success: false,
        exit_code: -1,
        stdout: '',
        stderr: String(err),
        execution_time_ms: 0,
        timeout_exceeded: false,
      }
      setExecutionResult(errResult)
      setBrowserPreviewHtml(buildOutputHtml('', String(err), false, errResult))
      setBrowserPreviewKey(k => k + 1)
    } finally {
      setExecuting(false)
    }
  }

  // Run code from a specific coder iteration
  async function handleRunCodeVersion(versionId: string, title: string) {
    if (!session) return

    // Close detail panel, open Browser Preview
    setSelectedNode(null)
    setSelectedNodeData(null)
    setExecuting(true)
    setShowBrowserPreview(true)
    setShowExecution(false)
    setShowCode(false)
    setShowIntervention(false)
    // Улучшатели#3 P2·M — record in panel history.
    pushPanel('browser')

    notify.warning(`Running intermediate code: ${title}. May contain errors.`, { title: '⚠ Intermediate Code' })
    setBrowserPreviewHtml(buildOutputHtml('⏳ Executing intermediate code...', '', true))
    setBrowserPreviewKey(k => k + 1)
    setExecutionResult(null)

    try {
      const result = await runCodeVersion(versionId, 30)
      setExecutionResult(result)

      // Show warning from backend if code had failed executions
      if (result.warning) {
        notify.warning(result.warning)
      }

      // If it returned HTML (browser language), render directly
      if ((result as any).html) {
        setBrowserPreviewHtml((result as any).html)
        setBrowserPreviewKey(k => k + 1)
      } else {
        const html = buildOutputHtml(result.stdout, result.stderr, false, result)
        setBrowserPreviewHtml(html)
        setBrowserPreviewKey(k => k + 1)
      }

      if (result.success) {
        notify.success(`${title} executed successfully`)
      } else if (result.timeout_exceeded) {
        notify.warning('Execution timed out', { title: 'Timeout' })
      } else {
        notify.error(result.error || 'Code execution failed')
      }
    } catch (err) {
      notify.error('Failed to execute code')
      const errResult = {
        success: false,
        exit_code: -1,
        stdout: '',
        stderr: String(err),
        execution_time_ms: 0,
        timeout_exceeded: false,
      }
      setExecutionResult(errResult)
      setBrowserPreviewHtml(buildOutputHtml('', String(err), false, errResult))
      setBrowserPreviewKey(k => k + 1)
    } finally {
      setExecuting(false)
    }
  }

  // Run in Browser - bundle JS/TS code and render in iframe
  async function handleRunInBrowser() {
    if (!finalResult || !session) return

    const code = finalResult.final_code
    const lang = session.language.toLowerCase()

    // Show loading state immediately
    setExecuting(true)
    setShowBrowserPreview(true)
    setShowExecution(false)
    setShowCode(false)
    setShowIntervention(false)
    setSelectedNode(null)
    setSelectedNodeData(null)
    // Улучшатели#3 P2·M — record in panel history.
    pushPanel('browser')

    // ── javascript_browser: code is a self-contained HTML page → render directly ──
    if (lang === 'javascript_browser' || lang === 'typescript_browser') {
      const trimmed = code.trim()

      // If code already starts with <!DOCTYPE or <html, use as-is
      if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) {
        setBrowserPreviewHtml(trimmed)
        setBrowserPreviewKey(k => k + 1)
        setExecuting(false)
        notify.success('Running in browser')
        return
      }

      // Try to extract HTML from code block (finаlizer may wrap in ```html ... ```)
      const htmlMatch = trimmed.match(/```html\s*\n([\s\S]*?)```/)
      if (htmlMatch) {
        const extracted = htmlMatch[1].trim()
        if (/^<!doctype\s+html|^<html[\s>]/i.test(extracted)) {
          setBrowserPreviewHtml(extracted)
          setBrowserPreviewKey(k => k + 1)
          setExecuting(false)
          notify.success('Running in browser')
          return
        }
      }

      // Fallback: wrap as JS in browser template
      const html = wrapCodeForBrowser(code, 'javascript')
      setBrowserPreviewHtml(html)
      setBrowserPreviewKey(k => k + 1)
      setExecuting(false)
      notify.success('Running in browser (wrapped)')
      return
    }

    // ── javascript / typescript: try bundle → sandbox fallback ──
    const nodeCode = isNodeJsCode(code)
    const browserDom = isBrowserDomCode(code)

    // Pure Node.js code (uses process, fs, setImmediate, etc. but no DOM) → go straight to sandbox
    if (nodeCode && !browserDom) {
      // Detect terminal animation code — warn user instead of wasting 30s on timeout
      if (isTerminalAnimationCode(code)) {
        const terminalHtml = buildTerminalAnimationHtml(code)
        setBrowserPreviewHtml(terminalHtml)
        setBrowserPreviewKey(k => k + 1)
        setExecuting(false)
        notify.info('This is a terminal animation — download and run with Node.js', { title: 'Terminal App' })
        return
      }

      setBrowserPreviewHtml(buildOutputHtml('⏳ Executing in sandbox (Node.js)...', '', true))
      setBrowserPreviewKey(k => k + 1)

      try {
        const result = await runFinalCode(sessionId!, 30)
        setExecutionResult(result)
        const html = buildOutputHtml(result.stdout, result.stderr, false, result)
        setBrowserPreviewHtml(html)
        setBrowserPreviewKey(k => k + 1)
        if (result.success) {
          notify.success('Code executed in Node.js sandbox')
        } else if (result.timeout_exceeded) {
          notify.warning('Execution timed out', { title: 'Timeout' })
        } else {
          notify.error(result.error || 'Code execution failed')
        }
      } catch (err) {
        const errResult = {
          success: false,
          exit_code: -1,
          stdout: '',
          stderr: String(err),
          execution_time_ms: 0,
          timeout_exceeded: false,
        }
        setExecutionResult(errResult)
        setBrowserPreviewHtml(buildOutputHtml('', String(err), false, errResult))
        setBrowserPreviewKey(k => k + 1)
        notify.error('Failed to execute code')
      } finally {
        setExecuting(false)
      }
      return
    }

    // Browser-compatible code — try bundling
    setBrowserPreviewHtml(buildOutputHtml('⏳ Bundling for browser...', '', true))
    setBrowserPreviewKey(k => k + 1)

    // Step 1: Try server-side bundling via esbuild
    if (lang === 'javascript' || lang === 'typescript' || lang === 'js' || lang === 'ts') {
      try {
        const bundleResult = await bundleFinalCode(sessionId!, 90)

        if (bundleResult.success && bundleResult.html) {
          setBrowserPreviewHtml(bundleResult.html)
          setBrowserPreviewKey(k => k + 1)
          setExecuting(false)

          const sizeKb = (bundleResult.bundled_size_bytes / 1024).toFixed(1)
          const warnings = bundleResult.warnings?.length
            ? ` (${bundleResult.warnings.length} warning${bundleResult.warnings.length > 1 ? 's' : ''})`
            : ''
          notify.success(`Running in browser • ${sizeKb}KB • ${bundleResult.build_time_ms}ms${warnings}`)
          return
        }

        // Bundle returned success=false — log the error but proceed to fallback
        console.warn('Bundle failed:', bundleResult.error)
      } catch (err) {
        // Bundle endpoint not available or errored — proceed to fallback
        console.warn('Bundle API error, trying fallback:', err)
      }
    }

    // Step 2: Try client-side wrapping (for simple browser code)
    if (!nodeCode || browserDom) {
      const html = wrapCodeForBrowser(code, session.language)
      setBrowserPreviewHtml(html)
      setBrowserPreviewKey(k => k + 1)
      setExecuting(false)
      notify.success('Running in browser (client-side)')
      return
    }

    // Step 3: Fallback — execute via sandbox headless
    setBrowserPreviewHtml(buildOutputHtml('⏳ Executing in sandbox (headless)...', '', true))
    setBrowserPreviewKey(k => k + 1)

    try {
      const result = await runFinalCode(sessionId!, 30)
      setExecutionResult(result)
      const html = buildOutputHtml(result.stdout, result.stderr, false, result)
      setBrowserPreviewHtml(html)
      setBrowserPreviewKey(k => k + 1)
      if (result.success) {
        notify.success('Code executed in sandbox')
      } else if (result.timeout_exceeded) {
        notify.warning('Execution timed out', { title: 'Timeout' })
      } else {
        notify.error(result.error || 'Code execution failed')
      }
    } catch (err) {
      const errResult = {
        success: false,
        exit_code: -1,
        stdout: '',
        stderr: String(err),
        execution_time_ms: 0,
        timeout_exceeded: false,
      }
      setExecutionResult(errResult)
      setBrowserPreviewHtml(buildOutputHtml('', String(err), false, errResult))
      setBrowserPreviewKey(k => k + 1)
      notify.error('Failed to execute code')
    } finally {
      setExecuting(false)
    }
  }

  // Open preview in a new browser tab via blob URL.
  // This loads the HTML as a proper page so CDN scripts work correctly.
  function handleOpenInNewTab() {
    if (!browserPreviewHtml) return
    // Strip CSP meta tags before opening
    const html = browserPreviewHtml.replace(
      /<meta\s+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,
      '<!-- CSP meta removed by CodeForge sandbox -->'
    )
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const newWin = window.open(url, '_blank')
    if (!newWin) {
      URL.revokeObjectURL(url)
      notify.error('Popup blocked — please allow popups for this site')
      return
    }
    // Revoke blob URL after the page has loaded to free memory
    scheduleTimeout(() => {
      URL.revokeObjectURL(url)
    }, 5000)
  }

  function getStatusColor(status: string): string {
    const colors: Record<string, string> = {
      created: 'bg-gray-500',
      running: 'bg-blue-500 animate-pulse',
      paused: 'bg-yellow-500',
      completed: 'bg-green-500',
      failed: 'bg-red-500',
      cancelled: 'bg-gray-500',
      awaiting_enhancement: 'bg-purple-500',
      enhancing: 'bg-purple-500 animate-pulse',
      awaiting_enhancement_review: 'bg-amber-500',
      // КАО#VR-Wave1 Frontend — Visual Review: warning-toned pill to signal
      // the workflow is paused on user input.
      awaiting_visual_review: 'bg-amber-500 animate-pulse',
    }
    return colors[status] || 'bg-gray-500'
  }

  function getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      awaiting_enhancement: 'Awaiting Enhancement',
      enhancing: 'Enhancing...',
      awaiting_enhancement_review: 'Enhancement Review',
      // КАО#VR-Wave1 Frontend — Visual Review label.
      awaiting_visual_review: '🎨 Awaiting Visual Review',
    }
    return labels[status] || status
  }

  // Улучшатели#3 wave 2 #8 — humanize the workflow phase indicator. The raw
  // values (`coding`, `testing`, `summarizing`, …) used to render lowercase via
  // CSS capitalize, which was both unfriendly and ambiguous (which iteration?).
  function humanizePhase(phase: string | undefined, iteration: number): string {
    if (!phase) return ''
    const iter = iteration > 0 ? iteration : 1
    switch (phase) {
      case 'coding':       return `Coding (iteration ${iter})`
      case 'testing':      return `Testing (iteration ${iter})`
      case 'summarizing':  return 'Summarizing audits'
      case 'finalizing':   return 'Finalizing winner'
      case 'enhancing':    return 'Enhancing'
      case 'completed':    return 'Completed'
      case 'idle':         return 'Idle'
      default:
        // Capitalise first letter as a safe fallback for unknown phases.
        return phase.charAt(0).toUpperCase() + phase.slice(1)
    }
  }

  // КАО#VR-13 NodeCountFix — only count ENABLED coder/tester rows so the UI
  // text ("• N coders • M testers") and totalCoders prop match what actually
  // runs. Legacy sessions with empty agent_configs keep their previous count.
  const _allConfigs = session?.agent_configs || []
  const _hasConfigs = _allConfigs.length > 0
  // КАО#VR-20 NodeOrder — keep this filter consistent with buildGraph(): sort
  // by agent_index so counts and any index-based UI stay in stable order even
  // when agent_configs DB rows come back shuffled.
  const coders = _allConfigs
    .filter(a => a.agent_type === 'coder' && (_hasConfigs ? a.enabled !== false : true))
    .sort((a, b) => a.agent_index - b.agent_index) // КАО#VR-20 NodeOrder
  const testers = _allConfigs
    .filter(a => a.agent_type === 'tester' && (_hasConfigs ? a.enabled !== false : true))
    .sort((a, b) => a.agent_index - b.agent_index) // КАО#VR-20 NodeOrder

  // Улучшатели#3 wave 2 #9 — MetricsPanel issues block was dead because
  // criticalIssues/seriousIssues state was never updated by any WS event.
  // We don't have severity breakdown on agent events; the next-best signal is
  // `issuesFound` set on tester nodes via updateNodeStatus in agent_completed.
  // We surface the aggregate count as `seriousIssues` so the panel renders a
  // live number during testing phases (instead of always being hidden).
  // TODO(backend): when tester events emit critical/serious breakdown, swap
  // these to the dedicated counters.
  const aggregatedTesterIssues = useMemo(() => {
    let total = 0
    for (const n of nodes as any[]) {
      const a = (n.data?.agentType as string | undefined) || ''
      if (a === 'tester' || a.startsWith('enhancer')) {
        const v = n.data?.issuesFound
        if (typeof v === 'number' && v > 0) total += v
      }
    }
    return total
  }, [nodes])
  const displayCriticalIssues = workflowState.criticalIssues || 0
  const displaySeriousIssues = (workflowState.seriousIssues || 0) + aggregatedTesterIssues

  // Улучшатели#3 P2·M — Side-panel breadcrumb.
  // Renders the panel-history chip row at the top of each side panel. Skipped
  // when there's only one entry (current panel) since there's nothing to
  // navigate back to.
  const renderPanelBreadcrumb = (current: PanelKey) => {
    if (panelHistory.length <= 1) return null
    return (
      <div className="px-3 py-1.5 border-b border-gray-700/60 bg-gray-900/40 flex items-center gap-1 text-[11px] text-gray-400 overflow-x-auto">
        {panelHistory.map((key, idx) => {
          const isCurrent = key === current
          return (
            <span key={`${key}-${idx}`} className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  if (!isCurrent) switchToPanel(key)
                }}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  isCurrent
                    ? 'bg-indigo-600/30 text-indigo-200 cursor-default'
                    : 'hover:bg-gray-700/60 text-gray-300 hover:text-white cursor-pointer'
                }`}
                title={isCurrent ? `Currently viewing ${PANEL_LABELS[key]}` : `Switch back to ${PANEL_LABELS[key]}`}
                disabled={isCurrent}
              >
                {PANEL_LABELS[key]}
              </button>
              {idx < panelHistory.length - 1 && (
                <ChevronRight className="w-3 h-3 text-gray-600 flex-shrink-0" aria-hidden="true" />
              )}
            </span>
          )
        })}
      </div>
    )
  }

  if (!sessionId) return <Navigate to="/sessions" />

  if (loading) {
    return (
      <div className="flex flex-col h-full bg-cf-bg p-4 gap-4 animate-pulse">
        {/* Top bar skeleton */}
        <div className="h-16 bg-cf-panel rounded-lg" />
        {/* Main canvas + sidebar */}
        <div className="flex-1 flex gap-4">
          <div className="flex-1 bg-cf-panel/50 rounded-lg" />
          <div className="w-80 bg-cf-panel rounded-lg space-y-3 p-4">
            <div className="h-6 bg-cf-border rounded w-3/4" />
            <div className="h-4 bg-cf-border rounded w-1/2" />
            <div className="h-4 bg-cf-border rounded w-2/3" />
            <div className="h-32 bg-cf-border rounded" />
          </div>
        </div>
      </div>
    )
  }

  if (!session) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center">
          <p className="text-gray-400 mb-4">Session not found</p>
          <button
            onClick={() => navigate('/sessions')}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg"
          >
            Back to Sessions
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-gray-900 h-full overflow-hidden">
      {/* Header */}
      <div className="bg-gray-800/80 backdrop-blur-sm border-b border-gray-700 px-6 py-4 z-10 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4 min-w-0 flex-shrink">
            <button
              onClick={() => navigate('/sessions')}
              className="p-2 hover:bg-gray-700 rounded-lg transition-colors flex-shrink-0"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              {/* Editable session title */}
              <div className="flex items-center gap-2 flex-nowrap min-w-0">
                {editingTitle ? (
                  <form
                    className="flex items-center gap-2"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      const trimmed = titleDraft.trim()
                      if (!trimmed || trimmed === session.name) {
                        setEditingTitle(false)
                        return
                      }
                      try {
                        const updated = await updateSession(sessionId!, { name: trimmed })
                        setSession(updated)
                        notify.success('Session renamed')
                      } catch {
                        notify.error('Failed to rename session')
                      }
                      setEditingTitle(false)
                    }}
                  >
                    <input
                      ref={titleInputRef}
                      type="text"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onBlur={() => {
                        // Small delay to allow form submit via button click
                        scheduleTimeout(() => setEditingTitle(false), 150)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditingTitle(false)
                      }}
                      className="text-xl font-semibold text-white bg-gray-700 border border-gray-500 rounded-lg px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-80"
                      autoFocus
                    />
                    <button
                      type="submit"
                      className="p-1 text-green-400 hover:text-green-300 transition-colors"
                      title="Save"
                    >
                      <Check className="w-5 h-5" />
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    className="group flex items-center gap-2 hover:bg-gray-700/50 rounded-lg px-2 py-0.5 -ml-2 transition-colors"
                    onClick={() => {
                      setTitleDraft(session.name)
                      setEditingTitle(true)
                    }}
                    title="Click to rename session"
                  >
                    <h1 className="text-xl font-semibold text-white truncate">{session.name}</h1>
                    <Pencil className="w-4 h-4 text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </button>
                )}
              </div>
              <div className="flex items-center gap-3 mt-0.5">
                <span className="text-sm text-gray-400">
                  Iteration {Math.max(workflowState.iteration ?? 0, session.current_iteration ?? 0) || 1} / {session.max_iterations}
                </span>
                <span className="text-sm text-gray-500">
                  • {coders.length} coders • {testers.length} testers
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap justify-end max-w-[72%]">
            {/* ============================================================
                VR-35 toolbar reorganization — buttons grouped left → right:
                  Group A (primary code): Run Code · View Result
                  Group B (workflow lifecycle): Start · Pause · Resume · Cancel ·
                    Review-candidates · Skip-review · Enhance · View/Apply
                    Enhancements · Skip & Complete
                  Group C (recovery): Retry-from-failed · Re-finalize · Restart ·
                    Reset
                  Group D (communication): Intervene
                  Group E (utility, icons rightmost): Save Template · Lock ·
                    Help · Settings · ⋯ overflow
                Visual separators (vertical bars) divide each group.
                ============================================================ */}

            {/* === Group A: primary code result actions === */}
            {finalResult && (
              <>
                <button
                  onClick={handleRunCode}
                  disabled={executing}
                  className="flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors disabled:opacity-50 bg-emerald-600 hover:bg-emerald-700"
                  data-tour="run-code-btn"
                  title="Execute the finalized code in the sandbox"
                >
                  {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  Run Code
                </button>
                <button
                  onClick={() => {
                    const next = !showCode
                    setShowCode(next)
                    if (next) pushPanel('code')
                  }}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                    showCode
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-700 hover:bg-gray-600 text-white'
                  }`}
                  title="Show / hide the Final Result side panel"
                >
                  <Code className="w-4 h-4" />
                  View Result
                </button>
                <div className="w-px h-7 bg-gray-700 mx-1" aria-hidden="true" />
              </>
            )}

            {/* === Group B: workflow lifecycle (state-driven primary actions) === */}
            {session.status === 'created' && (
              <button
                onClick={handleStart}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
                data-tour="start-btn"
              >
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Start
              </button>
            )}

            {(session.status === 'running' || session.status === 'enhancing') && (
              <button
                onClick={handlePause}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              >
                <Pause className="w-4 h-4" />
                Pause
              </button>
            )}

            {session.status === 'paused' && (
              <button
                onClick={handleResume}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              >
                <Play className="w-4 h-4" />
                Resume
              </button>
            )}

            {(session.status === 'running' || session.status === 'paused' || session.status === 'enhancing') && (
              <button
                onClick={handleCancel}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              >
                <Square className="w-4 h-4" />
                Cancel
              </button>
            )}

            {session.status === 'awaiting_visual_review' && (
              <>
                <button
                  onClick={() => {
                    switchToPanel('visualReview')
                    pushPanel('visualReview')
                  }}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-colors"
                  title="Open the visual review panel"
                >
                  <span aria-hidden="true">🎨</span>
                  Review candidates
                </button>
                <button
                  onClick={async () => {
                    try {
                      await skipVisualReview(sessionId!)
                      notify.success('Visual review skipped — AI will decide')
                      setShowVisualReview(false)
                      loadSession()
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : 'Failed to skip review'
                      notify.error(msg)
                    }
                  }}
                  disabled={actionLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 text-white rounded-lg transition-colors"
                  title="Let the AI decide and continue"
                >
                  <SkipForward className="w-4 h-4" />
                  Skip review
                </button>
              </>
            )}

            {finalResult && !['running', 'enhancing', 'created', 'paused', 'awaiting_enhancement_review'].includes(session.status) && (
              <button
                onClick={handleRunEnhancement}
                disabled={enhancementLoading}
                className="flex items-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
                data-tour="enhance-btn"
              >
                {enhancementLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                Enhance
              </button>
            )}

            {session.status === 'awaiting_enhancement_review' && (
              <>
                <button
                  onClick={handleOpenReview}
                  disabled={enhancementLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
                >
                  {enhancementLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ListChecks className="w-4 h-4" />}
                  View Enhancements
                </button>
                <button
                  onClick={handleApplyAllEnhancements}
                  disabled={enhancementLoading}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
                >
                  {enhancementLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  Apply Enhancements
                </button>
              </>
            )}

            {(session.status === 'awaiting_enhancement' || session.status === 'awaiting_enhancement_review') && (
              <button
                onClick={handleCompleteSession}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 text-white rounded-lg transition-colors"
              >
                <CheckCircle className="w-4 h-4" />
                Skip & Complete
              </button>
            )}

            {/* Separator between lifecycle and recovery — only show if any
                recovery-group button will be visible to avoid orphaned bars. */}
            {(session.status === 'failed'
              || session.status === 'completed'
              || session.status === 'cancelled'
              || session.status === 'awaiting_enhancement'
              || session.status === 'awaiting_enhancement_review'
              || session.status === 'awaiting_visual_review'
              || session.status === 'paused') && (
              <div className="w-px h-7 bg-gray-700 mx-1 hidden md:block" aria-hidden="true" />
            )}

            {/* === Group C: recovery / destructive actions (hidden < md, in ⋯ menu) === */}
            {session.status === 'failed' && (
              <button
                onClick={handleRetryFromFailed}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
                title="Retry from the failed step (resets failed agents and resumes)"
              >
                <RotateCcw className="w-4 h-4" />
                Retry from failed step
              </button>
            )}

            {(session.status === 'completed' || session.status === 'failed' || session.status === 'awaiting_enhancement') && (
              <button
                onClick={handleRefinalize}
                disabled={actionLoading}
                className="hidden md:flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
                title="Re-run finalization with existing code versions"
              >
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Re-finalize
              </button>
            )}

            {(session.status === 'paused'
              || session.status === 'awaiting_enhancement'
              || session.status === 'awaiting_enhancement_review'
              || session.status === 'awaiting_visual_review'
              || session.status === 'failed') && (
              <button
                onClick={handleRestart}
                disabled={actionLoading}
                className="hidden md:flex items-center gap-2 px-4 py-2 bg-red-700 hover:bg-red-800 disabled:bg-gray-600 text-white rounded-lg transition-colors"
                title="Discard all current results and re-run the workflow from iteration 0"
              >
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                <span className="text-sm">Restart from scratch</span>
              </button>
            )}

            {(session.status === 'failed' || session.status === 'completed' || session.status === 'cancelled') && (
              <button
                onClick={handleReset}
                disabled={actionLoading}
                className="hidden md:flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              >
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                Reset
              </button>
            )}

            {/* Separator before communication group */}
            <div className="w-px h-7 bg-gray-700 mx-1" aria-hidden="true" />

            {/* === Group D: communication === */}
            <button
              onClick={() => {
                const next = !showIntervention
                setShowIntervention(next)
                if (next) pushPanel('intervention')
              }}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                showIntervention
                  ? 'bg-indigo-600 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-white'
              }`}
              title="Send a free-text message into the running workflow"
            >
              <MessageSquare className="w-4 h-4" />
              Intervene
            </button>

            {/* Separator before utility cluster */}
            <div className="w-px h-7 bg-gray-700 mx-1" aria-hidden="true" />

            {/* === Group E: utility (icons rightmost) === */}
            <button
              onClick={handleOpenSaveTemplate}
              disabled={savingTemplate}
              className="hidden md:flex items-center gap-2 px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-600 text-gray-200 hover:text-white rounded-lg transition-colors"
              title="Save this session's configuration as a reusable template"
            >
              <BookmarkPlus className="w-4 h-4" />
              <span className="text-sm">Save as Template</span>
            </button>

            <button
              onClick={() => {
                const next = !lockViewport
                setLockViewport(next)
                notify.info(next ? 'Viewport locked — auto-pan disabled' : 'Viewport unlocked — auto-pan enabled')
              }}
              className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
                lockViewport
                  ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                  : 'bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white'
              }`}
              title={lockViewport ? 'Viewport locked (auto-pan disabled) — click to unlock' : 'Lock viewport (disable auto-pan on phase changes)'}
              aria-pressed={lockViewport}
            >
              {lockViewport ? <Lock className="w-4 h-4" /> : <Unlock className="w-4 h-4" />}
            </button>

            <button
              onClick={() => setShortcutsHelpOpen(true)}
              className="flex items-center justify-center w-9 h-9 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
              title="Keyboard shortcuts (press ?)"
            >
              <HelpCircle className="w-4 h-4" />
            </button>

            <button
              onClick={() => setShowSettings(true)}
              className="hidden md:flex items-center justify-center w-9 h-9 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
              title="Session Settings"
              data-tour="settings-btn"
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* Overflow ⋯ menu (md:hidden) — surfaces md-hidden secondary
                actions (Settings, Save Template, Reset, Re-finalize, Restart). */}
            <div ref={headerOverflowRef} className="md:hidden relative">
              <button
                type="button"
                onClick={() => setHeaderOverflowOpen(v => !v)}
                className="flex items-center justify-center w-9 h-9 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
                aria-haspopup="menu"
                aria-expanded={headerOverflowOpen}
                title="More actions"
              >
                <MoreHorizontal className="w-4 h-4" />
              </button>
              {headerOverflowOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-1 w-56 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-30 py-1"
                >
                  <button
                    role="menuitem"
                    onClick={() => { setHeaderOverflowOpen(false); setShowSettings(true) }}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors"
                  >
                    <Settings className="w-4 h-4" />
                    Session Settings
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setHeaderOverflowOpen(false); handleOpenSaveTemplate() }}
                    disabled={savingTemplate}
                    className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 transition-colors disabled:opacity-50"
                  >
                    <BookmarkPlus className="w-4 h-4" />
                    Save as Template
                  </button>
                  {(session.status === 'failed' || session.status === 'completed' || session.status === 'cancelled') && (
                    <button
                      role="menuitem"
                      onClick={() => { setHeaderOverflowOpen(false); handleReset() }}
                      disabled={actionLoading}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-orange-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Reset
                    </button>
                  )}
                  {(session.status === 'completed' || session.status === 'failed' || session.status === 'awaiting_enhancement') && (
                    <button
                      role="menuitem"
                      onClick={() => { setHeaderOverflowOpen(false); handleRefinalize() }}
                      disabled={actionLoading}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-indigo-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
                    >
                      <RefreshCw className="w-4 h-4" />
                      Re-finalize
                    </button>
                  )}
                  {(session.status === 'paused'
                    || session.status === 'awaiting_enhancement'
                    || session.status === 'awaiting_enhancement_review'
                    || session.status === 'awaiting_visual_review'
                    || session.status === 'failed') && (
                    <button
                      role="menuitem"
                      onClick={() => { setHeaderOverflowOpen(false); handleRestart() }}
                      disabled={actionLoading}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-300 hover:bg-gray-700 transition-colors disabled:opacity-50"
                    >
                      <RotateCcw className="w-4 h-4" />
                      Restart from scratch
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {session?.status === 'running' && workflowState.phase && (
        <div className="flex items-center gap-3 px-4 py-1.5 bg-cf-panel/50 border-b border-cf-border flex-shrink-0">
          <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all duration-500"
              style={{ width: `${Math.min(100, ((Math.max(workflowState.iteration ?? 0, session.current_iteration ?? 0) || 1) / (session.max_iterations || 5)) * 100)}%` }}
            />
          </div>
          <span className="text-xs text-cf-text-muted whitespace-nowrap">
            Iter {Math.max(workflowState.iteration ?? 0, session.current_iteration ?? 0) || 1}/{session.max_iterations || 5} &bull; {workflowState.phase}
          </span>
        </div>
      )}

      {/* VR-46 — Generation-finished status banner. Symmetric to the running
          Progress bar above: a clear, positive signal for the post-finalization
          states (awaiting_enhancement / _review / completed); renders null for
          every other state. CTAs reuse the same handlers as the header buttons. */}
      {session && (
        <CompletionBanner
          status={session.status}
          busy={enhancementLoading || actionLoading}
          onViewResult={() => {
            setShowCode(true)
            pushPanel('code')
          }}
          onReview={handleOpenReview}
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* React Flow Graph */}
        <div
          ref={reactFlowContainerRef}
          className="flex-1 relative h-full w-full overflow-hidden min-w-0"
          /* VR-38 — `overflow-hidden` clips GroupFramesLayer's dashed frames
             and their drag-handle strips so they cannot bleed into the
             sibling side-panel (Visual Review / DetailPanel / etc.) and
             intercept clicks on Live preview buttons. `min-w-0` lets the
             flex-1 shrink correctly when a side panel is open instead of
             forcing horizontal overflow on the parent row. */
          data-tour="agent-graph" /* tour-anchor: graph canvas (Tour 2, step 5) */
        >
          {/* Улучшатели#3 P0·M — WS reconnect UI: dimmed overlay while reconnecting.
              Pointer-events disabled so users can still pan/zoom the (stale) graph. */}
          {wsState.status === 'reconnecting' && (
            <div
              className="absolute inset-0 bg-gray-900/30 pointer-events-none z-10 transition-opacity duration-200"
              aria-hidden="true"
            />
          )}
          {/* Улучшатели#3 P0·M — WS reconnect UI: status pill (top-right).
              z-20 sits above the graph but below modals (which use z-50+). */}
          <WSStatusPill state={wsState} recentlyRecovered={wsRecentlyRecovered} />
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeClick}
            onPaneClick={() => setAgentConfigPopup(null)}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            connectionMode={ConnectionMode.Loose}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.3}
            maxZoom={1.5}
            className="bg-gray-900"
          >
            <Background color="#374151" gap={24} size={1} />
            <Controls 
              className="bg-gray-800 border-gray-700 rounded-lg"
              showInteractive={false}
            />
            <MiniMap
              className="bg-gray-800 rounded-lg"
              nodeColor={(node: any) => {
                const status = node.data?.status || 'idle'
                // Улучшатели#3 P3·S — Mini-map status palette completed.
                // Covers every value of the AgentNodeData['status'] enum so
                // active/error states aren't silently mapped to grey.
                const colors: Record<string, string> = {
                  idle: '#4B5563',       // grey — waiting to start
                  waiting: '#F59E0B',    // amber — queued
                  working: '#3B82F6',    // blue — active work
                  executing: '#3B82F6',  // blue — active sandbox run
                  fixing: '#F59E0B',     // amber — rework
                  done: '#10B981',       // emerald — complete
                  error: '#EF4444',      // red — failed
                  timeout: '#DC2626',    // red variant — timed out
                }
                return colors[status] || '#4B5563'
              }}
              maskColor="rgba(0, 0, 0, 0.8)"
            />

            {/* Metrics Panel — КАО#W4-FIX-02 v2 (Option A — reposition).
                Option B (pointer-events) didn't fully work: the inner card
                still extends ~32px down into the Spec node's hit area, and
                because the card is pointer-events:auto, those pixels block
                spec-node clicks. Move the panel to top-right where the Spec
                node never sits. Keep pointer-events-none on the wrapper as
                a safety net for any other top-corner overlap. */}
            <Panel position="top-right" className="pointer-events-none">
              <MetricsPanel
                iteration={Math.max(workflowState.iteration ?? 0, session.current_iteration ?? 0) || 1}
                maxIterations={session.max_iterations}
                totalTokens={workflowState.totalTokens}
                totalCost={workflowState.totalCost}
                status={session.status}
                /* Улучшатели#3 wave 2 #9 — aggregate tester issuesFound so the
                   panel block actually renders during testing phases. */
                criticalIssues={displayCriticalIssues}
                seriousIssues={displaySeriousIssues}
                codersDone={workflowState.codersDone}
                totalCoders={coders.length}
                testersDone={workflowState.testersDone}
                totalTesters={testers.length}
                checkpoints={checkpoints.map(c => ({
                  id: c.id,
                  iteration: c.iteration,
                  phase: c.phase,
                  created_at: c.created_at,
                  total_tokens: c.total_tokens,
                }))}
              />
            </Panel>

            {/* Legend Panel */}
            <Panel position="bottom-left">
              <LegendPanel compact />
            </Panel>

            {/* Phase indicator — Улучшатели#3 wave 2 #8: humanizePhase renders
                "Coding (iteration 2)" / "Summarizing audits" instead of raw
                lowercase enum + CSS capitalize. */}
            {((session.status === 'running' && workflowState.phase) || session.status === 'enhancing') && (
              <Panel position="top-center">
                <div className={`${session.status === 'enhancing' ? 'bg-purple-500/20 border-purple-500/50' : 'bg-blue-500/20 border-blue-500/50'} border rounded-full px-4 py-2 flex items-center gap-2`}>
                  <div className={`w-2 h-2 rounded-full ${session.status === 'enhancing' ? 'bg-purple-500' : 'bg-blue-500'} animate-pulse`} />
                  <span className={`text-sm font-medium ${session.status === 'enhancing' ? 'text-purple-400' : 'text-blue-400'}`}>
                    {session.status === 'enhancing'
                      ? 'Enhancement phase'
                      : `${humanizePhase(workflowState.phase, Math.max(workflowState.iteration ?? 0, session.current_iteration ?? 0))} phase`}
                  </span>
                </div>
              </Panel>
            )}

            {/* Status hints removed — info is already shown in the header badge */}
            {/* Bridge to report viewport changes to the parent */}
            <ViewportBridge onChange={setFlowViewport} />
            {/* Bridge to expose ReactFlow instance for auto-scroll */}
            <ReactFlowBridge instanceRef={reactFlowInstanceRef} />
          </ReactFlow>

          {/* Group frames overlay — rendered OUTSIDE ReactFlow so buttons aren't blocked by grab handler */}
          <GroupFramesLayer
            viewport={flowViewport}
            nodes={nodes}
            onAddCoder={() => handleAddAgent('coder')}
            onAddTester={() => handleAddAgent('tester')}
            onRemoveCoder={() => handleRemoveAgent('coder')}
            onRemoveTester={() => handleRemoveAgent('tester')}
            canModify={session.status === 'created'}
            onGroupDragStart={onGroupDragStart}
          />

          {/* Floating agent config popup */}
          {agentConfigPopup && (() => {
            const matchingConfig = session.agent_configs.find(c => {
              const typeMatch = c.agent_type === agentConfigPopup.agentType
              const indexMatch = agentConfigPopup.agentIndex === undefined || c.agent_index === agentConfigPopup.agentIndex
              return typeMatch && indexMatch
            })
            return (
              <AgentConfigPopup
                agentType={agentConfigPopup.agentType}
                x={agentConfigPopup.x}
                y={agentConfigPopup.y}
                existingConfig={matchingConfig
                  ? { llm_provider: matchingConfig.llm_provider, llm_model: matchingConfig.llm_model, thinking_effort: matchingConfig.thinking_effort, custom_prompt: matchingConfig.custom_prompt, enabled: matchingConfig.enabled, temperature: (matchingConfig as any).temperature, max_tokens: matchingConfig.max_tokens }
                  : { llm_provider: '', llm_model: '' }
                }
                onClose={() => setAgentConfigPopup(null)}
                onSave={async (config) => {
                  if (!session) return
                  const effortValue = config.thinkingEffort || null
                  const isEnhancer = agentConfigPopup.agentType.startsWith('enhancer_') && agentConfigPopup.agentType !== 'enhancer_summary'

                  if (matchingConfig) {
                    // Update existing agent config (includes enabled flag for enhancers)
                    try {
                      await updateAgentConfig(session.id, matchingConfig.id, {
                        llm_provider: config.provider,
                        llm_model: config.model,
                        thinking_effort: effortValue,
                        custom_prompt: config.instruction || null,
                        temperature: config.temperature,
                        max_tokens: config.maxTokens,
                        ...(isEnhancer ? { enabled: config.enabled } : {}),
                      })
                      notify.success('Agent settings saved')
                    } catch (e) {
                      console.error('Failed to update agent config:', e)
                      notify.error('Failed to save agent settings')
                      return
                    }
                    const updatedConfigs = session.agent_configs.map(c =>
                      c.id === matchingConfig.id
                        ? { ...c, llm_provider: config.provider, llm_model: config.model, thinking_effort: effortValue, custom_prompt: config.instruction || undefined, temperature: config.temperature, max_tokens: config.maxTokens, enabled: isEnhancer ? config.enabled : c.enabled }
                        : c
                    )
                    setSession({ ...session, agent_configs: updatedConfigs })
                    // Immediately update enhancer node disabled state on the graph
                    if (isEnhancer) {
                      setNodes(nds => nds.map(n =>
                        n.id === agentConfigPopup.nodeId
                          ? { ...n, data: { ...n.data, disabled: !config.enabled } }
                          : n
                      ))
                    }
                  } else {
                    // Create new agent config (e.g. for enhancer nodes that don't have one yet)
                    try {
                      const newConfig = await addAgentConfig(session.id, {
                        agent_type: agentConfigPopup.agentType,
                        agent_index: agentConfigPopup.agentIndex ?? 0,
                        llm_provider: config.provider,
                        llm_model: config.model,
                        thinking_effort: effortValue,
                        max_tokens: config.maxTokens,
                      })
                      // Save custom_prompt + temperature + enabled via update
                      await updateAgentConfig(session.id, newConfig.id, {
                        custom_prompt: config.instruction || null,
                        temperature: config.temperature,
                        ...(isEnhancer ? { enabled: config.enabled } : {}),
                      })
                      newConfig.custom_prompt = config.instruction || null
                      ;(newConfig as any).temperature = config.temperature
                      newConfig.max_tokens = config.maxTokens
                      if (isEnhancer) newConfig.enabled = config.enabled
                      notify.success('Agent settings saved')
                      setSession({ ...session, agent_configs: [...session.agent_configs, newConfig] })
                      // Immediately update enhancer node disabled state on the graph
                      if (isEnhancer) {
                        setNodes(nds => nds.map(n =>
                          n.id === agentConfigPopup.nodeId
                            ? { ...n, data: { ...n.data, disabled: !config.enabled } }
                            : n
                        ))
                      }
                    } catch (e) {
                      console.error('Failed to create agent config:', e)
                      notify.error('Failed to save agent settings')
                    }
                  }
                }}
              />
            )
          })()}

          {/* Улучшатели#3 P2·S — Click hint visibility flip.
              The hint is most useful for new users while agents are actually
              running/enhancing (so they know they can drill in). Hide it on
              completion (no agent will ever start now) and on idle states
              where no agent is currently active. */}
          {!selectedNode &&
            (session.status === 'running' || session.status === 'enhancing') && (
              <div className="absolute bottom-20 left-1/2 transform -translate-x-1/2 pointer-events-none">
                <div className="bg-gray-800/80 backdrop-blur-sm border border-gray-700 rounded-lg px-4 py-2 flex items-center gap-2">
                  <Eye className="w-4 h-4 text-gray-400" />
                  <span className="text-sm text-gray-400">Click on an agent to view details</span>
                </div>
              </div>
            )}
        </div>

        {/* Side panels */}
        {/* Улучшатели#3 wave 2 #6 — Intervention now shows a scrollable history
            above the textarea with each entry's delivery status. We optimistically
            flip to "Delivered" once the POST resolves. TODO(backend): emit an
            `intervention_acknowledged` WS event so we can flip to "Consumed by
            agent_X at iter N". */}
        {showIntervention && (
          <div className="w-96 bg-gray-800 border-l border-gray-700 flex flex-col">
            {renderPanelBreadcrumb('intervention')}
            <div className="p-4 border-b border-gray-700 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">Intervention</h3>
              <button
                onClick={() => setShowIntervention(false)}
                className="p-1 hover:bg-gray-700 rounded"
              >
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="flex-1 flex flex-col min-h-0">
              {/* History list */}
              <div className="px-4 pt-4 pb-2 flex items-center gap-2 text-xs uppercase tracking-wider text-gray-400">
                <History className="w-3.5 h-3.5" />
                History ({interventionHistory.length})
              </div>
              <div className="px-4 pb-3 overflow-y-auto max-h-[40vh] min-h-[60px]">
                {interventionHistory.length === 0 ? (
                  <p className="text-xs text-gray-500 italic">No interventions sent yet.</p>
                ) : (
                  <ul className="space-y-2">
                    {interventionHistory.map(entry => {
                      const statusLabel =
                        entry.status === 'pending'   ? 'Pending'
                        : entry.status === 'delivered' ? 'Delivered'
                        : entry.status === 'consumed'  ? (entry.consumedBy ? `Consumed by ${entry.consumedBy}` : 'Consumed')
                        : 'Failed'
                      const statusClass =
                        entry.status === 'pending'   ? 'bg-amber-500/15 text-amber-300 border-amber-500/40'
                        : entry.status === 'delivered' ? 'bg-blue-500/15 text-blue-300 border-blue-500/40'
                        : entry.status === 'consumed'  ? 'bg-green-500/15 text-green-300 border-green-500/40'
                        : 'bg-red-500/15 text-red-300 border-red-500/40'
                      const when = (() => {
                        try { return new Date(entry.sentAt).toLocaleTimeString() } catch { return '' }
                      })()
                      return (
                        <li key={entry.id} className="bg-gray-900/60 rounded-lg border border-gray-700/60 p-2">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${statusClass}`}>
                              {statusLabel}
                            </span>
                            <span className="text-[10px] text-gray-500 font-mono">{when}</span>
                          </div>
                          <p className="text-xs text-gray-200 whitespace-pre-wrap break-words">{entry.content}</p>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
              <div className="px-4 pb-4 pt-1 border-t border-gray-700/50">
                <p className="text-xs text-gray-400 mb-2">
                  Add comments or instructions for the agents. These will be included in the next iteration.
                </p>
                <textarea
                  value={interventionText}
                  onChange={(e) => setInterventionText(e.target.value)}
                  placeholder="Enter your intervention message..."
                  className="w-full h-28 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none text-sm"
                />
                <button
                  className="mt-3 w-full flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50"
                  disabled={!interventionText.trim()}
                  onClick={async () => {
                    const content = interventionText.trim()
                    if (!content) return
                    // Local-only id — backend doesn't return one. crypto.randomUUID
                    // is available in all modern browsers/HTTPS contexts.
                    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
                      ? crypto.randomUUID()
                      : `iv-${Date.now()}-${Math.random().toString(36).slice(2)}`
                    const entry: InterventionHistoryEntry = {
                      id,
                      content,
                      sentAt: Date.now(),
                      status: 'pending',
                    }
                    setInterventionHistory(prev => [entry, ...prev])
                    setInterventionText('')
                    try {
                      await createIntervention(sessionId!, {
                        intervention_type: 'comment',
                        content,
                      })
                      setInterventionHistory(prev =>
                        prev.map(e => (e.id === id ? { ...e, status: 'delivered' as InterventionStatus } : e)),
                      )
                      notify.success('Intervention sent')
                    } catch (err) {
                      setInterventionHistory(prev =>
                        prev.map(e => (e.id === id ? { ...e, status: 'failed' as InterventionStatus } : e)),
                      )
                      notify.error('Failed to save intervention')
                    }
                  }}
                >
                  <Send className="w-4 h-4" />
                  Send Intervention
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Enhancement Review Panel */}
        {showEnhancementReview && (
          <div className="w-[500px] bg-gray-800 border-l border-gray-700 flex flex-col">
            {renderPanelBreadcrumb('enhancement')}
            <div className="p-4 border-b border-gray-700 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <ListChecks className="w-5 h-5 text-amber-500" />
                  View Enhancements
                </h3>
                <p className="text-sm text-gray-400 mt-1">
                  {curatedItems.filter(i => i.selected).length} / {curatedItems.length} selected
                </p>
              </div>
              <button
                onClick={() => setShowEnhancementReview(false)}
                className="p-1 hover:bg-gray-700 rounded"
              >
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {curatedItems.length === 0 ? (
                <p className="text-gray-400 text-sm text-center py-8">No suggestions found. Add your own below.</p>
              ) : null}
              {/* Group suggestions by category */}
              {[
                  { key: 'design', label: 'Design', Icon: Palette, color: 'text-pink-400', borderColor: 'border-pink-500/30' },
                  { key: 'functionality', label: 'Functionality', Icon: CogIcon, color: 'text-cyan-400', borderColor: 'border-cyan-500/30' },
                  { key: 'security', label: 'Security', Icon: Shield, color: 'text-red-400', borderColor: 'border-red-500/30' },
                  { key: 'user', label: 'User Enhancements', Icon: UserPlus, color: 'text-green-400', borderColor: 'border-green-500/30' },
                ].map(group => {
                  const groupItems = curatedItems
                    .map((item, idx) => ({ item, idx }))
                    .filter(({ item }) => item.category === group.key || (group.key === 'functionality' && item.category === 'func'))
                  if (groupItems.length === 0 && group.key !== 'user') return null
                  return (
                    <div key={group.key} className="space-y-2">
                      <h4 className={`flex items-center gap-2 text-sm font-semibold ${group.color} border-b ${group.borderColor} pb-1.5`}>
                        <group.Icon className="w-4 h-4" />
                        {group.label}
                        <span className="text-xs text-gray-500 font-normal">({groupItems.length})</span>
                      </h4>
                      {groupItems.map(({ item, idx }) => (
                        <div
                          key={idx}
                          className={`rounded-lg border p-3 transition-colors ${
                            item.selected
                              ? 'bg-gray-700/60 border-gray-600'
                              : 'bg-gray-800/40 border-gray-700/50 opacity-60'
                          }`}
                        >
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              checked={item.selected}
                              onChange={() => {
                                const updated = [...curatedItems]
                                updated[idx] = { ...updated[idx], selected: !updated[idx].selected }
                                setCuratedItems(updated)
                              }}
                              className="mt-1 w-4 h-4 rounded border-gray-500 bg-gray-600 text-purple-500 focus:ring-purple-500"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 mb-1 flex-wrap">
                                <span
                                  onClick={() => {
                                    const updated = [...curatedItems]
                                    updated[idx] = { ...updated[idx], editing: true }
                                    setCuratedItems(updated)
                                  }}
                                  className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase cursor-pointer hover:ring-1 hover:ring-white/30 ${
                                    item.priority === 'critical' ? 'bg-red-500/20 text-red-400' :
                                    item.priority === 'high' ? 'bg-orange-500/20 text-orange-400' :
                                    item.priority === 'medium' ? 'bg-yellow-500/20 text-yellow-400' :
                                    'bg-gray-500/20 text-gray-400'
                                  }`}
                                  title="Click to edit priority"
                                >
                                  {item.priority}
                                </span>
                                {item.subcategory && (
                                  <span className="px-1.5 py-0.5 rounded text-[10px] text-gray-400 bg-gray-700/50">
                                    {item.subcategory.replace(/_/g, ' ')}
                                  </span>
                                )}
                              </div>

                              {item.editing ? (
                                <div className="space-y-2">
                                  <select
                                    value={item.priority}
                                    onChange={(e) => {
                                      const updated = [...curatedItems]
                                      updated[idx] = { ...updated[idx], priority: e.target.value }
                                      setCuratedItems(updated)
                                    }}
                                    aria-label="Priority"
                                    className="w-full px-2 py-1 bg-gray-600 border border-gray-500 rounded text-sm text-white"
                                  >
                                    <option value="critical">Critical</option>
                                    <option value="high">High</option>
                                    <option value="medium">Medium</option>
                                    <option value="low">Low</option>
                                  </select>
                                  <input
                                    type="text"
                                    value={item.title}
                                    onChange={(e) => {
                                      const updated = [...curatedItems]
                                      updated[idx] = { ...updated[idx], title: e.target.value }
                                      setCuratedItems(updated)
                                    }}
                                    className="w-full px-2 py-1 bg-gray-600 border border-gray-500 rounded text-sm text-white"
                                    placeholder="Title"
                                  />
                                  <textarea
                                    value={item.description}
                                    onChange={(e) => {
                                      const updated = [...curatedItems]
                                      updated[idx] = { ...updated[idx], description: e.target.value }
                                      setCuratedItems(updated)
                                    }}
                                    rows={3}
                                    className="w-full px-2 py-1 bg-gray-600 border border-gray-500 rounded text-sm text-white resize-none"
                                    placeholder="Description"
                                  />
                                  {/* VR-39 — per-enhancement attachments (files + git repo).
                                      Surfaced only for user-authored enhancements (`category === 'user'`)
                                      so LLM-generated suggestions stay text-only. Reuses the
                                      uploadFiles / fetchRepo APIs from the Specification dialog. */}
                                  {item.category === 'user' && (
                                    <div className="space-y-1.5 pt-1 border-t border-gray-600/60">
                                      <div className="text-[10px] uppercase tracking-wider text-gray-400 flex items-center gap-1">
                                        <FilePlus className="w-3 h-3" />
                                        Attachments (optional)
                                      </div>
                                      {(item.attachments || []).length > 0 && (
                                        <div className="space-y-1">
                                          {(item.attachments || []).map((att, attIdx) => (
                                            <div
                                              key={attIdx}
                                              className="flex items-center gap-2 px-2 py-1 bg-gray-700/50 border border-gray-600/40 rounded text-xs"
                                            >
                                              {att.type === 'repo_url' || att.type === 'repo' ? (
                                                <GitBranch className="w-3 h-3 text-green-400 shrink-0" />
                                              ) : (
                                                <FileText className="w-3 h-3 text-blue-400 shrink-0" />
                                              )}
                                              <span className="truncate text-gray-200 flex-1" title={
                                                att.type === 'repo_url' || att.type === 'repo'
                                                  ? (att.url || att.repo_name || '')
                                                  : (att.filename || '')
                                              }>
                                                {att.type === 'repo_url' || att.type === 'repo'
                                                  ? (att.repo_name || att.label || att.url || 'git repo')
                                                  : (att.filename || 'file')}
                                              </span>
                                              <button
                                                type="button"
                                                onClick={() => handleEnhRemoveAttachment(idx, attIdx)}
                                                className="p-0.5 hover:bg-gray-600 rounded text-gray-400 hover:text-red-300"
                                                title="Remove attachment"
                                              >
                                                <X className="w-3 h-3" />
                                              </button>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                      <div className="flex items-center gap-1.5">
                                        <label
                                          className={`flex items-center gap-1 px-2 py-1 text-xs rounded cursor-pointer transition-colors ${
                                            busyAttachIdx === idx
                                              ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                                              : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
                                          }`}
                                          title="Attach files (LLM will read their content as context)"
                                        >
                                          {busyAttachIdx === idx ? (
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                          ) : (
                                            <FilePlus className="w-3 h-3" />
                                          )}
                                          Add file(s)
                                          <input
                                            type="file"
                                            multiple
                                            className="hidden"
                                            disabled={busyAttachIdx === idx}
                                            onChange={(e) => {
                                              handleEnhUploadFiles(idx, e.target.files)
                                              e.target.value = ''  // allow re-uploading the same file
                                            }}
                                          />
                                        </label>
                                      </div>
                                      <div className="flex items-center gap-1.5">
                                        <input
                                          type="url"
                                          placeholder="https://github.com/user/repo"
                                          value={repoUrlByIdx[idx] || ''}
                                          onChange={(e) => setRepoUrlByIdx({ ...repoUrlByIdx, [idx]: e.target.value })}
                                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleEnhFetchRepo(idx) } }}
                                          disabled={busyAttachIdx === idx}
                                          className="flex-1 min-w-0 px-2 py-1 bg-gray-600 border border-gray-500 rounded text-xs text-white placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-green-500 disabled:opacity-50"
                                        />
                                        <button
                                          type="button"
                                          onClick={() => handleEnhFetchRepo(idx)}
                                          disabled={busyAttachIdx === idx || !(repoUrlByIdx[idx] || '').trim()}
                                          className="flex items-center gap-1 px-2 py-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 disabled:opacity-50 text-white text-xs rounded transition-colors"
                                          title="Fetch repo metadata + key files"
                                        >
                                          {busyAttachIdx === idx ? (
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                          ) : (
                                            <GitBranch className="w-3 h-3" />
                                          )}
                                          Add repo
                                        </button>
                                      </div>
                                    </div>
                                  )}
                                  <button
                                    onClick={() => {
                                      const updated = [...curatedItems]
                                      updated[idx] = { ...updated[idx], editing: false }
                                      setCuratedItems(updated)
                                    }}
                                    className="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white text-xs rounded"
                                  >
                                    Done
                                  </button>
                                </div>
                              ) : (
                                <>
                                  <h4 className="text-sm font-medium text-white">{item.title}</h4>
                                  <p className="text-xs text-gray-400 mt-1 line-clamp-3">{item.description}</p>
                                  {/* VR-39 — non-editing badge: show attachment count if any */}
                                  {item.attachments && item.attachments.length > 0 && (
                                    <div className="flex items-center gap-1 mt-1.5 text-[10px] text-gray-400">
                                      <FilePlus className="w-3 h-3 text-green-400" />
                                      {item.attachments.length} attachment{item.attachments.length === 1 ? '' : 's'}
                                      <span className="text-gray-500">
                                        ({item.attachments.map(a =>
                                          a.type === 'repo_url' || a.type === 'repo'
                                            ? (a.repo_name || 'repo')
                                            : (a.filename || 'file')
                                        ).slice(0, 3).join(', ')}{item.attachments.length > 3 ? '…' : ''})
                                      </span>
                                    </div>
                                  )}
                                </>
                              )}
                            </div>

                            <div className="flex gap-1 flex-shrink-0">
                              <button
                                onClick={() => {
                                  const updated = [...curatedItems]
                                  updated[idx] = { ...updated[idx], editing: !updated[idx].editing }
                                  setCuratedItems(updated)
                                }}
                                className="p-1 hover:bg-gray-600 rounded"
                                title="Edit"
                              >
                                <Edit3 className="w-3.5 h-3.5 text-gray-400" />
                              </button>
                              <button
                                onClick={() => {
                                  setCuratedItems(curatedItems.filter((_, i) => i !== idx))
                                }}
                                className="p-1 hover:bg-gray-600 rounded"
                                title="Delete"
                              >
                                <Trash2 className="w-3.5 h-3.5 text-red-400" />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                      {group.key === 'user' && (
                        <button
                          onClick={() => {
                            setCuratedItems([...curatedItems, {
                              title: '',
                              category: 'user',
                              priority: 'medium',
                              description: '',
                              selected: true,
                              editing: true,
                            }])
                          }}
                          className="w-full flex items-center justify-center gap-2 px-3 py-2 border border-dashed border-green-500/40 hover:border-green-500/70 hover:bg-green-500/10 text-green-400 text-sm rounded-lg transition-colors"
                        >
                          <Plus className="w-4 h-4" />
                          Add Enhancement
                        </button>
                      )}
                    </div>
                  )
                })
              }
            </div>

            {/* Footer actions */}
            <div className="p-4 border-t border-gray-700 space-y-2">
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    const allSelected = curatedItems.every(i => i.selected)
                    setCuratedItems(curatedItems.map(i => ({ ...i, selected: !allSelected })))
                  }}
                  className="flex-1 px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-lg transition-colors"
                >
                  {curatedItems.every(i => i.selected) ? 'Deselect All' : 'Select All'}
                </button>
              </div>
              <button
                onClick={handleApplyEnhancements}
                disabled={enhancementLoading || curatedItems.filter(i => i.selected).length === 0}
                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 disabled:text-gray-400 text-white rounded-lg transition-colors font-medium"
              >
                {enhancementLoading ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Sparkles className="w-4 h-4" />
                )}
                Apply {curatedItems.filter(i => i.selected).length} Enhancement{curatedItems.filter(i => i.selected).length !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        )}

        {showCode && finalResult && (
          <div className="w-[600px] bg-gray-800 border-l border-gray-700 flex flex-col">
            {renderPanelBreadcrumb('code')}
            <div className="p-4 border-b border-gray-700 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                  <CheckCircle className="w-5 h-5 text-green-500" />
                  Final Result
                </h3>
                <p className="text-sm text-gray-400 mt-1 flex items-center gap-2">
                  Selected Coder {finalResult.selected_coder_index + 1}
                  {finalResult.verification_passed === true && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/20 text-green-400 text-xs rounded-full" title={`Exit code: ${finalResult.verification_exit_code}`}>
                      <CheckCircle className="w-3 h-3" /> Verified
                    </span>
                  )}
                  {finalResult.verification_passed === false && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/20 text-red-400 text-xs rounded-full" title={finalResult.verification_stderr || `Exit code: ${finalResult.verification_exit_code}`}>
                      <XCircle className="w-3 h-3" /> Verification Failed
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {/* VR-35 FIX: surface Run Code inside the Final Result panel
                    so the action is reachable even if the toolbar above is
                    hidden behind another open side-panel. */}
                <button
                  onClick={handleRunCode}
                  disabled={executing}
                  className="flex items-center gap-2 px-3 py-1 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-sm text-white rounded transition-colors"
                >
                  {executing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                  Run Code
                </button>
                <button
                  onClick={async () => {
                    try {
                      const blob = await downloadResultZip(session.id)
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = `codeforge-result.zip`
                      a.click()
                      URL.revokeObjectURL(url)
                      notify.success('ZIP downloaded')
                    } catch {
                      notify.error('Failed to download ZIP')
                    }
                  }}
                  className="flex items-center gap-2 px-3 py-1 bg-gray-700 hover:bg-gray-600 text-sm text-white rounded transition-colors"
                >
                  <Archive className="w-4 h-4" />
                  Download ZIP
                </button>
                {finalResult.file_structure && Object.keys(finalResult.file_structure).length > 0 && (
                  <button
                    onClick={() => setShowPRModal(!showPRModal)}
                    className="flex items-center gap-2 px-3 py-1 bg-purple-600 hover:bg-purple-700 text-sm text-white rounded transition-colors"
                  >
                    <GitBranch className="w-4 h-4" />
                    Create PR
                  </button>
                )}
                {(session.attachments || []).some((a: { type?: string }) => a?.type === 'repo') && (
                  <button
                    onClick={() => setShowGitPanel(true)}
                    className="flex items-center gap-2 px-3 py-1 bg-gray-700 hover:bg-gray-600 text-sm text-white rounded transition-colors"
                    title="View commits, branches, and diffs"
                  >
                    <GitBranch className="w-4 h-4" />
                    Show Git Info
                  </button>
                )}
                <button
                  onClick={() => setShowCode(false)}
                  className="p-1 hover:bg-gray-700 rounded"
                >
                  <X className="w-5 h-5 text-gray-400" />
                </button>
              </div>
            </div>

            {/* PR Creation Modal */}
            {showPRModal && (
              <div className="p-4 bg-purple-900/30 border-b border-purple-500/50">
                {prResult ? (
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-5 h-5 text-green-400" />
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
                      onClick={async () => {
                        setPRLoading(true)
                        try {
                          const result = await createPullRequest({
                            session_id: session.id,
                            token: prToken,
                            branch_name: prBranch,
                            pr_title: prTitle,
                          })
                          setPRResult(result)
                          notify.success(`PR #${result.pr_number} created!`)
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : 'Failed to create PR'
                          notify.error(msg)
                        } finally {
                          setPRLoading(false)
                        }
                      }}
                      disabled={prLoading || !prToken.trim()}
                      className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded text-sm transition-colors"
                    >
                      {prLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
                      {prLoading ? 'Creating PR...' : 'Create Pull Request'}
                    </button>
                    <p className="text-xs text-gray-500">
                      Token needs <code>repo</code> scope. Never stored — used once for PR creation.
                    </p>
                  </div>
                )}
              </div>
            )}

            {finalResult.selection_reasoning && (
              <div className="px-4 py-3 bg-gray-700/50 border-b border-gray-700">
                <p className="text-sm text-gray-300">{finalResult.selection_reasoning}</p>
              </div>
            )}

            <div className="flex-1 overflow-auto p-4">
              {/* File Structure (repo mode) */}
              {finalResult.file_structure && Object.keys(finalResult.file_structure).length > 0 && (
                <div className="mb-6">
                  <h4 className="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
                    <FolderOpen className="w-4 h-4 text-purple-400" />
                    Modified Files
                  </h4>
                  <div className="space-y-1">
                    {Object.entries(finalResult.file_structure).map(([path, info]) => {
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
                            <FileText className="w-4 h-4 text-gray-400" />
                          )}
                          <span className="text-gray-300 font-mono text-xs">{path}</span>
                          <span className={`ml-auto text-xs ${
                            action === 'created' ? 'text-green-400' :
                            action === 'deleted' ? 'text-red-400' :
                            action === 'modified' ? 'text-yellow-400' :
                            'text-gray-500'
                          }`}>
                            {action}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="mb-6">
                <h4 className="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
                  <Code className="w-4 h-4" />
                  {finalResult.file_structure && Object.keys(finalResult.file_structure).length > 0 ? 'Combined Code' : 'Generated Code'}
                  {/* Улучшатели#3 P2·S — Final Result code: wrap + fullscreen toggles. */}
                  <span className="ml-auto flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setFinalCodeWrap(w => !w)}
                      className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors ${
                        finalCodeWrap
                          ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40'
                          : 'bg-gray-700/60 text-gray-300 hover:bg-gray-700 border border-gray-600/50'
                      }`}
                      title={finalCodeWrap ? 'Disable line wrapping (long lines scroll horizontally)' : 'Enable line wrapping for long lines'}
                      aria-pressed={finalCodeWrap}
                    >
                      {finalCodeWrap ? 'Wrap' : 'No wrap'}
                    </button>
                    <button
                      type="button"
                      onClick={() => setFinalCodeFullscreen(true)}
                      className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-gray-700/60 text-gray-300 hover:bg-gray-700 border border-gray-600/50 transition-colors flex items-center gap-1"
                      title="Expand the code viewer to fullscreen"
                    >
                      <Maximize2 className="w-3 h-3" />
                      Fullscreen
                    </button>
                  </span>
                </h4>
                {/* Улучшатели#3 wave 2 #5 + P2·S — syntax-highlighted via CodeBlock.
                    max-h bumped to 60vh so longer files don't clip at ~24 lines,
                    and showLineNumbers is toggled by the Wrap button (when wrap
                    is on CodeBlock switches to whitespace-pre-wrap mode). */}
                <CodeBlock
                  code={finalResult.final_code || ''}
                  language={session.language}
                  maxHeightClass="max-h-[60vh]"
                  showLineNumbers={!finalCodeWrap}
                />
              </div>

              {finalResult.readme_content && (
                <div className="mb-6">
                  <h4 className="text-sm font-medium text-gray-300 mb-2 flex items-center gap-2">
                    <FileText className="w-4 h-4" />
                    README
                  </h4>
                  <div className="bg-gray-900 p-4 rounded-lg text-sm text-gray-300">
                    <pre className="whitespace-pre-wrap">{finalResult.readme_content}</pre>
                  </div>
                </div>
              )}

              {/* Metrics */}
              <div className="grid grid-cols-3 gap-4 mt-4 pt-4 border-t border-gray-700">
                <div className="bg-gray-900 rounded-lg p-3">
                  <div className="text-xs text-gray-400 mb-1">Iterations</div>
                  <div className="text-lg font-semibold text-white">{finalResult.total_iterations || session.current_iteration}</div>
                </div>
                <div className="bg-gray-900 rounded-lg p-3">
                  <div className="text-xs text-gray-400 mb-1">Tokens</div>
                  <div className="text-lg font-semibold text-white">{(finalResult.total_tokens || 0).toLocaleString()}</div>
                </div>
                <div className="bg-gray-900 rounded-lg p-3">
                  <div className="text-xs text-gray-400 mb-1">Cost</div>
                  <div className="text-lg font-semibold text-white">${(finalResult.total_cost_usd || 0).toFixed(4)}</div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Execution Result Panel */}
        {showExecution && (
          <div className="w-[500px] bg-gray-800 border-l border-gray-700 flex flex-col">
            {renderPanelBreadcrumb('execution')}
            <div className="p-4 border-b border-gray-700 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white flex items-center gap-2">
                <Terminal className="w-5 h-5 text-blue-400" />
                Execution Result
              </h3>
              <button
                onClick={() => setShowExecution(false)}
                className="p-1 hover:bg-gray-700 rounded"
              >
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {executing ? (
                <div className="flex flex-col items-center justify-center h-full">
                  <Loader2 className="w-12 h-12 animate-spin text-blue-500 mb-4" />
                  <p className="text-gray-400">Executing code...</p>
                </div>
              ) : executionResult ? (
                <div className="space-y-4">
                  {/* Status badge */}
                  <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                    executionResult.success 
                      ? 'bg-green-900/30 border-green-700' 
                      : 'bg-red-900/30 border-red-700'
                  }`}>
                    {executionResult.success ? (
                      <CheckCircle className="w-6 h-6 text-green-500" />
                    ) : (
                      <X className="w-6 h-6 text-red-500" />
                    )}
                    <div>
                      <div className={`font-semibold ${executionResult.success ? 'text-green-400' : 'text-red-400'}`}>
                        {executionResult.success ? 'Success' : 'Failed'}
                      </div>
                      <div className="text-sm text-gray-400">
                        Exit code: {executionResult.exit_code} • Time: {executionResult.execution_time_ms}ms
                        {executionResult.memory_used_mb && ` • Memory: ${executionResult.memory_used_mb.toFixed(1)}MB`}
                      </div>
                    </div>
                  </div>

                  {/* Stdout */}
                  {executionResult.stdout && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-300 mb-2">Output (stdout)</h4>
                      <pre className="bg-gray-900 p-3 rounded-lg text-sm text-green-400 font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                        {executionResult.stdout}
                      </pre>
                    </div>
                  )}

                  {/* Stderr */}
                  {executionResult.stderr && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-300 mb-2">Errors (stderr)</h4>
                      <pre className="bg-gray-900 p-3 rounded-lg text-sm text-red-400 font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                        {executionResult.stderr}
                      </pre>
                    </div>
                  )}

                  {/* Run again button */}
                  <button
                    onClick={handleRunCode}
                    disabled={executing}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg transition-colors"
                  >
                    <Play className="w-4 h-4" />
                    Run Again
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {/* Browser Preview panel (Run in Browser) */}
        {showBrowserPreview && browserPreviewHtml && (
          <div className="w-[720px] h-full border-l border-gray-700 bg-gray-800 flex flex-col animate-slideIn">
            {renderPanelBreadcrumb('browser')}
            {/* Header */}
            <div className="flex items-center justify-between p-3 border-b border-gray-700 bg-gray-800/95">
              <div className="flex items-center gap-2">
                <Globe className="w-5 h-5 text-blue-400" />
                <h3 className="font-semibold text-white text-sm">Browser Preview</h3>
                <span className="text-xs text-gray-500 ml-1">
                  {({
                    javascript_browser: 'JS (BROWSER)',
                    typescript_browser: 'TS (BROWSER)',
                    javascript: 'JS (NODE.JS)',
                    typescript: 'TYPESCRIPT',
                  } as Record<string, string>)[session?.language?.toLowerCase() || ''] || session?.language?.toUpperCase()}
                </span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    setBrowserPreviewKey(k => k + 1)
                  }}
                  className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white transition-colors"
                  title="Refresh"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
                <button
                  onClick={handleOpenInNewTab}
                  className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white transition-colors"
                  title="Open in new tab"
                >
                  <ExternalLink className="w-4 h-4" />
                </button>
                <button
                  onClick={() => setShowBrowserPreview(false)}
                  className="p-1.5 hover:bg-gray-700 rounded text-gray-400 hover:text-white transition-colors"
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {/* Iframe loads sandbox-frame.html which renders content in a child
                iframe via srcdoc. The child inherits sandbox-frame.html's permissive
                CSP (script-src *), so CDN scripts like Three.js load correctly. */}
            <div className="flex-1 bg-white">
              <iframe
                key={browserPreviewKey}
                ref={sandboxIframeRef}
                src="/sandbox-frame.html"
                sandbox="allow-scripts allow-modals allow-forms allow-popups"
                className="w-full h-full border-0"
                title="CodeForge Browser Preview"
              />
            </div>
          </div>
        )}

        {/* Git panel — overlay showing commits, diffs, and PR status */}
        {showGitPanel && (
          <GitPanel
            sessionId={sessionId!}
            hasRepoAttached={(session.attachments || []).some((a: { type?: string }) => a?.type === 'repo')}
            prUrl={prResult?.pr_url}
            onClose={() => setShowGitPanel(false)}
          />
        )}

        {/* КАО#VR-Wave1 Frontend — Visual Review side-panel.
            Rendered above the DetailPanel guard so it takes precedence when open. */}
        {showVisualReview && (
          <div className="flex flex-col">
            {renderPanelBreadcrumb('visualReview')}
            <VisualReviewPanel
              sessionId={sessionId!}
              onClose={() => setShowVisualReview(false)}
              onSubmitted={() => {
                // Refresh session so status pill flips back to running/completed.
                loadSession()
              }}
              onSkipped={() => {
                loadSession()
              }}
            />
          </div>
        )}

        {/* Detail panel for selected node */}
        {selectedNode && selectedNodeData && !showCode && !showIntervention && !showExecution && !showBrowserPreview && !showEnhancementReview && !showVisualReview && (
          // Улучшатели#3 P2·M — wrap DetailPanel so the side-panel breadcrumb
          // sits above it. The DetailPanel itself is a self-contained component
          // we don't own, so we attach the breadcrumb at the wrapper level.
          <div className="flex flex-col">
            {renderPanelBreadcrumb('detail')}
            <DetailPanel
              nodeId={selectedNode}
              nodeType={selectedNodeData.agentType}
              agentIndex={selectedNodeData.agentIndex}
              sessionId={sessionId!}
              title={selectedNodeData.label}
              llmModel={selectedNodeData.llmModel}
              language={session.language}
              currentIteration={session.current_iteration}
              maxIterations={session.max_iterations}
              sessionStatus={session.status}
              specification={session.specification}
              onClose={() => {
                setSelectedNode(null)
                setSelectedNodeData(null)
              }}
              onRunCodeVersion={handleRunCodeVersion}
              /* Улучшатели#3 wave 2 #2 — current node status + retry handler.
                 Read live status from the nodes array (selectedNodeData may be stale). */
              nodeStatus={(nodes.find((n: any) => n.id === selectedNode)?.data as any)?.status as string | undefined}
              onRetryAgent={handleRetryAgent}
              /* VR-35 — let the Output node panel run the finalized code. */
              onRunCode={handleRunCode}
              isRunningCode={executing}
            />
          </div>
        )}
      </div>

      {/* Улучшатели#3 P2·S — Final Result fullscreen modal.
          Re-uses the Modal primitive (size="2xl") and the CodeBlock primitive
          so the fullscreen viewer inherits highlighting + copy. */}
      <Modal
        open={finalCodeFullscreen}
        onClose={() => setFinalCodeFullscreen(false)}
        title="Generated Code"
        size="2xl"
        icon={<Code className="w-5 h-5 text-indigo-400" />}
      >
        <div className="flex items-center gap-2 mb-2">
          <button
            type="button"
            onClick={() => setFinalCodeWrap(w => !w)}
            className={`text-[11px] uppercase tracking-wider px-2 py-1 rounded transition-colors ${
              finalCodeWrap
                ? 'bg-indigo-600/30 text-indigo-200 border border-indigo-500/40'
                : 'bg-gray-700/60 text-gray-300 hover:bg-gray-700 border border-gray-600/50'
            }`}
            title={finalCodeWrap ? 'Disable line wrapping' : 'Enable line wrapping'}
            aria-pressed={finalCodeWrap}
          >
            {finalCodeWrap ? 'Wrap' : 'No wrap'}
          </button>
        </div>
        <CodeBlock
          code={finalResult?.final_code || ''}
          language={session.language}
          maxHeightClass="max-h-[75vh]"
          showLineNumbers={!finalCodeWrap}
        />
      </Modal>

      {/* Specifications Dialog — opened when clicking the Specification node in the graph */}
      <SpecificationsDialog
        isOpen={showSpecificationsDialog}
        onClose={() => setShowSpecificationsDialog(false)}
        sessionId={sessionId!}
        specification={session.specification || ''}
        initialCode={session.initial_code || ''}
        attachments={session.attachments || []}
        language={session.language}
        agentConfigs={session.agent_configs}
        maxIterations={session.max_iterations}
        onSaved={(data) => {
          // Update local session state with saved specifications
          setSession(prev => prev ? {
            ...prev,
            specification: data.specification,
            initial_code: data.initial_code,
            attachments: data.attachments,
          } : prev)
        }}
      />

      {/* Save as Template dialog */}
      {showSaveTemplate && (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => !savingTemplate && setShowSaveTemplate(false)}
        >
          <div
            className="bg-gray-800 rounded-xl p-6 w-full max-w-md border border-gray-700"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-4">
              <BookmarkPlus className="w-5 h-5 text-indigo-400" />
              <h3 className="text-lg font-semibold text-white">Save as Template</h3>
            </div>
            <p className="text-sm text-gray-400 mb-4">
              Snapshot this session's agent configurations and settings as a reusable template.
            </p>
            <label className="block text-sm text-gray-300 mb-1">Name</label>
            <input
              type="text"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="Template name"
              maxLength={255}
              autoFocus
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 mb-3"
            />
            <label className="block text-sm text-gray-300 mb-1">Description (optional)</label>
            <textarea
              value={templateDescription}
              onChange={(e) => setTemplateDescription(e.target.value)}
              placeholder="What is this template for?"
              rows={3}
              maxLength={10000}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 mb-4 resize-none"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowSaveTemplate(false)}
                disabled={savingTemplate}
                className="px-4 py-2 text-gray-300 hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveTemplate}
                disabled={savingTemplate || !templateName.trim()}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
              >
                {savingTemplate && <Loader2 className="w-4 h-4 animate-spin" />}
                Save Template
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={handleResetConfirmed}
        title="Reset Session"
        message='This session will return to "Created" status. All results from the current run will be cleared and you can start again.'
        confirmText="Reset"
        cancelText="Cancel"
        type="warning"
        loading={actionLoading}
      />

      {/* Re-finalize Confirmation Dialog */}
      <ConfirmDialog
        isOpen={showRefinalizeConfirm}
        onClose={() => setShowRefinalizeConfirm(false)}
        onConfirm={handleRefinalizeConfirmed}
        title="Re-finalize Session"
        message="Re-run finalization using existing code versions. Current final result and enhancement suggestions will be replaced."
        confirmText="Re-finalize"
        cancelText="Cancel"
        type="warning"
        loading={actionLoading}
      />

      {/* КАО#VR-11 RestartFromScratch — destructive confirm before wiping all artifacts. */}
      <ConfirmDialog
        isOpen={showRestartConfirm}
        onClose={() => setShowRestartConfirm(false)}
        onConfirm={handleRestartConfirmed}
        title="Restart from scratch?"
        message="This will discard all current results (code versions, audits, screenshots, final code) and re-run the workflow from iteration 0 with the same specification. This cannot be undone."
        confirmText="Restart"
        cancelText="Cancel"
        type="danger"
        loading={actionLoading}
      />

      {/* Session Settings Modal */}
      {showSettings && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-800 rounded-xl border border-gray-700 shadow-2xl w-[520px] max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b border-gray-700">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Settings className="w-5 h-5 text-indigo-400" />
                Session Settings
              </h2>
              <button onClick={() => setShowSettings(false)} className="p-1 hover:bg-gray-700 rounded-lg transition-colors">
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                const form = e.currentTarget
                const fd = new FormData(form)
                try {
                  const agentT = Number(fd.get('agent_timeout'))
                  let requestT = Number(fd.get('request_timeout'))
                  if (requestT > agentT) requestT = agentT
                  // Feature #1: persist `streaming` in session.settings so
                  // backend emits agent_streaming WebSocket events.
                  const streamingOn = fd.get('streaming') === 'on'
                  const mergedSettings: Record<string, unknown> = {
                    ...(session.settings || {}),
                    streaming: streamingOn,
                  }
                  await updateSession(session.id, {
                    language: fd.get('language') as string,
                    max_iterations: Number(fd.get('max_iterations')),
                    enable_code_execution: fd.get('enable_code_execution') === 'on',
                    execution_timeout: Number(fd.get('execution_timeout')),
                    max_fix_attempts: Number(fd.get('max_fix_attempts')),
                    auto_install_deps: fd.get('auto_install_deps') === 'on',
                    agent_timeout: agentT,
                    request_timeout: requestT,
                    settings: mergedSettings,
                  })
                  // Update max_tokens for all agents
                  const newMaxTokens = Number(fd.get('max_tokens'))
                  if (newMaxTokens && newMaxTokens > 0) {
                    await Promise.all(
                      session.agent_configs.map(ac =>
                        updateAgentConfig(session.id, ac.id, { max_tokens: newMaxTokens })
                      )
                    )
                  }
                  notify.success('Settings saved')
                  setShowSettings(false)
                  loadSession()
                } catch (err: any) {
                  const detail = err?.response?.data?.detail || err?.message || 'Failed to save settings'
                  notify.error(String(detail))
                }
              }}
              className="p-5 space-y-3"
            >
              {/* Model & Agents */}
              <SettingsSection title="Model & Agents" defaultOpen={true}>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1" htmlFor="session-language-select">Language</label>
                    <select
                      id="session-language-select"
                      name="language"
                      defaultValue={session.language}
                      aria-label="Session language"
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    >
                      <option value="python">Python</option>
                      <option value="javascript_browser">JavaScript (Browser)</option>
                      <option value="typescript_browser">TypeScript (Browser)</option>
                      <option value="javascript">JavaScript (Node.js)</option>
                      <option value="typescript">TypeScript (Node.js)</option>
                      <option value="java">Java</option>
                      <option value="cpp">C++</option>
                      <option value="go">Go</option>
                      <option value="rust">Rust</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Max Tokens</label>
                    {(() => {
                      const limits = session.agent_configs.map(ac => {
                        const prov = providers.find(p => p.name === ac.llm_provider)
                        const caps = prov?.model_capabilities?.[ac.llm_model]
                        return caps?.max_output_tokens ?? 128000
                      })
                      const maxLimit = Math.max(...limits, 4096)
                      return (
                        <>
                          <input
                            name="max_tokens"
                            type="number"
                            min={1024}
                            max={maxLimit}
                            defaultValue={session.agent_configs[0]?.max_tokens ?? 64000}
                            className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                          />
                          <p className="text-xs text-indigo-400/70 mt-0.5">
                            Applied to all agents · Limit: {maxLimit.toLocaleString()} (providers auto-clamp)
                          </p>
                        </>
                      )
                    })()}
                  </div>
                </div>
              </SettingsSection>

              {/* Execution */}
              <SettingsSection title="Execution" defaultOpen={true}>
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <span className="text-sm font-medium text-gray-300">Enable Code Execution</span>
                    <p className="text-xs text-gray-500">Run generated code in sandbox to validate</p>
                  </div>
                  <input
                    name="enable_code_execution"
                    type="checkbox"
                    defaultChecked={session.enable_code_execution}
                    className="w-10 h-5 rounded-full appearance-none bg-gray-600 checked:bg-green-500 relative cursor-pointer transition-colors
                      before:content-[''] before:absolute before:w-4 before:h-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 before:transition-transform checked:before:translate-x-5"
                  />
                </label>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Sandbox Timeout (sec)</label>
                    <input
                      name="execution_timeout"
                      type="number"
                      min={10}
                      max={300}
                      defaultValue={session.execution_timeout}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    />
                    <p className="text-xs text-indigo-400/70 mt-0.5">Code execution: 10-300s</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Request Timeout (sec)</label>
                    <input
                      name="request_timeout"
                      type="number"
                      min={30}
                      max={3600}
                      defaultValue={session.request_timeout ?? 300}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    />
                    <p className="text-xs text-indigo-400/70 mt-0.5">Per LLM call: 30-3600s</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Agent Timeout (sec)</label>
                    <input
                      name="agent_timeout"
                      type="number"
                      min={60}
                      max={3600}
                      defaultValue={session.agent_timeout ?? 600}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    />
                    <p className="text-xs text-indigo-400/70 mt-0.5">Overall agent: 60-3600s</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Max Fix Attempts</label>
                    <input
                      name="max_fix_attempts"
                      type="number"
                      min={0}
                      max={10}
                      defaultValue={session.max_fix_attempts}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    />
                    <p className="text-xs text-indigo-400/70 mt-0.5">Per iteration</p>
                  </div>
                </div>
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <span className="text-sm font-medium text-gray-300">Auto-install Dependencies</span>
                    <p className="text-xs text-gray-500">Automatically install missing packages</p>
                  </div>
                  <input
                    name="auto_install_deps"
                    type="checkbox"
                    defaultChecked={session.auto_install_deps}
                    className="w-10 h-5 rounded-full appearance-none bg-gray-600 checked:bg-green-500 relative cursor-pointer transition-colors
                      before:content-[''] before:absolute before:w-4 before:h-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 before:transition-transform checked:before:translate-x-5"
                  />
                </label>
              </SettingsSection>

              {/* Workflow */}
              <SettingsSection title="Workflow" defaultOpen={true}>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Max Iterations</label>
                    <input
                      name="max_iterations"
                      type="number"
                      min={1}
                      max={50}
                      defaultValue={session.max_iterations}
                      className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                    />
                  </div>
                </div>
                {/* Feature #1: streaming LLM output toggle (default ON — avoids
                    Anthropic long-request timeouts on opus/large generations).
                    Reads from session.settings.streaming; undefined → ON. */}
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <span className="text-sm font-medium text-gray-300">Enable streaming output</span>
                    <p className="text-xs text-gray-500">
                      Show partial LLM tokens on agent nodes as they stream in.
                      Recommended ON to avoid Anthropic long-request timeouts.
                    </p>
                  </div>
                  <input
                    name="streaming"
                    type="checkbox"
                    defaultChecked={((session.settings as Record<string, unknown> | undefined)?.streaming ?? true) as boolean}
                    className="w-10 h-5 rounded-full appearance-none bg-gray-600 checked:bg-green-500 relative cursor-pointer transition-colors
                      before:content-[''] before:absolute before:w-4 before:h-4 before:rounded-full before:bg-white before:top-0.5 before:left-0.5 before:transition-transform checked:before:translate-x-5"
                  />
                </label>
              </SettingsSection>

              {/* Footer */}
              <div className="flex justify-end gap-2 pt-2 border-t border-gray-700">
                <button
                  type="button"
                  onClick={() => setShowSettings(false)}
                  className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 rounded-lg text-sm transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={session.status === 'running'}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  Save Settings
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Улучшатели#3 wave 2 #7 — Keyboard shortcuts help modal. */}
      <Modal
        open={shortcutsHelpOpen}
        onClose={() => setShortcutsHelpOpen(false)}
        title="Keyboard shortcuts"
        description="Press a key while the graph or canvas is focused (not while typing in an input)."
        size="md"
      >
        <ul className="space-y-2 text-sm text-cf-text">
          {[
            { keys: ['?'], label: 'Show / hide this help' },
            { keys: ['Esc'], label: 'Close the open panel or modal' },
            { keys: ['p'], label: 'Toggle browser preview' },
            { keys: ['Space'], label: 'Pause when running, resume when paused' },
            { keys: ['c'], label: 'Focus the most-recent code viewer' },
            { keys: ['i'], label: 'Open the intervention panel' },
          ].map(s => (
            <li key={s.label} className="flex items-center justify-between gap-3 py-1">
              <span className="text-cf-text-muted">{s.label}</span>
              <span className="flex gap-1">
                {s.keys.map(k => (
                  <kbd
                    key={k}
                    className="px-2 py-0.5 text-xs font-mono rounded border border-cf-border bg-cf-hover text-cf-text"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-5 flex justify-end">
          <Button variant="secondary" onClick={() => setShortcutsHelpOpen(false)}>
            Close
          </Button>
        </div>
      </Modal>

      {/* CSS for animations */}
      <style>{`
        @keyframes flowAnimation {
          from {
            stroke-dashoffset: 15;
          }
          to {
            stroke-dashoffset: 0;
          }
        }
        
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        
        .animate-slideIn {
          animation: slideIn 0.3s ease-out forwards;
        }
      `}</style>
    </div>
  )
}
