import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import notify from '../components/common/StyledToast'
import { createSession } from '../services/api'
import type { CreateSessionRequest, LLMProvider } from '../types'
import { useProvidersStore } from '../stores/providersStore'

/** Generate a session name like "Session-2026-02-17-14-30-05" */
function generateSessionName(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `Session-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
}

export default function NewSessionPage() {
  const navigate = useNavigate()
  const [error, setError] = useState('')
  const { providers, fetchProviders } = useProvidersStore()
  const creatingRef = useRef(false)

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  // Auto-create session as soon as providers are loaded
  useEffect(() => {
    if (providers.length === 0) return
    if (creatingRef.current) return
    creatingRef.current = true

    const defaultProvider = providers.find(p => p.configured) || providers[0]
    if (!defaultProvider) {
      setError('No providers configured. Please configure API keys in Settings.')
      return
    }

    const getDefaultModel = (providerName: string) => {
      const provider = providers.find(p => p.name === providerName)
      const model = provider?.models[0] || defaultProvider.models[0] || ''
      if (!model) {
        setError('No models available. Please configure an API key in Settings first.')
        notify.error('No models available')
        creatingRef.current = false
        return ''
      }
      return model
    }

    // Pick reasonable defaults
    const coderProvider = providers.find(p => p.name === 'anthropic' && p.configured) || defaultProvider
    const testerProvider = providers.find(p => p.name === 'openai' && p.configured) || defaultProvider

    const coderModel = getDefaultModel(coderProvider.name)
    if (!coderModel) return  // getDefaultModel already set error + reset creatingRef
    const testerModel = getDefaultModel(testerProvider.name)
    if (!testerModel) return

    const agentConfigs = [
      {
        agent_type: 'coder' as const,
        agent_index: 0,
        llm_provider: coderProvider.name as LLMProvider,
        llm_model: coderModel,
        max_tokens: 64000,
      },
      {
        agent_type: 'tester' as const,
        agent_index: 0,
        llm_provider: testerProvider.name as LLMProvider,
        llm_model: testerModel,
        max_tokens: 64000,
      },
      {
        agent_type: 'summarizer' as const,
        agent_index: 0,
        llm_provider: coderProvider.name as LLMProvider,
        llm_model: coderModel,
        max_tokens: 64000,
      },
      {
        agent_type: 'finalizer' as const,
        agent_index: 0,
        llm_provider: coderProvider.name as LLMProvider,
        llm_model: coderModel,
        max_tokens: 64000,
      },
    ]

    const request: CreateSessionRequest = {
      name: generateSessionName(),
      specification: '(not set)',
      language: 'python',
      max_iterations: 5,
      enable_code_execution: true,
      execution_timeout: 60,
      max_fix_attempts: 3,
      auto_install_deps: true,
      agent_configs: agentConfigs,
    }

    createSession(request)
      .then((session) => {
        navigate(`/sessions/${session.id}`, { replace: true })
      })
      .catch((err) => {
        console.error(err)
        setError('Failed to create session. Please try again.')
        notify.error('Failed to create session')
        creatingRef.current = false
      })
  }, [providers, navigate])

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <p className="text-cf-error text-lg mb-4">{error}</p>
          <button
            onClick={() => navigate('/settings')}
            className="px-4 py-2 bg-cf-primary text-white rounded-lg hover:bg-cf-secondary transition-colors"
          >
            Go to Settings
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="w-8 h-8 animate-spin text-cf-primary" />
        <p className="text-cf-text-muted">Creating session...</p>
      </div>
    </div>
  )
}
