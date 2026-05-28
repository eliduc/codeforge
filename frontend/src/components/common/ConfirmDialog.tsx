import { Fragment, useCallback } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { XMarkIcon, TrashIcon, ExclamationCircleIcon, InformationCircleIcon } from '@heroicons/react/24/outline'
import Button from './Button'

interface ConfirmDialogProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string
  confirmText?: string
  cancelText?: string
  type?: 'danger' | 'warning' | 'info'
  loading?: boolean
}

export default function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Delete',
  cancelText = 'Cancel',
  type = 'danger',
  loading = false,
}: ConfirmDialogProps) {
  // Улучшатели#5 P1·M — light-theme contract: keep type-coloured icon halos
  // but route the panel/text through cf-* tokens so light mode is readable.
  const iconColors = {
    danger: 'text-red-500 bg-red-500/15',
    warning: 'text-yellow-500 bg-yellow-500/15',
    info: 'text-blue-500 bg-blue-500/15',
  }

  const borderColors = {
    danger: 'border-red-500/40',
    warning: 'border-yellow-500/40',
    info: 'border-blue-500/40',
  }

  // Confirm button variant: danger maps to the new Button primitive variant.
  // warning/info both use 'primary' which is theme-aware.
  const confirmVariant: 'danger' | 'primary' = type === 'danger' ? 'danger' : 'primary'

  const Icon = type === 'danger' ? TrashIcon : type === 'warning' ? ExclamationCircleIcon : InformationCircleIcon

  // Headless UI Dialog handles focus trap and Escape key natively
  const safeClose = useCallback(() => {
    if (!loading) onClose()
  }, [loading, onClose])

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={safeClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/70 backdrop-blur-md" onClick={safeClose} aria-hidden="true" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-90 translate-y-4"
              enterTo="opacity-100 scale-100 translate-y-0"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100 translate-y-0"
              leaveTo="opacity-0 scale-90 translate-y-4"
            >
              <Dialog.Panel
                className={`relative w-full max-w-md transform overflow-hidden rounded-2xl bg-cf-panel text-cf-text border ${borderColors[type]} p-6 shadow-2xl transition-all`}
              >
                {/* Close button — Улучшатели#5 P2·S — all close paths gated through safeClose.
                    Visually grayed out while loading to match disabled affordance. */}
                <button
                  onClick={safeClose}
                  disabled={loading}
                  aria-label="Close dialog"
                  className={`absolute top-4 right-4 transition-colors p-1 rounded-lg disabled:cursor-not-allowed ${
                    loading
                      ? 'text-cf-text-muted/40 opacity-40'
                      : 'text-cf-text-muted hover:text-cf-text hover:bg-cf-hover'
                  }`}
                >
                  <XMarkIcon className="w-5 h-5" />
                </button>

                <div className="flex flex-col items-center text-center">
                  {/* Icon */}
                  <div className={`p-4 rounded-2xl ${iconColors[type]} mb-4`}>
                    <Icon className="w-8 h-8" />
                  </div>

                  {/* Content */}
                  <Dialog.Title className="text-xl font-bold text-cf-text mb-2">
                    {title}
                  </Dialog.Title>
                  <Dialog.Description className="text-sm text-cf-text-muted leading-relaxed max-w-sm">
                    {message}
                  </Dialog.Description>
                </div>

                {/* Actions — Улучшатели#5 P1·M Button primitive. */}
                <div className="mt-8 flex gap-3">
                  <Button
                    variant="secondary"
                    size="lg"
                    onClick={safeClose}
                    disabled={loading}
                    fullWidth
                  >
                    {cancelText}
                  </Button>
                  <Button
                    variant={confirmVariant}
                    size="lg"
                    onClick={onConfirm}
                    loading={loading}
                    fullWidth
                  >
                    {loading ? 'Processing...' : confirmText}
                  </Button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
