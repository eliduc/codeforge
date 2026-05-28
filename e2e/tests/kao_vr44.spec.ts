// КАО (Команда Агентов-Отладчиков) — UI/UX writers subteam — VR-44 pass.
//
// Scope (UI side):
//   * VR-44 — while session.status === 'enhancing', at least one enhancer
//             block must be pulsing (AgentNode pulses on working/executing/
//             fixing → renders the `animate-pulse` overlay). The mapping rule
//             lives in SessionDetailPage.loadSession()'s 'enhancing' branch.
//
// Mutation discipline
// -------------------
// READ-ONLY for live data. The default specs here run against FULLY-MOCKED
// endpoints via page.route() — no real session is created, NO LLM run is
// triggered, and no `_e2e_` session is spawned. A live-stage variant that
// would need an actual session sitting in the (transient) `enhancing` state
// is `test.skip`-ped unless E2E_VR44_ENHANCING_SESSION_ID is supplied, because
// that state is fleeting and cannot be guaranteed without kicking off an
// enhancement run (which we must NOT do).
//
// Run (mocked — safe against stage or localhost):
//   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
//     npx playwright test tests/kao_vr44.spec.ts --reporter=list

import { authedTest as test, expect, AUTH_TOKEN, type Page } from './_fixtures/auth'
import type { Route } from '@playwright/test'

// Deterministic, obviously-synthetic UUIDs (the "44" suffix keeps them unique
// from the VR-35..43 spec's fake ids).
const FAKE_ENHANCING = '00000000-0000-4000-8000-0000000000440'
const FAKE_ENHANCING_MID = '00000000-0000-4000-8000-0000000000441'

function requireAuth() {
  test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
}

/**
 * Minimal SessionResponse with the four enhancer agent_configs enabled so the
 * graph builds the enhancer-design / -func / -security / -summarizer nodes.
 */
function buildEnhancingSession(opts: {
  id: string
  status?: string
  enhancerEnabled?: boolean
}): Record<string, unknown> {
  const now = new Date().toISOString()
  const enabled = opts.enhancerEnabled ?? true
  const coder = {
    id: 'coder-0', session_id: opts.id, agent_type: 'coder', agent_index: 0,
    llm_provider: 'anthropic', llm_model: 'claude-3-5-sonnet-20241022', enabled: true, created_at: now,
  }
  const tester = {
    id: 'tester-0', session_id: opts.id, agent_type: 'tester', agent_index: 0,
    llm_provider: 'anthropic', llm_model: 'claude-3-5-sonnet-20241022', enabled: true, created_at: now,
  }
  const meta = ['summarizer', 'finalizer'].map(role => ({
    id: role, session_id: opts.id, agent_type: role, agent_index: 0,
    llm_provider: 'anthropic', llm_model: 'claude-3-5-sonnet-20241022', enabled: true, created_at: now,
  }))
  const enhancers = ['enhancer_design', 'enhancer_func', 'enhancer_security', 'enhancer_summary'].map(role => ({
    id: role, session_id: opts.id, agent_type: role, agent_index: 0,
    llm_provider: 'anthropic', llm_model: 'claude-3-5-sonnet-20241022', enabled, created_at: now,
  }))
  return {
    id: opts.id,
    name: '_e2e_vr44_stub',
    specification: 'noop',
    language: 'javascript_browser',
    max_iterations: 3,
    current_iteration: 1,
    status: opts.status ?? 'enhancing',
    execution_timeout: 60,
    enable_code_execution: true,
    max_fix_attempts: 3,
    auto_install_deps: false,
    auto_continue: false,
    agent_timeout: 600,
    request_timeout: 300,
    enhancement_round: 1,
    created_at: now,
    updated_at: now,
    agent_configs: [coder, tester, ...meta, ...enhancers],
    settings: {},
  }
}

/** Stub the endpoints SessionDetailPage hits on mount for an enhancing session. */
async function stubEnhancingRoutes(page: Page, opts: {
  sessionId: string
  session: Record<string, unknown>
}): Promise<void> {
  const { sessionId } = opts
  await page.route(`**/api/sessions/${sessionId}`, async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(opts.session) })
    } else {
      await route.continue()
    }
  })
  await page.route(`**/api/sessions/${sessionId}/metrics`, async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        session_id: sessionId, total_tokens: 0, total_tokens_input: 0,
        total_tokens_output: 0, total_cost_usd: 0, total_requests: 0,
      }),
    })
  })
  // Final result exists (enhancement runs AFTER a completed pipeline).
  await page.route(`**/api/sessions/${sessionId}/final-result`, async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        session_id: sessionId,
        final_code: 'console.log("e2e")',
        language: 'javascript_browser',
        summary: 'noop', iteration: 1, total_cost_usd: 0, total_tokens: 0,
        created_at: new Date().toISOString(), file_structure: {},
        selected_coder_index: 0,
      }),
    })
  })
  // Enhancement suggestions — empty so the panel doesn't 404.
  await page.route(`**/api/sessions/${sessionId}/enhancement-suggestions`, async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [] }) })
  })
}

// ────────────────────────────────────────────────────────────────────────────
// КАО#VR-44 — enhancing status → at least one pulsing enhancer block (mocked)
// ────────────────────────────────────────────────────────────────────────────

test.describe('КАО#VR-44 — enhancing pulse invariant (mocked routes)', () => {
  test.beforeEach(() => {
    requireAuth()
  })

  test('an enhancing session renders the enhancer nodes with ≥1 pulsing block', async ({ page }) => {
    // КАО#VR-44 — the graph must show enhancer-design/func/security pulsing
    // (status 'working') while the D/F/S sub-phase is active. AgentNode marks
    // the active overlay with the `animate-pulse` utility class.
    const sessionId = FAKE_ENHANCING
    await stubEnhancingRoutes(page, {
      sessionId,
      session: buildEnhancingSession({ id: sessionId, status: 'enhancing' }),
    })

    await page.goto(`/sessions/${sessionId}`)

    // Page booted (metrics panel renders) → no crash.
    await expect(page.locator('[data-tour="metrics-panel"]')).toBeVisible({ timeout: 20_000 })

    // The metrics badge humanizes 'enhancing' (VR-43) — sanity that we're in
    // the right state.
    await expect(page.getByText('Enhancing…')).toBeVisible({ timeout: 20_000 })

    // INVARIANT: at least one node in the graph is pulsing.
    // AgentNode renders the active gradient overlay with `animate-pulse`.
    await expect
      .poll(async () => await page.locator('[data-tour="agent-graph"] .animate-pulse').count(), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(1)
  })

  test('enhancer labels (Design / Functionality / Security) are present in the graph', async ({ page }) => {
    // КАО#VR-44 — confirms the enhancer blocks actually exist to pulse. The
    // AgentNode config labels are "Design", "Functionality", "Security".
    const sessionId = FAKE_ENHANCING_MID
    await stubEnhancingRoutes(page, {
      sessionId,
      session: buildEnhancingSession({ id: sessionId, status: 'enhancing' }),
    })

    await page.goto(`/sessions/${sessionId}`)

    await expect(page.locator('[data-tour="metrics-panel"]')).toBeVisible({ timeout: 20_000 })
    // At least one enhancer label must be visible in the canvas.
    const graph = page.locator('[data-tour="agent-graph"]')
    await expect(graph.getByText('Design', { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// КАО#VR-44 — LIVE variant (skipped unless a real enhancing session is given)
// ────────────────────────────────────────────────────────────────────────────
//
// A genuine `enhancing` session is transient and cannot be guaranteed without
// kicking off an LLM enhancement run — which this subteam must NOT do. So this
// test is skipped unless the operator points it at a pre-existing session
// (e.g. an `_e2e_`-prefixed one parked in `enhancing`) via
// E2E_VR44_ENHANCING_SESSION_ID. It is purely an OBSERVE-only check.

const LIVE_ENHANCING_ID = process.env.E2E_VR44_ENHANCING_SESSION_ID ?? ''

test.describe('КАО#VR-44 — enhancing pulse invariant (live, opt-in)', () => {
  test.beforeEach(() => {
    requireAuth()
    test.skip(
      !LIVE_ENHANCING_ID,
      'needs E2E_VR44_ENHANCING_SESSION_ID — a session known to be in `enhancing` state. ' +
        'Not auto-created: that would trigger a real LLM enhancement run.',
    )
  })

  test('live enhancing session shows ≥1 pulsing enhancer block', async ({ page }) => {
    await page.goto(`/sessions/${LIVE_ENHANCING_ID}`)
    await expect(page.locator('[data-tour="metrics-panel"]')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(async () => await page.locator('[data-tour="agent-graph"] .animate-pulse').count(), {
        timeout: 20_000,
      })
      .toBeGreaterThanOrEqual(1)
  })
})
