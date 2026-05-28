import { create } from 'zustand'

// КАО#W4-FIX-04 — three-value theme. 'system' follows the OS preference via
// `matchMedia('(prefers-color-scheme: dark)')`. The stored preference is the
// user's choice ('light' | 'dark' | 'system'); the effective theme (what gets
// applied to <html>) is always 'light' or 'dark'.
export type Theme = 'light' | 'dark' | 'system'
export type EffectiveTheme = 'light' | 'dark'

interface ThemeState {
  theme: Theme
  effectiveTheme: EffectiveTheme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

function getSystemEffective(): EffectiveTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

function resolveEffective(theme: Theme): EffectiveTheme {
  if (theme === 'system') return getSystemEffective()
  return theme
}

function applyEffective(effective: EffectiveTheme) {
  const root = document.documentElement
  if (effective === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem('codeforge_theme')
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored
  } catch { /* ignore */ }
  // КАО#W4-FIX-04 — new users default to 'system' so first-time experience
  // matches the OS preference.
  return 'system'
}

// Apply theme immediately on module load (before React renders) to avoid flash
const initialTheme = getInitialTheme()
const initialEffective = resolveEffective(initialTheme)
applyEffective(initialEffective)

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initialTheme,
  effectiveTheme: initialEffective,

  setTheme: (theme: Theme) => {
    const effective = resolveEffective(theme)
    applyEffective(effective)
    try { localStorage.setItem('codeforge_theme', theme) } catch { /* ignore */ }
    set({ theme, effectiveTheme: effective })
  },

  toggleTheme: () => {
    // Toggle cycles between explicit light/dark; if currently 'system', flip
    // away from the current effective theme to give the user an explicit choice.
    const state = get()
    const current: EffectiveTheme = state.theme === 'system' ? state.effectiveTheme : state.theme
    const next: Theme = current === 'dark' ? 'light' : 'dark'
    const effective = resolveEffective(next)
    applyEffective(effective)
    try { localStorage.setItem('codeforge_theme', next) } catch { /* ignore */ }
    set({ theme: next, effectiveTheme: effective })
  },
}))

// КАО#W4-FIX-04 — keep effective theme synced when OS preference changes,
// but only while the user's stored choice is 'system'. Listener installed
// once at module load; safe in SSR-free Vite browser builds.
try {
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = (e: MediaQueryListEvent) => {
    const { theme } = useThemeStore.getState()
    if (theme !== 'system') return
    const effective: EffectiveTheme = e.matches ? 'dark' : 'light'
    applyEffective(effective)
    useThemeStore.setState({ effectiveTheme: effective })
  }
  // addEventListener is the modern API; Safari < 14 used addListener but Vite
  // targets ES2020+ browsers so addEventListener is safe.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', handler)
  } else if (typeof (mql as any).addListener === 'function') {
    ;(mql as any).addListener(handler)
  }
} catch { /* ignore — no matchMedia, e.g. SSR / older test envs */ }
