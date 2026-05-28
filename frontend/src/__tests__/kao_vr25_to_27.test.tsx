// КАО (Команда Агентов-Отладчиков) — Regression tests for VR-25 / VR-26 / VR-27.
//
// Goals
// =====
//   VR-25  Live preview slideshow replaces the old iframe-based preview in
//          VisualReviewPanel and TournamentMode. The new component must:
//             - render the first captured frame on mount,
//             - advance via Next, retreat via Prev (with wraparound),
//             - auto-advance after (next.t - cur.t) * 1000 ms (clamped 300-4000),
//             - wrap from the last frame back to frame 0 after a 1 s pause,
//             - pause auto-advance when the user clicks the toggle,
//             - render an empty-state for shots.length === 0,
//             - NEVER render an <iframe> (the old preview surface).
//
//   VR-26  Modal now supports `screen-2xl`, `4xl`, `6xl` sizes. Also,
//          SessionDetailPage derives the workflow phase from the agent_type
//          inside the agent_started WS handler (PHASE_BY_AGENT map, now
//          exported at module scope) and guards against redundant setState
//          (prev.phase === derivedPhase ? prev : ...).
//
//   VR-27  apiFetch must surface FastAPI validation errors as a readable
//          message — never "[object Object]".
//
// КАО Round 2 — Minor fixes applied
// ---------------------------------
//   M1  Wrap every Headless UI mount/click in act(...) so React no longer
//       complains. The previous suite emitted 31 "An update to ... inside a
//       test was not wrapped in act(...)" warnings from Modal.Transition's
//       asynchronous state flush. We use userEvent (which auto-wraps in act)
//       for real-timer tests and explicit act() blocks for the fake-timer
//       branch where userEvent's promise-based pipeline doesn't compose with
//       vi.useFakeTimers cleanly.
//   M2  Removed the file-wide `// @ts-nocheck` and fixed up the resulting TS
//       errors (proper typing of caught errors, helper return types, etc.).
//   M4  PHASE_BY_AGENT is now an exported module-level constant in
//       SessionDetailPage. The static greps stay (belt-and-braces) but the
//       runtime import is the load-bearing assertion.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import Modal from '../components/common/Modal'
import VisualReviewPanel from '../components/graph/VisualReviewPanel'
import { apiFetch } from '../services/api'
import { PHASE_BY_AGENT } from '../pages/SessionDetailPage'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FRONTEND_ROOT = resolve(__dirname, '..', '..')

function readSrc(rel: string): string {
  return readFileSync(resolve(FRONTEND_ROOT, rel), 'utf8')
}

// ---------------------------------------------------------------------------
// Shared cleanup so React Testing Library doesn't leak DOM nodes between tests.
// ---------------------------------------------------------------------------
afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Test helpers (M1)
// ---------------------------------------------------------------------------
//
// flushAsync: drain microtasks + macrotasks inside an act() block so Headless
// UI's post-mount setState (which fires from a Promise.resolve().then() in
// the Transition component) is captured by React's test renderer instead of
// leaking out as a warning. Works under BOTH real and fake timers.
async function flushAsync(): Promise<void> {
  // Two passes through the microtask queue cover Headless UI's two-step
  // mount transition (Promise.resolve().then(...).then(...)).
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

// ===========================================================================
// VR-25 — Live preview slideshow
// ===========================================================================

describe('VR-25: LivePreviewSlideshow (in VisualReviewPanel)', () => {
  const VR_PANEL_SRC = readSrc('src/components/graph/VisualReviewPanel.tsx')
  const TOURNAMENT_SRC = readSrc('src/components/graph/TournamentMode.tsx')

  // --- Static invariants --------------------------------------------------

  it('VisualReviewPanel source defines a LivePreviewSlideshow component', () => {
    expect(VR_PANEL_SRC).toMatch(/function\s+LivePreviewSlideshow\s*\(/)
  })

  it('VisualReviewPanel uses the captured-PNG cadence formula (next.t - cur.t) * 1000', () => {
    expect(VR_PANEL_SRC).toMatch(/next\.t_seconds\s*-\s*cur\.t_seconds/)
    expect(VR_PANEL_SRC).toMatch(/\)\s*\*\s*1000/)
  })

  it('VisualReviewPanel wrap pause is 1000 ms when on the last frame', () => {
    // "waitMs = 1000" or " = 1000 " inside the wrap branch.
    expect(VR_PANEL_SRC).toMatch(/waitMs\s*=\s*1000/)
  })

  it('VisualReviewPanel renders the empty-state copy for shots.length === 0', () => {
    expect(VR_PANEL_SRC).toContain('No screenshots captured')
  })

  it('VisualReviewPanel slideshow exposes Prev / Pause / Next controls', () => {
    expect(VR_PANEL_SRC).toMatch(/Prev/)
    expect(VR_PANEL_SRC).toMatch(/Pause/)
    expect(VR_PANEL_SRC).toMatch(/Next/)
  })

  it('VisualReviewPanel no longer embeds an <iframe> for live preview', () => {
    // Old design used <iframe src=...>. The replacement is pure <img>.
    // Strip line + block comments so a historical reference inside a // comment
    // doesn't trip the scan — we care about live JSX, not prose.
    const stripped = VR_PANEL_SRC
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(stripped).not.toMatch(/<iframe[\s>]/)
  })

  it('TournamentMode no longer embeds an <iframe> for live preview', () => {
    const stripped = TOURNAMENT_SRC
      .replace(/\/\/.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    expect(stripped).not.toMatch(/<iframe[\s>]/)
  })

  it('TournamentMode applies the same slideshow pattern', () => {
    // Either inlined or imported — both should produce the same DOM signature.
    expect(TOURNAMENT_SRC).toMatch(/screenshot|frame_index|t_seconds/i)
  })

  // --- Dynamic render through VisualReviewPanel (forceMock) ---------------
  //
  // forceMock seeds 2 candidates × 5 screenshots with t = 0, 0.5, 1.0, 1.5, 2.0.
  // The "Live preview" button opens a Modal hosting LivePreviewSlideshow.
  //
  // M1: every interaction goes through userEvent (auto-wraps in act). The
  // three timer-driven tests below open the modal under real timers, then
  // switch to fake timers ONLY for the slideshow setTimeout assertion. This
  // keeps Headless UI's Transition mount sequence on real timers (where its
  // promise chain settles cleanly) while still giving us a deterministic
  // tick for the assertion.

  it('renders the first frame, then advances on Next / wraps on Prev', async () => {
    const user = userEvent.setup()
    render(<VisualReviewPanel sessionId="sess-1" onClose={() => {}} forceMock />)

    // Open the Live preview modal for the first candidate.
    const buttons = await screen.findAllByRole('button', { name: /Live preview/i })
    await user.click(buttons[0])

    // Frame 1 / 5 is visible immediately (findBy* waits for the modal to flush).
    expect(await screen.findByText(/Frame 1 \/ 5/)).toBeTruthy()

    // Pause auto-advance so the manual clicks aren't racing the timer.
    await user.click(await screen.findByRole('button', { name: /Pause/i }))

    await user.click(await screen.findByRole('button', { name: /Next/i }))
    expect(await screen.findByText(/Frame 2 \/ 5/)).toBeTruthy()

    await user.click(await screen.findByRole('button', { name: /Prev/i }))
    expect(await screen.findByText(/Frame 1 \/ 5/)).toBeTruthy()

    // Prev from frame 1 wraps to the last frame.
    await user.click(await screen.findByRole('button', { name: /Prev/i }))
    expect(await screen.findByText(/Frame 5 \/ 5/)).toBeTruthy()
  })

  // Tactical note for the three fake-timer tests below:
  //   Fake timers must be installed BEFORE render so the slideshow's first
  //   setTimeout (scheduled from useEffect) lands in the fake queue. After
  //   clicking the Live preview button we drain the Headless UI Transition
  //   chain via a microtask + zero-tick loop wrapped in act() — that
  //   absorbs the post-mount setState without firing any user-scheduled
  //   timer (we'd race past the assertion frame if we did).

  async function openModalUnderFakeTimers(): Promise<void> {
    // Headless UI's modal mount fires several Promise.resolve().then(...)
    // hops plus a few queued setTimeout(0)/RAF callbacks. We drain both
    // inside act() so the setStates are captured, but use advanceTimersByTime(0)
    // (which fires only timers due at t=0) so we don't accidentally trip
    // the slideshow's auto-advance timer (>= 300 ms).
    const buttons = screen.getAllByRole('button', { name: /Live preview/i })
    await act(async () => {
      buttons[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
      for (let i = 0; i < 8; i++) {
        await Promise.resolve()
        vi.advanceTimersByTime(0)
      }
    })
  }

  async function clickInModal(name: RegExp): Promise<void> {
    const btn = screen.getByRole('button', { name })
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      for (let i = 0; i < 4; i++) {
        await Promise.resolve()
        vi.advanceTimersByTime(0)
      }
    })
  }

  it('Pause stops auto-advance (no frame change after a tick of fake time)', async () => {
    vi.useFakeTimers()
    try {
      render(<VisualReviewPanel sessionId="sess-2" onClose={() => {}} forceMock />)
      await openModalUnderFakeTimers()
      expect(screen.getByText(/Frame 1 \/ 5/)).toBeTruthy()

      // Pause, then jump 5 seconds — frame index must not change.
      await clickInModal(/Pause/i)
      await act(async () => {
        vi.advanceTimersByTime(5_000)
      })
      expect(screen.getByText(/Frame 1 \/ 5/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('auto-advance fires using the clamped gap between t_seconds', async () => {
    vi.useFakeTimers()
    try {
      render(<VisualReviewPanel sessionId="sess-3" onClose={() => {}} forceMock />)
      await openModalUnderFakeTimers()
      expect(screen.getByText(/Frame 1 \/ 5/)).toBeTruthy()

      // Mock cadence: frames at 0.0s, 0.5s → 500 ms gap (above the 300 ms floor).
      await act(async () => {
        vi.advanceTimersByTime(500)
      })
      expect(screen.getByText(/Frame 2 \/ 5/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('wraps from the last frame back to frame 0 after the 1 s pause', async () => {
    vi.useFakeTimers()
    try {
      render(<VisualReviewPanel sessionId="sess-4" onClose={() => {}} forceMock />)
      await openModalUnderFakeTimers()

      // Pause to use manual nav, jump to the last frame, then re-play.
      await clickInModal(/Pause/i)
      await clickInModal(/Prev/i) // wrap to last
      expect(screen.getByText(/Frame 5 \/ 5/)).toBeTruthy()

      await clickInModal(/Play/i)
      await act(async () => {
        vi.advanceTimersByTime(1_000)
      })
      expect(screen.getByText(/Frame 1 \/ 5/)).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Live preview modal never renders an <iframe>', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <VisualReviewPanel sessionId="sess-5" onClose={() => {}} forceMock />,
    )

    const buttons = await screen.findAllByRole('button', { name: /Live preview/i })
    await user.click(buttons[0])

    // Wait for the modal to flush before asserting on it.
    await screen.findByText(/Frame 1 \/ 5/)

    // Both inside the panel root and globally via document — the modal is a portal.
    expect(container.querySelector('iframe')).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
  })
})

// ===========================================================================
// VR-26 — Modal sizes + phase derivation
// ===========================================================================

describe('VR-26: Modal sizes', () => {
  // M1: each Modal render triggers a Headless UI Transition mount whose post-
  // commit setState used to leak past the test boundary. flushAsync() inside
  // an act() block absorbs that update so the assertion runs against settled
  // DOM and no warning is emitted.

  it('size="screen-2xl" applies max-w-screen-2xl', async () => {
    render(
      <Modal open onClose={() => {}} title="t" size="screen-2xl">
        body
      </Modal>,
    )
    await flushAsync()
    expect(document.querySelector('.max-w-screen-2xl')).not.toBeNull()
  })

  it('size="4xl" applies max-w-4xl', async () => {
    render(
      <Modal open onClose={() => {}} title="t" size="4xl">
        body
      </Modal>,
    )
    await flushAsync()
    expect(document.querySelector('.max-w-4xl')).not.toBeNull()
  })

  it('size="6xl" applies max-w-6xl', async () => {
    render(
      <Modal open onClose={() => {}} title="t" size="6xl">
        body
      </Modal>,
    )
    await flushAsync()
    expect(document.querySelector('.max-w-6xl')).not.toBeNull()
  })

  it('still supports the legacy size="2xl"', async () => {
    render(
      <Modal open onClose={() => {}} title="t" size="2xl">
        body
      </Modal>,
    )
    await flushAsync()
    expect(document.querySelector('.max-w-2xl')).not.toBeNull()
  })
})

describe('VR-26: PHASE_BY_AGENT mapping + re-render guard', () => {
  // M4 (КАО Round 2): PHASE_BY_AGENT is now an exported module-level const,
  // so we runtime-validate it via import. The static SDP_SRC scans stay as
  // belt-and-braces — they ensure the constant is still referenced inside
  // the agent_started handler and the re-render guard is in place.
  const SDP_SRC = readSrc('src/pages/SessionDetailPage.tsx')

  it('still references PHASE_BY_AGENT inside the agent_started handler', () => {
    // The map literal lives at module scope but the consumer is inside the
    // `case 'agent_started':` block — the static scan keeps that wiring honest.
    expect(SDP_SRC).toMatch(/case 'agent_started':[\s\S]+?PHASE_BY_AGENT/)
  })

  // Runtime-validated pairs — drift in production code surfaces here directly
  // instead of through a fragile string match.
  const expectedPairs: Array<[keyof typeof PHASE_BY_AGENT, string]> = [
    ['coder', 'coding'],
    ['tester', 'testing'],
    ['summarizer', 'summarizing'],
    ['finalizer', 'finalizing'],
    ['enhancer', 'enhancing'],
    ['enhancer_summarizer', 'enhancing'],
  ]

  for (const [agent, phase] of expectedPairs) {
    it(`maps ${agent} -> ${phase}`, () => {
      expect(PHASE_BY_AGENT[agent]).toBe(phase)
    })
  }

  it('PHASE_BY_AGENT has no surprise extra keys', () => {
    // Locks the surface: if a new agent type is added, the test author must
    // think about whether it deserves a phase here.
    expect(Object.keys(PHASE_BY_AGENT).sort()).toEqual([
      'coder',
      'enhancer',
      'enhancer_summarizer',
      'finalizer',
      'summarizer',
      'tester',
    ])
  })

  it('guards against redundant setWorkflowState calls (prev.phase === derivedPhase ? prev : ...)', () => {
    expect(SDP_SRC).toMatch(/prev\.phase\s*===\s*derivedPhase\s*\?\s*prev\s*:/)
  })
})

// ===========================================================================
// VR-27 — apiFetch validation-error stringification
// ===========================================================================

describe('VR-27: apiFetch error message stringification', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    // Each test installs its own fetch mock.
    globalThis.fetch = vi.fn() as typeof globalThis.fetch
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  function mockFetchOnce(status: number, body: unknown): void {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    } as unknown as Response)
  }

  it('flattens FastAPI validation array into "loc: msg" segments (not [object Object])', async () => {
    mockFetchOnce(422, {
      detail: [
        {
          loc: ['body', 'scores', 0, 'score'],
          msg: 'Input should be a valid integer',
          type: 'int_from_float',
        },
      ],
    })

    let caught: unknown
    try {
      await apiFetch('/x')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    const message = (caught as Error).message
    expect(message).toContain('body.scores.0.score')
    expect(message).toContain('Input should be a valid integer')
    expect(message).not.toContain('[object Object]')
  })

  it('passes through a plain string detail', async () => {
    mockFetchOnce(422, { detail: 'simple string' })

    let caught: unknown
    try {
      await apiFetch('/x')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('simple string')
  })

  it('JSON.stringifies a non-array object detail', async () => {
    mockFetchOnce(422, { detail: { nested: 'object' } })

    let caught: unknown
    try {
      await apiFetch('/x')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('{"nested":"object"}')
  })

  it('falls back to "API error: <status>" when there is no detail field', async () => {
    mockFetchOnce(500, {})

    let caught: unknown
    try {
      await apiFetch('/x')
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('API error: 500')
  })
})
