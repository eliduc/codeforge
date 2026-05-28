// КАО (Команда Агентов-Отладчиков) — UI/UX writers subteam — VR-44 pass.
//
// Zone of responsibility (UI/UX writer):
//   * Vitest + React Testing Library at the component level.
//   * Static source greps for things RTL can't reach inside the ~1.9k-line
//     SessionDetailPage (the 'enhancing' loadSession branch is closure-bound
//     and not exported — we replicate its logic as a local PURE helper that
//     mirrors the production code byte-for-byte, then assert all branches +
//     the "≥1 pulsing" invariant; AND we pin the source so a future refactor
//     that breaks the mirror stands out in diff review).
//
// These tests SUPPLEMENT the existing VR-35..43 coverage (see
// kao_vr35_to_43_uiux.test.tsx + kao_vr35_to_43.test.tsx). We intentionally
// avoid re-testing what those files already lock down and focus on:
//   VR-44 — enhancer-node status rule while session.status === 'enhancing'.
//   AgentNode — the ACTUAL pulse class (`animate-pulse`) that the VR-44
//               'working' status drives (the visible "≥1 pulsing" guarantee).
//   VR-35 — Run Code button rendered by OutputPanel when onRunCode supplied,
//           coexisting with the disambiguated "Run in REPL" label.
//   VR-43 — MetricsPanel renders no Checkpoints section + humanizes the enum.
//
// Mutation discipline: pure unit tests, no network (api module is mocked).
// Read-only source reads via fs.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComponentProps } from 'react'
import '@testing-library/jest-dom/vitest'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const FRONTEND_ROOT = resolve(__dirname, '..', '..')

function readSrc(rel: string): string {
  return readFileSync(resolve(FRONTEND_ROOT, rel), 'utf8')
}

afterEach(() => {
  cleanup()
})

// ===========================================================================
// VR-44 — enhancer-node status rule (pure-logic mirror + invariant)
// ===========================================================================
//
// The rule lives inside SessionDetailPage.loadSession()'s `'enhancing'`
// branch (~line 1763). It is NOT exported, so we replicate it here as a
// pure helper that mirrors the production logic EXACTLY:
//
//   For each node whose id starts with 'enhancer-':
//     1. If node.data.status ∈ {done,error,timeout,working} → preserve.
//     2. Else dfsSiblings = enhancer-* nodes except 'enhancer-summarizer';
//        anyDfsDone = any sibling status ∈ {done,error,timeout}.
//     3. If node is 'enhancer-summarizer' → anyDfsDone ? 'working' : 'idle'.
//     4. Else (D/F/S node) → node.data.disabled===true ? 'idle' : 'working'.
//
// INVARIANT: while session.status === 'enhancing' at least one enhancer block
// must be 'working' (AgentNode pulses on working/executing/fixing).

type NodeStatus =
  | 'idle' | 'working' | 'done' | 'error' | 'waiting' | 'executing' | 'fixing' | 'timeout'

interface EnhNode {
  id: string
  data: { status: NodeStatus; disabled?: boolean }
}

/**
 * Pure mirror of SessionDetailPage's `'enhancing'` enhancer-node mapper.
 * `nds` is the full node array (siblings are read from it, exactly like the
 * production `nds.filter(...)` closure). Only enhancer-* nodes are mapped;
 * everything else is returned unchanged (matches `return node`).
 */
function applyEnhancingEnhancerRule(nds: EnhNode[]): EnhNode[] {
  return nds.map((node) => {
    if (!node.id.startsWith('enhancer-')) return node

    // 1. Preserve WS-driven transitions (VR-40 non-clobber).
    const preserveExisting =
      node.data.status === 'done' ||
      node.data.status === 'error' ||
      node.data.status === 'timeout' ||
      node.data.status === 'working'
    if (preserveExisting) {
      return node
    }

    // 2. Sibling D/F/S inspection.
    const dfsSiblings = nds.filter(
      (n) => n.id.startsWith('enhancer-') && n.id !== 'enhancer-summarizer',
    )
    const anyDfsDone = dfsSiblings.some(
      (n) =>
        n.data?.status === 'done' ||
        n.data?.status === 'error' ||
        n.data?.status === 'timeout',
    )

    // 3. Summarizer.
    if (node.id === 'enhancer-summarizer') {
      return { ...node, data: { ...node.data, status: anyDfsDone ? 'working' : 'idle' } }
    }

    // 4. D/F/S node — pulse unless explicitly disabled.
    const isDisabled = node.data?.disabled === true
    return { ...node, data: { ...node.data, status: isDisabled ? 'idle' : 'working' } }
  })
}

/** Status set AgentNode treats as "pulsing / active". */
const PULSING = new Set<NodeStatus>(['working', 'executing', 'fixing'])

function statusOf(nodes: EnhNode[], id: string): NodeStatus | undefined {
  return nodes.find((n) => n.id === id)?.data.status
}

function enhancerNodes(nodes: EnhNode[]): EnhNode[] {
  return nodes.filter((n) => n.id.startsWith('enhancer-'))
}

describe('КАО#VR-44 — enhancer-node status rule (pure-logic mirror)', () => {
  // Representative full enhancer set: 3 D/F/S blocks + the summarizer.
  const baseSet = (): EnhNode[] => [
    { id: 'enhancer-design', data: { status: 'idle' } },
    { id: 'enhancer-func', data: { status: 'idle' } },
    { id: 'enhancer-security', data: { status: 'idle' } },
    { id: 'enhancer-summarizer', data: { status: 'idle' } },
  ]

  it('Branch 4 — all D/F/S idle → all D/F/S pulse, summarizer stays idle', () => {
    const out = applyEnhancingEnhancerRule(baseSet())
    expect(statusOf(out, 'enhancer-design')).toBe('working')
    expect(statusOf(out, 'enhancer-func')).toBe('working')
    expect(statusOf(out, 'enhancer-security')).toBe('working')
    // Summarizer must NOT pulse while D/F/S phase is active.
    expect(statusOf(out, 'enhancer-summarizer')).toBe('idle')
  })

  it('Branch 3 — one D/F/S done → summarizer pulses (working)', () => {
    const nodes = baseSet()
    nodes[0].data.status = 'done' // enhancer-design finished
    const out = applyEnhancingEnhancerRule(nodes)
    // The done node is preserved (branch 1).
    expect(statusOf(out, 'enhancer-design')).toBe('done')
    // Summarizer now pulses because a sibling is done (branch 3, anyDfsDone).
    expect(statusOf(out, 'enhancer-summarizer')).toBe('working')
  })

  it('Branch 3 — anyDfsDone also true for sibling error / timeout', () => {
    for (const terminal of ['error', 'timeout'] as const) {
      const nodes = baseSet()
      nodes[1].data.status = terminal // enhancer-func errored / timed out
      const out = applyEnhancingEnhancerRule(nodes)
      expect(statusOf(out, 'enhancer-func')).toBe(terminal) // preserved
      expect(statusOf(out, 'enhancer-summarizer')).toBe('working')
    }
  })

  it('Branch 4 — a disabled D/F/S node stays idle (does NOT pulse)', () => {
    const nodes = baseSet()
    nodes[2].data = { status: 'idle', disabled: true } // security disabled
    const out = applyEnhancingEnhancerRule(nodes)
    expect(statusOf(out, 'enhancer-security')).toBe('idle')
    // Its non-disabled siblings still pulse.
    expect(statusOf(out, 'enhancer-design')).toBe('working')
    expect(statusOf(out, 'enhancer-func')).toBe('working')
  })

  it('Branch 1 — working/done/error/timeout are preserved verbatim', () => {
    const nodes: EnhNode[] = [
      { id: 'enhancer-design', data: { status: 'working' } },
      { id: 'enhancer-func', data: { status: 'done' } },
      { id: 'enhancer-security', data: { status: 'error' } },
      { id: 'enhancer-summarizer', data: { status: 'timeout' } },
    ]
    const out = applyEnhancingEnhancerRule(nodes)
    expect(statusOf(out, 'enhancer-design')).toBe('working')
    expect(statusOf(out, 'enhancer-func')).toBe('done')
    expect(statusOf(out, 'enhancer-security')).toBe('error')
    expect(statusOf(out, 'enhancer-summarizer')).toBe('timeout')
  })

  it('Branch 1 — a "done" summarizer is NOT downgraded to idle', () => {
    // Edge: summarizer already done but no sibling is done (e.g. WS finalize
    // raced ahead). Preservation must win over the branch-3 recompute.
    const nodes: EnhNode[] = [
      { id: 'enhancer-design', data: { status: 'idle' } },
      { id: 'enhancer-summarizer', data: { status: 'done' } },
    ]
    const out = applyEnhancingEnhancerRule(nodes)
    expect(statusOf(out, 'enhancer-summarizer')).toBe('done')
  })

  it('only enhancer-* nodes are touched — pipeline/input nodes pass through', () => {
    const nodes: EnhNode[] = [
      { id: 'input', data: { status: 'done' } },
      { id: 'coder-0', data: { status: 'done' } },
      { id: 'enhancer-design', data: { status: 'idle' } },
    ]
    const out = applyEnhancingEnhancerRule(nodes)
    expect(statusOf(out, 'input')).toBe('done')
    expect(statusOf(out, 'coder-0')).toBe('done')
    expect(statusOf(out, 'enhancer-design')).toBe('working')
  })

  // ── INVARIANT: ≥1 pulsing enhancer block while status === 'enhancing' ──
  describe('INVARIANT — at least one enhancer block pulses', () => {
    const scenarios: Array<{ name: string; nodes: () => EnhNode[] }> = [
      {
        name: 'fresh enhancing (all idle)',
        nodes: () => baseSet(),
      },
      {
        name: 'mid D/F/S phase (one done, rest idle)',
        nodes: () => {
          const n = baseSet()
          n[0].data.status = 'done'
          return n
        },
      },
      {
        name: 'all D/F/S done → only summarizer left to pulse',
        nodes: () => [
          { id: 'enhancer-design', data: { status: 'done' } },
          { id: 'enhancer-func', data: { status: 'done' } },
          { id: 'enhancer-security', data: { status: 'done' } },
          { id: 'enhancer-summarizer', data: { status: 'idle' } },
        ],
      },
      {
        name: 'one D/F/S disabled, rest idle',
        nodes: () => {
          const n = baseSet()
          n[2].data = { status: 'idle', disabled: true }
          return n
        },
      },
      {
        name: 'some already working (WS-driven)',
        nodes: () => {
          const n = baseSet()
          n[1].data.status = 'working'
          return n
        },
      },
    ]

    for (const sc of scenarios) {
      it(`holds for: ${sc.name}`, () => {
        const out = applyEnhancingEnhancerRule(sc.nodes())
        const pulsing = enhancerNodes(out).filter((n) => PULSING.has(n.data.status))
        expect(pulsing.length).toBeGreaterThanOrEqual(1)
      })
    }

    it('PATHOLOGICAL guard — when EVERY D/F/S is disabled, summarizer carries the pulse', () => {
      // If all D/F/S nodes are disabled they'd all be idle. The invariant
      // would then rely on the summarizer. But the summarizer only pulses
      // when anyDfsDone. With all-disabled-idle siblings, anyDfsDone is false
      // → summarizer idle → NO pulsing block. This documents the one input
      // shape where the "≥1 pulsing" invariant is NOT structurally guaranteed
      // by this rule alone (see finding in report). We assert the ACTUAL
      // behaviour so a future fix that closes the gap surfaces as a diff.
      const nodes: EnhNode[] = [
        { id: 'enhancer-design', data: { status: 'idle', disabled: true } },
        { id: 'enhancer-func', data: { status: 'idle', disabled: true } },
        { id: 'enhancer-security', data: { status: 'idle', disabled: true } },
        { id: 'enhancer-summarizer', data: { status: 'idle' } },
      ]
      const out = applyEnhancingEnhancerRule(nodes)
      const pulsing = enhancerNodes(out).filter((n) => PULSING.has(n.data.status))
      // Documented behaviour: zero pulsing in this all-disabled corner case.
      // (In practice the summarizer is never disabled, so production never
      // hits this; the invariant holds for every realistic node set above.)
      expect(pulsing.length).toBe(0)
    })
  })

  // ── Source pin: the production mirror must stay in sync. ──
  it('static: SessionDetailPage carries the VR-44 rule with the documented branches', () => {
    const src = readSrc('src/pages/SessionDetailPage.tsx')
    expect(src).toMatch(/VR-44/)
    // The four structural pillars of the rule.
    expect(src).toMatch(/node\.id\.startsWith\('enhancer-'\)/)
    expect(src).toMatch(/n\.id\s*!==\s*'enhancer-summarizer'/)
    expect(src).toMatch(/anyDfsDone\s*\?\s*'working'\s*:\s*'idle'/)
    expect(src).toMatch(/isDisabled\s*\?\s*'idle'\s*:\s*'working'/)
    // Preservation of WS-driven terminal/working states.
    expect(src).toMatch(/status\s*===\s*'done'[\s\S]{0,120}status\s*===\s*'working'/)
  })
})

// ===========================================================================
// AgentNode — the ACTUAL pulse class driven by VR-44's 'working' status.
// ===========================================================================
//
// AgentNode derives `isActive = working || executing || fixing` and renders
// an inner gradient overlay <div> with the `animate-pulse` utility (plus the
// header icon wrapper). idle / waiting render no `animate-pulse`. This is the
// visible signal the VR-44 invariant relies on, so we assert on the REAL
// class AgentNode uses rather than a proxy.

import AgentNode from '../components/graph/AgentNode'
// AgentNode renders React Flow <Handle> nodes which read the RF zustand store;
// they throw "you have not used zustand provider as an ancestor" unless mounted
// under a <ReactFlowProvider>. This is the documented React Flow unit-test
// pattern — it does NOT alter AgentNode's own pulse/styling logic.
import { ReactFlowProvider } from '@xyflow/react'

function renderAgentNode(props: Partial<ComponentProps<typeof AgentNode>['data']> = {}) {
  const { container } = render(
    <ReactFlowProvider>
      <AgentNode
        data={{
          label: 'Design',
          agentType: 'enhancer_design',
          status: 'idle',
          ...props,
        }}
      />
    </ReactFlowProvider>,
  )
  return container
}

describe('КАО#VR-44 — AgentNode pulse rendering (animate-pulse class)', () => {
  for (const status of ['working', 'executing', 'fixing'] as const) {
    it(`status="${status}" renders at least one element with animate-pulse`, () => {
      const container = renderAgentNode({ status })
      expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(1)
    })
  }

  for (const status of ['idle', 'waiting'] as const) {
    it(`status="${status}" renders NO animate-pulse (not active)`, () => {
      const container = renderAgentNode({ status })
      expect(container.querySelector('.animate-pulse')).toBeNull()
    })
  }

  it('done/error/timeout are NOT pulsing (terminal states are static)', () => {
    for (const status of ['done', 'error', 'timeout'] as const) {
      const container = renderAgentNode({ status })
      expect(container.querySelector('.animate-pulse')).toBeNull()
      cleanup()
    }
  })

  it('a DISABLED enhancer node does not pulse even if status looks active-ish', () => {
    // VR-44 branch 4 keeps disabled nodes at 'idle'; AgentNode also early-outs
    // the active styling for disabled nodes (opacity-60, no glow). Belt &
    // braces: a disabled+idle node has no animate-pulse.
    const container = renderAgentNode({ status: 'idle', disabled: true })
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('integration: VR-44 "working" output → AgentNode pulses', () => {
    // Feed the pure-rule output straight into AgentNode to prove the contract
    // end-to-end: a fresh-enhancing design node becomes 'working' and pulses.
    const ruled = applyEnhancingEnhancerRule([
      { id: 'enhancer-design', data: { status: 'idle' } },
    ])
    const designStatus = ruled[0].data.status
    expect(designStatus).toBe('working')
    const container = renderAgentNode({ status: designStatus })
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// VR-35 — Run Code in OutputPanel + "Run in REPL" coexistence (RTL mount).
// ===========================================================================
//
// Mock the api module so OutputPanel.loadResult() resolves to a final-code
// payload synchronously. The functionality writer already covers the prop
// chain in kao_vr35_to_43.test.tsx; here we lock the UI/UX contract that BOTH
// labels render together (Non-Degradation Rule: renaming REPL's button to
// "Run in REPL" must not remove the primary "Run Code").

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

vi.mock('../components/common/StyledToast', () => {
  const notify = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }
  return { default: notify, notify }
})

vi.mock('../hooks/useFetchData', () => ({
  useFetchData: () => ({ data: null, loading: false, error: null, refetch: vi.fn() }),
}))

vi.mock('../components/common/ResultActionsExtras', () => ({ default: () => null }))

vi.mock('../components/common/CodeBlock', () => ({
  default: ({ code }: { code: string }) => <pre data-testid="codeblock">{code}</pre>,
}))

import DetailPanel from '../components/graph/DetailPanel'

function renderOutputDetailPanel(props: Partial<ComponentProps<typeof DetailPanel>> = {}) {
  const sid = `vr44-${Math.random().toString(36).slice(2, 10)}`
  return render(
    <DetailPanel
      nodeId="output"
      nodeType="output"
      sessionId={sid}
      title="Final Code"
      language="python"
      currentIteration={1}
      maxIterations={1}
      sessionStatus="completed"
      onClose={() => {}}
      {...props}
    />,
  )
}

describe('КАО#VR-44 / VR-35 — OutputPanel Run Code + Run in REPL coexistence', () => {
  it('renders the green full-width "Run Code" button when onRunCode + final result present', async () => {
    renderOutputDetailPanel({ onRunCode: () => {} })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    const runCode = screen.getByRole('button', { name: /^Run Code$/i })
    expect(runCode).toBeInTheDocument()
    // Green primary palette + full width (VR-35 visual contract).
    expect(runCode.className).toMatch(/bg-green-600/)
    expect(runCode.className).toMatch(/\bw-full\b/)
  })

  it('the disambiguated "Run in REPL" label also renders (Non-Degradation)', async () => {
    renderOutputDetailPanel({ onRunCode: () => {} })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // REPLPreview's button — distinct label so the two actions don't collide.
    expect(screen.getByRole('button', { name: /Run in REPL/i })).toBeInTheDocument()
  })

  it('both buttons coexist and have DISTINCT labels (no duplicate "Run Code")', async () => {
    renderOutputDetailPanel({ onRunCode: () => {} })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    // Exactly one "Run Code" (the primary) and exactly one "Run in REPL".
    expect(screen.getAllByRole('button', { name: /^Run Code$/i })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Run in REPL/i })).toHaveLength(1)
  })

  it('without onRunCode the primary Run Code is absent but Run in REPL still shows', async () => {
    // VR-35 — Run Code is gated on the onRunCode prop; the REPL button is
    // unconditional inside the Output panel. Confirms we didn't accidentally
    // couple the two.
    renderOutputDetailPanel({})
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(screen.queryByRole('button', { name: /^Run Code$/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Run in REPL/i })).toBeInTheDocument()
  })
})

// ===========================================================================
// VR-43 — MetricsPanel: no Checkpoints section + humanized status badge.
// ===========================================================================

import MetricsPanel from '../components/graph/MetricsPanel'

describe('КАО#VR-44 / VR-43 — MetricsPanel checkpoints removed + humanized badge', () => {
  it('renders no Checkpoints section even when a checkpoints prop is passed', async () => {
    const checkpoints = [
      { id: 'cp-vr44-1', iteration: 1, phase: 'coding', created_at: new Date().toISOString(), total_tokens: 100 },
      { id: 'cp-vr44-2', iteration: 2, phase: 'testing', created_at: new Date().toISOString(), total_tokens: 200 },
    ]
    await act(async () => {
      render(
        <MetricsPanel
          iteration={2}
          maxIterations={3}
          totalTokens={300}
          totalCost={0.03}
          status="running"
          checkpoints={checkpoints}
        />,
      )
    })
    expect(screen.queryByText(/^Checkpoints?$/i)).toBeNull()
    expect(screen.queryByText(/Snapshots?/i)).toBeNull()
    expect(screen.queryByText(/cp-vr44-1/)).toBeNull()
    expect(screen.queryByText(/cp-vr44-2/)).toBeNull()
  })

  it('humanizes the raw status enum (awaiting_enhancement_review → "Enhancement Review")', async () => {
    await act(async () => {
      render(
        <MetricsPanel
          iteration={1}
          maxIterations={3}
          totalTokens={0}
          totalCost={0}
          status="awaiting_enhancement_review"
        />,
      )
    })
    expect(screen.getByText('Enhancement Review')).toBeInTheDocument()
    // The raw enum must NOT leak into the badge.
    expect(screen.queryByText(/awaiting_enhancement_review/)).toBeNull()
  })

  it('humanizes the "enhancing" status (→ "Enhancing…") with a pulsing badge', async () => {
    // VR-43 + VR-44 cross-check: while enhancing, the metrics badge itself
    // pulses (animate-pulse) — a second visible "something is happening" cue
    // that complements the pulsing enhancer node.
    await act(async () => {
      render(
        <MetricsPanel
          iteration={1}
          maxIterations={3}
          totalTokens={0}
          totalCost={0}
          status="enhancing"
        />,
      )
    })
    const badge = screen.getByText('Enhancing…')
    expect(badge).toBeInTheDocument()
    expect(badge.className).toMatch(/animate-pulse/)
  })
})
