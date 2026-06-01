import { create } from 'zustand'
import {
  clearLegacyToken,
  setAuthedHint,
  getAuthedHint,
  clearAuthedHint,
  getCurrentUser,
  probeCurrentUserForDevMode,
  logoutApi,
  type AuthUser,
} from '../services/api'

// КАО#SG1-selfxss — the JWT now lives in an httpOnly `codeforge_session`
// cookie, not in localStorage. The store therefore never holds the raw token;
// it only tracks the in-memory user + a non-sensitive "we think we're logged
// in" hint flag (see services/api.ts) used to decide whether to validate the
// session on startup.
interface AuthState {
  /** Current user info (null if not authenticated) */
  user: AuthUser | null
  /** True when we have a valid session */
  isAuthenticated: boolean
  /** True during initial auth check */
  loading: boolean
  /** True if auth check determined auth is not required (dev mode) */
  authDisabled: boolean

  /** Called on app startup to restore the session (httpOnly cookie + hint) */
  loadFromStorage: () => Promise<void>
  /** Called after successful OTP verification (the JWT is in the cookie) */
  login: (user: AuthUser) => void
  /** Clear session (server-side cookie + local state); the UI then redirects */
  logout: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  loading: true,
  authDisabled: false,

  loadFromStorage: async () => {
    // КАО#SG1-selfxss — purge any legacy JWT older builds left in localStorage
    // so a same-origin XSS can't read it. The httpOnly cookie replaces it.
    clearLegacyToken()

    if (getAuthedHint()) {
      // We believe a session exists — validate it. The httpOnly cookie is sent
      // automatically; getCurrentUser() throws on 401 (expired/absent session).
      try {
        const user = await getCurrentUser()
        setAuthedHint()
        set({
          user: { id: user.id, email: user.email, is_active: user.is_active },
          isAuthenticated: true,
          loading: false,
          authDisabled: user.id === 'dev',
        })
      } catch {
        // Session expired or invalid — self-heal back to logged-out.
        clearAuthedHint()
        set({ user: null, isAuthenticated: false, loading: false })
      }
      return
    }

    // No hint: only probe /me for dev-mode on localhost (КАО#SR-4). On
    // stage/prod we skip the probe to avoid a guaranteed 401 + console noise on
    // the anonymous /login page.
    const user = await probeCurrentUserForDevMode()
    if (user && user.id === 'dev') {
      set({
        user: { id: 'dev', email: 'dev@localhost', is_active: true },
        isAuthenticated: true,
        loading: false,
        authDisabled: true,
      })
      return
    }
    set({ loading: false })
  },

  login: (user: AuthUser) => {
    // The JWT was already set as an httpOnly cookie by verify-otp; we only
    // record the non-sensitive hint + the in-memory user.
    setAuthedHint()
    set({ user, isAuthenticated: true, loading: false })
  },

  logout: () => {
    // Best-effort server-side cookie clear; local state resets regardless so
    // the UI redirects to /login immediately.
    void logoutApi().catch(() => {})
    clearAuthedHint()
    set({ user: null, isAuthenticated: false })
  },
}))
