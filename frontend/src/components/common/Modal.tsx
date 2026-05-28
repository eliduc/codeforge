// Улучшатели#5 P1·M — Modal primitive cascade fix.
// Wraps @headlessui/react Dialog so we get:
//   * proper role="dialog" + aria-modal
//   * focus trap with auto-restore
//   * Esc-to-close (suppressed when `loading` is true to protect in-flight ops)
//   * backdrop click handler (also suppressed when loading)
//   * theme-aware surface using cf-* tokens (works for both light and dark)
//
// Rescues hand-rolled `<div>` modals like ResultActionsExtras.ModalShell that
// previously had none of the above accessibility affordances.

import { Fragment, type ReactNode } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import clsx from 'clsx'

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '4xl' | '6xl' | 'screen-2xl'

export interface ModalProps {
  open: boolean
  onClose: () => void
  /** When true, Esc + backdrop are ignored and the close button is disabled. */
  loading?: boolean
  /** Title used for Dialog.Title and aria-labelledby. Required for a11y. */
  title: ReactNode
  /** Optional description rendered under the title. */
  description?: ReactNode
  /** Optional decorative icon shown next to the title. */
  icon?: ReactNode
  size?: ModalSize
  /** Hide the built-in X close button if the body provides its own. */
  hideCloseButton?: boolean
  className?: string
  children: ReactNode
}

const sizeClasses: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
  // КАО#VR-26 — wide sizes for the Visual Review slideshow modal so a
  // 1280×720 PNG isn't downscaled to a thumbnail. max-w-2xl was only 672px.
  '4xl': 'max-w-4xl',
  '6xl': 'max-w-6xl',
  'screen-2xl': 'max-w-screen-2xl',
}

export default function Modal({
  open,
  onClose,
  loading = false,
  title,
  description,
  icon,
  size = 'md',
  hideCloseButton = false,
  className,
  children,
}: ModalProps) {
  // Headless UI Dialog onClose is fired by Esc + backdrop. Gating it on `loading`
  // gives us a single chokepoint that respects the prop without needing the
  // consumer to wire its own handlers.
  const safeClose = () => {
    if (!loading) onClose()
  }

  return (
    <Transition appear show={open} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={safeClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" aria-hidden="true" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-200"
              enterFrom="opacity-0 scale-95 translate-y-2"
              enterTo="opacity-100 scale-100 translate-y-0"
              leave="ease-in duration-150"
              leaveFrom="opacity-100 scale-100 translate-y-0"
              leaveTo="opacity-0 scale-95 translate-y-2"
            >
              <Dialog.Panel
                className={clsx(
                  'relative w-full transform overflow-hidden rounded-2xl shadow-2xl transition-all',
                  // Theme-aware surface — replaces hard-coded gray-800/gray-900 gradient.
                  'bg-cf-panel text-cf-text border border-cf-border',
                  sizeClasses[size],
                  className,
                )}
              >
                {!hideCloseButton && (
                  <button
                    type="button"
                    onClick={safeClose}
                    disabled={loading}
                    aria-label="Close dialog"
                    className="absolute top-3 right-3 p-1 rounded-lg text-cf-text-muted hover:text-cf-text hover:bg-cf-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <XMarkIcon className="w-5 h-5" />
                  </button>
                )}

                {(title || description || icon) && (
                  <div className="flex items-start gap-3 px-6 pt-6 pr-12">
                    {icon && <div className="shrink-0">{icon}</div>}
                    <div className="min-w-0 flex-1">
                      <Dialog.Title className="text-lg font-semibold text-cf-text leading-tight">
                        {title}
                      </Dialog.Title>
                      {description && (
                        <Dialog.Description className="text-sm text-cf-text-muted mt-1 leading-relaxed">
                          {description}
                        </Dialog.Description>
                      )}
                    </div>
                  </div>
                )}

                <div className="px-6 pt-4 pb-6">{children}</div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
