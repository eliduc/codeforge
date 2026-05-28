// КАО Security writers — General sanity: token storage hygiene.
//
// Asserts:
//   • setStoredToken / getStoredToken roundtrip via localStorage only — token
//     is NOT mirrored into cookies (where it could be sent cross-site).
//   • clearStoredToken removes the value so it's not recoverable.
//   • The auth-token key name has not silently changed (would break logout
//     across all open tabs).
//   • The token, once stored, is NOT leaked into document.title, location.href,
//     or document.cookie by any of the api helpers.
//
// КАО general-sanity
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearStoredToken,
  getStoredToken,
  setStoredToken,
} from '../../services/api'

beforeEach(() => {
  clearStoredToken()
  document.cookie = ''
  document.title = ''
})

afterEach(() => {
  clearStoredToken()
})

describe('token storage hygiene', () => {
  it('roundtrips via localStorage and only localStorage', () => {
    setStoredToken('jwt-abc-123')
    expect(getStoredToken()).toBe('jwt-abc-123')

    // Confirm value is in localStorage under a stable key.
    // We don't hardcode the exact key here — instead we scan localStorage
    // for a value matching the token. If there's no match, the storage
    // mechanism changed silently and we want to know.
    let foundInLS = false
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i) as string
      if (localStorage.getItem(k) === 'jwt-abc-123') {
        foundInLS = true
        // Defensive: ensure it's stored under a sensibly-named key.
        expect(k.toLowerCase()).toMatch(/token|auth|jwt|codeforge/)
        break
      }
    }
    expect(foundInLS, 'token must be in localStorage').toBe(true)

    // NOT in cookies.
    expect(document.cookie).not.toContain('jwt-abc-123')
  })

  it('clearStoredToken empties the slot', () => {
    setStoredToken('to-be-deleted')
    expect(getStoredToken()).toBe('to-be-deleted')
    clearStoredToken()
    expect(getStoredToken()).toBeNull()
  })

  it('does not mirror token into document.title / cookie / location on read', () => {
    setStoredToken('eyJSECRET.payload.signature')
    // Read the token a few times in different ways.
    const t = getStoredToken()
    expect(t).toBe('eyJSECRET.payload.signature')

    // No browser-side leak vectors.
    expect(document.title).not.toContain('eyJSECRET')
    expect(document.cookie).not.toContain('eyJSECRET')
    expect(window.location.href).not.toContain('eyJSECRET')
  })

  it('storage key name is stable (regression: do NOT silently rename it)', () => {
    setStoredToken('stable-key-probe')
    // Grab the key the helper used; assert it matches the public contract
    // (CodeForge stores under 'codeforge_token' — if anyone changes this,
    // every open browser tab logs out, which is a UX-breaking change that
    // must be done deliberately, not as a refactor side-effect).
    let storedUnder: string | null = null
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i) as string
      if (localStorage.getItem(k) === 'stable-key-probe') {
        storedUnder = k
        break
      }
    }
    expect(storedUnder).toBe('codeforge_token')
  })
})
