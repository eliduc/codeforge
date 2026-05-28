/**
 * Onboarding tour persistence hook.
 *
 * Tour state is stored in localStorage as boolean flags so a returning user
 * doesn't see the same tour twice. The version suffix (_v1) lets us bump
 * tour copy in the future and re-trigger every flow at once.
 */

export type TourId =
  | 'welcome'
  | 'session_anatomy'
  | 'session_live'
  | 'session_done'

// Bumped to v2 when the Demo Gallery step was added to the Welcome tour.
// Bumping the prefix re-triggers every flow for returning users so they see
// the new step. resetAll() clears the whole new prefix in one shot.
const KEY_PREFIX = 'cf_tour_v2_'

export const TOUR_KEYS: Record<TourId, string> = {
  welcome: `${KEY_PREFIX}welcome`,
  session_anatomy: `${KEY_PREFIX}session_anatomy`,
  session_live: `${KEY_PREFIX}session_live`,
  session_done: `${KEY_PREFIX}session_done`,
}

export function isTourSeen(id: TourId): boolean {
  try {
    return localStorage.getItem(TOUR_KEYS[id]) === 'true'
  } catch {
    return false
  }
}

export function markSeen(id: TourId): void {
  try {
    localStorage.setItem(TOUR_KEYS[id], 'true')
  } catch {
    /* localStorage might be disabled — silently ignore */
  }
}

// Legacy v1 keys — kept here so resetAll() can clean them up for users who
// were onboarded before the v2 bump. Safe to remove once stage/prod is fully
// migrated.
const LEGACY_KEYS = [
  'cf_tour_v1_welcome',
  'cf_tour_v1_session_anatomy',
  'cf_tour_v1_session_live',
  'cf_tour_v1_session_done',
]

export function resetAll(): void {
  try {
    for (const key of Object.values(TOUR_KEYS)) {
      localStorage.removeItem(key)
    }
    for (const key of LEGACY_KEYS) {
      localStorage.removeItem(key)
    }
  } catch {
    /* ignore */
  }
}

/** Returns true if at least one tour has been seen. Used as a hint that the
 *  user has been onboarded at least once. */
export function anyTourSeen(): boolean {
  return (Object.keys(TOUR_KEYS) as TourId[]).some(isTourSeen)
}
