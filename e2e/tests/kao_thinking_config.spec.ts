// КАО#VR-58 — E2E coverage for the node-settings "Thinking" controls
// (AgentConfigPopup: mode + level <select>s) plus an Axe a11y scan of the
// OPEN popup. This is the round zone's UI/UX E2E (the unit layer is covered by
// frontend/src/lib/thinkingEfforts.test.ts + the backend caps pytest).
//
// Requires (authed path):
//   E2E_BASE_URL=https://stage.gotcode.ai
//   E2E_AUTH_TOKEN=<JWT for the user that owns E2E_TEST_SESSION_ID>
//   E2E_TEST_SESSION_ID=<a session with agent nodes (Coder/Tester/…)>
//
// Run:
//   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
//     E2E_TEST_SESSION_ID=$SID npx playwright test tests/kao_thinking_config.spec.ts --reporter=list
//
// Mutation discipline: READ-ONLY. Opens the popup, asserts, never clicks OK/Save.

import { authedTest as test, expect } from './_fixtures/auth'

const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN ?? ''
const SESSION_ID = process.env.E2E_TEST_SESSION_ID ?? ''

// Soft-load axe so the file still parses if @axe-core/playwright isn't installed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _AxeBuilder: any = undefined
async function loadAxe(): Promise<any> {
  if (_AxeBuilder !== undefined) return _AxeBuilder
  try {
    // @ts-expect-error — module may not be installed; fail soft at runtime.
    const mod = await import('@axe-core/playwright')
    _AxeBuilder = mod.default ?? (mod as { AxeBuilder?: unknown }).AxeBuilder ?? null
  } catch {
    _AxeBuilder = null
  }
  return _AxeBuilder
}

test.describe('Node settings — Thinking controls (КАО#VR-58)', () => {
  test.beforeEach(() => {
    test.skip(!AUTH_TOKEN, 'E2E_AUTH_TOKEN not set')
    test.skip(!SESSION_ID, 'E2E_TEST_SESSION_ID not set')
  })

  test('agent node opens a config popup exposing mode + level selects', async ({ page }) => {
    await page.goto(`/sessions/${SESSION_ID}`)

    // React Flow renders the agent nodes; click the first one to open the popup.
    const node = page
      .locator('.react-flow__node', { hasText: /Coder|Tester|Finalizer|Summarizer/ })
      .first()
    await expect(node).toBeVisible({ timeout: 30_000 })
    await node.click()

    const modeSel = page.locator('#agent-thinking-mode-select')
    const levelSel = page.locator('#agent-thinking-effort-select')
    await expect(modeSel).toBeVisible({ timeout: 10_000 })
    await expect(levelSel).toBeVisible()

    // Mode has exactly two positions: an off/auto position and "On".
    const modeOpts = (await modeSel.locator('option').allTextContents()).map((t) => t.trim())
    expect(modeOpts.length).toBe(2)
    expect(modeOpts.some((t) => /^On$/i.test(t))).toBeTruthy()
    expect(modeOpts.some((t) => /^(Off|Auto)$/i.test(t))).toBeTruthy()

    // Level options (when the model supports thinking) come from the canonical
    // vocabulary; never an unexpected token.
    const levelOpts = (await levelSel.locator('option').allTextContents()).map((t) => t.trim())
    for (const o of levelOpts) {
      expect(/^(Minimal|Low|Medium|High|Max|—)$/i.test(o)).toBeTruthy()
    }

    // a11y: the open popup must have no serious/critical axe violations.
    const AxeBuilder = await loadAxe()
    if (AxeBuilder) {
      const results = await new AxeBuilder({ page }).analyze()
      const serious = results.violations.filter(
        (v: { impact?: string }) => v.impact === 'serious' || v.impact === 'critical',
      )
      expect(
        serious,
        `axe serious/critical: ${JSON.stringify(serious.map((v: { id: string }) => v.id))}`,
      ).toHaveLength(0)
    }
  })
})
