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

/** Inject the JWT into localStorage BEFORE any page script runs. */
export async function injectAuth(context: BrowserContext): Promise<void> {
  if (!AUTH_TOKEN) return
  // matches AUTH_TOKEN_KEY = 'codeforge_token' in frontend/src/services/api.ts
  await context.addInitScript(
    ({ token, baseUrl }) => {
      try {
        localStorage.setItem('codeforge_token', token)
        // Also stash the base URL hint so any debug logs are unambiguous.
        ;(window as unknown as { __cf_e2e_base?: string }).__cf_e2e_base = baseUrl
      } catch {
        /* localStorage may be restricted; tests will fail anyway */
      }
    },
    { token: AUTH_TOKEN, baseUrl: BASE_URL }
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
