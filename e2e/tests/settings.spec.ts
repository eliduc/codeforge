import { test, expect } from '@playwright/test'

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    const token = process.env.E2E_AUTH_TOKEN
    if (!token) test.skip()
    await page.addInitScript((t) => localStorage.setItem('codeforge_token', t), token)
    await page.goto('/settings')
  })

  test('shows providers list', async ({ page }) => {
    await expect(page.getByText(/openai|anthropic|google|grok|ollama/i).first()).toBeVisible({ timeout: 5000 })
  })

  test('shows webhooks section', async ({ page }) => {
    await expect(page.getByText(/webhook/i).first()).toBeVisible()
  })
})
