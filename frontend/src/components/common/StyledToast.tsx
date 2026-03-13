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

interface StyledToastProps {
  t: Toast
  type: ToastType
  message: string
  title?: string
}

function StyledToastContent({ t, type, message, title }: StyledToastProps) {
  const s = styles[type]
  const displayTitle = title || typeLabels[type]

  return (
    <div
      className={`
        ${t.visible ? 'animate-toast-enter' : 'animate-toast-leave'}
        max-w-sm w-full pointer-events-auto
        rounded-xl border ${s.border}
        bg-gradient-to-b from-gray-800/95 to-gray-900/95
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
          <p className="text-[13px] text-gray-300 mt-1 leading-relaxed break-words">
            {message}
          </p>
        </div>

        {/* Dismiss button */}
        <button
          onClick={() => toast.dismiss(t.id)}
          className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-gray-700/50 transition-colors shrink-0"
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
}

function showToast(type: ToastType, message: string, opts?: NotifyOptions) {
  const duration = opts?.duration ?? (type === 'error' ? 6000 : type === 'warning' ? 5000 : 4000)

  return toast.custom(
    (t) => (
      <StyledToastContent t={t} type={type} message={message} title={opts?.title} />
    ),
    {
      duration,
      position: 'top-right',
    }
  )
}

export const notify = {
  error:   (message: string, opts?: NotifyOptions) => showToast('error', message, opts),
  success: (message: string, opts?: NotifyOptions) => showToast('success', message, opts),
  warning: (message: string, opts?: NotifyOptions) => showToast('warning', message, opts),
  info:    (message: string, opts?: NotifyOptions) => showToast('info', message, opts),
}

export default notify
