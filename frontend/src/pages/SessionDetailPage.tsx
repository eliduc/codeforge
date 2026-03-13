/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, Navigate } from 'react-router-dom'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  useViewport,
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
} from 'lucide-react'
import notify from '../components/common/StyledToast'
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
  refinalizeSession,
  addAgentConfig,
  updateAgentConfig,
  deleteAgentConfig,
  createIntervention,
  runCodeVersion,
} from '../services/api'
import type { SessionResponse, FinalResultResponse, ExecutionResult, ReconnectingWebSocket } from '../services/api'
import type { EnhancementSuggestion, CuratedSuggestion, EnhancerAgentConfig, EnhancerSummarizerConfig, EnhanceRequest } from '../types'
import { useProvidersStore } from '../stores/providersStore'
import SpecificationsDialog from '../components/common/SpecificationsDialog'
import ConfirmDialog from '../components/common/ConfirmDialog'
import { 
  AgentNode, 
  ArtifactEdge, 
  DetailPanel, 
  MetricsPanel, 
  LegendPanel,
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

// ── Group Frames Overlay ──
// Rendered OUTSIDE <ReactFlow> so buttons aren't blocked by the pane grab handler.
function GroupFramesLayer({ viewport, nodes: allNodes, onAddCoder, onAddTester, onRemoveCoder, onRemoveTester, canModify }: {
  viewport: { x: number; y: number; zoom: number }
  nodes: any[]
  onAddCoder: () => void
  onAddTester: () => void
  onRemoveCoder: () => void
  onRemoveTester: () => void
  canModify: boolean
}) {
  const { x: vx, y: vy, zoom } = viewport

  const PADDING = 24
  const AGENT_NODE_W = 200
  const AGENT_NODE_H = 130

  const groups: { label: string; color: string; nodePrefix: string; showCount?: boolean; onAdd?: () => void; onRemove?: () => void; minCount?: number }[] = [
    { label: 'Coders', color: '#3B82F6', nodePrefix: 'coder-', showCount: true, onAdd: onAddCoder, onRemove: onRemoveCoder, minCount: 1 },
    { label: 'Testers', color: '#F59E0B', nodePrefix: 'tester-', showCount: true, onAdd: onAddTester, onRemove: onRemoveTester, minCount: 1 },
    { label: 'Enhancers', color: '#A855F7', nodePrefix: 'enhancer-' },
  ]

  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 5 }}>
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
          >
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
const NODE_WIDTH = 180
const HORIZONTAL_GAP = 120
const VERTICAL_GAP = 140
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
  existingConfig?: { llm_provider: string; llm_model: string; thinking_effort?: string | null; custom_prompt?: string | null; enabled?: boolean };
  onClose: () => void;
  onSave?: (config: { provider: string; model: string; thinkingEffort: string; enabled: boolean; instruction: string }) => void
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
      className="absolute z-50 w-52 bg-gray-800 border border-gray-600 rounded-xl p-3 flex flex-col gap-2.5 shadow-xl shadow-black/40 max-h-[calc(100vh-80px)] overflow-y-auto"
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
            <label className="block text-xs font-medium text-gray-400 mb-1">Provider</label>
            <select
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
              className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
            >
              {providers.map(p => (
                <option key={p.name} value={p.name}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Model</label>
            <select
              value={model}
              onChange={e => {
                setModel(e.target.value)
                // Reset thinking effort when model changes
                setThinkingEffort('')
              }}
              className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
            >
              {modelsForProvider.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>

          {/* Thinking Effort */}
          <div>
            <label className="block text-xs font-medium text-gray-400 mb-1">Thinking Effort</label>
            <select
              value={thinkingEffort}
              onChange={e => setThinkingEffort(e.target.value)}
              disabled={supportedEfforts.length === 0}
              className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {finalEffortOptions.map(o => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          {/* Instruction */}
          {isEnhancerAgent && (
            <div>
              <label className="block text-xs font-medium text-gray-400 mb-1">Instructions</label>
              <textarea
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                placeholder="Custom instructions..."
                rows={3}
                className="w-full px-2 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-xs text-white placeholder-gray-500 resize-none focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>
          )}

          {/* OK button */}
          <button
            onClick={() => {
              onSave?.({ provider, model, thinkingEffort, enabled, instruction })
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

export default function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()
  const wsRef = useRef<ReconnectingWebSocket | null>(null)
  const reactFlowContainerRef = useRef<HTMLDivElement>(null)

  const [session, setSession] = useState<SessionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState(false)
  const [finalResult, setFinalResult] = useState<FinalResultResponse | null>(null)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [showRefinalizeConfirm, setShowRefinalizeConfirm] = useState(false)

  // UI state
  const [showCode, setShowCode] = useState(false)
  const [showPRModal, setShowPRModal] = useState(false)
  const [prToken, setPRToken] = useState('')
  const [prBranch, setPRBranch] = useState('codeforge/improvements')
  const [prTitle, setPRTitle] = useState('CodeForge: Code Improvements')
  const [prLoading, setPRLoading] = useState(false)
  const [prResult, setPRResult] = useState<{ pr_url: string; pr_number: number } | null>(null)
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

  // Editable title state
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Specifications dialog state
  const [showSpecificationsDialog, setShowSpecificationsDialog] = useState(false)

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
  const executionTimeoutRef = useRef<number>(60)

  // Keep refs in sync with state
  useEffect(() => {
    finishedCodersRef.current = workflowState.finishedCoders
  }, [workflowState.finishedCoders])

  useEffect(() => {
    agentTimeoutRef.current = session?.agent_timeout ?? 300
    executionTimeoutRef.current = session?.execution_timeout ?? 60
  }, [session?.agent_timeout, session?.execution_timeout])

  // Setup WebSocket connection — use ref to avoid stale closure
  useEffect(() => {
    if (!sessionId) return

    const ws = createWebSocket(sessionId)
    wsRef.current = ws

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
      
      // Initialize workflowState from session data
      setWorkflowState(prev => ({
        ...prev,
        iteration: data.current_iteration ?? prev.iteration,
        phase: data.status === 'running' ? 'coding' : 
               data.status === 'completed' ? 'completed' : 
               data.status === 'enhancing' ? 'coding' :
               data.status === 'awaiting_enhancement' ? 'completed' :
               data.status === 'awaiting_enhancement_review' ? 'completed' : 'idle',
      }))

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
                    iteration: data.current_iteration || node.data.iteration,
                  },
                }
              }
              // Enhancer nodes → working only if enabled (D/F/S agents only).
              // Enh. Summarizer stays idle until it actually starts
              // (it runs only after all enhancer agents finish).
              if (node.id.startsWith('enhancer-') && node.id !== 'enhancer-summarizer') {
                const enhancerConfigs = data.agent_configs || session?.agent_configs || []
                const isEnabledEnhancer =
                  enhancerConfigs.some((c: any) => c.agent_type === node.data.agentType && c.enabled !== false)
                return {
                  ...node,
                  data: {
                    ...node.data,
                    status: isEnabledEnhancer ? 'working' : 'idle',
                  },
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
              if (node.id === 'input' || node.id === 'output') return node
              return {
                ...node,
                data: {
                  ...node.data,
                  status: 'done',
                  iteration: data.current_iteration || node.data.iteration,
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

    const coders = sessionData.agent_configs.filter(a => a.agent_type === 'coder')
    const testers = sessionData.agent_configs.filter(a => a.agent_type === 'tester')
    const summarizer = sessionData.agent_configs.find(a => a.agent_type === 'summarizer')
    const finalizer = sessionData.agent_configs.find(a => a.agent_type === 'finalizer')
    const enhancerConfigs = sessionData.agent_configs.filter(a => ['enhancer_design', 'enhancer_func', 'enhancer_security'].includes(a.agent_type))

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
        status: sessionData.status === 'completed' ? 'done' : 'idle',
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
          hasArtifact: sessionData.status === 'completed',
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
    const enhancerY = centerY + Math.max(coders.length, testers.length) * VERTICAL_GAP / 2 + VERTICAL_GAP + 20
    const enhAgentNames = ['design', 'functionality', 'security']
    const enhAgentLabels = ['Design', 'Functionality', 'Security']
    const enhAgentTypes = ['enhancer_design', 'enhancer_func', 'enhancer_security']
    const enhAgentsX = finalizerX  // D/F/S column — below Finalizer
    const enhVerticalGap = 90
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

  // Keep the ref pointing at the latest handleWSMessage to avoid stale closures
  useEffect(() => {
    handleWSMessageRef.current = handleWSMessage
  })

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
          '*'
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

  function handleWSMessage(message: { type: string; data?: Record<string, unknown> }) {
    const { type, data } = message

    switch (type) {
      case 'workflow_started':
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
            // Animate edges from input to all coders
            setEdges((eds: any[]) =>
              eds.map((edge: any) => {
                if (edge.source === 'input') {
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
          // Animate edges from input to active coders only
          setEdges((eds: any[]) =>
            eds.map((edge: any) => {
              if (edge.source === 'input') {
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
            // Testers will get 'working' from individual agent_started events
          } else if (phase === 'summarizing') {
            // All testers are done — set them all to 'done' (catch-all)
            updateAllAgentStatuses('tester', 'done')
            updateNodeStatus('summarizer', undefined, 'working', {
              timeoutAt: Date.now() + agentTimeoutRef.current * 1000,
            })
            animateEdgesToNode('summarizer', undefined)
          } else if (phase === 'finalizing') {
            updateNodeStatus('finalizer', undefined, 'working', {
              timeoutAt: Date.now() + agentTimeoutRef.current * 1000,
            })
            animateEdgesToNode('finalizer', undefined)
          }
        }
        break

      case 'agent_started':
        if (data) {
          const agentType = data.agent_type as string
          const agentIndex = data.agent_index as number | undefined
          const coderIndex = data.coder_index as number | undefined

          updateNodeStatus(agentType, agentIndex, 'working', {
            timeoutAt: Date.now() + agentTimeoutRef.current * 1000,
          })
          animateEdgesToNode(agentType, agentIndex, coderIndex)
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
                updateNodeStatus('tester', agentIndex, 'done', { ...data, timeoutAt: undefined })
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
            updateNodeStatus(agentType, agentIndex, 'done', { ...data, timeoutAt: undefined })
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
              timeoutAt: undefined,
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
            timeoutAt: Date.now() + executionTimeoutRef.current * 1000,
          })
        }
        break

      case 'code_execution_completed':
        if (data) {
          const coderIndex = data.coder_index as number
          const success = data.success as boolean
          
          if (success) {
            // Execution succeeded, go back to done state
            updateNodeStatus('coder', coderIndex, 'done')
          }
          // If not success, fixing_started will follow
        }
        break

      case 'code_fixing_started':
        if (data) {
          const coderIndex = data.coder_index as number
          const attempt = data.attempt as number

          // Use updateNodeStatus (not WithFix) to set timeoutAt for the fixing LLM call
          updateNodeStatus('coder', coderIndex, 'fixing', {
            fixAttempt: attempt,
            timeoutAt: Date.now() + agentTimeoutRef.current * 1000,
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
        // Mark main pipeline nodes as done (coding finished)
        setNodes((nds: any[]) =>
          nds.map((node: any) => {
            if (node.id.startsWith('coder-') || node.id.startsWith('tester-') ||
                node.id === 'summarizer' || node.id === 'finalizer' || node.id === 'output') {
              return {
                ...node,
                data: { ...node.data, status: 'done' },
              }
            }
            return node
          })
        )
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
            timeoutAt: Date.now() + agentTimeoutRef.current * 1000,
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
        }
        break
      }

      case 'enhancer_agent_completed': {
        const enhNodeId = enhancerTypeToNodeId(String(data?.agent_type || ''))
        if (enhNodeId) {
          updateEnhancerNode(enhNodeId, 'done', { timeoutAt: undefined })
          // Stop incoming edge animations, animate outgoing edges
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
            timeoutAt: undefined,
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
        updateEnhancerNode('enhancer-summarizer', 'working', {
          timeoutAt: Date.now() + agentTimeoutRef.current * 1000,
        })
        setEdges((eds: any[]) =>
          eds.map((edge: any) => {
            if (edge.target === 'enhancer-summarizer') {
              return { ...edge, data: { ...edge.data, animated: true, hasArtifact: true } }
            }
            return edge
          })
        )
        break

      case 'enhancer_summarizer_completed':
        updateEnhancerNode('enhancer-summarizer', 'done', { timeoutAt: undefined })
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
          timeoutAt: undefined,
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
              return { ...node, data: { ...node.data, status: 'error', timeoutAt: undefined } }
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

      case 'workflow_cancelled':
        notify.info('Workflow cancelled')
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
              iteration: (data?.iteration as number) || node.data.iteration,
              tokensUsed: (data?.tokens as number) ?? node.data.tokensUsed,
              costUsd: (data?.cost as number) ?? node.data.costUsd,
              issuesFound: (data?.issues_found as number) ?? node.data.issuesFound,
              fixAttempt: (data?.fixAttempt as number) ?? node.data.fixAttempt,
              maxFixAttempts: (data?.maxFixAttempts as number) ?? node.data.maxFixAttempts,
              // Preserve timeoutAt unless explicitly set in data (even to undefined = clear)
              timeoutAt: data && 'timeoutAt' in data
                ? (data.timeoutAt as number | undefined)
                : node.data.timeoutAt,
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

  function updateNodeStatusWithFix(
    agentType: string,
    agentIndex: number | undefined,
    status: string,
    fixAttempt: number
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
              fixAttempt,
            },
          }
        }
        return node
      })
    )
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
  }, [])

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

  async function handlePause() {
    setActionLoading(true)
    try {
      await pauseSession(sessionId!)
      notify.success('Session paused')
      loadSession()
    } catch (err) {
      notify.error('Failed to pause session')
    } finally {
      setActionLoading(false)
    }
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
    setActionLoading(true)
    try {
      await cancelSession(sessionId!)
      notify.success('Session cancelled')
      loadSession()
    } catch (err) {
      notify.error('Failed to cancel session')
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

  async function handleRunEnhancement() {
    if (!session) return
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
      notify.error(`Failed to start enhancement: ${err}`)
    } finally {
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
    }
    return colors[status] || 'bg-gray-500'
  }

  function getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      awaiting_enhancement: 'Awaiting Enhancement',
      enhancing: 'Enhancing...',
      awaiting_enhancement_review: 'Enhancement Review',
    }
    return labels[status] || status
  }

  const coders = session?.agent_configs.filter(a => a.agent_type === 'coder') || []
  const testers = session?.agent_configs.filter(a => a.agent_type === 'tester') || []

  if (!sessionId) return <Navigate to="/sessions" />

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-900">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-indigo-500 mx-auto mb-4" />
          <p className="text-gray-400">Loading session...</p>
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
                  Iteration {workflowState.iteration || session.current_iteration} / {session.max_iterations}
                </span>
                <span className="text-sm text-gray-500">
                  • {coders.length} coders • {testers.length} testers
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 whitespace-nowrap flex-shrink-0">
            {/* Settings gear */}
            <button
              onClick={() => setShowSettings(true)}
              className="flex items-center justify-center w-9 h-9 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
              title="Session Settings"
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* Reset button for non-running sessions */}
            {(session.status === 'failed' || session.status === 'completed' || session.status === 'cancelled') && (
              <button
                onClick={handleReset}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              >
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                Reset
              </button>
            )}

            {/* Re-finalize button */}
            {(session.status === 'completed' || session.status === 'failed' || session.status === 'awaiting_enhancement') && (
              <button
                onClick={handleRefinalize}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
                title="Re-run finalization with existing code versions"
              >
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Re-finalize
              </button>
            )}

            {session.status === 'created' && (
              <button
                onClick={handleStart}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              >
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                Start
              </button>
            )}

            {session.status === 'running' && (
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

            {(session.status === 'running' || session.status === 'paused') && (
              <button
                onClick={handleCancel}
                disabled={actionLoading}
                className="flex items-center gap-2 px-4 py-2 bg-red-600 hover:bg-red-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
              >
                <Square className="w-4 h-4" />
                Cancel
              </button>
            )}

            {/* Enhancement workflow buttons — Enhance + context-specific actions */}
            {finalResult && !['running', 'enhancing', 'created', 'paused', 'awaiting_enhancement_review'].includes(session.status) && (
              <button
                onClick={handleRunEnhancement}
                disabled={enhancementLoading}
                className="flex items-center gap-1.5 px-3 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-600 text-white rounded-lg transition-colors"
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

            <button
              onClick={() => setShowIntervention(!showIntervention)}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                showIntervention 
                  ? 'bg-indigo-600 text-white' 
                  : 'bg-gray-700 hover:bg-gray-600 text-white'
              }`}
            >
              <MessageSquare className="w-4 h-4" />
              Intervene
            </button>

            {finalResult && (
              <>
                <button
                  onClick={handleRunCode}
                  disabled={executing}
                  className="flex items-center gap-2 px-4 py-2 text-white rounded-lg transition-colors disabled:opacity-50 bg-emerald-600 hover:bg-emerald-700"
                >
                  {executing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                  Run Code
                </button>
                <button
                  onClick={() => setShowCode(!showCode)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                    showCode 
                      ? 'bg-indigo-600 text-white' 
                      : 'bg-gray-700 hover:bg-gray-600 text-white'
                  }`}
                >
                  <Code className="w-4 h-4" />
                  View Result
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* React Flow Graph */}
        <div ref={reactFlowContainerRef} className="flex-1 relative h-full w-full">
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
                const colors: Record<string, string> = {
                  idle: '#4B5563',
                  working: '#3B82F6',
                  done: '#10B981',
                  error: '#EF4444',
                  waiting: '#F59E0B',
                }
                return colors[status] || '#4B5563'
              }}
              maskColor="rgba(0, 0, 0, 0.8)"
            />

            {/* Metrics Panel */}
            <Panel position="top-left">
              <MetricsPanel
                iteration={workflowState.iteration || session.current_iteration}
                maxIterations={session.max_iterations}
                totalTokens={workflowState.totalTokens}
                totalCost={workflowState.totalCost}
                status={session.status}
                criticalIssues={workflowState.criticalIssues}
                seriousIssues={workflowState.seriousIssues}
                codersDone={workflowState.codersDone}
                totalCoders={coders.length}
                testersDone={workflowState.testersDone}
                totalTesters={testers.length}
              />
            </Panel>

            {/* Legend Panel */}
            <Panel position="bottom-left">
              <LegendPanel compact />
            </Panel>

            {/* Phase indicator */}
            {((session.status === 'running' && workflowState.phase) || session.status === 'enhancing') && (
              <Panel position="top-center">
                <div className={`${session.status === 'enhancing' ? 'bg-purple-500/20 border-purple-500/50' : 'bg-blue-500/20 border-blue-500/50'} border rounded-full px-4 py-2 flex items-center gap-2`}>
                  <div className={`w-2 h-2 rounded-full ${session.status === 'enhancing' ? 'bg-purple-500' : 'bg-blue-500'} animate-pulse`} />
                  <span className={`text-sm font-medium ${session.status === 'enhancing' ? 'text-purple-400' : 'text-blue-400'} capitalize`}>
                    {session.status === 'enhancing' ? 'Enhancement' : workflowState.phase} Phase
                  </span>
                </div>
              </Panel>
            )}

            {/* Status hints removed — info is already shown in the header badge */}
            {/* Bridge to report viewport changes to the parent */}
            <ViewportBridge onChange={setFlowViewport} />
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
                  ? { llm_provider: matchingConfig.llm_provider, llm_model: matchingConfig.llm_model, thinking_effort: matchingConfig.thinking_effort, custom_prompt: matchingConfig.custom_prompt, enabled: matchingConfig.enabled }
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
                        ...(isEnhancer ? { enabled: config.enabled } : {}),
                      })
                    } catch (e) {
                      console.error('Failed to update agent config:', e)
                      return
                    }
                    const updatedConfigs = session.agent_configs.map(c =>
                      c.id === matchingConfig.id
                        ? { ...c, llm_provider: config.provider, llm_model: config.model, thinking_effort: effortValue, custom_prompt: config.instruction || undefined, enabled: isEnhancer ? config.enabled : c.enabled }
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
                      })
                      // Save custom_prompt + enabled via update
                      if (config.instruction || (isEnhancer && !config.enabled)) {
                        await updateAgentConfig(session.id, newConfig.id, {
                          custom_prompt: config.instruction || null,
                          ...(isEnhancer ? { enabled: config.enabled } : {}),
                        })
                        newConfig.custom_prompt = config.instruction || null
                        if (isEnhancer) newConfig.enabled = config.enabled
                      }
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
                    }
                  }
                }}
              />
            )
          })()}

          {/* Click hint */}
          {!selectedNode && session.status !== 'running' && session.status !== 'enhancing' && (
            <div className="absolute bottom-20 left-1/2 transform -translate-x-1/2 pointer-events-none">
              <div className="bg-gray-800/80 backdrop-blur-sm border border-gray-700 rounded-lg px-4 py-2 flex items-center gap-2">
                <Eye className="w-4 h-4 text-gray-400" />
                <span className="text-sm text-gray-400">Click on an agent to view details</span>
              </div>
            </div>
          )}
        </div>

        {/* Side panels */}
        {showIntervention && (
          <div className="w-96 bg-gray-800 border-l border-gray-700 flex flex-col">
            <div className="p-4 border-b border-gray-700 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">Intervention</h3>
              <button
                onClick={() => setShowIntervention(false)}
                className="p-1 hover:bg-gray-700 rounded"
              >
                <X className="w-5 h-5 text-gray-400" />
              </button>
            </div>
            <div className="flex-1 p-4">
              <p className="text-sm text-gray-400 mb-4">
                Add comments or instructions for the agents. These will be included in the next iteration.
              </p>
              <textarea
                value={interventionText}
                onChange={(e) => setInterventionText(e.target.value)}
                placeholder="Enter your intervention message..."
                className="w-full h-40 px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              />
              <button
                className="mt-4 w-full flex items-center justify-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50"
                disabled={!interventionText.trim()}
                onClick={async () => {
                  if (!interventionText.trim()) return
                  try {
                    await createIntervention(sessionId!, {
                      intervention_type: 'comment',
                      content: interventionText.trim(),
                    })
                    notify.success('Intervention saved — will be included in the next iteration')
                    setInterventionText('')
                  } catch (err) {
                    notify.error('Failed to save intervention')
                  }
                }}
              >
                <Send className="w-4 h-4" />
                Send Intervention
              </button>
            </div>
          </div>
        )}

        {/* Enhancement Review Panel */}
        {showEnhancementReview && (
          <div className="w-[500px] bg-gray-800 border-l border-gray-700 flex flex-col">
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
              <div className="flex items-center gap-2">
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
                </h4>
                <pre className="bg-gray-900 p-4 rounded-lg overflow-x-auto text-sm text-gray-300 font-mono max-h-96">
                  {finalResult.final_code}
                </pre>
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

        {/* Detail panel for selected node */}
        {selectedNode && selectedNodeData && !showCode && !showIntervention && !showExecution && !showBrowserPreview && !showEnhancementReview && (
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
          />
        )}
      </div>

      {/* Specifications Dialog — opened when clicking the Specification node in the graph */}
      <SpecificationsDialog
        isOpen={showSpecificationsDialog}
        onClose={() => setShowSpecificationsDialog(false)}
        sessionId={sessionId!}
        specification={session.specification || ''}
        initialCode={session.initial_code || ''}
        attachments={session.attachments || []}
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
                  await updateSession(session.id, {
                    language: fd.get('language') as string,
                    max_iterations: Number(fd.get('max_iterations')),
                    enable_code_execution: fd.get('enable_code_execution') === 'on',
                    execution_timeout: Number(fd.get('execution_timeout')),
                    max_fix_attempts: Number(fd.get('max_fix_attempts')),
                    auto_install_deps: fd.get('auto_install_deps') === 'on',
                    agent_timeout: Number(fd.get('agent_timeout')),
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
              className="p-5 space-y-5"
            >
              {/* General section */}
              <div>
                <h3 className="text-xs font-semibold text-indigo-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Code2 className="w-3.5 h-3.5" />
                  General
                </h3>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Language</label>
                    <select
                      name="language"
                      defaultValue={session.language}
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
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1">Max Tokens</label>
                    {(() => {
                      // Use MAX across agents: each provider clamps to its own limit internally
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
              </div>

              {/* Code Execution section */}
              <div>
                <h3 className="text-xs font-semibold text-green-400 uppercase tracking-wider mb-3 flex items-center gap-2">
                  <Terminal className="w-3.5 h-3.5" />
                  Code Execution
                </h3>
                <div className="space-y-3">
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
                  <div className="grid grid-cols-2 gap-3">
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
                      <p className="text-xs text-indigo-400/70 mt-0.5">Code execution: 10–300s</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-300 mb-1">Agent Timeout (sec)</label>
                      <input
                        name="agent_timeout"
                        type="number"
                        min={60}
                        max={1800}
                        defaultValue={session.agent_timeout ?? 300}
                        className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-white text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
                      />
                      <p className="text-xs text-indigo-400/70 mt-0.5">LLM call: 60–1800s</p>
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
                </div>
              </div>

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
