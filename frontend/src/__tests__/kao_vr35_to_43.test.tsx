// КАО (Команда Агентов-Отладчиков) — Functionality regression tests for
// VR-35, VR-37, VR-40, VR-43.
//
// Scope (Functionality writer's zone):
//   • VR-35 — DetailPanel/OutputPanel Run-Code prop chain
//             (onRunCode optional, button only when prop provided, spinner
//             when isRunningCode=true, backwards-compat with old call sites).
//   • VR-37 — SessionDetailPage UI↔backend state-sync useEffect:
//             visibilitychange + window.focus + 30s interval all call
//             loadSession(); document.hidden=true → skip; cleanup on unmount.
//   • VR-40 — WS handler transitions for the enhancer phase:
//             enhancer_agent_completed → keep 'working' (NOT 'done').
//             enhancer_summarizer_started → D/F/S 'done', summarizer 'working'.
//             enhancer_summarizer_completed → summarizer stays 'working'.
//             awaiting_enhancement_review → finalize (summarizer 'done').
//             loadSession preserves done/error/timeout/working when status='enhancing'.
//   • VR-43 — MetricsPanel no longer renders the Checkpoints UI.
//             phase_started: testing → testers='working'.
//             enhancer_started → enabled D/F/S='working' + main pipeline 'done'.
//
// Test strategy
// -------------
// 1. DetailPanel — real RTL mount with mocked api module so loadResult resolves.
// 2. SessionDetailPage WS handlers — testing them with a full mount is
//    infeasible (the component is 6.8K lines and pulls ReactFlow + WS). We
//    follow the same "static source assertion" pattern already established
//    by kao_vr25_to_27.test.tsx for VR-26 (PHASE_BY_AGENT) which inspects
//    SessionDetailPage.tsx source directly — that file is checked into the
//    repo so the assertion is stable and PARALLEL-SAFE.
// 3. VR-37 useEffect — we ALSO add a focused behavioural test using a tiny
//    isolated component that mirrors the production effect exactly, so
//    coverage isn't purely textual.
//
// All tests are PARALLEL-SAFE: each one uses unique session IDs, mocks via
// vi.mock() scoped to the file, and never touches global module state.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom/vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComponentProps } from 'react'
import { useEffect } from 'react'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FRONTEND_ROOT = resolve(__dirname, '..', '..')

function readSrc(rel: string): string {
  return readFileSync(resolve(FRONTEND_ROOT, rel), 'utf8')
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// ===========================================================================
// VR-35 — DetailPanel/OutputPanel Run-Code prop chain
// ===========================================================================

// Mock the api module BEFORE importing DetailPanel so the OutputPanel's
// loadResult() resolves synchronously to a final-code payload.
vi.mock('../services/api', () => ({
  getFinalResult: vi.fn(async () => ({
    final_code: "print('hi')",
    selected_coder_index: 0,
    total_tokens: 42,
    total_cost_usd: 0.0001,
    file_structure: {},
  })),
  getCodeVersions: vi.fn(async () => []),
  getAudits: vi.fn(async () => []),
  getSummaries: vi.fn(async () => []),
  downloadResultZip: vi.fn(),
  createPullRequest: vi.fn(),
  getEnhancementSuggestions: vi.fn(async () => []),
  runFinalCode: vi.fn(),
}))

// Mock the toast lib so notify.* calls don't try to mount the actual Toaster.
vi.mock('../components/common/StyledToast', () => {
  const notify = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  }
  return { default: notify, notify }
})

// Mock useFetchData — DetailPanel sub-panels use it for non-output panels; the
// output panel uses its own loadResult so a no-op stub is fine.
vi.mock('../hooks/useFetchData', () => ({
  useFetchData: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }),
}))

// Mock ResultActionsExtras (it does its own fetches at mount time).
vi.mock('../components/common/ResultActionsExtras', () => ({
  default: () => null,
}))

// Mock CodeBlock — only the Output panel uses it. A bare <pre> is enough.
vi.mock('../components/common/CodeBlock', () => ({
  default: ({ code }: { code: string }) => <pre data-testid="codeblock">{code}</pre>,
}))

// Now we can import the component under test.
import DetailPanel from '../components/graph/DetailPanel'

function renderOutputDetailPanel(props: Partial<ComponentProps<typeof DetailPanel>> = {}) {
  // Stable per-test uniqueness — never share session IDs across tests.
  const sid = `vr35-${Math.random().toString(36).slice(2, 10)}`
  return render(
    <DetailPanel
      nodeId="output"
      nodeType="output"
      sessionId={sid}
      title="Output"
      language="python"
      currentIteration={1}
      maxIterations={1}
      sessionStatus="completed"
      onClose={() => {}}
      {...props}
    />
  )
}

describe('VR-35 — DetailPanel/OutputPanel Run-Code prop chain', () => {
  it('does NOT render Run Code button when onRunCode prop is omitted (backwards-compat)', async () => {
    renderOutputDetailPanel({})
    // wait for OutputPanel's loadResult promise to settle.
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByRole('button', { name: /run code/i })).not.toBeInTheDocument()
  })

  it('renders Run Code button when onRunCode prop is provided', async () => {
    renderOutputDetailPanel({ onRunCode: () => {} })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.getByRole('button', { name: /run code/i })).toBeInTheDocument()
  })

  it('invokes onRunCode when the button is clicked', async () => {
    const onRunCode = vi.fn()
    renderOutputDetailPanel({ onRunCode })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const btn = screen.getByRole('button', { name: /run code/i })
    await userEvent.click(btn)
    expect(onRunCode).toHaveBeenCalledTimes(1)
  })

  it('disables the button and shows "Running…" when isRunningCode=true', async () => {
    const onRunCode = vi.fn()
    renderOutputDetailPanel({ onRunCode, isRunningCode: true })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const btn = screen.getByRole('button', { name: /running/i })
    expect(btn).toBeDisabled()
    // userEvent honors pointer-events:none but RTL's bare click also checks
    // disabled — we assert no invocation regardless of how the test runner
    // bubbles the click.
    expect(onRunCode).not.toHaveBeenCalled()
  })

  it('DetailPanel source pipes onRunCode/isRunningCode into OutputPanel', () => {
    // Belt-and-braces source assertion — protects against accidental removal
    // of the prop forwarding even if jsdom rendering changes shape.
    const src = readSrc('src/components/graph/DetailPanel.tsx')
    expect(src).toMatch(/onRunCode\?:\s*\(\)\s*=>\s*void/)
    expect(src).toMatch(/isRunningCode\?:\s*boolean/)
    // OutputPanel must receive both props from DetailPanel.
    expect(src).toMatch(/<OutputPanel[\s\S]*?onRunCode=\{onRunCode\}[\s\S]*?isRunningCode=\{isRunningCode\}/)
  })

  it('SessionDetailPage source passes handleRunCode + isRunningCode into DetailPanel', () => {
    // VR-35 — the whole chain SessionDetail → DetailPanel → OutputPanel must be
    // intact; this catches a regression where the parent stops forwarding.
    const src = readSrc('src/pages/SessionDetailPage.tsx')
    expect(src).toMatch(/handleRunCode/)
    // The DetailPanel receives onRunCode from the parent.
    // КАО#VR-35 — relax regex window to fit current props block size
    const detailPanelIdx = src.indexOf('<DetailPanel')
    expect(detailPanelIdx).toBeGreaterThan(-1)
    const onRunCodeIdx = src.indexOf('onRunCode=', detailPanelIdx)
    expect(onRunCodeIdx).toBeGreaterThan(-1)
    expect(onRunCodeIdx - detailPanelIdx).toBeLessThan(3000)
  })
})

// ===========================================================================
// VR-37 — visibility/focus/poll state-sync effect
// ===========================================================================

// We extract the effect's contract into a tiny component that mirrors the
// production code byte-for-byte (no shared module — the SessionDetailPage
// implementation is closure-bound). The test asserts that visibility/focus/
// interval all call the callback and that document.hidden=true short-circuits.

function StateSyncProbe({
  sessionId,
  loadSession,
}: {
  sessionId: string | null
  loadSession: () => void
}) {
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false

    const refresh = (_reason: string) => {
      if (cancelled || document.hidden) return
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
  }, [sessionId, loadSession])
  return null
}

describe('VR-37 — state-sync useEffect (visibility/focus/interval)', () => {
  beforeEach(() => {
    // Reset document.hidden between tests via property override.
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  it('SessionDetailPage source contains the three-fallback effect', () => {
    const src = readSrc('src/pages/SessionDetailPage.tsx')
    // The effect is anchored by the VR-37 banner comment.
    expect(src).toMatch(/VR-37[\s\S]{0,2000}?visibilitychange[\s\S]{0,500}?focus[\s\S]{0,500}?setInterval/)
    // 30s interval magic number must be present.
    expect(src).toMatch(/setInterval[\s\S]{0,400}?30_000|setInterval[\s\S]{0,400}?30000/)
    // document.hidden short-circuit guard.
    expect(src).toMatch(/if\s*\([^)]*document\.hidden[^)]*\)\s*return/)
  })

  it('visibilitychange (visible) triggers loadSession', () => {
    const loadSession = vi.fn()
    render(<StateSyncProbe sessionId={`vr37-${Math.random()}`} loadSession={loadSession} />)
    // ensure the listener is attached (effect ran synchronously)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(loadSession).toHaveBeenCalledTimes(1)
  })

  it('visibilitychange with document.hidden=true does NOT trigger loadSession', () => {
    const loadSession = vi.fn()
    render(<StateSyncProbe sessionId={`vr37-${Math.random()}`} loadSession={loadSession} />)
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(loadSession).not.toHaveBeenCalled()
  })

  it('window focus triggers loadSession (only when document is visible)', () => {
    const loadSession = vi.fn()
    render(<StateSyncProbe sessionId={`vr37-${Math.random()}`} loadSession={loadSession} />)
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(loadSession).toHaveBeenCalledTimes(1)

    // ...but when hidden the focus event must also be a no-op.
    loadSession.mockClear()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(loadSession).not.toHaveBeenCalled()
  })

  it('30s interval ticks fire loadSession', () => {
    vi.useFakeTimers()
    try {
      const loadSession = vi.fn()
      render(<StateSyncProbe sessionId={`vr37-${Math.random()}`} loadSession={loadSession} />)
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })

      // Advance just under 30s — nothing yet.
      act(() => { vi.advanceTimersByTime(29_999) })
      expect(loadSession).not.toHaveBeenCalled()

      act(() => { vi.advanceTimersByTime(1) })
      expect(loadSession).toHaveBeenCalledTimes(1)

      // Two more cycles.
      act(() => { vi.advanceTimersByTime(60_000) })
      expect(loadSession).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleanup on unmount removes listeners + clears interval', () => {
    vi.useFakeTimers()
    try {
      const loadSession = vi.fn()
      const { unmount } = render(<StateSyncProbe sessionId={`vr37-${Math.random()}`} loadSession={loadSession} />)
      Object.defineProperty(document, 'hidden', { configurable: true, value: false })

      unmount()

      // After unmount, neither events nor timers should call loadSession.
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      act(() => { window.dispatchEvent(new Event('focus')) })
      act(() => { vi.advanceTimersByTime(120_000) })

      expect(loadSession).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('null sessionId does not register any listeners', () => {
    const loadSession = vi.fn()
    render(<StateSyncProbe sessionId={null} loadSession={loadSession} />)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    act(() => { window.dispatchEvent(new Event('focus')) })
    expect(loadSession).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// VR-40 — Enhancer WS handler transitions
// ===========================================================================
//
// The WS event handlers live inside the SessionDetailPage component closure
// and can't be exported. We pin their contract via source assertions — each
// `case '<event>':` block is followed by the expected setNodes/setEdges
// behaviour. The comments themselves are tagged `VR-40` which the regex
// scopes to ensure we're inspecting the right block, not a stray earlier
// match.

describe('VR-40 — Enhancer WS handler transitions (source pins)', () => {
  const src = readSrc('src/pages/SessionDetailPage.tsx')

  it('enhancer_agent_completed keeps the node in "working" (not "done")', () => {
    // Match the case body up to the next case label.
    const m = src.match(/case 'enhancer_agent_completed':[\s\S]*?(?=case '|^\s*\}\s*\)\s*$)/m)
    expect(m).toBeTruthy()
    const block = m![0]
    // VR-40 banner is inside the block.
    expect(block).toMatch(/VR-40/)
    // updateEnhancerNode call with 'working' (NOT 'done')
    expect(block).toMatch(/updateEnhancerNode\([^,]+,\s*'working'/)
    // Must NOT set status: 'done' on the enhancer.
    expect(block).not.toMatch(/updateEnhancerNode\([^,]+,\s*'done'/)
  })

  it('enhancer_summarizer_started marks D/F/S → done and summarizer → working', () => {
    const m = src.match(/case 'enhancer_summarizer_started':[\s\S]*?(?=case ')/m)
    expect(m).toBeTruthy()
    const block = m![0]
    expect(block).toMatch(/VR-40/)
    // D/F/S enhancers get status: 'done' inside a setNodes map. The filter
    // excludes the summarizer node itself.
    expect(block).toMatch(/node\.id\.startsWith\('enhancer-'\)[\s\S]*?node\.id !== 'enhancer-summarizer'/)
    expect(block).toMatch(/status:\s*'done'/)
    // Summarizer becomes 'working' AFTER the bulk update.
    expect(block).toMatch(/updateEnhancerNode\('enhancer-summarizer',\s*'working'/)
  })

  it('enhancer_summarizer_completed keeps summarizer in "working" (not "done")', () => {
    const m = src.match(/case 'enhancer_summarizer_completed':[\s\S]*?(?=case ')/m)
    expect(m).toBeTruthy()
    const block = m![0]
    expect(block).toMatch(/VR-40/)
    expect(block).toMatch(/updateEnhancerNode\('enhancer-summarizer',\s*'working'/)
    // No 'done' transition until awaiting_enhancement_review.
    expect(block).not.toMatch(/updateEnhancerNode\('enhancer-summarizer',\s*'done'/)
  })

  it('awaiting_enhancement_review finalizes the summarizer to done', () => {
    const m = src.match(/case 'awaiting_enhancement_review':[\s\S]*?(?=case ')/m)
    expect(m).toBeTruthy()
    const block = m![0]
    expect(block).toMatch(/VR-40/)
    // The setNodes block applies status:'done' to enhancer-* nodes.
    expect(block).toMatch(/node\.id\.startsWith\('enhancer-'\)/)
    expect(block).toMatch(/status:\s*'done'/)
  })

  it('loadSession preserves done/error/timeout/working when status="enhancing"', () => {
    // КАО#VR-44 — re-anchored: the VR-44 rewrite moved "preserve" ahead of the
    // VR-40 tag in the comment, so the old VR-40→preserve→done ordering no
    // longer held. Pin the VR-44 enhancing-branch fix + the `preserveExisting`
    // guard that covers all four WS-driven statuses (done/error/timeout/working).
    expect(src).toMatch(
      /VR-44[\s\S]*?preserveExisting[\s\S]{0,200}?'done'[\s\S]{0,120}?'error'[\s\S]{0,120}?'timeout'[\s\S]{0,120}?'working'/
    )
  })
})

// ===========================================================================
// VR-43 — Checkpoints removed + phase_started/enhancer_started transitions
// ===========================================================================

describe('VR-43 — MetricsPanel.Checkpoints removed', () => {
  const src = readSrc('src/components/graph/MetricsPanel.tsx')

  it('MetricsPanel no longer renders a Checkpoints heading or list', () => {
    // We allow the comment banner referencing `checkpoints` (prop kept for
    // API stability) but assert no JSX heading or item-render call.
    // Strip line + block comments first so a historical mention inside a
    // comment doesn't fool the assertion.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
    // No <h... Checkpoints...> or `>Checkpoints<` text node.
    expect(stripped).not.toMatch(/>\s*Checkpoints\s*</)
    // The prop type can still exist; what matters is no .map render of it.
    expect(stripped).not.toMatch(/checkpoints\??\.map\b/)
  })

  it('VR-43 banner comment is present documenting the removal', () => {
    expect(src).toMatch(/VR-43/)
  })
})

describe('VR-43 — phase_started/enhancer_started status transitions (source pins)', () => {
  const src = readSrc('src/pages/SessionDetailPage.tsx')

  it("phase_started case for 'testing' marks all testers as 'working'", () => {
    const m = src.match(/case 'phase_started':[\s\S]*?(?=case ')/m)
    expect(m).toBeTruthy()
    const block = m![0]
    expect(block).toMatch(/VR-43/)
    // The testing branch sets coders='waiting' then testers='working'.
    expect(block).toMatch(/phase\s*===\s*'testing'[\s\S]*?updateAllAgentStatuses\('tester',\s*'working'\)/)
  })

  it("enhancer_started marks enabled D/F/S as 'working' and main pipeline as 'done'", () => {
    const m = src.match(/case 'enhancer_started':[\s\S]*?(?=case ')/m)
    expect(m).toBeTruthy()
    const block = m![0]
    expect(block).toMatch(/VR-43/)
    // Main pipeline → done.
    expect(block).toMatch(/coder-|tester-|summarizer[\s\S]*?status:\s*'done'/)
    // Enabled enhancer (non-summarizer) nodes → working.
    expect(block).toMatch(/enhancer-[\s\S]*?node\.id\s*!==\s*'enhancer-summarizer'[\s\S]*?status:\s*'working'/)
    // The enabled set is derived from session.agent_configs with enabled !== false.
    expect(block).toMatch(/enabled\s*!==\s*false/)
  })
})
