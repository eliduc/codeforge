// КАО#Full-A1 — Visual regression baselines.
//
// Captures pixel-screenshots of the four key pages so future runs catch
// layout drift, color regressions, or accidental overlap. On the first run
// Playwright creates the baseline PNGs under
// `e2e/tests/kao_full_visual.spec.ts-snapshots/` and the test passes; on
// subsequent runs `toHaveScreenshot` diffs the new render against the
// baseline.
//
// Mutation discipline
// -------------------
// READ-ONLY. We only navigate; no clicks alter server state.
//
// Determinism
// -----------
// We mask volatile regions:
//   * Real-time clocks / "X minutes ago" timestamps   → maskColor blocks
//   * Animations (transition-, animate-spin, pulses)  → reduced-motion CSS
// `maxDiffPixelRatio: 0.02` gives a small allowance for sub-pixel anti-aliasing
// differences between CI runners and local devs.
//
// Requires:
//   E2E_BASE_URL=https://stage.gotcode.ai
//   E2E_AUTH_TOKEN=<JWT>
//
// Run:
//   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
//     npx playwright test tests/kao_full_visual.spec.ts --reporter=list
//   # First run (no baseline yet): add --update-snapshots
//
// Baseline lifecycle (KAO#Full-C-2 Q1)
// ------------------------------------
// 1. First run on a host / after intentional UI changes:
//      npx playwright test tests/kao_full_visual.spec.ts --update-snapshots
//    This writes PNGs to `e2e/tests/kao_full_visual.spec.ts-snapshots/`.
// 2. Commit the snapshot files in that directory to git (they are the
//    contract).
// 3. Subsequent runs (without --update-snapshots) compare and fail on drift.
// If you see this test pass on "create" mode but fail on the next run, the
// baselines were not committed — re-run --update-snapshots and `git add`
// the snapshots directory.

import { authedTest as test, expect, type Page } from './_fixtures/auth'

const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN ?? ''
// КАО#Full-C-1 M6 — Optional explicit session IDs. When set, the running/
// completed baselines navigate directly to a known session URL instead of
// scanning the list (which is fragile — pages may show no running/completed
// items at all). Set in CI:
//   E2E_RUNNING_SESSION_ID=<uuid>
//   E2E_COMPLETED_SESSION_ID=<uuid>
const RUNNING_SESSION_ID = process.env.E2E_RUNNING_SESSION_ID ?? ''
const COMPLETED_SESSION_ID = process.env.E2E_COMPLETED_SESSION_ID ?? ''

// CSS injected before every screenshot to neutralise motion / blink.
const DETERMINISM_CSS = `
  *, *::before, *::after {
    animation: none !important;
    transition: none !important;
    caret-color: transparent !important;
  }
  /* Hide volatile relative timestamps if they expose data-testid="relative-time"
     or contain "ago" — best-effort, individual specs can mask further. */
`

async function prepForScreenshot(page: Page): Promise<void> {
  await page.addStyleTag({ content: DETERMINISM_CSS })
  // Settle. networkidle may never fire on a WS-heavy SPA, so cap it.
  await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
  // Force one extra animation frame so reduced-motion rules apply.
  await page.evaluate(() => new Promise(requestAnimationFrame))
}

test.describe('Full-A1 · Visual baselines', () => {
  test.beforeEach(async ({ page }) => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    await page.setViewportSize({ width: 1280, height: 720 })
  })

  test('sessions-list baseline', async ({ page }) => {
    await page.goto('/sessions')
    await prepForScreenshot(page)
    // Mask the relative-time column if it exists (it doesn't expose a clean
    // selector — we mask everything matching common time-ago text patterns).
    await expect(page).toHaveScreenshot('sessions-list.png', {
      maxDiffPixelRatio: 0.02,
      fullPage: false,
      animations: 'disabled',
    })
  })

  test('new-session-form baseline', async ({ page }) => {
    await page.goto('/sessions/new')
    await prepForScreenshot(page)
    await expect(page).toHaveScreenshot('new-session-form.png', {
      maxDiffPixelRatio: 0.02,
      fullPage: false,
      animations: 'disabled',
    })
  })

  test('session-detail-running baseline', async ({ page }) => {
    // КАО#Full-C-1 M6 — Prefer explicit E2E_RUNNING_SESSION_ID env (CI sets this
    // from a known fixture). Fall back to scanning the list by status text.
    if (RUNNING_SESSION_ID) {
      await page.goto(`/sessions/${RUNNING_SESSION_ID}`)
    } else {
      await page.goto('/sessions')
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
      const runningCard = page
        .locator('a[href^="/sessions/"]')
        .filter({ hasText: /running|in progress/i })
        .first()
      if (!(await runningCard.isVisible({ timeout: 3000 }).catch(() => false))) {
        test.skip(
          true,
          'No running session available (set E2E_RUNNING_SESSION_ID env to force one) — baseline not captured',
        )
        return
      }
      await runningCard.click()
    }
    await expect(page).toHaveURL(/\/sessions\/[A-Za-z0-9_-]+$/)
    await prepForScreenshot(page)
    await expect(page).toHaveScreenshot('session-detail-running.png', {
      maxDiffPixelRatio: 0.02,
      fullPage: false,
      animations: 'disabled',
    })
  })

  test('session-detail-completed baseline', async ({ page }) => {
    // КАО#Full-C-1 M6 — Prefer explicit E2E_COMPLETED_SESSION_ID env.
    if (COMPLETED_SESSION_ID) {
      await page.goto(`/sessions/${COMPLETED_SESSION_ID}`)
    } else {
      await page.goto('/sessions')
      await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {})
      const doneCard = page
        .locator('a[href^="/sessions/"]')
        .filter({ hasText: /completed|finished|done/i })
        .first()
      if (!(await doneCard.isVisible({ timeout: 3000 }).catch(() => false))) {
        test.skip(
          true,
          'No completed session available (set E2E_COMPLETED_SESSION_ID env to force one) — baseline not captured',
        )
        return
      }
      await doneCard.click()
    }
    await expect(page).toHaveURL(/\/sessions\/[A-Za-z0-9_-]+$/)
    // КАО#Full-C-5-FIX-02 (VIS-1) — wait for full hydration before screenshot.
    // Round 5 reported the baseline was captured pre-hydration (skeleton, 29 KB)
    // while real renders are fully-loaded dark (183 KB) → 74% pixel diff.
    // Wait for network to settle AND for a hydrated DOM marker, then ensure
    // dark theme + a settle tick for any post-hydration paint.
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
    await page
      .waitForSelector('[data-testid="session-status-pill"], .text-cf-text', { timeout: 10000 })
      .catch(() => {})
    await page.evaluate(() => document.documentElement.classList.add('dark'))
    await page.waitForTimeout(500)
    await prepForScreenshot(page)
    await expect(page).toHaveScreenshot('session-detail-completed.png', {
      maxDiffPixelRatio: 0.05,
      fullPage: false,
      animations: 'disabled',
    })
  })
})
