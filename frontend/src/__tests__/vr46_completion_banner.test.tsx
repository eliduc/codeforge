// VR-46 — "generation finished" indication.
//
// Two parts:
//   1. CompletionBanner component (RTL): the status strip shown under the
//      session header for post-finalization states. Renders for
//      awaiting_enhancement / awaiting_enhancement_review / completed and
//      nothing otherwise; the CTA reuses the header handlers.
//   2. Source pins for the Final Code (output) node fix inside the closure-bound
//      buildGraph / loadSession reconciliation in SessionDetailPage (not
//      exported, so we pin the production source the way kao_vr44 does).

import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import '@testing-library/jest-dom/vitest'
import CompletionBanner from '../components/graph/CompletionBanner'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = resolve(__dirname, '..', '..')
const readSrc = (rel: string) => readFileSync(resolve(FRONTEND_ROOT, rel), 'utf8')

afterEach(() => cleanup())

const noop = () => {}

describe('VR-46 — CompletionBanner component', () => {
  it('awaiting_enhancement → "Code generation complete" + View Result CTA', () => {
    render(<CompletionBanner status="awaiting_enhancement" onViewResult={noop} onReview={noop} />)
    const banner = screen.getByTestId('completion-banner')
    expect(banner).toBeInTheDocument()
    expect(banner).toHaveAttribute('data-status', 'awaiting_enhancement')
    expect(screen.getByText('Code generation complete')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /View Result/i })).toBeInTheDocument()
  })

  it('awaiting_enhancement_review → "Enhancement analysis ready" + Review Suggestions CTA', () => {
    render(<CompletionBanner status="awaiting_enhancement_review" onViewResult={noop} onReview={noop} />)
    expect(screen.getByText('Enhancement analysis ready')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Review Suggestions/i })).toBeInTheDocument()
  })

  it('completed → "Workflow complete" + View Result CTA', () => {
    render(<CompletionBanner status="completed" onViewResult={noop} onReview={noop} />)
    expect(screen.getByText('Workflow complete')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /View Result/i })).toBeInTheDocument()
  })

  it.each(['created', 'running', 'paused', 'enhancing', 'failed', 'cancelled', 'awaiting_visual_review'])(
    'renders nothing for non-finished state "%s"',
    (status) => {
      const { container } = render(
        <CompletionBanner status={status} onViewResult={noop} onReview={noop} />,
      )
      expect(container).toBeEmptyDOMElement()
      expect(screen.queryByTestId('completion-banner')).not.toBeInTheDocument()
    },
  )

  it('View Result CTA fires onViewResult only', () => {
    const onViewResult = vi.fn()
    const onReview = vi.fn()
    render(<CompletionBanner status="awaiting_enhancement" onViewResult={onViewResult} onReview={onReview} />)
    fireEvent.click(screen.getByRole('button', { name: /View Result/i }))
    expect(onViewResult).toHaveBeenCalledTimes(1)
    expect(onReview).not.toHaveBeenCalled()
  })

  it('Review CTA fires onReview only', () => {
    const onViewResult = vi.fn()
    const onReview = vi.fn()
    render(<CompletionBanner status="awaiting_enhancement_review" onViewResult={onViewResult} onReview={onReview} />)
    fireEvent.click(screen.getByRole('button', { name: /Review Suggestions/i }))
    expect(onReview).toHaveBeenCalledTimes(1)
    expect(onViewResult).not.toHaveBeenCalled()
  })

  it('busy disables the CTA', () => {
    render(<CompletionBanner status="awaiting_enhancement" onViewResult={noop} onReview={noop} busy />)
    expect(screen.getByRole('button', { name: /View Result/i })).toBeDisabled()
  })

  it('is announced to screen readers (role=status, aria-live=polite)', () => {
    render(<CompletionBanner status="completed" onViewResult={noop} onReview={noop} />)
    const banner = screen.getByTestId('completion-banner')
    expect(banner).toHaveAttribute('role', 'status')
    expect(banner).toHaveAttribute('aria-live', 'polite')
  })
})

describe('VR-46 — Final Code node + SessionDetailPage source pins', () => {
  const src = readSrc('src/pages/SessionDetailPage.tsx')

  it('the banner is rendered in SessionDetailPage', () => {
    expect(src).toContain('<CompletionBanner')
  })

  it('output node reads "done" for every post-finalization state (not just completed)', () => {
    expect(src).toContain(
      "status: ['completed', 'awaiting_enhancement', 'awaiting_enhancement_review', 'enhancing'].includes(sessionData.status) ? 'done' : 'idle',",
    )
  })

  it('the final artifact edge is shown for the same post-finalization states', () => {
    expect(src).toContain(
      "hasArtifact: ['completed', 'awaiting_enhancement', 'awaiting_enhancement_review', 'enhancing'].includes(sessionData.status),",
    )
  })

  it('completed/awaiting reconciliation no longer skips the output node', () => {
    expect(src).toContain("if (node.id === 'input') return node")
    expect(src).not.toContain("if (node.id === 'input' || node.id === 'output') return node")
  })
})
