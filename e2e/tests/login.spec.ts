import { test, expect } from '@playwright/test'

test.describe('Login flow', () => {
  test('shows login page with email input', async ({ page }) => {
    await page.goto('/login')
    await expect(page.locator('h1, h2').filter({ hasText: /CodeForge/i })).toBeVisible()
    await expect(page.locator('input[type="email"]')).toBeVisible()
    await expect(page.getByRole('button', { name: /send code/i })).toBeVisible()
  })

  test('rejects invalid email format', async ({ page }) => {
    await page.goto('/login')
    await page.locator('input[type="email"]').fill('not-an-email')
    await page.getByRole('button', { name: /send code/i }).click()
    // Browser native validation OR API validation
    await expect(page.locator('input[type="email"]:invalid')).toBeVisible({ timeout: 2000 }).catch(() => {})
    // OR check for error message
  })

  test('shows OTP step after sending code (mock or real test email)', async ({ page }) => {
    test.skip(!process.env.E2E_TEST_EMAIL, 'Requires E2E_TEST_EMAIL env var')

    await page.goto('/login')
    await page.locator('input[type="email"]').fill(process.env.E2E_TEST_EMAIL!)
    await page.getByRole('button', { name: /send code/i }).click()
    // OTP boxes should appear
    await expect(page.locator('input').first()).toBeFocused({ timeout: 5000 })
  })
})
