import { useState, useEffect, useRef } from 'react'
import notify from '../components/common/StyledToast'

/**
 * Reusable clipboard copy hook with auto-reset and notify integration.
 * Tracks copy state for 2 seconds, shows success toast, cleans up on unmount.
 */
export function useCopyToClipboard(timeoutMs = 2000) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => { clearTimeout(timerRef.current) }, [])

  const copy = async (text: string, successMessage = 'Copied to clipboard') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      notify.success(successMessage)
      clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCopied(false), timeoutMs)
      return true
    } catch (err) {
      notify.error('Failed to copy to clipboard')
      return false
    }
  }

  return { copied, copy }
}
