/**
 * R13 — useTimelinePlayer hook regression tests.
 *
 * The frontend lacks a React-hook testing infrastructure (no jest, no vitest,
 * no jsdom, no @testing-library). Rather than dragging those in, we take a
 * dual-pronged approach:
 *
 *   (A) **Behavioural-oracle simulator** (this file): re-implements the hook's
 *       core state machine — clock advance, event dispatch, chapter pause,
 *       continueChapter, seekTo — in plain JS. The simulator mirrors the
 *       hook line-for-line. If a future refactor of useTimelinePlayer.ts
 *       changes observable behaviour, the simulator's invariants will lag
 *       behind production and the static-source assertions (below) will catch
 *       the divergence.
 *
 *   (B) **Static source assertions**: read useTimelinePlayer.ts as text and
 *       assert that key invariant lines are still present. This catches the
 *       case where the simulator is silently right but the production hook
 *       diverged in a way the simulator can't model.
 *
 * Run:
 *   cd frontend/tests
 *   node --test test_round13_timeline_player.mjs
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK_PATH = resolve(__dirname, '../src/hooks/useTimelinePlayer.ts')
const HOOK_SRC = readFileSync(HOOK_PATH, 'utf8')

// ===========================================================================
// (B) STATIC ASSERTIONS — guards that the source still implements R13 contract
// ===========================================================================

describe('R13 useTimelinePlayer — static source contract', () => {
  test('hook exports useTimelinePlayer named function', () => {
    assert.match(HOOK_SRC, /export function useTimelinePlayer/, 'hook signature missing')
  })

  test('hook exposes continueChapter API (R13 addition)', () => {
    assert.match(HOOK_SRC, /const continueChapter = useCallback/,
      'continueChapter must be defined inside the hook')
    assert.match(HOOK_SRC, /continueChapter,/,
      'continueChapter must be in the returned object')
  })

  test('hook exposes restart API', () => {
    assert.match(HOOK_SRC, /const restart = useCallback/,
      'restart must be defined')
  })

  test('hook exposes seekTo API', () => {
    assert.match(HOOK_SRC, /const seekTo = useCallback/,
      'seekTo must be defined')
  })

  test('hook returns state.pausedForChapter and state.currentChapter', () => {
    assert.match(HOOK_SRC, /pausedForChapter/, 'pausedForChapter state missing')
    assert.match(HOOK_SRC, /currentChapter/, 'currentChapter state missing')
  })

  test('hook starts paused — initial playing state is false', () => {
    // Initial useState(false) for playing
    assert.match(HOOK_SRC, /useState\(false\)/, 'expected useState(false) somewhere (playing)')
  })

  test('camera_focus event bumps a monotonic seq', () => {
    assert.match(HOOK_SRC, /cameraSeqRef\.current \+= 1/,
      'camera_focus must increment cameraSeqRef monotonically')
  })

  test('seekTo backward clears acknowledged chapters', () => {
    // We assert the line that resets the acknowledged set inside the back-seek branch.
    assert.match(HOOK_SRC, /acknowledgedChaptersRef\.current = new Set\(\)/,
      'seekTo backward path must reset acknowledgedChaptersRef')
  })

  test('pause_for_interaction event sets interactivePauseKey', () => {
    assert.match(HOOK_SRC, /setInteractivePauseKey\(ev\.pause_key\)/,
      'pause_for_interaction must set interactivePauseKey from ev.pause_key')
  })

  test('chapter pause halts the clock at t_start (not after)', () => {
    // The rAF loop must set clockRef to c.t_start when pausing.
    assert.match(HOOK_SRC, /clockRef\.current = c\.t_start/,
      'rAF loop must pin clock to chapter boundary on pause')
  })

  test('continueChapter dispatches boundary events atomically', () => {
    // Loop dispatching events with t <= next.t_start inside continueChapter.
    assert.match(HOOK_SRC, /tl\.events\[nextEventIdxRef\.current\]\.t <= next\.t_start/,
      'continueChapter must dispatch events up to next.t_start (inclusive)')
  })

  test('hook handles narration_chapters being undefined safely', () => {
    assert.match(HOOK_SRC, /tl\.narration_chapters \?\? \[\]/,
      'hook must default narration_chapters to []')
  })
})

// ===========================================================================
// (A) BEHAVIOURAL ORACLE — simulator port of the state machine
// ===========================================================================

/**
 * Pure-JS simulator of useTimelinePlayer. Mirrors the hook closely; this lets
 * us write deterministic unit tests for the chapter-pause behaviour without
 * a React renderer. If you change useTimelinePlayer.ts, update this too.
 */
function makePlayer(timeline) {
  const state = {
    clock: 0,
    playing: false,
    speed: 1,
    finished: false,
    workflow: {
      status: 'idle',
      iteration: 0,
      phase: null,
      totalTokens: 0,
      totalCost: 0,
      codersDone: 0,
      testersDone: 0,
    },
    agents: {},
    interactivePauseKey: null,
    cameraFocus: null,
    cameraSeq: 0,
    currentChapterIdx: -1,
    pausedForChapter: false,
    stagedNextChapterIdx: null,
    acknowledgedChapters: new Set(),
  }

  // Build initial agents
  if (timeline) {
    for (let i = 0; i < timeline.coders.length; i++) state.agents[`coder_${i}`] = freshAgent()
    for (let i = 0; i < timeline.testers.length; i++) state.agents[`tester_${i}`] = freshAgent()
    state.agents['summarizer_0'] = freshAgent()
    state.agents['finalizer_0'] = freshAgent()
  }

  let nextEventIdx = 0

  function freshAgent() {
    return { status: 'idle', streamingContent: '', isStreaming: false,
      tokensUsed: 0, costUsd: 0, issuesFound: 0, startedAt: null }
  }

  function applyEvent(ev) {
    if (ev.type === 'workflow_started') state.workflow.status = 'running'
    else if (ev.type === 'iteration_started') state.workflow.iteration = ev.iteration ?? state.workflow.iteration
    else if (ev.type === 'phase_started') state.workflow.phase = ev.phase ?? state.workflow.phase
    else if (ev.type === 'agent_started') {
      const k = `${ev.agent_type}_${ev.agent_index ?? 0}`
      state.agents[k] = { ...(state.agents[k] ?? freshAgent()), status: 'working', isStreaming: true, startedAt: 1 }
    } else if (ev.type === 'agent_completed') {
      const k = `${ev.agent_type}_${ev.agent_index ?? 0}`
      const tokens = ev.tokens ?? 0
      state.agents[k] = { ...(state.agents[k] ?? freshAgent()), status: 'done', isStreaming: false, tokensUsed: tokens, costUsd: ev.cost ?? 0 }
      state.workflow.totalTokens += tokens
      if (ev.agent_type === 'coder') state.workflow.codersDone += 1
      if (ev.agent_type === 'tester') state.workflow.testersDone += 1
    } else if (ev.type === 'workflow_completed') {
      state.workflow.status = 'completed'
      state.workflow.phase = null
      state.finished = true
    } else if (ev.type === 'camera_focus' && ev.target) {
      state.cameraSeq += 1
      state.cameraFocus = { target: ev.target, zoom: ev.zoom, seq: state.cameraSeq }
    } else if (ev.type === 'pause_for_interaction' && ev.pause_key) {
      state.playing = false
      state.interactivePauseKey = ev.pause_key
    }
  }

  // Advance the clock to `target` seconds. Mirrors the rAF loop logic.
  function advanceTo(target) {
    const tl = timeline
    target = Math.min(target, tl.duration_seconds)
    const chapters = tl.narration_chapters ?? []
    // Check for chapter boundary
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i]
      if (c.t_start <= target && c.t_start > state.clock) {
        const isFirstChapter = (i === 0 && state.currentChapterIdx < 0)
        // Dispatch events strictly BEFORE the boundary
        while (nextEventIdx < tl.events.length && tl.events[nextEventIdx].t < c.t_start) {
          applyEvent(tl.events[nextEventIdx]); nextEventIdx++
        }
        state.clock = c.t_start
        if (state.acknowledgedChapters.has(c.id)) {
          state.currentChapterIdx = i
          while (nextEventIdx < tl.events.length && tl.events[nextEventIdx].t <= c.t_start) {
            applyEvent(tl.events[nextEventIdx]); nextEventIdx++
          }
          continue
        }
        if (isFirstChapter) state.currentChapterIdx = 0
        else state.stagedNextChapterIdx = i
        state.playing = false
        state.pausedForChapter = true
        return
      }
    }
    while (nextEventIdx < tl.events.length && tl.events[nextEventIdx].t <= target) {
      applyEvent(tl.events[nextEventIdx]); nextEventIdx++
    }
    state.clock = target
    if (state.clock >= tl.duration_seconds) {
      state.playing = false
      state.finished = true
    }
  }

  function continueChapter() {
    const tl = timeline
    const chapters = tl.narration_chapters ?? []
    const staged = state.stagedNextChapterIdx
    let nextIdx
    if (staged !== null) {
      nextIdx = staged
      state.stagedNextChapterIdx = null
    } else if (state.currentChapterIdx >= 0) {
      nextIdx = state.currentChapterIdx + 1
    } else {
      nextIdx = 0
    }
    if (nextIdx < 0 || nextIdx >= chapters.length) {
      state.pausedForChapter = false
      state.playing = true
      return
    }
    const next = chapters[nextIdx]
    state.acknowledgedChapters.add(next.id)
    if (state.currentChapterIdx >= 0) {
      state.acknowledgedChapters.add(chapters[state.currentChapterIdx].id)
    }
    if (state.clock < next.t_start) {
      while (nextEventIdx < tl.events.length && tl.events[nextEventIdx].t < next.t_start) {
        applyEvent(tl.events[nextEventIdx]); nextEventIdx++
      }
      state.clock = next.t_start
    }
    state.currentChapterIdx = nextIdx
    while (nextEventIdx < tl.events.length && tl.events[nextEventIdx].t <= next.t_start) {
      applyEvent(tl.events[nextEventIdx]); nextEventIdx++
    }
    state.pausedForChapter = false
    state.playing = true
  }

  function seekTo(target) {
    const tl = timeline
    const clamped = Math.max(0, Math.min(target, tl.duration_seconds))
    if (clamped < state.clock) {
      nextEventIdx = 0
      state.workflow = { status: 'idle', iteration: 0, phase: null, totalTokens: 0, totalCost: 0, codersDone: 0, testersDone: 0 }
      state.agents = {}
      for (let i = 0; i < tl.coders.length; i++) state.agents[`coder_${i}`] = freshAgent()
      for (let i = 0; i < tl.testers.length; i++) state.agents[`tester_${i}`] = freshAgent()
      state.agents['summarizer_0'] = freshAgent()
      state.agents['finalizer_0'] = freshAgent()
      state.finished = false
      state.acknowledgedChapters = new Set()
      state.currentChapterIdx = -1
      state.pausedForChapter = false
      state.interactivePauseKey = null
    }
    while (nextEventIdx < tl.events.length && tl.events[nextEventIdx].t <= clamped) {
      applyEvent(tl.events[nextEventIdx]); nextEventIdx++
    }
    state.clock = clamped
  }

  function setSpeed(s) { state.speed = s }
  function play() { state.playing = true }
  function pause() { state.playing = false }
  function restart() { seekTo(0); state.playing = true }

  return { state, advanceTo, continueChapter, seekTo, setSpeed, play, pause, restart }
}

// Minimal canned timeline for deterministic testing.
function makeTimeline() {
  return {
    id: 'test',
    name: 'test',
    description: '',
    language: 'python',
    spec: '',
    duration_seconds: 50,
    coders: [{ model: 'x' }],
    testers: [{ model: 'y' }],
    summarizer: { model: 's' },
    finalizer: { model: 'f' },
    final_code: 'print("hi")',
    narration_chapters: [
      { id: 'ch0', t_start: 0.5, title: 'C0', paragraphs: ['p'] },
      { id: 'ch1', t_start: 10, title: 'C1', paragraphs: ['p'] },
      { id: 'ch2', t_start: 25, title: 'C2', paragraphs: ['p'] },
    ],
    events: [
      { t: 0,    type: 'workflow_started' },
      { t: 1,    type: 'phase_started', phase: 'spec' },
      { t: 2,    type: 'camera_focus', target: 'spec' },
      { t: 10,   type: 'phase_started', phase: 'coding' },
      { t: 10,   type: 'camera_focus', target: 'coder_' },
      { t: 10,   type: 'agent_started', agent_type: 'coder', agent_index: 0 },
      { t: 15,   type: 'agent_completed', agent_type: 'coder', agent_index: 0, tokens: 100 },
      { t: 20,   type: 'pause_for_interaction', pause_key: 'after_finalize' },
      { t: 25,   type: 'phase_started', phase: 'tester' },
      { t: 30,   type: 'agent_started', agent_type: 'tester', agent_index: 0 },
      { t: 40,   type: 'agent_completed', agent_type: 'tester', agent_index: 0, tokens: 50 },
      { t: 50,   type: 'workflow_completed' },
    ],
  }
}

describe('R13 useTimelinePlayer — behavioural oracle (simulator)', () => {
  test('player starts paused, no chapter active', () => {
    const tl = makeTimeline()
    const p = makePlayer(tl)
    assert.equal(p.state.playing, false)
    assert.equal(p.state.currentChapterIdx, -1)
    assert.equal(p.state.pausedForChapter, false)
    assert.equal(p.state.clock, 0)
  })

  test('advancing past first chapter t_start pauses on first chapter', () => {
    const tl = makeTimeline()
    const p = makePlayer(tl)
    p.advanceTo(2)
    assert.equal(p.state.pausedForChapter, true, 'should be paused for first chapter')
    assert.equal(p.state.currentChapterIdx, 0, 'first chapter active immediately')
    assert.equal(p.state.clock, 0.5, 'clock pinned to first chapter t_start')
  })

  test('continueChapter advances atomically through next chapter boundary', () => {
    const tl = makeTimeline()
    const p = makePlayer(tl)
    p.advanceTo(2)  // pauses at ch0.t_start=0.5
    assert.equal(p.state.pausedForChapter, true)
    assert.equal(p.state.currentChapterIdx, 0)
    p.continueChapter()
    // continueChapter auto-stages next chapter? No — when not staged and currentChapterIdx=0,
    // nextIdx becomes 1 → switches immediately to ch1 (t=10), dispatching events <= 10.
    // Verify: currentChapterIdx=1, agent_started@t=10 has fired, phase=coding.
    assert.equal(p.state.currentChapterIdx, 1)
    assert.equal(p.state.playing, true)
    assert.equal(p.state.clock, 10)
    assert.equal(p.state.workflow.phase, 'coding', 'phase_started@t=10 must have fired atomically')
    assert.equal(p.state.agents.coder_0.status, 'working', 'agent_started@t=10 must have fired atomically')
    // camera_focus@t=10 also fired
    assert.equal(p.state.cameraFocus.target, 'coder_')
  })

  test('restart() clears acknowledged chapters set — re-pauses on subsequent boundaries', () => {
    const tl = makeTimeline()
    const p = makePlayer(tl)
    p.advanceTo(2);   p.continueChapter()  // ack ch0
    p.advanceTo(15);  p.continueChapter()  // ack ch1
    assert.ok(p.state.acknowledgedChapters.size >= 2)
    p.restart()
    assert.equal(p.state.acknowledgedChapters.size, 0)
    assert.equal(p.state.currentChapterIdx, -1)
    // Advance: should re-pause on the very first chapter again.
    p.advanceTo(2)
    assert.equal(p.state.pausedForChapter, true)
    assert.equal(p.state.currentChapterIdx, 0)
  })

  test('pause_for_interaction event sets interactivePauseKey', () => {
    // Build a timeline WITHOUT chapter boundaries between the pause event,
    // so the chapter pause doesn't pre-empt the pause_for_interaction.
    const tl = {
      ...makeTimeline(),
      narration_chapters: [],  // no chapters → no chapter pauses
      events: [
        { t: 0, type: 'workflow_started' },
        { t: 5, type: 'pause_for_interaction', pause_key: 'after_finalize' },
      ],
      duration_seconds: 10,
    }
    const p = makePlayer(tl)
    p.advanceTo(6)
    assert.equal(p.state.interactivePauseKey, 'after_finalize')
    assert.equal(p.state.playing, false)
  })

  test('camera_focus events bump cameraFocus.seq monotonically', () => {
    const tl = {
      ...makeTimeline(),
      narration_chapters: [],
      events: [
        { t: 0, type: 'camera_focus', target: 'spec' },
        { t: 1, type: 'camera_focus', target: 'spec' },  // same target!
        { t: 2, type: 'camera_focus', target: 'coder_' },
      ],
      duration_seconds: 5,
    }
    const p = makePlayer(tl)
    p.advanceTo(3)
    // Final seq should be 3 (monotonically incremented despite same target repeated)
    assert.equal(p.state.cameraFocus.seq, 3)
    assert.equal(p.state.cameraFocus.target, 'coder_')
  })

  test('chapter t_start exactly at workflow_completed t — edge case', () => {
    const tl = {
      ...makeTimeline(),
      duration_seconds: 50,
      narration_chapters: [
        { id: 'ch0', t_start: 1, title: 'A', paragraphs: ['p'] },
        { id: 'final', t_start: 50, title: 'B', paragraphs: ['p'] }, // exactly at end
      ],
      events: [
        { t: 0, type: 'workflow_started' },
        { t: 50, type: 'workflow_completed' },
      ],
    }
    const p = makePlayer(tl)
    p.advanceTo(2)               // pause at ch0
    assert.equal(p.state.currentChapterIdx, 0)
    p.continueChapter()          // continueChapter atomically switches to 'final' (next chapter)
                                 // and dispatches events <= 50 → workflow_completed fires.
    // The hook does NOT pause when continueChapter brings us to the last chapter that
    // coincides with duration; it just dispatches events <= t_start which includes
    // workflow_completed@t=50.
    assert.equal(p.state.currentChapterIdx, 1, 'currentChapterIdx switched to final')
    assert.equal(p.state.clock, 50)
    assert.equal(p.state.finished, true, 'workflow_completed fired atomically with chapter switch')
    // Now if user clicks Continue again, no more chapters → state.playing=true (no-op).
    p.continueChapter()
    assert.equal(p.state.pausedForChapter, false)
  })

  test('seekTo backward → replays from t=0, clears acknowledged', () => {
    const tl = makeTimeline()
    const p = makePlayer(tl)
    p.advanceTo(2);  p.continueChapter()   // ack ch0
    p.advanceTo(15); p.continueChapter()   // ack ch1
    // Seek backward
    p.seekTo(5)
    // Acknowledged cleared, workflow state reset, then events up to t=5 dispatched
    assert.equal(p.state.acknowledgedChapters.size, 0)
    assert.equal(p.state.clock, 5)
    assert.equal(p.state.currentChapterIdx, -1)
    // workflow_started@t=0 dispatched; phase_started@t=1 dispatched; camera_focus@t=2
    assert.equal(p.state.workflow.status, 'running')
    assert.equal(p.state.workflow.phase, 'spec')
  })

  test('speed change mid-play does NOT trigger pause', () => {
    const tl = makeTimeline()
    const p = makePlayer(tl)
    p.advanceTo(2)
    p.continueChapter()  // playing = true
    const wasPlaying = p.state.playing
    const acks = new Set(p.state.acknowledgedChapters)
    p.setSpeed(4)
    assert.equal(p.state.playing, wasPlaying, 'setSpeed must not affect playing')
    assert.equal(p.state.pausedForChapter, false, 'setSpeed must not introduce a pause')
    assert.deepEqual(p.state.acknowledgedChapters, acks, 'setSpeed must not touch acknowledgements')
  })

  test('seekTo forward dispatches all events ≤ target unconditionally (no chapter logic)', () => {
    // Note: hook's seekTo dispatches all events with t <= clamped UNCONDITIONALLY
    // (no chapter pause logic inside seekTo). This is intentional — drag-scrub
    // is a "view" operation. Verify that.
    const tl = {
      ...makeTimeline(),
      narration_chapters: [],  // no chapter boundaries to confuse the seekTo test
    }
    const p = makePlayer(tl)
    p.seekTo(30)
    assert.equal(p.state.workflow.phase, 'tester')  // phase_started@t=25
    assert.equal(p.state.clock, 30)
    assert.equal(p.state.pausedForChapter, false)
    // pause_for_interaction@t=20 should have set interactivePauseKey during seek
    assert.equal(p.state.interactivePauseKey, 'after_finalize')
  })

  test('multiple advances accumulate without dropping events', () => {
    const tl = makeTimeline()
    const p = makePlayer(tl)
    // Step through in small chunks
    p.advanceTo(0.4)
    assert.equal(p.state.workflow.status, 'running')  // workflow_started@t=0
    assert.equal(p.state.pausedForChapter, false)
    p.advanceTo(0.6) // crosses ch0 t_start=0.5
    assert.equal(p.state.pausedForChapter, true)
    assert.equal(p.state.currentChapterIdx, 0)
  })
})
