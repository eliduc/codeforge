// W4-Dashboard Tester — КАО Wave-4 Dashboard surface tests.
//
// Verifies the Улучшатели#3 P2·S work on DashboardPage:
//   - humanized status pills via sessionLabels.humanizeStatus()
//   - pills rendered as <Link to="/sessions?status=<enum>"> (anchors)
//   - basic stat-card rendering and dashboard navigation
//
// Notes on the actual surface (DashboardPage.tsx) vs. the spec brief:
//   - The brief says "page loads at /" — actually `/` redirects to `/sessions`
//     and the Dashboard is mounted at `/dashboard`. We test `/dashboard`.
//   - The brief mentions "Total sessions" tile — the real surface has
//     Total Cost / Total Tokens / Requests / Avg Iterations.
//   - The brief mentions a Welcome / onboarding card and Recent sessions list —
//     neither exists on the current DashboardPage. Those tests are marked
//     `.fixme` with a documented reason rather than asserting fictional UI.
//
// Read-only: no mutations.
//
// Run:
//   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
//     npx playwright test tests/wave4-dashboard.spec.ts --reporter=list

import { authedTest as test, expect } from './_fixtures/auth'

const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN ?? ''

test.describe('Wave 4 — Dashboard', () => {
  test.beforeEach(async () => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 1) Page loads — authenticated user lands on Dashboard.
  //    Brief said "/" but the route is /dashboard ("/" -> redirect /sessions).
  // ─────────────────────────────────────────────────────────────────────────
  test('1. /dashboard loads for authenticated user', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page).toHaveURL(/\/dashboard(\?|$)/, { timeout: 15_000 })
    // The H1 with the BarChart3 icon + "Dashboard" text.
    await expect(page.getByRole('heading', { name: /Dashboard/i })).toBeVisible({
      timeout: 15_000,
    })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 2) Stats cards render. Real tiles: Total Cost / Total Tokens / Requests /
  //    Avg Iterations. The brief mentioned "Total sessions" — that tile does
  //    NOT exist on the current surface (Sessions by Status panel is separate).
  // ─────────────────────────────────────────────────────────────────────────
  test('2. stat cards render (Total Cost / Total Tokens / Requests / Avg Iterations)', async ({
    page,
  }) => {
    await page.goto('/dashboard')
    // Wait for either a stat label to appear or an explicit error/loading clear.
    await expect(page.getByText(/Total Cost/i).first()).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/Total Tokens/i).first()).toBeVisible()
    await expect(page.getByText(/Requests/i).first()).toBeVisible()
    await expect(page.getByText(/Avg Iterations/i).first()).toBeVisible()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 3) Sessions-by-status pills are humanized (Wave 3 P2·S).
  //    Pills must render human-friendly labels — not raw enum
  //    (`awaiting_enhancement_review` etc.). The "Sessions by Status" section
  //    may be empty for accounts with no sessions in the window — in that
  //    case we soft-skip with fixme.
  // ─────────────────────────────────────────────────────────────────────────
  test('3. status pills are humanized — no raw enum strings', async ({ page }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: /Sessions by Status/i })).toBeVisible({
      timeout: 15_000,
    })

    const panel = page.locator('h2', { hasText: /Sessions by Status/i }).locator('..')
    const empty = panel.getByText(/No sessions in window/i)
    if (await empty.isVisible().catch(() => false)) {
      test.fixme(true, 'No sessions in window — cannot validate pill labels')
      return
    }

    // Collect all pill anchors under the panel.
    const pills = panel.locator('a[href^="/sessions?status="]')
    const n = await pills.count()
    expect(n, 'expected ≥1 status pill').toBeGreaterThan(0)

    const rawEnumPattern = /\b(awaiting_enhancement_review|awaiting_enhancement|enhancing)\b/
    for (let i = 0; i < n; i++) {
      const text = (await pills.nth(i).innerText()).trim()
      // Must not contain raw snake_case enum tokens.
      expect(text, `pill #${i} contains raw enum: "${text}"`).not.toMatch(rawEnumPattern)
    }

    // At least one of the well-known humanized strings should appear somewhere
    // (only if the corresponding status is in the user's window).
    // We don't hard-require any specific label — just verify the humanizer
    // ran (no raw enum above already covers the contract).
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 4) Pills are clickable <a> links pointing at /sessions?status=<enum>.
  //    Click one and assert navigation.
  // ─────────────────────────────────────────────────────────────────────────
  test('4. pills are <a> Links to /sessions?status=<enum> and navigate on click', async ({
    page,
  }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: /Sessions by Status/i })).toBeVisible({
      timeout: 15_000,
    })

    const panel = page.locator('h2', { hasText: /Sessions by Status/i }).locator('..')
    const empty = panel.getByText(/No sessions in window/i)
    if (await empty.isVisible().catch(() => false)) {
      test.fixme(true, 'No sessions in window — no pills to click')
      return
    }

    const pills = panel.locator('a[href^="/sessions?status="]')
    const n = await pills.count()
    expect(n, 'expected ≥1 pill anchor').toBeGreaterThan(0)

    // Tag-name check: every pill must be an <a>.
    for (let i = 0; i < n; i++) {
      const tag = await pills.nth(i).evaluate((el) => el.tagName.toLowerCase())
      expect(tag).toBe('a')
      const href = await pills.nth(i).getAttribute('href')
      expect(href, `pill #${i} href`).toMatch(/^\/sessions\?status=[A-Za-z_%0-9]+$/)
    }

    // Click the first pill and assert URL contains the status query param.
    const firstHref = await pills.first().getAttribute('href')
    expect(firstHref).toBeTruthy()
    await pills.first().click()
    await expect(page).toHaveURL(/\/sessions\?status=/, { timeout: 10_000 })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 5) Status filter applies on /sessions after clicking a pill.
  //    BUG WATCH: SessionsPage uses `useState('all')` for statusFilter and
  //    does NOT read `?status=` from the URL — so the filter pill on
  //    /sessions does not auto-activate from the query param. We document
  //    that here. The test will fail if (and only if) someone wires the URL
  //    sync — which is the spec's intent — so this becomes a guard rather
  //    than a passing assertion until the bug is fixed.
  // ─────────────────────────────────────────────────────────────────────────
  test('5. clicking a pill activates the matching status filter on /sessions', async ({
    page,
  }) => {
    await page.goto('/dashboard')
    await expect(page.getByRole('heading', { name: /Sessions by Status/i })).toBeVisible({
      timeout: 15_000,
    })

    const panel = page.locator('h2', { hasText: /Sessions by Status/i }).locator('..')
    const empty = panel.getByText(/No sessions in window/i)
    if (await empty.isVisible().catch(() => false)) {
      test.fixme(true, 'No sessions in window — no pill to click')
      return
    }

    const firstPill = panel.locator('a[href^="/sessions?status="]').first()
    const href = await firstPill.getAttribute('href')
    expect(href).toBeTruthy()
    const statusEnum = decodeURIComponent(
      (href || '').split('status=')[1] || ''
    ).trim()
    expect(statusEnum.length).toBeGreaterThan(0)

    await firstPill.click()
    await expect(page).toHaveURL(/\/sessions\?status=/, { timeout: 10_000 })

    // The active filter pill on /sessions is the <button> whose label maps to
    // the same enum. КАО#R4-M2 — active pills now carry explicit per-status
    // light/dark border classes (not the old `border-current`); the stable
    // semantic contract is aria-pressed="true". Match "All" at a word boundary
    // so the trailing "(7)" count in the button's text doesn't break the row.
    const sessionsFilterRow = page.locator('button', { hasText: /^All\b/i }).first().locator('..')
    const activePill = sessionsFilterRow.locator('button[aria-pressed="true"]').first()
    // We assert the active pill exists; if it's still "All" the URL sync is
    // missing — this asserts the spec contract and fails loudly otherwise.
    await expect(activePill).toBeVisible({ timeout: 5_000 })
    const activeText = (await activePill.innerText()).toLowerCase()
    // The active text should reference the same status (or its label).
    // Accept either the raw enum, the humanized label, or a substring match
    // on the leading word (e.g. "completed" ⊂ "Completed (12)").
    const head = statusEnum.split('_')[0]
    expect(activeText, `active filter pill = "${activeText}", expected ~ "${statusEnum}"`)
      .toContain(head)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 6) Welcome / onboarding card (КАО W4-CFIX-01)
  //    Renders only for empty accounts (recentSessions.length === 0).
  //    For accounts WITH sessions we assert the card is ABSENT (the inverse
  //    contract — equally valuable). Either way the test runs.
  // ─────────────────────────────────────────────────────────────────────────
  test('6. welcome / onboarding card renders only for empty accounts', async ({ page }) => {
    await page.goto('/dashboard')
    const card = page.locator('[data-testid="dashboard-welcome-card"]')
    const hasSessions = await page.evaluate(async () => {
      // КАО#R4-S6sug — the httpOnly cookie rides same-origin fetches; the
      // legacy localStorage token is always empty post-SG1.
      const r = await fetch('/api/sessions/?limit=1')
      if (!r.ok) return false
      const j = await r.json()
      return ((j.items ?? j) as unknown[]).length > 0
    })
    if (hasSessions) {
      await expect(card, 'welcome card must NOT render when account has sessions').toHaveCount(0)
    } else {
      await expect(card).toBeVisible()
      await expect(card.getByRole('link', { name: /Create your first session/i })).toBeVisible()
      await expect(card.getByRole('link', { name: /Try a demo first/i })).toBeVisible()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // 7) Recent sessions list (КАО W4-CFIX-02)
  //    Renders when account has ≥1 session. Each row is a link to detail.
  // ─────────────────────────────────────────────────────────────────────────
  test('7. recent sessions list shows up to 5 most recent sessions and links to detail', async ({ page }) => {
    await page.goto('/dashboard')
    const hasSessions = await page.evaluate(async () => {
      // КАО#R4-S6sug — the httpOnly cookie rides same-origin fetches; the
      // legacy localStorage token is always empty post-SG1.
      const r = await fetch('/api/sessions/?limit=1')
      if (!r.ok) return false
      const j = await r.json()
      return ((j.items ?? j) as unknown[]).length > 0
    })
    const list = page.locator('[data-testid="dashboard-recent-sessions"]')
    if (!hasSessions) {
      await expect(list, 'recent sessions list hidden on empty accounts').toHaveCount(0)
      return
    }
    await expect(list).toBeVisible({ timeout: 10_000 })
    const items = list.locator('ul li a')
    const n = await items.count()
    expect(n, 'at least one recent session row').toBeGreaterThan(0)
    expect(n, 'at most 5 recent sessions').toBeLessThanOrEqual(5)

    // First row links to /sessions/:uuid
    const firstHref = await items.first().getAttribute('href')
    expect(firstHref).toMatch(/\/sessions\/[a-f0-9-]+/)

    // "View all" link is present and routes to /sessions
    const viewAll = list.getByRole('link', { name: /View all/i })
    await expect(viewAll).toBeVisible()
    expect(await viewAll.getAttribute('href')).toBe('/sessions')
  })
})
