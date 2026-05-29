// VR-47 — Coder node: "Checking" self-check label (run N/max) + persistent
// run→fix badge (green = clean, yellow = hit max_fix_attempts).
//
// AgentNode renders React Flow <Handle> nodes that read the RF zustand store,
// so it must be wrapped in <ReactFlowProvider> (the documented RF unit-test
// pattern) — this does not alter AgentNode's own label/badge logic.

import { afterEach, describe, expect, it } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ComponentProps } from 'react'
import '@testing-library/jest-dom/vitest'
import AgentNode from '../components/graph/AgentNode'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FRONTEND_ROOT = resolve(__dirname, '..', '..')
const readSrc = (rel: string) => readFileSync(resolve(FRONTEND_ROOT, rel), 'utf8')

afterEach(() => cleanup())

type Data = ComponentProps<typeof AgentNode>['data']

function renderNode(data: Partial<Data>) {
  return render(
    <ReactFlowProvider>
      <AgentNode data={{ label: 'Coder 1', agentType: 'coder', status: 'idle', ...data } as Data} />
    </ReactFlowProvider>,
  )
}

describe('VR-47 — Coder "Checking" self-check label', () => {
  it('coder executing with run counter → "Checking… (run 1/3)"', () => {
    renderNode({ agentType: 'coder', status: 'executing', fixAttempt: 1, maxFixAttempts: 3 })
    expect(screen.getByText(/Checking… \(run 1\/3\)/)).toBeInTheDocument()
  })

  it('coder executing without counter → "Checking…"', () => {
    renderNode({ agentType: 'coder', status: 'executing' })
    expect(screen.getByText('Checking…')).toBeInTheDocument()
  })

  it('non-coder (finalizer) executing keeps "Executing..."', () => {
    renderNode({ agentType: 'finalizer', label: 'Finalizer', status: 'executing' })
    expect(screen.getByText('Executing...')).toBeInTheDocument()
  })

  it('coder fixing shows the attempt counter', () => {
    renderNode({ agentType: 'coder', status: 'fixing', fixAttempt: 2, maxFixAttempts: 3 })
    expect(screen.getByText(/Fixing \(2\/3\)/)).toBeInTheDocument()
  })
})

describe('VR-47 — Coder run→fix badge (persistent on done)', () => {
  it('green "✓ 1 run" when clean on first run', () => {
    renderNode({ agentType: 'coder', status: 'done', runFixCount: 1, runFixClean: true })
    const badge = screen.getByTestId('runfix-badge')
    expect(badge).toHaveAttribute('data-clean', 'true')
    expect(badge).toHaveTextContent('✓ 1 run')
  })

  it('green pluralizes → "✓ 3 runs"', () => {
    renderNode({ agentType: 'coder', status: 'done', runFixCount: 3, runFixClean: true })
    expect(screen.getByTestId('runfix-badge')).toHaveTextContent('✓ 3 runs')
  })

  it('yellow "⚠ 3/3" when the fix limit was reached', () => {
    renderNode({ agentType: 'coder', status: 'done', runFixCount: 3, runFixClean: false, maxFixAttempts: 3 })
    const badge = screen.getByTestId('runfix-badge')
    expect(badge).toHaveAttribute('data-clean', 'false')
    expect(badge).toHaveTextContent('⚠ 3/3')
  })

  it('no badge while still working (only after done)', () => {
    renderNode({ agentType: 'coder', status: 'working', runFixCount: 2, runFixClean: true })
    expect(screen.queryByTestId('runfix-badge')).not.toBeInTheDocument()
  })

  it('no badge when runFixCount is 0 (execution disabled / never ran)', () => {
    renderNode({ agentType: 'coder', status: 'done', runFixCount: 0, runFixClean: false })
    expect(screen.queryByTestId('runfix-badge')).not.toBeInTheDocument()
  })

  it('no badge on non-coder nodes', () => {
    renderNode({ agentType: 'finalizer', label: 'Finalizer', status: 'done', runFixCount: 2, runFixClean: true })
    expect(screen.queryByTestId('runfix-badge')).not.toBeInTheDocument()
  })
})

describe('VR-47 — wiring source pins', () => {
  const sdp = readSrc('src/pages/SessionDetailPage.tsx')
  it('buildGraph attaches run-fix data to coder nodes from code_versions', () => {
    expect(sdp).toContain('coderRunFixCount')
    expect(sdp).toContain('runFixClean: coderRunFixClean')
    expect(sdp).toContain('maxFixAttempts: sessionData.max_fix_attempts')
  })
  it('updateNodeStatus merges runFix fields', () => {
    expect(sdp).toContain('runFixCount: (data?.runFixCount as number)')
  })
  it('code_execution_completed records the live green outcome', () => {
    expect(sdp).toContain('runFixClean: true')
  })
})
