import { test, expect } from '@playwright/test'

/**
 * Round 14 — Team 1 (Test-Writer): Auth & Onboarding wave 1–3 specs.
 *
 * Anonymous-route tests for the /login surface. Each test stands alone — no
 * shared state. Tests that need a real backend round-trip to reach the OTP
 * step are marked `test.fixme` since stage's allowed-list and email infra
 * cannot be exercised reliably from an anonymous Playwright run.
 *
 * Expected status: SOME OF THESE TESTS WILL FAIL — those failures are the
 * bugs Team 2 / Team 3 are tasked to triage and fix downstream.
 */

test.describe('Wave 3 — LoginPage email step a11y', () => {
  test('email input has required a11y + autofill attributes', async ({ page }) => {
    await page.goto('/login')

    const email = page.locator('input#email')
    await expect(email).toBeVisible()
    await expect(email).toHaveAttribute('autocomplete', 'email')
    await expect(email).toHaveAttribute('name', 'email')
    await expect(email).toHaveAttribute('type', 'email')
    await expect(email).toHaveAttribute('inputmode', 'email')
  })
})

test.describe('Wave 3 — LoginPage logo a11y', () => {
  test('decorative logo container has aria-hidden="true"', async ({ page }) => {
    await page.goto('/login')

    // The decorative logo block wraps the Code2 SVG icon. Per
    // LoginPage.tsx (Улучшатели#1 P3·S), the outer flex container that
    // hosts both the Code2 icon and the CodeForge title is the aria-hidden
    // region. Find via the CodeForge title and walk up to the aria-hidden
    // ancestor.
    const ariaHidden = page.locator('[aria-hidden="true"]').filter({ hasText: 'CodeForge' })
    await expect(ariaHidden).toBeVisible()

    // Sanity-check: the SVG icon lives inside the aria-hidden block.
    await expect(ariaHidden.locator('svg').first()).toBeAttached()
  })
})

test.describe('Wave 3 — Open-redirect safety on from-path', () => {
  test('no protocol-relative anchor smuggled onto /login DOM', async ({ page }) => {
    await page.goto('/login')

    // The from-path sanitiser lives in client code; we cannot drive
    // location.state directly through page.goto. Best we can do anonymously
    // is assert that no anchor with a protocol-relative href ("//evil.com")
    // has been emitted onto the login page DOM as a side-effect of routing.
    const badAnchors = page.locator('a[href^="//"]')
    await expect(badAnchors).toHaveCount(0)
  })

  test('safeFromPath rejects "//evil.com" via location.state — client-side helper', async ({ page }) => {
    // We push history state via history.replaceState before any navigation
    // occurs, then verify the visible login UI rendered (i.e., we did not
    // get redirected off-origin). This is a smoke test: a real redirect to
    // "//evil.com" would either error or leave-origin; safeFromPath must
    // keep us on /login.
    await page.goto('/login')
    await page.evaluate(() => {
      // Inject the malicious from in history state; React Router reads this
      // via useLocation().state.
      history.replaceState({ from: '//evil.com' }, '', '/login')
    })
    // Reload so router picks up the manufactured state.
    await page.reload()

    // We should still be on /login and the email input must be visible.
    expect(page.url()).toContain('/login')
    await expect(page.locator('input#email')).toBeVisible()
  })
})

test.describe('Wave 3 — OTP step a11y (needs reachable OTP step)', () => {
  // Reaching the OTP step requires the backend to accept the email + send a
  // code. On stage that means going through the allowed-list + mail provider
  // round-trip, which cannot be faked from an anonymous test. We attempt to
  // reach it via a configured E2E_TEST_EMAIL env var; otherwise we mark the
  // tests as fixme so they show up in the report but do not flake.
  const testEmail = process.env.E2E_TEST_EMAIL

  test('first OTP input has autoComplete="one-time-code"', async ({ page }) => {
    test.fixme(!testEmail, 'needs test backend / E2E_TEST_EMAIL to reach OTP step')

    await page.goto('/login')
    await page.locator('input#email').fill(testEmail!)
    await page.getByRole('button', { name: /send code/i }).click()

    const firstDigit = page.getByRole('textbox', { name: 'Digit 1 of 6' })
    await expect(firstDigit).toBeVisible({ timeout: 10_000 })
    await expect(firstDigit).toHaveAttribute('autocomplete', 'one-time-code')
  })

  test('all 6 OTP inputs have aria-label "Digit N of 6"', async ({ page }) => {
    test.fixme(!testEmail, 'needs test backend / E2E_TEST_EMAIL to reach OTP step')

    await page.goto('/login')
    await page.locator('input#email').fill(testEmail!)
    await page.getByRole('button', { name: /send code/i }).click()

    for (let i = 1; i <= 6; i++) {
      const input = page.getByRole('textbox', { name: `Digit ${i} of 6` })
      await expect(input).toBeVisible({ timeout: 10_000 })
    }
  })

  test('all 6 OTP inputs have inputMode="numeric" and pattern="[0-9]*"', async ({ page }) => {
    test.fixme(!testEmail, 'needs test backend / E2E_TEST_EMAIL to reach OTP step')

    await page.goto('/login')
    await page.locator('input#email').fill(testEmail!)
    await page.getByRole('button', { name: /send code/i }).click()

    for (let i = 1; i <= 6; i++) {
      const input = page.getByRole('textbox', { name: `Digit ${i} of 6` })
      await expect(input).toHaveAttribute('inputmode', 'numeric')
      await expect(input).toHaveAttribute('pattern', '[0-9]*')
    }
  })

  test('all 6 OTP boxes render at ~48px height (h-12 fix, not broken h-13)', async ({ page }) => {
    test.fixme(!testEmail, 'needs test backend / E2E_TEST_EMAIL to reach OTP step')

    await page.goto('/login')
    await page.locator('input#email').fill(testEmail!)
    await page.getByRole('button', { name: /send code/i }).click()

    for (let i = 1; i <= 6; i++) {
      const input = page.getByRole('textbox', { name: `Digit ${i} of 6` })
      await expect(input).toBeVisible({ timeout: 10_000 })
      const box = await input.boundingBox()
      expect(box).not.toBeNull()
      // h-12 = 3rem = 48px. Allow generous +/- 4px for browser rounding /
      // possible 1px borders. h-13 (the broken Tailwind value) would render
      // as the browser default ~21–24px, so any reasonable measurement
      // above ~40px confirms the fix.
      expect(box!.height).toBeGreaterThanOrEqual(44)
      expect(box!.height).toBeLessThanOrEqual(56)
    }
  })

  test('Resend button shows cooldown copy "Resend in Ns" and is disabled', async ({ page }) => {
    test.fixme(!testEmail, 'needs test backend / E2E_TEST_EMAIL to reach OTP step')

    await page.goto('/login')
    await page.locator('input#email').fill(testEmail!)
    await page.getByRole('button', { name: /send code/i }).click()

    // After OTP request succeeds, the Resend button is rendered on the code
    // step. Cooldown is initialised to 60s in client code.
    const resend = page.getByRole('button', { name: /Resend in \d+s/ })
    await expect(resend).toBeVisible({ timeout: 10_000 })
    await expect(resend).toBeDisabled()
  })
})

test.describe('Wave 3 — Allowed-list (not_allowed) step copy', () => {
  // The not_allowed branch fires only when the backend returns
  // { not_allowed: true } for a non-allowed email. We need an env var
  // pointing at an email known to NOT be on the allowed list.
  const notAllowedEmail = process.env.E2E_NOT_ALLOWED_EMAIL

  test('not_allowed step shows 1 business day copy + Learn more (target=_blank)', async ({ page }) => {
    test.fixme(
      !notAllowedEmail,
      'needs test backend / E2E_NOT_ALLOWED_EMAIL set to an email known not to be on the allowed list',
    )

    await page.goto('/login')
    await page.locator('input#email').fill(notAllowedEmail!)
    await page.getByRole('button', { name: /send code/i }).click()

    await expect(page.getByText(/Access restricted/i)).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText(/1 business day/i)).toBeVisible()

    const learnMore = page.getByRole('link', { name: /learn more/i })
    await expect(learnMore).toBeVisible()
    await expect(learnMore).toHaveAttribute('target', '_blank')
    // Defence-in-depth — opener safety should also be present.
    await expect(learnMore).toHaveAttribute('rel', /noopener/)
  })
})
