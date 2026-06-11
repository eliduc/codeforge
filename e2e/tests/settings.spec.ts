import { test, expect } from '@playwright/test'
import { injectAuth } from './_fixtures/auth'  // КАО#R4-S14

test.describe('Settings', () => {
  test.beforeEach(async ({ page, context }) => {
    const token = process.env.E2E_AUTH_TOKEN
    if (!token) test.skip()
    await injectAuth(context)  // КАО#R4-S14
    await page.goto('/settings')
  })

  test('shows providers list', async ({ page }) => {
    await expect(page.getByText(/openai|anthropic|google|grok|ollama/i).first()).toBeVisible({ timeout: 5000 })
  })

  test('shows webhooks section', async ({ page }) => {
    await expect(page.getByText(/webhook/i).first()).toBeVisible()
  })
})
