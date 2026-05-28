import { test, expect } from '@playwright/test'

test.describe('Security headers', () => {
  test('response includes security headers', async ({ request }) => {
    const response = await request.get('/health')
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
    expect(response.headers()['x-frame-options']).toBe('DENY')
    expect(response.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin')
  })

  test('sessions endpoint requires auth', async ({ request }) => {
    const response = await request.get('/api/sessions/')
    expect(response.status()).toBe(401)
  })
})
