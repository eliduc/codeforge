import { useEffect, useState } from 'react'

/**
 * Subscribe to a CSS media query and re-render when its match state flips.
 *
 * Returns `true` when the query currently matches, `false` otherwise.
 * SSR-safe: defaults to `false` when `window` is unavailable so the first
 * render is deterministic (the effect re-syncs once mounted).
 *
 * Example:
 *   const isMobile = useMediaQuery('(max-width: 767px)')
 */
export function useMediaQuery(query: string): boolean {
  const getMatch = (): boolean => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia(query).matches
  }
  const [matches, setMatches] = useState<boolean>(getMatch)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches)
    // Sync once on mount in case the initial state was stale (e.g. SSR).
    setMatches(mql.matches)
    // Safari < 14 only supports the legacy addListener API.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    }
    mql.addListener(onChange)
    return () => mql.removeListener(onChange)
  }, [query])

  return matches
}
