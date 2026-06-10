/**
 * Styled toast notification system matching the app's dark theme design.
 *
 * Usage:
 *   import { notify } from '../components/common/StyledToast'
 *   notify.error('Something went wrong')
 *   notify.success('Operation completed')
 *   notify.warning('Low credit balance')
 *   notify.info('Session is paused')
 */

import toast from 'react-hot-toast'
import type { Toast } from 'react-hot-toast'
import { AlertCircle, CheckCircle2, AlertTriangle, Info, X } from 'lucide-react'
import { type ReactNode } from 'react'

/* ── Style config per type ────────────────────────────────────── */

type ToastType = 'error' | 'success' | 'warning' | 'info'

interface TypeStyle {
  icon: ReactNode
  border: string
  iconBg: string
  iconText: string
  accent: string      // left accent bar
  titleColor: string
}

const styles: Record<ToastType, TypeStyle> = {
  error: {
    icon: <AlertCircle className="w-5 h-5" />,
    border: 'border-red-500/40',
    iconBg: 'bg-gradient-to-br from-red-500/25 to-red-600/15',
    iconText: 'text-red-400',
    accent: 'bg-gradient-to-b from-red-500 to-red-600',
    titleColor: 'text-red-400',
  },
  success: {
    icon: <CheckCircle2 className="w-5 h-5" />,
    border: 'border-emerald-500/40',
    iconBg: 'bg-gradient-to-br from-emerald-500/25 to-emerald-600/15',
    iconText: 'text-emerald-400',
    accent: 'bg-gradient-to-b from-emerald-500 to-emerald-600',
    titleColor: 'text-emerald-400',
  },
  warning: {
    icon: <AlertTriangle className="w-5 h-5" />,
    border: 'border-yellow-500/40',
    iconBg: 'bg-gradient-to-br from-yellow-500/25 to-yellow-600/15',
    iconText: 'text-yellow-400',
    accent: 'bg-gradient-to-b from-yellow-500 to-yellow-600',
    titleColor: 'text-yellow-400',
  },
  info: {
    icon: <Info className="w-5 h-5" />,
    border: 'border-blue-500/40',
    iconBg: 'bg-gradient-to-br from-blue-500/25 to-blue-600/15',
    iconText: 'text-blue-400',
    accent: 'bg-gradient-to-b from-blue-500 to-blue-600',
    titleColor: 'text-blue-400',
  },
}

const typeLabels: Record<ToastType, string> = {
  error: 'Error',
  success: 'Success',
  warning: 'Warning',
  info: 'Info',
}

/* ── Toast render component ─────────────────────────────────── */

interface ToastAction {
  label: string
  onClick: () => void
}

interface StyledToastProps {
  t: Toast
  type: ToastType
  message: string
  title?: string
  action?: ToastAction
}

function StyledToastContent({ t, type, message, title, action }: StyledToastProps) {
  const s = styles[type]
  const displayTitle = title || typeLabels[type]

  // Улучшатели#5 P1·M — cf-* tokens for theme-aware surface (was gray-800/gray-900).
  // КАО#R2-01 — react-hot-toast only spreads ariaProps onto its built-in ToastBar;
  // toast.custom() nodes render verbatim, so the toast was announced to nobody
  // (WCAG 4.1.3). Add live-region semantics here: errors interrupt (assertive/alert),
  // everything else is polite (status).
  const isError = type === 'error'
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      aria-atomic="true"
      className={`
        ${t.visible ? 'animate-toast-enter' : 'animate-toast-leave'}
        max-w-sm w-full pointer-events-auto
        rounded-xl border ${s.border}
        bg-cf-panel
        backdrop-blur-xl shadow-2xl
        overflow-hidden
        flex
      `}
    >
      {/* Left accent bar */}
      <div className={`w-1 ${s.accent} shrink-0`} />

      {/* Content area */}
      <div className="flex items-start gap-3 p-3.5 flex-1 min-w-0">
        {/* Icon */}
        <div className={`p-2 rounded-lg ${s.iconBg} ${s.iconText} shrink-0 mt-0.5`}>
          {s.icon}
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-semibold ${s.titleColor} leading-tight`}>
            {displayTitle}
          </p>
          <p className="text-[13px] text-cf-text mt-1 leading-relaxed break-words">
            {message}
          </p>
          {action && (
            <button
              onClick={() => {
                action.onClick()
                toast.dismiss(t.id)
              }}
              className={`mt-2 text-xs font-semibold ${s.titleColor} hover:underline focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 ${s.iconText} rounded`}
            >
              {action.label}
            </button>
          )}
        </div>

        {/* Dismiss button — cf-* tokens. */}
        <button
          onClick={() => toast.dismiss(t.id)}
          aria-label="Dismiss notification"
          className="p-1 rounded-md text-cf-text-muted hover:text-cf-text hover:bg-cf-hover transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

/* ── Public API ──────────────────────────────────────────────── */

interface NotifyOptions {
  title?: string
  duration?: number
  action?: ToastAction
}

// Улучшатели#5 P1·M — Settings → Notifications: toast verbosity gate.
// `silent` keeps only `error` (hard failures must still surface). `important-only`
// adds `warning` (sensible default — actionable, not noisy). `verbose` keeps
// everything including success/info confirmations.
type ToastVerbosity = 'verbose' | 'important-only' | 'silent'

function readVerbosity(): ToastVerbosity {
  try {
    const raw = typeof window !== 'undefined'
      ? window.localStorage.getItem('codeforge.prefs.toastVerbosity')
      : null
    if (raw === 'verbose' || raw === 'important-only' || raw === 'silent') return raw
  } catch {
    // localStorage unavailable (SSR / private mode) — fall through.
  }
  return 'important-only'
}

function shouldShow(type: ToastType): boolean {
  const v = readVerbosity()
  if (v === 'verbose') return true
  if (v === 'silent') return type === 'error'
  return type === 'error' || type === 'warning'
}

function maybePlaySound(type: ToastType) {
  try {
    if (typeof window === 'undefined') return
    if (type !== 'error' && type !== 'warning') return
    if (window.localStorage.getItem('codeforge.prefs.soundEnabled') !== 'true') return
    const Ctor = window.AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = type === 'error' ? 220 : 440
    gain.gain.value = 0.05
    osc.start()
    osc.stop(ctx.currentTime + 0.15)
  } catch {
    // best-effort
  }
}

function maybeShowDesktop(type: ToastType, message: string, title?: string) {
  try {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return
    if (window.localStorage.getItem('codeforge.prefs.desktopNotifications') !== 'true') return
    if (Notification.permission !== 'granted') return
    if (type !== 'error' && type !== 'warning') return
    new Notification(title || typeLabels[type], { body: message })
  } catch {
    // best-effort
  }
}

function showToast(type: ToastType, message: string, opts?: NotifyOptions) {
  // Verbosity gate — short-circuit before rendering anything.
  if (!shouldShow(type)) return ''

  maybePlaySound(type)
  maybeShowDesktop(type, message, opts?.title)

  // Actionable toasts get a longer default duration so users can react
  const duration = opts?.duration ?? (
    opts?.action ? 10000 :
    type === 'error' ? 6000 :
    type === 'warning' ? 5000 : 4000
  )

  // Улучшатели#5 P1·S — Toaster z-stack / position-rule conflict.
  // Position is owned by the <Toaster> container in Layout.tsx (top: 80, top-right).
  // Setting it here previously bypassed the container offset and stacked toasts
  // at the viewport edge instead of below the session header bar.
  return toast.custom(
    (t) => (
      <StyledToastContent t={t} type={type} message={message} title={opts?.title} action={opts?.action} />
    ),
    {
      duration,
    }
  )
}

export const notify = {
  error:   (message: string, opts?: NotifyOptions) => showToast('error', message, opts),
  success: (message: string, opts?: NotifyOptions) => showToast('success', message, opts),
  warning: (message: string, opts?: NotifyOptions) => showToast('warning', message, opts),
  info:    (message: string, opts?: NotifyOptions) => showToast('info', message, opts),
}

// КАО W4 testability: expose notify on window so e2e specs can drive
// toasts without going through real user actions. Read-only mirror —
// production behaviour is unchanged.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __cf_notify?: typeof notify }).__cf_notify = notify
}

export default notify
