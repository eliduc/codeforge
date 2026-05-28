import { create } from 'zustand'
import {
  getStoredToken,
  setStoredToken,
  clearStoredToken,
  getCurrentUser,
  probeCurrentUserForDevMode,
  type AuthUser,
} from '../services/api'

interface AuthState {
  /** JWT token (null if not authenticated) */
  token: string | null
  /** Current user info */
  user: AuthUser | null
  /** True when we have a valid token + user */
  isAuthenticated: boolean
  /** True during initial auth check */
  loading: boolean
  /** True if auth check determined auth is not required (dev mode) */
  authDisabled: boolean

  /** Called on app startup to restore session from localStorage */
  loadFromStorage: () => Promise<void>
  /** Called after successful OTP verification */
  login: (token: string, user: AuthUser) => void
  /** Clear session and redirect to login */
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  token: null,
  user: null,
  isAuthenticated: false,
  loading: true,
  authDisabled: false,

  loadFromStorage: async () => {
    const token = getStoredToken()
    if (!token) {
      // КАО#SR-4 Round 4 — Probe /me only when running on localhost (dev mode
      // detection). On stage/prod we skip the probe to avoid a guaranteed 401
      // and its associated console.error noise on the anonymous /login page.
      const user = await probeCurrentUserForDevMode()
      if (user && user.id === 'dev') {
        // Dev mode — auth not required
        set({
          token: null,
          user: { id: 'dev', email: 'dev@localhost', is_active: true },
          isAuthenticated: true,
          loading: false,
          authDisabled: true,
        })
        return
      }
      set({ loading: false })
      return
    }

    // Token exists — validate it
    try {
      const user = await getCurrentUser()
      set({
        token,
        user: { id: user.id, email: user.email, is_active: user.is_active },
        isAuthenticated: true,
        loading: false,
        authDisabled: user.id === 'dev',
      })
    } catch {
      // Token expired or invalid
      clearStoredToken()
      set({ token: null, user: null, isAuthenticated: false, loading: false })
    }
  },

  login: (token: string, user: AuthUser) => {
    setStoredToken(token)
    set({ token, user, isAuthenticated: true, loading: false })
  },

  logout: () => {
    clearStoredToken()
    set({ token: null, user: null, isAuthenticated: false })
  },
}))
