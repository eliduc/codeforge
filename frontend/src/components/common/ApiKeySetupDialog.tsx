// Улучшатели#5 P1·M — Settings API-key consolidation.
// First-time wizard. Reuses <ApiKeyRow mode="bulk"> so the dialog and the
// SettingsPage share placeholder strings, show/hide handling, and the post-save
// `testLLMProvider` follow-up. The dialog keeps its own aggregate Save button
// (it commits N providers at once) and delegates per-row save+test to each row
// via an imperative ref handle.

import { Fragment, useRef, useState } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { KeyIcon } from '@heroicons/react/24/outline'
import notify from './StyledToast'
import Button from './Button'
import ApiKeyRow, { type ApiKeyRowHandle, type ApiKeyRowProvider } from '../ApiKeyRow'

interface ProviderEntry extends ApiKeyRowProvider {
  label: string
  placeholder: string
}

const PROVIDERS: ProviderEntry[] = [
  { name: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
  { name: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'sk-ant-api03-...' },
  { name: 'google', label: 'Google (Gemini)', placeholder: 'AIzaSy...' },
  { name: 'grok', label: 'xAI (Grok)', placeholder: 'xai-...' },
  { name: 'ollama', label: 'Ollama (local)', placeholder: 'http://localhost:11434', isUrl: true },
]

interface ApiKeySetupDialogProps {
  isOpen: boolean
  onClose: () => void
  onSaved: () => void
}

export default function ApiKeySetupDialog({ isOpen, onClose, onSaved }: ApiKeySetupDialogProps) {
  const [keys, setKeys] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const rowRefs = useRef<Record<string, ApiKeyRowHandle | null>>({})

  function updateKey(provider: string, value: string) {
    setKeys((prev) => ({ ...prev, [provider]: value }))
  }

  const filledCount = Object.values(keys).filter((v) => v.trim()).length

  async function handleSave() {
    const filled = PROVIDERS.filter((p) => (keys[p.name] || '').trim())
    if (filled.length === 0) {
      notify.error('Enter at least one API key')
      return
    }

    setSaving(true)
    let successCount = 0

    // Drive each row's saveAndTest sequentially so toasts are coherent and the
    // server isn't flooded with parallel writes.
    for (const p of filled) {
      const handle = rowRefs.current[p.name]
      if (!handle) continue
      const { saved } = await handle.saveAndTest()
      if (saved) successCount++
    }

    setSaving(false)

    if (successCount > 0) {
      notify.success(`${successCount} provider${successCount > 1 ? 's' : ''} configured!`)
      onSaved()
    } else {
      notify.error('Failed to save keys. Check your connection.')
    }
  }

  return (
    <Transition appear show={isOpen} as={Fragment}>
      {/* Улучшатели#5 P2·S — honor Esc to dismiss (backdrop click still ignored
          to prevent accidental clicks during typing). Pass through to parent's
          onClose so the user is never trapped on first launch. */}
      <Dialog as="div" className="relative z-50" onClose={() => { if (!saving) onClose() }}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/70 backdrop-blur-md" aria-hidden="true" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-90 translate-y-4"
              enterTo="opacity-100 scale-100 translate-y-0"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100 translate-y-0"
              leaveTo="opacity-0 scale-90 translate-y-4"
            >
              {/* Улучшатели#5 P1·M — cf-* tokens replace gray-800/gray-900 gradient. */}
              <Dialog.Panel className="w-full max-w-lg transform overflow-hidden rounded-2xl bg-cf-panel text-cf-text border border-cf-border p-6 shadow-2xl transition-all">
                {/* Header — first-time wizard framing stays unique to this dialog. */}
                <div className="flex flex-col items-center text-center mb-6">
                  <div className="p-4 rounded-2xl bg-indigo-100 text-indigo-700 dark:bg-cf-primary/15 dark:text-cf-primary mb-4">
                    <KeyIcon className="w-8 h-8" />
                  </div>
                  <Dialog.Title className="text-xl font-bold text-cf-text">
                    Welcome to CodeForge
                  </Dialog.Title>
                  <Dialog.Description className="text-sm text-cf-text-muted mt-2 max-w-sm leading-relaxed">
                    No LLM providers configured. Enter at least one API key to get started.
                  </Dialog.Description>
                </div>

                {/* Provider inputs — each row is the shared ApiKeyRow primitive. */}
                <div className="space-y-3">
                  {PROVIDERS.map((p) => (
                    <ApiKeyRow
                      key={p.name}
                      ref={(handle) => { rowRefs.current[p.name] = handle }}
                      provider={p}
                      mode="bulk"
                      showLabel
                      value={keys[p.name] || ''}
                      onChange={(v) => updateKey(p.name, v)}
                    />
                  ))}
                </div>

                {/* Actions — Улучшатели#5 P2·S — Skip promoted to ghost Button (equal visual weight)
                    plus an explanation so users know they can configure later. */}
                <div className="mt-6">
                  <p className="text-xs text-cf-text-muted mb-3 text-center">
                    You can add API keys later in Settings → API Keys.
                  </p>
                  <div className="flex items-center justify-end gap-3">
                    <Button
                      variant="ghost"
                      size="lg"
                      onClick={onClose}
                      disabled={saving}
                    >
                      Skip for now
                    </Button>
                    <Button
                      variant="primary"
                      size="lg"
                      onClick={handleSave}
                      disabled={filledCount === 0}
                      loading={saving}
                    >
                      {saving
                        ? 'Saving...'
                        : `Save & continue${filledCount > 0 ? ` (${filledCount})` : ''}`}
                    </Button>
                  </div>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
