import { Routes, Route, Navigate, Link } from 'react-router-dom'
import Layout from './components/layout/Layout'
import RequireAuth from './components/RequireAuth'
import LoginPage from './pages/LoginPage'
import SessionsPage from './pages/SessionsPage'
import SessionDetailPage from './pages/SessionDetailPage'
import NewSessionPage from './pages/NewSessionPage'
import SettingsPage from './pages/SettingsPage'
import DashboardPage from './pages/DashboardPage'
import SharedSessionPage from './pages/SharedSessionPage'
import DemoPlayerPage from './pages/DemoPlayerPage'
import DemosPage from './pages/DemosPage'
import { useAuthStore } from './stores/authStore'
import { Code2, LogIn } from 'lucide-react'

// КАО#R14-FIX-01 (HIGH) — Demo de-auth
// Public wrapper for the /demos and /demo/:templateId routes. Demos are
// marketing surface — anonymous visitors must reach them without being
// bounced to /login. We still give logged-in users the full Layout chrome
// (sidebar + topbar) so the page doesn't feel different post-login; anon
// visitors get a minimal top bar with a Sign-in link instead.
function PublicChrome({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  if (isAuthenticated) {
    return <Layout>{children}</Layout>
  }
  return (
    <div className="min-h-screen bg-cf-bg flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-cf-border bg-cf-panel">
        <Link to="/" className="flex items-center gap-2 text-cf-text">
          <div className="w-7 h-7 bg-gradient-to-br from-cf-primary to-cf-secondary rounded-lg flex items-center justify-center">
            <Code2 className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold">CodeForge</span>
        </Link>
        <Link
          to="/login"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-cf-primary hover:bg-cf-secondary text-white text-sm font-medium rounded-lg transition-colors"
        >
          <LogIn className="w-4 h-4" />
          Sign in
        </Link>
      </header>
      <main className="flex-1 flex flex-col overflow-hidden">{children}</main>
    </div>
  )
}

function App() {
  return (
    <Routes>
      {/* Public route — login page (no Layout wrapper) */}
      <Route path="/login" element={<LoginPage />} />

      {/* Public route — shared read-only session view (no auth required) */}
      <Route path="/share/:token" element={<SharedSessionPage />} />

      {/* КАО#R14-FIX-01 (HIGH) — Demo de-auth
          Public demo routes — anonymous visitors must reach them without
          being bounced to /login. Wrapped in PublicChrome which provides
          full Layout when authenticated, minimal chrome when not. */}
      <Route path="/demos" element={<PublicChrome><DemosPage /></PublicChrome>} />
      <Route path="/demo/:templateId" element={<PublicChrome><DemoPlayerPage /></PublicChrome>} />

      {/* Protected routes — wrapped in RequireAuth + Layout */}
      <Route
        path="*"
        element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route path="/" element={<Navigate to="/sessions" replace />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/sessions" element={<SessionsPage />} />
                <Route path="/sessions/new" element={<NewSessionPage />} />
                <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={
                  <div className="flex-1 flex flex-col items-center justify-center p-6">
                    <h1 className="text-3xl font-bold text-cf-text mb-4">Page not found</h1>
                    <p className="text-cf-text-muted mb-6">The page you are looking for does not exist.</p>
                    <Link to="/" className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors">
                      Go back home
                    </Link>
                  </div>
                } />
              </Routes>
            </Layout>
          </RequireAuth>
        }
      />
    </Routes>
  )
}

export default App
