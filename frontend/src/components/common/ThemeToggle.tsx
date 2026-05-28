// Улучшатели#5 P1·M — ThemeToggle primitive cascade fix.
// Consolidates three forks (SettingsPage Appearance section, Layout sidebar
// expanded button, Layout sidebar collapsed button) into one component with
// a `variant` switch. Reads/writes via useThemeStore so behaviour stays
// identical to the originals.
//
// КАО#W4-FIX-04 — pill variant now exposes the Wave 1 Foundation spec's three
// values (Light / Dark / System). The icon variants reflect the *effective*
// theme (what the OS / preference resolves to) so the sidebar Sun/Moon stays
// accurate when the stored preference is 'system'.

import { Sun, Moon, Monitor } from 'lucide-react'
import clsx from 'clsx'
import { useThemeStore } from '../../stores/themeStore'

export type ThemeToggleVariant = 'pill' | 'icon' | 'centered'

export interface ThemeToggleProps {
  variant?: ThemeToggleVariant
  className?: string
}

export default function ThemeToggle({ variant = 'icon', className }: ThemeToggleProps) {
  const theme = useThemeStore((s) => s.theme)
  const effectiveTheme = useThemeStore((s) => s.effectiveTheme)
  const setTheme = useThemeStore((s) => s.setTheme)
  const toggleTheme = useThemeStore((s) => s.toggleTheme)

  if (variant === 'pill') {
    // Used in SettingsPage Appearance card — three segmented buttons (Light /
    // Dark / System). КАО#W4-FIX-04.
    return (
      <div
        className={clsx(
          'inline-flex rounded-lg border border-cf-border overflow-hidden',
          className,
        )}
        role="group"
        aria-label="Theme"
      >
        <button
          type="button"
          onClick={() => setTheme('light')}
          aria-pressed={theme === 'light'}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors',
            theme === 'light'
              ? 'bg-cf-primary text-white'
              : 'bg-cf-bg text-cf-text-muted hover:text-cf-text hover:bg-cf-hover',
          )}
        >
          <Sun className="w-4 h-4" />
          Light
        </button>
        <button
          type="button"
          onClick={() => setTheme('dark')}
          aria-pressed={theme === 'dark'}
          className={clsx(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors',
            theme === 'dark'
              ? 'bg-cf-primary text-white'
              : 'bg-cf-bg text-cf-text-muted hover:text-cf-text hover:bg-cf-hover',
          )}
        >
          <Moon className="w-4 h-4" />
          Dark
        </button>
        <button
          type="button"
          onClick={() => setTheme('system')}
          aria-pressed={theme === 'system'}
          title="Follow OS preference"
          className={clsx(
            'flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors',
            theme === 'system'
              ? 'bg-cf-primary text-white'
              : 'bg-cf-bg text-cf-text-muted hover:text-cf-text hover:bg-cf-hover',
          )}
        >
          <Monitor className="w-4 h-4" />
          System
        </button>
      </div>
    )
  }

  // 'icon' and 'centered' both render a single icon button that toggles.
  // 'centered' adds `w-full flex justify-center` (used in the collapsed sidebar
  // so the icon centers within the narrow strip).
  //
  // КАО#W4-FIX-04 — icon reflects the EFFECTIVE theme so users on 'system' see
  // the OS-resolved Sun/Moon. Title hints when the preference is 'system'.
  const isCentered = variant === 'centered'
  const followsSystem = theme === 'system'
  const showingDark = effectiveTheme === 'dark'
  const title = followsSystem
    ? `Following OS (${effectiveTheme}) — click for ${showingDark ? 'light' : 'dark'} mode`
    : showingDark
      ? 'Switch to light mode'
      : 'Switch to dark mode'
  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={title}
      aria-label={title}
      className={clsx(
        'p-2 rounded-lg text-cf-text-muted hover:text-cf-text hover:bg-cf-border transition-colors',
        isCentered && 'w-full flex justify-center',
        className,
      )}
    >
      {showingDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
  )
}
