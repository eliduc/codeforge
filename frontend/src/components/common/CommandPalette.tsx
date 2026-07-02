// Улучшатели#5 P1·M — Cmd-K palette
// Global command palette mounted once inside Layout. Activated by Cmd-K /
// Ctrl-K from anywhere in the app. Esc closes via the Modal primitive's
// built-in handler. While the palette is open, the Cmd-K trigger is a no-op
// (the input swallows it inside Combobox).
//
// Commands are hard-coded for now — no plugin system. Each command has a
// category badge (Navigate / Action) shown on the right of its row.

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Dialog, Combobox, Transition } from '@headlessui/react'
import { Search, ArrowRight, Compass, FolderOpen, BarChart3, Plus, Settings, Sparkles, Moon, FileCode } from 'lucide-react'
import clsx from 'clsx'
import { useThemeStore } from '../../stores/themeStore'
import { resetAll as resetAllTours } from '../onboarding/useOnboarding'
// КАО#UX-7 — P3 power-tool: live session search in the palette.
import { useFetchData } from '../../hooks/useFetchData'
import { getSessions } from '../../services/api'

type CommandCategory = 'Navigate' | 'Action' | 'Session'

interface PaletteCommand {
  id: string
  label: string
  category: CommandCategory
  icon: React.ComponentType<{ className?: string }>
  run: () => void
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const navigate = useNavigate()
  const toggleTheme = useThemeStore(s => s.toggleTheme)

  // Listen for Cmd-K / Ctrl-K anywhere in the app. The palette owns its
  // own activation — Layout does not need to know about this.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const hit = e.key === 'k' && (isMac ? e.metaKey : e.ctrlKey)
      if (!hit) return
      // Ignore when the palette itself is open (Esc closes it).
      if (open) return
      e.preventDefault()
      setOpen(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  // Reset query whenever palette re-opens.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  function close() {
    setOpen(false)
  }

  function handleRestartTour() {
    resetAllTours()
    navigate('/sessions')
  }

  // Hard-coded command set (Wave 2 — no plugin registry).
  const commands: PaletteCommand[] = useMemo(() => [
    { id: 'nav-sessions',  label: 'Go to Sessions',  category: 'Navigate', icon: FolderOpen, run: () => navigate('/sessions') },
    { id: 'nav-dashboard', label: 'Go to Dashboard', category: 'Navigate', icon: BarChart3,  run: () => navigate('/dashboard') },  /* КАО#R4-S2 — '/' redirects to /sessions */
    { id: 'nav-demos',     label: 'Go to Demos',     category: 'Navigate', icon: Sparkles,   run: () => navigate('/demos') },
    { id: 'nav-settings',  label: 'Go to Settings',  category: 'Navigate', icon: Settings,   run: () => navigate('/settings') },
    { id: 'new-session',   label: 'New session',     category: 'Navigate', icon: Plus,       run: () => navigate('/sessions/new') },
    { id: 'toggle-theme',  label: 'Toggle theme',    category: 'Action',   icon: Moon,       run: () => toggleTheme() },
    { id: 'restart-tour',  label: 'Restart tour',    category: 'Action',   icon: Compass,    run: handleRestartTour },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [navigate, toggleTheme])

  // КАО#UX-7 — lazily fetch the session list ONLY while the palette is open, so
  // it costs nothing on cold load. useFetchData cancels stale fetches on close.
  const { data: sessionsPage } = useFetchData(() => getSessions(0, 50), [open], { enabled: open })

  // Turn sessions into navigate-to-detail commands. These are appended to the
  // results only when the user has typed something (so opening the palette
  // doesn't dump 50 rows over the static commands).
  const sessionCommands: PaletteCommand[] = useMemo(() => {
    const items = sessionsPage?.items ?? []
    return items.map(s => ({
      id: 'session-' + s.id,
      label: s.name || '(untitled session)',
      category: 'Session' as const,
      icon: FileCode,
      run: () => navigate('/sessions/' + s.id),
    }))
  }, [sessionsPage, navigate])

  // Simple substring / token fuzzy filter — case-insensitive. All tokens in
  // the query must appear somewhere in the label. КАО#UX-7 — static commands
  // always show (filtered); matching sessions append below, capped at 8.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    const tokens = q.split(/\s+/)
    const match = (label: string) => {
      const hay = label.toLowerCase()
      return tokens.every(t => hay.includes(t))
    }
    const staticMatches = commands.filter(cmd => match(cmd.label))
    const sessionMatches = sessionCommands.filter(cmd => match(cmd.label)).slice(0, 8)
    return [...staticMatches, ...sessionMatches]
  }, [query, commands, sessionCommands])

  function runCommand(cmd: PaletteCommand | null) {
    if (!cmd) return
    close()
    // Defer slightly so the Dialog can close cleanly before route changes.
    setTimeout(() => cmd.run(), 0)
  }

  return (
    <Transition appear show={open} as={Fragment}>
      <Dialog as="div" className="relative z-[60]" onClose={close}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-150"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-100"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-start justify-center p-4 pt-[15vh]">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-150"
              enterFrom="opacity-0 scale-95 translate-y-2"
              enterTo="opacity-100 scale-100 translate-y-0"
              leave="ease-in duration-100"
              leaveFrom="opacity-100 scale-100 translate-y-0"
              leaveTo="opacity-0 scale-95 translate-y-2"
            >
              <Dialog.Panel
                className={clsx(
                  'relative w-full max-w-xl transform overflow-hidden rounded-2xl shadow-2xl',
                  'bg-cf-panel text-cf-text border border-cf-border',
                )}
              >
                {/* КАО#R5-a11y: give the dialog an accessible name so screen
                    readers announce it as "Command palette" instead of an
                    unnamed dialog. Headless UI wires aria-labelledby from this. */}
                <Dialog.Title className="sr-only">Command palette</Dialog.Title>
                <Combobox<PaletteCommand | null>
                  value={null}
                  onChange={runCommand}
                >
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-cf-border">
                    <Search className="w-4 h-4 text-cf-text-muted shrink-0" aria-hidden="true" />
                    <Combobox.Input
                      autoFocus
                      aria-label="Search commands and sessions"  /* КАО#R5-a11y */
                      placeholder="Search commands and sessions..."
                      onChange={(e) => setQuery(e.target.value)}
                      displayValue={() => query}
                      className="flex-1 bg-transparent text-sm text-cf-text placeholder-cf-text-muted focus:outline-none"
                    />
                    <kbd className="text-[10px] px-1.5 py-0.5 rounded border border-cf-border text-cf-text-muted">
                      Esc
                    </kbd>
                  </div>

                  <Combobox.Options
                    static
                    className="max-h-80 overflow-y-auto py-1"
                  >
                    {filtered.length === 0 ? (
                      <div className="px-4 py-6 text-center text-sm text-cf-text-muted">
                        No matching commands.
                      </div>
                    ) : (
                      filtered.map((cmd) => {
                        const Icon = cmd.icon
                        return (
                          <Combobox.Option
                            key={cmd.id}
                            value={cmd}
                            className={({ active }) =>
                              clsx(
                                'flex items-center gap-3 px-4 py-2.5 cursor-pointer select-none',
                                active ? 'bg-cf-hover' : '',
                              )
                            }
                          >
                            {({ active }) => (
                              <>
                                <Icon className={clsx('w-4 h-4 shrink-0', active ? 'text-cf-primary' : 'text-cf-text-muted')} />
                                <span className="flex-1 text-sm text-cf-text truncate">
                                  {cmd.label}
                                </span>
                                <span
                                  className={clsx(
                                    'text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wide font-medium',
                                    cmd.category === 'Navigate'
                                      ? 'bg-indigo-100 dark:bg-cf-primary/15 text-indigo-700 dark:text-cf-primary'
                                      : cmd.category === 'Session'
                                      ? 'bg-emerald-100 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                      : 'bg-cf-border text-cf-text-muted',
                                  )}
                                >
                                  {cmd.category}
                                </span>
                                {active && <ArrowRight className="w-3.5 h-3.5 text-cf-primary shrink-0" />}
                              </>
                            )}
                          </Combobox.Option>
                        )
                      })
                    )}
                  </Combobox.Options>
                </Combobox>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
