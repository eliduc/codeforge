# Wave-4 NewSession Tester Report

- **Spec file**: `e2e/tests/wave4-newsession.spec.ts`
- **Target**: `https://stage.gotcode.ai`
- **Auth**: `E2E_AUTH_TOKEN` for `levrlg@gmail.com` (sub `7572b001-...`)
- **Reference UI**: `frontend/src/pages/NewSessionPage.tsx`
- **Reference API**: `frontend/src/services/api.ts` (`createSession`, `deleteSession`, `cancelSession`)
- **Run command**:
  ```bash
  cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
    npx playwright test tests/wave4-newsession.spec.ts --reporter=list
  ```
- **Result**: 10/10 passed in 49.3s (full-parallel, 4 workers, chromium)

## Case / result table

| # | Case | Result | Notes |
|---|------|--------|-------|
| 1 | Form fields exist | PASS | Spec textarea autofocused (`document.activeElement.id === 'spec-input'`); language `<option>` set is a strict superset of `[python, javascript, typescript, html, rust, go]`; iter min/max/default = 1/10/3, coders/testers min/max/default = 1/4/2; enhancement checkbox defaults to checked after clearing `localStorage` key `codeforge.newSession.useEnhancementPipeline`; "Try a template" link and "Create session" submit button render. |
| 2 | Submit disabled until spec ≥ 20 chars (КАО R14-FIX-02) | PASS | Empty → disabled, 5 chars → disabled, 25 chars → enabled, cleared → disabled. |
| 3 | Char counter updates live | PASS | `[aria-live="polite"]` counter shows `0` initially, `25` after `fill(a*25)`. Counter format is `N / 100,000` (not `N/20+ chars` as written in the brief — see "Spec deviation A"). |
| 4 | Min-length error after invalid submit | PASS | Submit button is disabled on invalid input, so the test dispatches a `submit` event on the `<form>` to trigger `validate()`; the `#spec-error` span then renders "Specification must be at least 20 characters". |
| 5 | Iterations bounds | PASS | `value=0` → submit disabled; `value=11` → submit disabled; `value=5` → enabled. Note: `<input type=number>` HTML5 native `min/max` attributes do not block typing out-of-range values — the gating is enforced by `isFormValid` in React state (verified). |
| 6 | Autogen name preview | PASS | After `fill("Build a snake game with arrow keys and walls")`, `#name-input` placeholder matches `/Session\s*—\s*Build a snake game with arrow/`. Code uses an em-dash (U+2014), not a hyphen. |
| 7 | Submit happy path with cleanup | PASS | Submitted with name `_e2e_w4_<ts>_create_test`, spec ≥ 20 chars, language `javascript`, iterations/coders/testers = 1/1/1, enhancement off. The POST `/api/sessions/` returned 2xx and the page navigated to `/sessions/:id`. Both a `response`-listener and a URL match captured the new ID; the test issued an immediate `POST /api/sessions/:id/cancel` and tracked the ID for `afterAll` `DELETE /api/sessions/:id`. |
| 8 | Error recovery banner (Try-again) | PASS | `page.route('**/api/sessions/')` returned 422; the inline `role="alert"` banner appeared with "Could not create session" and a "Try again" button. URL stayed at `/sessions/new`. Clicking "Try again" hides the banner. **No real session was created — request was intercepted client-side.** |
| 9 | Cancel button → /sessions | PASS | The form ships a `<button type="button">Cancel</button>` (not a link); clicking navigates to `/sessions`. |
| 10 | "Try a template" link | PASS | Link `href="/sessions"`; clicking navigates to `/sessions`. (The templates panel itself lives on `SessionsPage.tsx`; the NewSession page has no in-page template modal — see "Spec deviation B".) |

## Spec deviations & findings (no code fixes — documented only)

1. **`language: javascript_browser` is not an option in the UI.** `LANGUAGE_OPTIONS` in `NewSessionPage.tsx:17-24` exposes exactly `python / javascript / typescript / html / rust / go`. The closest browser-runnable choice is `javascript`. Test 7 uses `javascript` and notes this in a code comment. The backend may accept `javascript_browser` (the form selects from a curated subset), but it cannot be chosen through this UI.
2. **No `auto_start` flag in `CreateSessionRequest`.** Inspected `frontend/src/types/index.ts:322-349` and `frontend/src/services/api.ts:422-427`. The frontend cannot prevent the backend from auto-starting. The test mitigates this by issuing `POST /api/sessions/:id/cancel` immediately after the POST returns (both via a `page.on('response')` hook and in `test.afterAll`), then `DELETE`. Cost exposure: 1 session × `javascript` × 1 iter × 1 coder × 1 tester, cancelled within milliseconds. Final cleanup is independent of test outcome.
3. **Char counter wording.** Brief expects `25/20+ chars`; the actual UI renders `25 / 100,000` (current count / `SPEC_MAX_CHARS`). The min-length is shown separately as the helper text `Minimum 20 characters.` below. Test 3 asserts the live update, not the exact format.
4. **`Cancel` is a `<button>`, not a `<Link>`.** Brief says "Cancel link or button (if present)". The implementation is a button that calls `navigate('/sessions')`. Test 9 covers it.
5. **No in-page templates modal.** The "Try a template" element is a hyperlink to `/sessions` (the templates panel lives on `SessionsPage.tsx`, per the source comment at `NewSessionPage.tsx:536-545`). Test 10 verifies the navigation behaviour, which matches the actual implementation.
6. **Test 8 uses route interception** rather than triggering a real 4xx with a malformed payload. Rationale: client-side validation (gated by `isFormValid`) blocks the user from sending a request that would round-trip to 422 — the name input is clamped at `maxLength=255`, iterations/coders/testers are gated, spec length is gated. The only way to provoke a deterministic 4xx without LLM cost is to mock the response. The error banner UX is exercised end-to-end.

## Cleanup audit

**Mutation cap**: 5 sessions (enforced via `SESSION_CREATION_LIMIT`).
**Sessions created during this run**: exactly **1** (Test 7).
  - Name pattern: `_e2e_w4_<timestamp>_create_test`
  - Language: `javascript`, iterations=1, coders=1, testers=1, enhancement off.
  - Lifecycle: `POST /api/sessions/` → captured `id` from response body and URL → `POST /api/sessions/:id/cancel` (immediate) → `DELETE /api/sessions/:id` (in `test.afterAll`).
**Test 8** uses `page.route()` to intercept the POST and return 422 client-side — **no real session created**.
**All other tests** (1–6, 9, 10) never click Submit, so no creation.

**Post-run verification** (executed by the tester after the run completed):
```
GET https://stage.gotcode.ai/api/sessions/?limit=50
→ sessions whose name starts with "_e2e_w4_": 0
```
Confirmed: zero leftover `_e2e_w4_*` sessions on stage.

The `afterAll` hook iterates `CREATED_SESSION_IDS`, issues `cancel` then `DELETE`, and logs the HTTP status for every ID. The `Set` deduplicates IDs added by both the response listener and the URL parser in Test 7. Even on test failure, `afterAll` runs (Playwright guarantees this for `test.afterAll` outside of catastrophic worker crashes), so cleanup is robust to assertion failures.

## Open issues noticed but NOT fixed

- The UI label "Minimum 20 characters." (helper text) and the field error "Specification must be at least 20 characters" share the same number but are rendered by different elements; future copy refactors should keep them in sync.
- `localStorage['codeforge.newSession.useEnhancementPipeline']` survives across sessions per-user-per-browser; the "default checked" assertion in Test 1 explicitly removes it before reload to avoid flakiness if a prior test ran on the same origin/user.
- No `auto_start: false` flag in the public API. Worth considering for future E2E ergonomics — it would let test code create a session without the backend kicking off an LLM job that has to be cancelled in a race with the test runner.
