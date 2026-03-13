import { Fragment, useCallback } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { XMarkIcon, TrashIcon, ExclamationCircleIcon, InformationCircleIcon } from '@heroicons/react/24/outline'

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
  const iconColors = {
    danger: 'text-red-400 bg-gradient-to-br from-red-500/30 to-red-600/20',
    warning: 'text-yellow-400 bg-gradient-to-br from-yellow-500/30 to-yellow-600/20',
    info: 'text-blue-400 bg-gradient-to-br from-blue-500/30 to-blue-600/20',
  }

  const buttonColors = {
    danger: 'bg-gradient-to-r from-red-600 to-red-700 hover:from-red-500 hover:to-red-600 focus:ring-red-500 shadow-lg shadow-red-500/25',
    warning: 'bg-gradient-to-r from-yellow-600 to-yellow-700 hover:from-yellow-500 hover:to-yellow-600 focus:ring-yellow-500 shadow-lg shadow-yellow-500/25',
    info: 'bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-500 hover:to-blue-600 focus:ring-blue-500 shadow-lg shadow-blue-500/25',
  }

  const borderColors = {
    danger: 'border-red-500/30',
    warning: 'border-yellow-500/30',
    info: 'border-blue-500/30',
  }

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
                className={`w-full max-w-md transform overflow-hidden rounded-2xl bg-gradient-to-b from-gray-800 to-gray-900 border ${borderColors[type]} p-6 shadow-2xl transition-all`}
              >
                {/* Close button */}
                <button
                  onClick={onClose}
                  className="absolute top-4 right-4 text-gray-500 hover:text-gray-300 transition-colors p-1 rounded-lg hover:bg-gray-700/50"
                >
                  <XMarkIcon className="w-5 h-5" />
                </button>

                <div className="flex flex-col items-center text-center">
                  {/* Icon */}
                  <div className={`p-4 rounded-2xl ${iconColors[type]} mb-4`}>
                    <Icon className="w-8 h-8" />
                  </div>

                  {/* Content */}
                  <Dialog.Title className="text-xl font-bold text-white mb-2">
                    {title}
                  </Dialog.Title>
                  <Dialog.Description className="text-sm text-gray-400 leading-relaxed max-w-sm">
                    {message}
                  </Dialog.Description>
                </div>

                {/* Actions */}
                <div className="mt-8 flex gap-3">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={loading}
                    className="flex-1 px-4 py-3 text-sm font-semibold text-gray-300 bg-gray-700/50 hover:bg-gray-600/50 border border-gray-600 rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-gray-500 disabled:opacity-50"
                  >
                    {cancelText}
                  </button>
                  <button
                    type="button"
                    onClick={onConfirm}
                    disabled={loading}
                    className={`flex-1 px-4 py-3 text-sm font-semibold text-white rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:opacity-50 ${buttonColors[type]}`}
                  >
                    {loading ? (
                      <span className="flex items-center justify-center gap-2">
                        <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                          <circle
                            className="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            strokeWidth="4"
                            fill="none"
                          />
                          <path
                            className="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                          />
                        </svg>
                        Processing...
                      </span>
                    ) : (
                      confirmText
                    )}
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
