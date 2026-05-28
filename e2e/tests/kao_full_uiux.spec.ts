// КАО#Full-A1 — Full UI/UX coverage E2E (writers subteam)
//
// Purpose
// =======
// Cross-page smoke / interaction harness. For every major route we assert:
//   1. The page loads with no uncaught pageerror.
//   2. The page emits no console.error after settle.
//   3. The primary headline / landmark renders.
//   4. Key buttons & links are visible AND not occluded (bounding-box hit-test).
//   5. The layout doesn't break at desktop (1280x720) and tablet (768x1024).
//
// Mutation discipline
// -------------------
// READ-ONLY. No sessions are created, no templates deleted, no settings written.
// All interactions are limited to navigation, hover, and harmless toggles.
//
// Requires:
//   E2E_BASE_URL=https://stage.gotcode.ai
//   E2E_AUTH_TOKEN=<JWT>           (skip auth-gated paths if missing)
//   stage backend up + frontend bundle served
//
// Run:
//   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
//     npx playwright test tests/kao_full_uiux.spec.ts --reporter=list

import { authedTest as test, expect, type Page } from './_fixtures/auth'

const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN ?? ''

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

interface PageErrorCollector {
  pageErrors: Error[]
  consoleErrors: string[]
}

/**
 * Attach error collectors BEFORE navigation so we don't miss boot-time errors.
 * Returns an object whose arrays mutate as errors fire — read them after the
 * page settles. We filter out known-noisy console messages (404 fetches on
 * optional endpoints, ResizeObserver loops) so tests stay deterministic.
 */
function collectErrors(page: Page): PageErrorCollector {
  const pageErrors: Error[] = []
  const consoleErrors: string[] = []

  page.on('pageerror', (err) => {
    pageErrors.push(err)
  })

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return
    const text = msg.text()
    // КАО#Full-A1 — ignore well-known benign console.error sources.
    // ResizeObserver loop is a chromium quirk, not a real bug.
    if (/ResizeObserver loop/i.test(text)) return
    // Fetch failures for optional endpoints (telemetry, analytics) are noisy
    // but non-fatal — they don't mean the UI is broken.
    if (/Failed to load resource.*\b(telemetry|analytics|sentry)\b/i.test(text)) return
    // React DevTools recommendation banner (production builds in dev mode).
    if (/Download the React DevTools/i.test(text)) return
    consoleErrors.push(text)
  })

  return { pageErrors, consoleErrors }
}

/** Wait for body to be visible and the JS bundle to have settled. */
async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.locator('body')).toBeVisible()
  // networkidle is racy on a SPA with websockets — cap it.
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {})
}

/**
 * Hit-test a locator: confirm it's visible AND its center pixel actually
 * belongs to it (or a child). Catches CSS-overlap bugs where a transparent
 * div eats clicks.
 */
async function expectClickable(page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box, 'locator must have a bounding box').not.toBeNull()
  if (!box) return
  // Read the element at the center point. elementFromPoint returns the
  // top-most element — assert it's the target or a descendant.
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const overlapHandle = await page.evaluateHandle(
    (p) => document.elementFromPoint(p.x, p.y),
    center
  )
  const targetHandle = await locator.elementHandle()
  if (!targetHandle) throw new Error('Locator resolved no element')
  const overlapsTarget = await page.evaluate(
    ([overlap, target]) => {
      if (!overlap || !target) return false
      return target.contains(overlap as Node) || (overlap as Node).contains(target)
    },
    [overlapHandle, targetHandle] as const
  )
  expect(overlapsTarget, 'center pixel must belong to the locator (no overlay)').toBe(true)
}

// ────────────────────────────────────────────────────────────────────────────
// Viewports
// ────────────────────────────────────────────────────────────────────────────

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'tablet', width: 768, height: 1024 },
] as const

// ────────────────────────────────────────────────────────────────────────────
// /login (public route — no auth required)
// ────────────────────────────────────────────────────────────────────────────

test.describe('Full-A1 · /login (public)', () => {
  // КАО#Full-C-1 Q2 — Public-route tests occasionally hit ERR_NETWORK_CHANGED
  // when the stage host's TLS handshake races with our DNS prefetch from a
  // previous test. Two automatic retries pin the flake without masking real
  // failures (deterministic bugs still fail on every retry).
  test.describe.configure({ retries: 2 })

  // KAO#Full-C-2 M3 — `authedTest` injects E2E_AUTH_TOKEN via addInitScript on
  // EVERY page in this fixture. For the /login describe we need to verify the
  // public form renders for an UNAUTHENTICATED visitor. Clearing the storage
  // synchronously after first navigation (and disabling the persisted JWT in
  // localStorage / sessionStorage) reverts to an anonymous session without
  // forking the file into two fixtures.
  test.beforeEach(async ({ page, context }) => {
    await context.clearCookies()
    await context.addInitScript(() => {
      try {
        localStorage.removeItem('codeforge_token')
        sessionStorage.clear()
      } catch {
        /* storage may be inaccessible in some contexts */
      }
    })
  })

  for (const vp of VIEWPORTS) {
    test(`renders cleanly @ ${vp.name} (${vp.width}x${vp.height})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      const errs = collectErrors(page)
      await page.goto('/login')
      await waitForAppReady(page)

      // КАО#Full-A1 — email input is the load-bearing primary CTA on /login.
      const email = page.locator('input[name="email"]')
      await expect(email).toBeVisible()
      await expectClickable(page, email)

      // No fatal errors during boot.
      expect(errs.pageErrors, `pageerror[]: ${errs.pageErrors.map(e => e.message).join('\n')}`).toEqual([])
      expect(errs.consoleErrors, `console.error[]: ${errs.consoleErrors.join('\n')}`).toEqual([])
    })
  }

  test('email form accepts input and Continue button is reachable', async ({ page }) => {
    await page.goto('/login')
    await waitForAppReady(page)
    const email = page.locator('input[name="email"]')
    await email.fill('not-a-real-user@example.invalid')
    await expect(email).toHaveValue('not-a-real-user@example.invalid')
    // A submit-style button must exist (Continue / Send code / etc.).
    const submitBtn = page
      .getByRole('button', { name: /continue|send code|sign in|next/i })
      .first()
    await expect(submitBtn).toBeVisible()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// /sessions (list)
// ────────────────────────────────────────────────────────────────────────────

test.describe('Full-A1 · /sessions list', () => {
  test.beforeEach(() => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
  })

  for (const vp of VIEWPORTS) {
    test(`renders cleanly @ ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      const errs = collectErrors(page)
      await page.goto('/sessions')
      await waitForAppReady(page)

      await expect(page.getByRole('heading', { name: /^sessions$/i })).toBeVisible()

      // Sidebar landmark must be present (Layout).
      await expect(page.getByRole('navigation', { name: /main|primary/i }).first()).toBeVisible()

      expect(errs.pageErrors, `pageerror[]: ${errs.pageErrors.map(e => e.message).join('\n')}`).toEqual([])
      expect(errs.consoleErrors).toEqual([])
    })
  }

  test('search input is interactive and not overlapped', async ({ page }) => {
    await page.goto('/sessions')
    await waitForAppReady(page)
    const search = page.getByRole('textbox', { name: /search sessions by name/i }).or(
      page.locator('input[aria-label="Search sessions by name"]')
    )
    // Search input only renders if there are sessions, so allow skip.
    if (!(await search.first().isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'No sessions for this account, search input not rendered')
      return
    }
    await expectClickable(page, search.first())
  })

  test('clicking the first session card navigates to detail', async ({ page }) => {
    await page.goto('/sessions')
    await waitForAppReady(page)
    // Each row is wrapped in a Link to /sessions/<id>; we navigate via the first.
    const firstSessionLink = page.locator('a[href^="/sessions/"]').filter({
      hasNot: page.locator('[href="/sessions/new"]'),
    }).first()
    if (!(await firstSessionLink.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'No sessions to click into')
      return
    }
    await firstSessionLink.click()
    await expect(page).toHaveURL(/\/sessions\/[A-Za-z0-9_-]+$/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// /sessions/new
// ────────────────────────────────────────────────────────────────────────────

test.describe('Full-A1 · /sessions/new', () => {
  test.beforeEach(() => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
  })

  for (const vp of VIEWPORTS) {
    test(`renders cleanly @ ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      const errs = collectErrors(page)
      await page.goto('/sessions/new')
      await waitForAppReady(page)

      await expect(page.getByRole('heading', { name: /^new session$/i })).toBeVisible()

      // Specification textarea must be present.
      const spec = page.locator('textarea').first()
      await expect(spec).toBeVisible()
      await expectClickable(page, spec)

      expect(errs.pageErrors).toEqual([])
      expect(errs.consoleErrors).toEqual([])
    })
  }

  test('spec textarea accepts input', async ({ page }) => {
    await page.goto('/sessions/new')
    await waitForAppReady(page)
    const spec = page.locator('textarea').first()
    await spec.fill('A small toy: add two numbers via CLI.')
    await expect(spec).toHaveValue(/add two numbers/i)
  })

  test('language switcher / dropdown is reachable', async ({ page }) => {
    await page.goto('/sessions/new')
    await waitForAppReady(page)
    // Match any visible <select> or button with "language" / "python" hints.
    const langCandidate = page
      .locator('select, [role="combobox"], [role="button"]')
      .filter({ hasText: /python|javascript|typescript|language/i })
      .first()
    if (!(await langCandidate.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, 'Language switcher not present on this build')
      return
    }
    await expect(langCandidate).toBeVisible()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// /sessions/:id (detail)
// ────────────────────────────────────────────────────────────────────────────

test.describe('Full-A1 · /sessions/:id detail', () => {
  test.beforeEach(() => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
  })

  async function openFirstSession(page: Page): Promise<boolean> {
    await page.goto('/sessions')
    await waitForAppReady(page)
    const firstSessionLink = page.locator('a[href^="/sessions/"]').filter({
      hasNot: page.locator('[href="/sessions/new"]'),
    }).first()
    if (!(await firstSessionLink.isVisible({ timeout: 3000 }).catch(() => false))) {
      return false
    }
    await firstSessionLink.click()
    await expect(page).toHaveURL(/\/sessions\/[A-Za-z0-9_-]+$/)
    return true
  }

  for (const vp of VIEWPORTS) {
    test(`renders cleanly @ ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      const errs = collectErrors(page)
      const opened = await openFirstSession(page)
      if (!opened) {
        test.skip(true, 'No sessions to open')
        return
      }
      await waitForAppReady(page)

      // Session header (name as <h1>) must render.
      await expect(page.locator('h1').first()).toBeVisible()

      expect(errs.pageErrors).toEqual([])
      expect(errs.consoleErrors).toEqual([])
    })
  }
})

// ────────────────────────────────────────────────────────────────────────────
// /settings & /dashboard quick smoke
// ────────────────────────────────────────────────────────────────────────────

test.describe('Full-A1 · /settings + /dashboard smoke', () => {
  test.beforeEach(() => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
  })

  for (const path of ['/settings', '/dashboard'] as const) {
    test(`${path} loads without errors`, async ({ page }) => {
      const errs = collectErrors(page)
      await page.goto(path)
      await waitForAppReady(page)
      // The first <h1> on the page must render (page is non-blank).
      await expect(page.locator('h1').first()).toBeVisible()
      expect(errs.pageErrors).toEqual([])
      expect(errs.consoleErrors).toEqual([])
    })
  }
})
