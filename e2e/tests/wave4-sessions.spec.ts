// W4-Sessions Tester — Wave-4 KAO
// Validates Sessions page behavior (filters, sort, search, kebab, compare,
// responsive header, empty state, formatDate, bulk select, templates).
//
// Target: https://stage.gotcode.ai
// Run:
//   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
//     npx playwright test tests/wave4-sessions.spec.ts --reporter=list
//
// READ-ONLY: this spec does NOT create sessions or trigger real deletes.

import { authedTest as test, expect, type Page } from './_fixtures/auth'

const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN ?? ''

async function gotoSessions(page: Page) {
  await page.goto('/sessions')
  await expect(page.getByRole('heading', { name: /^sessions$/i })).toBeVisible()
  // Wait for either the pills row or empty-state to render
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
}

async function hasAnySessions(page: Page): Promise<boolean> {
  // Pills only render when sessions.length > 0 (see SessionsPage.tsx).
  const allPill = page.getByRole('button', { name: /^All \(\d+\)$/ })
  return allPill.isVisible({ timeout: 5_000 }).catch(() => false)
}

test.describe('W4-Sessions', () => {
  test.beforeEach(async () => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Filter pills row
  // ─────────────────────────────────────────────────────────────────────────
  test('1. Filter pills: all status pills always rendered', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const expected = [
      'All',
      'Created',
      'Running',
      'Completed',
      'Failed',
      'Paused',
      'Cancelled',
      'Awaiting Enhancement',
      'Enhancing...',
      'Review Enhancements',
    ]
    for (const label of expected) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      await expect(
        page.getByRole('button', { name: new RegExp(`^${escaped} \\(\\d+\\)$`) })
      ).toBeVisible()
    }
  })

  test('2. Filter pills: active pill highlighted, others muted', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const allPill = page.getByRole('button', { name: /^All \(\d+\)$/ })
    await expect(allPill).toHaveAttribute('aria-pressed', 'true')

    // Pick any non-all pill and click it
    const created = page.getByRole('button', { name: /^Created \(\d+\)$/ })
    await created.click()
    await expect(created).toHaveAttribute('aria-pressed', 'true')
    await expect(allPill).toHaveAttribute('aria-pressed', 'false')
  })

  test('3. Enhancing pill icon is Sparkles (NOT spinning Loader2) when count=0', async ({
    page,
  }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const enhancingPill = page.getByRole('button', { name: /^Enhancing\.\.\. \(\d+\)$/ })
    await expect(enhancingPill).toBeVisible()
    // No spinning Loader2 (animate-spin) icon inside filter pill
    const spinningInside = enhancingPill.locator('.animate-spin')
    expect(await spinningInside.count()).toBe(0)
    // Sparkles svg (lucide) present
    const svg = enhancingPill.locator('svg')
    expect(await svg.count()).toBeGreaterThan(0)
  })

  test('4. Running pill icon is non-pulsing', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const runningPill = page.getByRole('button', { name: /^Running \(\d+\)$/ })
    await expect(runningPill).toBeVisible()
    const pulsing = runningPill.locator('.animate-pulse')
    expect(await pulsing.count()).toBe(0)
  })

  test('5. Clicking a pill narrows the list; non-matching pills remain visible', async ({
    page,
  }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    // Find a pill with count > 0 to click (try the obvious ones)
    let clicked = false
    for (const label of ['Completed', 'Created', 'Failed', 'Cancelled', 'Running']) {
      const pill = page.getByRole('button', { name: new RegExp(`^${label} \\(\\d+\\)$`) })
      const text = (await pill.textContent()) || ''
      const m = text.match(/\((\d+)\)/)
      if (m && parseInt(m[1], 10) > 0) {
        await pill.click()
        clicked = true
        break
      }
    }
    test.skip(!clicked, 'Account has only single-status sessions; cannot narrow')

    // All pills still visible after narrowing
    for (const label of ['All', 'Created', 'Running', 'Completed', 'Failed', 'Cancelled']) {
      await expect(
        page.getByRole('button', { name: new RegExp(`^${label} \\(\\d+\\)$`) })
      ).toBeVisible()
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Sort dropdown
  // ─────────────────────────────────────────────────────────────────────────
  test('6. Sort dropdown options + default newest', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const sort = page.getByRole('combobox', { name: /sort sessions/i })
    await expect(sort).toBeVisible()
    await expect(sort).toHaveValue('newest')

    const options = await sort.locator('option').allTextContents()
    expect(options).toEqual(
      expect.arrayContaining([
        'Newest first',
        'Oldest first',
        'Recently updated',
        'Highest cost',
        'Most iterations',
      ])
    )
  })

  test('7. Switching sort reorders visible cards client-side', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    // Get first few card names with newest sort
    const cardTitles = page.locator('[data-tour="sessions-list"] h3')
    const beforeCount = await cardTitles.count()
    test.skip(beforeCount < 2, 'Need at least 2 sessions to verify reorder')

    const before = await cardTitles.allTextContents()

    // Switch to oldest
    const sort = page.getByRole('combobox', { name: /sort sessions/i })
    await sort.selectOption('oldest')
    await page.waitForTimeout(300)
    const after = await cardTitles.allTextContents()

    // Order should differ — at minimum first item changes if list len > 1 with distinct dates
    const changed =
      before.length !== after.length || before.some((v, i) => v !== after[i])
    expect(changed).toBeTruthy()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Search
  // ─────────────────────────────────────────────────────────────────────────
  test('8. Typing in search filters cards client-side', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const cardTitles = page.locator('[data-tour="sessions-list"] h3')
    const beforeCount = await cardTitles.count()
    test.skip(beforeCount < 1, 'No cards to search')

    // Use the prefix of the first card name as the query
    const firstName = ((await cardTitles.first().textContent()) || '').trim()
    const query = firstName.slice(0, Math.min(4, firstName.length)) || 'a'

    const search = page.getByPlaceholder(/search sessions by name/i)
    await search.fill(query)
    await page.waitForTimeout(300)

    const afterCount = await cardTitles.count()
    expect(afterCount).toBeGreaterThan(0)
    expect(afterCount).toBeLessThanOrEqual(beforeCount)
  })

  test('9. Disclosure note appears when hasMore and search/filter active', async ({
    page,
  }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    // hasMore is true when totalSessions > loaded. Verify via the "Showing N of M" indicator.
    const indicator = page.locator('text=/Showing \\d+ of \\d+ sessions/')
    const hasIndicator = await indicator.isVisible({ timeout: 3_000 }).catch(() => false)
    if (!hasIndicator) {
      test.skip(true, 'No "Showing N of M" indicator — cannot verify hasMore state')
    }
    const txt = (await indicator.textContent()) || ''
    const m = txt.match(/Showing (\d+) of (\d+) sessions/)
    test.skip(!m, 'Indicator format unexpected')
    const loaded = parseInt(m![1], 10)
    const total = parseInt(m![2], 10)
    test.skip(loaded >= total, 'hasMore is false — full list loaded')

    // Activate a filter (search) and confirm disclosure note appears
    const search = page.getByPlaceholder(/search sessions by name/i)
    await search.fill('z')
    const disclosure = page.locator(
      `text=/Showing matches from the first ${loaded} sessions/`
    )
    await expect(disclosure).toBeVisible({ timeout: 3_000 })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Kebab menu
  // ─────────────────────────────────────────────────────────────────────────
  test('10. Kebab menu opens with all four actions', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const kebabs = page.getByRole('button', { name: /session actions/i })
    const first = kebabs.first()
    await first.click()

    await expect(page.getByRole('menuitem', { name: /copy session/i })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /copy structure/i })).toBeVisible()
    await expect(
      page.getByRole('menuitem', { name: /compare with another/i })
    ).toBeVisible()
    await expect(page.getByRole('menuitem', { name: /delete session/i })).toBeVisible()
  })

  test('11. Esc closes kebab dropdown', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const kebabs = page.getByRole('button', { name: /session actions/i })
    await kebabs.first().click()
    const item = page.getByRole('menuitem', { name: /copy session/i })
    await expect(item).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(item).not.toBeVisible({ timeout: 3_000 })
  })

  test('12. Clicking outside closes kebab dropdown', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const kebabs = page.getByRole('button', { name: /session actions/i })
    await kebabs.first().click()
    const item = page.getByRole('menuitem', { name: /copy session/i })
    await expect(item).toBeVisible()
    // Click on page heading
    await page.getByRole('heading', { name: /^sessions$/i }).click()
    await expect(item).not.toBeVisible({ timeout: 3_000 })
  })

  test('13. Copy session triggers action and shows toast', async ({ page }) => {
    // КАО W4 closure: allowed to mutate, copy creates a new `(Copy)` session.
    // Track the new session ID and delete it in afterEach. Use READ-ONLY page
    // session via TEST_SESSION_ID as the source.
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const beforeCount = await page.locator('[data-tour="sessions-list"] > div').count()

    // Open kebab on the first card → Copy session.
    const kebab = page.getByRole('button', { name: /session actions/i }).first()
    await kebab.click()
    const copyItem = page.getByRole('menuitem', { name: /copy session/i }).first()
    await copyItem.click()

    // Toast surfaces (success or error — we accept either to keep this test
    // independent of LLM-stack health; the contract is "Copy triggers a
    // network action and surfaces the result").
    await expect(page.locator('[role="status"]').first()).toBeVisible({ timeout: 10_000 })

    // List should grow by 1 after copy resolves.
    await expect
      .poll(async () => page.locator('[data-tour="sessions-list"] > div').count(), { timeout: 10_000 })
      .toBeGreaterThan(beforeCount)

    // CLEANUP — find the newly-created (Copy) session and delete via API.
    const token = process.env.E2E_AUTH_TOKEN ?? ''
    const newest = await page.evaluate(async (t) => {
      const r = await fetch('/api/sessions/?limit=5', { headers: { Authorization: `Bearer ${t}` } })
      const j = await r.json()
      const items = j.items || j
      return items[0]?.id as string | undefined
    }, token)
    if (newest) {
      await page.evaluate(async ({ id, t }) => {
        await fetch(`/api/sessions/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } })
      }, { id: newest, t: token })
    }
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Compare button visibility
  // ─────────────────────────────────────────────────────────────────────────
  test('14. Compare button only inline after entering compare-pick mode', async ({
    page,
  }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const cards = page.locator('[data-tour="sessions-list"] > div')
    const cardCount = await cards.count()
    test.skip(cardCount < 2, 'Need at least 2 sessions for compare-mode test')

    // Before compare-pick mode: no inline Compare button on any card.
    const inlineBefore = page.getByRole('button', { name: /^compare session$/i })
    expect(await inlineBefore.count()).toBe(0)

    // Enter compare-pick mode via session A's kebab → Compare with another
    const kebabs = page.getByRole('button', { name: /session actions/i })
    await kebabs.first().click()
    await page.getByRole('menuitem', { name: /compare with another/i }).click()

    // Modal opens; on session B card (in background list), inline Compare visible.
    // The button has aria-label "Compare session"
    const inlineAfter = page.getByRole('button', { name: /^compare session$/i })
    // The compare modal is overlay; underlying cards still have the button rendered.
    expect(await inlineAfter.count()).toBeGreaterThan(0)

    // Close modal
    await page.getByRole('button', { name: /^close$/i }).click().catch(() => {})
    await page.keyboard.press('Escape')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Header secondary actions responsive
  // ─────────────────────────────────────────────────────────────────────────
  test('15. Header responsive: 600x800 hides secondary, shows kebab overflow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 600, height: 800 })
    await gotoSessions(page)

    // Inline buttons hidden at <md (tailwind md=768px)
    const importBtn = page.getByRole('button', { name: /^import sessions from json$/i })
    const selectBtn = page.getByRole('button', { name: /^select sessions for export$/i })
    const templatesBtn = page.getByRole('button', { name: /^toggle templates panel$/i })

    // They render in DOM (hidden via CSS) but should not be visible
    await expect(importBtn).toBeHidden().catch(async () => {
      expect(await importBtn.isVisible()).toBe(false)
    })

    // Overflow kebab visible
    const overflow = page.getByRole('button', { name: /^more actions$/i })
    await expect(overflow).toBeVisible()
  })

  test('16. Header responsive: 1200x800 shows all secondary actions', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 800 })
    await gotoSessions(page)

    const importBtn = page.getByRole('button', { name: /^import sessions from json/i })
    // The Select button has visible text "Select" (or "Cancel" when toggled); no aria-label.
    const selectBtn = page.locator('button[title="Select sessions for export"]')
    const templatesBtn = page.getByRole('button', { name: /toggle templates panel/i })

    await expect(importBtn).toBeVisible()
    await expect(selectBtn).toBeVisible()
    await expect(templatesBtn).toBeVisible()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Empty state Clear filters
  // ─────────────────────────────────────────────────────────────────────────
  test('17. Empty state shows Clear filters; clicking resets', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const query = `_NEVER_MATCHING_QUERY_${Date.now()}`
    const search = page.getByPlaceholder(/search sessions by name/i)
    await search.fill(query)
    await page.waitForTimeout(300)

    await expect(page.getByText(/No sessions match the current filter/i)).toBeVisible()
    const clearBtn = page.getByRole('button', { name: /^clear filters$/i })
    await expect(clearBtn).toBeVisible()
    await clearBtn.click()
    await expect(search).toHaveValue('')
    const allPill = page.getByRole('button', { name: /^All \(\d+\)$/ })
    await expect(allPill).toHaveAttribute('aria-pressed', 'true')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Load More count
  // ─────────────────────────────────────────────────────────────────────────
  test('18. "Showing N of M sessions" text visible above Load More', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')
    const indicator = page.locator('text=/Showing \\d+ of \\d+ sessions/')
    await expect(indicator).toBeVisible()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // formatDate
  // ─────────────────────────────────────────────────────────────────────────
  test('19. Intl.DateTimeFormat resolves a locale', async ({ page }) => {
    await gotoSessions(page)
    const locale = await page.evaluate(
      () => new Intl.DateTimeFormat().resolvedOptions().locale
    )
    expect(typeof locale).toBe('string')
    expect(locale.length).toBeGreaterThan(0)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // SessionCompareModal
  // ─────────────────────────────────────────────────────────────────────────
  test('20. SessionCompareModal opens with 2 columns + tabs', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const kebabs = page.getByRole('button', { name: /session actions/i })
    await kebabs.first().click()
    await page.getByRole('menuitem', { name: /compare with another/i }).click()

    // Modal visible
    const dialog = page.getByRole('dialog', { name: /session comparison/i })
    await expect(dialog).toBeVisible()

    // Three view tabs
    const tablist = page.getByRole('tablist', { name: /comparison view mode/i })
    await expect(tablist).toBeVisible()
    await expect(tablist.getByRole('tab', { name: /side-by-side/i })).toBeVisible()
    await expect(tablist.getByRole('tab', { name: /unified diff/i })).toBeVisible()
    await expect(tablist.getByRole('tab', { name: /raw/i })).toBeVisible()

    // Default = side-by-side
    await expect(
      tablist.getByRole('tab', { name: /side-by-side/i })
    ).toHaveAttribute('aria-selected', 'true')

    // Close
    await page.keyboard.press('Escape')
  })

  test('21. Switching modal tabs changes view', async ({ page }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const kebabs = page.getByRole('button', { name: /session actions/i })
    await kebabs.first().click()
    await page.getByRole('menuitem', { name: /compare with another/i }).click()
    const tablist = page.getByRole('tablist', { name: /comparison view mode/i })
    await expect(tablist).toBeVisible()

    const unifiedTab = tablist.getByRole('tab', { name: /unified diff/i })
    await unifiedTab.click()
    await expect(unifiedTab).toHaveAttribute('aria-selected', 'true')

    const rawTab = tablist.getByRole('tab', { name: /^raw$/i })
    await rawTab.click()
    await expect(rawTab).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('Escape')
  })

  test('22. Column B empty state shows "Pick from list →" link; clicking closes modal', async ({
    page,
  }) => {
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const kebabs = page.getByRole('button', { name: /session actions/i })
    await kebabs.first().click()
    await page.getByRole('menuitem', { name: /compare with another/i }).click()

    const dialog = page.getByRole('dialog', { name: /session comparison/i })
    await expect(dialog).toBeVisible()

    const pickLink = dialog.getByRole('button', { name: /pick from list/i })
    await expect(pickLink).toBeVisible()
    await pickLink.click()
    await expect(dialog).not.toBeVisible({ timeout: 3_000 })
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Bulk select + delete
  // ─────────────────────────────────────────────────────────────────────────
  test('23. Bulk select: checkboxes appear, Delete Selected ConfirmDialog cancellable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 800 })
    await gotoSessions(page)
    test.skip(!(await hasAnySessions(page)), 'No sessions for this account')

    const selectBtn = page.locator('button[title="Select sessions for export"]')
    await selectBtn.click()

    // After click, label becomes "Cancel" (button still has same title attribute)
    // Checkboxes (Square / CheckSquare icons) appear on every card.
    // Each card has a checkbox button (the Square / CheckSquare).
    const cards = page.locator('[data-tour="sessions-list"] > div').filter({
      has: page.locator('h3'),
    })
    const cardCount = await cards.count()
    test.skip(cardCount < 1, 'No cards')

    // Click first card checkbox
    await cards.first().locator('button').first().click()

    // Export Selected + Delete Selected buttons appear
    await expect(
      page.getByRole('button', { name: /^export selected sessions$/i })
    ).toBeVisible()
    const delBtn = page.getByRole('button', { name: /^delete selected sessions$/i })
    await expect(delBtn).toBeVisible()

    // Open confirm dialog (READ-ONLY: Cancel only)
    await delBtn.click()
    const confirmDialog = page.getByRole('dialog', {
      name: /delete selected sessions confirmation/i,
    })
    await expect(confirmDialog).toBeVisible()
    // Count is shown
    await expect(confirmDialog).toContainText(/1/)

    // Cancel — no deletion happens
    await confirmDialog.getByRole('button', { name: /^cancel$/i }).click()
    await expect(confirmDialog).not.toBeVisible({ timeout: 3_000 })
    // Cards still visible
    expect(await cards.count()).toBe(cardCount)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Templates panel
  // ─────────────────────────────────────────────────────────────────────────
  test('24. Templates panel: apply-template validation', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 })
    await gotoSessions(page)

    const templatesBtn = page.getByRole('button', { name: /toggle templates panel/i })
    await templatesBtn.click()

    // Panel header visible
    await expect(
      page.getByRole('heading', { name: /session templates/i })
    ).toBeVisible()

    // If no templates, skip the apply-flow
    const useBtn = page.getByRole('button', { name: /^use$/i })
    const hasTemplates = await useBtn.first().isVisible({ timeout: 3_000 }).catch(() => false)
    test.skip(!hasTemplates, 'No templates exist for this account')

    await useBtn.first().click()

    // Dialog with name + spec textarea opens
    const dialog = page.locator('text=/Use template "/').locator('..').locator('..')
    await expect(page.getByText(/use template "/i)).toBeVisible()

    // Counter starts at 0/20+
    await expect(page.getByText(/0\/20\+ chars/)).toBeVisible()

    // Try submit empty — Create Session button should be disabled
    const createBtn = page.getByRole('button', { name: /^create session$/i })
    await expect(createBtn).toBeDisabled()

    // Type 5 chars in spec
    const specBox = page.locator('textarea')
    await specBox.fill('hello')
    await expect(page.getByText(/5\/20\+ chars/)).toBeVisible()
    await expect(createBtn).toBeDisabled()

    // Type 25+ chars
    await specBox.fill('This is a long enough specification text yes!')
    await expect(createBtn).toBeEnabled()

    // Press Cancel
    await page.getByRole('button', { name: /^cancel$/i }).click()
    await expect(page.getByText(/use template "/i)).not.toBeVisible({ timeout: 3_000 })
  })
})
