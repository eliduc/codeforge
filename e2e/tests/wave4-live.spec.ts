/**
 * Wave 4 — LiveSession Tester.
 *
 * Read-only DOM/keyboard checks against /sessions/{E2E_TEST_SESSION_ID} on
 * a session that is in `created` state. We MUST NOT click Start/Run/Pause/
 * Cancel/Reset on the real session — only inspect the rendered surface.
 *
 * Tests cover Wave 1 P0·M (WS status pill), Wave 2 P1·{M,S} (lock viewport,
 * keyboard help, humanized status/phase, retry agent, code highlight), and
 * Wave 3 P2·{S,M} + P3·S (spec node affordance, edge tooltips, countdown
 * chips, disabled enhancer a11y, breadcrumb, fullscreen modal, header
 * overflow on narrow viewport, mini-map palette).
 *
 * Failures are logged into tests/reports/w4_live.md — Tester does NOT fix
 * the underlying bugs.
 */

import { authedTest as test, expect, BASE_URL, TEST_SESSION_ID, AUTH_TOKEN } from './_fixtures/auth'

const LOCK_KEY = 'codeforge.session.lockViewport'

const sessionUrl = `/sessions/${TEST_SESSION_ID}`

test.beforeEach(async () => {
  test.skip(!AUTH_TOKEN, 'E2E_AUTH_TOKEN missing')
  test.skip(!TEST_SESSION_ID, 'E2E_TEST_SESSION_ID missing')
})

/**
 * Goto the session detail page and wait for the React Flow graph + metrics
 * panel to land. Throws if the user got bounced back to /login.
 */
async function gotoSession(page: import('@playwright/test').Page) {
  await page.goto(sessionUrl)
  await page.waitForLoadState('domcontentloaded')

  // Bail loudly if we got bounced to /login (token expired / wrong session).
  if (/\/login(\?|$)/.test(page.url())) {
    throw new Error(
      `Bounced to /login when opening ${sessionUrl} — check E2E_AUTH_TOKEN`,
    )
  }

  // Wait for the canvas (React Flow root) AND the metrics panel.
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-tour="metrics-panel"]')).toBeVisible({ timeout: 30_000 })
}

// ── 1. Page renders without error ──────────────────────────────────────
test('1. page renders graph + MetricsPanel without error', async ({ page }) => {
  await gotoSession(page)

  // React Flow viewport exists.
  await expect(page.locator('.react-flow__viewport').first()).toBeVisible()
  // MetricsPanel header "Session Metrics".
  await expect(
    page.locator('[data-tour="metrics-panel"]').getByText('Session Metrics', { exact: true }),
  ).toBeVisible()
})

// ── 2. WS status pill ──────────────────────────────────────────────────
test('2. WS status pill: connecting → connected → hides within ~2s', async ({ page }) => {
  await page.goto(sessionUrl)

  // Initially pill should show "Connecting…" or "Reconnecting…" briefly.
  // Pill is hidden once steady-connected, with a 1.5s "Connected" success
  // flash after a recovery. On a clean load we may go straight from
  // connecting to connected without a flash, so we look for either of:
  //   - "Connecting…"
  //   - "Connected" (flash)
  //   - eventual disappearance
  const pillTexts = page.getByText(
    /Connecting…|Reconnecting \(attempt|Live feed disconnected|Connected/,
  )

  // Give it up to 10s to surface SOMETHING (connecting state appears
  // synchronously when WS subscriber registers).
  // Use a soft check: count of matches.
  // If the WS handshake is so fast we miss "Connecting…" entirely, we still
  // accept the test as long as the pill is hidden when stable.
  await page.waitForLoadState('domcontentloaded')

  // Poll for stable connected state where the pill is HIDDEN within ~5s of load.
  await expect
    .poll(
      async () => {
        const count = await pillTexts.count()
        return count
      },
      { timeout: 15_000, intervals: [200, 500, 1000] },
    )
    .toBeLessThanOrEqual(1) // 0 (hidden) or 1 (success flash still visible)

  // After at most 4s the pill should be fully hidden (success flash = 1.5s + slack).
  await expect
    .poll(async () => await pillTexts.count(), { timeout: 6_000 })
    .toBe(0)
})

// ── 3. Lock viewport toggle exists + persists ──────────────────────────
test('3. Lock viewport toggle exists and persists to localStorage', async ({ page }) => {
  // Start from a known-OFF state so we can flip and re-check. We CANNOT use
  // context.addInitScript here because that re-clears localStorage on every
  // navigation including reload — defeating the persistence check.
  // Instead, navigate once to set up origin, then clear localStorage in-page.
  await page.goto(sessionUrl)
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate((k) => localStorage.removeItem(k), LOCK_KEY)

  // Now reload so SessionDetailPage re-runs useState() and reads the cleared key.
  await page.reload()
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 })

  const lockBtn = page.locator(
    'button[title*="Lock viewport"], button[title*="Viewport locked"], ' +
      'button[aria-label*="Lock viewport"], button[aria-label*="Unlock viewport"]',
  ).first()
  await expect(lockBtn).toBeVisible({ timeout: 15_000 })
  await expect(lockBtn).toHaveAttribute('aria-pressed', 'false')

  // Flip it.
  await lockBtn.click()
  await expect(lockBtn).toHaveAttribute('aria-pressed', 'true')
  await expect(lockBtn).toHaveAttribute('title', /Viewport locked/)

  const stored = await page.evaluate((k) => localStorage.getItem(k), LOCK_KEY)
  expect(stored).toBe('1')

  // Reload and confirm the locked state survived.
  await page.reload()
  await expect(page.locator('.react-flow').first()).toBeVisible({ timeout: 30_000 })
  const lockBtn2 = page.locator(
    'button[title*="Lock viewport"], button[title*="Viewport locked"]',
  ).first()
  await expect(lockBtn2).toBeVisible()
  await expect(lockBtn2).toHaveAttribute('aria-pressed', 'true')

  // Cleanup: toggle back OFF so subsequent tests start consistent.
  await lockBtn2.click()
  await expect(lockBtn2).toHaveAttribute('aria-pressed', 'false')
})

// ── 4. ? opens the keyboard help modal listing shortcuts ───────────────
test('4. "?" opens the keyboard help modal with all documented shortcuts', async ({ page }) => {
  await gotoSession(page)

  // Make sure focus isn't trapped in any input.
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press('Shift+Slash') // → "?" on US layout

  // Modal title.
  const title = page.getByText('Keyboard shortcuts', { exact: true })
  await expect(title).toBeVisible({ timeout: 5_000 })

  // All 6 labelled rows.
  await expect(page.getByText('Show / hide this help')).toBeVisible()
  await expect(page.getByText('Close the open panel or modal')).toBeVisible()
  await expect(page.getByText('Toggle browser preview')).toBeVisible()
  await expect(page.getByText('Pause when running, resume when paused')).toBeVisible()
  await expect(page.getByText('Focus the most-recent code viewer')).toBeVisible()
  await expect(page.getByText('Open the intervention panel')).toBeVisible()

  // Each documented key renders inside a <kbd>.
  for (const key of ['?', 'Esc', 'p', 'Space', 'c', 'i']) {
    const escaped = key.replace(/[?]/g, '\\?')
    const kbd = page.locator('kbd', { hasText: new RegExp(`^${escaped}$`) }).first()
    await expect(kbd).toBeVisible()
  }
})

// ── 5. Esc closes the keyboard help modal ──────────────────────────────
test('5. Esc closes the keyboard help modal', async ({ page }) => {
  await gotoSession(page)
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {})
  await page.keyboard.press('Shift+Slash')

  const title = page.getByText('Keyboard shortcuts', { exact: true })
  await expect(title).toBeVisible({ timeout: 5_000 })

  await page.keyboard.press('Escape')
  await expect(title).toBeHidden({ timeout: 5_000 })
})

// ── 6. MetricsPanel status badge is humanized ──────────────────────────
test('6. MetricsPanel status badge text is humanized (never raw enum)', async ({ page }) => {
  await gotoSession(page)

  const panel = page.locator('[data-tour="metrics-panel"]')
  await expect(panel).toBeVisible()

  const badge = panel.locator('span.rounded-full').first()
  await expect(badge).toBeVisible()
  const text = (await badge.textContent())?.trim() ?? ''

  // Must NOT be the raw enum.
  expect(text).not.toBe('awaiting_enhancement_review')
  expect(text).not.toBe('awaiting_enhancement')
  expect(text).not.toMatch(/^[a-z_]+$/)

  // Must match one of the humanized labels.
  // Spec calls for the "Created|Running|…|Awaiting Enhancement|Enhancement Review|Enhancing…" set.
  expect(text).toMatch(
    /^(Created|Running|Paused|Completed|Failed|Cancelled|Enhancing…|Awaiting Enhancement|Enhancement Review)$/,
  )
})

// ── 7. Phase indicator humanized (skip in `created`) ───────────────────
test('7. phase indicator (when visible) uses humanized labels', async ({ page }) => {
  await gotoSession(page)

  // Phase indicator only renders when session.status === 'running' (with a
  // phase) or session.status === 'enhancing'. Our fixture session is
  // `created`, so the chip should not be present.
  const phaseChip = page.locator(
    'text=/(Coding \\(iteration \\d+\\)|Testing \\(iteration \\d+\\)|Summarizing audits|Finalizing winner|Enhancing|Enhancement) phase/',
  ).first()

  const visible = await phaseChip.isVisible().catch(() => false)
  if (!visible) {
    test.skip(true, 'session is in `created` — phase indicator only shows for running/enhancing')
  }

  const txt = (await phaseChip.textContent())?.trim() ?? ''
  expect(txt).not.toMatch(/^(coding|testing|summarizing|finalizing|enhancing) phase$/)
  expect(txt).toMatch(
    /^(Coding \(iteration \d+\)|Testing \(iteration \d+\)|Summarizing audits|Finalizing winner|Enhancing|Enhancement) phase$/,
  )
})

// ── 8. Spec node click affordance (cursor-help + Info icon + click) ────
test('8. Specification node has cursor-help, Info icon, and opens dialog on click', async ({ page }) => {
  await gotoSession(page)

  const specNode = page.locator('div[title="Click to view full specification"]').first()
  await expect(specNode).toBeVisible({ timeout: 15_000 })

  // cursor-help Tailwind utility on the outer div.
  const klass = (await specNode.getAttribute('class')) ?? ''
  expect(klass).toMatch(/cursor-help/)

  // Inner Info indicator (lucide-react renders as inline <svg>).
  const infoIndicator = specNode.locator(
    'div[title="Click to view full specification"][aria-hidden="true"]',
  )
  await expect(infoIndicator).toHaveCount(1)
  await expect(infoIndicator.locator('svg')).toBeVisible()

  // Click → SpecificationsDialog opens. After КАО#W4-FIX-02-v2 the
  // MetricsPanel is in top-right corner and no longer overlaps the spec
  // node (which sits at top-left of the canvas), so a plain click works
  // without any canvas panning gymnastics.
  const rfInputNode = page.locator('.react-flow__node[data-id="input"]').first()
  await expect(rfInputNode).toBeVisible()
  await rfInputNode.click()

  // SpecificationsDialog (headlessui) renders with a title "Session Specifications".
  // The outer dialog div has `class="relative z-50"` (size 0), so we check the
  // open state via data-headlessui-state OR look for the title text being
  // present somewhere in the DOM (the visible panel is a child of the
  // role=dialog wrapper).
  const dialogOpen = page.locator('[role="dialog"][data-headlessui-state="open"]').first()
  await expect(dialogOpen).toBeAttached({ timeout: 5_000 })
  const dialogTitle = page.getByText('Session Specifications', { exact: true }).first()
  await expect(dialogTitle).toBeVisible({ timeout: 5_000 })

  // Close it with Esc so subsequent tests run clean.
  await page.keyboard.press('Escape')
})

// ── 9. Spec node tooltip ───────────────────────────────────────────────
test('9. Specification node carries `title="Click to view full specification"`', async ({ page }) => {
  await gotoSession(page)

  const specNode = page.locator('div[title="Click to view full specification"]').first()
  await expect(specNode).toHaveAttribute('title', 'Click to view full specification')
})

// ── 10. Edge artifact tooltips ─────────────────────────────────────────
test('10. edge artifact badges (if any) carry descriptive tooltips', async ({ page }) => {
  await gotoSession(page)

  // Wait briefly for edges to mount.
  await page.waitForTimeout(500)

  // ArtifactEdge renders a <div title="..."> in EdgeLabelRenderer with text
  // pattern "<Kind> (iter N) from X → Y". Locate by the arrow glyph.
  const badge = page.locator(
    'div.react-flow__edges + *, .react-flow__edgelabel-renderer div[title*="→"]',
  ).first()

  // More reliable: any element with a title attr containing "→".
  const badgeByTitle = page.locator('div[title*="→"]').first()
  const present = await badgeByTitle.count().catch(() => 0)
  if (present === 0) {
    test.skip(true, 'session in `created` has no artifact-bearing edges — nothing to assert')
  }

  await expect(badgeByTitle).toBeVisible({ timeout: 5_000 })
  const title = (await badgeByTitle.getAttribute('title')) ?? ''
  // e.g. "Code (iter 2) from Coder 1 → Tester 2" or "Final from Finalizer → Final Code".
  expect(title).toMatch(/(Code|Audit|Summary|Final|Enhancement|Artifact)/i)
  expect(title).toContain('→')
})

// ── 11. Countdown chips on active agent nodes ──────────────────────────
test('11. countdown chips T/R/S/A render on active agent nodes', async ({ page }) => {
  await gotoSession(page)

  // Chips render when isActive (working|executing|fixing). On a `created`
  // session no agent is active.
  const chips = page.locator('span[title^="T = "], span[title^="R = "], span[title^="S = "], span[title^="A = "]')
  const count = await chips.count().catch(() => 0)
  if (count === 0) {
    test.skip(true, 'no active agents on `created` session — countdown chips not rendered')
  }

  // At least one chip should be visible with a tooltip.
  await expect(chips.first()).toBeVisible()
  const ttl = await chips.first().getAttribute('title')
  expect(ttl).toMatch(/^(T|R|S|A) =/)
})

// ── 12. Disabled enhancer a11y ─────────────────────────────────────────
test('12. disabled enhancer nodes show opacity-60 + "Disabled" badge + Enable button', async ({ page }) => {
  await gotoSession(page)

  // Find any "Disabled" badge inside a node.
  const disabledBadge = page.locator('span:has-text("Disabled")', {
    hasText: /^Disabled$/,
  }).first()
  const present = await disabledBadge.count().catch(() => 0)
  if (present === 0) {
    test.skip(true, 'no disabled enhancer agents in this session — nothing to assert')
  }

  await expect(disabledBadge).toBeVisible()
  // Ancestor node has opacity-60 class.
  const node = disabledBadge.locator('xpath=ancestor::div[contains(@class,"opacity-60")][1]')
  await expect(node).toBeVisible()

  // On-hover Enable button exists (may be hidden until hover via group-hover).
  const enableBtn = node.locator('button[aria-label="Enable agent"], button:has-text("Enable")').first()
  await expect(enableBtn).toHaveCount(1)
})

// ── 13. Side-panel breadcrumb ──────────────────────────────────────────
test('13. side-panel breadcrumb appears after switching panels', async ({ page }) => {
  await gotoSession(page)

  // КАО#UX-13 — drive the breadcrumb via two reliable TOOLBAR buttons instead of
  // a graph-node click. The previous version force-clicked the coder node's
  // geometric CENTRE, which lands on one of the AgentNode's inner buttons
  // (config gear / run-fix badges — all stopPropagation) and never bubbles to
  // ReactFlow's onNodeClick, so the DetailPanel never opened and
  // pushPanel('detail') was skipped → panelHistory stayed length 1 and no
  // breadcrumb rendered. (The old `h3:has-text("Coder")` check was a false
  // positive — it matched the node's OWN label, not the panel.) Verified on
  // stage: a centre click opens nothing; "View Result" + "Intervene" push
  // distinct panel keys whose panels don't depend on node-selection state, so
  // the breadcrumb — including the switch-back step — renders deterministically.
  const viewResult = page.locator('button:has-text("View Result")').first()
  if ((await viewResult.count().catch(() => 0)) === 0) {
    test.skip(true, 'no finalResult on this session — breadcrumb needs ≥2 openable side panels (set E2E_TEST_SESSION_ID to a completed session)')
  }
  await expect(viewResult).toBeVisible({ timeout: 15_000 })
  await viewResult.click()

  const intervenenBtn = page.locator('button:has-text("Intervene")').first()
  await expect(intervenenBtn).toBeVisible({ timeout: 5_000 })
  await intervenenBtn.click()

  // panelHistory is now ['code','intervention'] → the breadcrumb (length > 1)
  // renders inside the Intervention panel: "Switch back to Result" ·
  // "Currently viewing Intervene".
  const breadcrumb = page.locator(
    'button[title^="Switch back to"], button[title^="Currently viewing"]',
  )
  await expect(breadcrumb.first()).toBeVisible({ timeout: 5_000 })
  const switchBtn = page.locator('button[title^="Switch back to"]').first()
  if (await switchBtn.count() > 0) {
    await switchBtn.click()
    // After switching back to Result, the breadcrumb still shows a non-current
    // chip ("Switch back to Intervene").
    await expect(page.locator('button[title^="Switch back to"]').first()).toBeVisible({ timeout: 3_000 })
  }
})

// ── 14. Final Result code view fullscreen ──────────────────────────────
test('14. Final Result Fullscreen button opens modal with code', async ({ page }) => {
  await gotoSession(page)

  // The Fullscreen button only exists when finalResult.final_code is present.
  const fsBtn = page.locator('button:has-text("Fullscreen")').first()
  const present = await fsBtn.count().catch(() => 0)
  if (present === 0) {
    test.skip(true, 'no Final Result (final_code) on this session — Fullscreen button not rendered')
  }
  await expect(fsBtn).toBeVisible({ timeout: 5_000 })
  await fsBtn.click()

  // Modal opens with title "Generated Code" and the CodeBlock has max-h-[75vh].
  const dialog = page.locator('[role="dialog"]:has-text("Generated Code")').first()
  await expect(dialog).toBeVisible({ timeout: 5_000 })

  // Code container with max-h-[75vh].
  const codeBlock = dialog.locator('[class*="max-h-[75vh]"]').first()
  await expect(codeBlock).toBeVisible()

  // Close with Esc.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden({ timeout: 5_000 })
})

// ── 15. Header overflow ⋯ menu on narrow viewport ──────────────────────
test('15. on 600x800 the secondary actions collapse into a ⋯ menu', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 })
  await gotoSession(page)

  const overflowBtn = page.locator('button[title="More actions"]')
  await expect(overflowBtn).toBeVisible({ timeout: 15_000 })

  // Settings gear is hidden at < md (it has md:flex + base hidden).
  const settingsBtn = page.locator('button[data-tour="settings-btn"]')
  await expect(settingsBtn).toBeHidden()

  // Standalone "Save as Template" is hidden too.
  const saveTplBtn = page
    .locator('button:not([role="menuitem"]):has-text("Save as Template")')
    .first()
  await expect(saveTplBtn).toBeHidden()

  // Open the menu — verify items surface.
  await overflowBtn.click()
  const menu = page.locator('div[role="menu"]').first()
  await expect(menu).toBeVisible()
  await expect(menu.locator('button:has-text("Session Settings")')).toBeVisible()
  await expect(menu.locator('button:has-text("Save as Template")')).toBeVisible()
})

// ── 16. Mini-map status palette ────────────────────────────────────────
test('16. mini-map (if visible) wires up the status colour palette', async ({ page }) => {
  await gotoSession(page)

  const minimap = page.locator('.react-flow__minimap')
  const visible = await minimap.isVisible().catch(() => false)
  if (!visible) {
    test.skip(true, 'mini-map is not visible (collapsed/disabled) — palette assertion skipped')
  }

  // Collect fill colours from the rect elements (each node = one rect).
  const fills = await minimap.locator('rect').evaluateAll((rects) =>
    rects.map((r) => (r as SVGRectElement).getAttribute('fill') ?? ''),
  )

  // Look for at least one of the palette-defined colours. We accept any of
  // the documented states (working/executing/fixing/done/error/etc).
  const hasColouredNode = fills.some((f) =>
    /^#?(3B82F6|F59E0B|10B981|EF4444|DC2626|FB923C|F87171)/i.test(f),
  )
  if (!hasColouredNode) {
    test.skip(
      true,
      'no coloured node in mini-map — needs an active executing/fixing/timeout ' +
        'state for a meaningful assertion',
    )
  }
  expect(hasColouredNode).toBe(true)
})

// ── 17. Retry-agent button on error node ───────────────────────────────
test('17. DetailPanel shows ↻ Retry agent button for error/timeout agents', async ({ page }) => {
  await gotoSession(page)

  // A `created` session has no error/timeout agents. We need to detect any
  // first; if none, skip.
  // The Retry button lives inside DetailPanel — we need to open one. Look
  // for any node with red/error border by searching the DOM for a node with
  // a status indicator labelled "Error" or "Timed Out".
  const errorNode = page.locator(
    '.react-flow__node:has(span:text-is("Error")), .react-flow__node:has(span:text-is("Timed Out"))',
  ).first()
  const present = await errorNode.count().catch(() => 0)
  if (present === 0) {
    test.skip(true, 'no agents in error/timeout state — Retry affordance only renders for those')
  }

  await errorNode.click()
  const retryBtn = page.locator('button:has-text("Retry agent")')
  await expect(retryBtn).toBeVisible({ timeout: 5_000 })
  const ttl = await retryBtn.getAttribute('title')
  expect(ttl).toMatch(/Retry/i)
})

// ── 18. CodeBlock syntax highlight ─────────────────────────────────────
test('18. open code viewer renders with hljs highlight spans', async ({ page }) => {
  await gotoSession(page)

  // Try to open a coder DetailPanel — if it has a code viewer mounted we can
  // check for hljs spans. CoderPanel only renders code when versions exist.
  const coderNode = page.locator('.react-flow__node[data-id^="coder-"]').first()
  const coderPresent = await coderNode.count().catch(() => 0)
  if (coderPresent === 0) {
    test.skip(true, 'no coder nodes visible — cannot open a code viewer')
  }
  await coderNode.click()

  // Wait a beat for the panel to mount and (potentially) load versions.
  await page.waitForTimeout(1500)

  const hljs = page.locator('.hljs').first()
  const present = await hljs.count().catch(() => 0)
  if (present === 0) {
    test.skip(
      true,
      'no code viewer mounted in side panel (session has no code versions yet) — ' +
        'cannot assert hljs highlighting',
    )
  }
  await expect(hljs).toBeVisible()
  // Some hljs descendant span (token) should exist.
  const tokens = page.locator('.hljs span').first()
  await expect(tokens).toBeVisible()
})
