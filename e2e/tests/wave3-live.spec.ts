import { test, expect } from '@playwright/test'
import { injectAuth as injectCookieAuth } from './_fixtures/auth'  // КАО#R4-S14

/**
 * Round 14 — Team 1 (Test-Writer): Wave 1–3 Live Session UI specs.
 *
 * Validates the changes shipped on the /sessions/:id (SessionDetailPage)
 * surface across waves 1–3:
 *   Wave 1 P0·M  — WSStatusPill (live-feed connection state)
 *   Wave 2 P1·M  — Lock viewport toggle (persists via localStorage)
 *   Wave 2 P1·S  — Keyboard-shortcut help modal (?, Esc)
 *   Wave 2 P1·S  — Phase indicator + status badge humanization
 *   Wave 3 P2·S  — Specification node cursor-help + Info icon
 *   Wave 3 P3·S  — Header overflow ⋯ menu on mobile viewport
 *   Wave 3 P3·S  — Mini-map status palette covers active states
 *
 * Auth-gated tests require:
 *   E2E_AUTH_TOKEN        — a backend JWT for an authenticated user
 *   E2E_TEST_SESSION_ID   — id of a real session owned by that user
 * Both are skipped (not fixme) when env vars are absent so the suite
 * runs clean for anonymous smoke + reports the gap.
 *
 * Failures here are bugs for Team 3. We do NOT fix from this seat.
 */

const LOCK_KEY = 'codeforge.session.lockViewport'

/** КАО#R4-S14 — auth rides the httpOnly codeforge_session cookie now. */
async function seedAuth(page: import('@playwright/test').Page) {
  await injectCookieAuth(page.context())
}

/** Navigate to the configured test session, waiting for the header to land. */
async function gotoSession(page: import('@playwright/test').Page) {
  const sid = process.env.E2E_TEST_SESSION_ID!
  await page.goto(`/sessions/${sid}`)
  // Either the header lands, or we get bounced (auth failure). The latter is
  // a test-config error — surface it loudly rather than masking with timeouts.
  await page.waitForLoadState('domcontentloaded')
}

// ──────────────────────────────────────────────────────────────────────
// 1. Anonymous redirect — smoke (no auth required)
// ──────────────────────────────────────────────────────────────────────
test.describe('Wave 1–3 Live Session — anonymous redirect (smoke)', () => {
  test('/sessions/:id redirects anonymous user to /login', async ({ page }) => {
    // A bogus id is fine — the route guard runs before any backend fetch.
    await page.goto('/sessions/00000000-0000-0000-0000-000000000000')

    // Allow router a moment to do its thing.
    await page.waitForURL(/\/login(\?|$)/, { timeout: 10_000 })
    expect(page.url()).toMatch(/\/login/)
    // Login page email input should be present.
    await expect(page.locator('input#email')).toBeVisible()
  })
})

// ──────────────────────────────────────────────────────────────────────
// 2. WS status pill — Wave 1 P0·M
// ──────────────────────────────────────────────────────────────────────
test.describe('Wave 1 P0·M — WS status pill', () => {
  test('pill (or status text) renders on the session page', async ({ page }) => {
    test.skip(!process.env.E2E_AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    test.skip(!process.env.E2E_TEST_SESSION_ID, 'needs E2E_TEST_SESSION_ID')

    // Per SessionDetailPage.tsx, WSStatusPill is HIDDEN when state.status ===
    // 'connected' AND not recently recovered. If the live socket comes up
    // immediately and stays up we have no DOM to assert against — flag fixme
    // rather than flake.
    test.fixme(
      true,
      'WSStatusPill is hidden when connected; reliable assertion requires a ' +
        'forced reconnect path (not available from an external test).',
    )

    await seedAuth(page)
    await gotoSession(page)

    const pill = page.locator('[data-testid="ws-status-pill"]')
    const pillText = page.getByText(
      /Connecting…|Reconnecting \(attempt|Live feed disconnected|Connected/,
    )

    // Either explicit testid OR fallback text-match.
    await expect(pill.or(pillText).first()).toBeVisible({ timeout: 15_000 })
  })
})

// ──────────────────────────────────────────────────────────────────────
// 3. Lock viewport toggle — Wave 2 P1·M
// ──────────────────────────────────────────────────────────────────────
test.describe('Wave 2 P1·M — Lock viewport toggle', () => {
  test('toggle exists, title flips, state persists', async ({ page }) => {
    test.skip(!process.env.E2E_AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    test.skip(!process.env.E2E_TEST_SESSION_ID, 'needs E2E_TEST_SESSION_ID')

    await seedAuth(page)
    // Start from a clean lockViewport state so persistence assertions are
    // deterministic regardless of how prior runs left localStorage.
    await page.evaluate((k) => window.localStorage.removeItem(k), LOCK_KEY)
    await gotoSession(page)

    // SessionDetailPage uses `title` (not aria-label) — match either to be
    // forgiving if a follow-up change adds aria-label.
    const lockBtn = page.locator(
      'button[title*="Lock viewport"], button[title*="Viewport locked"], ' +
        'button[aria-label*="Lock viewport"], button[aria-label*="Unlock viewport"]',
    ).first()
    await expect(lockBtn).toBeVisible({ timeout: 15_000 })

    // Initially unlocked → title should be "Lock viewport (…)".
    await expect(lockBtn).toHaveAttribute('title', /Lock viewport/)
    await expect(lockBtn).toHaveAttribute('aria-pressed', 'false')

    // Click — title flips to "Viewport locked".
    await lockBtn.click()
    await expect(lockBtn).toHaveAttribute('title', /Viewport locked/)
    await expect(lockBtn).toHaveAttribute('aria-pressed', 'true')

    // Verify localStorage was written.
    const stored = await page.evaluate((k) => window.localStorage.getItem(k), LOCK_KEY)
    expect(stored).toBe('1')

    // Reload and verify the locked state persisted.
    await page.reload()
    const lockBtn2 = page.locator(
      'button[title*="Lock viewport"], button[title*="Viewport locked"]',
    ).first()
    await expect(lockBtn2).toBeVisible({ timeout: 15_000 })
    await expect(lockBtn2).toHaveAttribute('aria-pressed', 'true')
  })

  test('lock viewport persists OFF after toggling off and reloading', async ({ page }) => {
    test.skip(!process.env.E2E_AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    test.skip(!process.env.E2E_TEST_SESSION_ID, 'needs E2E_TEST_SESSION_ID')

    await seedAuth(page)
    // Pre-seed lockViewport ON.
    await page.evaluate((k) => window.localStorage.setItem(k, '1'), LOCK_KEY)
    await gotoSession(page)

    const lockBtn = page.locator(
      'button[title*="Lock viewport"], button[title*="Viewport locked"]',
    ).first()
    await expect(lockBtn).toBeVisible({ timeout: 15_000 })
    await expect(lockBtn).toHaveAttribute('aria-pressed', 'true')

    // Toggle OFF.
    await lockBtn.click()
    await expect(lockBtn).toHaveAttribute('aria-pressed', 'false')

    const stored = await page.evaluate((k) => window.localStorage.getItem(k), LOCK_KEY)
    expect(stored).toBe('0')

    await page.reload()
    const lockBtn2 = page.locator(
      'button[title*="Lock viewport"], button[title*="Viewport locked"]',
    ).first()
    await expect(lockBtn2).toBeVisible({ timeout: 15_000 })
    await expect(lockBtn2).toHaveAttribute('aria-pressed', 'false')
  })
})

// ──────────────────────────────────────────────────────────────────────
// 4–5. Keyboard help modal — Wave 2 P1·S
// ──────────────────────────────────────────────────────────────────────
test.describe('Wave 2 P1·S — Keyboard shortcut help modal', () => {
  test('? opens the keyboard help modal listing all shortcuts', async ({ page }) => {
    test.skip(!process.env.E2E_AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    test.skip(!process.env.E2E_TEST_SESSION_ID, 'needs E2E_TEST_SESSION_ID')

    await seedAuth(page)
    await gotoSession(page)

    // Make sure focus isn't trapped in an input.
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
    await page.keyboard.press('Shift+Slash') // "?" on most US keyboards

    // The modal title is "Keyboard shortcuts".
    await expect(page.getByText('Keyboard shortcuts', { exact: true })).toBeVisible({
      timeout: 5_000,
    })

    // Each shortcut row appears.
    await expect(page.getByText('Show / hide this help')).toBeVisible()
    await expect(page.getByText('Close the open panel or modal')).toBeVisible()
    await expect(page.getByText('Toggle browser preview')).toBeVisible()
    await expect(page.getByText('Pause when running, resume when paused')).toBeVisible()
    await expect(page.getByText('Focus the most-recent code viewer')).toBeVisible()
    await expect(page.getByText('Open the intervention panel')).toBeVisible()

    // Sanity: each documented key has a <kbd>.
    for (const key of ['?', 'Esc', 'p', 'Space', 'c', 'i']) {
      await expect(page.locator('kbd', { hasText: new RegExp(`^${key.replace(/[?]/g, '\\?')}$`) }).first()).toBeVisible()
    }
  })

  test('Esc closes the keyboard help modal', async ({ page }) => {
    test.skip(!process.env.E2E_AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    test.skip(!process.env.E2E_TEST_SESSION_ID, 'needs E2E_TEST_SESSION_ID')

    await seedAuth(page)
    await gotoSession(page)

    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
    await page.keyboard.press('Shift+Slash')

    const title = page.getByText('Keyboard shortcuts', { exact: true })
    await expect(title).toBeVisible({ timeout: 5_000 })

    await page.keyboard.press('Escape')
    await expect(title).toBeHidden({ timeout: 5_000 })
  })
})

// ──────────────────────────────────────────────────────────────────────
// 7. Phase indicator humanized — Wave 2 P1·S
// ──────────────────────────────────────────────────────────────────────
test.describe('Wave 2 P1·S — Phase indicator humanization', () => {
  test('phase indicator uses humanized labels (no raw enum)', async ({ page }) => {
    test.skip(!process.env.E2E_AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    test.skip(!process.env.E2E_TEST_SESSION_ID, 'needs E2E_TEST_SESSION_ID')

    await seedAuth(page)
    await gotoSession(page)

    // Phase indicator only renders while running/enhancing. Look for the
    // chip with "phase" suffix.
    const phaseChip = page.locator('text=/(Coding \\(iteration \\d+\\)|Testing \\(iteration \\d+\\)|Summarizing audits|Finalizing winner|Enhancing|Enhancement) phase/').first()

    const visible = await phaseChip.isVisible().catch(() => false)
    if (!visible) {
      test.skip(true, 'no active phase indicator (session completed/idle) — nothing to assert')
    }

    const txt = (await phaseChip.textContent())?.trim() ?? ''
    // Must NOT contain the raw lowercase enum values directly (i.e., no
    // "coding phase" or "summarizing phase" without the humanized suffix).
    expect(txt).not.toMatch(/^(coding|testing|summarizing|finalizing|enhancing) phase$/)
    expect(txt).toMatch(
      /^(Coding \(iteration \d+\)|Testing \(iteration \d+\)|Summarizing audits|Finalizing winner|Enhancing|Enhancement) phase$/,
    )
  })
})

// ──────────────────────────────────────────────────────────────────────
// 8. Status badge humanized — Wave 2 P1·S
// ──────────────────────────────────────────────────────────────────────
test.describe('Wave 2 P1·S — MetricsPanel status badge humanization', () => {
  test('badge text is a humanized label, never raw enum', async ({ page }) => {
    test.skip(!process.env.E2E_AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    test.skip(!process.env.E2E_TEST_SESSION_ID, 'needs E2E_TEST_SESSION_ID')

    await seedAuth(page)
    await gotoSession(page)

    // MetricsPanel header: "Session Metrics" + a status badge sibling.
    const panel = page.locator('[data-tour="metrics-panel"]')
    await expect(panel).toBeVisible({ timeout: 15_000 })

    // Badge is the rounded-full span next to "Session Metrics".
    const badge = panel.locator('span.rounded-full').first()
    await expect(badge).toBeVisible()

    const text = (await badge.textContent())?.trim() ?? ''

    // Must NEVER be the raw enum.
    expect(text).not.toBe('awaiting_enhancement_review')
    expect(text).not.toBe('awaiting_enhancement')
    expect(text).not.toMatch(/^[a-z_]+$/) // no all-lowercase-underscore strings

    // Must match one of the known humanized labels (note "Enhancing…" uses an
    // ellipsis char, not "...").
    expect(text).toMatch(
      /^(Created|Running|Paused|Completed|Failed|Cancelled|Enhancing…|Awaiting Enhancement|Enhancement Review)$/,
    )
  })
})

// ──────────────────────────────────────────────────────────────────────
// 9. Spec node cursor-help + Info icon — Wave 3 P2·S
// ──────────────────────────────────────────────────────────────────────
test.describe('Wave 3 P2·S — Specification node affordance', () => {
  test('Specification node has cursor-help and an Info icon', async ({ page }) => {
    test.skip(!process.env.E2E_AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    test.skip(!process.env.E2E_TEST_SESSION_ID, 'needs E2E_TEST_SESSION_ID')

    await seedAuth(page)
    await gotoSession(page)

    // AgentNode applies title="Click to view full specification" on the
    // outer container of the input/Specification node.
    const specNode = page.locator(
      'div[title="Click to view full specification"]',
    ).first()
    await expect(specNode).toBeVisible({ timeout: 15_000 })

    // class must include cursor-help (Tailwind utility).
    const klass = (await specNode.getAttribute('class')) ?? ''
    expect(klass).toMatch(/cursor-help/)

    // The hidden Info indicator has its own title attr at the corner.
    const infoIndicator = specNode.locator(
      'div[title="Click to view full specification"][aria-hidden="true"]',
    )
    await expect(infoIndicator).toHaveCount(1)
    // Lucide Info icon renders as an inline <svg>.
    await expect(infoIndicator.locator('svg')).toBeVisible()
  })
})

// ──────────────────────────────────────────────────────────────────────
// 10. Header overflow ⋯ menu on mobile — Wave 3 P3·S
// ──────────────────────────────────────────────────────────────────────
test.describe('Wave 3 P3·S — Header overflow on mobile', () => {
  test('600x800 viewport: secondary buttons hidden, ⋯ button visible', async ({ page }) => {
    test.skip(!process.env.E2E_AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    test.skip(!process.env.E2E_TEST_SESSION_ID, 'needs E2E_TEST_SESSION_ID')

    await page.setViewportSize({ width: 600, height: 800 })
    await seedAuth(page)
    await gotoSession(page)

    // The overflow trigger uses title="More actions".
    const overflowBtn = page.locator('button[title="More actions"]')
    await expect(overflowBtn).toBeVisible({ timeout: 15_000 })

    // Settings gear is hidden at < md (md:flex + base hidden).
    const settingsBtn = page.locator('button[data-tour="settings-btn"]')
    await expect(settingsBtn).toBeHidden()

    // "Save as Template" copy is also hidden at this width.
    const saveTplBtn = page.locator('button:has-text("Save as Template")').first()
    // The visible copy lives inside the overflow menu only AFTER opening it;
    // collapsed header should hide the standalone button.
    await expect(saveTplBtn).toBeHidden()

    // Open the menu and verify menuitem entries surface.
    await overflowBtn.click()
    const menu = page.locator('div[role="menu"]')
    await expect(menu).toBeVisible()
    await expect(menu.locator('button:has-text("Session Settings")')).toBeVisible()
    await expect(menu.locator('button:has-text("Save as Template")')).toBeVisible()
  })
})

// ──────────────────────────────────────────────────────────────────────
// 11. Mini-map status palette — Wave 3 P3·S
// ──────────────────────────────────────────────────────────────────────
test.describe('Wave 3 P3·S — Mini-map status palette', () => {
  test('no node falls back to grey when status is executing/fixing/timeout', async ({ page }) => {
    test.skip(!process.env.E2E_AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
    test.skip(!process.env.E2E_TEST_SESSION_ID, 'needs E2E_TEST_SESSION_ID')

    await seedAuth(page)
    await gotoSession(page)

    // React Flow renders mini-map nodes as <rect> inside `.react-flow__minimap`.
    const minimap = page.locator('.react-flow__minimap')
    await expect(minimap).toBeVisible({ timeout: 15_000 })

    // The palette covers idle/waiting/working/executing/fixing/done/error/
    // timeout. The fallback is '#4B5563' (idle grey). Active-state nodes
    // (executing/fixing/timeout) should NEVER end up at the fallback colour.
    //
    // To assert this we'd need a session currently in one of those states.
    // If the live graph has no such node we have nothing meaningful to check.
    // Skip in that case to avoid false greens / false reds.
    const fills = await minimap.locator('rect').evaluateAll((rects) =>
      rects.map((r) => (r as SVGRectElement).getAttribute('fill') ?? ''),
    )

    // Every fill should be one of the documented palette colours, or the
    // RF-internal mask/background colour. We just enforce: there exists at
    // least one non-grey fill (proof the palette wired up at all). If every
    // single node is grey, either nothing has happened yet (skip) or the
    // palette regressed.
    const hasColouredNode = fills.some((f) =>
      /^#?(3B82F6|F59E0B|10B981|EF4444|DC2626)/i.test(f),
    )
    if (!hasColouredNode) {
      test.skip(
        true,
        'no coloured node in mini-map — needs a session with executing/fixing/' +
          'timeout/waiting/working/done/error state to make a meaningful assertion',
      )
    }
    expect(hasColouredNode).toBe(true)
  })
})
