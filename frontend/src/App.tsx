import { Routes, Route, Navigate, Link } from 'react-router-dom'
import Layout from './components/layout/Layout'
import RequireAuth from './components/RequireAuth'
import LoginPage from './pages/LoginPage'
import SessionsPage from './pages/SessionsPage'
import SessionDetailPage from './pages/SessionDetailPage'
import NewSessionPage from './pages/NewSessionPage'
import SettingsPage from './pages/SettingsPage'

function App() {
  return (
    <Routes>
      {/* Public route — login page (no Layout wrapper) */}
      <Route path="/login" element={<LoginPage />} />

      {/* Protected routes — wrapped in RequireAuth + Layout */}
      <Route
        path="*"
        element={
          <RequireAuth>
            <Layout>
              <Routes>
                <Route path="/" element={<Navigate to="/sessions" replace />} />
                <Route path="/sessions" element={<SessionsPage />} />
                <Route path="/sessions/new" element={<NewSessionPage />} />
                <Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={
                  <div className="flex-1 flex flex-col items-center justify-center p-6">
                    <h1 className="text-3xl font-bold text-white mb-4">Page not found</h1>
                    <p className="text-gray-400 mb-6">The page you are looking for does not exist.</p>
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
