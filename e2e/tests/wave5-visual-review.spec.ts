// Wave-5 Visual Review tester — KAO VR-E2E (Task VR-7)
//
// End-to-end coverage for the Visual Review feature (Waves 1-3 + frontend):
//   * VisualReviewPanel renders in mock mode (?mock_visual_review=1)
//   * Linear scoring: submit gating, skip-button availability
//   * Live-preview and screenshot zoom modals + Esc-to-close
//   * NewSessionPage toggles (skip / force) with localStorage persistence and
//     mutual exclusion
//   * Tournament mode (N=5) with mocked candidates
//   * Backend-dependent: status pill / settings POST flow — gated behind
//     E2E_VR_BACKEND_READY and E2E_VISUAL_REVIEW_SESSION_ID env vars so the
//     suite is ready when the backend lands on stage.
//
// Approach: the panel only renders when SessionDetailPage state
// `showVisualReview === true`. That flag flips automatically when
// `session.status === 'awaiting_visual_review'`. We never have such a session
// on stage yet (backend not deployed), so for mock tests we intercept
// GET /api/sessions/:id and force the status. The `?mock_visual_review=1`
// param then makes VisualReviewPanel use buildMockCandidates(2) instead of
// hitting the backend.
//
// MUTATION DISCIPLINE:
//   * No sessions created. All backend interaction is intercepted via
//     page.route(); we never POST a real session.
//
// Run:
//   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
//     npx playwright test tests/wave5-visual-review.spec.ts --reporter=list

import { authedTest as test, expect, AUTH_TOKEN, type Page } from './_fixtures/auth'
import type { Route } from '@playwright/test'

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

const FAKE_SESSION_ID = '00000000-0000-4000-8000-000000000005'

interface SessionStubOptions {
  status?: string
  id?: string
}

/** A minimal SessionResponse-shaped object that satisfies SessionDetailPage. */
function buildSessionStub(opts: SessionStubOptions = {}): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    id: opts.id ?? FAKE_SESSION_ID,
    name: '_e2e_w5_visual_review_stub',
    specification: 'Build a small visual app for e2e tests.',
    language: 'javascript',
    max_iterations: 3,
    current_iteration: 3,
    status: opts.status ?? 'awaiting_visual_review',
    execution_timeout: 60,
    enable_code_execution: true,
    max_fix_attempts: 3,
    auto_install_deps: true,
    auto_continue: false,
    agent_timeout: 600,
    request_timeout: 300,
    enhancement_round: 0,
    created_at: now,
    updated_at: now,
    agent_configs: [],
    settings: {},
  }
}

/**
 * Intercept the requests SessionDetailPage fires on mount so we can drive the
 * page from a stub without a deployed backend. We stub:
 *   * GET /api/sessions/:id      → session with the requested status
 *   * GET /api/sessions/:id/metrics → empty metrics
 *   * GET /api/sessions/:id/final-result → 404 (no final yet)
 *   * GET /api/sessions/:id/visual-review → empty (mock-mode shortcircuits this anyway)
 */
async function stubSessionRoutes(page: Page, opts: SessionStubOptions = {}): Promise<void> {
  const sessionId = opts.id ?? FAKE_SESSION_ID
  const session = buildSessionStub(opts)

  await page.route(`**/api/sessions/${sessionId}`, async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(session),
      })
    } else {
      await route.continue()
    }
  })

  await page.route(`**/api/sessions/${sessionId}/metrics`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session_id: sessionId,
        total_tokens: 0,
        total_tokens_input: 0,
        total_tokens_output: 0,
        total_cost_usd: 0,
        total_requests: 0,
      }),
    })
  })

  await page.route(`**/api/sessions/${sessionId}/final-result`, async (route: Route) => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not yet"}' })
  })

  await page.route(`**/api/sessions/${sessionId}/visual-review`, async (route: Route) => {
    // Mock URL param drives the panel from in-component fixture data instead,
    // but be defensive in case the param is dropped on navigation.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ candidates: [] }),
    })
  })
}

/** Open SessionDetailPage with mock visual review active and panel ready. */
async function openMockReviewPage(page: Page, opts: SessionStubOptions = {}): Promise<void> {
  await stubSessionRoutes(page, opts)
  const sessionId = opts.id ?? FAKE_SESSION_ID
  await page.goto(`/sessions/${sessionId}?mock_visual_review=1`)
}

/** Guard: skip if no auth token wired. */
function requireAuth() {
  test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
}

// ────────────────────────────────────────────────────────────────────────────
// Mock-mode tests (work without backend deploy)
// ────────────────────────────────────────────────────────────────────────────

test.describe('Wave-5 Visual Review — mock mode', () => {
  test.beforeEach(() => {
    requireAuth()
  })

  test('1. Mock mode renders panel with candidates + screenshot strips + slider', async ({ page }) => {
    await openMockReviewPage(page)

    // Header
    const panelHeader = page.getByRole('heading', { name: /Visual Review/i })
    await expect(panelHeader).toBeVisible({ timeout: 20_000 })

    // "Mock" badge confirms we're in mock mode (not just fallback to backend).
    await expect(page.getByText(/^Mock$/i).first()).toBeVisible()

    // Two candidate cards — match by Coder labels.
    await expect(page.getByText(/^Coder 1$/i)).toBeVisible()
    await expect(page.getByText(/^Coder 2$/i)).toBeVisible()

    // Each card has 5 thumbnail buttons. The mock builder yields 5 frames
    // per candidate (mock-shot-<i>-0..4) — assert via the title attribute
    // we know it sets.
    const frame1Thumbs = page.locator('button[title^="Frame 1 @"]')
    await expect(frame1Thumbs).toHaveCount(2) // one per candidate
    const allFrameThumbs = page.locator('button[title^="Frame "]')
    expect(await allFrameThumbs.count()).toBeGreaterThanOrEqual(10)

    // Score slider per candidate.
    const sliders = page.locator('input[type="range"][aria-label^="Score candidate"]')
    await expect(sliders).toHaveCount(2)
    // 0-10 range, step=0.5.
    await expect(sliders.first()).toHaveAttribute('min', '0')
    await expect(sliders.first()).toHaveAttribute('max', '10')
  })

  test('2. Mock mode — Submit disabled until both candidates scored', async ({ page }) => {
    await openMockReviewPage(page)

    const submit = page.getByRole('button', { name: /Submit ranking/i })
    await expect(submit).toBeVisible({ timeout: 20_000 })
    await expect(submit).toBeDisabled()

    const sliders = page.locator('input[type="range"][aria-label^="Score candidate"]')
    await expect(sliders).toHaveCount(2)

    // Score candidate 1 → still disabled (candidate 2 untouched).
    await sliders.nth(0).evaluate((el, value) => {
      const input = el as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, '7')
    await expect(submit).toBeDisabled()

    // Score candidate 2 → submit enables.
    await sliders.nth(1).evaluate((el, value) => {
      const input = el as HTMLInputElement
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }, '4')
    await expect(submit).toBeEnabled()
  })

  test('3. Mock mode — Skip button always enabled', async ({ page }) => {
    await openMockReviewPage(page)

    const skipBtn = page.getByRole('button', { name: /Skip — let AI decide/i })
    await expect(skipBtn).toBeVisible({ timeout: 20_000 })
    await expect(skipBtn).toBeEnabled()
  })

  test('4. Mock mode — Live preview opens an iframe modal, Esc closes it', async ({ page }) => {
    await openMockReviewPage(page)

    // First "Live preview" button (Coder 1).
    const live = page.getByRole('button', { name: /Live preview/i }).first()
    await expect(live).toBeVisible({ timeout: 20_000 })
    await live.click()

    // Modal title matches "Live preview — Coder 1".
    const modalTitle = page.getByRole('heading', { name: /Live preview\s*—\s*Coder 1/i })
    await expect(modalTitle).toBeVisible()

    // Iframe is mounted.
    const iframe = page.locator('iframe[title^="Live preview"]').first()
    await expect(iframe).toBeVisible()

    // Esc closes the modal.
    await page.keyboard.press('Escape')
    await expect(modalTitle).toBeHidden()
  })

  test('5. Mock mode — Click thumbnail opens zoom modal, Esc closes it', async ({ page }) => {
    await openMockReviewPage(page)

    const firstThumb = page.locator('button[title^="Frame 1 @"]').first()
    await expect(firstThumb).toBeVisible({ timeout: 20_000 })
    await firstThumb.click()

    // The zoom modal title matches "Frame 1 · 0.0s" (or similar t_seconds).
    const zoomTitle = page.getByRole('heading', { name: /^Frame 1 ·/ })
    await expect(zoomTitle).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(zoomTitle).toBeHidden()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// NewSessionPage visual-review toggle tests
// ────────────────────────────────────────────────────────────────────────────

test.describe('Wave-5 NewSession toggles', () => {
  test.beforeEach(() => {
    requireAuth()
  })

  // localStorage key constants — must match NewSessionPage.tsx.
  const SKIP_KEY = 'codeforge.newSession.skipVisualReview'
  const FORCE_KEY = 'codeforge.newSession.forceVisualReview'

  test('6. Skip visual review toggle persists across reload', async ({ page }) => {
    await page.goto('/sessions/new')
    const skipCheckbox = page.locator('#skip-visual-review-checkbox')
    await expect(skipCheckbox).toBeVisible({ timeout: 20_000 })

    // Start unchecked (or set to known state).
    if (await skipCheckbox.isChecked()) {
      await skipCheckbox.uncheck()
    }
    await expect(skipCheckbox).not.toBeChecked()

    await skipCheckbox.check()
    await expect(skipCheckbox).toBeChecked()

    const persisted = await page.evaluate((k) => localStorage.getItem(k), SKIP_KEY)
    expect(persisted).toBe('true')

    await page.reload()
    const after = page.locator('#skip-visual-review-checkbox')
    await expect(after).toBeChecked({ timeout: 20_000 })

    // Cleanup.
    await after.uncheck()
  })

  test('7. Force visual review toggle persists across reload', async ({ page }) => {
    await page.goto('/sessions/new')
    const forceCheckbox = page.locator('#force-visual-review-checkbox')
    await expect(forceCheckbox).toBeVisible({ timeout: 20_000 })

    if (await forceCheckbox.isChecked()) {
      await forceCheckbox.uncheck()
    }
    await expect(forceCheckbox).not.toBeChecked()

    await forceCheckbox.check()
    await expect(forceCheckbox).toBeChecked()

    const persisted = await page.evaluate((k) => localStorage.getItem(k), FORCE_KEY)
    expect(persisted).toBe('true')

    await page.reload()
    const after = page.locator('#force-visual-review-checkbox')
    await expect(after).toBeChecked({ timeout: 20_000 })

    // Cleanup.
    await after.uncheck()
  })

  test('8. Skip and Force are mutually exclusive', async ({ page }) => {
    await page.goto('/sessions/new')
    const skipCb = page.locator('#skip-visual-review-checkbox')
    const forceCb = page.locator('#force-visual-review-checkbox')

    await expect(skipCb).toBeVisible({ timeout: 20_000 })
    if (await skipCb.isChecked()) await skipCb.uncheck()
    if (await forceCb.isChecked()) await forceCb.uncheck()

    // Check Skip → Force must stay/become unchecked.
    await skipCb.check()
    await expect(skipCb).toBeChecked()
    await expect(forceCb).not.toBeChecked()

    // Check Force → Skip flips off.
    await forceCb.check()
    await expect(forceCb).toBeChecked()
    await expect(skipCb).not.toBeChecked()

    // Check Skip again → Force flips off.
    await skipCb.check()
    await expect(skipCb).toBeChecked()
    await expect(forceCb).not.toBeChecked()

    // Cleanup so other tests start clean.
    await skipCb.uncheck()
    await expect(skipCb).not.toBeChecked()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Tournament-mode tests (mock with N=5)
// ────────────────────────────────────────────────────────────────────────────
//
// Mock fixture inside VisualReviewPanel is hardcoded to 2 candidates. To test
// tournament mode (which only renders for >=5 candidates) we override the
// /visual-review backend response with a synthetic 5-candidate payload AND
// drop the `mock_visual_review` URL param so the panel actually fetches.

interface CandidateStub {
  code_version_id: string
  coder_index: number
  llm_model: string
  screenshots: Array<{
    id: string
    code_version_id: string
    frame_index: number
    t_seconds: number
    image_url: string
    width: number
    height: number
  }>
  user_score: number | null
  vision_llm_score: number
  issues_count: number
}

function buildCandidates(n: number): CandidateStub[] {
  const models = ['claude-sonnet-4-5', 'gpt-4o', 'gemini-2.5-pro', 'grok-2', 'llama-3.3']
  return Array.from({ length: n }).map((_, i) => ({
    code_version_id: `stub-cv-${i}`,
    coder_index: i,
    llm_model: models[i % models.length],
    screenshots: Array.from({ length: 5 }).map((__, fi) => ({
      id: `stub-shot-${i}-${fi}`,
      code_version_id: `stub-cv-${i}`,
      frame_index: fi,
      t_seconds: fi * 0.5,
      image_url: `https://picsum.photos/seed/vrtest-${i}-${fi}/200/150`,
      width: 200,
      height: 150,
    })),
    user_score: null,
    vision_llm_score: 5 + (i % 4),
    issues_count: i % 2,
  }))
}

async function openTournamentPage(page: Page, n: number): Promise<void> {
  const sessionId = FAKE_SESSION_ID
  await stubSessionRoutes(page, { id: sessionId })

  // Override the visual-review endpoint with a real candidate payload.
  await page.unroute(`**/api/sessions/${sessionId}/visual-review`).catch(() => {})
  await page.route(`**/api/sessions/${sessionId}/visual-review`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ candidates: buildCandidates(n) }),
    })
  })

  // No mock_visual_review param — the panel goes through getVisualReview().
  await page.goto(`/sessions/${sessionId}`)
}

test.describe('Wave-5 Visual Review — tournament mode', () => {
  test.beforeEach(() => {
    requireAuth()
  })

  test('9. Tournament prompt + Start button appear for 5+ candidates', async ({ page }) => {
    await openTournamentPage(page, 5)

    // Banner: "5 candidates — too many for linear scoring. Use Tournament mode."
    const banner = page.getByText(/too many for linear scoring/i)
    await expect(banner).toBeVisible({ timeout: 20_000 })

    const startBtn = page.getByRole('button', { name: /Start tournament/i })
    await expect(startBtn).toBeVisible()
    await expect(startBtn).toBeEnabled()

    await startBtn.click()

    // After starting: round indicator + two "Prefer this one" buttons.
    await expect(page.getByText(/Round\s+1\s+of\s+\d+/i)).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole('button', { name: /←\s*Prefer this one/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Prefer this one\s*→/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /No preference/i })).toBeVisible()
  })

  test('10. Tournament — picking a winner advances the match counter', async ({ page }) => {
    await openTournamentPage(page, 5)
    await page.getByRole('button', { name: /Start tournament/i }).click()

    // Initial match counter text: "Match 1 of N".
    const matchCounter = page.getByText(/^Match\s+\d+\s+of\s+\d+$/i).first()
    await expect(matchCounter).toBeVisible({ timeout: 20_000 })
    const initial = (await matchCounter.textContent()) ?? ''
    const initialIdx = parseInt(initial.match(/Match\s+(\d+)/i)?.[1] ?? '0', 10)

    await page.getByRole('button', { name: /←\s*Prefer this one/i }).click()

    // Either the counter increments OR we land on the summary screen
    // (with only 5 candidates the second branch is unlikely after one pick,
    // but be permissive — both indicate the click was honoured).
    await page.waitForTimeout(300)
    const summaryVisible = await page.getByRole('heading', { name: /Final ranking/i }).isVisible().catch(() => false)
    if (summaryVisible) {
      await expect(page.getByRole('heading', { name: /Final ranking/i })).toBeVisible()
      return
    }
    const after = (await matchCounter.textContent()) ?? ''
    const afterIdx = parseInt(after.match(/Match\s+(\d+)/i)?.[1] ?? '0', 10)
    expect(afterIdx).toBeGreaterThan(initialIdx)
  })

  test('11. Tournament — "Undo last match" disabled on first match', async ({ page }) => {
    await openTournamentPage(page, 5)
    await page.getByRole('button', { name: /Start tournament/i }).click()

    const undo = page.getByRole('button', { name: /Undo last match/i })
    await expect(undo).toBeVisible({ timeout: 20_000 })
    await expect(undo).toBeDisabled()
  })

  test('12. Tournament — final summary shows 0-10 scores after running all matches', async ({ page }) => {
    test.setTimeout(90_000)
    await openTournamentPage(page, 5)
    await page.getByRole('button', { name: /Start tournament/i }).click()
    await expect(page.getByText(/Round\s+1\s+of\s+\d+/i)).toBeVisible({ timeout: 20_000 })

    // Click "Prefer this one" (left) until we reach the summary screen. Guard
    // against an infinite loop with a generous cap (5 candidates × 3 rounds
    // ≈ 6 matches; cap at 30).
    const summary = page.getByRole('heading', { name: /Final ranking/i })
    let safety = 30
    while (safety-- > 0) {
      if (await summary.isVisible().catch(() => false)) break
      const leftBtn = page.getByRole('button', { name: /←\s*Prefer this one/i })
      if (!(await leftBtn.isVisible().catch(() => false))) {
        // Could be transient placeholder ("Preparing next round…") — wait
        // briefly then retry.
        await page.waitForTimeout(150)
        continue
      }
      await leftBtn.click()
      // Tiny pause to let the next match render.
      await page.waitForTimeout(80)
    }

    await expect(summary).toBeVisible({ timeout: 10_000 })

    // Summary shows N entries with "X.X / 10" scores. Pattern matches the
    // text rendered by TournamentMode (`{score.toFixed(1)} / 10`).
    const scoreLabels = page.locator('text=/\\d+(?:\\.\\d)?\\s*\\/\\s*10/')
    expect(await scoreLabels.count()).toBeGreaterThanOrEqual(5)

    // Apply + Back to tournament buttons present.
    await expect(page.getByRole('button', { name: /Apply ranking/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Back to tournament/i })).toBeVisible()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Backend-integration tests (need real awaiting_visual_review session)
// ────────────────────────────────────────────────────────────────────────────

const VR_BACKEND_READY = Boolean(process.env.E2E_VR_BACKEND_READY)
const VR_SESSION_ID = process.env.E2E_VISUAL_REVIEW_SESSION_ID ?? ''

test.describe('Wave-5 Visual Review — backend integration', () => {
  test.beforeEach(() => {
    requireAuth()
  })

  test('13. Status pill + dedicated header actions appear for awaiting_visual_review session', async ({ page }) => {
    test.skip(!VR_BACKEND_READY || !VR_SESSION_ID,
      'needs E2E_VR_BACKEND_READY and E2E_VISUAL_REVIEW_SESSION_ID — backend not deployed yet')

    await page.goto(`/sessions/${VR_SESSION_ID}`)

    // Amber status pill with the emoji label.
    await expect(page.getByText(/🎨\s*Awaiting Visual Review/i)).toBeVisible({ timeout: 30_000 })

    // "Review candidates" + "Skip review" buttons are present;
    // Pause/Cancel are hidden because status is not running/paused.
    await expect(page.getByRole('button', { name: /Review candidates/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Skip review/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Cancel$/ })).toHaveCount(0)
  })

  test('14. createSession POST carries skip_visual_review setting', async ({ page }) => {
    // This test runs without backend — we intercept the POST to inspect the
    // body, then abort so no real session is created.
    let capturedBody: string | null = null
    await page.route('**/api/sessions/', async (route: Route) => {
      if (route.request().method() === 'POST') {
        capturedBody = route.request().postData()
        // Return a 422 to surface an error without creating anything; that
        // also short-circuits the navigate-on-success path.
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'e2e: intercepted, not created' }),
        })
      } else {
        await route.continue()
      }
    })

    await page.goto('/sessions/new')
    const skipCb = page.locator('#skip-visual-review-checkbox')
    await expect(skipCb).toBeVisible({ timeout: 20_000 })
    if (await skipCb.isChecked()) await skipCb.uncheck()
    await skipCb.check()
    await expect(skipCb).toBeChecked()

    // Fill the required Specification field. Min length per the page is
    // SPEC_MIN_CHARS — use a comfortably long stub.
    await page.locator('#spec-input').fill(
      'E2E stub specification — verifying skip_visual_review flows into the create-session POST body. This text is intentionally long enough to clear any client-side min-char gate.',
    )

    // Submit; the route handler captures the body and returns 422.
    await page.getByRole('button', { name: /Create session/i }).click()

    // Wait for the captured POST.
    await expect.poll(() => capturedBody, { timeout: 15_000 }).not.toBeNull()
    expect(capturedBody).toBeTruthy()
    // Cast through unknown to satisfy strict TS: capturedBody is `string | null`
    // by Playwright's typing, the poll above proved non-null but TS doesn't
    // narrow closure variables.
    const body = capturedBody as unknown as string
    const parsed = JSON.parse(body) as {
      settings?: { skip_visual_review?: boolean; force_visual_review?: boolean }
    }
    expect(parsed.settings).toBeTruthy()
    expect(parsed.settings?.skip_visual_review).toBe(true)
    expect(parsed.settings?.force_visual_review).toBe(false)

    // Cleanup toggle.
    await page.reload()
    const after = page.locator('#skip-visual-review-checkbox')
    if (await after.isChecked()) await after.uncheck()
  })
})

// ────────────────────────────────────────────────────────────────────────────
// КАО#VR-13 NodeCountFix — graph node count must match agent_configs
// ────────────────────────────────────────────────────────────────────────────
//
// Regression: SessionDetailPage's React Flow graph was rendering 3 Coder nodes
// even when session.agent_configs only had 1 enabled coder row. The buildGraph
// fn filtered by agent_type alone, so disabled rows (and any stale duplicates
// the backend hadn't yet cleaned up) leaked into the rendered graph.
//
// Fix: filter by agent_type AND enabled !== false. These tests intercept the
// session payload with N enabled coder/tester rows and assert React Flow
// renders exactly N `.react-flow__node[data-id^="coder-"]` / `tester-` boxes.

/** Build a SessionResponse stub with a configurable set of agent_configs. */
function buildSessionStubWithAgents(opts: {
  id?: string
  coders: Array<{ index: number; enabled?: boolean }>
  testers: Array<{ index: number; enabled?: boolean }>
}): Record<string, unknown> {
  const sessionId = opts.id ?? FAKE_SESSION_ID
  const now = new Date().toISOString()
  const agent_configs: Array<Record<string, unknown>> = []
  for (const c of opts.coders) {
    agent_configs.push({
      id: `coder-${c.index}`,
      session_id: sessionId,
      agent_type: 'coder',
      agent_index: c.index,
      llm_provider: 'anthropic',
      llm_model: 'claude-3-5-sonnet-20241022',
      enabled: c.enabled !== false,
      created_at: now,
    })
  }
  for (const t of opts.testers) {
    agent_configs.push({
      id: `tester-${t.index}`,
      session_id: sessionId,
      agent_type: 'tester',
      agent_index: t.index,
      llm_provider: 'anthropic',
      llm_model: 'claude-3-5-sonnet-20241022',
      enabled: t.enabled !== false,
      created_at: now,
    })
  }
  // Summarizer + finalizer so the graph is well-formed.
  for (const role of ['summarizer', 'finalizer']) {
    agent_configs.push({
      id: role,
      session_id: sessionId,
      agent_type: role,
      agent_index: 0,
      llm_provider: 'anthropic',
      llm_model: 'claude-3-5-sonnet-20241022',
      enabled: true,
      created_at: now,
    })
  }
  return {
    id: sessionId,
    name: '_e2e_vr13_node_count',
    specification: 'noop',
    language: 'python',
    max_iterations: 3,
    current_iteration: 0,
    status: 'created',
    execution_timeout: 60,
    enable_code_execution: false,
    max_fix_attempts: 3,
    auto_install_deps: false,
    auto_continue: false,
    agent_timeout: 600,
    request_timeout: 300,
    enhancement_round: 0,
    created_at: now,
    updated_at: now,
    agent_configs,
    settings: {},
  }
}

async function stubSessionWithAgents(
  page: Page,
  stub: Record<string, unknown>,
): Promise<void> {
  const sessionId = stub.id as string
  await page.route(`**/api/sessions/${sessionId}`, async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stub),
      })
    } else {
      await route.continue()
    }
  })
  await page.route(`**/api/sessions/${sessionId}/metrics`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        session_id: sessionId,
        total_tokens: 0,
        total_tokens_input: 0,
        total_tokens_output: 0,
        total_cost_usd: 0,
        total_requests: 0,
      }),
    })
  })
  await page.route(`**/api/sessions/${sessionId}/final-result`, async (route: Route) => {
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"not yet"}' })
  })
}

test.describe('КАО#VR-13 NodeCountFix — graph node count matches agent_configs', () => {
  test.beforeEach(() => {
    requireAuth()
  })

  test('renders exactly 1 coder node when agent_configs has 1 enabled coder', async ({ page }) => {
    const sessionId = '00000000-0000-4000-8000-0000000013a1'
    const stub = buildSessionStubWithAgents({
      id: sessionId,
      coders: [{ index: 0, enabled: true }],
      testers: [{ index: 0, enabled: true }],
    })
    await stubSessionWithAgents(page, stub)
    await page.goto(`/sessions/${sessionId}`)

    const coderNodes = page.locator('.react-flow__node[data-id^="coder-"]')
    await expect(coderNodes).toHaveCount(1, { timeout: 20_000 })

    const testerNodes = page.locator('.react-flow__node[data-id^="tester-"]')
    await expect(testerNodes).toHaveCount(1)
  })

  test('renders N coder nodes when agent_configs has N enabled coders', async ({ page }) => {
    const sessionId = '00000000-0000-4000-8000-0000000013a2'
    const stub = buildSessionStubWithAgents({
      id: sessionId,
      coders: [
        { index: 0, enabled: true },
        { index: 1, enabled: true },
        { index: 2, enabled: true },
      ],
      testers: [
        { index: 0, enabled: true },
        { index: 1, enabled: true },
      ],
    })
    await stubSessionWithAgents(page, stub)
    await page.goto(`/sessions/${sessionId}`)

    const coderNodes = page.locator('.react-flow__node[data-id^="coder-"]')
    await expect(coderNodes).toHaveCount(3, { timeout: 20_000 })

    const testerNodes = page.locator('.react-flow__node[data-id^="tester-"]')
    await expect(testerNodes).toHaveCount(2)
  })

  test('disabled coder rows are NOT rendered as nodes', async ({ page }) => {
    const sessionId = '00000000-0000-4000-8000-0000000013a3'
    // 3 coder rows but only 1 enabled — graph should show 1 box, not 3.
    const stub = buildSessionStubWithAgents({
      id: sessionId,
      coders: [
        { index: 0, enabled: true },
        { index: 1, enabled: false },
        { index: 2, enabled: false },
      ],
      testers: [{ index: 0, enabled: true }],
    })
    await stubSessionWithAgents(page, stub)
    await page.goto(`/sessions/${sessionId}`)

    const coderNodes = page.locator('.react-flow__node[data-id^="coder-"]')
    await expect(coderNodes).toHaveCount(1, { timeout: 20_000 })

    // The one rendered coder must be coder-0 (the enabled one).
    await expect(page.locator('.react-flow__node[data-id="coder-0"]')).toBeVisible()
    await expect(page.locator('.react-flow__node[data-id="coder-1"]')).toHaveCount(0)
    await expect(page.locator('.react-flow__node[data-id="coder-2"]')).toHaveCount(0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// КАО#VR-20 NodeOrder — vertical ordering of coder/tester nodes must follow
// agent_index, not the DB row insertion order
// ────────────────────────────────────────────────────────────────────────────
//
// Regression: after VR-13 (filter by enabled !== false), the filtered array
// preserved the original DB ordering. When /restart recreates agent_configs
// rows out of order, the React Flow graph rendered Coders 3-1-2 (top to
// bottom) instead of 1-2-3.
//
// Fix: append .sort((a, b) => a.agent_index - b.agent_index) to the coder /
// tester filters in buildGraph() and the component-body filter. This test
// stubs a session whose agent_configs come back in [2, 0, 1] order and
// asserts that React Flow lays out coder-0 above coder-1 above coder-2 by Y
// position.

test.describe('КАО#VR-20 NodeOrder — coder/tester nodes sorted by agent_index', () => {
  test.beforeEach(() => {
    requireAuth()
  })

  test('coder nodes render in agent_index order (1,2,3) even when agent_configs are shuffled', async ({ page }) => {
    const sessionId = '00000000-0000-4000-8000-0000000020a1'
    // Insert coders in scrambled order [2, 0, 1] to simulate the
    // post-/restart DB row ordering bug.
    const stub = buildSessionStubWithAgents({
      id: sessionId,
      coders: [
        { index: 2, enabled: true },
        { index: 0, enabled: true },
        { index: 1, enabled: true },
      ],
      testers: [
        { index: 1, enabled: true },
        { index: 0, enabled: true },
      ],
    })
    await stubSessionWithAgents(page, stub)
    await page.goto(`/sessions/${sessionId}`)

    // All 3 coders rendered.
    const coderNodes = page.locator('.react-flow__node[data-id^="coder-"]')
    await expect(coderNodes).toHaveCount(3, { timeout: 20_000 })

    // Read Y position of each coder node via React Flow's transform style.
    // React Flow positions nodes with `transform: translate(Xpx, Ypx)` on
    // the `.react-flow__node` wrapper, so we can compare their Y coords.
    async function nodeY(dataId: string): Promise<number> {
      const box = await page.locator(`.react-flow__node[data-id="${dataId}"]`).boundingBox()
      if (!box) throw new Error(`No bounding box for ${dataId}`)
      return box.y
    }

    const y0 = await nodeY('coder-0')
    const y1 = await nodeY('coder-1')
    const y2 = await nodeY('coder-2')

    // Coder 1 (index 0) must be above Coder 2 (index 1) above Coder 3 (index 2).
    expect(y0).toBeLessThan(y1)
    expect(y1).toBeLessThan(y2)

    // Same check for testers — index 0 above index 1.
    const ty0 = await nodeY('tester-0')
    const ty1 = await nodeY('tester-1')
    expect(ty0).toBeLessThan(ty1)
  })
})
