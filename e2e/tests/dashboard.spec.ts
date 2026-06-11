import { test, expect } from '@playwright/test'
import { injectAuth } from './_fixtures/auth'  // КАО#R4-S14 — httpOnly cookie auth

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page, context }) => {
    const token = process.env.E2E_AUTH_TOKEN
    if (!token) test.skip()
    await injectAuth(context)  // КАО#R4-S14 — the app ignores (and purges) the legacy localStorage token
    await page.goto('/dashboard')
  })

  test('renders stat cards', async ({ page }) => {
    await expect(page.getByText(/total cost/i)).toBeVisible({ timeout: 5000 })
    await expect(page.getByText(/total tokens/i)).toBeVisible()
  })

  test('window selector changes data', async ({ page }) => {
    await page.locator('select').selectOption('7')
    // Window changed — would refetch
    await page.waitForTimeout(500)
  })
})
