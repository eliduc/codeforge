import { useState, useEffect, useCallback, useRef, Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Code2, Settings, FolderOpen, Plus, PanelLeftClose, PanelLeftOpen, AlertTriangle, BarChart3, User, LogOut, Compass, Sparkles, HelpCircle, Keyboard, BookOpen, Megaphone, Copy as CopyIcon, RotateCcw } from 'lucide-react'
import { Toaster, useToasterStore } from 'react-hot-toast'
import toast from 'react-hot-toast'
import clsx from 'clsx'
import { useProvidersStore } from '../../stores/providersStore'
import { useAuthStore } from '../../stores/authStore'
import ApiKeySetupDialog from '../common/ApiKeySetupDialog'
import ThemeToggle from '../common/ThemeToggle'
import OnboardingTour from '../onboarding/OnboardingTour'
import { resetAll as resetAllTours } from '../onboarding/useOnboarding'
import CommandPalette from '../common/CommandPalette'
import Button from '../common/Button'

// Улучшатели#5 P1·S — Toaster z-stack / position-rule conflict
// Renders a "Dismiss all" pill above the toast column when ≥3 toasts are
// visible. Lives inside <Toaster>'s viewport so it stacks with the toasts.
function DismissAllToasts() {
  const { toasts } = useToasterStore()
  const visible = toasts.filter(t => t.visible)
  if (visible.length < 3) return null
  return (
    <div
      style={{
        position: 'fixed',
        top: 56,
        right: 16,
        zIndex: 9999,
      }}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={() => toast.dismiss()}
        className="bg-cf-panel border border-cf-border shadow-md"
      >
        Dismiss all ({visible.length})
      </Button>
    </div>
  )
}

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

  // Улучшатели#5 P2·S — preserve in-flight session state on transient errors.
  // 1. Try again — reset hasError without reload (one chance before full reload).
  // 2. Copy error details — error + stack to clipboard for bug reports.
  // 3. Reload page — last resort.
  handleTryAgain = () => {
    this.setState({ hasError: false, error: null })
  }

  handleCopyError = async () => {
    const err = this.state.error
    if (!err) return
    const details = `${err.toString()}\n\n${err.stack ?? '(no stack)'}`
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(details)
        toast.success('Error details copied')
      } else {
        // Fallback for non-secure contexts.
        const ta = document.createElement('textarea')
        ta.value = details
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        toast.success('Error details copied')
      }
    } catch {
      toast.error('Copy failed — select the message manually')
    }
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
            <div className="flex items-center justify-center gap-2 flex-wrap">
              <Button
                variant="primary"
                size="md"
                onClick={this.handleTryAgain}
                leadingIcon={<RotateCcw className="w-4 h-4" />}
              >
                Try again
              </Button>
              <Button
                variant="secondary"
                size="md"
                onClick={this.handleCopyError}
                leadingIcon={<CopyIcon className="w-4 h-4" />}
              >
                Copy error details
              </Button>
              <Button
                variant="ghost"
                size="md"
                onClick={() => window.location.reload()}
              >
                Reload page
              </Button>
            </div>
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
  const navigate = useNavigate()
  const fetchProviders = useProvidersStore(s => s.fetchProviders)
  const loaded = useProvidersStore(s => s.loaded)
  const hasAnyConfigured = useProvidersStore(s => s.hasAnyConfigured)
  // Theme handled inside <ThemeToggle /> (reads/writes useThemeStore directly).
  // Улучшатели#5 P1·M — three forks consolidated into one component.
  // Auth — used for the user dropdown (logout + restart tour).
  const user = useAuthStore(s => s.user)
  const logout = useAuthStore(s => s.logout)
  const authDisabled = useAuthStore(s => s.authDisabled)

  // User menu dropdown state
  const [userMenuOpen, setUserMenuOpen] = useState(false)
  const userMenuRef = useRef<HTMLDivElement | null>(null)

  // Close user menu on outside click / escape
  useEffect(() => {
    if (!userMenuOpen) return
    function onDocClick(e: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setUserMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [userMenuOpen])

  function handleRestartTour() {
    resetAllTours()
    setUserMenuOpen(false)
    // Navigate to /sessions so Tour 1 (Welcome) auto-fires on the next render.
    navigate('/sessions')
  }

  function handleLogout() {
    setUserMenuOpen(false)
    logout()
    navigate('/login')
  }

  // Улучшатели#5 P2·S — Help menu actions.
  // The Cmd-K palette listens for a Cmd/Ctrl-K keydown on document; we dispatch
  // a synthetic event to open it from the Help submenu. Works on both macOS
  // (metaKey) and other platforms (ctrlKey) — palette checks navigator.platform.
  function openCommandPalette() {
    setUserMenuOpen(false)
    const isMac = navigator.platform.toLowerCase().includes('mac')
    const evt = new KeyboardEvent('keydown', {
      key: 'k',
      metaKey: isMac,
      ctrlKey: !isMac,
      bubbles: true,
    })
    document.dispatchEvent(evt)
  }

  function openDocs() {
    setUserMenuOpen(false)
    window.open('https://docs.gotcode.ai', '_blank', 'noopener,noreferrer')
  }

  function openChangelog() {
    setUserMenuOpen(false)
    // Placeholder — no in-app changelog yet. Toast keeps the user informed.
    toast('Changelog coming soon', { icon: '📝' })
  }

  // Улучшатели#5 P2·S — shared dropdown body used in both expanded & collapsed
  // sidebar modes. Includes Help submenu items and the version/copyright footer
  // so metadata is always reachable.
  const renderUserDropdown = () => (
    <>
      {user?.email && (
        <div className="px-3 py-2 text-xs text-cf-text-muted border-b border-cf-border truncate">
          {user.email}
        </div>
      )}
      <button
        role="menuitem"
        onClick={handleRestartTour}
        className="w-full text-left px-3 py-2 text-sm text-cf-text hover:bg-cf-border transition-colors flex items-center gap-2"
      >
        <Compass className="w-4 h-4 text-cf-primary" />
        Restart onboarding tour
      </button>
      {/* Help section */}
      <div className="border-t border-cf-border mt-1 pt-1">
        <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-wider text-cf-text-muted font-semibold">
          Help
        </div>
        <button
          role="menuitem"
          onClick={openCommandPalette}
          className="w-full text-left px-3 py-2 text-sm text-cf-text hover:bg-cf-border transition-colors flex items-center gap-2"
        >
          <Keyboard className="w-4 h-4 text-cf-text-muted" />
          Keyboard shortcuts
        </button>
        <button
          role="menuitem"
          onClick={openDocs}
          className="w-full text-left px-3 py-2 text-sm text-cf-text hover:bg-cf-border transition-colors flex items-center gap-2"
        >
          <BookOpen className="w-4 h-4 text-cf-text-muted" />
          Documentation
        </button>
        <button
          role="menuitem"
          onClick={openChangelog}
          className="w-full text-left px-3 py-2 text-sm text-cf-text hover:bg-cf-border transition-colors flex items-center gap-2"
        >
          <Megaphone className="w-4 h-4 text-cf-text-muted" />
          What's new
        </button>
      </div>
      {!authDisabled && (
        <div className="border-t border-cf-border mt-1 pt-1">
          <button
            role="menuitem"
            onClick={handleLogout}
            className="w-full text-left px-3 py-2 text-sm text-cf-text hover:bg-cf-border transition-colors flex items-center gap-2"
          >
            <LogOut className="w-4 h-4" />
            Log out
          </button>
        </div>
      )}
      {/* Version / copyright — always reachable in both sidebar modes. */}
      <div className="border-t border-cf-border mt-1 pt-2 pb-2 px-3 text-[10px] text-cf-text-muted leading-tight">
        <div>CodeForge v1.0.0</div>
        <div>&copy; 2026</div>
      </div>
    </>
  )

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
    { path: '/dashboard', icon: BarChart3, label: 'Dashboard' },
    { path: '/sessions', icon: FolderOpen, label: 'Sessions' },
    { path: '/sessions/new', icon: Plus, label: 'New Session' },
    // Demos route shows the pre-recorded multi-agent playbacks; targeted by
    // the Welcome tour's final step (data-tour="demos-nav").
    { path: '/demos', icon: Sparkles, label: 'Demos', tour: 'demos-nav' as const },
    { path: '/settings', icon: Settings, label: 'Settings' },
  ]

  return (
    // VR-52 — h-screen (definite height), not min-h-screen, so flex-1 +
    // overflow-auto regions (incl. the demo player's narration panel) bound to
    // the viewport and scroll internally instead of growing past it. main is
    // overflow-hidden and every page self-scrolls, so auth pages are unaffected.
    <div className="h-screen bg-cf-bg flex">
      {/* Sidebar */}
      <aside
        className={clsx(
          'bg-cf-panel border-r border-cf-border flex flex-col flex-shrink-0',
          // КАО#R4-S1 — no overflow-hidden here: it clipped the user-menu
          // dropdown (bottom-full, opens upward/outward) to invisibility. The
          // collapse animation is already clipped per-element (logo text + nav
          // labels carry their own overflow-hidden whitespace-nowrap).
          'transition-all duration-300 ease-in-out',
          sidebarCollapsed ? 'w-12' : 'w-64'
        )}
        aria-label="Main navigation"
      >
        {/* Logo / Toggle */}
        <div className={clsx(
          'border-b border-cf-border flex min-h-[56px]',
          sidebarCollapsed ? 'flex-col items-center gap-2 px-1 py-3' : 'items-center justify-between px-4 py-3'
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
          {sidebarCollapsed && (
            <Link to="/" className="block" aria-label="CodeForge" title="CodeForge">
              <div className="w-8 h-8 bg-gradient-to-br from-cf-primary to-cf-secondary rounded-lg flex items-center justify-center">
                <Code2 className="w-5 h-5 text-white" />
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
                data-tour={'tour' in item ? (item as { tour?: string }).tour : undefined}
                className={clsx(
                  'flex items-center rounded-lg transition-colors',
                  sidebarCollapsed ? 'justify-center p-2' : 'gap-3 px-3 py-2',
                  isActive
                    ? 'bg-cf-primary/20 text-indigo-700 dark:text-cf-primary'
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
            {/* Улучшатели#5 P2·S — footer no longer crams 3 columns of metadata.
                Version/copyright moved into the user dropdown (always reachable). */}
            <div className="flex items-center gap-2">
              {/* Улучшатели#5 P1·M — ThemeToggle primitive (icon variant). */}
              <ThemeToggle variant="icon" />

              {/* User menu — dropdown with Restart tour + Help + Logout. */}
              <div className="relative ml-auto" ref={userMenuRef}>
                <button
                  onClick={() => setUserMenuOpen(o => !o)}
                  className="p-2 rounded-lg text-cf-text-muted hover:text-cf-text hover:bg-cf-border transition-colors flex items-center gap-1"
                  title={user?.email || 'Account'}
                  aria-haspopup="menu"
                  aria-expanded={userMenuOpen}
                  data-tour="user-menu" /* tour-anchor: opens the user dropdown */
                >
                  <User className="w-4 h-4" />
                </button>
                {userMenuOpen && (
                  // Anchor dropdown on the LEFT edge of the User button so it
                  // expands rightward — right-anchored dropdowns would overflow
                  // the viewport from the sidebar's left edge.
                  <div
                    role="menu"
                    className="absolute bottom-full mb-2 left-0 min-w-[240px] bg-cf-panel border border-cf-border rounded-lg shadow-lg py-1 z-50"
                  >
                    {renderUserDropdown()}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {sidebarCollapsed && (
          <div className="mt-auto p-1.5 border-t border-cf-border space-y-1">
            {/* Улучшатели#5 P1·M — ThemeToggle primitive (centered variant). */}
            <ThemeToggle variant="centered" />
            {/* Улучшатели#5 P2·S — collapsed Help button (opens command palette / shortcuts).
                Keeps Help discoverable even when sidebar metadata is hidden. */}
            <button
              onClick={openCommandPalette}
              className="p-2 rounded-lg text-cf-text-muted hover:text-cf-text hover:bg-cf-border transition-colors w-full flex justify-center"
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (⌘K)"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setUserMenuOpen(o => !o)}
                className="p-2 rounded-lg text-cf-text-muted hover:text-cf-text hover:bg-cf-border transition-colors w-full flex justify-center"
                title={user?.email || 'Account'}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                data-tour="user-menu" /* tour-anchor: opens the user dropdown */
              >
                <User className="w-4 h-4" />
              </button>
              {userMenuOpen && (
                <div
                  role="menu"
                  className="absolute bottom-full left-full ml-2 min-w-[240px] bg-cf-panel border border-cf-border rounded-lg shadow-lg py-1 z-50"
                >
                  {renderUserDropdown()}
                </div>
              )}
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

      {/* Onboarding tour — inert until it has something to show. */}
      <OnboardingTour />

      {/* Улучшатели#5 P1·M — Cmd-K palette mounted once at the root. */}
      <CommandPalette />

      {/* Улучшатели#5 P1·S — Dismiss-all chip rendered when ≥3 toasts visible. */}
      <DismissAllToasts />

      {/* Toast notifications — below the session header bar so badges don't
          overlap action buttons. Container owns position; notify.* no longer
          overrides per-call (see StyledToast.tsx). */}
      <Toaster
        position="top-right"
        gutter={8}
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
