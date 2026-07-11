/**
 * КАО#R6-models — background "new models available" notifier.
 *
 * On app entry (once per mount, after providers load), asks the backend whether
 * newer models have appeared for any vendor that has a key configured. If so,
 * raises a persistent toast summarising them with a "Load latest" action that
 * refreshes the model lists, and a "Dismiss" that acknowledges them so the same
 * set won't nag again. Entirely best-effort — never blocks or errors the UI.
 */
import { useEffect, useRef } from 'react'
import { createElement as h } from 'react'
import toast from 'react-hot-toast'
import { useProvidersStore } from '../stores/providersStore'
import type { ModelUpdatesResponse } from '../services/api'

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  grok: 'Grok',
}

const TOAST_ID = 'model-updates'

function buildRows(data: ModelUpdatesResponse) {
  return Object.entries(data.providers)
    .map(([provider, info]) => ({
      provider,
      label: PROVIDER_LABELS[provider] ?? provider,
      newModels: info.new ?? [],
      announced: info.announced ?? [],
    }))
    .filter((r) => r.newModels.length > 0 || r.announced.length > 0)
}

export function useModelUpdateNotifier() {
  const loaded = useProvidersStore((s) => s.loaded)
  const hasAnyConfigured = useProvidersStore((s) => s.hasAnyConfigured)
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    if (!loaded || !hasAnyConfigured) return
    ranRef.current = true

    ;(async () => {
      const store = useProvidersStore.getState()
      const data = await store.checkModelUpdates()
      if (!data || !data.has_updates) return
      const rows = buildRows(data)
      if (rows.length === 0) return

      toast(
        (t) =>
          h(
            'div',
            { className: 'flex flex-col gap-2 min-w-[240px]' },
            h(
              'div',
              { className: 'font-semibold text-cf-text flex items-center gap-2' },
              h('span', { 'aria-hidden': true }, '✨'),
              'New models available',
            ),
            h(
              'ul',
              { className: 'text-sm text-cf-text-muted space-y-0.5' },
              ...rows.map((r) =>
                h(
                  'li',
                  { key: r.provider },
                  h('span', { className: 'text-cf-text font-medium' }, `${r.label}: `),
                  r.newModels.length > 0 ? r.newModels.join(', ') : null,
                  r.announced.length > 0
                    ? h(
                        'span',
                        { className: 'italic' },
                        `${r.newModels.length > 0 ? ' · ' : ''}announced: ${r.announced.join(', ')}`,
                      )
                    : null,
                ),
              ),
            ),
            h(
              'div',
              { className: 'flex gap-2 mt-1' },
              h(
                'button',
                {
                  className:
                    'px-3 py-1 text-sm rounded-md bg-cf-primary text-white hover:bg-cf-secondary transition-colors',
                  onClick: async () => {
                    const s = useProvidersStore.getState()
                    await s.refreshAllModels()
                    await s.acknowledgeModels()
                    toast.dismiss(t.id)
                    toast.success('Model lists updated')
                  },
                },
                'Load latest',
              ),
              h(
                'button',
                {
                  className:
                    'px-3 py-1 text-sm rounded-md border border-cf-border text-cf-text hover:bg-cf-border transition-colors',
                  onClick: async () => {
                    await useProvidersStore.getState().acknowledgeModels()
                    toast.dismiss(t.id)
                  },
                },
                'Dismiss',
              ),
            ),
          ),
        { id: TOAST_ID, duration: Infinity },
      )
    })()
  }, [loaded, hasAnyConfigured])
}
