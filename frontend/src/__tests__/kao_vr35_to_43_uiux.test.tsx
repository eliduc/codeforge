// КАО (Команда Агентов-Отладчиков) — UI/UX writers subteam
// VR-35..43 — visual / layout / a11y coverage at component level.
//
// Zone of responsibility (UI/UX writer):
//   * Vitest + React Testing Library at the component level.
//   * Static source greps for things RTL can't reach inside the 6k-line
//     SessionDetailPage (CSS contract, JSX gates, label copy).
//   * The functionality writer's file (kao_vr35_to_43.test.tsx) handles
//     behavioural contracts (handler logic, prop chain, useEffect). We
//     intentionally avoid overlap and focus on what survives a refactor:
//     visible label text, banner colour palette, layout-critical classes,
//     and the gate expressions that govern conditional rendering.
//
// Covered IDs:
//   VR-35 — Run Code button label + Tailwind colour classes + tour anchor.
//   VR-38 — Graph wrapper carries `overflow-hidden`; sandbox vocab extended.
//   VR-39 — Per-enhancement attachments: category gate, label copy,
//           singular/plural attachment count badge.
//   VR-41 — VisualReviewPanel amber warning banner — label copy +
//           singular/plural fork + amber Tailwind palette.
//   VR-43 — MetricsPanel renders no Checkpoints DOM at runtime.
//
// Mutation discipline: pure unit tests, no network. Reads source files
// from the repo via fs — read-only.

import { describe, expect, it, afterEach } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '@testing-library/jest-dom/vitest'

import MetricsPanel from '../components/graph/MetricsPanel'

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
// VR-43 — MetricsPanel UI/UX: Checkpoints panel DOM-removal contract
// ===========================================================================
//
// Functionality writer covers the handler-level pulse-gap fix. UI/UX
// writer covers the visual contract: even when a checkpoints array is
// passed, nothing renders. We also defend the "Workflow Complete" badge
// that replaces the old Checkpoints section in the completed state — its
// label is the one a designer is most likely to break in a future polish
// pass.

describe('КАО#VR-43 — MetricsPanel visual contract', () => {
  it('does NOT render "Checkpoint" / "Snapshot" copy even when checkpoints prop is populated', async () => {
    const checkpoints = [
      { id: 'cp-1', iteration: 1, phase: 'coding', created_at: new Date().toISOString(), total_tokens: 100 },
      { id: 'cp-2', iteration: 2, phase: 'testing', created_at: new Date().toISOString(), total_tokens: 250 },
      { id: 'cp-3', iteration: 3, phase: 'summarizing', created_at: new Date().toISOString(), total_tokens: 500 },
    ]
    await act(async () => {
      render(
        <MetricsPanel
          iteration={3}
          maxIterations={3}
          totalTokens={500}
          totalCost={0.05}
          status="completed"
          codersDone={1}
          totalCoders={1}
          testersDone={1}
          totalTesters={1}
          checkpoints={checkpoints}
        />
      )
    })

    // Three candidate strings the old panel used. None must appear.
    expect(screen.queryByText(/^Checkpoints?$/i)).toBeNull()
    expect(screen.queryByText(/Snapshots?/i)).toBeNull()
    expect(screen.queryByText(/Saved at iteration/i)).toBeNull()

    // And no checkpoint ids leaked into the rendered DOM.
    expect(screen.queryByText(/cp-1/)).toBeNull()
    expect(screen.queryByText(/cp-2/)).toBeNull()
    expect(screen.queryByText(/cp-3/)).toBeNull()
  })

  it('preserves the "Workflow Complete" badge in the completed state', async () => {
    // VR-43 — non-degradation rule: the section that REPLACES Checkpoints
    // must keep working. The completion badge is the one visible signal
    // the user gets when status === 'completed'.
    await act(async () => {
      render(
        <MetricsPanel
          iteration={3}
          maxIterations={3}
          totalTokens={100}
          totalCost={0.01}
          status="completed"
        />
      )
    })
    expect(screen.getByText(/Workflow Complete/i)).toBeInTheDocument()
  })

  it('agent progress + cost + iteration sections still render (non-degradation)', async () => {
    // VR-43 — guard against accidentally removing more than just the
    // Checkpoints section. Tokens / Cost / Iteration are load-bearing
    // KPIs the user looks at every session.
    await act(async () => {
      render(
        <MetricsPanel
          iteration={2}
          maxIterations={3}
          totalTokens={1234}
          totalCost={0.0123}
          status="running"
          codersDone={1}
          totalCoders={2}
          testersDone={2}
          totalTesters={3}
        />
      )
    })
    // Iteration X / Y is the progress label.
    expect(screen.getByText(/2\s*\/\s*3/)).toBeInTheDocument()
    // Tokens counter (formatted with locale separator).
    expect(screen.getByText(/1,234/)).toBeInTheDocument()
    // Cost formatted with 4 decimals.
    expect(screen.getByText(/\$0\.0123/)).toBeInTheDocument()
    // Agent progress text — Coders: 1/2 and "Tests: 2/6" (1 active coder cross-product not relevant here).
    expect(screen.getByText(/Coders:\s*1\s*\/\s*2/)).toBeInTheDocument()
  })

  it('static: source contains the VR-43 explanatory comment so accidental restore stands out in diff', () => {
    const src = readSrc('src/components/graph/MetricsPanel.tsx')
    expect(src).toMatch(/VR-43\b/)
    expect(src).toMatch(/Checkpoints panel removed/i)
  })

  it('static: no JSX map over a `checkpoints` variable in MetricsPanel.tsx', () => {
    // Stronger contract — if anyone re-adds `{checkpoints.map(…)}` this
    // catches it before review.
    const src = readSrc('src/components/graph/MetricsPanel.tsx')
    const noComments = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(noComments).not.toMatch(/checkpoints\??\.map\(/)
  })
})

// ===========================================================================
// VR-35 — Run Code button: visual / tour-anchor / label contract
// ===========================================================================

describe('КАО#VR-35 — Run Code visual contract', () => {
  const SDP_SRC = readSrc('src/pages/SessionDetailPage.tsx')
  const DP_SRC = readSrc('src/components/graph/DetailPanel.tsx')

  it('toolbar Run Code uses the data-tour="run-code-btn" anchor (load-bearing for tour + e2e)', () => {
    expect(SDP_SRC).toMatch(/data-tour="run-code-btn"/)
  })

  it('toolbar Run Code uses emerald-* Tailwind palette (visual identity for primary action)', () => {
    // VR-35 — Tailwind colour family signals "go" / primary action. If a
    // designer accidentally swaps to indigo / gray, the visual hierarchy
    // is lost in the toolbar.
    // Grab the chunk near the data-tour anchor and assert class colours.
    const anchorIdx = SDP_SRC.indexOf('data-tour="run-code-btn"')
    expect(anchorIdx).toBeGreaterThan(0)
    // Look backward for the className= on the same button.
    const slice = SDP_SRC.slice(Math.max(0, anchorIdx - 500), anchorIdx + 200)
    expect(slice).toMatch(/bg-emerald-600/)
    expect(slice).toMatch(/hover:bg-emerald-700/)
  })

  it('OutputPanel Run Code uses green-* Tailwind palette (primary action inside side-panel)', () => {
    // VR-35 — the Output node side-panel uses bg-green-600 (one shade
    // lighter than the toolbar's emerald). Both are "go" colours; keep
    // the contract explicit so a global colour rename doesn't flatten
    // them to neutral.
    expect(DP_SRC).toMatch(/bg-green-600[\s\S]{0,400}Run Code/)
    expect(DP_SRC).toMatch(/hover:bg-green-700/)
  })

  it('OutputPanel renders the Loader2 spinner WITH "Running…" label when isRunningCode', () => {
    // VR-35 — spinner-only would leave the button looking broken. The
    // adjacent "Running…" label confirms the click was registered.
    expect(DP_SRC).toMatch(/animate-spin[\s\S]{0,100}Running…/)
  })

  it('Run Code label text (not "Execute" / "Start") is consistent across toolbar + OutputPanel', () => {
    // VR-35 — unified vocabulary. The user sees "Run Code" everywhere,
    // never "Execute" / "Start" / "Run".
    // Match "Run Code" as a JSX-text token (preceded by whitespace + braces
    // closing the spinner expression, followed by `</button>`). Across both
    // toolbar + Final Result panel locations.
    const toolbarRunCode = (SDP_SRC.match(/\bRun Code\b/g) ?? []).length
    expect(toolbarRunCode).toBeGreaterThanOrEqual(2) // toolbar + final-result panel
    const panelRunCode = (DP_SRC.match(/\bRun Code\b/g) ?? []).length
    expect(panelRunCode).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// VR-38 — Graph overflow-hidden + sandbox auto-click vocab
// ===========================================================================

describe('КАО#VR-38 — Graph clipping + sandbox vocab', () => {
  const SDP_SRC = readSrc('src/pages/SessionDetailPage.tsx')

  it('graph canvas container className includes `overflow-hidden`', () => {
    // VR-38 — the visual contract that protects the side-panel from being
    // overlaid by GroupFramesLayer's dashed frames.
    // Locate the data-tour anchor and inspect the same-element className.
    const idx = SDP_SRC.indexOf('data-tour="agent-graph"')
    expect(idx).toBeGreaterThan(0)
    // Same element: read back ~600 chars to capture the className above.
    const slice = SDP_SRC.slice(Math.max(0, idx - 600), idx + 200)
    expect(slice).toMatch(/overflow-hidden/)
    // min-w-0 is the companion fix — without it the flex-1 doesn't shrink.
    expect(slice).toMatch(/min-w-0/)
  })

  it('source carries the VR-38 marker explaining the clip contract', () => {
    expect(SDP_SRC).toMatch(/VR-38/)
    expect(SDP_SRC).toMatch(/intercept clicks on Live preview buttons/i)
  })

  it('sandbox browser_screenshot.js has VR-38 markers + canvas-click fallback diagnostic', () => {
    const repoRoot = resolve(FRONTEND_ROOT, '..')
    const src = readFileSync(resolve(repoRoot, 'sandbox', 'browser_screenshot.js'), 'utf8')
    // VR-38 markers in source (at least 2 — vocab + canvas fallback).
    const markers = src.match(/VR-38/g) ?? []
    expect(markers.length).toBeGreaterThanOrEqual(2)
    // canvas-click fallback diagnostic field name.
    expect(src).toMatch(/canvas_clicked/)
  })

  it('sandbox extended vocab covers common seed-button conventions', () => {
    const repoRoot = resolve(FRONTEND_ROOT, '..')
    const src = readFileSync(resolve(repoRoot, 'sandbox', 'browser_screenshot.js'), 'utf8')
    // КАО#VR-38 — extract regex alternatives, не string literals.
    // The production code stores the vocab as alternations inside `positive`
    // regex literals (e.g. /(play|start|run|...)/i), so plain string-literal
    // search ('start' / "start") misses them.
    const regexMatches = src.match(/positive\s*=\s*\/\(([^)]+)\)/g) ?? []
    expect(regexMatches.length).toBeGreaterThanOrEqual(1)
    const allAlternatives = regexMatches.join('|').toLowerCase()
    const tokens = ['start', 'play', 'begin', 'launch', 'continue', 'next', 'ok', 'apply', 'confirm']
    const found = tokens.filter(t => allAlternatives.includes(t))
    expect(found.length).toBeGreaterThanOrEqual(3)
  })
})

// ===========================================================================
// VR-39 — Per-enhancement attachments: category gate + labels
// ===========================================================================

describe('КАО#VR-39 — Enhancement attachments visual contract', () => {
  const SDP_SRC = readSrc('src/pages/SessionDetailPage.tsx')

  it("attachments JSX block is gated by `item.category === 'user'`", () => {
    // VR-39 — only user-authored enhancements can carry attachments.
    // LLM-suggested ones stay text-only to keep the surface uncluttered.
    expect(SDP_SRC).toMatch(/item\.category\s*===\s*['"]user['"]\s*&&/)
  })

  it('label vocabulary: "Attachments (optional)", "Add file(s)", "Add repo"', () => {
    // VR-39 — these copy strings are the contract for the e2e tests AND
    // for screen-reader / accessibility users. Locking them down here
    // means a designer can't silently rename "Add file(s)" to "Upload".
    expect(SDP_SRC).toMatch(/Attachments \(optional\)/)
    expect(SDP_SRC).toMatch(/Add file\(s\)/)
    expect(SDP_SRC).toMatch(/Add repo/)
  })

  it('git URL input uses a github.com placeholder + type="url"', () => {
    // VR-39 — input affordance: type=url surfaces browser validation +
    // the github example sets expectation about what URLs are accepted.
    expect(SDP_SRC).toMatch(/type="url"[\s\S]{0,200}placeholder="https:\/\/github\.com\/user\/repo"/)
  })

  it('non-editing badge: singular/plural fork ("1 attachment" vs "N attachments")', () => {
    // VR-39 — when not in edit mode, the item shows a tiny badge with
    // the count. Singular/plural fork is a high-frequency typo target;
    // lock it down.
    // КАО#VR-39 — JSX expression syntax, not template literal
    expect(SDP_SRC).toContain("attachments.length === 1 ? '' : 's'")
  })

  it('Remove-attachment button has a stable title attribute for a11y', () => {
    // VR-39 — title="Remove attachment" is the only label on the X icon
    // button. Without it, screen-reader users can't tell what the icon
    // button does.
    expect(SDP_SRC).toMatch(/title="Remove attachment"/)
  })

  it('attachments list renders distinct icons for repo vs file', () => {
    // VR-39 — GitBranch icon for repo attachments, FileText for file
    // attachments. Visual signifier that the user added the right kind.
    expect(SDP_SRC).toMatch(/att\.type\s*===\s*['"]repo_url['"]\s*\|\|\s*att\.type\s*===\s*['"]repo['"]/)
    expect(SDP_SRC).toMatch(/<GitBranch className="w-3 h-3 text-green-400/)
    expect(SDP_SRC).toMatch(/<FileText className="w-3 h-3 text-blue-400/)
  })
})

// ===========================================================================
// VR-41 — VisualReviewPanel amber warning banner
// ===========================================================================

describe('КАО#VR-41 — Missing-coders banner visual contract', () => {
  const VR_SRC = readSrc('src/components/graph/VisualReviewPanel.tsx')

  it('renders the banner inside a div with amber-500/40 border + amber-500/10 background', () => {
    // VR-41 — amber == warning. Red would imply error/blocking; we want
    // a soft "FYI some coders dropped out, keep going" tone.
    expect(VR_SRC).toMatch(/border-amber-500\/40[\s\S]{0,100}bg-amber-500\/10/)
  })

  it('uses an AlertTriangle icon (consistent with other warnings in the app)', () => {
    expect(VR_SRC).toMatch(/<AlertTriangle\s+className="[^"]*text-amber-400/)
  })

  it('headline copy is exactly "Showing {N} of {M} coders"', () => {
    // VR-41 — locks down the exact JSX expression. Re-ordering / pluralising
    // the headline would break the e2e test that asserts the headline text.
    expect(VR_SRC).toMatch(/Showing\s+\{candidates\.length\}\s+of\s+\{totalConfiguredCoders\}\s+coders/)
  })

  it("singular vs plural copy: 'Coder' vs 'Coders' based on missing count", () => {
    // VR-41 — the banner detail line forks the noun on count.
    expect(VR_SRC).toMatch(/Coder\{missingCoderIndices\.length === 1 \? '' : 's'\}/)
  })

  it("detail copy explains the LLM-timeout reason", () => {
    // VR-41 — the user needs to know WHY a coder is missing (LLM timeout
    // / error, not a bug in the platform). Lock the explanation copy.
    expect(VR_SRC).toMatch(/didn't produce a previewable result/)
    expect(VR_SRC).toMatch(/LLM timeout or error/)
  })

  it("detail copy reassures: missing variants can be retried next iteration", () => {
    // VR-41 — UX nudge: the user shouldn't feel stuck. Tell them this
    // is recoverable.
    expect(VR_SRC).toMatch(/can be retried in the next iteration/)
  })

  it('banner is gated on candidates.length > 0 AND missingCoderIndices.length > 0 AND totalConfiguredCoders > 0', () => {
    // VR-41 — three-condition AND so the banner doesn't flicker during
    // loading (when candidates is still [] but missing array might be set).
    expect(VR_SRC).toMatch(/candidates\.length\s*>\s*0\s*&&\s*missingCoderIndices\.length\s*>\s*0\s*&&\s*totalConfiguredCoders\s*>\s*0/)
  })

  it('formats coder indices as 1-based for display (i + 1)', () => {
    // VR-41 — backend uses 0-based agent_index but users see 1-based
    // "Coder 1, Coder 2". The mapping must be explicit.
    expect(VR_SRC).toMatch(/missingCoderIndices\.map\(i\s*=>\s*i\s*\+\s*1\)/)
  })
})

// ===========================================================================
// VR-37 — UI ↔ backend state sync UI safety net (smoke side; functionality
// writer covers behavioural semantics).
// ===========================================================================

describe('КАО#VR-37 — State-sync useEffect doesn\'t break UI rendering', () => {
  const SDP_SRC = readSrc('src/pages/SessionDetailPage.tsx')

  it('the VR-37 effect is co-located with its explanatory comment block', () => {
    // VR-37 — keep the why-this-exists comment with the code so future
    // refactors don't accidentally collapse the three listeners into one.
    expect(SDP_SRC).toMatch(/VR-37[\s\S]{0,200}UI\s*↔\s*backend state synchronization/i)
  })

  it('refresh helper is debounced against `document.hidden`', () => {
    // VR-37 — don't spam the backend with refresh requests when the tab
    // isn't visible. This is a perf/cost contract as much as a UX one.
    expect(SDP_SRC).toMatch(/document\.hidden/)
  })
})
