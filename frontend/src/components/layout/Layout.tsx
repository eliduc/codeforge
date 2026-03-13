import { useState, useEffect, useCallback, Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { Code2, Settings, FolderOpen, Plus, PanelLeftClose, PanelLeftOpen, AlertTriangle } from 'lucide-react'
import { Toaster } from 'react-hot-toast'
import clsx from 'clsx'
import { useProvidersStore } from '../../stores/providersStore'
import { useThemeStore } from '../../stores/themeStore'
import ApiKeySetupDialog from '../common/ApiKeySetupDialog'

// Error Boundary to catch render crashes in child components
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <AlertTriangle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-cf-text mb-2">Something went wrong</h2>
            <p className="text-sm text-cf-text-muted mb-4">
              {this.state.error?.message || 'An unexpected error occurred.'}
            </p>
            <button
              onClick={() => {
                this.setState({ hasError: false, error: null })
                window.location.reload()
              }}
              className="px-4 py-2 bg-cf-primary text-white rounded-lg hover:bg-cf-primary/90 transition-colors"
            >
              Reload Page
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const location = useLocation()
  const fetchProviders = useProvidersStore(s => s.fetchProviders)
  const loaded = useProvidersStore(s => s.loaded)
  const hasAnyConfigured = useProvidersStore(s => s.hasAnyConfigured)
  // Initialize theme (store applies correct class on document.documentElement)
  useThemeStore(s => s.theme)

  // API key setup dialog — shown once per session when no providers are configured
  const [showApiKeySetup, setShowApiKeySetup] = useState(false)
  const [apiKeyCheckDone, setApiKeyCheckDone] = useState(false)

  // Pre-fetch providers on app startup (cached — no duplicate calls)
  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  // Check if we need to show the API key setup dialog
  useEffect(() => {
    if (loaded && !apiKeyCheckDone) {
      setApiKeyCheckDone(true)
      if (!hasAnyConfigured) {
        setShowApiKeySetup(true)
      }
    }
  }, [loaded, hasAnyConfigured, apiKeyCheckDone])

  // Sidebar collapsed state — persisted in localStorage
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('codeforge_sidebar_collapsed') === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('codeforge_sidebar_collapsed', String(sidebarCollapsed))
    } catch { /* ignore */ }
  }, [sidebarCollapsed])

  const toggleSidebar = useCallback(() => {
    setSidebarCollapsed(prev => !prev)
  }, [])

  const navItems = [
    { path: '/sessions', icon: FolderOpen, label: 'Sessions' },
    { path: '/sessions/new', icon: Plus, label: 'New Session' },
    { path: '/settings', icon: Settings, label: 'Settings' },
  ]

  return (
    <div className="min-h-screen bg-cf-bg flex">
      {/* Sidebar */}
      <aside
        className={clsx(
          'bg-cf-panel border-r border-cf-border flex flex-col flex-shrink-0',
          'transition-all duration-300 ease-in-out overflow-hidden',
          sidebarCollapsed ? 'w-12' : 'w-64'
        )}
        aria-label="Main navigation"
      >
        {/* Logo / Toggle */}
        <div className={clsx(
          'border-b border-cf-border flex items-center min-h-[56px]',
          sidebarCollapsed ? 'justify-center px-1 py-3' : 'justify-between px-4 py-3'
        )}>
          {!sidebarCollapsed && (
            <Link to="/" className="flex items-center gap-3 overflow-hidden">
              <div className="w-8 h-8 bg-gradient-to-br from-cf-primary to-cf-secondary rounded-lg flex items-center justify-center flex-shrink-0">
                <Code2 className="w-5 h-5 text-white" />
              </div>
              <div className="overflow-hidden whitespace-nowrap">
                <h1 className="text-base font-bold text-cf-text leading-tight">CodeForge</h1>
                <p className="text-[10px] text-cf-text-muted leading-tight">Multi-Agent System</p>
              </div>
            </Link>
          )}
          <button
            onClick={toggleSidebar}
            className={clsx(
              'p-1.5 rounded-lg text-cf-text-muted hover:text-cf-text hover:bg-cf-border transition-colors flex-shrink-0'
            )}
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {sidebarCollapsed
              ? <PanelLeftOpen className="w-5 h-5" />
              : <PanelLeftClose className="w-5 h-5" />
            }
          </button>
        </div>

        {/* Navigation */}
        <nav className={clsx('flex-1 space-y-1', sidebarCollapsed ? 'p-1.5' : 'p-3')} aria-label="Primary">
          {navItems.map((item) => {
            const isActive = location.pathname === item.path ||
              (item.path === '/sessions' && location.pathname.startsWith('/sessions/') && location.pathname !== '/sessions/new')

            return (
              <Link
                key={item.path}
                to={item.path}
                aria-label={item.label}
                title={sidebarCollapsed ? item.label : undefined}
                className={clsx(
                  'flex items-center rounded-lg transition-colors',
                  sidebarCollapsed ? 'justify-center p-2' : 'gap-3 px-3 py-2',
                  isActive
                    ? 'bg-cf-primary/20 text-cf-primary'
                    : 'text-cf-text-muted hover:bg-cf-border hover:text-cf-text'
                )}
              >
                <item.icon className="w-5 h-5 flex-shrink-0" />
                {!sidebarCollapsed && (
                  <span className="font-medium whitespace-nowrap overflow-hidden">{item.label}</span>
                )}
              </Link>
            )
          })}
        </nav>

        {/* Footer */}
        {!sidebarCollapsed && (
          <div className="p-4 border-t border-cf-border">
            <div className="text-xs text-cf-text-muted">
              <p>CodeForge v1.0.0</p>
              <p className="mt-1">&copy; 2026</p>
            </div>
          </div>
        )}
      </aside>

      {/* Main content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <ErrorBoundary>
          {children}
        </ErrorBoundary>
      </main>

      {/* API Key Setup Dialog — shown on first load if no providers configured */}
      <ApiKeySetupDialog
        isOpen={showApiKeySetup}
        onClose={() => setShowApiKeySetup(false)}
        onSaved={async () => {
          await fetchProviders(true)
          setShowApiKeySetup(false)
        }}
      />

      {/* Toast notifications — below the session header bar so badges don't overlap action buttons */}
      <Toaster
        position="top-right"
        containerStyle={{ top: 80, right: 16 }}
        toastOptions={{
          // Fallback for any raw toast() calls that bypass notify.*
          className: 'bg-cf-panel text-cf-text border border-cf-border',
          duration: 4000,
          style: {
            background: 'var(--cf-panel)',
            color: 'var(--cf-text)',
            borderColor: 'var(--cf-border)',
          },
        }}
      />
    </div>
  )
}
