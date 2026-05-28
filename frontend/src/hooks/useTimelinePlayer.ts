/**
 * Pre-recorded demo timeline playback engine.
 *
 * Drives a fake multi-agent session purely from a JSON timeline (no WebSocket,
 * no LLM calls). The hook owns the playback clock and exposes the same state
 * shape SessionDetailPage uses (per-agent status, streaming text, totals)
 * so the DemoPlayer view can render the standard `AgentNode` / `MetricsPanel`
 * components unchanged.
 *
 * The clock advances via requestAnimationFrame. Pending events fire when
 * `t <= clock`. Replays are deterministic — replaying at the same speed
 * always produces the same visible state at the same wall-clock offset.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

export type DemoAgentType =
  | 'coder'
  | 'tester'
  | 'summarizer'
  | 'finalizer'
  | 'enhancer_design'
  | 'enhancer_func'
  | 'enhancer_security'
  | 'enhancer_summary'

export interface TimelineEvent {
  t: number
  type:
    | 'workflow_started'
    | 'iteration_started'
    | 'phase_started'
    | 'agent_started'
    | 'agent_streaming'
    | 'agent_completed'
    | 'iteration_completed'
    | 'workflow_completed'
    /** Pan the React Flow camera to a node group / individual node id. */
    | 'camera_focus'
    /** Halt playback until the user explicitly resumes. The `pause_key` lets
     *  the UI render different controls for different pause points. */
    | 'pause_for_interaction'
  agent_type?: DemoAgentType
  agent_index?: number
  iteration?: number
  phase?: string
  partial_content?: string
  tokens?: number
  cost?: number
  issuesFound?: number
  /** camera_focus event: target React-Flow node id (e.g. 'spec', 'coder_0',
   *  'tester_0', 'summarizer_0', 'finalizer_0', 'output',
   *  'enhancer_design_0', etc.) — or a group prefix ending in '_'
   *  (e.g. 'coder_', 'tester_', 'enhancer_'). Group focus = bbox of all
   *  nodes with that prefix. */
  target?: string
  /** Optional explicit zoom level when focusing (default = baseZoom × 1.1). */
  zoom?: number
  /** pause_for_interaction event: identifies the pause point so the UI can
   *  render the appropriate CTA buttons. */
  pause_key?: 'after_finalize' | 'after_enhance_finalize'
}

/** Optional commentary card shown on top of the graph for `durationS`
 *  seconds starting at `at`. Used for explicit narration (e.g. simulated
 *  Enhancement phase at the end of a demo). The player also auto-derives
 *  a generic phase-status plaque from workflow state — annotations are
 *  for richer specific text. */
export interface TimelineAnnotation {
  at: number        // seconds into the timeline
  durationS: number // how long the card stays on screen
  title: string
  body: string
  /** Optional emoji shown next to the title. */
  icon?: string
}

/** A "chapter" of the demo — a phase with rich narration. The player pauses
 *  the clock at `t_start` and shows the chapter's title + paragraphs in a
 *  scrollable plaque. The user reads at their own pace, clicks ▶ Continue
 *  to resume; the clock then advances until the next chapter pauses again.
 *  Replaces the old auto-rotating annotation strip. */
export interface NarrationChapter {
  id: string
  t_start: number
  title: string
  icon?: string
  /** Body paragraphs (one block per concept). Rendered as a stacked list inside
   *  a scrollable body. */
  paragraphs: string[]
  /** Optional CTA shown at the bottom when paused on this chapter. Defaults:
   *  "▶ Continue" (resume to next chapter). For terminal chapters, use e.g.
   *  "🚀 Try it yourself". */
  cta_label?: string
  /** Optional secondary CTA. Used for the two `run_code` pause points. */
  secondary_cta?: { label: string; action: 'run_simplified' | 'run_final' | 'try_yourself' }
  /** Optional "phase completion" paragraph. Appears at the end of the
   *  plaque body when the player pauses on this chapter (i.e. when the phase
   *  finishes and is waiting for the user to click Continue). The body
   *  auto-scrolls down so the user sees the conclusion appear. */
  closing_paragraph?: string
}

export interface DemoTimeline {
  id: string
  name: string
  description: string
  language: string
  spec: string
  duration_seconds: number
  coders: { model: string }[]
  testers: { model: string }[]
  summarizer?: { model: string }
  finalizer?: { model: string }
  events: TimelineEvent[]
  /** Optional explicit narration cards. See TimelineAnnotation. */
  annotations?: TimelineAnnotation[]
  /** Phase chapters — the modern narration system. The player auto-pauses
   *  at each chapter's t_start, shows a scrollable plaque with all its
   *  paragraphs, and resumes on Continue. */
  narration_chapters?: NarrationChapter[]
  final_code: string
  /** Optional simplified version of the code shown at an intermediate pause
   *  point (e.g. mandelbulb demo runs an early-iteration code first, then a
   *  full enhanced version at the end). */
  simplified_code?: string
  thumbnail?: string
}

export type DemoAgentStatus = 'idle' | 'working' | 'done'

export interface DemoAgentState {
  status: DemoAgentStatus
  streamingContent: string
  isStreaming: boolean
  tokensUsed: number
  costUsd: number
  issuesFound: number
  startedAt: number | null // wall-clock ms when this agent started (for elapsed timer)
}

export interface DemoWorkflowState {
  status: 'idle' | 'running' | 'completed'
  iteration: number
  phase: string | null
  totalTokens: number
  totalCost: number
  codersDone: number
  testersDone: number
}

export interface DemoPlayerState {
  clock: number
  playing: boolean
  speed: number
  finished: boolean
  workflow: DemoWorkflowState
  agents: Record<string, DemoAgentState>
  /** Set when a `pause_for_interaction` event fires. UI shows CTA buttons
   *  matching the key; `resume()` clears it and continues playback. */
  interactivePauseKey: 'after_finalize' | 'after_enhance_finalize' | null
  /** Last camera-focus target (React-Flow node id or group prefix); the
   *  DemoPlayerPage subscribes to this to call setCenter on the RF instance.
   *  Bumped via a monotonically-increasing `cameraFocusSeq` so identical
   *  consecutive targets still trigger a re-pan. */
  cameraFocus: { target: string; zoom?: number; seq: number } | null
  /** Currently-active narration chapter — the chapter whose `t_start` is the
   *  greatest value ≤ clock. UI renders the ChapterPlaque from this. */
  currentChapter: NarrationChapter | null
  /** When true, the clock is paused waiting for the user to read the current
   *  chapter and click ▶ Continue. Distinct from `interactivePauseKey` which
   *  is for the special run-code pause points. */
  pausedForChapter: boolean
}

export const agentKey = (type: DemoAgentType, index: number) => `${type}_${index}`

function freshAgent(): DemoAgentState {
  return {
    status: 'idle',
    streamingContent: '',
    isStreaming: false,
    tokensUsed: 0,
    costUsd: 0,
    issuesFound: 0,
    startedAt: null,
  }
}

function buildInitialAgents(tl: DemoTimeline | null): Record<string, DemoAgentState> {
  if (!tl) return {}
  const out: Record<string, DemoAgentState> = {}
  for (let i = 0; i < tl.coders.length; i++) out[agentKey('coder', i)] = freshAgent()
  for (let i = 0; i < tl.testers.length; i++) out[agentKey('tester', i)] = freshAgent()
  out[agentKey('summarizer', 0)] = freshAgent()
  out[agentKey('finalizer', 0)] = freshAgent()
  return out
}

const INITIAL_WORKFLOW: DemoWorkflowState = {
  status: 'idle',
  iteration: 0,
  phase: null,
  totalTokens: 0,
  totalCost: 0,
  codersDone: 0,
  testersDone: 0,
}

interface UseTimelinePlayerOpts {
  timeline: DemoTimeline | null
  autoPlay?: boolean
}

export function useTimelinePlayer({ timeline, autoPlay = true }: UseTimelinePlayerOpts) {
  const [clock, setClock] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [finished, setFinished] = useState(false)
  const [workflow, setWorkflow] = useState<DemoWorkflowState>(INITIAL_WORKFLOW)
  const [agents, setAgents] = useState<Record<string, DemoAgentState>>(() =>
    buildInitialAgents(timeline),
  )
  const [interactivePauseKey, setInteractivePauseKey] = useState<DemoPlayerState['interactivePauseKey']>(null)
  const [cameraFocus, setCameraFocus] = useState<DemoPlayerState['cameraFocus']>(null)
  const cameraSeqRef = useRef(0)
  // Chapter pause state
  const [currentChapterIdx, setCurrentChapterIdx] = useState<number>(-1)
  const [pausedForChapter, setPausedForChapter] = useState<boolean>(false)
  /** When paused at a chapter boundary, the next chapter (the one we're ABOUT
   *  to switch to once the user clicks Continue) is held here. The plaque
   *  continues to show the previous chapter; switching is deferred so the new
   *  text and the new agent activity appear in lock-step at Continue time. */
  const stagedNextChapterIdxRef = useRef<number | null>(null)
  /** Set of chapter IDs the user has acknowledged (clicked Continue on). The
   *  player only auto-pauses at chapters not in this set, so seeking backward
   *  and replaying doesn't re-stop at chapters already passed. */
  const acknowledgedChaptersRef = useRef<Set<string>>(new Set())

  // Refs that mirror the latest state so the rAF loop reads fresh values without
  // re-subscribing.
  const clockRef = useRef(0)
  const playingRef = useRef(false)
  const speedRef = useRef(1)
  const nextEventIdxRef = useRef(0)
  const lastFrameRef = useRef<number | null>(null)
  const rafRef = useRef<number | null>(null)
  const timelineRef = useRef<DemoTimeline | null>(timeline)
  timelineRef.current = timeline

  // Reset when timeline changes.
  useEffect(() => {
    nextEventIdxRef.current = 0
    clockRef.current = 0
    setClock(0)
    setWorkflow(INITIAL_WORKFLOW)
    setAgents(buildInitialAgents(timeline))
    setFinished(false)
    setInteractivePauseKey(null)
    setCameraFocus(null)
    cameraSeqRef.current = 0
    setCurrentChapterIdx(-1)
    setPausedForChapter(false)
    stagedNextChapterIdxRef.current = null
    acknowledgedChaptersRef.current = new Set()
    if (timeline && autoPlay) {
      setPlaying(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeline?.id])

  // Apply a single timeline event into the state.
  const applyEvent = useCallback((ev: TimelineEvent) => {
    const now = Date.now()
    if (ev.type === 'workflow_started') {
      setWorkflow(w => ({ ...w, status: 'running' }))
    } else if (ev.type === 'iteration_started') {
      setWorkflow(w => ({ ...w, iteration: ev.iteration ?? w.iteration }))
    } else if (ev.type === 'phase_started') {
      setWorkflow(w => ({ ...w, phase: ev.phase ?? w.phase }))
    } else if (ev.type === 'agent_started' && ev.agent_type) {
      const k = agentKey(ev.agent_type, ev.agent_index ?? 0)
      setAgents(a => ({
        ...a,
        [k]: { ...(a[k] ?? freshAgent()), status: 'working', isStreaming: true, startedAt: now },
      }))
    } else if (ev.type === 'agent_streaming' && ev.agent_type) {
      const k = agentKey(ev.agent_type, ev.agent_index ?? 0)
      setAgents(a => ({
        ...a,
        [k]: {
          ...(a[k] ?? freshAgent()),
          status: 'working',
          isStreaming: true,
          streamingContent: ev.partial_content ?? a[k]?.streamingContent ?? '',
        },
      }))
    } else if (ev.type === 'agent_completed' && ev.agent_type) {
      const k = agentKey(ev.agent_type, ev.agent_index ?? 0)
      const tokens = ev.tokens ?? 0
      const cost = ev.cost ?? 0
      const issues = ev.issuesFound ?? 0
      setAgents(a => ({
        ...a,
        [k]: {
          ...(a[k] ?? freshAgent()),
          status: 'done',
          isStreaming: false,
          tokensUsed: tokens,
          costUsd: cost,
          issuesFound: issues,
        },
      }))
      setWorkflow(w => ({
        ...w,
        totalTokens: w.totalTokens + tokens,
        totalCost: w.totalCost + cost,
        codersDone: ev.agent_type === 'coder' ? w.codersDone + 1 : w.codersDone,
        testersDone: ev.agent_type === 'tester' ? w.testersDone + 1 : w.testersDone,
      }))
    } else if (ev.type === 'iteration_completed') {
      // no-op for our simple display (workflow_completed handles final state)
    } else if (ev.type === 'workflow_completed') {
      setWorkflow(w => ({ ...w, status: 'completed', phase: null }))
      setFinished(true)
    } else if (ev.type === 'camera_focus' && ev.target) {
      cameraSeqRef.current += 1
      setCameraFocus({ target: ev.target, zoom: ev.zoom, seq: cameraSeqRef.current })
    } else if (ev.type === 'pause_for_interaction' && ev.pause_key) {
      // Halt playback. The rAF loop sees playingRef.current=false on its
      // next tick and stops dispatching events until resume() flips it back.
      playingRef.current = false
      setPlaying(false)
      setInteractivePauseKey(ev.pause_key)
    }
  }, [])

  // Fast-forward to a given clock value (used by seek + restart).
  const seekTo = useCallback(
    (target: number) => {
      const tl = timelineRef.current
      if (!tl) return
      const clamped = Math.max(0, Math.min(target, tl.duration_seconds))
      // Улучшатели#4 P1·M — seek-back chapter state.
      // If seeking backwards, replay from t=0.
      const seekingBack = clamped < clockRef.current
      if (seekingBack) {
        nextEventIdxRef.current = 0
        setWorkflow(INITIAL_WORKFLOW)
        setAgents(buildInitialAgents(tl))
        setFinished(false)
        // Forget chapter acknowledgements so they re-pause on the way back.
        acknowledgedChaptersRef.current = new Set()
        setCurrentChapterIdx(-1)
        setPausedForChapter(false)
        stagedNextChapterIdxRef.current = null
        setInteractivePauseKey(null)
      }
      while (
        nextEventIdxRef.current < tl.events.length &&
        tl.events[nextEventIdxRef.current].t <= clamped
      ) {
        applyEvent(tl.events[nextEventIdxRef.current])
        nextEventIdxRef.current += 1
      }
      clockRef.current = clamped
      setClock(clamped)

      // Улучшатели#4 P1·M — seek-back chapter state.
      // After the seek lands, reconcile chapter state with the new clock.
      // Without this, seeking (esp. backwards) leaves currentChapterIdx and
      // pausedForChapter inconsistent: the user can land mid-chapter with
      // Continue disabled because no chapter-boundary event fires forward
      // from a position INSIDE a chapter.
      const chapters = tl.narration_chapters ?? []
      if (chapters.length > 0) {
        // Find the chapter whose [t_start, next.t_start) interval contains
        // clamped (or last chapter if clamped >= last t_start).
        let landedIdx = -1
        for (let i = 0; i < chapters.length; i++) {
          if (chapters[i].t_start <= clamped) landedIdx = i
          else break
        }
        if (landedIdx < 0) {
          // Clock is BEFORE all chapter boundaries — reset to idle state.
          // Covered cases: seek to t=0, seek to t=10 (before any chapter).
          setCurrentChapterIdx(-1)
          setPausedForChapter(false)
          stagedNextChapterIdxRef.current = null
        } else {
          // Clock is inside chapter landedIdx's range, or past the last
          // chapter's t_start. Activate the landed chapter.
          setCurrentChapterIdx(landedIdx)
          stagedNextChapterIdxRef.current = null
          const landed = chapters[landedIdx]
          if (seekingBack) {
            // Seeking backwards into a chapter: show the plaque paused so
            // the user can re-read it and click Continue to advance.
            // Mark un-acknowledged so Continue (which uses chapter id) does
            // the right thing and the rAF loop won't auto-skip it.
            acknowledgedChaptersRef.current.delete(landed.id)
            setPausedForChapter(true)
            playingRef.current = false
            setPlaying(false)
          } else {
            // Seeking forward into a chapter: don't auto-pause — the user
            // chose to skip ahead, keep playing. Acknowledge the chapter
            // so the rAF loop doesn't re-pause at its boundary.
            acknowledgedChaptersRef.current.add(landed.id)
            setPausedForChapter(false)
          }
        }
      }
    },
    [applyEvent],
  )

  // rAF loop
  useEffect(() => {
    playingRef.current = playing
    speedRef.current = speed
    if (!playing) {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      lastFrameRef.current = null
      return
    }
    const tick = (ts: number) => {
      if (!playingRef.current) {
        rafRef.current = null
        return
      }
      const tl = timelineRef.current
      if (!tl) {
        rafRef.current = requestAnimationFrame(tick)
        return
      }
      if (lastFrameRef.current == null) lastFrameRef.current = ts
      const dtMs = ts - lastFrameRef.current
      lastFrameRef.current = ts
      const newClock = clockRef.current + (dtMs / 1000) * speedRef.current
      const target = Math.min(newClock, tl.duration_seconds)
      // Dispatch any events whose t has been crossed.
      // Chapter check: stop the clock JUST BEFORE the next chapter's t_start
      // so the events at t == t_start (phase_started, agent_started, ...) do
      // NOT fire until the user clicks Continue. This keeps the previous
      // chapter's plaque visible until Continue, at which point the new
      // chapter text appears AT THE SAME tick the new agents start working.
      const chapters = tl.narration_chapters ?? []
      if (chapters.length > 0) {
        for (let i = 0; i < chapters.length; i++) {
          const c = chapters[i]
          if (c.t_start <= target && c.t_start > clockRef.current) {
            // Special case: very first chapter — show its plaque immediately
            // (no "previous chapter" to leave on screen).
            const isFirstChapter = i === 0 && currentChapterIdx < 0
            // Dispatch only events strictly BEFORE the chapter boundary.
            while (
              nextEventIdxRef.current < tl.events.length &&
              tl.events[nextEventIdxRef.current].t < c.t_start
            ) {
              applyEvent(tl.events[nextEventIdxRef.current])
              nextEventIdxRef.current += 1
            }
            clockRef.current = c.t_start
            setClock(c.t_start)
            if (acknowledgedChaptersRef.current.has(c.id)) {
              // Already acknowledged (e.g. after a manual seek). Activate
              // chapter and dispatch its boundary events, keep playing.
              setCurrentChapterIdx(i)
              while (
                nextEventIdxRef.current < tl.events.length &&
                tl.events[nextEventIdxRef.current].t <= c.t_start
              ) {
                applyEvent(tl.events[nextEventIdxRef.current])
                nextEventIdxRef.current += 1
              }
              continue
            }
            if (isFirstChapter) {
              // First chapter: switch immediately, then pause.
              setCurrentChapterIdx(0)
            } else {
              // Subsequent chapter: stage it. The plaque keeps showing the
              // previous chapter until continueChapter() applies the switch.
              stagedNextChapterIdxRef.current = i
            }
            playingRef.current = false
            setPlaying(false)
            setPausedForChapter(true)
            rafRef.current = null
            return
          }
        }
      }
      while (
        nextEventIdxRef.current < tl.events.length &&
        tl.events[nextEventIdxRef.current].t <= target
      ) {
        applyEvent(tl.events[nextEventIdxRef.current])
        nextEventIdxRef.current += 1
      }
      clockRef.current = target
      setClock(target)
      if (target >= tl.duration_seconds) {
        playingRef.current = false
        setPlaying(false)
        setFinished(true)
        rafRef.current = null
        return
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
      rafRef.current = null
      lastFrameRef.current = null
    }
  }, [playing, speed, applyEvent])

  const pause = useCallback(() => setPlaying(false), [])
  const restart = useCallback(() => {
    seekTo(0)
    setPlaying(true)
  }, [seekTo])

  const currentChapter = useMemo(() => {
    if (!timeline || !timeline.narration_chapters || currentChapterIdx < 0) return null
    return timeline.narration_chapters[currentChapterIdx] ?? null
  }, [timeline, currentChapterIdx])

  const state = useMemo<DemoPlayerState>(
    () => ({
      clock, playing, speed, finished, workflow, agents,
      interactivePauseKey, cameraFocus,
      currentChapter, pausedForChapter,
    }),
    [clock, playing, speed, finished, workflow, agents, interactivePauseKey, cameraFocus, currentChapter, pausedForChapter],
  )

  /** Clear an interactive-pause flag and continue playback. */
  const resume = useCallback(() => {
    setInteractivePauseKey(null)
    setPlaying(true)
  }, [])

  /** Advance to the next chapter. Each Continue click moves the demo forward
   *  by exactly one phase — synchronizing plaque switch + new agent activity
   *  in a single tick and skipping any "dead time" between chapters with no
   *  agent activity. */
  const continueChapter = useCallback(() => {
    const tl = timelineRef.current
    if (!tl) return
    const chapters = tl.narration_chapters ?? []

    // Determine the target chapter (staged from boundary, else next of current).
    const staged = stagedNextChapterIdxRef.current
    let nextIdx: number
    if (staged !== null) {
      nextIdx = staged
      stagedNextChapterIdxRef.current = null
    } else if (currentChapter) {
      const curIdx = chapters.findIndex(c => c.id === currentChapter.id)
      nextIdx = curIdx + 1
    } else {
      nextIdx = 0
    }

    // No more chapters → just unpause and play to the end.
    if (nextIdx < 0 || nextIdx >= chapters.length) {
      setPausedForChapter(false)
      setPlaying(true)
      return
    }

    const next = chapters[nextIdx]
    acknowledgedChaptersRef.current.add(next.id)
    // Acknowledge any prior chapter we're leaving behind (so the rAF loop
    // doesn't re-pause when the clock crosses it again on a seek replay).
    if (currentChapter) acknowledgedChaptersRef.current.add(currentChapter.id)

    // Fast-forward through any dead time between current clock and next chapter,
    // dispatching events strictly BEFORE the chapter boundary first.
    if (clockRef.current < next.t_start) {
      while (
        nextEventIdxRef.current < tl.events.length &&
        tl.events[nextEventIdxRef.current].t < next.t_start
      ) {
        applyEvent(tl.events[nextEventIdxRef.current])
        nextEventIdxRef.current += 1
      }
      clockRef.current = next.t_start
      setClock(next.t_start)
    }
    // Atomic chapter switch: update the plaque AND fire the chapter's
    // boundary events (phase_started, camera_focus, agent_started at t == next.t_start)
    // in the same React commit.
    setCurrentChapterIdx(nextIdx)
    while (
      nextEventIdxRef.current < tl.events.length &&
      tl.events[nextEventIdxRef.current].t <= next.t_start
    ) {
      applyEvent(tl.events[nextEventIdxRef.current])
      nextEventIdxRef.current += 1
    }
    setPausedForChapter(false)
    setPlaying(true)
  }, [currentChapter, applyEvent])

  // Улучшатели#4 P2·S — pause/continue race condition.
  // The bottom-bar ▶/⏸ button used to set `playing = true` directly even when
  // the player was paused at a chapter boundary (pausedForChapter === true).
  // That bypassed `continueChapter()`, leaving the plaque on chapter N while
  // the rAF loop raced past the boundary and fired N+1's events. Now play()
  // detects "paused mid-chapter" and routes through continueChapter() so the
  // chapter switch is acknowledged atomically with the resume — the plaque
  // and the new agent activity flip in lock-step, same as clicking Continue.
  // Plain `pause()` is unchanged: stopping the clock from a chapter pause is
  // a no-op (already stopped) and from normal playback just halts as before.
  const play = useCallback(() => {
    if (pausedForChapter) {
      continueChapter()
      return
    }
    setPlaying(true)
  }, [pausedForChapter, continueChapter])

  return {
    state,
    play,
    pause,
    resume,
    continueChapter,
    restart,
    setSpeed,
    seekTo,
  }
}
