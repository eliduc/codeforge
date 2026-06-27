// КАО#UX-audit — regression coverage for the UI/UX audit fixes (КАО#UX-1…16b).
//
// Testing strategy (testing-trophy / gold standard):
//   • Behavioural component tests (RTL + user-event) are the core — they assert
//     observable behaviour via accessible queries (role/text/label), not
//     implementation details, and run in jsdom with no live backend.
//   • Source-contract assertions are used ONLY for the 6k-line SessionDetailPage
//     and DemoPlayerPage, where jsdom can't render/measure the ReactFlow graph
//     or compute layout — matching the convention the rest of this suite already
//     follows (see kao_vr35_to_43_uiux.test.tsx).
//   • Pure layout/responsive contracts (control-bar overflow, demos grid wrap)
//     live in Playwright (e2e/), since jsdom has no layout engine.
//
// Pairs with the e2e regression tests for КАО#UX-11/13/14/15 in e2e/tests/.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '@testing-library/jest-dom/vitest'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = resolve(__dirname, '..', '..')
const readSrc = (rel: string) => readFileSync(resolve(FRONTEND_ROOT, rel), 'utf8')

// ── shared mocks ────────────────────────────────────────────────────────────
// useNavigate is spied so we can assert navigation targets; everything else in
// react-router-dom (Link, MemoryRouter, …) stays real.
const navigateSpy = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigateSpy }
})

// getSessions is the only api call exercised here (CommandPalette session
// search); keep the rest of the module real.
vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>()
  return {
    ...actual,
    getSessions: vi.fn().mockResolvedValue({
      items: [
        { id: 'sess-mandel-1', name: 'Mandelbulb explorer', status: 'completed' },
        { id: 'sess-life-2', name: 'Game of Life', status: 'running' },
      ],
      total: 2,
      skip: 0,
      limit: 50,
    }),
  }
})

// providersStore.fetchProviders fires on NewSessionPage mount — stub it so the
// page renders without touching the network.
vi.mock('../stores/providersStore', () => ({
  useProvidersStore: (selector?: (s: unknown) => unknown) => {
    const state = {
      providers: [],
      fetchProviders: vi.fn(),
      hasAnyConfigured: true,
      loaded: true,
    }
    return selector ? selector(state) : state
  },
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// ===========================================================================
// КАО#UX-2 — Login cold-start CTA
// ===========================================================================
describe('КАО#UX-2 — LoginPage demo CTA', () => {
  it('renders a "Watch a demo first" link pointing at the public /demos route', async () => {
    const { default: LoginPage } = await import('../pages/LoginPage')
    render(<MemoryRouter><LoginPage /></MemoryRouter>)

    const cta = screen.getByRole('link', { name: /watch a demo first/i })
    expect(cta).toBeInTheDocument()
    expect(cta).toHaveAttribute('href', '/demos')
    // The value prop that motivates the click is present.
    expect(screen.getByText(/no account needed/i)).toBeInTheDocument()
    // The primary email sign-in path is still the dominant action.
    expect(screen.getByRole('button', { name: /send code/i })).toBeInTheDocument()
  })
})

// ===========================================================================
// КАО#UX-6 — Visual Review: user-score precedence note
// ===========================================================================
describe('КАО#UX-6 — VisualReviewPanel precedence note', () => {
  it('tells the user their scores outrank the AI vision scores', async () => {
    const { default: VisualReviewPanel } = await import('../components/graph/VisualReviewPanel')
    render(
      <MemoryRouter>
        <VisualReviewPanel sessionId="test-session" forceMock onClose={() => {}} />
      </MemoryRouter>,
    )
    expect(
      await screen.findByText(/your scores decide the winner/i),
    ).toBeInTheDocument()
  })

  it('caps width responsively (w-full max-w-[560px]) so it never clips on narrow screens', () => {
    // Layout contract — jsdom has no layout engine, so assert the className that
    // governs the responsive width on the panel root.
    const src = readSrc('src/components/graph/VisualReviewPanel.tsx')
    expect(src).toMatch(/w-full max-w-\[560px\] shrink-0/)
    expect(src).not.toMatch(/className="w-\[560px\]/) // the old hard width is gone
  })
})

// ===========================================================================
// КАО#UX-8 — Agent-graph reading modes: legend collapse
// ===========================================================================
describe('КАО#UX-8 — LegendPanel collapse', () => {
  it('renders a "Legend" pill when collapsed and expands on click', async () => {
    const { default: LegendPanel } = await import('../components/graph/LegendPanel')
    const onToggle = vi.fn()
    render(
      <LegendPanel compact collapsible collapsed onToggleCollapsed={onToggle} />,
    )
    const pill = screen.getByRole('button', { name: /show legend/i })
    expect(pill).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(pill)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('renders a collapse control when expanded', async () => {
    const { default: LegendPanel } = await import('../components/graph/LegendPanel')
    const onToggle = vi.fn()
    render(<LegendPanel collapsible collapsed={false} onToggleCollapsed={onToggle} />)
    const hide = screen.getByRole('button', { name: /hide legend/i })
    expect(hide).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(hide)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('stays a non-collapsible legend for other callers (default props)', async () => {
    const { default: LegendPanel } = await import('../components/graph/LegendPanel')
    render(<LegendPanel />)
    // No collapse/expand affordance when collapsible is not opted into.
    expect(screen.queryByRole('button', { name: /legend/i })).not.toBeInTheDocument()
    expect(screen.getByText('Legend')).toBeInTheDocument()
  })
})

// ===========================================================================
// КАО#UX-7 — Command Palette: live session search
// ===========================================================================
describe('КАО#UX-7 — CommandPalette session search', () => {
  async function openPalette() {
    const { default: CommandPalette } = await import('../components/common/CommandPalette')
    render(<MemoryRouter><CommandPalette /></MemoryRouter>)
    // Palette listens on document for Cmd/Ctrl-K. Fire both modifiers so the
    // platform check (mac→meta, else→ctrl) is satisfied either way.
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true, metaKey: true })
    return screen.getByPlaceholderText(/search commands and sessions/i)
  }

  it('keeps the static navigation commands and adds matching sessions when querying', async () => {
    const input = await openPalette()
    // Static commands are always available with an empty query.
    expect(screen.getByText('Go to Sessions')).toBeInTheDocument()
    // Typing surfaces the live session results (fetched lazily while open).
    await userEvent.type(input, 'mandel')
    expect(await screen.findByText('Mandelbulb explorer')).toBeInTheDocument()
    // The non-matching session is filtered out.
    expect(screen.queryByText('Game of Life')).not.toBeInTheDocument()
  })

  it('navigates to the session detail when a session result is chosen', async () => {
    const input = await openPalette()
    await userEvent.type(input, 'mandel')
    const row = await screen.findByText('Mandelbulb explorer')
    await userEvent.click(row)
    expect(navigateSpy).toHaveBeenCalledWith('/sessions/sess-mandel-1')
  })
})

// ===========================================================================
// КАО#UX-9 / UX-10 — New Session: templates affordance + run preview
// ===========================================================================
describe('КАО#UX-9/10 — NewSessionPage', () => {
  async function renderForm() {
    const { default: NewSessionPage } = await import('../pages/NewSessionPage')
    render(<MemoryRouter><NewSessionPage /></MemoryRouter>)
  }

  it('offers a "Start from a template" affordance next to the spec field', async () => {
    await renderForm()
    const link = screen.getByRole('link', { name: /start from a template/i })
    expect(link).toHaveAttribute('href', '/sessions')
  })

  it('groups the power-user controls under an open "Advanced settings" disclosure', async () => {
    await renderForm()
    expect(screen.getByText(/advanced settings/i)).toBeInTheDocument()
    // Open by default → the agent-count fields remain reachable on load.
    expect(screen.getByLabelText(/iterations/i)).toBeVisible()
    expect(screen.getByLabelText(/coders/i)).toBeVisible()
  })

  it('previews the run scale and recomputes when agent counts change', async () => {
    await renderForm()
    // Reads the actual rendered inputs and asserts the preview reflects the
    // real formula: iterations × (coders + testers + 1 summarizer) + 1 finalizer.
    const iter = screen.getByLabelText(/iterations/i) as HTMLInputElement
    const coders = screen.getByLabelText(/coders/i) as HTMLInputElement
    const testers = screen.getByLabelText(/testers/i) as HTMLInputElement
    const passes = (n: { it: number; c: number; t: number }) => n.it * (n.c + n.t + 1) + 1
    const expected = passes({ it: +iter.value, c: +coders.value, t: +testers.value })
    const preview = screen.getByText(/agent passes/i)
    expect(preview).toHaveTextContent(new RegExp(`~?\\s*${expected}\\s+agent passes`))

    // Bumping testers increases the previewed pass count.
    await userEvent.clear(testers)
    await userEvent.type(testers, '4')
    const expected2 = passes({ it: +iter.value, c: +coders.value, t: 4 })
    expect(expected2).toBeGreaterThan(expected)
    expect(screen.getByText(/agent passes/i)).toHaveTextContent(
      new RegExp(`~?\\s*${expected2}\\s+agent passes`),
    )
  })
})

// ===========================================================================
// КАО#UX-1/4/8/11 — source contracts for the 6k-line SessionDetailPage and
// DemoPlayerPage (jsdom can't render the ReactFlow graph / measure layout).
// ===========================================================================
describe('КАО#UX source contracts (giant components)', () => {
  it('UX-11 — recovery actions move into an all-breakpoint overflow menu', () => {
    const src = readSrc('src/pages/SessionDetailPage.tsx')
    // The ⋯ menu is no longer md-only.
    expect(src).toMatch(/ref=\{headerOverflowRef\}\s+className="relative"/)
    // Re-finalize / Restart / Reset / Save-as-Template are hidden inline (now in ⋯).
    for (const re of [
      /title="Re-run finalization with existing code versions"/,
      /title="Save this session's configuration as a reusable template"/,
    ]) {
      expect(src).toMatch(re)
    }
    expect(src).toMatch(/className="hidden items-center gap-2 px-4 py-2 bg-indigo-600/) // Re-finalize → hidden
  })

  it('UX-8 — hideSecondaryEdges derives displayEdges without mutating the source edges', () => {
    const src = readSrc('src/pages/SessionDetailPage.tsx')
    expect(src).toMatch(/const displayEdges = useMemo/)
    expect(src).toMatch(/if \(!hideSecondaryEdges\) return edges/)
    expect(src).toMatch(/strokeDasharray/)
    expect(src).toMatch(/artifactType === 'enhancement'/)
    // The graph is fed the derived list, not the raw edges.
    expect(src).toMatch(/edges=\{displayEdges\}/)
    // And there's a user-facing toggle.
    expect(src).toMatch(/aria-pressed=\{hideSecondaryEdges\}/)
  })

  it('UX-1 — mobile control bar wraps into two rows (no horizontal overflow)', () => {
    const src = readSrc('src/pages/DemoPlayerPage.tsx')
    // Responsive ordering: transport order-2/​md:order-1, progress full-width row.
    expect(src).toMatch(/flex flex-wrap items-center gap-x-4 gap-y-2/)
    expect(src).toMatch(/order-1 md:order-2 w-full md:w-auto md:flex-1/)
    expect(src).toMatch(/order-3 ml-auto md:ml-0/)
  })

  it('UX-4 — a Skip-to-final-result control is exposed during playback', () => {
    const src = readSrc('src/pages/DemoPlayerPage.tsx')
    expect(src).toMatch(/aria-label="Skip to final result"/)
    // Gated on not-yet-finished (WhatNextCta + Final tab take over afterwards).
    expect(src).toMatch(/!state\.finished &&[\s\S]{0,400}Skip to final result/)
  })

  it('UX-16 — no inline <style> elements remain in the demo player', () => {
    const src = readSrc('src/pages/DemoPlayerPage.tsx')
    expect(src).not.toMatch(/<style>\{/)
  })
})
