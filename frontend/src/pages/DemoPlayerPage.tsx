/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * DemoPlayerPage — replays a pre-recorded multi-agent session timeline.
 *
 * Reuses the real graph components (`AgentNode`, `ArtifactEdge`,
 * `MetricsPanel`) and the same dark theme so the demo *feels* like a real
 * session, not a slideshow. State comes from `useTimelinePlayer`, driven by
 * a clock instead of WebSocket events.
 *
 * URL: /demo/:templateId
 *
 * The DOM tree is intentionally lighter than SessionDetailPage — no detail
 * panel, no interventions, no per-coder DetailPanel. Just the live graph and
 * the metrics panel.
 */

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import {
  ReactFlow,
  Background,
  Controls,
  ReactFlowProvider,
  MarkerType,
  useViewport,
  useReactFlow,
  type NodeTypes,
  type EdgeTypes,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
  Play,
  Pause,
  RotateCcw,
  ChevronLeft,
  Loader2,
  Rocket,
  Eye,
  Network,
  PartyPopper,
  FileText,
  ChevronUp,
  ChevronDown,
  Zap,
  ExternalLink,
} from 'lucide-react'
import notify from '../components/common/StyledToast'
import ConfirmDialog from '../components/common/ConfirmDialog'
import { AgentNode, ArtifactEdge, MetricsPanel, type AgentNodeData } from '../components/graph'
import {
  useTimelinePlayer,
  agentKey,
  type DemoTimeline,
  type DemoAgentState,
  type DemoPlayerState,
  type TimelineAnnotation,
  type NarrationChapter,
} from '../hooks/useTimelinePlayer'
import { createSession } from '../services/api'
// Улучшатели#4 P1·L — responsive layout <900px.
import { useMediaQuery } from '../hooks/useMediaQuery'
// КАО#R14-FIX-01 (HIGH) — Demo de-auth: gate "Try it yourself" on auth state.
import { useAuthStore } from '../stores/authStore'

// Улучшатели#4 P1·S — speed presets aligned with DemosPage "60× speed" promise.
const SPEEDS = [0.5, 1, 2, 4, 8, 16, 60]

/** MURMUR-DEMO — open self-contained HTML in a new browser tab: a real page
 *  load (blob URL) so CDN scripts run and the app gets the full viewport.
 *  Mirrors SessionDetailPage's "Open in new tab" so the demo's final result
 *  opens in a full separate window exactly like a real session's. */
function openHtmlInNewWindow(code: string) {
  // Strip CSP meta tags so CDN scripts (e.g. three.js) load in the new tab.
  const html = code.replace(
    /<meta\s+http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi,
    '<!-- CSP meta removed by CodeForge -->',
  )
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank')
  if (!win) {
    URL.revokeObjectURL(url)
    notify.error('Popup blocked — please allow popups for this site')
    return
  }
  window.setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/** Derive a human-friendly status sentence from current player state.
 *  Used by <StatusPlaque /> to narrate what's happening without requiring
 *  the timeline JSON to carry explicit annotations. */
function deriveStatus(timeline: DemoTimeline, state: DemoPlayerState): { title: string; body: string; icon: string } {
  const { workflow, agents, finished, clock } = state
  if (clock < 0.1 && workflow.status === 'idle') {
    return {
      title: 'Demo ready to play',
      body: 'Press ▶ to start the playback. Watch how a small team of AI agents builds and refines the code together.',
      icon: '🎬',
    }
  }
  if (finished || workflow.status === 'completed') {
    return {
      title: 'Workflow complete',
      body: 'All agents finished. Open the Final result tab to interact with the generated code.',
      icon: '🎉',
    }
  }
  // Find first agent currently working (priority: enhancer → finalizer → summarizer → tester → coder).
  const states = Object.entries(agents)
  const working = (prefix: string) => states.find(([k, s]) => k.startsWith(prefix) && s.status === 'working')
  if (working('enhancer_summary')) {
    return {
      title: 'Enh. Summarizer — merging suggestions',
      body: "Aggregates the three specialists' suggestions into one curated list you can approve or reject item by item.",
      icon: '✨',
    }
  }
  if (working('enhancer_design') || working('enhancer_func') || working('enhancer_security')) {
    return {
      title: 'Enhancement — second pass',
      body: 'Design (UX & layout), Functionality (perf & correctness), and Security (safety & edge cases) review the final code in parallel and propose targeted improvements.',
      icon: '🎨',
    }
  }
  if (working('finalizer')) {
    return {
      title: 'Finalizer — picking the winner',
      body: "Comparing both Coders' final versions side by side and writing a short README explaining the choice.",
      icon: '🏆',
    }
  }
  if (working('summarizer')) {
    return {
      title: 'Summarizer — ranking issues',
      body: "Reading every Tester's audit and writing a single prioritised brief the Coders will read next iteration.",
      icon: '📊',
    }
  }
  if (working('tester')) {
    return {
      title: 'Testers — auditing the code',
      body: 'Each Tester reviews every Coder version for spec compliance, correctness, and code quality. Audits drive the next iteration.',
      icon: '🔍',
    }
  }
  if (working('coder')) {
    const codersTotal = timeline.coders.length
    return {
      title: codersTotal > 1 ? 'Coders writing in parallel' : 'Coder writing the code',
      body: codersTotal > 1
        ? `${codersTotal} models take independent approaches. You'll see streaming text appear on each node as the LLM generates.`
        : 'Streaming text appears live on the Coder node as the LLM generates.',
      icon: '🧑‍💻',
    }
  }
  return {
    title: 'Pipeline in progress',
    body: 'Watch the graph as agents pass artifacts down the chain: Spec → Coders → Testers → Summarizer → Finalizer → Final Code.',
    icon: '⚙️',
  }
}

/** Find the latest annotation whose [at, at + durationS] window includes `clock`.
 *  Returns null if no annotation is currently active. */
function pickAnnotation(annotations: TimelineAnnotation[] | undefined, clock: number): TimelineAnnotation | null {
  if (!annotations || !annotations.length) return null
  // Iterate in reverse so the LATEST overlapping annotation wins.
  for (let i = annotations.length - 1; i >= 0; i--) {
    const a = annotations[i]
    if (clock >= a.at && clock < a.at + a.durationS) {
      return a
    }
  }
  return null
}

// Build the node + edge graph for the demo timeline. The layout mirrors the
// real session: Spec → Coders → Testers → Summarizer → Finalizer → Final.
function buildGraph(tl: DemoTimeline, agents: Record<string, DemoAgentState>, workflowIter: number = 1) {
  const nodes: Node<AgentNodeData>[] = []
  const edges: Edge[] = []
  const COL_X = [220, 500, 800, 1100, 1380, 1660]
  // Invisible spacer node to the LEFT of the Spec — gives fitView a tiny
  // bbox extension on the left so the Spec node sits just clear of the
  // Tour plaque (≈4× tighter than before per user feedback).
  nodes.push({
    id: '_pad_left',
    type: 'agent',
    position: { x: COL_X[0] - 135, y: 240 },
    draggable: false,
    selectable: false,
    style: { opacity: 0, pointerEvents: 'none' },
    data: { label: '', agentType: 'input', status: 'idle' },
  })
  // Spec
  nodes.push({
    id: 'spec',
    type: 'agent',
    position: { x: COL_X[0], y: 240 },
    draggable: false,
    data: {
      label: 'Specification',
      agentType: 'input',
      status: 'done',
    },
  })
  // Coders
  tl.coders.forEach((c, i) => {
    const k = agentKey('coder', i)
    const a = agents[k]
    nodes.push({
      id: k,
      type: 'agent',
      position: { x: COL_X[1], y: 80 + i * 200 },
      draggable: false,
      data: {
        label: `Coder ${i + 1}`,
        agentType: 'coder',
        agentIndex: i,
        llmModel: c.model,
        status: mapStatus(a?.status, a?.isStreaming),
        streamingContent: a?.streamingContent,
        isStreaming: a?.isStreaming,
        tokensUsed: a?.tokensUsed,
        costUsd: a?.costUsd,
        activeSince: a?.startedAt ?? undefined,
        // Use the live workflow.iteration so the Iter badge ticks 1→2→3...
        // when the timeline fires iteration_started events.
        iteration: workflowIter,
      },
    })
    edges.push({
      id: `spec-coder${i}`,
      source: 'spec',
      target: k,
      type: 'artifact',
      data: { artifactType: 'code', label: 'Spec', animated: a?.isStreaming },
    })
  })
  // Testers
  tl.testers.forEach((c, i) => {
    const k = agentKey('tester', i)
    const a = agents[k]
    nodes.push({
      id: k,
      type: 'agent',
      position: { x: COL_X[2], y: 80 + i * 200 },
      draggable: false,
      data: {
        label: `Tester ${i + 1}`,
        agentType: 'tester',
        agentIndex: i,
        llmModel: c.model,
        status: mapStatus(a?.status, a?.isStreaming),
        streamingContent: a?.streamingContent,
        isStreaming: a?.isStreaming,
        tokensUsed: a?.tokensUsed,
        costUsd: a?.costUsd,
        issuesFound: a?.issuesFound ?? undefined,
        activeSince: a?.startedAt ?? undefined,
        // Use the live workflow.iteration so the Iter badge ticks 1→2→3...
        // when the timeline fires iteration_started events.
        iteration: workflowIter,
      },
    })
    // each coder feeds each tester
    tl.coders.forEach((_, ci) => {
      edges.push({
        id: `coder${ci}-tester${i}`,
        source: agentKey('coder', ci),
        target: k,
        type: 'artifact',
        data: { artifactType: 'code', animated: a?.isStreaming },
      })
    })
  })
  // Summarizer
  {
    const k = agentKey('summarizer', 0)
    const a = agents[k]
    nodes.push({
      id: k,
      type: 'agent',
      position: { x: COL_X[3], y: 240 },
      draggable: false,
      data: {
        label: 'Summarizer',
        agentType: 'summarizer',
        llmModel: tl.summarizer?.model,
        status: mapStatus(a?.status, a?.isStreaming),
        streamingContent: a?.streamingContent,
        isStreaming: a?.isStreaming,
        tokensUsed: a?.tokensUsed,
        costUsd: a?.costUsd,
        activeSince: a?.startedAt ?? undefined,
        // Use the live workflow.iteration so the Iter badge ticks 1→2→3...
        // when the timeline fires iteration_started events.
        iteration: workflowIter,
      },
    })
    tl.testers.forEach((_, ti) => {
      edges.push({
        id: `tester${ti}-sum`,
        source: agentKey('tester', ti),
        target: k,
        type: 'artifact',
        data: { artifactType: 'audit', animated: a?.isStreaming },
      })
    })
  }
  // Finalizer
  {
    const k = agentKey('finalizer', 0)
    const a = agents[k]
    nodes.push({
      id: k,
      type: 'agent',
      position: { x: COL_X[4], y: 240 },
      draggable: false,
      data: {
        label: 'Finalizer',
        agentType: 'finalizer',
        llmModel: tl.finalizer?.model,
        status: mapStatus(a?.status, a?.isStreaming),
        streamingContent: a?.streamingContent,
        isStreaming: a?.isStreaming,
        tokensUsed: a?.tokensUsed,
        costUsd: a?.costUsd,
        activeSince: a?.startedAt ?? undefined,
        // Use the live workflow.iteration so the Iter badge ticks 1→2→3...
        // when the timeline fires iteration_started events.
        iteration: workflowIter,
      },
    })
    edges.push({
      id: 'sum-final',
      source: agentKey('summarizer', 0),
      target: agentKey('finalizer', 0),
      type: 'artifact',
      data: { artifactType: 'summary', animated: a?.isStreaming },
    })
  }
  // Final output
  {
    const finalA = agents[agentKey('finalizer', 0)]
    const done = finalA?.status === 'done'
    nodes.push({
      id: 'output',
      type: 'agent',
      position: { x: COL_X[5], y: 240 },
      draggable: false,
      data: {
        label: 'Final Code',
        agentType: 'output',
        status: done ? 'done' : 'idle',
      },
    })
    edges.push({
      id: 'final-out',
      source: agentKey('finalizer', 0),
      target: 'output',
      type: 'artifact',
      data: { artifactType: 'final', animated: !!finalA?.isStreaming, hasArtifact: done },
    })
  }

  // Enhancers (Design / Functionality / Security) — bottom row.
  // Only rendered when the timeline carries enhancer events (so demos without
  // an Enhancement phase don't show empty nodes). Detection: any agent state
  // for `enhancer_*` key OR they exist in the agents map already (player
  // creates a key on first event). Layout: below the main row, in a sub-grid.
  const hasEnhancerRun =
    !!agents[agentKey('enhancer_design', 0)] ||
    !!agents[agentKey('enhancer_func', 0)] ||
    !!agents[agentKey('enhancer_security', 0)] ||
    !!agents[agentKey('enhancer_summary', 0)] ||
    !!tl.events.some(e => e.agent_type && e.agent_type.startsWith('enhancer_'))
  if (hasEnhancerRun) {
    // Push enhancers well below the main row so the bottom edge of the main
    // group frames doesn't visually touch the top edge of the enhancement
    // frame. Main row y range ≈ 80..480 → 700 leaves ~220px gap.
    const enhY = 720
    const trio: { type: 'enhancer_design' | 'enhancer_func' | 'enhancer_security'; label: string; col: number }[] = [
      { type: 'enhancer_design', label: 'Design', col: 2 },
      { type: 'enhancer_func', label: 'Functionality', col: 3 },
      { type: 'enhancer_security', label: 'Security', col: 4 },
    ]
    for (const { type, label, col } of trio) {
      const k = agentKey(type, 0)
      const a = agents[k]
      nodes.push({
        id: k,
        type: 'agent',
        position: { x: COL_X[col], y: enhY },
        draggable: false,
        data: {
          label,
          agentType: type as AgentNodeData['agentType'],
          status: mapStatus(a?.status, a?.isStreaming),
          streamingContent: a?.streamingContent,
          isStreaming: a?.isStreaming,
          tokensUsed: a?.tokensUsed,
          costUsd: a?.costUsd,
          activeSince: a?.startedAt ?? undefined,
          iteration: 2,
        },
      })
      edges.push({
        id: `output-${type}`,
        source: 'output',
        target: k,
        type: 'artifact',
        data: { artifactType: 'final', animated: !!a?.isStreaming },
      })
    }
    // Enh. Summarizer aggregates the trio
    {
      const k = agentKey('enhancer_summary', 0)
      const a = agents[k]
      nodes.push({
        id: k,
        type: 'agent',
        position: { x: COL_X[1], y: enhY },
        draggable: false,
        data: {
          label: 'Enh. Summarizer',
          agentType: 'enhancer_summary',
          status: mapStatus(a?.status, a?.isStreaming),
          streamingContent: a?.streamingContent,
          isStreaming: a?.isStreaming,
          tokensUsed: a?.tokensUsed,
          costUsd: a?.costUsd,
          activeSince: a?.startedAt ?? undefined,
          iteration: 2,
        },
      })
      for (const { type } of trio) {
        edges.push({
          id: `${type}-esum`,
          source: agentKey(type, 0),
          target: k,
          type: 'artifact',
          data: { artifactType: 'audit', animated: !!a?.isStreaming },
        })
      }
      // Feedback edge from Enh. Summarizer back to coders — visualizes the
      // "new session spawns from enhanced spec" idea.
      tl.coders.forEach((_, ci) => {
        edges.push({
          id: `esum-coder${ci}`,
          source: k,
          target: agentKey('coder', ci),
          type: 'artifact',
          data: { artifactType: 'summary', label: 'Enh. brief', animated: a?.status === 'done' && !a?.isStreaming, hasArtifact: a?.status === 'done' },
        })
      })
    }
  }

  return { nodes, edges }
}

function mapStatus(s: DemoAgentState['status'] | undefined, isStreaming: boolean | undefined): AgentNodeData['status'] {
  if (s === 'done') return 'done'
  if (s === 'working' || isStreaming) return 'working'
  return 'idle'
}

const nodeTypes: NodeTypes = { agent: AgentNode as any }
const edgeTypes: EdgeTypes = { artifact: ArtifactEdge as any }

export default function DemoPlayerPage() {
  const { templateId } = useParams<{ templateId: string }>()
  const navigate = useNavigate()
  // КАО W4-CFIX-03: `?startAtChapter=N` URL param lets users share a deep
  // link into a specific narration chapter. Read once on mount; the seek
  // is applied AFTER the timeline loads (otherwise seekTo has no timeline
  // to anchor against).
  const [searchParams] = useSearchParams()
  const startAtChapterParam = searchParams.get('startAtChapter')
  const [timeline, setTimeline] = useState<DemoTimeline | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'graph' | 'final'>('graph')
  const [creatingSession, setCreatingSession] = useState(false)
  // Spec card "shutter" — auto-shown during the Specification chapter, can
  // be manually re-opened from any chapter by clicking the Spec node.
  const [specPanelOpen, setSpecPanelOpen] = useState(false)
  const autoSwitchedRef = useRef(false)
  // Улучшатели#6 P1·M — "Try it yourself" confirmation dialog state.
  const [tryConfirmOpen, setTryConfirmOpen] = useState(false)
  // Улучшатели#3 P1·M — "What next" CTA dismissal + copy-link feedback state.
  const [ctaDismissed, setCtaDismissed] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  // Улучшатели#4 P1·L — responsive layout <900px.
  // Below the md breakpoint (Tailwind's md = 768px), the 300px sidebar +
  // fixed 1-row top bar + InteractivePausePanel's `min(34rem, calc(100vw - 340px))`
  // width all go negative or wrap badly. We use 767.98px to match Tailwind's
  // md: utility (max-width: 767.98px = below md).
  const isMobile = useMediaQuery('(max-width: 767.98px)')
  // Mobile-only: collapsible "Tour" drawer at the bottom of the graph area.
  // Replaces the left aside (which is hidden on mobile to free up horizontal
  // space — the graph needs every pixel below 900px to stay legible).
  const [mobileTourOpen, setMobileTourOpen] = useState(false)

  useEffect(() => {
    if (!templateId) return
    let cancelled = false
    fetch(`/demo-templates/${templateId}.json`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: DemoTimeline) => {
        if (!cancelled) setTimeline(d)
      })
      .catch(err => {
        if (!cancelled) setError(err?.message || 'Failed to load timeline')
      })
    return () => {
      cancelled = true
    }
  }, [templateId])

  const { state, play, pause, resume, continueChapter, restart, setSpeed, seekTo } = useTimelinePlayer({
    timeline,
    autoPlay: true,
  })

  // Auto-switch is disabled by design: the user wants the demo to STOP at
  // the end of the enhancement cycle, not to auto-launch the final code in
  // the iframe. The Final result tab remains a manual click — that is the
  // "button" that runs the final code.
  // (The autoSwitchedRef is kept around as a no-op anchor for future use.)

  // Reset to the Live graph tab on restart so the user actually sees the
  // replay instead of staring at a stale "Final result" panel.
  useEffect(() => {
    if (state.clock === 0) {
      autoSwitchedRef.current = false
      setTab('graph')
    }
  }, [state.clock])

  // КАО W4-CFIX-03: apply `?startAtChapter=N` once the timeline is loaded.
  // The seek MUST happen after the timeline is in the player's hook state
  // (the hook resolves `timelineRef.current` on mount). Guard with a ref so
  // re-renders don't re-seek to the same chapter.
  const startAtSeekedRef = useRef(false)
  useEffect(() => {
    if (startAtSeekedRef.current) return
    if (!timeline || !startAtChapterParam) return
    const idx = parseInt(startAtChapterParam, 10)
    const chapters = timeline.narration_chapters ?? []
    if (!Number.isFinite(idx) || idx < 0 || idx >= chapters.length) return
    const target = chapters[idx]?.t_start
    if (typeof target !== 'number' || target <= 0) return
    startAtSeekedRef.current = true
    // Defer one tick so the player's rAF loop initialises before we seek.
    const t = setTimeout(() => seekTo(target), 50)
    return () => clearTimeout(t)
  }, [timeline, startAtChapterParam, seekTo])

  const { nodes, edges } = useMemo(() => {
    if (!timeline) return { nodes: [], edges: [] }
    return buildGraph(timeline, state.agents, Math.max(1, state.workflow.iteration))
  }, [timeline, state.agents, state.workflow.iteration])

  // Улучшатели#1 P1·M — keyboard support for the player.
  // Space=play/pause, ←/→=seek ±5s, Home=restart, End=seek-to-end.
  // Ignored while typing in inputs/textareas/contenteditable so it doesn't
  // hijack the confirm dialog or future search boxes.
  useEffect(() => {
    if (!timeline) return
    const isTypingTarget = (el: EventTarget | null): boolean => {
      const node = el as HTMLElement | null
      if (!node) return false
      const tag = node.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
      if (node.isContentEditable) return true
      return false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      // Don't fight the ConfirmDialog's own ESC/focus trap.
      if (tryConfirmOpen) return
      // КАО#R1-06 — while the full-screen CodePreviewModal is open, its buttons
      // are not typing targets, so Space/←/→/Home/End would silently drive the
      // hidden background timeline (Home even restarts it). Suppress here.
      if (typeof document !== 'undefined' && document.querySelector('[data-code-preview-modal]')) return
      switch (e.key) {
        case ' ':
        case 'Spacebar':
          e.preventDefault()
          if (state.playing) pause()
          else play()
          break
        case 'ArrowLeft':
          e.preventDefault()
          seekTo(Math.max(0, state.clock - 5))
          break
        case 'ArrowRight':
          e.preventDefault()
          seekTo(Math.min(timeline.duration_seconds, state.clock + 5))
          break
        case 'Home':
          e.preventDefault()
          restart()
          break
        case 'End':
          e.preventDefault()
          seekTo(timeline.duration_seconds)
          break
        default:
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [timeline, state.playing, state.clock, tryConfirmOpen, play, pause, seekTo, restart])

  // КАО#R14-FIX-01 (HIGH) — Demo de-auth: anonymous viewers may reach the
  // demo page, but creating a real session requires auth. Read isAuthenticated
  // here (not in deps below — Zustand subscription is fine).
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)

  // Улучшатели#6 P1·M — Try-it-yourself confirm dialog.
  // `handleTryYourself` now OPENS a confirmation modal; the actual session
  // creation runs only after the user clicks Confirm in `doCreateSession`.
  // КАО#R14-FIX-01 (HIGH) — if anon, redirect to /login (with return path)
  // instead of opening the confirm dialog and 401-ing on submit.
  const handleTryYourself = useCallback(() => {
    if (!timeline) return
    if (!isAuthenticated) {
      navigate('/login', { state: { from: window.location.pathname } })
      return
    }
    setTryConfirmOpen(true)
  }, [timeline, isAuthenticated, navigate])

  const doCreateSession = useCallback(async () => {
    if (!timeline) return
    setCreatingSession(true)
    try {
      const session = await createSession({
        name: timeline.name,
        specification: timeline.spec,
        language: timeline.language,
        max_iterations: 3,
        num_coders: Math.max(1, timeline.coders.length),
        num_testers: Math.max(1, timeline.testers.length),
      })
      notify.success('Session created — give it a moment to start')
      setTryConfirmOpen(false)
      navigate(`/sessions/${session.id}`)
    } catch (err: any) {
      notify.error(err?.message || 'Failed to create session')
    } finally {
      setCreatingSession(false)
    }
  }, [timeline, navigate])

  // Улучшатели#3 P1·M — reset CTA dismissal when the demo restarts.
  useEffect(() => {
    if (state.clock === 0) {
      setCtaDismissed(false)
      setLinkCopied(false)
    }
  }, [state.clock])

  // Улучшатели#4 P1·L — auto-open the mobile Tour drawer when the player
  // pauses at a chapter boundary. Otherwise the user sees a small badge and
  // doesn't realize a Continue button exists.
  useEffect(() => {
    if (isMobile && state.pausedForChapter) setMobileTourOpen(true)
  }, [isMobile, state.pausedForChapter])

  // Wrap setTab so manually switching tabs dismisses the post-demo CTA card.
  const handleTabChange = useCallback((next: 'graph' | 'final') => {
    setTab(next)
    setCtaDismissed(true)
  }, [])

  const copyDemoLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 1800)
    } catch {
      notify.error('Could not copy link to clipboard')
    }
  }, [])

  if (error) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8">
        <h1 className="text-2xl font-bold text-white mb-3">Demo unavailable</h1>
        <p className="text-gray-400 mb-4">{error}</p>
        <Link to="/demos" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg">
          Back to demos
        </Link>
      </div>
    )
  }
  if (!timeline) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-indigo-400 animate-spin" />
      </div>
    )
  }

  const progressPct = Math.min(100, (state.clock / timeline.duration_seconds) * 100)

  return (
    <div className="flex-1 flex flex-col bg-gray-900 overflow-hidden">
      {/* Top bar — Улучшатели#4 P1·L: stacks into 2 rows on mobile so the
          title/description aren't squeezed by the "Try it yourself" button. */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-2 md:gap-0 px-4 py-3 border-b border-gray-800 bg-gray-900/80 backdrop-blur-sm">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/demos"
            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            title="Back to demos"
          >
            <ChevronLeft className="w-5 h-5" />
          </Link>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-2xl leading-none">{timeline.thumbnail || '✨'}</span>
              <h1 className="text-lg font-bold text-white truncate">{timeline.name}</h1>
              <span className="px-2 py-0.5 text-[10px] uppercase tracking-wider bg-indigo-500/20 text-indigo-300 rounded-full font-semibold">
                Demo · Pre-recorded
              </span>
            </div>
            <p className="text-xs text-gray-400 truncate max-w-2xl">{timeline.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={handleTryYourself}
            disabled={creatingSession}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-600 text-white text-sm font-medium rounded-lg transition-colors"
            title="Create a real session from this spec"
          >
            {creatingSession ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Rocket className="w-4 h-4" />
            )}
            Try it yourself
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-4 pt-2 border-b border-gray-800 bg-gray-900">
        {/* Улучшатели#3 P1·M — handleTabChange dismisses the post-demo CTA. */}
        <TabButton active={tab === 'graph'} onClick={() => handleTabChange('graph')} icon={<Network className="w-4 h-4" />}>
          Live graph
        </TabButton>
        <TabButton
          active={tab === 'final'}
          onClick={() => handleTabChange('final')}
          icon={<Eye className="w-4 h-4" />}
          badge={state.finished}
        >
          Final result
        </TabButton>
      </div>

      {/* Body — two-column layout when on Live graph tab with chapters:
          [Left sidebar: Spec + Narration column] [Graph area]
          Улучшатели#4 P1·L: on mobile (<md), the aside is hidden entirely and
          the chapter narration moves into a bottom-anchored drawer (see
          MobileTourDrawer below) so the graph gets the full viewport width. */}
      <div className="flex-1 flex min-h-0">
        {/* Left sidebar — only on Live graph tab, desktop only. */}
        {tab === 'graph' && !isMobile && (
          <aside
            className="w-[300px] flex-shrink-0 border-r border-gray-800 bg-gray-900 flex flex-col min-h-0 relative"
            style={{ zIndex: 20 }}
          >
            {/* Tour plaque ON TOP — visually higher than graph's group labels
                (CODERS / TESTERS / ENHANCERS badges sit at the top of dashed
                frames). With plaque on top, the entire sidebar column starts
                with narration content, so nothing peeks above it. */}
            {timeline.narration_chapters && timeline.narration_chapters.length > 0 && state.currentChapter && (
              <ChapterSidePanel
                chapter={state.currentChapter}
                paused={state.pausedForChapter}
                onContinue={continueChapter}
                onReplay={restart}
                isLast={!!(timeline.narration_chapters && timeline.narration_chapters[timeline.narration_chapters.length - 1]?.id === state.currentChapter.id)}
                simplifiedCode={timeline.simplified_code}
                finalCode={timeline.final_code}
                onTryYourself={handleTryYourself}
                creatingSession={creatingSession}
              />
            )}
            {/* Specification card moved out of the sidebar: it now slides in
                as a floating overlay anchored to the top-left of the graph
                area (right next to the upper part of the plaque). That keeps
                the sidebar a clean strip for the plaque only, and the spec
                appears over the graph instead of "under" the plaque. */}
          </aside>
        )}
      <div className="flex-1 relative min-h-0 overflow-hidden">
        {tab === 'graph' ? (
          <ReactFlowProvider>
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              edgeTypes={edgeTypes}
              fitView
              fitViewOptions={{ padding: 0.55, includeHiddenNodes: false }}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={true}
              onNodeClick={(_event: any, node: any) => {
                // Spec node click toggles the sidebar Specification shutter
                if (node?.id === 'spec') setSpecPanelOpen(o => !o)
              }}
              defaultEdgeOptions={{
                markerEnd: { type: MarkerType.ArrowClosed, color: '#4B5563' },
              }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#1f2937" gap={20} />
              <Controls showInteractive={false} className="bg-gray-800 border-gray-700" />
            </ReactFlow>

            {/* Group frames overlay (dashed CODERS/TESTERS/ENHANCERS labels)
                — must live inside ReactFlowProvider so useViewport works. */}
            <DemoGroupFrames nodes={nodes} />

            {/* Camera-focus bridge: listens to camera_focus timeline events
                and pans the RF viewport to the target node or group. */}
            <CameraFocusBridge focus={state.cameraFocus} nodes={nodes} />

            {/* Compact metrics card — single small chip in the corner.
                The full MetricsPanel is too large for the demo player where
                screen real estate is precious (banner above + nodes below). */}
            <div className="absolute top-3 right-3 z-10 bg-gray-800/90 backdrop-blur-sm border border-gray-700 rounded-lg px-3 py-2 shadow-lg">
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-400 uppercase tracking-wide text-[10px]">Iter</span>
                  <span className="font-semibold text-white">{state.workflow.iteration}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Zap className="w-3 h-3 text-yellow-400" />
                  <span className="font-semibold text-white tabular-nums">{state.workflow.totalTokens.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-green-400 text-[11px]">$</span>
                  <span className="font-semibold text-white tabular-nums">{state.workflow.totalCost.toFixed(2)}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-gray-400 uppercase tracking-wide text-[10px]">Agents</span>
                  <span className="font-semibold text-white tabular-nums">
                    {/* КАО#R1-01 — count done coder/tester NODES vs the real node
                        count. The old numerator accumulated across iterations and the
                        old denominator multiplied testers×coders, so multi-iteration
                        demos showed impossible ratios (e.g. 11/6). This derives both
                        sides from the current graph and never overflows. */}
                    {(() => {
                      const total = timeline.coders.length + timeline.testers.length
                      const done = Object.entries(state.agents).filter(
                        ([k, a]) => (k.startsWith('coder_') || k.startsWith('tester_')) && a.status === 'done',
                      ).length
                      return `${Math.min(done, total)}/${total}`
                    })()}
                  </span>
                </div>
              </div>
            </div>

            {/* Specification overlay — slides in from the left edge of the
                graph area (right next to the upper part of the plaque).
                Visible during the Specification chapter, or when the user
                clicks the Spec node. Floats above nodes (z-30) but only
                occupies the upper-left corner of the graph viewport, so the
                rest of the graph stays free. */}
            {(() => {
              const inSpecChapter = state.currentChapter?.id === 'specification'
              const shouldShow = inSpecChapter || specPanelOpen
              return (
                <div
                  className="absolute top-3 left-3 pointer-events-none transition-all duration-300 ease-in-out"
                  style={{
                    // Stretch across the empty top strip of the graph area:
                    // starts right next to the upper part of the plaque
                    // (left:12), ends before the Iter/Tokens/$ metrics chip
                    // on the right (right:260). Bounded height keeps it
                    // strictly above the node rows.
                    right: 260,
                    maxHeight: 320,
                    zIndex: 30,
                    opacity: shouldShow ? 1 : 0,
                    transform: shouldShow ? 'translateY(0)' : 'translateY(-8px)',
                  }}
                  aria-hidden={!shouldShow}
                >
                  {/* КАО#R1-05 — when hidden (opacity 0) the inner subtree must not
                      keep pointer-events:auto, otherwise the invisible spec panel
                      swallows clicks/drag/hover over the top-left graph strip. */}
                  <div className={`${shouldShow ? 'pointer-events-auto' : 'pointer-events-none'} shadow-2xl shadow-black/60 rounded-lg`}>
                    <SidebarSpec
                      spec={timeline.spec}
                      onManualClose={!inSpecChapter ? () => setSpecPanelOpen(false) : undefined}
                      templateId={templateId}
                    />
                  </div>
                </div>
              )
            })()}

            {/* Legacy auto-plaque only when no chapters defined.
                (The chapter banner above the graph handles the chapter case.) */}
            {(!timeline.narration_chapters || timeline.narration_chapters.length === 0) && (
              <StatusPlaque timeline={timeline} state={state} />
            )}

            {/* Interactive pause: when the timeline triggers a pause point,
                replace the auto-plaque with a CTA card so the user can run
                the code, continue, or try-it-yourself. */}
            {state.interactivePauseKey && (
              <InteractivePausePanel
                pauseKey={state.interactivePauseKey}
                simplifiedCode={timeline.simplified_code}
                finalCode={timeline.final_code}
                onResume={resume}
                onTryYourself={handleTryYourself}
                creatingSession={creatingSession}
                isMobile={isMobile}
              />
            )}

            {/* Confetti overlay on completion */}
            {state.finished && <Confetti />}

            {/* Улучшатели#3 P1·M — "What next" CTA after demo ends.
                Sits top-center in the graph area (NOT in the bottom bar),
                auto-dismisses when the user switches tabs manually. */}
            {state.finished && !ctaDismissed && (
              <WhatNextCta
                linkCopied={linkCopied}
                creatingSession={creatingSession}
                onViewFinal={() => handleTabChange('final')}
                onTryYourself={handleTryYourself}
                onReplay={() => {
                  setCtaDismissed(true)
                  restart()
                }}
                onCopyLink={copyDemoLink}
                onDismiss={() => setCtaDismissed(true)}
              />
            )}

            {/* Улучшатели#4 P1·L — mobile-only Tour drawer.
                On <md viewports the left aside is hidden; chapter narration
                lives in a bottom-anchored toggle drawer instead so the graph
                gets full width. The "Tour ▼/▲" button stays visible at the
                bottom-left of the graph area; tapping it expands a sheet with
                the same ChapterSidePanel content. */}
            {isMobile && timeline.narration_chapters && timeline.narration_chapters.length > 0 && state.currentChapter && (
              <MobileTourDrawer
                open={mobileTourOpen}
                onToggle={() => setMobileTourOpen(o => !o)}
                chapter={state.currentChapter}
                paused={state.pausedForChapter}
                onContinue={() => { continueChapter(); /* close drawer after Continue so the graph is visible */ setMobileTourOpen(false) }}
                onReplay={() => { restart(); setMobileTourOpen(false) }}
                isLast={!!(timeline.narration_chapters && timeline.narration_chapters[timeline.narration_chapters.length - 1]?.id === state.currentChapter.id)}
                simplifiedCode={timeline.simplified_code}
                finalCode={timeline.final_code}
                onTryYourself={handleTryYourself}
                creatingSession={creatingSession}
              />
            )}
          </ReactFlowProvider>
        ) : (
          <FinalIframe
            code={timeline.final_code}
            ready={state.finished}
            onSkipToResult={() => {
              // Улучшатели#4 P2·S — Skip-to-result.
              // Seek to the very end so workflow_completed fires and
              // state.finished flips to true; the next render swaps this
              // placeholder for the actual iframe. We also reassert the
              // 'final' tab in case the user changes their mind mid-seek.
              seekTo(timeline.duration_seconds)
              setTab('final')
            }}
          />
        )}
      </div>
      </div>

      {/* Bottom control bar */}
      <div className="border-t border-gray-800 bg-gray-900/90 backdrop-blur-sm px-4 py-3">
        <div className="flex items-center gap-4">
          <button
            onClick={state.playing ? pause : play}
            className="p-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition-colors"
            title={state.playing ? 'Pause' : 'Play'}
            aria-label={state.playing ? 'Pause' : 'Play'}
          >
            {state.playing ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
          </button>
          <button
            onClick={restart}
            className="p-2 text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
            title="Restart"
            aria-label="Restart"
          >
            <RotateCcw className="w-5 h-5" />
          </button>

          {/* Улучшатели#2 P1·M — progress bar as proper a11y slider with
              keyboard + pointer-drag support. */}
          <div className="flex-1 flex items-center gap-3">
            <div className="text-xs font-mono text-gray-300 tabular-nums w-12 text-right">
              {state.clock.toFixed(1)}s
            </div>
            <ProgressSlider
              clock={state.clock}
              duration={timeline.duration_seconds}
              progressPct={progressPct}
              seekTo={seekTo}
            />
            <div className="text-xs font-mono text-gray-500 tabular-nums w-12">
              {timeline.duration_seconds}s
            </div>
          </div>

          {/* Speed control */}
          <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-0.5">
            {SPEEDS.map(s => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                  state.speed === s
                    ? 'bg-indigo-600 text-white'
                    : 'text-gray-300 hover:text-white hover:bg-gray-700'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Улучшатели#6 P1·M — confirm dialog before spawning a real session. */}
      <ConfirmDialog
        isOpen={tryConfirmOpen}
        onClose={() => { if (!creatingSession) setTryConfirmOpen(false) }}
        onConfirm={doCreateSession}
        title="Start a real session?"
        message="This will start a real CodeForge session billed to your account. Continue?"
        confirmText={creatingSession ? 'Creating…' : 'Create session'}
        cancelText="Cancel"
        type="info"
        loading={creatingSession}
      />
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon,
  badge,
  children,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  badge?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center gap-1.5 px-3 py-1.5 -mb-px border-b-2 text-sm font-medium transition-colors ${
        active
          ? 'border-indigo-500 text-white'
          : 'border-transparent text-gray-400 hover:text-white'
      }`}
    >
      {icon}
      {children}
      {badge && (
        <span className="ml-1 w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
      )}
    </button>
  )
}

function FinalIframe({
  code,
  ready,
  onSkipToResult,
}: {
  code: string
  ready: boolean
  onSkipToResult: () => void
}) {
  // Use srcDoc so the HTML runs cross-origin-isolated and can't reach the host.
  if (!ready) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400">
        <Loader2 className="w-8 h-8 animate-spin mb-3" />
        <p className="text-sm">Final result will be available once playback finishes.</p>
        {/* Улучшатели#4 P2·S — "Skip to result" affordance.
            Lets the user jump straight to the demo's end without scrubbing
            the timeline manually. Seeks to duration_seconds, which triggers
            workflow_completed → state.finished = true, then re-selects the
            Final tab so the iframe takes over this placeholder. */}
        <button
          type="button"
          onClick={onSkipToResult}
          className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-gray-800 hover:bg-gray-700 text-gray-100 border border-gray-700 transition-colors"
          title="Jump the demo to the end and show the final result"
        >
          ⏭ Skip to result
        </button>
      </div>
    )
  }
  // Улучшатели#4 P2·S — iframe sandbox tighten.
  // Drop `allow-same-origin`: combined with `allow-scripts` it defeats the
  // sandbox per MDN — scripts could `postMessage` the parent and read
  // same-origin cookies. None of the shipped demo templates touch parent.*
  // or document.cookie (grep-verified), so dropping it is safe. We keep
  // `allow-scripts` (the demos need JS) and add `allow-pointer-lock` only
  // if a template needs it; none of the shipped demos call
  // requestPointerLock (verified) so we leave it off here. The
  // CodePreviewModal below DOES include allow-pointer-lock because future
  // demos may opt in for a fullscreen-style experience.
  return (
    <>
      <iframe
        title="Demo final result"
        srcDoc={code}
        sandbox="allow-scripts"
        className="absolute inset-0 w-full h-full border-0 bg-black"
      />
      {/* MURMUR-DEMO — open the final app in a full separate window (real page
          load via blob URL), exactly like a real session's "Open in new tab". */}
      <button
        type="button"
        onClick={() => openHtmlInNewWindow(code)}
        className="absolute top-3 right-3 z-10 inline-flex items-center gap-1.5 px-3 py-1.5 bg-gray-900/85 hover:bg-gray-800 border border-gray-600 text-white text-xs font-semibold rounded-md shadow-lg backdrop-blur-sm transition-colors"
        title="Open the final app in a new browser window (full size)"
      >
        <ExternalLink className="w-3.5 h-3.5" /> Open in full window
      </button>
    </>
  )
}

/** Interactive pause panel shown when the timeline halts at a pause point.
 *  Replaces the auto status plaque; offers CTA buttons specific to the pause. */
function InteractivePausePanel({
  pauseKey,
  simplifiedCode,
  finalCode,
  onResume,
  onTryYourself,
  creatingSession,
  isMobile = false,
}: {
  pauseKey: 'after_finalize' | 'after_enhance_finalize'
  simplifiedCode?: string
  finalCode: string
  onResume: () => void
  onTryYourself: () => void
  creatingSession: boolean
  isMobile?: boolean
}) {
  const [previewOpen, setPreviewOpen] = useState(false)
  const codeToRun = pauseKey === 'after_finalize' ? (simplifiedCode || finalCode) : finalCode

  const isFirst = pauseKey === 'after_finalize'
  const title = isFirst ? '✋ First version is ready' : '🎉 Enhanced version is ready'
  const body = isFirst
    ? "The Coders, Testers and Finalizer have produced a working first cut. Run it to see — it's basic (one light, single colour, fixed n) but it works. Then continue to see the Enhancement loop add polish."
    : "After Enhancement, the same agents produced a richer version with palettes, twin lights, soft shadows, live orbit trails, and a Phase-3 morph control. Run it, or spin up your own session from this spec."

  return (
    <>
      {/* Улучшатели#4 P1·L — width: on desktop, fits next to the 300px aside
          via `calc(100vw - 340px)`; on mobile the aside is hidden so the
          panel goes full-width minus a 16px gutter on each side (the previous
          calc would go negative below ~360px viewport). */}
      <div
        className={`absolute bottom-3 left-1/2 -translate-x-1/2 z-20 ${
          isMobile ? 'w-[calc(100vw-32px)]' : 'w-[min(34rem,calc(100vw-340px))]'
        }`}
      >
        <div className="backdrop-blur-md border-2 rounded-xl px-4 py-3 shadow-2xl"
             style={{ background: 'rgba(15, 23, 42, 0.92)', borderColor: isFirst ? '#3B82F6' : '#A855F7' }}>
          <div className="text-sm font-bold text-white mb-1">{title}</div>
          <div className="text-[12px] text-gray-300 leading-snug mb-3">{body}</div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setPreviewOpen(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-md transition-colors"
            >
              ▶ {isFirst ? 'Run code' : 'Run enhanced code'}
            </button>
            {isFirst ? (
              <button
                onClick={onResume}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold rounded-md transition-colors"
              >
                ✨ Continue with Enhance →
              </button>
            ) : (
              <button
                onClick={onTryYourself}
                disabled={creatingSession}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-md transition-colors"
              >
                🚀 {creatingSession ? 'Creating…' : 'Try it yourself'}
              </button>
            )}
          </div>
        </div>
      </div>

      {previewOpen && (
        <CodePreviewModal
          mode={isFirst ? 'simplified' : 'final'}
          code={codeToRun}
          onClose={() => setPreviewOpen(false)}
        />
      )}
    </>
  )
}

/** Shared full-screen modal that runs a piece of HTML/JS in a sandboxed
 *  iframe. Used by both the chapter-side panel and the interactive-pause
 *  panel to "Run code" / "Run enhanced code". Includes a prominent Back
 *  button + ESC keyboard shortcut so the user can't get stuck inside. */
function CodePreviewModal({
  mode,
  code,
  onClose,
}: {
  mode: 'simplified' | 'final'
  code: string
  onClose: () => void
}) {
  // КАО#R1-07 — ESC to close + a focus trap so Tab/Shift+Tab cycle within the
  // modal instead of leaking focus to the background player controls.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key !== 'Tab') return
      const root = rootRef.current
      if (!root) return
      const f = Array.from(
        root.querySelectorAll<HTMLElement>('button, iframe, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter(el => !el.hasAttribute('disabled'))
      if (f.length === 0) return
      const first = f[0], last = f[f.length - 1]
      const active = document.activeElement as HTMLElement | null
      if (e.shiftKey && (active === first || !root.contains(active))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (active === last || !root.contains(active))) { e.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    // КАО#R1-06 — data-code-preview-modal lets the page keydown handler detect
    // that this modal is open and stop driving the background timeline.
    <div ref={rootRef} data-code-preview-modal className="fixed inset-0 z-50 bg-black/85 flex items-center justify-center p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Demo code preview"
        className="relative bg-gray-900 border border-gray-700 rounded-xl shadow-2xl w-full max-w-5xl h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Top bar: prominent Back-to-demo button on the LEFT, title in the
            middle, secondary Close on the right. */}
        <div className="flex items-center gap-3 px-3 py-2 border-b border-gray-700 bg-gray-800/60">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-md transition-colors"
            title="Return to the demo (or press ESC)"
            autoFocus
          >
            ← Back to demo
          </button>
          <div className="text-sm font-semibold text-white flex-1 truncate">
            {mode === 'simplified' ? 'Iteration-1 preview — basic version' : 'Final enhanced version'}
          </div>
          {/* MURMUR-DEMO — open the running app in a full separate window. */}
          <button
            onClick={() => openHtmlInNewWindow(code)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-semibold rounded-md transition-colors"
            title="Open in a new browser window (full size)"
          >
            <ExternalLink className="w-3.5 h-3.5" /> Full window
          </button>
          <span className="text-[11px] text-gray-400">ESC to close</span>
          <button
            onClick={onClose}
            className="px-2 py-1 text-xs text-gray-300 hover:text-white hover:bg-gray-700 rounded transition-colors"
            title="Close"
          >
            ✕
          </button>
        </div>
        {/* КАО#R1-04 — drop allow-same-origin to match FinalIframe: allow-scripts
            + allow-same-origin together defeats the iframe sandbox per MDN. */}
        <iframe
          srcDoc={code}
          sandbox="allow-scripts allow-pointer-lock"
          className="flex-1 w-full bg-black rounded-b-xl"
          title="Demo code preview"
        />
      </div>
    </div>
  )
}

/** SidebarSpec — Specification displayed in the left sidebar (not floating
 *  over the graph). Collapsible to save space. */
function SidebarSpec({
  spec,
  onManualClose,
  templateId,
}: {
  spec: string
  onManualClose?: () => void
  templateId?: string
}) {
  // Улучшатели#4 P3·S — namespace spec-collapse state per template.
  // The previous global key (`cf_demo_spec_collapsed`) leaked state between
  // demos: collapsing the spec on the Crystal demo would re-open collapsed on
  // Mandelbulb, which is surprising when each demo has its own pedagogical
  // value for keeping the spec visible. Template id comes from the URL.
  const storageKey = templateId
    ? `cf_demo_spec_collapsed_${templateId}`
    : 'cf_demo_spec_collapsed'
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === '1' } catch { return false }
  })
  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(storageKey, next ? '1' : '0') } catch { /* ignore */ }
  }
  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg overflow-hidden">
      <div className="w-full flex items-center px-3 py-2 text-xs font-semibold uppercase tracking-wider text-gray-300">
        <button
          onClick={toggle}
          className="flex-1 flex items-center gap-1.5 hover:text-white transition-colors text-left"
          title={collapsed ? 'Show specification' : 'Hide specification'}
          aria-expanded={!collapsed}
        >
          <FileText className="w-3.5 h-3.5 text-indigo-300" />
          Specification
          {collapsed ? <ChevronDown className="w-3.5 h-3.5 ml-auto" /> : <ChevronUp className="w-3.5 h-3.5 ml-auto" />}
        </button>
        {onManualClose && (
          <button
            onClick={onManualClose}
            className="ml-2 p-1 rounded text-gray-400 hover:text-white hover:bg-gray-700 transition-colors"
            title="Close specification panel"
            aria-label="Close specification panel"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
      {!collapsed && (
        <div className="px-3 pb-3 pt-1 text-xs text-gray-200 leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap">
          {spec}
        </div>
      )}
    </div>
  )
}

/** ChapterSidePanel — vertical phase narration inside the left sidebar.
 *  Fills the rest of the sidebar height below the Spec card. Has the same
 *  scrollable body + rewind + Continue + secondary-CTA contract as the
 *  former ChapterBanner, but never overlaps graph nodes. */
function ChapterSidePanel({
  chapter,
  paused,
  onContinue,
  onReplay,
  isLast,
  simplifiedCode,
  finalCode,
  onTryYourself,
  creatingSession,
}: {
  chapter: NarrationChapter
  paused: boolean
  onContinue: () => void
  onReplay: () => void
  isLast: boolean
  simplifiedCode?: string
  finalCode: string
  onTryYourself: () => void
  creatingSession: boolean
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [chapter.id])
  // When phase completes (player auto-pauses on next chapter boundary), the
  // closing paragraph slides into view via a smooth scroll-to-bottom.
  useEffect(() => {
    if (paused && chapter.closing_paragraph && bodyRef.current) {
      // Defer one tick so the new paragraph is in the DOM before scrolling.
      const t = setTimeout(() => {
        if (bodyRef.current) bodyRef.current.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
      }, 60)
      return () => clearTimeout(t)
    }
  }, [paused, chapter.closing_paragraph])
  const rewind = () => {
    if (bodyRef.current) bodyRef.current.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const [previewMode, setPreviewMode] = useState<'simplified' | 'final' | null>(null)
  const codeToPreview = previewMode === 'simplified' ? (simplifiedCode || finalCode) : finalCode
  const sec = chapter.secondary_cta
  const onSecondary = () => {
    if (!sec) return
    if (sec.action === 'run_simplified') setPreviewMode('simplified')
    else if (sec.action === 'run_final') setPreviewMode('final')
    else if (sec.action === 'try_yourself') onTryYourself()
  }
  // КАО#R1-02 — on the LAST chapter the primary button's label ("Replay from
  // start" / "🚀 Try it yourself") must perform that action, not just play the
  // final ~2-4s of the demo. (cta_label is otherwise only the button text.)
  const onPrimary = () => {
    if (isLast) {
      const l = (chapter.cta_label || '').toLowerCase()
      if (l.includes('replay')) { onReplay(); return }
      if (l.includes('try')) { onTryYourself(); return }
    }
    onContinue()
  }
  return (
    <>
      <div
        className="flex-1 flex flex-col min-h-0 m-3 mb-0 rounded-lg overflow-hidden border-2 relative"
        style={{
          borderColor: paused ? '#A855F7' : '#3B82F6',
          // FULLY OPAQUE backgrounds (was rgba(...,0.55) which let React Flow
          // edges + group-frame dashed borders bleed through from the graph
          // sibling div that renders later in DOM).
          background: paused
            ? 'linear-gradient(180deg, #2e1065 0%, #1e1140 100%)'
            : 'linear-gradient(180deg, #1e3a8a 0%, #172554 100%)',
          boxShadow: '0 6px 18px rgba(0,0,0,0.5)',
          // High z-index for belt-and-suspenders: even if some absolute-
          // positioned graph child slips into the sidebar visually, the
          // opaque plaque covers it.
          zIndex: 30,
        }}
      >
        {/* Accent stripe on the left */}
        <div
          className="absolute top-0 bottom-0 left-0 w-1.5"
          style={{ background: paused ? '#A855F7' : '#3B82F6' }}
        />
        {/* Title row */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 pl-4">
          <span
            className="px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full flex-shrink-0"
            style={{
              background: paused ? 'rgba(168,85,247,0.25)' : 'rgba(59,130,246,0.25)',
              color: paused ? '#E9D5FF' : '#BFDBFE',
              border: `1px solid ${paused ? '#A855F7' : '#3B82F6'}`,
            }}
          >
            📖 Tour
          </span>
          <button
            type="button"
            onClick={rewind}
            title="Scroll text to the top"
            className="ml-auto p-1 rounded text-white/60 hover:text-white hover:bg-white/10 transition-colors flex-shrink-0"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 1 0 3-6.7" />
              <polyline points="3 4 3 10 9 10" />
            </svg>
          </button>
        </div>
        {/* Title */}
        <div className="px-3 pt-2 pl-4">
          <div className="flex items-start gap-2">
            {chapter.icon && <span className="text-lg leading-none">{chapter.icon}</span>}
            <div className="text-sm font-bold text-white leading-tight">{chapter.title}</div>
          </div>
        </div>
        {/* Scrollable body */}
        <div
          ref={bodyRef}
          className="overflow-y-auto px-3 py-2 pl-4 text-[12.5px] text-gray-200 leading-relaxed space-y-2 flex-1 min-h-0"
        >
          {chapter.paragraphs.map((p, i) => (
            <p key={i} className="whitespace-pre-line">{p}</p>
          ))}
          {paused && chapter.closing_paragraph && (
            <div className="mt-3 pt-3 border-t border-white/15 whitespace-pre-line text-emerald-200/95 font-medium transition-opacity duration-500">
              ✅ {chapter.closing_paragraph}
            </div>
          )}
        </div>
        {/* Footer with CTAs */}
        <div className="flex items-center gap-2 px-3 py-2 pl-4 border-t border-white/10 flex-shrink-0">
          {sec && (
            <button
              onClick={onSecondary}
              disabled={sec.action === 'try_yourself' && creatingSession}
              className="px-2.5 py-1.5 text-xs font-semibold rounded-md transition-colors bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white"
            >
              {sec.label}
            </button>
          )}
          {/* Улучшатели#4 P1·M — Continue button hidden mid-chapter.
              A disabled button with only a title= hint is invisible affordance;
              hiding it entirely until pausedForChapter===true makes the flow
              clearer: the button literally appears when it becomes actionable.
              The footer collapses to just the secondary CTA (if any) while
              playing — no dead space, no greyed-out control to misinterpret. */}
          {paused && (
            <button
              onClick={onPrimary}
              className="ml-auto px-3 py-1.5 text-xs font-semibold rounded-md transition-colors bg-indigo-600 hover:bg-indigo-500 text-white"
              title={isLast ? "Run this chapter's action" : 'Continue to the next phase'}
            >
              {chapter.cta_label ?? '▶ Continue'}
            </button>
          )}
        </div>
      </div>
      {previewMode && (
        <CodePreviewModal mode={previewMode} code={codeToPreview} onClose={() => setPreviewMode(null)} />
      )}
    </>
  )
}

// Улучшатели#5 P1·M — ChapterBanner & ChapterPlaque deleted (only ChapterSidePanel is rendered).

/** MobileTourDrawer — Улучшатели#4 P1·L responsive layout <900px.
 *  Replaces the left aside on <md viewports. Collapsed by default: a small
 *  "Tour ▲" button sits at the bottom-left of the graph area; tapping it
 *  expands a bottom sheet with the same chapter content as ChapterSidePanel.
 *  When paused at a chapter boundary, the drawer auto-pulses to draw the
 *  user's eye since they can't see the chapter content otherwise.
 *  When not paused, the drawer is collapsed by default to maximize graph
 *  visibility; user can tap to read narration. */
function MobileTourDrawer({
  open,
  onToggle,
  chapter,
  paused,
  onContinue,
  onReplay,
  isLast,
  simplifiedCode,
  finalCode,
  onTryYourself,
  creatingSession,
}: {
  open: boolean
  onToggle: () => void
  chapter: NarrationChapter
  paused: boolean
  onContinue: () => void
  onReplay: () => void
  isLast: boolean
  simplifiedCode?: string
  finalCode: string
  onTryYourself: () => void
  creatingSession: boolean
}) {
  const [previewMode, setPreviewMode] = useState<'simplified' | 'final' | null>(null)
  const codeToPreview = previewMode === 'simplified' ? (simplifiedCode || finalCode) : finalCode
  const sec = chapter.secondary_cta
  const onSecondary = () => {
    if (!sec) return
    if (sec.action === 'run_simplified') setPreviewMode('simplified')
    else if (sec.action === 'run_final') setPreviewMode('final')
    else if (sec.action === 'try_yourself') onTryYourself()
  }
  // КАО#R1-02 — same terminal-CTA routing as ChapterSidePanel.
  const onPrimary = () => {
    if (isLast) {
      const l = (chapter.cta_label || '').toLowerCase()
      if (l.includes('replay')) { onReplay(); return }
      if (l.includes('try')) { onTryYourself(); return }
    }
    onContinue()
  }
  // Note: auto-open on `paused` is handled in the parent (DemoPlayerPage)
  // since `open` is a controlled prop. The drawer just renders the UI.
  return (
    <>
      {/* Toggle button — always visible at bottom-left of graph area. */}
      <button
        type="button"
        onClick={onToggle}
        className="absolute bottom-3 left-3 z-30 flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-semibold shadow-lg transition-colors text-white"
        style={{
          background: paused ? '#A855F7' : '#3B82F6',
          // Subtle pulse when paused but drawer is closed — affordance that
          // the user needs to open the drawer to click Continue.
          animation: paused && !open ? 'cf-tour-pulse 1.4s ease-in-out infinite' : undefined,
        }}
        aria-expanded={open}
        aria-controls="cf-mobile-tour-sheet"
      >
        <style>{`@keyframes cf-tour-pulse {
          0%, 100% { transform: scale(1); box-shadow: 0 4px 14px rgba(168,85,247,0.4); }
          50% { transform: scale(1.06); box-shadow: 0 6px 18px rgba(168,85,247,0.7); }
        }`}</style>
        <span>📖 Tour</span>
        <span aria-hidden="true">{open ? '▼' : '▲'}</span>
      </button>

      {/* Bottom sheet — slides up from below when open. */}
      <div
        id="cf-mobile-tour-sheet"
        role="region"
        aria-label="Tour narration"
        className="absolute left-2 right-2 bottom-14 z-30 rounded-lg overflow-hidden border-2 flex flex-col"
        style={{
          maxHeight: '55%',
          background: paused
            ? 'linear-gradient(180deg, #2e1065 0%, #1e1140 100%)'
            : 'linear-gradient(180deg, #1e3a8a 0%, #172554 100%)',
          borderColor: paused ? '#A855F7' : '#3B82F6',
          boxShadow: '0 10px 28px rgba(0,0,0,0.6)',
          transform: open ? 'translateY(0)' : 'translateY(110%)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
          transition: 'transform 200ms ease-out, opacity 160ms ease-out',
        }}
      >
        {/* Title row */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-white/10 flex-shrink-0">
          {chapter.icon && <span className="text-base leading-none">{chapter.icon}</span>}
          <div className="text-sm font-bold text-white leading-tight flex-1 truncate">{chapter.title}</div>
          <button
            type="button"
            onClick={onToggle}
            className="p-1 rounded text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            aria-label="Close tour drawer"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        {/* Scrollable body */}
        <div className="overflow-y-auto px-3 py-2 text-[12.5px] text-gray-200 leading-relaxed space-y-2 flex-1 min-h-0">
          {chapter.paragraphs.map((p, i) => (
            <p key={i} className="whitespace-pre-line">{p}</p>
          ))}
          {paused && chapter.closing_paragraph && (
            <div className="mt-3 pt-3 border-t border-white/15 whitespace-pre-line text-emerald-200/95 font-medium">
              ✅ {chapter.closing_paragraph}
            </div>
          )}
        </div>
        {/* Footer CTAs */}
        <div className="flex items-center gap-2 px-3 py-2 border-t border-white/10 flex-shrink-0">
          {sec && (
            <button
              onClick={onSecondary}
              disabled={sec.action === 'try_yourself' && creatingSession}
              className="px-2.5 py-1.5 text-xs font-semibold rounded-md transition-colors bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white"
            >
              {sec.label}
            </button>
          )}
          {/* Same hide-when-not-paused contract as the desktop ChapterSidePanel. */}
          {paused && (
            <button
              onClick={onPrimary}
              className="ml-auto px-3 py-1.5 text-xs font-semibold rounded-md transition-colors bg-indigo-600 hover:bg-indigo-500 text-white"
              title={isLast ? "Run this chapter's action" : 'Continue to the next phase'}
            >
              {chapter.cta_label ?? '▶ Continue'}
            </button>
          )}
        </div>
      </div>

      {previewMode && (
        <CodePreviewModal mode={previewMode} code={codeToPreview} onClose={() => setPreviewMode(null)} />
      )}
    </>
  )
}

function Confetti() {
  // Lightweight CSS-driven confetti, no library. Only mounts once.
  const pieces = useMemo(() => {
    const out: { left: number; delay: number; size: number; color: string; rot: number }[] = []
    const palette = ['#1ce6b5', '#ff5fa2', '#5fbcff', '#ffd166', '#a78bfa']
    for (let i = 0; i < 80; i++) {
      out.push({
        left: Math.random() * 100,
        delay: Math.random() * 0.8,
        size: 6 + Math.random() * 6,
        color: palette[i % palette.length],
        rot: Math.random() * 360,
      })
    }
    return out
  }, [])
  return (
    <div className="absolute inset-0 pointer-events-none overflow-hidden z-20">
      <style>{`
        @keyframes cf-confetti-fall {
          0% { transform: translateY(-20px) rotate(0deg); opacity: 0; }
          10% { opacity: 1; }
          100% { transform: translateY(110vh) rotate(720deg); opacity: 0; }
        }
      `}</style>
      {/* Улучшатели#8 P3·S — a11y: announce completion to screen-readers. */}
      <div
        role="status"
        aria-live="polite"
        className="absolute top-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-4 py-2 bg-gray-900/95 border border-emerald-500/50 rounded-full shadow-lg animate-pulse"
      >
        <PartyPopper className="w-4 h-4 text-emerald-400" />
        <span className="text-sm font-semibold text-white">Workflow complete!</span>
      </div>
      {pieces.map((p, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: `${p.left}%`,
            top: '-20px',
            width: `${p.size}px`,
            height: `${p.size * 0.4}px`,
            background: p.color,
            transform: `rotate(${p.rot}deg)`,
            animation: `cf-confetti-fall ${2.5 + Math.random() * 1.5}s ${p.delay}s linear forwards`,
            borderRadius: '2px',
          }}
        />
      ))}
    </div>
  )
}

/* ───── Demo annotation cards ───────────────────────────────────────── */

/** Specification card — anchored top-left of the graph viewport. Collapsible
 *  so the user can hide it once they've read the spec. Persists collapse
 *  state across the session via localStorage. */
function SpecCard({ spec, templateId }: { spec: string; templateId?: string }) {
  // Улучшатели#4 P3·S — namespace spec-collapse state per template.
  // Mirrors SidebarSpec so both surfaces respect the same per-template key.
  const storageKey = templateId
    ? `cf_demo_spec_collapsed_${templateId}`
    : 'cf_demo_spec_collapsed'
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(storageKey) === '1' } catch { return false }
  })
  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    try { localStorage.setItem(storageKey, next ? '1' : '0') } catch { /* ignore */ }
  }
  return (
    <div className="absolute top-3 left-3 z-10 max-w-sm">
      <div className="bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-xl shadow-lg overflow-hidden">
        <button
          onClick={toggle}
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold uppercase tracking-wider text-gray-300 hover:bg-gray-700/50 transition-colors"
          title={collapsed ? 'Show specification' : 'Hide specification'}
          aria-expanded={!collapsed}
        >
          <span className="flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5 text-indigo-300" />
            Specification
          </span>
          {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
        {!collapsed && (
          <div className="px-3 pb-3 pt-1 text-xs text-gray-200 leading-relaxed max-h-64 overflow-y-auto whitespace-pre-wrap">
            {spec}
          </div>
        )}
      </div>
    </div>
  )
}

/** Bridge: subscribes to timeline `camera_focus` events and pans the
 *  React-Flow viewport to the target node id or group prefix. Captures the
 *  user's "base" zoom on first focus and pans to baseZoom * 1.1 by default
 *  (or to an explicit zoom from the event). Must live inside ReactFlowProvider. */
function CameraFocusBridge({
  focus,
  nodes,
}: {
  focus: { target: string; zoom?: number; seq: number } | null
  nodes: Node<AgentNodeData>[]
}) {
  const rf = useReactFlow()
  const baseZoomRef = useRef<number | null>(null)
  const lastSeqRef = useRef<number>(-1)

  useEffect(() => {
    if (!focus) return
    if (focus.seq === lastSeqRef.current) return
    lastSeqRef.current = focus.seq

    // Capture base zoom on first focus so we don't drift across many transitions.
    if (baseZoomRef.current === null) {
      try { baseZoomRef.current = rf.getViewport?.()?.zoom ?? 1.0 } catch { baseZoomRef.current = 1.0 }
    }
    const targetZoom = focus.zoom ?? Math.min((baseZoomRef.current ?? 1) * 1.25, 1.5)

    const NODE_W = 220
    const NODE_H = 140
    let cx = 0, cy = 0
    if (focus.target.endsWith('_')) {
      // Group prefix: average bbox of matching nodes.
      const groupNodes = nodes.filter(n => n.id.startsWith(focus.target))
      if (groupNodes.length === 0) return
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const n of groupNodes) {
        if (n.position.x < minX) minX = n.position.x
        if (n.position.y < minY) minY = n.position.y
        if (n.position.x + NODE_W > maxX) maxX = n.position.x + NODE_W
        if (n.position.y + NODE_H > maxY) maxY = n.position.y + NODE_H
      }
      cx = (minX + maxX) / 2
      cy = (minY + maxY) / 2
    } else {
      const node = nodes.find(n => n.id === focus.target)
      if (!node) return
      cx = node.position.x + NODE_W / 2
      cy = node.position.y + NODE_H / 2
    }
    try { rf.setCenter(cx, cy, { zoom: targetZoom, duration: 700 }) } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.seq])

  return null
}

/** Demo-only group frames overlay — mirrors GroupFramesLayer from the real
 *  SessionDetailPage, but READ-ONLY (no add/remove buttons, no drag handles).
 *  Renders dashed frames + labels around Coders, Testers, and Enhancers so the
 *  demo looks like the real session. */
function DemoGroupFrames({ nodes }: { nodes: Node<AgentNodeData>[] }) {
  const vp = useViewport()
  const { x: vx, y: vy, zoom } = vp
  const PADDING = 56
  const NODE_W = 220
  const NODE_H_BASE = 140
  // Streaming preview adds the "STREAMING" panel (~110px) inside the node card,
  // making it grow vertically. The group frame must grow to match. We measure
  // actual rendered heights via DOM since the streaming panel height varies
  // slightly with content; fall back to a heuristic if the node isn't mounted.
  const nodeH = (n: Node<AgentNodeData>): number => {
    try {
      const el = document.querySelector(`.react-flow__node[data-id="${n.id}"]`) as HTMLElement | null
      if (el) {
        // Element height is in screen px → divide by zoom to get flow-coord height.
        const h = el.getBoundingClientRect().height / Math.max(zoom, 0.0001)
        if (h > 10) return h
      }
    } catch { /* ignore */ }
    // Fallback: if data flag suggests streaming, assume +110 px expansion.
    return n.data?.isStreaming ? NODE_H_BASE + 110 : NODE_H_BASE
  }
  const groups: { label: string; color: string; nodePrefix: string }[] = [
    { label: 'Coders', color: '#3B82F6', nodePrefix: 'coder_' },
    { label: 'Testers', color: '#F59E0B', nodePrefix: 'tester_' },
    { label: 'Enhancers', color: '#A855F7', nodePrefix: 'enhancer_' },
  ]
  return (
    <div className="absolute inset-0 pointer-events-none" style={{ zIndex: 5, overflow: 'hidden' }}>
      {groups.map(({ label, color, nodePrefix }) => {
        const groupNodes = nodes.filter(n => n.id.startsWith(nodePrefix))
        if (groupNodes.length === 0) return null
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of groupNodes) {
          const h = nodeH(n)
          if (n.position.x < minX) minX = n.position.x
          if (n.position.y < minY) minY = n.position.y
          if (n.position.x + NODE_W > maxX) maxX = n.position.x + NODE_W
          if (n.position.y + h > maxY) maxY = n.position.y + h
        }
        minX -= PADDING; minY -= PADDING; maxX += PADDING; maxY += PADDING
        const screenX = minX * zoom + vx
        const screenY = minY * zoom + vy
        const screenW = (maxX - minX) * zoom
        const screenH = (maxY - minY) * zoom
        return (
          <div
            key={label}
            className="absolute"
            style={{ left: screenX, top: screenY, width: screenW, height: screenH }}
          >
            <div
              className="absolute inset-0 rounded-xl border-2 border-dashed pointer-events-none"
              style={{ borderColor: `${color}40` }}
            />
            <div
              className="absolute left-3 px-2 text-xs font-bold uppercase tracking-wider pointer-events-none"
              style={{
                color,
                backgroundColor: 'var(--cf-bg, #0b0d12)',
                top: -Math.min(10 * zoom, 10),
                fontSize: Math.max(10 * zoom, 8),
              }}
            >
              {label}{groupNodes.length > 1 ? ` (${groupNodes.length})` : ''}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** Status plaque — anchored top-center of the graph viewport. Shows either
 *  the active explicit annotation from `timeline.annotations` or an
 *  auto-derived narration based on agent statuses. */
function StatusPlaque({ timeline, state }: { timeline: DemoTimeline; state: DemoPlayerState }) {
  const annotation = pickAnnotation(timeline.annotations, state.clock)
  const auto = annotation ? null : deriveStatus(timeline, state)
  const title = annotation ? annotation.title : auto!.title
  const body = annotation ? annotation.body : auto!.body
  const icon = annotation?.icon ?? auto!.icon
  const accentClass = annotation
    ? 'border-purple-400/40 bg-purple-500/15'
    : 'border-indigo-400/30 bg-indigo-500/10'
  return (
    // Bottom-center, above the control bar — avoids colliding with the Spec
    // card (top-left) and the MetricsPanel (top-right).
    <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 max-w-lg w-[min(32rem,calc(100vw-340px))] pointer-events-none">
      <div className={`backdrop-blur-sm border rounded-xl px-3 py-2 shadow-lg transition-colors ${accentClass}`}>
        <div className="flex items-start gap-2">
          <span className="text-xl leading-none mt-0.5">{icon}</span>
          <div className="min-w-0">
            <div className="text-sm font-semibold text-white">{title}</div>
            <div className="text-[11px] text-gray-200/90 leading-snug">{body}</div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Улучшатели#2 P1·M — ProgressSlider: accessible seek bar.
 *  - role="slider" with aria-valuemin/max/now/label
 *  - tabIndex=0 to be focusable
 *  - ←/→ seek ±5s, Home/End jump, PageUp/Down ±10s
 *  - pointerdown → pointermove live seek → pointerup commits
 *  - visible focus ring */
function ProgressSlider({
  clock,
  duration,
  progressPct,
  seekTo,
}: {
  clock: number
  duration: number
  progressPct: number
  seekTo: (t: number) => void
}) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = barRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)))
      seekTo(ratio * duration)
    },
    [seekTo, duration],
  )

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    setDragging(true)
    try { (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
    seekFromClientX(e.clientX)
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    seekFromClientX(e.clientX)
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    try { (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    seekFromClientX(e.clientX)
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    switch (e.key) {
      case 'ArrowLeft':  next = Math.max(0, clock - 5); break
      case 'ArrowRight': next = Math.min(duration, clock + 5); break
      case 'PageDown':   next = Math.max(0, clock - 10); break
      case 'PageUp':     next = Math.min(duration, clock + 10); break
      case 'Home':       next = 0; break
      case 'End':        next = duration; break
      default: return
    }
    e.preventDefault()
    e.stopPropagation()
    if (next !== null) seekTo(next)
  }

  return (
    <div
      ref={barRef}
      role="slider"
      tabIndex={0}
      aria-label="Demo progress"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={Math.round(clock * 10) / 10}
      aria-valuetext={`${clock.toFixed(1)} of ${duration} seconds`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className="relative flex-1 h-2 bg-gray-800 rounded-full cursor-pointer group outline-none focus:ring-2 focus:ring-indigo-400 focus:ring-offset-2 focus:ring-offset-gray-900 select-none touch-none"
    >
      <div
        className="absolute inset-y-0 left-0 bg-gradient-to-r from-indigo-500 to-purple-500 rounded-full transition-all pointer-events-none"
        style={{ width: `${progressPct}%`, transitionDuration: dragging ? '0ms' : undefined }}
      />
      <div
        className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full shadow transition-opacity pointer-events-none ${
          dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus:opacity-100'
        }`}
        style={{ left: `calc(${progressPct}% - 6px)` }}
      />
    </div>
  )
}

/** Улучшатели#3 P1·M — Post-demo "What next" CTA card.
 *  Overlay in the graph area (top-center), shown when state.finished &&
 *  !ctaDismissed. Auto-dismisses on tab change (via handleTabChange). */
function WhatNextCta({
  linkCopied,
  creatingSession,
  onViewFinal,
  onTryYourself,
  onReplay,
  onCopyLink,
  onDismiss,
}: {
  linkCopied: boolean
  creatingSession: boolean
  onViewFinal: () => void
  onTryYourself: () => void
  onReplay: () => void
  onCopyLink: () => void
  onDismiss: () => void
}) {
  return (
    <div
      className="absolute top-16 left-1/2 -translate-x-1/2 z-30 w-[min(34rem,calc(100vw-340px))] pointer-events-auto"
      role="dialog"
      aria-label="What next"
    >
      <div className="rounded-xl border-2 border-emerald-400/50 bg-gray-900/95 backdrop-blur-md shadow-2xl px-4 py-3 relative">
        <button
          onClick={onDismiss}
          className="absolute top-2 right-2 p-1 text-gray-400 hover:text-white hover:bg-gray-800 rounded transition-colors"
          aria-label="Dismiss"
          title="Dismiss"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div className="text-sm font-bold text-white mb-1 pr-6">Demo complete — what next?</div>
        <div className="text-[12px] text-gray-300 mb-3">Pick where to go from here.</div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={onViewFinal}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold rounded-md transition-colors"
          >
            ▶ View final result
          </button>
          <button
            onClick={onTryYourself}
            disabled={creatingSession}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold rounded-md transition-colors"
          >
            🚀 Try it yourself
          </button>
          <button
            onClick={onReplay}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-white text-xs font-semibold rounded-md transition-colors"
          >
            ↻ Replay
          </button>
          <button
            onClick={onCopyLink}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs font-semibold rounded-md transition-colors border border-gray-700"
            aria-live="polite"
          >
            {linkCopied ? '✓ Link copied' : 'Copy link to demo'}
          </button>
        </div>
      </div>
    </div>
  )
}
