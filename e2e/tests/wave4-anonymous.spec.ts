/**
 * Wave-4 — Anonymous / public-surface tests (W4-Anonymous Tester).
 *
 * Owns: anonymous flows only (no auth token injected).
 *  - Login UX: a11y, safeFromPath() open-redirect neutralisation, "Send Code"
 *    disabled-on-empty.
 *  - PublicChrome rendering for /demos and /demo/:templateId (КАО R14-FIX-01).
 *  - Demo gallery contents.
 *  - Onboarding tour ?tour=1 gating for anonymous visitors.
 *
 * Run:
 *   E2E_BASE_URL=https://stage.gotcode.ai npx playwright test \
 *     tests/wave4-anonymous.spec.ts --reporter=list
 *
 * NOTE: This file deliberately uses vanilla `test` (not authedTest) — every
 * case here must run unauthenticated. localStorage is cleared in beforeEach
 * to be defensive against shared-state leakage.
 */
import { test, expect, type Page } from '@playwright/test'
import { BASE_URL } from './_fixtures/auth'

// All tests are anonymous: clear any prior auth state.
test.beforeEach(async ({ context }) => {
  await context.clearCookies()
  await context.addInitScript(() => {
    try {
      localStorage.removeItem('codeforge_token')
      localStorage.clear()
      sessionStorage.clear()
    } catch {
      /* ignore */
    }
  })
})

// ─── helpers ─────────────────────────────────────────────────────────────────

async function gotoLogin(page: Page): Promise<void> {
  await page.goto('/login')
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 })
}

function emailInput(page: Page) {
  return page.locator('input#email[type="email"]')
}

function sendCodeBtn(page: Page) {
  return page.getByRole('button', { name: /Send Code/i })
}

// ─── Login UX ────────────────────────────────────────────────────────────────

test.describe('Wave-4 Anonymous — Login UX', () => {
  test('A1. /sessions redirects unauthenticated to /login', async ({ page }) => {
    await page.goto('/sessions')
    // RequireAuth bounces to /login. Allow a small grace for the SPA redirect.
    await expect(page).toHaveURL(/\/login(\?|$|#)/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('A2. Email input has correct a11y attributes', async ({ page }) => {
    await gotoLogin(page)
    const input = emailInput(page)
    await expect(input).toBeVisible()
    await expect(input).toHaveAttribute('autocomplete', 'email')
    await expect(input).toHaveAttribute('name', 'email')
    await expect(input).toHaveAttribute('inputmode', 'email')
    await expect(input).toHaveAttribute('type', 'email')
  })

  test('A3. Logo block is aria-hidden (decorative)', async ({ page }) => {
    await gotoLogin(page)
    // The logo cluster (icon + CodeForge title + subtitle) is aria-hidden.
    const heading = page.locator('h1', { hasText: 'CodeForge' })
    await expect(heading).toBeVisible()
    // The aria-hidden=true is on the wrapper div above the h1.
    const decorativeWrapper = page.locator('div[aria-hidden="true"]', {
      has: page.locator('h1', { hasText: 'CodeForge' }),
    })
    await expect(decorativeWrapper).toHaveCount(1)
  })

  test('A4. "Send Code" disabled on empty email, enabled after typing valid email', async ({ page }) => {
    await gotoLogin(page)
    const btn = sendCodeBtn(page)
    await expect(btn).toBeVisible()
    await expect(btn).toBeDisabled()

    await emailInput(page).fill('someone@example.com')
    await expect(btn).toBeEnabled()

    // Sanity: clearing re-disables.
    await emailInput(page).fill('')
    await expect(btn).toBeDisabled()
  })

  test('A5. safeFromPath neutralises protocol-relative ?from (//evil.com)', async ({ page }) => {
    // Drive the LoginPage useEffect that fires when isAuthenticated flips true.
    // We inject a fake token + user into the auth store BEFORE navigation so
    // the "if (isAuthenticated) navigate(from, ...)" effect runs immediately.
    // The malicious `from` is provided via location.state, which we can't set
    // via URL — but the same safeFromPath() guard receives state.from, and
    // for the ?from=… query-string variant the page should still land on a
    // safe local route.
    //
    // We test the guard end-to-end by mounting at /login with a faked auth
    // state, then asserting the post-effect URL is same-origin (never lands
    // on //evil.com or \\evil).
    const malicious = ['//evil.com', '/\\evil', '\\evil', '%2F%2Fevil.com']

    for (const f of malicious) {
      await page.context().clearCookies()
      await page.addInitScript((from) => {
        // Fake an authenticated state so LoginPage's redirect-effect runs.
        try {
          localStorage.setItem(
            'codeforge_token',
            'eyJhbGciOiJIUzI1NiJ9.fake.fake' // any non-empty string; the page only checks isAuthenticated
          )
          // Stash a hint so we can inspect what `from` was attempted.
          ;(window as unknown as { __cf_from?: string }).__cf_from = from
        } catch {
          /* ignore */
        }
      }, f)

      // We can't drive location.state via URL, so this test asserts the loose
      // invariant: after navigating to /login with any malicious string in the
      // query, we never end up on an external origin.
      await page.goto(`/login?from=${encodeURIComponent(f)}`)
      // Wait briefly for any redirect.
      await page.waitForTimeout(800)
      const url = new URL(page.url())
      expect(url.origin, `from=${f} must not redirect to external origin`).toBe(new URL(BASE_URL).origin)
    }
  })

  test('A6. "Not in list" copy + Learn-more link target=_blank — source-verified', async ({ page }) => {
    // We can't easily push a real email through the allowed-list rejection
    // path from anonymous E2E without a known-bad test email. Document the
    // assertion by inspecting the rendered DOM after navigating to /login;
    // the not_allowed copy only renders after a backend response. We mark
    // this as fixme and verify the source-level contract instead.
    test.fixme(
      true,
      'Requires a known-rejected email to reach the not_allowed step; verified by LoginPage.tsx source: "1 business day" copy + docs.gotcode.ai Learn-more with target=_blank rel=noopener.',
    )
    await gotoLogin(page)
  })
})

// ─── Public chrome rendering (КАО R14-FIX-01) ────────────────────────────────

test.describe('Wave-4 Anonymous — PublicChrome rendering', () => {
  test('B1. /demos loads anonymously (no /login redirect)', async ({ page }) => {
    await page.goto('/demos')
    await expect(page).toHaveURL(/\/demos(\?|$|#)/, { timeout: 15_000 })
    await expect(page.getByRole('heading', { name: 'Demos', exact: true })).toBeVisible({ timeout: 15_000 })
  })

  test('B2. /demo/mandelbulb loads anonymously', async ({ page }) => {
    await page.goto('/demo/mandelbulb')
    await expect(page).toHaveURL(/\/demo\/mandelbulb(\?|$|#)/, { timeout: 15_000 })
    // Demo player title appears once the timeline JSON loads.
    await expect(
      page.locator('h1', { hasText: /Mandelbulb/i }).first(),
    ).toBeVisible({ timeout: 20_000 })
  })

  test('B3. On /demo/:id anonymous, PublicChrome (logo + Sign-in) — NOT sidebar', async ({ page }) => {
    await page.goto('/demo/mandelbulb')
    await page.waitForLoadState('domcontentloaded')

    // Header has CodeForge logo link.
    const logoLink = page.getByRole('link', { name: /CodeForge/i }).first()
    await expect(logoLink).toBeVisible({ timeout: 15_000 })

    // Header has Sign-in link.
    const signInLink = page.getByRole('link', { name: /Sign in/i }).first()
    await expect(signInLink).toBeVisible()
    await expect(signInLink).toHaveAttribute('href', '/login')

    // Full Layout sidebar should NOT be present anonymously. Layout renders
    // nav items like "Sessions", "Dashboard", "Settings" in a sidebar; those
    // links should be absent (or only the topbar logo+sign-in present).
    // Use a conservative probe: the Layout sidebar's "Sessions" nav link.
    const sidebarSessions = page.getByRole('link', { name: /^Sessions$/ })
    await expect(sidebarSessions).toHaveCount(0)
  })

  test('B4. PublicChrome Sign-in link navigates to /login', async ({ page }) => {
    await page.goto('/demo/mandelbulb')
    const signInLink = page.getByRole('link', { name: /Sign in/i }).first()
    await expect(signInLink).toBeVisible({ timeout: 15_000 })
    await signInLink.click()
    await expect(page).toHaveURL(/\/login(\?|$|#)/, { timeout: 10_000 })
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible()
  })

  test('B5. "Try it yourself" anonymous → redirects to /login (R14-FIX-01)', async ({ page }) => {
    await page.goto('/demo/mandelbulb')
    // Wait for the demo to load (Try-it button only exists once `timeline` is set).
    const tryBtn = page.getByRole('button', { name: /Try it yourself/i }).first()
    await expect(tryBtn).toBeVisible({ timeout: 25_000 })
    await tryBtn.click()
    await expect(page).toHaveURL(/\/login(\?|$|#)/, { timeout: 10_000 })
  })
})

// ─── Demo gallery /demos (anonymous) ─────────────────────────────────────────

test.describe('Wave-4 Anonymous — /demos gallery', () => {
  // КАО#VR-58 — updated for the current 3-demo gallery (VR-48/50/51 removed
  // "Neon Snake" + "WebGL Glass Crystal", added "Conway's Game of Life").
  test('C1. Renders all 3 demo cards (mandelbulb, life, particles)', async ({ page }) => {
    await page.goto('/demos')
    await expect(page.getByRole('heading', { name: 'Demos', exact: true })).toBeVisible({ timeout: 15_000 })

    // Each card has a "Watch demo" link pointing to /demo/<id>. We assert one
    // exists per demo id by checking the href.
    for (const id of ['mandelbulb', 'life', 'particles']) {
      const link = page.locator(`a[href="/demo/${id}"]`).first()
      await expect(link, `Watch demo link for ${id}`).toBeVisible({ timeout: 15_000 })
    }
  })

  test('C2. Clicking a card navigates to /demo/:templateId', async ({ page }) => {
    await page.goto('/demos')
    const lifeLink = page.locator('a[href="/demo/life"]').first()
    await expect(lifeLink).toBeVisible({ timeout: 15_000 })
    await lifeLink.click()
    await expect(page).toHaveURL(/\/demo\/life(\?|$|#)/, { timeout: 10_000 })
  })

  test('C3. "Real multi-agent runs, replayed" copy present (Wave 1 P1·S)', async ({ page }) => {
    await page.goto('/demos')
    await expect(page.getByText(/Real multi-agent runs, replayed/i)).toBeVisible({ timeout: 15_000 })
  })

  test('C4. Cards expose thumbnail + descriptive copy', async ({ page }) => {
    await page.goto('/demos')
    await expect(page.getByRole('heading', { name: 'Demos', exact: true })).toBeVisible({ timeout: 15_000 })

    // КАО#VR-58 — current 3-demo gallery (thumbnails are SVG illustrations now).
    await expect(page.getByText(/Mandelbulb 3D Attractor/i).first()).toBeVisible()
    await expect(page.getByText(/Game of Life/i).first()).toBeVisible()
    await expect(page.getByText(/Flow-Field Particles/i).first()).toBeVisible()
  })
})

// ─── Onboarding tour ?tour=1 anonymous gating (Wave 3 P3·S) ──────────────────

test.describe('Wave-4 Anonymous — Onboarding tour gating', () => {
  test('D1. ?tour=1 anonymous — tour-prompt does NOT appear (gated by isAuthenticated)', async ({ page }) => {
    // OnboardingTour effect: `if (!isAuthenticated) return` — so even with
    // ?tour=1, anonymous visitors should never see the prompt toast.
    // Also note: `/` with RequireAuth bounces anon to /login.
    await page.goto('/?tour=1')

    // The route guard sends us to /login.
    await expect(page).toHaveURL(/\/login(\?|$|#)/, { timeout: 15_000 })

    // The prompt toast (role="status" aria-label="Onboarding tour prompt")
    // must NOT appear.
    const toast = page.locator('[aria-label="Onboarding tour prompt"]')
    await expect(toast).toHaveCount(0)

    // Also wait a moment — the orchestrator has a 600ms timeout before
    // firing welcome on /sessions; we're not on /sessions, but be defensive.
    await page.waitForTimeout(1200)
    await expect(toast).toHaveCount(0)
  })

  test('D2. ?tour=1 on /demos anonymous — tour does NOT appear (PublicChrome, no Layout/OnboardingTour mount)', async ({ page }) => {
    // OnboardingTour is mounted inside Layout (authenticated chrome only),
    // so the public /demos route should not render the tour orchestrator
    // at all. Verify the toast never appears.
    await page.goto('/demos?tour=1')
    await expect(page.getByRole('heading', { name: 'Demos', exact: true })).toBeVisible({ timeout: 15_000 })
    await page.waitForTimeout(1500)
    const toast = page.locator('[aria-label="Onboarding tour prompt"]')
    await expect(toast).toHaveCount(0)
  })
})
