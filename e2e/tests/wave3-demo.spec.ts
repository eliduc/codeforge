import { test, expect, Page } from '@playwright/test'

/**
 * Round 14 — Team 1 (Test-Writer): Demo Player Wave 1–3 specs.
 *
 * Anonymous tests against the pre-recorded `mandelbulb` demo on the staging
 * environment. Each test is independent; clipboard permissions are granted
 * via context.grantPermissions where needed. Some tests will fail — those
 * failures are the bugs Team 3 will triage downstream.
 *
 * Target URL: /demo-player/mandelbulb (duration_seconds = 162)
 */

// Spec said `/demo-player/mandelbulb` but the actual route in App.tsx is
// `/demo/:templateId`. Using the real path.
const DEMO_URL = '/demo/mandelbulb'
const CRYSTAL_URL = '/demo/particles'  // КАО#R4-S13 — crystal removed; particles is the current 5th demo
const DURATION = 162

/** Wait for the demo player UI to be ready: TOUR plaque + React Flow graph. */
async function waitForPlayerReady(page: Page) {
  // The "TOUR" badge is rendered inside the ChapterSidePanel once the first
  // chapter activates (auto-pauses immediately). Use a regex to allow for
  // surrounding icon text.
  await expect(page.locator('text=/Tour/i').first()).toBeVisible({ timeout: 20_000 })
  // React Flow root.
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 10_000 })
}

/** Locator for the bottom-bar play/pause button (aria-label flips). */
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

test.describe('Wave 1–3 — Demo Player (mandelbulb)', () => {
  test('1. Page loads and player initializes', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)
    // Bottom controls present.
    await expect(playPauseBtn(page)).toBeVisible()
    await expect(progressSlider(page)).toBeVisible()
  })

  test('2. Speed presets include 60× (Wave 1)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    const expected = ['0.5×', '1×', '2×', '4×', '8×', '16×', '60×']
    for (const label of expected) {
      // Match buttons whose exact text is the label (avoids matching "10×" etc.).
      const btn = page.getByRole('button', { name: label, exact: true })
      await expect(btn, `speed preset "${label}" should be visible`).toBeVisible()
    }
  })

  test('3. Keyboard play/pause (Wave 1 P1·M)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    // КАО R14: the first chapter auto-pauses. Click Continue first to enter a
    // stable "playing=true" state so Space toggle isn't racing the Wave-3
    // chapter-pause routing. Note: button label is "▶ Continue" (with arrow),
    // so the regex must match flexibly.
    const continueBtn = page.getByRole('button', { name: /Continue/i }).first()
    if (await continueBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await continueBtn.click()
    }

    const btn = playPauseBtn(page)
    await expect
      .poll(async () => btn.getAttribute('aria-label'), { timeout: 5_000 })
      .toBe('Pause')

    // КАО R14: dispatch Space keydown directly on window so React Flow's
    // canvas doesn't swallow it. The global handler in DemoPlayerPage listens
    // on `window`, not on a focused element.
    const pressSpace = () =>
      page.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
      })

    await pressSpace()
    await expect
      .poll(async () => btn.getAttribute('aria-label'), { timeout: 5_000 })
      .toBe('Play')

    await pressSpace()
    await expect
      .poll(async () => btn.getAttribute('aria-label'), { timeout: 5_000 })
      .toBe('Pause')
  })

  test('4. Keyboard seek End/Home (Wave 1)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('End')
    await expect
      .poll(async () => readClock(page), { timeout: 5_000 })
      .toBeGreaterThanOrEqual(DURATION - 1)

    await page.keyboard.press('Home')
    await expect
      .poll(async () => readClock(page), { timeout: 5_000 })
      .toBeLessThan(1)
  })

  test('5. Progress slider role and aria (Wave 1 P1·M)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    const slider = progressSlider(page)
    await expect(slider).toBeVisible()
    await expect(slider).toHaveAttribute('role', 'slider')
    await expect(slider).toHaveAttribute('aria-valuemin', '0')
    await expect(slider).toHaveAttribute('aria-valuemax', String(DURATION))
    await expect(slider).toHaveAttribute('tabindex', '0')

    // aria-valuenow exists and is a finite number ≥ 0.
    const valueNow = await slider.getAttribute('aria-valuenow')
    expect(valueNow).not.toBeNull()
    const parsed = parseFloat(valueNow ?? '')
    expect(Number.isFinite(parsed)).toBe(true)
    expect(parsed).toBeGreaterThanOrEqual(0)
  })

  test('6. Progress slider keyboard seek (Wave 1)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    const slider = progressSlider(page)
    await slider.focus()

    const before = await readClock(page)
    await page.keyboard.press('ArrowRight')
    await expect
      .poll(async () => readClock(page), { timeout: 3_000 })
      .toBeGreaterThan(before + 3) // ≥ ~5s

    const mid = await readClock(page)
    await page.keyboard.press('ArrowLeft')
    await expect
      .poll(async () => readClock(page), { timeout: 3_000 })
      .toBeLessThan(mid - 3)
  })

  test('7. "What next" CTA appears after finish (Wave 1 P1·M)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('End')

    const cta = page.locator('[role="region"][aria-label="Demo complete — what next"]')
    await expect(cta).toBeVisible({ timeout: 10_000 })
    await expect(cta.getByRole('button', { name: /View final result/i })).toBeVisible()
    await expect(cta.getByRole('button', { name: /Try it yourself/i })).toBeVisible()
    await expect(cta.getByRole('button', { name: /Replay/i })).toBeVisible()
    await expect(cta.getByRole('button', { name: /Copy link/i })).toBeVisible()
  })

  test('8. Copy-link CTA copies URL', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('End')

    const cta = page.locator('[role="region"][aria-label="Demo complete — what next"]')
    await expect(cta).toBeVisible({ timeout: 10_000 })
    await cta.getByRole('button', { name: /Copy link/i }).click()

    // Wait briefly for clipboard write to complete.
    await expect
      .poll(async () => {
        try {
          return await page.evaluate(() => navigator.clipboard.readText())
        } catch {
          return ''
        }
      }, { timeout: 5_000 })
      .toContain('/demo/mandelbulb')
  })

  test('9. Try-it-yourself shows confirm dialog (Wave 1 P1·M)', async ({ page }) => {
    // КАО R14-FIX-01: anonymous click now navigates to /login (with from-path)
    // instead of opening ConfirmDialog. Auth users still see the dialog —
    // test that path only when E2E_AUTH_TOKEN is provided.
    test.skip(!process.env.E2E_AUTH_TOKEN, 'ConfirmDialog only for authenticated users; anonymous → /login (test 9b below)')

    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    await page.getByRole('button', { name: /Try it yourself/i }).first().click()

    const dialogText = page.locator('text=/start a real CodeForge session/i')
    await expect(dialogText).toBeVisible({ timeout: 5_000 })

    await page.getByRole('button', { name: /^Cancel$/ }).click()
    await expect(dialogText).toBeHidden({ timeout: 5_000 })

    expect(page.url()).toContain('/demo/mandelbulb')
  })

  test('9b. Try-it-yourself anonymous → /login redirect (КАО R14-FIX-01)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    await page.getByRole('button', { name: /Try it yourself/i }).first().click()
    await page.waitForURL(/\/login/, { timeout: 5_000 })
    expect(page.url()).toContain('/login')
  })

  test('10. Iframe sandbox is tight (Wave 3 P2·S)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('End')

    // Wait for the post-completion CTA to confirm finished.
    await expect(page.locator('[role="region"][aria-label="Demo complete — what next"]'))
      .toBeVisible({ timeout: 10_000 })

    // Switch to Final result tab. Use exact match so we don't ambiguously hit
    // the "▶ View final result" button inside the post-completion CTA.
    await page.getByRole('tab', { name: 'Final result' }).click()  // КАО#R4-S13 — R3-M4 made it a tab

    const iframe = page.locator('iframe[title="Demo final result"]')
    await expect(iframe).toBeVisible({ timeout: 10_000 })

    const sandbox = await iframe.getAttribute('sandbox')
    expect(sandbox, 'iframe must have a sandbox attribute').not.toBeNull()
    expect(sandbox!).toContain('allow-scripts')
    expect(sandbox!).not.toContain('allow-same-origin')
  })

  test('11. Skip-to-result button (Wave 3 P2·S)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    // Early in playback — clock should still be small.
    const earlyClock = await readClock(page)
    expect(earlyClock).toBeLessThan(20)

    // Switch to Final result tab — placeholder + Skip-to-result button.
    await page.getByRole('tab', { name: /Final result/i }).click()  // КАО#R4-S13

    const skipBtn = page.getByRole('button', { name: /Skip to result/i })
    await expect(skipBtn).toBeVisible({ timeout: 5_000 })

    await skipBtn.click()

    // After click, demo should seek to end → iframe replaces placeholder.
    await expect(page.locator('iframe[title="Demo final result"]'))
      .toBeVisible({ timeout: 10_000 })
  })

  test('12. Mobile drawer at narrow viewport (Wave 2 P1·L)', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto(DEMO_URL)
    // Wait for graph; on mobile the aside is hidden so we look for the
    // bottom "Tour" toggle instead of the aside-rendered plaque.
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 15_000 })

    // The 300px aside should NOT be present at this viewport.
    const aside = page.locator('aside.w-\\[300px\\]')
    await expect(aside).toHaveCount(0)

    // Mobile "Tour" toggle button at the bottom of the graph area.
    const tourToggle = page.getByRole('button', { name: /Tour/i }).first()
    await expect(tourToggle).toBeVisible({ timeout: 10_000 })

    await tourToggle.click()
    // After opening, the drawer body (aria-label="Tour narration") should
    // become visible.
    await expect(page.locator('[aria-label="Tour narration"]'))
      .toBeVisible({ timeout: 5_000 })
  })

  test('13. Spec card per-template namespacing (Wave 3 P3·S)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    // Open the spec panel by clicking the Spec node (it auto-opens during the
    // Specification chapter; if not, click the spec node). The collapse toggle
    // button has title="Hide specification" when expanded.
    const hideBtn = page.locator('button[title="Hide specification"]').first()
    if (await hideBtn.count() > 0) {
      await hideBtn.click()
    }
    // Now it should be collapsed → title flips to "Show specification".
    await expect(page.locator('button[title="Show specification"]').first())
      .toBeVisible({ timeout: 5_000 })

    // Navigate to a different template.
    await page.goto(CRYSTAL_URL)
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 20_000 })

    // The crystal spec card should be expanded (independent state) — i.e. a
    // "Hide specification" button should be present (not "Show").
    // The spec panel is mounted when the spec chapter is active OR the spec
    // node is clicked; auto-pauses on first chapter exposes it.
    await expect(page.locator('button[title="Hide specification"]').first())
      .toBeVisible({ timeout: 10_000 })

    // Navigate back to mandelbulb — state should be remembered as collapsed.
    await page.goto(DEMO_URL)
    await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('button[title="Show specification"]').first())
      .toBeVisible({ timeout: 10_000 })
  })

  test('14. Continue button hidden mid-chapter (Wave 2 P1·M)', async ({ page }) => {
    await page.goto(DEMO_URL)
    await waitForPlayerReady(page)

    // At demo start, first chapter is paused (pausedForChapter=true) so
    // Continue IS visible.
    const continueBtn = page.getByRole('button', { name: /Continue/i }).first()
    await expect(continueBtn).toBeVisible({ timeout: 5_000 })

    // Click Continue to enter playing state, then verify mid-chapter
    // (clock advances, not paused) the Continue button is hidden.
    await continueBtn.click()

    // Wait until clock advances past 5s (well into a chapter, not at boundary).
    await expect
      .poll(async () => readClock(page), { timeout: 15_000 })
      .toBeGreaterThan(5)

    // Mid-chapter: the Continue button in the side panel should not be
    // rendered (the footer only shows Continue when paused).
    // Scope to the ChapterSidePanel aside on desktop.
    const asideContinue = page
      .locator('aside')
      .getByRole('button', { name: /Continue/i })
    // Allow that there might be NO matches OR all matches hidden.
    const count = await asideContinue.count()
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        await expect(asideContinue.nth(i)).toBeHidden()
      }
    }
  })
})
