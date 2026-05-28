// Wave-4 NewSession tester — KAO W4
//
// Validates the New Session form (frontend/src/pages/NewSessionPage.tsx) and
// associated submit/error UX on https://stage.gotcode.ai.
//
// MUTATION DISCIPLINE:
//   - Every created session name starts with `_e2e_w4_<timestamp>_`.
//   - Spec text is intentionally tiny.
//   - language uses an in-browser-runnable option to minimise sandbox cost.
//   - All created session IDs are tracked in CREATED_SESSION_IDS and deleted
//     in test.afterAll via the REST API (DELETE /api/sessions/:id).
//   - Hard cap: 5 sessions across this file.
//
// Run:
//   cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
//     npx playwright test tests/wave4-newsession.spec.ts --reporter=list

import { authedTest as test, expect, AUTH_TOKEN, BASE_URL, type Page } from './_fixtures/auth'

// ────────────────────────────────────────────────────────────────────────────
// Cleanup tracking
// ────────────────────────────────────────────────────────────────────────────
const CREATED_SESSION_IDS = new Set<string>()
const SESSION_CREATION_LIMIT = 5

async function recordCreated(id: string) {
  CREATED_SESSION_IDS.add(id)
}

async function apiDelete(id: string): Promise<{ ok: boolean; status: number; body?: string }> {
  if (!AUTH_TOKEN) return { ok: false, status: 0, body: 'no auth' }
  try {
    const resp = await fetch(`${BASE_URL}/api/sessions/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
    const body = resp.ok ? undefined : await resp.text().catch(() => undefined)
    return { ok: resp.ok, status: resp.status, body }
  } catch (err) {
    return { ok: false, status: 0, body: String(err) }
  }
}

async function apiCancel(id: string): Promise<void> {
  if (!AUTH_TOKEN) return
  try {
    await fetch(`${BASE_URL}/api/sessions/${id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    })
  } catch {
    /* best effort */
  }
}

function requireAuth() {
  test.skip(!AUTH_TOKEN, 'needs E2E_AUTH_TOKEN')
}

function tsName(suffix: string): string {
  return `_e2e_w4_${Date.now()}_${suffix}`
}

// Final cleanup pass — covers every tracked ID even on test failure.
test.afterAll(async () => {
  if (CREATED_SESSION_IDS.size === 0) return
  // eslint-disable-next-line no-console
  console.log(`[w4-newsession] cleanup: deleting ${CREATED_SESSION_IDS.size} session(s)`)
  for (const id of CREATED_SESSION_IDS) {
    // Try cancel first (in case run is in-flight), then delete.
    await apiCancel(id)
    const res = await apiDelete(id)
    // eslint-disable-next-line no-console
    console.log(`[w4-newsession] DELETE /api/sessions/${id} -> ${res.status} ${res.ok ? 'ok' : `FAIL ${res.body ?? ''}`}`)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

test.describe('Wave-4 NewSession form', () => {
  test.beforeEach(async ({ page }) => {
    requireAuth()
    // Speed up provider load — wait for the page-shell, then form.
    await page.goto('/sessions/new')
    await expect(page.getByRole('heading', { name: /New Session/i })).toBeVisible({ timeout: 15_000 })
  })

  // 1) Form fields exist
  test('1. Form fields exist', async ({ page }) => {
    const specTa = page.locator('#spec-input')
    await expect(specTa).toBeVisible()
    await expect(specTa).toHaveAttribute('rows', '10')
    // Autofocus check — Playwright reads document.activeElement.
    const focusedId = await page.evaluate(() => document.activeElement?.id ?? '')
    expect(focusedId).toBe('spec-input')

    await expect(page.locator('#name-input')).toBeVisible()

    const lang = page.locator('#lang-select')
    await expect(lang).toBeVisible()
    const langValues = await lang.locator('option').evaluateAll((opts) =>
      (opts as HTMLOptionElement[]).map((o) => o.value),
    )
    expect(langValues).toEqual(
      expect.arrayContaining(['python', 'javascript', 'typescript', 'html', 'rust', 'go']),
    )

    const iter = page.locator('#iter-input')
    await expect(iter).toHaveAttribute('min', '1')
    await expect(iter).toHaveAttribute('max', '10')
    await expect(iter).toHaveValue('3')

    const coders = page.locator('#coders-input')
    await expect(coders).toHaveAttribute('min', '1')
    await expect(coders).toHaveAttribute('max', '4')
    await expect(coders).toHaveValue('2')

    const testers = page.locator('#testers-input')
    await expect(testers).toHaveAttribute('min', '1')
    await expect(testers).toHaveAttribute('max', '4')
    await expect(testers).toHaveValue('2')

    const enh = page.locator('#enhancement-checkbox')
    await expect(enh).toBeVisible()
    // Default checked (unless localStorage overrode it on a previous run); a
    // best-effort assertion — the page reads localStorage so we clear it first.
    await page.evaluate(() => localStorage.removeItem('codeforge.newSession.useEnhancementPipeline'))
    await page.reload()
    await expect(page.locator('#enhancement-checkbox')).toBeChecked()

    await expect(page.getByRole('link', { name: /Try a template/i })).toBeVisible()

    const submit = page.getByRole('button', { name: /Create session/i })
    await expect(submit).toBeVisible()
  })

  // 2) Submit disabled until valid — KAO R14-FIX-02
  test('2. Submit disabled until spec >= 20 chars', async ({ page }) => {
    const spec = page.locator('#spec-input')
    const submit = page.getByRole('button', { name: /Create session/i })

    await expect(submit).toBeDisabled()

    await spec.fill('12345')
    await expect(submit).toBeDisabled()

    await spec.fill('a'.repeat(25))
    await expect(submit).toBeEnabled()

    await spec.fill('')
    await expect(submit).toBeDisabled()
  })

  // 3) Char counter live update
  test('3. Char counter updates as user types', async ({ page }) => {
    const spec = page.locator('#spec-input')
    const counter = page.locator('[aria-live="polite"]').first()
    await expect(counter).toContainText('0')
    await spec.fill('a'.repeat(25))
    await expect(counter).toContainText('25')
  })

  // 4) Min length error after blur (after attempting submit)
  test('4. Min-length error after invalid submit attempt', async ({ page }) => {
    const spec = page.locator('#spec-input')
    await spec.fill('short')
    // Blur away; field-level errors only render after validate() runs on submit,
    // so we trigger a submit via Enter or by forcing form.submit. The submit
    // button is disabled, so dispatch a submit event directly to invoke
    // handleSubmit -> validate() -> setFieldErrors.
    await page.locator('form').evaluate((f) => {
      ;(f as HTMLFormElement).dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }))
    })
    const err = page.locator('#spec-error')
    await expect(err).toBeVisible()
    await expect(err).toContainText(/at least 20 characters/i)
  })

  // 5) Iterations bounds
  test('5. Iterations bounds (1–10) gate Submit', async ({ page }) => {
    const spec = page.locator('#spec-input')
    const iter = page.locator('#iter-input')
    const submit = page.getByRole('button', { name: /Create session/i })

    await spec.fill('a'.repeat(40))
    await expect(submit).toBeEnabled()

    await iter.fill('0')
    await expect(submit).toBeDisabled()

    await iter.fill('11')
    await expect(submit).toBeDisabled()

    await iter.fill('5')
    await expect(submit).toBeEnabled()
  })

  // 6) Autogen name preview in placeholder
  test('6. Autogen name preview in name placeholder', async ({ page }) => {
    const spec = page.locator('#spec-input')
    const nameInput = page.locator('#name-input')
    await spec.fill('Build a snake game with arrow keys and walls')
    const placeholder = await nameInput.getAttribute('placeholder')
    expect(placeholder).toMatch(/Session\s*—\s*Build a snake game with arrow/i)
  })

  // 7) Submit happy path with cleanup
  test('7. Submit happy path (or graceful error banner)', async ({ page }) => {
    test.skip(CREATED_SESSION_IDS.size >= SESSION_CREATION_LIMIT, 'mutation cap reached')

    const sessionName = tsName('create_test')
    await page.locator('#spec-input').fill('echo hello world from e2e w4 test_____')
    await page.locator('#name-input').fill(sessionName)
    // The form's `LANGUAGE_OPTIONS` does not include `javascript_browser`; the
    // most browser-runnable option is `javascript`. We document the deviation.
    await page.locator('#lang-select').selectOption('javascript')
    await page.locator('#iter-input').fill('1')
    await page.locator('#coders-input').fill('1')
    await page.locator('#testers-input').fill('1')
    const enh = page.locator('#enhancement-checkbox')
    if (await enh.isChecked()) await enh.uncheck()

    // Intercept POST /api/sessions to capture the created ID even if the page
    // navigates faster than our locator can read it.
    let createdId: string | null = null
    page.on('response', async (resp) => {
      try {
        if (resp.request().method() === 'POST' && /\/api\/sessions\/?$/.test(resp.url()) && resp.status() < 300) {
          const body = await resp.json().catch(() => null) as { id?: string } | null
          if (body?.id) {
            createdId = body.id
            await recordCreated(body.id)
            // Immediate cancel to halt any LLM spend.
            await apiCancel(body.id)
          }
        }
      } catch {
        /* ignore */
      }
    })

    const submit = page.getByRole('button', { name: /Create session/i })
    await expect(submit).toBeEnabled()
    await submit.click()

    // Either navigation to /sessions/:id OR an inline error banner appears.
    const navigated = await page
      .waitForURL(/\/sessions\/[0-9a-f-]{8,}/, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false)

    if (navigated) {
      const url = page.url()
      const idMatch = url.match(/\/sessions\/([0-9a-f-]{8,})/)
      const id = idMatch?.[1] ?? createdId
      expect(id, 'expected a session id captured from URL or POST response').toBeTruthy()
      if (id) {
        await recordCreated(id)
        await apiCancel(id)
      }
    } else {
      // Error banner path — assert inline alert + "Try again" button.
      const alert = page.getByRole('alert')
      await expect(alert).toBeVisible({ timeout: 10_000 })
      await expect(alert).toContainText(/Could not create session/i)
      await expect(alert.getByRole('button', { name: /Try again/i })).toBeVisible()
      // Sanity: no redirect to /sessions/:id.
      expect(page.url()).toMatch(/\/sessions\/new$/)
    }
  })

  // 8) Error recovery banner — force a 4xx with extremely long name (>255 chars
  // is clamped client-side by maxLength=255; instead intercept the POST and
  // return 422 to assert the banner UX renders regardless of trigger).
  test('8. Error recovery banner appears with Try-again button', async ({ page }) => {
    // Intercept the create call and respond with 422 to deterministically
    // exercise the error UI without spending tokens or hitting backend rate
    // limits.
    await page.route('**/api/sessions/', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 422,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'mocked validation error for e2e' }),
        })
      } else {
        await route.continue()
      }
    })

    await page.locator('#spec-input').fill('echo hello world from e2e error path_______')
    await page.locator('#iter-input').fill('1')
    await page.locator('#coders-input').fill('1')
    await page.locator('#testers-input').fill('1')

    const submit = page.getByRole('button', { name: /Create session/i })
    await expect(submit).toBeEnabled()
    await submit.click()

    const alert = page.getByRole('alert')
    await expect(alert).toBeVisible({ timeout: 10_000 })
    await expect(alert).toContainText(/Could not create session/i)
    await expect(alert.getByRole('button', { name: /Try again/i })).toBeVisible()
    // Stays on the form (no navigation).
    expect(page.url()).toMatch(/\/sessions\/new$/)

    // Click Try again — banner should dismiss.
    await alert.getByRole('button', { name: /Try again/i }).click()
    await expect(alert).toBeHidden()
  })

  // 9) Cancel link/button navigates back to /sessions
  test('9. Cancel button navigates to /sessions', async ({ page }) => {
    const cancel = page.getByRole('button', { name: /^Cancel$/ })
    await expect(cancel).toBeVisible()
    await cancel.click()
    await page.waitForURL(/\/sessions(\?|$|\/)/, { timeout: 10_000 })
    expect(page.url()).toMatch(/\/sessions(\?|$|\/)/)
  })

  // 10) "Try a template" link
  test('10. "Try a template" link navigates to /sessions', async ({ page }) => {
    const link = page.getByRole('link', { name: /Try a template/i })
    await expect(link).toBeVisible()
    const href = await link.getAttribute('href')
    expect(href).toBe('/sessions')
    await link.click()
    await page.waitForURL(/\/sessions(\?|$|\/)/, { timeout: 10_000 })
    expect(page.url()).toMatch(/\/sessions(\?|$|\/)/)
  })
})
