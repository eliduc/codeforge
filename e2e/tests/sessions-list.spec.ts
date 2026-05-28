import { test, expect } from '@playwright/test'

test.describe('Sessions page', () => {
  test.beforeEach(async ({ page, context }) => {
    // Set auth token if provided
    const token = process.env.E2E_AUTH_TOKEN
    if (!token) test.skip()
    await context.addCookies([])
    await page.addInitScript((t) => {
      localStorage.setItem('codeforge_token', t)
    }, token)
    await page.goto('/sessions')
  })

  test('renders sessions list page', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /sessions/i })).toBeVisible()
    // Search bar present
    await expect(page.locator('input[placeholder*="Search"]')).toBeVisible()
  })

  test('shows status filter pills', async ({ page }) => {
    // Status filter UI
    await expect(page.locator('button').filter({ hasText: /all/i }).first()).toBeVisible()
  })

  test('search filters sessions', async ({ page }) => {
    await page.locator('input[placeholder*="Search"]').fill('xyz123nonexistent')
    // Should show empty state
    await expect(page.locator('text=/no sessions/i')).toBeVisible({ timeout: 3000 })
  })
})
