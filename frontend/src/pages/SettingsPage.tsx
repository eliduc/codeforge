import { useState, useEffect } from 'react'
import {
  Key,
  CheckCircle,
  XCircle,
  Loader2,
  TestTube,
  Save,
  RefreshCw,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Sun,
  Moon,
  Palette,
} from 'lucide-react'
import notify from '../components/common/StyledToast'
import { testLLMProvider, apiFetch } from '../services/api'
import type { ProviderInfo } from '../types'
import { useProvidersStore } from '../stores/providersStore'
import { useThemeStore } from '../stores/themeStore'

interface ProviderConfig {
  apiKey: string
  rateLimit: number
  showKey: boolean
  expanded: boolean
  saving: boolean
}

export default function SettingsPage() {
  const { allProviders: providers, loading: storeLoading, fetchProviders, refreshAllModels } = useProvidersStore()
  const { theme, setTheme } = useThemeStore()
  const [loading, setLoading] = useState(true)
  const [testing, setTesting] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [configs, setConfigs] = useState<Record<string, ProviderConfig>>({})

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
          showKey: false,
          expanded: false,
          saving: false,
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
    } catch (err) {
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
    } catch (err) {
      notify.error('Failed to refresh models')
    } finally {
      setRefreshing(false)
    }
  }

  async function handleSaveConfig(providerName: string) {
    const config = configs[providerName]
    if (!config) return

    setConfigs(prev => ({
      ...prev,
      [providerName]: { ...prev[providerName], saving: true }
    }))

    try {
      const body: Record<string, string | number> = {}
      if (config.apiKey) {
        body.api_key = config.apiKey
      }
      body.rate_limit = config.rateLimit

      const result = await apiFetch<{ success: boolean; message?: string; models?: string[] }>(`/api/settings/providers/${providerName}/config`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })

      if (result.success) {
        notify.success(`${providerName} configuration saved!`)
        // Clear the API key input after saving
        setConfigs(prev => ({
          ...prev,
          [providerName]: { ...prev[providerName], apiKey: '' }
        }))
        // Reload providers to get updated status
        await fetchProviders(true)
      } else {
        notify.error(result.message || 'Failed to save configuration')
      }
    } catch (err) {
      notify.error('Failed to save configuration')
      console.error(err)
    } finally {
      setConfigs(prev => ({
        ...prev,
        [providerName]: { ...prev[providerName], saving: false }
      }))
    }
  }

  function toggleExpanded(providerName: string) {
    setConfigs(prev => ({
      ...prev,
      [providerName]: { ...prev[providerName], expanded: !prev[providerName]?.expanded }
    }))
  }

  function updateConfig(providerName: string, field: keyof ProviderConfig, value: string | number | boolean) {
    setConfigs(prev => ({
      ...prev,
      [providerName]: { ...prev[providerName], [field]: value }
    }))
  }

  const getPlaceholder = (providerName: string) => {
    const placeholders: Record<string, string> = {
      openai: 'sk-...',
      anthropic: 'sk-ant-api03-...',
      google: 'AIzaSy...',
      grok: 'xai-...',
      ollama: 'http://localhost:11434',
    }
    return placeholders[providerName] || 'API Key'
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

          <div className="flex items-center gap-4">
            <span className="text-sm text-cf-text-muted">Theme</span>
            <div className="inline-flex rounded-lg border border-cf-border overflow-hidden">
              <button
                onClick={() => setTheme('light')}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
                  theme === 'light'
                    ? 'bg-cf-primary text-white'
                    : 'bg-cf-bg text-cf-text-muted hover:text-cf-text hover:bg-cf-hover'
                }`}
              >
                <Sun className="w-4 h-4" />
                Light
              </button>
              <button
                onClick={() => setTheme('dark')}
                className={`flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors ${
                  theme === 'dark'
                    ? 'bg-cf-primary text-white'
                    : 'bg-cf-bg text-cf-text-muted hover:text-cf-text hover:bg-cf-hover'
                }`}
              >
                <Moon className="w-4 h-4" />
                Dark
              </button>
            </div>
          </div>
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
              {refreshing ? 'Refreshing...' : 'Refresh Models'}
            </button>
          </div>

          <p className="text-sm text-cf-text-muted mb-4">
            Configure API keys and rate limits for each provider. Click on a provider to expand configuration options.
          </p>

          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 text-cf-primary animate-spin" />
            </div>
          ) : (
            <div className="space-y-3">
              {providers.map(provider => {
                const config = configs[provider.name] || { apiKey: '', rateLimit: 10, showKey: false, expanded: false, saving: false }

                return (
                  <div
                    key={provider.name}
                    className="bg-cf-bg rounded-lg overflow-hidden"
                  >
                    {/* Provider Header */}
                    <div
                      className="flex items-center justify-between p-4 cursor-pointer hover:bg-cf-hover transition-colors"
                      onClick={() => toggleExpanded(provider.name)}
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
                      <div className="px-4 pb-4 pt-2 border-t border-cf-border">
                        <div className="grid grid-cols-2 gap-4">
                          {/* API Key Input */}
                          <div>
                            <label className="block text-sm font-medium text-cf-text mb-1">
                              {provider.name === 'ollama' ? 'Base URL' : 'API Key'}
                            </label>
                            <div className="relative">
                              <input
                                type={config.showKey ? 'text' : 'password'}
                                value={config.apiKey}
                                onChange={(e) => updateConfig(provider.name, 'apiKey', e.target.value)}
                                placeholder={provider.configured && !config.apiKey ? '••••••••' : getPlaceholder(provider.name)}
                                className="w-full px-3 py-2 pr-10 bg-cf-input border border-cf-border rounded-lg text-cf-text placeholder-cf-text-muted focus:outline-none focus:ring-2 focus:ring-cf-primary text-sm font-mono"
                              />
                              <button
                                type="button"
                                onClick={() => updateConfig(provider.name, 'showKey', !config.showKey)}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-cf-text-muted hover:text-cf-text"
                              >
                                {config.showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            </div>
                            {provider.configured && (
                              <p className="text-xs text-green-400 mt-1">✓ API key is configured</p>
                            )}
                          </div>

                          {/* Rate Limit Input */}
                          <div>
                            <label className="block text-sm font-medium text-cf-text mb-1">
                              Rate Limit (requests/min)
                            </label>
                            <input
                              type="number"
                              value={config.rateLimit}
                              onChange={(e) => { const n = parseInt(e.target.value); updateConfig(provider.name, 'rateLimit', isNaN(n) ? 10 : n) }}
                              min={1}
                              max={1000}
                              className="w-full px-3 py-2 bg-cf-input border border-cf-border rounded-lg text-cf-text focus:outline-none focus:ring-2 focus:ring-cf-primary text-sm"
                            />
                          </div>
                        </div>

                        {/* Available Models */}
                        {provider.models.length > 0 && (
                          <div className="mt-4">
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

                        {/* Save Button */}
                        <div className="mt-4 flex justify-end">
                          <button
                            onClick={() => handleSaveConfig(provider.name)}
                            disabled={config.saving}
                            className="flex items-center gap-2 px-4 py-2 bg-cf-primary hover:bg-cf-secondary disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
                          >
                            {config.saving ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <Save className="w-4 h-4" />
                            )}
                            {config.saving ? 'Saving...' : 'Save Configuration'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
