import { Fragment, useState } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { KeyIcon } from '@heroicons/react/24/outline'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import notify from './StyledToast'
import { apiFetch } from '../../services/api'

interface ProviderEntry {
  name: string
  label: string
  placeholder: string
  isUrl?: boolean
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
  const [showKey, setShowKey] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)

  function updateKey(provider: string, value: string) {
    setKeys(prev => ({ ...prev, [provider]: value }))
  }

  function toggleShow(provider: string) {
    setShowKey(prev => ({ ...prev, [provider]: !prev[provider] }))
  }

  const filledCount = Object.values(keys).filter(v => v.trim()).length

  async function handleSave() {
    const filled = Object.entries(keys).filter(([, v]) => v.trim())
    if (filled.length === 0) {
      notify.error('Enter at least one API key')
      return
    }

    setSaving(true)
    let successCount = 0

    for (const [provider, key] of filled) {
      try {
        const body: Record<string, string> = { api_key: key.trim() }
        const result = await apiFetch<{ success: boolean }>(`/api/settings/providers/${provider}/config`, {
          method: 'PUT',
          body: JSON.stringify(body),
        })
        if (result.success) successCount++
      } catch {
        // continue with other providers
      }
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
      <Dialog as="div" className="relative z-50" onClose={() => { /* non-dismissible via backdrop */ }}>
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
              <Dialog.Panel className="w-full max-w-lg transform overflow-hidden rounded-2xl bg-gradient-to-b from-gray-800 to-gray-900 border border-indigo-500/30 p-6 shadow-2xl transition-all">
                {/* Header */}
                <div className="flex flex-col items-center text-center mb-6">
                  <div className="p-4 rounded-2xl bg-gradient-to-br from-indigo-500/30 to-indigo-600/20 text-indigo-400 mb-4">
                    <KeyIcon className="w-8 h-8" />
                  </div>
                  <Dialog.Title className="text-xl font-bold text-white">
                    Welcome to CodeForge
                  </Dialog.Title>
                  <Dialog.Description className="text-sm text-gray-400 mt-2 max-w-sm leading-relaxed">
                    No LLM providers configured. Enter at least one API key to get started.
                  </Dialog.Description>
                </div>

                {/* Provider inputs */}
                <div className="space-y-3">
                  {PROVIDERS.map((p) => (
                    <div key={p.name} className="flex items-center gap-3">
                      <label className="w-36 text-sm font-medium text-gray-300 shrink-0 text-right">
                        {p.label}
                      </label>
                      <div className="relative flex-1">
                        <input
                          type={showKey[p.name] ? 'text' : 'password'}
                          value={keys[p.name] || ''}
                          onChange={(e) => updateKey(p.name, e.target.value)}
                          placeholder={p.placeholder}
                          className="w-full px-3 py-2 pr-9 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-mono"
                        />
                        <button
                          type="button"
                          onClick={() => toggleShow(p.name)}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white"
                          tabIndex={-1}
                        >
                          {showKey[p.name] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Actions */}
                <div className="mt-6 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={saving}
                    className="text-sm text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
                  >
                    Skip for now
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || filledCount === 0}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:opacity-50 shadow-lg shadow-indigo-500/25"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      `Save & Continue${filledCount > 0 ? ` (${filledCount})` : ''}`
                    )}
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
