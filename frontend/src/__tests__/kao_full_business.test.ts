// КАО#Full-A2 — Frontend business-logic coverage (no React rendering).
//
// Scope: pure helpers + the apiFetch HTTP plumbing. We deliberately do NOT
// overlap with kao_vr25_to_27.test.tsx (which covers the error-message
// flattening branch of apiFetch). Instead we cover:
//   • analyzeSpec across languages, including Russian-Cyrillic substrings.
//   • apiFetch:
//       - 401 clears the token + redirects to /login (the auth-loop guard).
//       - timeout (AbortController) surfaces a "Request timeout after Xms".
//       - 204 No Content returns undefined (not "throws on empty body").
//       - Bearer token is attached when a stored token is present.
//       - Auth-endpoints (/api/auth/*) do NOT trigger the redirect on 401
//         (so the login form can show "wrong code" without bouncing).
//
// Sandbox: each test installs its own fetch mock + clears localStorage so the
// suite remains hermetic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { analyzeSpec, BROWSER_RENDERABLE_LANGUAGES } from '../lib/visualReviewHints'
import {
  apiFetch,
  clearStoredToken,
  getStoredToken,
  setStoredToken,
} from '../services/api'

// ────────────────────────────────────────────────────────────────────────────
// 1. analyzeSpec — language + keyword matrix, including Russian.
// ────────────────────────────────────────────────────────────────────────────

// КАО#Full-A2 — analyzeSpec on empty / null / undefined inputs is a no-op.
describe('analyzeSpec — null-safety', () => {
  it('handles null spec', () => {
    const result = analyzeSpec(null, 'python')
    expect(result.hasVisualKeywords).toBe(false)
    expect(result.suggestSwitch).toBe(false)
    expect(result.matchedKeywords).toEqual([])
  })

  it('handles undefined spec', () => {
    const result = analyzeSpec(undefined, 'python')
    expect(result.hasVisualKeywords).toBe(false)
  })

  it('handles empty string spec', () => {
    const result = analyzeSpec('', 'python')
    expect(result.hasVisualKeywords).toBe(false)
    expect(result.matchedKeywords).toEqual([])
  })

  it('handles null language', () => {
    const result = analyzeSpec('animate a particle', null)
    // No language means isBrowserRenderable=false, suggestSwitch=true.
    expect(result.hasVisualKeywords).toBe(true)
    expect(result.isBrowserRenderable).toBe(false)
    expect(result.suggestSwitch).toBe(true)
  })
})

// КАО#Full-A2 — English keyword detection with word-boundary semantics.
describe('analyzeSpec — English keywords (word-boundary)', () => {
  it.each([
    ['render a button', 'render'],
    ['animate the canvas', 'animate'],
    ['draw a circle', 'draw'],
    ['paint it red', 'paint'],
    ['build a game', 'game'],
    ['compute a fractal', 'fractal'],
    ['run a simulation', 'simulation'],
    ['emit a particle', 'particle'],
    ['add a glow effect', 'glow'],
  ])('matches %s -> contains %s', (spec, keyword) => {
    const r = analyzeSpec(spec, 'python')
    expect(r.hasVisualKeywords).toBe(true)
    expect(r.matchedKeywords).toContain(keyword.toLowerCase())
  })

  it('does NOT match substrings inside larger words (word-boundary)', () => {
    // "rendering" contains "render", but \b should NOT match because the
    // regex uses \b(render)\b — "rendering" has a letter after "render".
    // However, our regex is /\b(...)\b/gi so "rendering" actually has \b
    // only at the start and end of the WHOLE word; "render" inside
    // "rendering" is NOT word-bounded on the right. So no match.
    const r = analyzeSpec('the rendering pipeline works fine', 'python')
    // The keyword 'render' isolated wouldn't match, but the regex matches
    // 'render' followed by 'ing' which is NOT a word boundary — confirm.
    expect(r.matchedKeywords).not.toContain('render')
  })

  it('is case-insensitive', () => {
    const r = analyzeSpec('Animate THE Game', 'python')
    expect(r.matchedKeywords).toContain('animate')
    expect(r.matchedKeywords).toContain('game')
  })

  it('returns DISTINCT keywords (no duplicates)', () => {
    const r = analyzeSpec('animate animate animate', 'python')
    const animateCount = r.matchedKeywords.filter(k => k === 'animate').length
    expect(animateCount).toBe(1)
  })
})

// КАО#Full-A2 — Russian/Cyrillic substring matching (frontend-only feature).
describe('analyzeSpec — Russian keywords (substring)', () => {
  it.each([
    ['визуально нарисуй сцену', 'визуально'],
    ['нужна визуализация данных', 'визуализ'],
    ['добавь анимацию частиц', 'анимаци'],
    ['это графика на canvas', 'графика'],
    ['рисование линий', 'рисов'],
    ['простая игра', 'игра'],
    ['рендер сцены', 'рендер'],
    ['используй канвас', 'канвас'],
  ])('matches RU spec "%s" -> %s', (spec, keyword) => {
    const r = analyzeSpec(spec, 'python')
    expect(r.hasVisualKeywords).toBe(true)
    expect(r.matchedKeywords).toContain(keyword)
  })

  it('matches morphological variants via substring (визуализируй / визуальный)', () => {
    expect(analyzeSpec('визуализируй процесс', 'python').hasVisualKeywords).toBe(true)
    expect(analyzeSpec('визуальный редактор', 'python').hasVisualKeywords).toBe(true)
    expect(analyzeSpec('анимационный фон', 'python').hasVisualKeywords).toBe(true)
  })

  it('mixed Russian + English in one spec captures BOTH groups', () => {
    const r = analyzeSpec('Build a game с анимацией', 'python')
    expect(r.matchedKeywords).toContain('game')
    expect(r.matchedKeywords).toContain('анимаци')
  })
})

// КАО#Full-A2 — suggestSwitch = hasVisualKeywords AND !isBrowserRenderable
describe('analyzeSpec — suggestSwitch logic', () => {
  it.each(BROWSER_RENDERABLE_LANGUAGES)(
    'does NOT suggest switch for browser-renderable language %s',
    (lang) => {
      const r = analyzeSpec('animate a particle', lang)
      expect(r.hasVisualKeywords).toBe(true)
      expect(r.isBrowserRenderable).toBe(true)
      expect(r.suggestSwitch).toBe(false)
    },
  )

  it.each(['python', 'go', 'rust', 'java', 'cpp'])(
    'DOES suggest switch when visual spec + non-browser language %s',
    (lang) => {
      const r = analyzeSpec('animate a particle', lang)
      expect(r.suggestSwitch).toBe(true)
    },
  )

  it('does NOT suggest switch for plain non-visual spec on python', () => {
    const r = analyzeSpec('sort a list of integers ascending', 'python')
    expect(r.hasVisualKeywords).toBe(false)
    expect(r.suggestSwitch).toBe(false)
  })

  it('normalizes language case + whitespace before lookup', () => {
    const r = analyzeSpec('animate a particle', '  HTML  ')
    expect(r.isBrowserRenderable).toBe(true)
    expect(r.suggestSwitch).toBe(false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 2. apiFetch — Bearer attachment + 401 redirect + timeout + 204 No Content.
// ────────────────────────────────────────────────────────────────────────────

describe('apiFetch — Bearer + 401 + 204 + timeout', () => {
  const originalFetch = globalThis.fetch
  // Capture the original window.location so we can restore it.
  const originalLocation = window.location

  beforeEach(() => {
    globalThis.fetch = vi.fn() as typeof globalThis.fetch
    // Each test starts with a clean token store.
    clearStoredToken()
    // Re-mock window.location so we can detect the redirect.
    // (jsdom's location is non-configurable by default; replace via Object.defineProperty.)
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: { ...originalLocation, href: 'http://localhost/' },
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    clearStoredToken()
    Object.defineProperty(window, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    })
  })

  // КАО#Full-A2 — apiFetch attaches Bearer header from localStorage.
  it('attaches Authorization: Bearer <token> when a token is stored', async () => {
    setStoredToken('my-jwt')
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as unknown as Response)

    await apiFetch('/api/sessions/')

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs).toBeDefined()
    const init = callArgs?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer my-jwt')
  })

  // КАО#Full-A2 — when no token, no Authorization header is set.
  it('omits Authorization when no token is stored', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response)

    await apiFetch('/api/sessions/')

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const init = callArgs?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBeUndefined()
  })

  // КАО#Full-A2 — 401 on non-auth endpoint clears token + redirects.
  it('on 401 (non-auth path): clears token and redirects to /login', async () => {
    setStoredToken('expired-jwt')
    expect(getStoredToken()).toBe('expired-jwt')

    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'expired' }),
    } as unknown as Response)

    let caught: unknown
    try {
      await apiFetch('/api/sessions/')
    } catch (e) {
      caught = e
    }

    // Token must be cleared.
    expect(getStoredToken()).toBeNull()
    // Redirect must have been triggered.
    expect(window.location.href).toBe('/login')
    // The thrown error explains the session expired.
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/session expired/i)
  })

  // КАО#Full-A2 — 401 on /api/auth/* must NOT clear or redirect (login UX).
  it('on 401 from /api/auth/*: does NOT redirect or clear token', async () => {
    setStoredToken('some-jwt')
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ detail: 'invalid code' }),
    } as unknown as Response)

    let caught: unknown
    try {
      await apiFetch('/api/auth/verify-otp', { method: 'POST', body: '{}' })
    } catch (e) {
      caught = e
    }

    // Token must NOT be cleared — the user might still have a valid one
    // (e.g. they're verifying an unrelated OTP).
    expect(getStoredToken()).toBe('some-jwt')
    // No redirect.
    expect(window.location.href).toBe('http://localhost/')
    // Error still surfaces with the server's detail.
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('invalid code')
  })

  // КАО#Full-A2 — 204 No Content returns undefined (not a thrown JSON parse).
  it('returns undefined on 204 No Content', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 204,
      // 204 responses have no body; json() would throw if called.
      json: async () => { throw new Error('204 has no body') },
    } as unknown as Response)

    const result = await apiFetch<void>('/api/sessions/abc', { method: 'DELETE' })
    expect(result).toBeUndefined()
  })

  // КАО#Full-A2 — timeout via AbortController -> "Request timeout after Xms".
  it('surfaces a "Request timeout" error when the request aborts', async () => {
    // Mock fetch to honor the AbortSignal: when aborted, throw AbortError.
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init.signal as AbortSignal
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new DOMException(
                'The operation was aborted',
                'AbortError',
              )
              reject(err)
            })
          }
          // Never resolve — wait for abort.
        })
      },
    )

    let caught: unknown
    try {
      // Use a very short timeout (10ms) so the test runs fast.
      await apiFetch('/api/slow', {}, 10)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toMatch(/timeout/i)
    expect((caught as Error).message).toContain('10ms')
    expect((caught as Error).message).toContain('/api/slow')
  })

  // КАО#Full-A2 — Content-Type header defaults to application/json.
  it('defaults Content-Type to application/json on JSON requests', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response)

    await apiFetch('/api/sessions/', { method: 'POST', body: '{}' })

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const init = callArgs?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
  })

  // КАО#Full-A2 — caller-supplied headers override defaults (e.g. Accept).
  it('honors caller-supplied custom headers without dropping defaults', async () => {
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response)

    await apiFetch('/api/x', {
      headers: { 'X-Custom': 'kao' },
    })

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const init = callArgs?.[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['X-Custom']).toBe('kao')
    expect(headers['Content-Type']).toBe('application/json')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 3. Token storage helpers — round-trip + idempotent clear.
// ────────────────────────────────────────────────────────────────────────────

describe('Token storage helpers', () => {
  beforeEach(() => clearStoredToken())
  afterEach(() => clearStoredToken())

  // КАО#Full-A2 — set/get/clear contract.
  it('round-trips set -> get', () => {
    setStoredToken('jwt-abc')
    expect(getStoredToken()).toBe('jwt-abc')
  })

  it('returns null when nothing is stored', () => {
    expect(getStoredToken()).toBeNull()
  })

  it('clear is idempotent (no error when token absent)', () => {
    clearStoredToken()
    clearStoredToken()
    expect(getStoredToken()).toBeNull()
  })

  it('setStoredToken overwrites existing token', () => {
    setStoredToken('first')
    setStoredToken('second')
    expect(getStoredToken()).toBe('second')
  })
})
