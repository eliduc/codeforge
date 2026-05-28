// КАО Security writers — VR-37 polling / visibility-triggered refresh.
//
// Scope: The SessionDetailPage installs three fallback refresh mechanisms
//   (visibilitychange, window focus, 30-s interval) on top of the WS-driven
//   model. This file asserts the security-relevant invariants of that code:
//
//   1. apiFetch ALWAYS attaches the stored Bearer token, so a polled refresh
//      can never reach the backend anonymously.
//   2. If the token is cleared (e.g. user logged out) BEFORE a polling tick,
//      the subsequent apiFetch sends NO Authorization header — which means
//      the backend returns 401 and the SPA bounces to /login (i.e. polling
//      cannot keep fetching protected data after logout).
//   3. A 401 from a non-/api/auth/* endpoint triggers clearStoredToken() —
//      i.e. once the backend rejects, we don't keep retrying with a stale
//      token.
//   4. The Bearer token never ends up in the URL query string for non-WS
//      requests (would leak to access logs / Referer).
//
// We deliberately do NOT mount SessionDetailPage itself — the test would
// have to mock React Query, the WS, and the whole sub-tree, which would
// dilute the security signal. Instead we exercise the apiFetch layer
// directly, which is the single point through which all REST refreshes
// (polling, visibility, focus) go.
//
// КАО#VR-37 КАО general-sanity
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  apiFetch,
  clearStoredToken,
  getStoredToken,
  setStoredToken,
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
  // Vitest's vi.stubGlobal won't replace location wholesale on jsdom, so we
  // monkey-patch the href setter via Object.defineProperty.
  const originalLocation = window.location
  Object.defineProperty(window, 'location', {
    writable: true,
    value: { ...originalLocation, href: 'http://localhost/' },
  })
  clearStoredToken()
})

afterEach(() => {
  vi.restoreAllMocks()
  clearStoredToken()
})

// КАО#VR-37 — polling-style refresh ATTACHES Bearer when a token exists.
describe('VR-37 — apiFetch attaches Bearer on every refresh', () => {
  it('uses stored token for a refresh GET (simulates 30-s poll)', async () => {
    setStoredToken('test-jwt-token-abcdef')
    const fetchMock = installFetchMock([{ status: 200, body: { id: 'sess-1' } }])

    const result = await apiFetch('/api/sessions/sess-1')
    expect(result).toEqual({ id: 'sess-1' })

    // Inspect the actual Authorization header.
    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer test-jwt-token-abcdef')

    // Token does NOT appear in URL.
    const [url] = fetchMock.mock.calls[0]
    expect(String(url)).not.toContain('test-jwt-token-abcdef')
    expect(String(url)).not.toContain('access_token=')
  })

  it('does NOT attach Authorization if no token (i.e. after logout)', async () => {
    // Simulate logout: clearStoredToken was called before this poll tick.
    clearStoredToken()
    expect(getStoredToken()).toBeNull()

    const fetchMock = installFetchMock([{ status: 200, body: [] }])
    await apiFetch('/api/sessions/')
    const [, init] = fetchMock.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })
})

// КАО#VR-37 — 401 clears the token and redirects → polling can't loop.
describe('VR-37 — 401 from polling tick logs the user out', () => {
  it('clears stored token and navigates to /login on 401', async () => {
    setStoredToken('stale-jwt-aaaa')
    installFetchMock([{ status: 401, body: { detail: 'Token expired' } }])

    await expect(apiFetch('/api/sessions/abc')).rejects.toThrow(/log in again/i)

    // Side effect 1: token cleared so the NEXT poll has no Bearer header.
    expect(getStoredToken()).toBeNull()
    // Side effect 2: navigation to /login (the harness moved window.location.href).
    expect(window.location.href).toMatch(/\/login$/)
  })

  it('after a 401 cleared the token, a subsequent fetch is anonymous (no Bearer)', async () => {
    setStoredToken('jwt-to-be-invalidated')
    // First call returns 401 → token cleared
    installFetchMock([
      { status: 401, body: { detail: 'expired' } },
    ])
    await expect(apiFetch('/api/sessions/x')).rejects.toThrow(/log in/i)

    // Second call uses a fresh fetch mock; assert no Bearer
    const second = installFetchMock([{ status: 200, body: { id: 'x' } }])
    await apiFetch('/api/sessions/x')
    const [, init] = second.mock.calls[0]
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBeUndefined()
  })

  it('401 on /api/auth/* DOES NOT redirect (login form needs to show error)', async () => {
    setStoredToken('bad-otp')
    installFetchMock([{ status: 401, body: { detail: 'Bad OTP' } }])
    await expect(apiFetch('/api/auth/verify-otp', { method: 'POST' })).rejects.toThrow()
    // Token should still be there — auth endpoints bypass the auto-clear.
    expect(getStoredToken()).toBe('bad-otp')
    // No navigation.
    expect(window.location.href).not.toMatch(/\/login$/)
  })
})

// КАО general-sanity — Bearer never leaks to URL or browser-side artefacts.
describe('VR-37 — no token leakage in URLs', () => {
  it('never appends token as ?access_token=… (uses header)', async () => {
    setStoredToken('eyJsensitive')
    const fetchMock = installFetchMock([{ status: 200, body: { ok: true } }])
    await apiFetch('/api/sessions/abc')
    const [url] = fetchMock.mock.calls[0]
    const s = String(url)
    expect(s).not.toMatch(/access_token=/i)
    expect(s).not.toMatch(/token=eyJ/i)
    expect(s).not.toMatch(/bearer/i)
  })

  it('does not log the token to console on error (smoke check)', async () => {
    setStoredToken('eyJSUPERSECRET')
    installFetchMock([{ status: 500, body: { detail: 'oops' } }])
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await apiFetch('/api/sessions/abc').catch(() => {})
      for (const call of errSpy.mock.calls) {
        const msg = call.map(String).join(' ')
        expect(msg).not.toContain('eyJSUPERSECRET')
      }
    } finally {
      errSpy.mockRestore()
    }
  })
})
