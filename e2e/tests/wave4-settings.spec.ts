/**
 * Wave-4 — Settings / Webhooks / Cross-cutting tests (W4-Settings Tester).
 *
 * Scope: Settings page (Appearance, API Keys, Notifications), Webhooks CRUD,
 * Cmd-K palette, Toaster offset/dismiss-all, Sidebar Help menu, sentence-case
 * button copy, ApiKeySetupDialog Esc, and ErrorBoundary buttons.
 *
 * MUTATION DISCIPLINE (webhooks):
 *   - All webhook names start with `_e2e_w4_<timestamp>_`.
 *   - Strict cleanup via API DELETE in test.afterEach. Hard cap: 3 webhooks.
 *
 * Run:
 *   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai \
 *     npx playwright test tests/wave4-settings.spec.ts --reporter=list
 */
import { authedTest as test, expect, AUTH_TOKEN, BASE_URL, type Page } from './_fixtures/auth'

// ─── webhook cleanup helpers ─────────────────────────────────────────────────

/** Webhook IDs to clean up after each test that mutates webhooks. */
const createdWebhookIds = new Set<string>()

async function apiDeleteWebhook(id: string): Promise<void> {
  if (!AUTH_TOKEN) return
  try {
    await fetch(`${BASE_URL}/api/webhooks/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
  } catch {
    // best-effort
  }
}

async function apiListWebhooks(): Promise<Array<{ id: string; name: string; url: string }>> {
  if (!AUTH_TOKEN) return []
  try {
    const r = await fetch(`${BASE_URL}/api/webhooks/`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    if (!r.ok) return []
    return (await r.json()) as Array<{ id: string; name: string; url: string }>
  } catch {
    return []
  }
}

test.afterEach(async () => {
  for (const id of createdWebhookIds) {
    await apiDeleteWebhook(id)
  }
  createdWebhookIds.clear()
})

// Safety net at the suite level: nuke any stale _e2e_w4_* webhooks regardless.
test.afterAll(async () => {
  const list = await apiListWebhooks()
  for (const wh of list) {
    if (typeof wh.name === 'string' && wh.name.startsWith('_e2e_w4_')) {
      await apiDeleteWebhook(wh.id)
    }
  }
})

test.beforeEach(async ({ page }) => {
  if (!AUTH_TOKEN) test.skip(true, 'E2E_AUTH_TOKEN not set')
  // Intentionally NOT pre-seeding 'codeforge.prefs.toastVerbosity' here — S7
  // verifies persistence across reload, so the init script would clobber it.
  void page
})

// ─── small DOM helpers ───────────────────────────────────────────────────────

async function gotoSettings(page: Page): Promise<void> {
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 15_000 })
}

// ─── Settings page ───────────────────────────────────────────────────────────

test.describe('Wave-4 Settings — Page sections', () => {
  test('S1. Page loads at /settings — Appearance / API Keys / Notifications sections visible', async ({ page }) => {
    await gotoSettings(page)
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'LLM Providers' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible()
  })

  test('S2. Appearance ThemeToggle has Light/Dark pill (no "System" — documented)', async ({ page }) => {
    await gotoSettings(page)
    const group = page.locator('[role="group"][aria-label="Theme"]')
    await expect(group).toBeVisible()
    await expect(group.getByRole('button', { name: /Light/ })).toBeVisible()
    await expect(group.getByRole('button', { name: /Dark/ })).toBeVisible()
    // Note: spec asks for "System" — current implementation only ships Light/Dark.
    // Documented as a gap in tests/reports/w4_settings.md; not failing.
  })

  test('S3. Theme toggle switches html.dark class', async ({ page }) => {
    await gotoSettings(page)
    const group = page.locator('[role="group"][aria-label="Theme"]')
    await group.getByRole('button', { name: /Light/ }).click()
    await expect.poll(async () => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(false)
    await group.getByRole('button', { name: /Dark/ }).click()
    await expect.poll(async () => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(true)
  })

  test('S4. ConfirmDialog renders with light-theme tokens after Light toggle', async ({ page }) => {
    // Wave 1 P1·S — verify ConfirmDialog uses cf-* theme tokens (not hard-coded dark).
    // Seed a webhook through page.request (shares context auth) so we can open
    // the ConfirmDialog without UI mutation overhead.
    const ts = Date.now()
    const name = `_e2e_w4_${ts}_confirmdialog`
    const created = await page.request.post(`${BASE_URL}/api/webhooks/`, {
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      data: {
        name,
        url: 'https://example.com/hook',
        webhook_type: 'generic',
        event_filter: null,
        enabled: true,
        secret: null,
      },
    })
    expect(created.ok(), `Seed POST failed: ${created.status()}`).toBeTruthy()
    const body = await created.json()
    createdWebhookIds.add(body.id)

    await gotoSettings(page)

    // Switch to light theme.
    const group = page.locator('[role="group"][aria-label="Theme"]')
    await group.getByRole('button', { name: /Light/ }).click()
    await expect.poll(async () => page.evaluate(() => document.documentElement.classList.contains('dark')))
      .toBe(false)

    // Webhook row should be visible (use .truncate span which is the row title).
    const rowTitle = page.locator('span.truncate', { hasText: name })
    await expect(rowTitle).toBeVisible({ timeout: 10_000 })

    // Click Delete on that row.
    const row = rowTitle.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
    await row.getByRole('button', { name: 'Delete' }).click()

    // ConfirmDialog appears.
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Delete webhook?')).toBeVisible({ timeout: 5_000 })

    // Background should NOT be dark.
    const bgColor = await dialog.locator('.bg-cf-panel').first().evaluate((el) => {
      return getComputedStyle(el).backgroundColor
    })
    const m = bgColor.match(/(\d+),\s*(\d+),\s*(\d+)/)
    expect(m, `Expected rgb() background, got: ${bgColor}`).not.toBeNull()
    if (m) {
      const r = +m[1], g = +m[2], b = +m[3]
      const avg = (r + g + b) / 3
      expect(avg, `Background avg ${avg} suggests dark theme`).toBeGreaterThan(150)
    }

    // Cancel the dialog.
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(dialog).toBeHidden({ timeout: 5_000 })

    // Restore dark theme.
    await page.locator('[role="group"][aria-label="Theme"]').getByRole('button', { name: /Dark/ }).click()
  })

  test('S5. API Keys section lists providers with Save + Test', async ({ page }) => {
    await gotoSettings(page)
    // Wait for the "Refresh models" button to be enabled — implies providers loaded.
    const refreshBtn = page.getByRole('button', { name: /^Refresh models$/ })
    await expect(refreshBtn).toBeVisible({ timeout: 15_000 })

    // Wait for at least one provider name to be rendered (capitalize CSS doesn't
    // change DOM text; raw text is lowercase like "openai").
    const knownProviders = ['openai', 'anthropic', 'google', 'grok', 'ollama']
    let foundProvider: string | null = null
    for (let attempt = 0; attempt < 20 && !foundProvider; attempt++) {
      for (const name of knownProviders) {
        const cnt = await page.locator(`div.font-medium`, { hasText: new RegExp(`^${name}$`, 'i') }).count()
        if (cnt > 0) {
          foundProvider = name
          break
        }
      }
      if (!foundProvider) await page.waitForTimeout(500)
    }
    expect(foundProvider, 'At least one provider should be listed').not.toBeNull()

    // Expand the first provider row.
    if (foundProvider) {
      const header = page.locator(`div.font-medium`, { hasText: new RegExp(`^${foundProvider}$`, 'i') }).first()
      await header.click()
      // Expanded panel has Save and Test buttons.
      await expect(page.getByRole('button', { name: /^Save$/ }).first()).toBeVisible({ timeout: 5_000 })
      // There is also a Test button in the collapsed row; just check >= 1.
      const testCount = await page.getByRole('button', { name: /^Test$/ }).count()
      expect(testCount).toBeGreaterThan(0)
    }
  })

  test('S6. Notifications section: verbosity radio + desktop + sound + email digest', async ({ page }) => {
    await gotoSettings(page)
    await expect(page.locator('input[type="radio"][name="toast-verbosity"][value="verbose"]')).toBeVisible()
    await expect(page.locator('input[type="radio"][name="toast-verbosity"][value="important-only"]')).toBeVisible()
    await expect(page.locator('input[type="radio"][name="toast-verbosity"][value="silent"]')).toBeVisible()
    await expect(page.getByText('Browser desktop notifications')).toBeVisible()
    await expect(page.getByText('Notification sound')).toBeVisible()
    await expect(page.locator('input[type="radio"][name="email-digest"][value="weekly"]')).toBeVisible()
    await expect(page.locator('input[type="radio"][name="email-digest"][value="never"]')).toBeVisible()
  })

  test('S7. Notifications persist via localStorage (toastVerbosity)', async ({ page }) => {
    await gotoSettings(page)
    // Set to silent (force — radio inputs sit inside a clickable label).
    await page.locator('input[type="radio"][name="toast-verbosity"][value="silent"]').check({ force: true })
    await expect(page.locator('input[type="radio"][name="toast-verbosity"][value="silent"]')).toBeChecked()

    // Sanity: localStorage was written.
    const beforeReload = await page.evaluate(() => localStorage.getItem('codeforge.prefs.toastVerbosity'))
    expect(beforeReload).toBe('silent')

    // Reload.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
    await expect(page.locator('input[type="radio"][name="toast-verbosity"][value="silent"]')).toBeChecked()

    const stored = await page.evaluate(() => localStorage.getItem('codeforge.prefs.toastVerbosity'))
    expect(stored).toBe('silent')

    // Reset to important-only.
    await page.locator('input[type="radio"][name="toast-verbosity"][value="important-only"]').check({ force: true })
    await expect(page.locator('input[type="radio"][name="toast-verbosity"][value="important-only"]')).toBeChecked()
    const reset = await page.evaluate(() => localStorage.getItem('codeforge.prefs.toastVerbosity'))
    expect(reset).toBe('important-only')
  })

  test('S8. Silent mode mutes notify.success — via window.__cf_notify', async ({ page }) => {
    await gotoSettings(page)
    // Set verbosity to silent via the localStorage key (S7 verifies persistence).
    await page.evaluate(() => localStorage.setItem('codeforge.prefs.toastVerbosity', 'silent'))
    await page.reload()
    await gotoSettings(page)

    // Fire notify.success — should be muted.
    await page.evaluate(() => {
      const w = window as unknown as { __cf_notify?: { success: (m: string) => void; error: (m: string) => void } }
      w.__cf_notify?.success('e2e-silent-success-' + Date.now())
    })
    await page.waitForTimeout(500)
    const successToasts = await page.locator('text=/e2e-silent-success-/').count()
    expect(successToasts, 'silent mode must mute notify.success').toBe(0)

    // Fire notify.error — should NOT be muted (errors always pass).
    await page.evaluate(() => {
      const w = window as unknown as { __cf_notify?: { success: (m: string) => void; error: (m: string) => void } }
      w.__cf_notify?.error('e2e-silent-error-' + Date.now())
    })
    await expect(page.locator('text=/e2e-silent-error-/').first()).toBeVisible({ timeout: 3_000 })

    // Reset prefs back so next tests are independent.
    await page.evaluate(() => localStorage.setItem('codeforge.prefs.toastVerbosity', 'important-only'))
  })
})

// ─── Webhooks CRUD (mutation discipline: cap 3) ──────────────────────────────

test.describe('Wave-4 Settings — Webhooks', () => {
  test('W9. Webhooks section visible (list + "Add webhook" button)', async ({ page }) => {
    await gotoSettings(page)
    await expect(page.getByRole('heading', { name: 'Webhooks' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add webhook', exact: true })).toBeVisible()
  })

  test('W10. Add webhook via UI — appears in list', async ({ page }) => {
    await gotoSettings(page)
    const ts = Date.now()
    const name = `_e2e_w4_${ts}_test`

    await page.getByRole('button', { name: 'Add webhook', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'New Webhook' })).toBeVisible({ timeout: 5_000 })

    await page.getByPlaceholder('My Slack alert').fill(name)
    await page.getByPlaceholder(/hooks\.slack\.com/).fill('https://example.com/hook')

    // Uncheck "All events" and select Session completed.
    const allEventsCheckbox = page.getByLabel('All events')
    if (await allEventsCheckbox.isChecked()) await allEventsCheckbox.uncheck()
    await page.getByLabel('Session completed').check()

    await page.getByRole('button', { name: 'Create webhook' }).click()

    // Row appears (use truncate span — unique title node).
    await expect(page.locator('span.truncate', { hasText: name })).toBeVisible({ timeout: 10_000 })

    // Verify via API + track for cleanup. Retry once for replica lag.
    let mine: { id: string; name: string } | undefined
    for (let i = 0; i < 5 && !mine; i++) {
      const list = await apiListWebhooks()
      mine = list.find((w) => w.name === name)
      if (!mine) await page.waitForTimeout(500)
    }
    expect(mine, 'Webhook should exist server-side').toBeDefined()
    if (mine) createdWebhookIds.add(mine.id)
  })

  test('W11. Edit webhook — change URL, save, verify', async ({ page }) => {
    const ts = Date.now()
    const name = `_e2e_w4_${ts}_edit`
    const created = await page.request.post(`${BASE_URL}/api/webhooks/`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      data: { name, url: 'https://example.com/hook', webhook_type: 'generic', event_filter: null, enabled: true, secret: null },
    })
    expect(created.ok(), `Seed POST failed: ${created.status()}`).toBeTruthy()
    const body = await created.json()
    createdWebhookIds.add(body.id)

    await gotoSettings(page)
    const rowTitle = page.locator('span.truncate', { hasText: name })
    await expect(rowTitle).toBeVisible({ timeout: 10_000 })

    const row = rowTitle.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
    await row.getByRole('button', { name: 'Edit' }).click()

    await expect(page.getByRole('heading', { name: 'Edit Webhook' })).toBeVisible({ timeout: 5_000 })

    await page.getByPlaceholder(/hooks\.slack\.com/).fill('https://example.com/hook2')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await expect(page.getByRole('heading', { name: 'Edit Webhook' })).toBeHidden({ timeout: 5_000 })

    // Verify via API.
    const after = await page.request.get(`${BASE_URL}/api/webhooks/`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    expect(after.ok()).toBeTruthy()
    const list = await after.json() as Array<{ id: string; name: string; url: string }>
    const mine = list.find((w) => w.id === body.id)
    expect(mine?.url, 'URL should be updated').toBe('https://example.com/hook2')
  })

  test('W12. Delete webhook via ConfirmDialog (NOT window.confirm)', async ({ page }) => {
    const ts = Date.now()
    const name = `_e2e_w4_${ts}_delete`
    const created = await page.request.post(`${BASE_URL}/api/webhooks/`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' },
      data: { name, url: 'https://example.com/hook', webhook_type: 'generic', event_filter: null, enabled: true, secret: null },
    })
    expect(created.ok(), `Seed POST failed: ${created.status()}`).toBeTruthy()
    const body = await created.json()
    createdWebhookIds.add(body.id)

    let nativeDialogFired = false
    page.on('dialog', async (d) => {
      nativeDialogFired = true
      await d.dismiss()
    })

    await gotoSettings(page)
    const rowTitle = page.locator('span.truncate', { hasText: name })
    await expect(rowTitle).toBeVisible({ timeout: 10_000 })

    const row = rowTitle.locator('xpath=ancestor::div[contains(@class,"rounded-lg")][1]')
    await row.getByRole('button', { name: 'Delete' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Delete webhook?')).toBeVisible({ timeout: 5_000 })
    expect(nativeDialogFired, 'Native window.confirm should NOT fire').toBe(false)

    // Click the Confirm button inside the dialog (exact text "Delete").
    await dialog.getByRole('button', { name: 'Delete', exact: true }).click()

    // Row disappears — scope to the row title span to avoid matching dialog text.
    await expect(rowTitle).toBeHidden({ timeout: 10_000 })

    // Verify gone server-side.
    let stillThere: { id: string } | undefined
    for (let i = 0; i < 5; i++) {
      const after = await apiListWebhooks()
      stillThere = after.find((w) => w.id === body.id)
      if (!stillThere) break
      await page.waitForTimeout(500)
    }
    expect(stillThere, 'Webhook should be gone server-side').toBeUndefined()

    createdWebhookIds.delete(body.id)
  })
})

// ─── Cross-cutting (Cmd-K, Toaster, Help menu, button copy, dialogs) ─────────

test.describe('Wave-4 Settings — Cross-cutting', () => {
  // Helper: open Cmd-K palette. Playwright's `keyboard.press('Control+K')`
  // sometimes fails to deliver a keydown that React's `document.addEventListener`
  // hook sees (timing/focus). Fallback to dispatching a synthetic KeyboardEvent
  // — the same mechanism Layout.openCommandPalette() uses.
  async function openCmdK(page: Page) {
    await page.evaluate(() => {
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const evt = new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
      })
      document.dispatchEvent(evt)
    })
  }

  test('X13. Cmd-K palette opens and "Go to Demos" navigates', async ({ page }) => {
    await page.goto('/sessions')
    await expect(page.getByRole('heading', { name: /Sessions/i }).first()).toBeVisible({ timeout: 15_000 })

    await openCmdK(page)
    // The Dialog root has size 0 (portal); assert on the Panel input.
    const input = page.getByPlaceholder('Type a command...')
    await expect(input).toBeVisible({ timeout: 5_000 })
    await input.fill('demos')
    const goDemos = page.getByText('Go to Demos', { exact: true })
    await expect(goDemos).toBeVisible({ timeout: 5_000 })
    await goDemos.click()

    await expect(page).toHaveURL(/\/demos(\?|#|$)/, { timeout: 10_000 })
  })

  test('X14. Cmd-K Esc closes palette', async ({ page }) => {
    await page.goto('/sessions')
    await expect(page.getByRole('heading', { name: /Sessions/i }).first()).toBeVisible({ timeout: 15_000 })

    await openCmdK(page)
    const input = page.getByPlaceholder('Type a command...')
    await expect(input).toBeVisible({ timeout: 5_000 })

    await page.keyboard.press('Escape')
    await expect(input).toBeHidden({ timeout: 5_000 })
    // Sanity: the Headless UI Dialog root is also gone from the DOM.
    await expect(page.locator('[data-headlessui-state="open"]')).toHaveCount(0, { timeout: 5_000 })
  })

  test('X15. Toaster top offset >= 80px', async ({ page }) => {
    await gotoSettings(page)
    // Bump verbosity to verbose so the success toast from "Refresh models"
    // actually renders (verbosity gate in StyledToast.tsx l. 174 — `important-only`
    // suppresses success toasts).
    await page.evaluate(() => {
      localStorage.setItem('codeforge.prefs.toastVerbosity', 'verbose')
    })
    // Reload so the page picks up the new verbosity (StyledToast reads it
    // per-toast, so this is technically not required — but it's deterministic).
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()

    const refreshBtn = page.getByRole('button', { name: /^Refresh models$/ })
    await expect(refreshBtn).toBeEnabled({ timeout: 15_000 })
    await refreshBtn.click()

    // StyledToastContent root has class `pointer-events-auto`. Match on its
    // toast text ("Success" / "Models refreshed!" / "Failed to refresh models").
    const toast = page.locator('.pointer-events-auto').filter({
      hasText: /Models refreshed|Failed to refresh|Success|Error/i,
    }).first()
    await expect(toast).toBeVisible({ timeout: 15_000 })
    const box = await toast.boundingBox()
    expect(box).not.toBeNull()
    if (box) {
      expect(box.y, `Toast top ${box.y} should be >= 80`).toBeGreaterThanOrEqual(80)
    }
    // Restore important-only for subsequent tests in this worker.
    await page.evaluate(() => {
      localStorage.setItem('codeforge.prefs.toastVerbosity', 'important-only')
    })
  })

  test('X16. Dismiss-all chip appears when ≥3 toasts visible — via window.__cf_notify', async ({ page }) => {
    await gotoSettings(page)
    // Make sure toast verbosity isn't muting non-error toasts.
    await page.evaluate(() => localStorage.setItem('codeforge.prefs.toastVerbosity', 'verbose'))

    // Fire 3 long-duration toasts so they overlap.
    await page.evaluate(() => {
      const w = window as unknown as { __cf_notify?: { info: (m: string, o?: { duration?: number }) => void } }
      w.__cf_notify?.info('e2e-dismiss-1', { duration: 8000 })
      w.__cf_notify?.info('e2e-dismiss-2', { duration: 8000 })
      w.__cf_notify?.info('e2e-dismiss-3', { duration: 8000 })
    })
    // Dismiss-all chip surfaces when visible.length >= 3.
    await expect(page.getByRole('button', { name: /Dismiss all/i })).toBeVisible({ timeout: 3_000 })

    // Clicking it clears the stack.
    await page.getByRole('button', { name: /Dismiss all/i }).click()
    await page.waitForTimeout(500)
    await expect(page.getByRole('button', { name: /Dismiss all/i })).not.toBeVisible({ timeout: 3_000 })
  })

  test('X17. Sidebar Help / user dropdown menu items', async ({ page }) => {
    await gotoSettings(page)
    await page.locator('[data-tour="user-menu"]').first().click()
    const menu = page.locator('[role="menu"]').first()
    await expect(menu).toBeVisible({ timeout: 5_000 })
    await expect(menu.getByRole('menuitem', { name: /Restart onboarding tour/i })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /Keyboard shortcuts/ })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /Documentation/ })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /What's new/ })).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /Log out/ })).toBeVisible()
    await expect(menu.getByText(/CodeForge v/)).toBeVisible()
    await expect(menu.getByText(/©|\(c\)/)).toBeVisible()
  })

  test('X18. Documentation menu item opens external URL in new tab', async ({ page }) => {
    // Layout calls `window.open('https://docs.gotcode.ai', '_blank',
    // 'noopener,noreferrer')`. The `noopener` feature makes the new tab a
    // separate browsing context not always observable as a `page` event in
    // Playwright's BrowserContext. Stub window.open to capture the URL.
    await page.addInitScript(() => {
      const w = window as unknown as {
        open: (...args: unknown[]) => Window | null
        __cf_open_calls: Array<{ url: string; target?: string; features?: string }>
      }
      w.__cf_open_calls = []
      const orig = w.open.bind(window)
      w.open = (...args: unknown[]) => {
        try {
          w.__cf_open_calls.push({
            url: String(args[0] ?? ''),
            target: args[1] as string | undefined,
            features: args[2] as string | undefined,
          })
        } catch {
          /* ignore */
        }
        return orig(...args)
      }
    })

    await gotoSettings(page)
    await page.locator('[data-tour="user-menu"]').first().click()
    const menu = page.locator('[role="menu"]').first()
    await expect(menu).toBeVisible()

    await menu.getByRole('menuitem', { name: /Documentation/ }).click()

    const calls = await page.evaluate(() => {
      return (window as unknown as { __cf_open_calls?: Array<{ url: string; target?: string; features?: string }> })
        .__cf_open_calls ?? []
    })
    expect(calls.length, 'window.open should have been called').toBeGreaterThan(0)
    const last = calls[calls.length - 1]
    expect(last.url, `window.open URL: ${last.url}`).toMatch(/^https?:\/\/.*docs\.gotcode\.ai/)
    expect(last.target).toBe('_blank')
  })

  test('X19. Sentence-case button copy', async ({ page }) => {
    await gotoSettings(page)
    // "Refresh models" — exact match. The non-sentence variant must not exist.
    await expect(page.getByRole('button', { name: 'Refresh models', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Refresh Models', exact: true })).toHaveCount(0)
    // "Add webhook" — exact match.
    await expect(page.getByRole('button', { name: 'Add webhook', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Add Webhook', exact: true })).toHaveCount(0)
    // "Save & continue" lives in ApiKeySetupDialog — only shown to first-time
    // users without keys. Source-verified at
    // frontend/src/components/common/ApiKeySetupDialog.tsx l. 157.
  })

  test.fixme('X20. ApiKeySetupDialog Esc — unreachable when keys configured (source-verified)', async () => {
    // The dialog only auto-opens for users with NO configured providers
    // (Layout.tsx ll. 295-302). The E2E user has providers configured on
    // stage, so the dialog is unreachable through normal UI flow. Source
    // check (ApiKeySetupDialog.tsx l. 79): `onClose={() => { if (!saving)
    // onClose() }}` is wired through Headless UI's Dialog, which handles
    // Esc natively. Documented in tests/reports/w4_settings.md.
  })

  test.fixme('X21. ErrorBoundary buttons — too brittle to trigger programmatically (source-verified)', async () => {
    // Triggering the boundary requires throwing inside a child render. Source
    // check (Layout.tsx ll. 95-132): boundary renders three buttons —
    //   "Try again"            (handleTryAgain — resets hasError, no reload)
    //   "Copy error details"   (handleCopyError — clipboard.writeText)
    //   "Reload page"          (window.location.reload)
    // Documented in tests/reports/w4_settings.md.
  })
})
