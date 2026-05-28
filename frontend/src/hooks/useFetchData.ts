import { useState, useEffect, useRef, useCallback } from 'react'

interface UseFetchDataOptions {
  /** Enable/disable the fetch (default: true) */
  enabled?: boolean
  /** Called when fetch fails */
  onError?: (err: Error) => void
}

interface UseFetchDataResult<T> {
  data: T | null
  loading: boolean
  error: Error | null
  refetch: () => Promise<void>
}

/**
 * Reusable data-fetching hook with cancellation, loading, and error state.
 *
 * The fetcher must return a Promise. The hook handles:
 *   - Loading state
 *   - Error state with onError callback
 *   - Cancellation when deps change or component unmounts (via sequence number)
 *   - Manual refetch
 *
 * Usage:
 *   const { data, loading, error, refetch } = useFetchData(
 *     () => getSession(sessionId),
 *     [sessionId]
 *   )
 */
export function useFetchData<T>(
  fetcher: () => Promise<T>,
  deps: React.DependencyList,
  options: UseFetchDataOptions = {}
): UseFetchDataResult<T> {
  const { enabled = true, onError } = options
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const seqRef = useRef(0)

  const refetch = useCallback(async () => {
    if (!enabled) return
    const seq = ++seqRef.current
    setLoading(true)
    setError(null)
    try {
      const result = await fetcher()
      if (seq !== seqRef.current) return  // stale
      setData(result)
    } catch (err) {
      if (seq !== seqRef.current) return
      const e = err instanceof Error ? err : new Error(String(err))
      setError(e)
      onError?.(e)
    } finally {
      if (seq === seqRef.current) {
        setLoading(false)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ...deps])

  useEffect(() => {
    if (!enabled) return
    refetch()
    return () => {
      seqRef.current++  // cancel any in-flight fetches
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetch, enabled])

  return { data, loading, error, refetch }
}
