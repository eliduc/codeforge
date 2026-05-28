// Улучшатели#5 P1·M — Settings API-key consolidation.
// Reusable per-provider row used by both:
//   * SettingsPage.tsx (inline mode — own Save/Test buttons per provider)
//   * common/ApiKeySetupDialog.tsx (bulk mode — just input + show/hide toggle;
//     the dialog drives a single aggregate Save and then asks each row to test).
//
// Consolidates placeholder strings, focus styles, show-key toggle handling, and
// (most importantly) ensures BOTH call sites now go through `testLLMProvider`
// after a successful save with the same loading state and result toast.

import { useState, forwardRef, useImperativeHandle } from 'react'
import { Eye, EyeOff, Save, TestTube } from 'lucide-react'
import Button from './common/Button'
import notify from './common/StyledToast'
import { testLLMProvider, apiFetch } from '../services/api'

export interface ApiKeyRowProvider {
  /** Backend provider id, e.g. "openai", "anthropic", "ollama". */
  name: string
  /** Human-readable label shown to the user. Defaults to a capitalised `name`. */
  label?: string
  /** Override placeholder. Falls back to a built-in map keyed by `name`. */
  placeholder?: string
  /** True once the backend has a stored key/url for this provider. */
  configured?: boolean
  /** Render hint: ollama uses "Base URL" instead of "API Key". */
  isUrl?: boolean
}

export interface ApiKeyRowProps {
  provider: ApiKeyRowProvider
  /** Current input value (controlled). */
  value: string
  onChange: (next: string) => void
  /**
   * `inline` — full row with Save + Test buttons (used in SettingsPage).
   * `bulk`   — just input + show/hide toggle (used in the first-time wizard
   *            dialog that drives its own aggregate Save).
   */
  mode?: 'inline' | 'bulk'
  /** Show the "{label}" caption on the left (bulk mode in the dialog). */
  showLabel?: boolean
  /** Called after a successful save+test cycle (inline) or imperative save (bulk). */
  onSaved?: () => void
  /** Optional rate-limit value sent with the save body (inline mode only). */
  rateLimit?: number
  /** Auto-focus input on mount. */
  autoFocus?: boolean
}

const DEFAULT_PLACEHOLDERS: Record<string, string> = {
  openai: 'sk-...',
  anthropic: 'sk-ant-api03-...',
  google: 'AIzaSy...',
  grok: 'xai-...',
  ollama: 'http://localhost:11434',
}

function defaultLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function resolvePlaceholder(p: ApiKeyRowProvider): string {
  if (p.placeholder) return p.placeholder
  return DEFAULT_PLACEHOLDERS[p.name] || 'API Key'
}

/** Imperative handle exposed to parents (e.g. the dialog uses this to drive bulk save). */
export interface ApiKeyRowHandle {
  /** Save the current value (if non-empty) and, on success, call testLLMProvider. */
  saveAndTest: () => Promise<{ saved: boolean; tested: boolean }>
}

const ApiKeyRow = forwardRef<ApiKeyRowHandle, ApiKeyRowProps>(function ApiKeyRow(
  {
    provider,
    value,
    onChange,
    mode = 'inline',
    showLabel = false,
    onSaved,
    rateLimit,
    autoFocus,
  },
  ref,
) {
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)

  const placeholder = provider.configured && !value
    ? '••••••••'
    : resolvePlaceholder(provider)
  const label = provider.label || defaultLabel(provider.name)
  const fieldLabel = provider.isUrl ? 'Base URL' : 'API Key'

  async function runTest(): Promise<boolean> {
    setTesting(true)
    try {
      const result = await testLLMProvider(provider.name)
      if (result.success) {
        notify.success(`${label} is working!`)
        return true
      }
      notify.error(`${label} test failed: ${result.message}`)
      return false
    } catch {
      notify.error(`${label} test failed`)
      return false
    } finally {
      setTesting(false)
    }
  }

  async function persistKey(): Promise<boolean> {
    if (!value.trim()) {
      notify.error(`Enter ${fieldLabel.toLowerCase()} for ${label}`)
      return false
    }
    setSaving(true)
    try {
      const body: Record<string, string | number> = { api_key: value.trim() }
      if (typeof rateLimit === 'number') body.rate_limit = rateLimit
      const result = await apiFetch<{ success: boolean; message?: string }>(
        `/api/settings/providers/${provider.name}/config`,
        { method: 'PUT', body: JSON.stringify(body) },
      )
      if (!result.success) {
        notify.error(result.message || `Failed to save ${label}`)
        return false
      }
      return true
    } catch {
      notify.error(`Failed to save ${label}`)
      return false
    } finally {
      setSaving(false)
    }
  }

  async function handleSave() {
    const saved = await persistKey()
    if (!saved) return
    notify.success(`${label} saved`)
    // Always follow up with a test — matches the dialog wizard contract.
    const tested = await runTest()
    if (tested) onSaved?.()
  }

  // Expose imperative save-and-test to parent (used by the wizard dialog for bulk save).
  useImperativeHandle(ref, () => ({
    async saveAndTest() {
      if (!value.trim()) return { saved: false, tested: false }
      const saved = await persistKey()
      if (!saved) return { saved: false, tested: false }
      const tested = await runTest()
      if (tested) onSaved?.()
      return { saved, tested }
    },
  }), [value, provider.name])

  const inputBlock = (
    <div className="relative flex-1">
      <input
        type={showKey ? 'text' : 'password'}
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={`${label} ${fieldLabel}`}
        className="w-full px-3 py-2 pr-10 bg-cf-input border border-cf-border rounded-lg text-cf-text placeholder-cf-text-muted focus:outline-none focus:ring-2 focus:ring-cf-primary text-sm font-mono"
      />
      <button
        type="button"
        title={showKey ? `Hide ${fieldLabel.toLowerCase()}` : `Show ${fieldLabel.toLowerCase()}`}
        aria-label={showKey ? `Hide ${fieldLabel.toLowerCase()}` : `Show ${fieldLabel.toLowerCase()}`}
        onClick={() => setShowKey((v) => !v)}
        tabIndex={-1}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-cf-text-muted hover:text-cf-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cf-primary rounded"
      >
        {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  )

  if (mode === 'bulk') {
    return (
      <div className="flex items-center gap-3">
        {showLabel && (
          <label className="w-36 text-sm font-medium text-cf-text shrink-0 text-right">
            {label}
          </label>
        )}
        {inputBlock}
      </div>
    )
  }

  // Inline (Settings) layout — input + Save + Test, all using Button primitive.
  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium text-cf-text">{fieldLabel}</label>
      <div className="flex items-stretch gap-2">
        {inputBlock}
        <Button
          variant="primary"
          size="md"
          onClick={handleSave}
          loading={saving}
          disabled={testing}
          leadingIcon={<Save className="w-4 h-4" />}
        >
          Save
        </Button>
        <Button
          variant="secondary"
          size="md"
          onClick={runTest}
          loading={testing}
          disabled={saving || !provider.configured}
          leadingIcon={<TestTube className="w-4 h-4" />}
          title={provider.configured ? 'Test provider connection' : 'Save a key first'}
        >
          Test
        </Button>
      </div>
      {provider.configured && !value && (
        <p className="text-xs text-green-400">✓ {fieldLabel} is configured</p>
      )}
    </div>
  )
})

export default ApiKeyRow
