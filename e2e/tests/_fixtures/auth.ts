/**
 * Shared auth fixture for Wave 4 KAO testers.
 *
 * Injects the JWT into localStorage BEFORE any page script runs, so the
 * AuthStore picks it up on its initial `loadFromStorage()` call and the
 * page renders authenticated.
 *
 * Usage:
 *   import { authedTest as test, requireAuth } from './_fixtures/auth'
 *   test.beforeEach(async ({ page }) => { await requireAuth(page) })
 *   test('...', async ({ page }) => { await page.goto('/sessions') })
 */
import { test as base, expect, type Page, type BrowserContext } from '@playwright/test'

export const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN ?? ''
export const TEST_SESSION_ID = process.env.E2E_TEST_SESSION_ID ?? ''
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3300'

/** Authenticate the browser context BEFORE any page script runs.
 *
 * КАО#SG1-selfxss — the JWT now rides an httpOnly `codeforge_session` cookie
 * (no longer localStorage). Playwright can set httpOnly cookies at the protocol
 * level, so we add the cookie to the context (it then accompanies every request
 * and the WS handshake). We also set the non-sensitive `codeforge_authed` hint
 * flag so the SPA validates the session on startup instead of treating the user
 * as anonymous.
 */
export async function injectAuth(context: BrowserContext): Promise<void> {
  if (!AUTH_TOKEN) return
  const url = new URL(BASE_URL)
  await context.addCookies([
    {
      name: 'codeforge_session',
      value: AUTH_TOKEN,
      domain: url.hostname,
      path: '/',
      httpOnly: true,
      sameSite: 'Lax',
      secure: url.protocol === 'https:',
    },
  ])
  await context.addInitScript(
    ({ baseUrl }) => {
      try {
        // Non-sensitive hint so AuthStore.loadFromStorage() validates the
        // session (the JWT itself is in the httpOnly cookie, not here).
        localStorage.setItem('codeforge_authed', '1')
        ;(window as unknown as { __cf_e2e_base?: string }).__cf_e2e_base = baseUrl
      } catch {
        /* localStorage may be restricted; tests will fail anyway */
      }
    },
    { baseUrl: BASE_URL }
  )
}

/** Skip test if AUTH_TOKEN is missing. */
export function requireAuth(): boolean {
  return Boolean(AUTH_TOKEN)
}

/** Skip test if a TEST_SESSION_ID is required and missing. */
export function requireSession(): boolean {
  return Boolean(TEST_SESSION_ID)
}

/**
 * Playwright test with `authed` extended to inject the token on every page
 * launched in this fixture. Use in place of vanilla `test` from `@playwright/test`.
 */
export const authedTest = base.extend<{ authed: void }>({
  authed: [
    async ({ context }, use) => {
      await injectAuth(context)
      await use()
    },
    { auto: true },
  ],
})

export { expect, type Page }
