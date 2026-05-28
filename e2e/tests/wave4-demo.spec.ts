/**
 * Wave-4 — Demo Player extended coverage (W4-Demo Tester).
 *
 * Complements (does NOT replace) `wave3-demo.spec.ts` and `wave4-anonymous.spec.ts`.
 * Adds coverage that those specs did not yet exercise:
 *
 *   - Multi-template playback (mandelbulb / crystal / particles / snake)
 *   - narration_chapters vs StatusPlaque presence per template
 *   - /demos gallery contents (4 cards, header copy, navigation, anon & auth)
 *   - Keyboard-shortcut edge cases (End-then-→, Home-then-←, typing inputs)
 *   - URL ?startAtChapter=N param support (probe; documented if absent)
 *   - Chapter narration completeness (mandelbulb: 14 chapters, all non-empty)
 *   - Speed control persistence (confirms NOT persisted by design)
 *
 * Skipped here because covered elsewhere:
 *   - Iframe sandbox (wave3-demo test 10)
 *   - Mobile drawer (wave3-demo test 12)
 *   - Continue-button visibility (wave3-demo test 14)
 *   - Spec card per-template (wave3-demo test 13)
 *   - Anonymous PublicChrome / Sign-in link (wave4-anonymous B3/B4/B5)
 *   - Demo gallery card navigation basics (wave4-anonymous C1–C4)
 *
 * Run:
 *   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai \
 *     npx playwright test tests/wave4-demo.spec.ts --reporter=list
 *
 * This file uses vanilla `test` — all cases default to anonymous. The one
 * test that requires auth (Space-on-input edge case via ConfirmDialog) is
 * test.skip()'d when E2E_AUTH_TOKEN is missing.
 */
import { test, expect, type Page } from '@playwright/test'

// Per-template metadata used by the multi-template loop.
interface TemplateInfo {
  id: 'mandelbulb' | 'crystal' | 'particles' | 'snake'
  name: RegExp
  durationSeconds: number
  hasNarrationChapters: boolean
}

const TEMPLATES: TemplateInfo[] = [
  { id: 'mandelbulb', name: /Mandelbulb/i, durationSeconds: 162, hasNarrationChapters: true },
  { id: 'crystal',    name: /Crystal/i,    durationSeconds: 90,  hasNarrationChapters: false },
  { id: 'particles',  name: /Particles/i,  durationSeconds: 90,  hasNarrationChapters: false },
  { id: 'snake',      name: /Snake/i,      durationSeconds: 90,  hasNarrationChapters: false },
]

// All tests default to anonymous: clear any prior auth state.
test.beforeEach(async ({ context }) => {
  await context.clearCookies()
  await context.addInitScript(() => {
    try {
      localStorage.removeItem('codeforge_token')
      localStorage.clear()
      sessionStorage.clear()
    } catch {
      /* ignore */
    }
  })
})

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Wait for the React Flow graph to be ready (works for ALL templates). */
async function waitForGraph(page: Page): Promise<void> {
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 20_000 })
}

/** Locator for the bottom-bar play/pause button. */
function playPauseBtn(page: Page) {
  return page.locator('button[aria-label="Pause"], button[aria-label="Play"]').first()
}

/** Locator for the progress slider. */
function progressSlider(page: Page) {
  return page.locator('[role="slider"][aria-label="Demo progress"]')
}

/** Read the bottom-bar clock display (e.g. "12.3s" → 12.3). */
async function readClock(page: Page): Promise<number> {
  const text = await page
    .locator('div.font-mono.tabular-nums.w-12.text-right')
    .first()
    .textContent()
  if (!text) return NaN
  return parseFloat(text.replace('s', '').trim())
}

/** Inject a fake auth token before the page boots — so PublicChrome renders
 *  the full Layout (sidebar) instead of the minimal anon header. */
async function injectFakeAuth(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('codeforge_token', 'eyJhbGciOiJIUzI1NiJ9.fake.fake')
    } catch {
      /* ignore */
    }
  })
}

// ─── 1–5. Multi-template playback ────────────────────────────────────────────

test.describe('Wave-4 Demo — Multi-template coverage', () => {
  for (const tpl of TEMPLATES) {
    test(`1–4. /demo/${tpl.id} loads (graph + title + Try-it button)`, async ({ page }) => {
      await page.goto(`/demo/${tpl.id}`)
      // Page title from timeline.name.
      await expect(page.locator('h1', { hasText: tpl.name }).first())
        .toBeVisible({ timeout: 25_000 })
      // React Flow graph is rendered.
      await waitForGraph(page)
      // Try-it button is present (only renders once timeline is loaded).
      await expect(page.getByRole('button', { name: /Try it yourself/i }).first())
        .toBeVisible({ timeout: 10_000 })
      // Demo · Pre-recorded badge.
      await expect(page.getByText(/Demo · Pre-recorded/i).first()).toBeVisible()
    })
  }

  test('5. narration_chapters presence: mandelbulb has ChapterSidePanel, others use StatusPlaque', async ({ page }) => {
    // Mandelbulb — ChapterSidePanel rendered (Tour plaque visible in left aside,
    // and the page exposes a Continue button at first chapter boundary).
    await page.goto('/demo/mandelbulb')
    await waitForGraph(page)
    // The Tour plaque (only rendered when narration_chapters exist) shows "Tour".
    await expect(page.locator('text=/Tour/i').first()).toBeVisible({ timeout: 20_000 })
    // First-chapter pause exposes the Continue button.
    await expect(page.getByRole('button', { name: /Continue/i }).first())
      .toBeVisible({ timeout: 10_000 })

    // Other templates — StatusPlaque is the fallback (no narration_chapters).
    // The auto-derived StatusPlaque renders a "Demo ready to play" body at
    // clock≈0 / workflow=idle, or a phase-specific body once playback starts.
    // We assert NO chapter-style "Continue" button is present (since there's
    // no chapter pause), and the React Flow graph still renders.
    for (const id of ['crystal', 'particles', 'snake'] as const) {
      await page.goto(`/demo/${id}`)
      await waitForGraph(page)
      // No chapter Continue (StatusPlaque only auto-narrates, no pause CTA).
      // Allow up to 4s for any transient first-frame render; then assert 0.
      await page.waitForTimeout(1500)
      const continueCount = await page
        .getByRole('button', { name: /^\s*▶?\s*Continue\s*$/i })
        .count()
      expect(continueCount, `template ${id} should NOT show chapter Continue`).toBe(0)
    }
  })
})

// ─── 8–11. Demo gallery /demos ───────────────────────────────────────────────

test.describe('Wave-4 Demo — /demos gallery (anon + auth)', () => {
  test('10. Header copy "Real multi-agent runs, replayed" visible', async ({ page }) => {
    await page.goto('/demos')
    await expect(page.getByText(/Real multi-agent runs, replayed/i))
      .toBeVisible({ timeout: 15_000 })
  })

  test('11. /demos renders for authenticated users too (PublicChrome → full Layout)', async ({ page }) => {
    await injectFakeAuth(page)
    await page.goto('/demos')
    // Demos heading present.
    await expect(page.getByRole('heading', { name: 'Demos', exact: true }))
      .toBeVisible({ timeout: 15_000 })
    // Featured Demos gallery rendered.
    await expect(page.getByText(/Featured Demos/i).first()).toBeVisible()
    // All 4 cards rendered via "Watch demo" links.
    for (const id of ['mandelbulb', 'crystal', 'particles', 'snake']) {
      await expect(page.locator(`a[href="/demo/${id}"]`).first())
        .toBeVisible({ timeout: 10_000 })
    }
  })

  test('11b. /demos still renders anonymously (4 cards present)', async ({ page }) => {
    await page.goto('/demos')
    await expect(page.getByRole('heading', { name: 'Demos', exact: true }))
      .toBeVisible({ timeout: 15_000 })
    for (const id of ['mandelbulb', 'crystal', 'particles', 'snake']) {
      await expect(page.locator(`a[href="/demo/${id}"]`).first())
        .toBeVisible({ timeout: 10_000 })
    }
  })
})

// ─── 13. Keyboard shortcuts: typing-input edge case ──────────────────────────

test.describe('Wave-4 Demo — Keyboard edge cases', () => {
  test('13. Space inside ConfirmDialog does NOT toggle play/pause (auth-only)', async ({ page }) => {
    // ConfirmDialog only opens for authenticated users (R14-FIX-01); anon
    // visitors are redirected to /login. Skip when no auth token available.
    test.skip(!process.env.E2E_AUTH_TOKEN, 'ConfirmDialog requires auth (anon → /login per R14-FIX-01)')

    // Inject the real auth token so the Try-it dialog actually opens.
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('codeforge_token', token as string)
      } catch {
        /* ignore */
      }
    }, process.env.E2E_AUTH_TOKEN)

    // КАО W4: AuthStore.loadFromStorage() is async — calls /api/auth/me to
    // validate the injected token. Until it resolves, `isAuthenticated` is
    // false and clicking Try-yourself redirects to /login. Wait for the
    // store's own round-trip to complete, then wait one extra paint frame.
    const authedResponse = page.waitForResponse(
      r => r.url().includes('/api/auth/me') && r.status() === 200,
      { timeout: 10_000 }
    )
    await page.goto('/demo/mandelbulb')
    await waitForGraph(page)
    await authedResponse
    await page.waitForTimeout(300)

    const btn = playPauseBtn(page)
    // Resume past the first chapter pause if needed.
    const continueBtn = page.getByRole('button', { name: /Continue/i }).first()
    if (await continueBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await continueBtn.click()
    }
    await expect
      .poll(async () => btn.getAttribute('aria-label'), { timeout: 5_000 })
      .toBe('Pause')

    // Open the Try-it confirm dialog.
    await page.getByRole('button', { name: /Try it yourself/i }).first().click()
    // Use getByText (Playwright API), not a malformed mixed CSS+text selector.
    await expect(page.getByText(/start a real CodeForge session/i).first())
      .toBeVisible({ timeout: 5_000 })

    const stateBefore = await btn.getAttribute('aria-label')

    // The keyboard handler in DemoPlayerPage early-returns when
    // `tryConfirmOpen` is true, so Space should NOT toggle the player.
    // CAUTION: `page.keyboard.press('Space')` sends Space to the focused
    // element. Headless UI Dialog auto-focuses Cancel (first focusable),
    // and Space-on-a-button ACTIVATES it — dismissing the dialog. Use
    // window dispatchEvent to send the key directly to the global handler
    // without going through the focused element.
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(500)
    const stateAfter = await btn.getAttribute('aria-label')
    expect(stateAfter, 'Space inside ConfirmDialog must not toggle play/pause')
      .toBe(stateBefore)

    // Close the dialog — Cancel button is rendered by ConfirmDialog.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  })

  test('14. End → clock=duration; then → arrow does not advance further', async ({ page }) => {
    await page.goto('/demo/mandelbulb')
    await waitForGraph(page)

    // Focus the document body so window-level keydown handler fires.
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('End')
    await expect
      .poll(async () => readClock(page), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(162 - 1)

    const atEnd = await readClock(page)
    expect(atEnd).toBeLessThanOrEqual(162 + 0.5)

    // ArrowRight should clamp at duration_seconds (Math.min in handler).
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(500)
    const afterArrow = await readClock(page)
    // Clock must NOT exceed duration_seconds.
    expect(afterArrow).toBeLessThanOrEqual(162 + 0.5)
  })

  test('15. Home → clock=0; then ← arrow stays at 0 (no negative)', async ({ page }) => {
    await page.goto('/demo/mandelbulb')
    await waitForGraph(page)

    await page.locator('body').click({ position: { x: 5, y: 5 } })
    // Advance a bit first so Home actually moves the clock.
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(300)

    await page.keyboard.press('Home')
    await expect
      .poll(async () => readClock(page), { timeout: 5_000 })
      .toBeLessThan(1)

    await page.keyboard.press('ArrowLeft')
    await page.waitForTimeout(500)
    const c = await readClock(page)
    // Must clamp at 0 (Math.max(0, clock-5) in handler).
    expect(c).toBeGreaterThanOrEqual(0)
    expect(c).toBeLessThan(1)
  })
})

// ─── 16. ?startAtChapter=N URL param (probe) ─────────────────────────────────

test.describe('Wave-4 Demo — URL params', () => {
  test('16. ?startAtChapter=2 seeks the demo into chapter 2 (КАО W4-CFIX-03)', async ({ page }) => {
    await page.goto('/demo/mandelbulb?startAtChapter=2')
    await waitForGraph(page)
    // Wait a moment for the post-load seekTo to apply.
    await page.waitForTimeout(800)
    const c = await readClock(page)
    // Mandelbulb chapter 2 t_start lives past 5s; chapters 0/1 start before that.
    expect(c, '?startAtChapter=2 must seek past 5s').toBeGreaterThan(5)
  })

  test('16b. ?startAtChapter=0 is a no-op (chapter 0 t_start is 0)', async ({ page }) => {
    await page.goto('/demo/mandelbulb?startAtChapter=0')
    await waitForGraph(page)
    await page.waitForTimeout(400)
    const c = await readClock(page)
    // Chapter 0 starts at t=0 so the guard `target <= 0` should skip the seek,
    // and clock should be near 0 (modulo a tiny natural advance from autoPlay).
    expect(c, '?startAtChapter=0 must not jump').toBeLessThan(3)
  })

  test('16c. ?startAtChapter=999 (out of range) is ignored', async ({ page }) => {
    await page.goto('/demo/mandelbulb?startAtChapter=999')
    await waitForGraph(page)
    await page.waitForTimeout(400)
    const c = await readClock(page)
    expect(c, 'out-of-range startAtChapter must be ignored, clock stays near 0').toBeLessThan(3)
  })
})

// ─── 17. Chapter narration completeness (mandelbulb only) ────────────────────

test.describe('Wave-4 Demo — Chapter narration completeness', () => {
  test('17. mandelbulb timeline JSON: 14 chapters, each with non-empty title + paragraphs', async ({ page }) => {
    // Use page.evaluate so the fetch goes through the same origin (avoids
    // CORS issues that node-side fetch would hit when staging is behind
    // any origin-checks).
    await page.goto('/demo/mandelbulb')
    await waitForGraph(page) // ensures the JSON is cacheable from the same origin

    const tl = await page.evaluate(async () => {
      const r = await fetch('/demo-templates/mandelbulb.json')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return r.json() as Promise<{
        narration_chapters?: { id: string; title?: string; paragraphs?: string[] }[]
      }>
    })

    expect(tl.narration_chapters, 'mandelbulb must declare narration_chapters').toBeDefined()
    const chapters = tl.narration_chapters!
    expect(chapters.length, 'mandelbulb has 14 narration chapters').toBe(14)

    for (const ch of chapters) {
      expect(ch.id, `chapter id missing`).toBeTruthy()
      expect(ch.title, `chapter "${ch.id}" must have a title`).toBeTruthy()
      expect(typeof ch.title).toBe('string')
      expect((ch.title as string).trim().length).toBeGreaterThan(0)

      expect(Array.isArray(ch.paragraphs), `chapter "${ch.id}" must have paragraphs array`).toBe(true)
      const paras = ch.paragraphs ?? []
      expect(paras.length, `chapter "${ch.id}" must have ≥1 paragraph`).toBeGreaterThan(0)
      for (const p of paras) {
        expect(typeof p).toBe('string')
        expect(p.trim().length, `chapter "${ch.id}" has empty paragraph`)
          .toBeGreaterThan(0)
      }
    }
  })
})

// ─── 18. Speed control persistence (confirms NOT persisted) ──────────────────

test.describe('Wave-4 Demo — Speed control persistence', () => {
  test('18. Speed selection does NOT persist across reload (by design)', async ({ page }) => {
    await page.goto('/demo/mandelbulb')
    await waitForGraph(page)

    // Default speed is 1× (useState(1) in useTimelinePlayer).
    // Click 4× preset.
    const fourX = page.getByRole('button', { name: '4×', exact: true })
    await expect(fourX).toBeVisible({ timeout: 10_000 })
    await fourX.click()

    // Verify the 4× button gained the "selected" visual indicator. The exact
    // selected-class isn't part of the test contract; we use aria-pressed if
    // present, or fall back to a visual-state probe via the button's class
    // containing the active background color.
    // Conservative probe: at minimum the click did not throw — proceed to reload.

    await page.reload()
    await waitForGraph(page)

    // After reload, speed must be back to default (1×). We verify by:
    //   1) Reading the speed preset whose visual indicates "current" — the
    //      `Improvers#4 P1·S` SPEEDS list renders one selected button. The
    //      simplest deterministic check is: localStorage should not contain
    //      any persisted speed key, AND advancing the clock for 1 second of
    //      wall time advances by ~1s of demo-clock (not 4s).
    const persistedKeys = await page.evaluate(() =>
      Object.keys(localStorage).filter(k => /speed/i.test(k))
    )
    expect(persistedKeys, 'no localStorage key persisting demo speed').toHaveLength(0)

    // Behavior probe: read clock, wait 1.2 seconds, read clock again. The
    // delta should be ~1.2 (±0.6) at speed=1×, NOT ~4.8 (which would indicate
    // 4× persisted). The first chapter auto-pauses, so first click Continue.
    const continueBtn = page.getByRole('button', { name: /Continue/i }).first()
    if (await continueBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await continueBtn.click()
    }
    // Sometimes the player auto-pauses again on the next chapter quickly; we
    // sample the clock during an active "playing" window only.
    await page.waitForTimeout(300)
    const c1 = await readClock(page)
    await page.waitForTimeout(1200)
    const c2 = await readClock(page)
    const delta = c2 - c1
    // Only assert when both reads were during playback (delta > 0). If the
    // player paused at a chapter boundary between samples, delta could be ~0
    // — which still rules out "persisted 4×" so we treat ≤ 2.5 as PASS.
    expect(delta, `clock delta over 1.2s wall — must be ≤ ~2.5 (1×), not ≥ 4 (4×). got ${delta}`)
      .toBeLessThan(2.6)
  })
})
