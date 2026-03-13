import { create } from 'zustand'

type Theme = 'light' | 'dark'

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggleTheme: () => void
}

function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'dark') {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }
}

function getInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem('codeforge_theme')
    if (stored === 'light' || stored === 'dark') return stored
  } catch { /* ignore */ }
  return 'dark'
}

// Apply theme immediately on module load (before React renders) to avoid flash
const initialTheme = getInitialTheme()
applyTheme(initialTheme)

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initialTheme,

  setTheme: (theme: Theme) => {
    applyTheme(theme)
    try { localStorage.setItem('codeforge_theme', theme) } catch { /* ignore */ }
    set({ theme })
  },

  toggleTheme: () => {
    set((state) => {
      const next: Theme = state.theme === 'dark' ? 'light' : 'dark'
      applyTheme(next)
      try { localStorage.setItem('codeforge_theme', next) } catch { /* ignore */ }
      return { theme: next }
    })
  },
}))
