/**
 * КАО#R6-models — behavioral tests for the "new models available" notifier.
 *
 * Drives the real useModelUpdateNotifier hook + real providersStore, mocking
 * only the API boundary, and asserts the toast appears with the new models and
 * that "Load latest" refreshes + acknowledges.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster } from 'react-hot-toast'
import toast from 'react-hot-toast'

vi.mock('../services/api', () => ({
  checkModelUpdates: vi.fn(),
  acknowledgeModelUpdates: vi.fn().mockResolvedValue({ acknowledged: true, providers: [] }),
  refreshModels: vi.fn().mockResolvedValue({ success: true, message: 'ok', providers: [] }),
  getLLMProviders: vi.fn().mockResolvedValue({ providers: [] }),
}))

import * as api from '../services/api'
import { useProvidersStore } from '../stores/providersStore'
import { useModelUpdateNotifier } from '../hooks/useModelUpdateNotifier'

function Harness() {
  useModelUpdateNotifier()
  return <Toaster />
}

beforeEach(() => {
  vi.clearAllMocks()
  toast.remove() // react-hot-toast is a global singleton — clear leftovers
  useProvidersStore.setState({ loaded: true, hasAnyConfigured: true })
})

describe('КАО#R6 — model-update notifier', () => {
  it('shows a toast with the new models when updates exist', async () => {
    ;(api.checkModelUpdates as ReturnType<typeof vi.fn>).mockResolvedValue({
      has_updates: true,
      tavily_enabled: true,
      checked_at: '2026-07-02T00:00:00Z',
      providers: {
        openai: { current: ['gpt-5.6'], new: ['gpt-5.6'], announced: [] },
        grok: { current: ['grok-4.3'], new: [], announced: ['grok-4.5'] },
      },
    })

    render(<Harness />)

    expect(await screen.findByText('New models available')).toBeInTheDocument()
    expect(screen.getByText(/gpt-5\.6/)).toBeInTheDocument()
    // announced label present for grok
    expect(screen.getByText(/announced: grok-4\.5/)).toBeInTheDocument()
  })

  it('does NOT show a toast when there are no updates', async () => {
    ;(api.checkModelUpdates as ReturnType<typeof vi.fn>).mockResolvedValue({
      has_updates: false,
      tavily_enabled: true,
      checked_at: '2026-07-02T00:00:00Z',
      providers: {},
    })

    render(<Harness />)

    await waitFor(() => expect(api.checkModelUpdates).toHaveBeenCalled())
    expect(screen.queryByText('New models available')).not.toBeInTheDocument()
  })

  it('"Load latest" refreshes models and acknowledges', async () => {
    ;(api.checkModelUpdates as ReturnType<typeof vi.fn>).mockResolvedValue({
      has_updates: true,
      tavily_enabled: false,
      checked_at: '2026-07-02T00:00:00Z',
      providers: { openai: { current: ['gpt-5.6'], new: ['gpt-5.6'], announced: [] } },
    })

    render(<Harness />)
    const loadBtn = await screen.findByRole('button', { name: 'Load latest' })
    await userEvent.click(loadBtn)

    await waitFor(() => {
      expect(api.refreshModels).toHaveBeenCalled()
      expect(api.acknowledgeModelUpdates).toHaveBeenCalled()
    })
  })

  it('"Dismiss" acknowledges without refreshing', async () => {
    ;(api.checkModelUpdates as ReturnType<typeof vi.fn>).mockResolvedValue({
      has_updates: true,
      tavily_enabled: false,
      checked_at: '2026-07-02T00:00:00Z',
      providers: { openai: { current: ['gpt-5.6'], new: ['gpt-5.6'], announced: [] } },
    })

    render(<Harness />)
    const dismissBtn = await screen.findByRole('button', { name: 'Dismiss' })
    await userEvent.click(dismissBtn)

    await waitFor(() => expect(api.acknowledgeModelUpdates).toHaveBeenCalled())
    expect(api.refreshModels).not.toHaveBeenCalled()
  })
})
