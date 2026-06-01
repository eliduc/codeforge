// КАО#SG1-selfxss — token storage hygiene (post httpOnly-cookie migration).
//
// The JWT now lives in an httpOnly `codeforge_session` cookie set by the
// backend — JavaScript CANNOT read it, so a same-origin XSS (e.g. a preview
// tab opened from generated code) can no longer exfiltrate it. This file
// asserts the INVERTED invariant of the old localStorage-token model:
//
//   • The auth helpers never write a JWT to localStorage — only a NON-sensitive
//     hint flag ('codeforge_authed' = '1'). Reading or forging the flag grants
//     no access; only the httpOnly cookie does.
//   • clearLegacyToken() purges any JWT older builds left under the legacy
//     'codeforge_token' key (defence-in-depth migration of existing clients).
//   • The auth helpers never leak a session into document.cookie /
//     document.title / location.href.
//
// КАО#SG1-selfxss КАО general-sanity
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  clearAuthedHint,
  clearLegacyToken,
  getAuthedHint,
  setAuthedHint,
} from '../../services/api'

const LEGACY_KEY = 'codeforge_token'
const HINT_KEY = 'codeforge_authed'

beforeEach(() => {
  localStorage.clear()
  document.title = ''
})

afterEach(() => {
  localStorage.clear()
})

describe('token storage hygiene (httpOnly cookie model)', () => {
  it('the auth hint is just a flag — never a JWT', () => {
    setAuthedHint()
    expect(getAuthedHint()).toBe(true)
    // The stored value is the literal '1', not a token.
    expect(localStorage.getItem(HINT_KEY)).toBe('1')
    // Scan ALL of localStorage: nothing JWT-shaped (base64url "eyJ…") present.
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i) as string
      const v = localStorage.getItem(k) || ''
      expect(v).not.toMatch(/^eyJ/)
    }
  })

  it('clearAuthedHint removes the flag', () => {
    setAuthedHint()
    expect(getAuthedHint()).toBe(true)
    clearAuthedHint()
    expect(getAuthedHint()).toBe(false)
    expect(localStorage.getItem(HINT_KEY)).toBeNull()
  })

  it('clearLegacyToken purges a JWT left under the legacy key', () => {
    // Simulate an old build that stored the JWT in localStorage.
    localStorage.setItem(LEGACY_KEY, 'eyJhbGciOi.PAYLOAD.sig')
    clearLegacyToken()
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull()
  })

  it('auth helpers never leak a session into cookie / title / location', () => {
    setAuthedHint()
    // The httpOnly session cookie is set by the SERVER and is not JS-readable;
    // the client must never write it (or any JWT) to document.cookie.
    expect(document.cookie).not.toContain('codeforge_session')
    expect(document.cookie).not.toMatch(/eyJ/)
    expect(document.title).not.toMatch(/eyJ/)
    expect(window.location.href).not.toMatch(/eyJ/)
  })
})
