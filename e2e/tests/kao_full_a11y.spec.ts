// КАО#Full-A1 — Accessibility audit (axe-core).
//
// Runs axe-core/playwright against each major route and fails on any
// violation whose impact is `serious` or `critical`. `minor` and `moderate`
// violations are logged via test.info().annotations so a tester can review
// them, but they don't fail the build (per КАО writeup — minor/suggestion
// fixed on user request).
//
// Mutation discipline
// -------------------
// READ-ONLY. axe.analyze() walks the DOM, doesn't interact.
//
// devDependency added
// -------------------
//   cd e2e && npm install --save-dev @axe-core/playwright
//
// Requires:
//   E2E_BASE_URL=https://stage.gotcode.ai
//   E2E_AUTH_TOKEN=<JWT>
//
// Run:
//   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
//     npx playwright test tests/kao_full_a11y.spec.ts --reporter=list

import { authedTest as test, expect, type Page } from './_fixtures/auth'

// КАО#Full-A1 — dynamic import wrapper so the file still parses if
// @axe-core/playwright hasn't been installed yet. The test itself
// soft-skips (with an explicit message) when the module is missing,
// so this spec never throws at collect time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _AxeBuilder: any = undefined
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

const AUTH_TOKEN = process.env.E2E_AUTH_TOKEN ?? ''

type Impact = 'minor' | 'moderate' | 'serious' | 'critical' | null
interface Violation {
  id: string
  impact: Impact
  description: string
  nodes: Array<{ html: string; target: string[] }>
}

async function auditPage(page: Page, label: string): Promise<void> {
  const Builder = await loadAxe()
  test.skip(!Builder, '@axe-core/playwright not installed — run `cd e2e && npm i -D @axe-core/playwright`')
  if (!Builder) return

  const results = await new Builder({ page }).analyze()
  const violations: Violation[] = results.violations ?? []

  const blocking = violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical'
  )
  const informational = violations.filter(
    (v) => v.impact === 'minor' || v.impact === 'moderate'
  )

  // Surface informational violations as annotations (non-blocking).
  for (const v of informational) {
    test.info().annotations.push({
      type: `a11y-${v.impact}`,
      description: `[${label}] ${v.id}: ${v.description} (${v.nodes.length} node(s))`,
    })
  }

  // Hard fail with full detail on serious / critical.
  if (blocking.length > 0) {
    // КАО#Full-C-4 — full JSON dump for fixer triage
    // eslint-disable-next-line no-console
    console.log(`\n===== AXE VIOLATIONS DUMP [${label}] =====`)
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(blocking, null, 2))
    // eslint-disable-next-line no-console
    console.log(`===== END DUMP [${label}] =====\n`)
    const detail = blocking
      .map(
        (v) =>
          `- ${v.impact?.toUpperCase()} · ${v.id}: ${v.description}\n` +
          v.nodes
            .map((n) => `    @ ${n.target.join(' >> ')}\n      HTML: ${n.html}`)
            .join('\n')
      )
      .join('\n')
    expect(blocking, `${label} a11y violations:\n${detail}`).toEqual([])
  }
}

test.describe('Full-A1 · Accessibility (axe-core)', () => {
  test('/login passes serious/critical axe checks', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('domcontentloaded')
    await page.locator('input[name="email"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    await auditPage(page, '/login')
  })

  test('/sessions passes serious/critical axe checks', async ({ page }) => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    await page.goto('/sessions')
    await page.getByRole('heading', { name: /^sessions$/i }).waitFor({ timeout: 8000 }).catch(() => {})
    await auditPage(page, '/sessions')
  })

  test('/sessions/new passes serious/critical axe checks', async ({ page }) => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    await page.goto('/sessions/new')
    await page.getByRole('heading', { name: /^new session$/i }).waitFor({ timeout: 8000 }).catch(() => {})
    await auditPage(page, '/sessions/new')
  })

  test('/settings passes serious/critical axe checks', async ({ page }) => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    await page.goto('/settings')
    await page.locator('h1').first().waitFor({ timeout: 8000 }).catch(() => {})
    await auditPage(page, '/settings')
  })

  test('/dashboard passes serious/critical axe checks', async ({ page }) => {
    test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    await page.goto('/dashboard')
    await page.locator('h1').first().waitFor({ timeout: 8000 }).catch(() => {})
    await auditPage(page, '/dashboard')
  })
})
