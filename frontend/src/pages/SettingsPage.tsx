import { useState, useEffect } from 'react'
import {
  Key,
  CheckCircle,
  XCircle,
  Loader2,
  TestTube,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Palette,
  Bell,
} from 'lucide-react'
// Улучшатели#5 P2·S — provider-card skeleton row (replaces centered spinner).
function ProviderSkeletonRow() {
  return (
    <div className="bg-cf-bg rounded-lg p-4 animate-pulse">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4 flex-1">
          <div className="w-10 h-10 rounded-lg bg-cf-panel/40" />
          <div className="flex-1 space-y-2">
            <div className="h-4 w-32 bg-cf-panel/40 rounded" />
            <div className="h-3 w-48 bg-cf-panel/40 rounded" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-8 w-20 bg-cf-panel/40 rounded-lg" />
          <div className="h-9 w-24 bg-cf-panel/40 rounded-lg" />
          <div className="w-5 h-5 bg-cf-panel/40 rounded" />
        </div>
      </div>
    </div>
  )
}
import notify from '../components/common/StyledToast'
import Button from '../components/common/Button'
import ThemeToggle from '../components/common/ThemeToggle'
import ApiKeyRow from '../components/ApiKeyRow'
import { testLLMProvider, apiFetch } from '../services/api'
import WebhooksSection from '../components/WebhooksSection'
import type { ProviderInfo } from '../types'
import { useProvidersStore } from '../stores/providersStore'

interface ProviderConfig {
  apiKey: string
  rateLimit: number
  expanded: boolean
}

// Улучшатели#5 P1·M — Notifications prefs (localStorage-backed).
// TODO: persist to backend when /api/users/me/prefs exists.
type ToastVerbosity = 'verbose' | 'important-only' | 'silent'
type EmailDigest = 'weekly' | 'never'

const PREF_KEYS = {
  toastVerbosity: 'codeforge.prefs.toastVerbosity',
  desktopNotifications: 'codeforge.prefs.desktopNotifications',
  soundEnabled: 'codeforge.prefs.soundEnabled',
  emailDigest: 'codeforge.prefs.emailDigest',
} as const

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T
  } catch {
    // ignore
  }
  return fallback
}

function readBoolPref(key: string, fallback = false): boolean {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === 'true') return true
    if (raw === 'false') return false
  } catch {
    // ignore
  }
  return fallback
}

function writePref(key: string, value: string | boolean) {
  try {
    window.localStorage.setItem(key, String(value))
  } catch {
    // ignore
  }
}

export default function SettingsPage() {
  const { allProviders: providers, fetchProviders, refreshAllModels } = useProvidersStore()
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [configs, setConfigs] = useState<Record<string, ProviderConfig>>({})

  // Улучшатели#5 P1·M — Notifications prefs state (mirrors localStorage).
  const [toastVerbosity, setToastVerbosity] = useState<ToastVerbosity>(() =>
    readPref<ToastVerbosity>(PREF_KEYS.toastVerbosity, ['verbose', 'important-only', 'silent'], 'important-only'),
  )
  const [desktopEnabled, setDesktopEnabled] = useState<boolean>(() => readBoolPref(PREF_KEYS.desktopNotifications, false))
  const [soundEnabled, setSoundEnabled] = useState<boolean>(() => readBoolPref(PREF_KEYS.soundEnabled, false))
  const [emailDigest, setEmailDigest] = useState<EmailDigest>(() =>
    readPref<EmailDigest>(PREF_KEYS.emailDigest, ['weekly', 'never'], 'never'),
  )
  const [notifPermission, setNotifPermission] = useState<NotificationPermission | 'unsupported'>(() => {
    if (typeof Notification === 'undefined') return 'unsupported'
    return Notification.permission
  })

  useEffect(() => {
    fetchProviders().finally(() => setLoading(false))
  }, [fetchProviders])

  // Initialize configs when providers load
  useEffect(() => {
    if (providers.length === 0) return
    setConfigs(prev => {
      const updated: Record<string, ProviderConfig> = {}
      for (const provider of providers) {
        updated[provider.name] = prev[provider.name] || {
          apiKey: '',
          rateLimit: provider.rate_limit || 10,
          expanded: false,
        }
      }
      return updated
    })
  }, [providers])

  async function handleTest(provider: ProviderInfo) {
    if (!provider.configured || provider.models.length === 0) {
      notify.error('Provider not configured')
      return
    }

    setTesting(provider.name)
    try {
      const result = await testLLMProvider(provider.name)

      if (result.success) {
        notify.success(`${provider.name} is working!`)
      } else {
        notify.error(`Test failed: ${result.message}`)
      }
    } catch {
      notify.error('Test failed')
    } finally {
      setTesting(null)
    }
  }

  async function handleRefreshModels() {
    setRefreshing(true)
    try {
      const result = await refreshAllModels()
      if (result.success) {
        notify.success('Models refreshed!')
      } else {
        notify.error(result.error || 'Failed to refresh models')
      }
    } catch {
      notify.error('Failed to refresh models')
    } finally {
      setRefreshing(false)
    }
  }

  // Improvшатели#5 P1·M — rate-limit save (separated from API-key save, which lives in ApiKeyRow).
  async function handleSaveRateLimit(providerName: string) {
    const config = configs[providerName]
    if (!config) return
    try {
      const result = await apiFetch<{ success: boolean; message?: string }>(
        `/api/settings/providers/${providerName}/config`,
        { method: 'PUT', body: JSON.stringify({ rate_limit: config.rateLimit }) },
      )
      if (result.success) {
        notify.success(`${providerName} rate limit updated`)
        await fetchProviders(true)
      } else {
        notify.error(result.message || 'Failed to save rate limit')
      }
    } catch (err) {
      console.error(err)
      notify.error('Failed to save rate limit')
    }
  }

  function toggleExpanded(providerName: string) {
    setConfigs(prev => ({
      ...prev,
      [providerName]: { ...prev[providerName], expanded: !prev[providerName]?.expanded },
    }))
  }

  function updateConfig(providerName: string, field: keyof ProviderConfig, value: string | number | boolean) {
    setConfigs(prev => ({
      ...prev,
      [providerName]: { ...prev[providerName], [field]: value },
    }))
  }

  // Улучшатели#5 P1·M — Notifications pref handlers.
  function handleVerbosityChange(next: ToastVerbosity) {
    setToastVerbosity(next)
    writePref(PREF_KEYS.toastVerbosity, next)
  }

  async function handleDesktopToggle(next: boolean) {
    if (next && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        const perm = await Notification.requestPermission()
        setNotifPermission(perm)
        if (perm !== 'granted') {
          notify.warning('Desktop notifications denied by browser')
          return
        }
      } catch {
        notify.error('Failed to request notification permission')
        return
      }
    }
    setDesktopEnabled(next)
    writePref(PREF_KEYS.desktopNotifications, next)
  }

  async function handleRequestPermission() {
    if (typeof Notification === 'undefined') {
      notify.error('Browser does not support notifications')
      return
    }
    try {
      const perm = await Notification.requestPermission()
      setNotifPermission(perm)
      if (perm === 'granted') {
        notify.success('Desktop notifications enabled')
      } else if (perm === 'denied') {
        notify.warning('Desktop notifications denied')
      }
    } catch {
      notify.error('Failed to request notification permission')
    }
  }

  function handleSoundToggle(next: boolean) {
    setSoundEnabled(next)
    writePref(PREF_KEYS.soundEnabled, next)
  }

  function handleEmailDigestChange(next: EmailDigest) {
    setEmailDigest(next)
    writePref(PREF_KEYS.emailDigest, next)
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-cf-text mb-2">Settings</h1>
          <p className="text-cf-text-muted">
            Configure LLM providers and application settings
          </p>
        </div>

        {/* Appearance / Theme */}
        <div className="bg-cf-panel rounded-xl p-6 border border-cf-border mb-6">
          <h2 className="text-lg font-semibold text-cf-text flex items-center gap-2 mb-4">
            <Palette className="w-5 h-5 text-cf-primary" />
            Appearance
          </h2>

          {/* Улучшатели#5 P1·M — ThemeToggle primitive (pill variant). */}
          <div className="flex items-center gap-4">
            <span className="text-sm text-cf-text-muted">Theme</span>
            <ThemeToggle variant="pill" />
          </div>
        </div>

        {/* Улучшатели#5 P1·M — Notifications section (localStorage-backed prefs). */}
        <div className="bg-cf-panel rounded-xl p-6 border border-cf-border mb-6">
          <h2 className="text-lg font-semibold text-cf-text flex items-center gap-2 mb-4">
            <Bell className="w-5 h-5 text-cf-primary" />
            Notifications
          </h2>
          <p className="text-sm text-cf-text-muted mb-4">
            Control how CodeForge alerts you. Preferences are stored locally in this browser.
            {/* TODO: persist to backend when /api/users/me/prefs exists */}
          </p>

          {/* Toast verbosity */}
          <fieldset className="mb-5">
            <legend className="text-sm font-medium text-cf-text mb-2">Toast notifications</legend>
            <div className="flex flex-col gap-2">
              {([
                { value: 'verbose', label: 'Verbose', hint: 'Show all toasts (success, info, warning, error)' },
                { value: 'important-only', label: 'Important only', hint: 'Only warnings and errors (default)' },
                { value: 'silent', label: 'Silent', hint: 'Only errors — success/info/warning suppressed' },
              ] as const).map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-start gap-3 p-3 rounded-lg bg-cf-bg hover:bg-cf-hover transition-colors cursor-pointer border border-transparent has-[:checked]:border-cf-primary/40"
                >
                  <input
                    type="radio"
                    name="toast-verbosity"
                    value={opt.value}
                    checked={toastVerbosity === opt.value}
                    onChange={() => handleVerbosityChange(opt.value)}
                    className="mt-0.5 accent-cf-primary"
                  />
                  <div className="flex-1">
                    <div className="text-sm font-medium text-cf-text">{opt.label}</div>
                    <div className="text-xs text-cf-text-muted">{opt.hint}</div>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>

          {/* Desktop notifications */}
          <div className="mb-5">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={desktopEnabled && notifPermission === 'granted'}
                onChange={(e) => handleDesktopToggle(e.target.checked)}
                disabled={notifPermission === 'unsupported' || notifPermission === 'denied'}
                className="mt-0.5 accent-cf-primary"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-cf-text">Browser desktop notifications</div>
                <div className="text-xs text-cf-text-muted">
                  Show OS-level notifications for warnings and errors.
                  {' '}
                  <span className="text-cf-text-muted">
                    Permission: <span className="font-mono">{notifPermission}</span>
                  </span>
                </div>
                {notifPermission === 'default' && (
                  <div className="mt-2">
                    <Button variant="secondary" size="sm" onClick={handleRequestPermission}>
                      Request permission
                    </Button>
                  </div>
                )}
                {notifPermission === 'denied' && (
                  <div className="mt-1 text-xs text-cf-text-muted">
                    Browser has blocked notifications — re-enable them in your browser settings.
                  </div>
                )}
              </div>
            </label>
          </div>

          {/* Sound */}
          <div className="mb-5">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={soundEnabled}
                onChange={(e) => handleSoundToggle(e.target.checked)}
                className="mt-0.5 accent-cf-primary"
              />
              <div className="flex-1">
                <div className="text-sm font-medium text-cf-text">Notification sound</div>
                <div className="text-xs text-cf-text-muted">Play a short tone on warnings and errors.</div>
              </div>
            </label>
          </div>

          {/* Email digest */}
          <fieldset>
            <legend className="text-sm font-medium text-cf-text mb-2">
              Email digest <span className="text-xs text-cf-text-muted font-normal">(coming soon)</span>
            </legend>
            <div className="flex gap-3">
              {([
                { value: 'weekly', label: 'Weekly summary' },
                { value: 'never', label: 'Never' },
              ] as const).map((opt) => (
                <label
                  key={opt.value}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-cf-bg hover:bg-cf-hover transition-colors cursor-pointer border border-transparent has-[:checked]:border-cf-primary/40"
                >
                  <input
                    type="radio"
                    name="email-digest"
                    value={opt.value}
                    checked={emailDigest === opt.value}
                    onChange={() => handleEmailDigestChange(opt.value)}
                    className="accent-cf-primary"
                  />
                  <span className="text-sm text-cf-text">{opt.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        {/* LLM Providers */}
        <div className="bg-cf-panel rounded-xl p-6 border border-cf-border mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-cf-text flex items-center gap-2">
              <Key className="w-5 h-5 text-cf-primary" />
              LLM Providers
            </h2>
            <button
              onClick={handleRefreshModels}
              disabled={refreshing}
              className="flex items-center gap-2 px-3 py-1.5 bg-cf-border hover:bg-cf-hover text-cf-text text-sm font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              {/* Улучшатели#5 P2·S — sentence-case button label. */}
              {refreshing ? 'Refreshing...' : 'Refresh models'}
            </button>
          </div>

          <p className="text-sm text-cf-text-muted mb-4">
            Configure API keys and rate limits for each provider. Click on a provider to expand configuration options.
          </p>

          {loading ? (
            // Улучшатели#5 P2·S — skeleton rows match final card layout instead of bare spinner.
            <div className="space-y-3" role="status" aria-busy="true" aria-label="Loading providers">
              <ProviderSkeletonRow />
              <ProviderSkeletonRow />
              <ProviderSkeletonRow />
            </div>
          ) : (
            <div className="space-y-3">
              {providers.map(provider => {
                const config = configs[provider.name] || { apiKey: '', rateLimit: 10, expanded: false }

                return (
                  <div
                    key={provider.name}
                    className="bg-cf-bg rounded-lg overflow-hidden"
                  >
                    {/* Provider Header — КАО#R3-S3: keyboard-operable (was a
                        plain onClick div; nested Test button rules out a real
                        <button>, so role=button + tabIndex + Enter/Space). */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={config.expanded}
                      className="flex items-center justify-between p-4 cursor-pointer hover:bg-cf-hover transition-colors focus:outline-none focus:ring-2 focus:ring-cf-accent/50 focus:ring-inset"
                      onClick={() => toggleExpanded(provider.name)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded(provider.name) } }}
                    >
                      <div className="flex items-center gap-4">
                        <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                          provider.configured ? 'bg-green-500/20' : 'bg-cf-border'
                        }`}>
                          {provider.configured ? (
                            <CheckCircle className="w-5 h-5 text-green-400" />
                          ) : (
                            <XCircle className="w-5 h-5 text-cf-text-muted" />
                          )}
                        </div>

                        <div>
                          <div className="font-medium text-cf-text capitalize">
                            {provider.name}
                          </div>
                          <div className="text-sm text-cf-text-muted">
                            {provider.configured
                              ? `${provider.models.length} models available`
                              : 'Not configured'
                            }
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        {provider.configured && (
                          <div className="text-sm text-cf-text-muted">
                            Rate limit: {provider.rate_limit}/min
                          </div>
                        )}

                        <button
                          onClick={(e) => { e.stopPropagation(); handleTest(provider); }}
                          disabled={!provider.configured || testing === provider.name}
                          className="flex items-center gap-2 px-3 py-1.5 bg-cf-border hover:bg-cf-hover disabled:opacity-40 text-cf-text text-sm font-medium rounded-lg transition-colors"
                        >
                          {testing === provider.name ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <TestTube className="w-4 h-4" />
                          )}
                          Test
                        </button>

                        {config.expanded ? (
                          <ChevronUp className="w-5 h-5 text-cf-text-muted" />
                        ) : (
                          <ChevronDown className="w-5 h-5 text-cf-text-muted" />
                        )}
                      </div>
                    </div>

                    {/* Expanded Configuration */}
                    {config.expanded && (
                      <div className="px-4 pb-4 pt-2 border-t border-cf-border space-y-4">
                        {/* Улучшатели#5 P1·M — Settings API-key consolidation.
                            Inline API-key UI now lives in <ApiKeyRow> so it stays
                            in sync with ApiKeySetupDialog (placeholders, show/hide
                            toggle, post-save test). */}
                        <ApiKeyRow
                          provider={{
                            name: provider.name,
                            configured: provider.configured,
                            isUrl: provider.name === 'ollama',
                          }}
                          mode="inline"
                          value={config.apiKey}
                          onChange={(v) => updateConfig(provider.name, 'apiKey', v)}
                          rateLimit={config.rateLimit}
                          onSaved={() => {
                            updateConfig(provider.name, 'apiKey', '')
                            fetchProviders(true)
                          }}
                        />

                        {/* Rate Limit Input + Save (separate write — API-key save is row-owned). */}
                        <div>
                          <label className="block text-sm font-medium text-cf-text mb-1" htmlFor={`rate-limit-${provider.name}`}>
                            Rate Limit (requests/min)
                          </label>
                          <div className="flex items-stretch gap-2">
                            <input
                              id={`rate-limit-${provider.name}`}
                              type="number"
                              value={config.rateLimit}
                              onChange={(e) => { const n = parseInt(e.target.value); updateConfig(provider.name, 'rateLimit', isNaN(n) ? 10 : n) }}
                              min={1}
                              max={1000}
                              className="flex-1 px-3 py-2 bg-cf-input border border-cf-border rounded-lg text-cf-text focus:outline-none focus:ring-2 focus:ring-cf-primary text-sm"
                            />
                            <Button
                              variant="secondary"
                              size="md"
                              onClick={() => handleSaveRateLimit(provider.name)}
                              disabled={!provider.configured}
                              title={provider.configured ? 'Save rate limit' : 'Save an API key first'}
                            >
                              Save rate limit
                            </Button>
                          </div>
                        </div>

                        {/* Available Models */}
                        {provider.models.length > 0 && (
                          <div>
                            <label className="block text-sm font-medium text-cf-text mb-2">
                              Available Models ({provider.models.length})
                            </label>
                            <div className="flex flex-wrap gap-2">
                              {provider.models.slice(0, 8).map(model => (
                                <span
                                  key={model}
                                  className="px-2 py-1 bg-cf-input text-cf-text-muted text-xs rounded-md font-mono"
                                >
                                  {model}
                                </span>
                              ))}
                              {provider.models.length > 8 && (
                                <span className="px-2 py-1 bg-cf-border text-cf-text-muted text-xs rounded-md">
                                  +{provider.models.length - 8} more
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Webhooks */}
        <WebhooksSection />

      </div>
    </div>
  )
}
