// КАО#SG1-selfxss (was КАО#VR-37) — polling / visibility refresh security.
//
// The SessionDetailPage installs three fallback refresh mechanisms
// (visibilitychange, window focus, 30-s interval) on top of the WS model.
// After the httpOnly-cookie migration the security-relevant invariants of that
// code shift from "always attach the Bearer token" to "always send the session
// cookie and bounce to /login on 401":
//
//   1. apiFetch sends `credentials: 'same-origin'` on EVERY request, so the
//      httpOnly session cookie rides every polled refresh — a refresh can never
//      silently drop credentials and reach the backend anonymously.
//   2. The JWT is NEVER attached as an Authorization header from JS (it's no
//      longer JS-readable) and NEVER appears in the URL.
//   3. A 401 from a protected endpoint clears the auth hint + navigates to
//      /login → polling cannot keep looping after the session dies.
//   4. A 401 from /api/auth/* does NOT redirect (the login form shows its error).
//
// We exercise the apiFetch layer directly — the single point all REST
// refreshes (polling, visibility, focus) flow through.
//
// КАО#SG1-selfxss КАО general-sanity
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  apiFetch,
  clearAuthedHint,
  getAuthedHint,
  setAuthedHint,
} from '../../services/api'

type MockFetch = ReturnType<typeof vi.fn> & {
  mock: { calls: Parameters<typeof fetch>[][] }
}

function installFetchMock(
  responses: Array<{ status: number; body: unknown; headers?: Record<string, string> }>,
): MockFetch {
  let i = 0
  const fn = vi.fn(async (..._args: Parameters<typeof fetch>) => {
    const r = responses[Math.min(i, responses.length - 1)]
    i += 1
    return new Response(
      typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      {
        status: r.status,
        headers: { 'content-type': 'application/json', ...(r.headers || {}) },
      },
    )
  }) as unknown as MockFetch
  // jsdom's fetch is on globalThis
  ;(globalThis as unknown as { fetch: typeof fetch }).fetch = fn as unknown as typeof fetch
  return fn
}

beforeEach(() => {
  // Avoid jsdom navigation between tests by stubbing window.location.href.
  const originalLocation = window.location
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...originalLocation, href: 'http://localhost/' },
  })
  clearAuthedHint()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearAuthedHint()
})

// КАО#SG1-selfxss — every refresh carries the cookie (via credentials), no Bearer.
describe('SG1 — apiFetch sends the session cookie on every refresh', () => {
  it('sets credentials:"same-origin" so the httpOnly cookie rides a poll GET', async () => {
    const fetchMock = installFetchMock([{ status: 200, body: { id: 'sess-1' } }])

    const result = await apiFetch('/api/sessions/sess-1')
    expect(result).toEqual({ id: 'sess-1' })

    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).credentials).toBe('same-origin')

    // No Authorization header is synthesised from JS anymore.
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()

    // And no token in the URL.
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).not.toContain('access_token=')
    expect(String(url)).not.toMatch(/token=/i)
  })

  it('still sends credentials with no auth hint (the cookie is the source of truth)', async () => {
    clearAuthedHint()
    expect(getAuthedHint()).toBe(false)

    const fetchMock = installFetchMock([{ status: 200, body: [] }])
    await apiFetch('/api/sessions/')
    const [, init] = fetchMock.mock.calls[0]
    expect((init as RequestInit).credentials).toBe('same-origin')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })
})

// КАО#SG1-selfxss — 401 clears the hint and redirects → polling can't loop.
describe('SG1 — 401 from a polling tick logs the user out', () => {
  it('clears the auth hint and navigates to /login on 401', async () => {
    setAuthedHint()
    installFetchMock([{ status: 401, body: { detail: 'Token expired' } }])

    await expect(apiFetch('/api/sessions/abc')).rejects.toThrow(/log in again/i)

    // Side effect 1: hint cleared so the SPA treats the user as logged out.
    expect(getAuthedHint()).toBe(false)
    // Side effect 2: navigation to /login.
    expect(window.location.href).toMatch(/\/login$/)
  })

  it('401 on /api/auth/* DOES NOT redirect (login form needs to show error)', async () => {
    setAuthedHint()
    installFetchMock([{ status: 401, body: { detail: 'Bad OTP' } }])
    await expect(apiFetch('/api/auth/verify-otp', { method: 'POST' })).rejects.toThrow()
    // Hint should still be there — auth endpoints bypass the auto-clear.
    expect(getAuthedHint()).toBe(true)
    // No navigation.
    expect(window.location.href).not.toMatch(/\/login$/)
  })
})

// КАО general-sanity — no token leakage in URLs.
describe('SG1 — no token leakage in URLs', () => {
  it('never appends a token as a query param (uses the cookie)', async () => {
    const fetchMock = installFetchMock([{ status: 200, body: { ok: true } }])
    await apiFetch('/api/sessions/abc')
    const [url] = fetchMock.mock.calls[0]
    const s = String(url)
    expect(s).not.toMatch(/access_token=/i)
    expect(s).not.toMatch(/token=/i)
    expect(s).not.toMatch(/bearer/i)
  })
})
