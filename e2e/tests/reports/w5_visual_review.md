# Wave-5 Visual Review — E2E Test Report (Task VR-7)

**Spec file:** `e2e/tests/wave5-visual-review.spec.ts`
**Run command:**
```
cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
  npx playwright test tests/wave5-visual-review.spec.ts --reporter=list
```

## Environment used for the initial run

| Variable | Value |
|---|---|
| `E2E_BASE_URL` | `https://stage.gotcode.ai` |
| `E2E_AUTH_TOKEN` | Provided token (decoded `exp = 2026-05-14T13:41:22Z`) |
| `E2E_VR_BACKEND_READY` | unset |
| `E2E_VISUAL_REVIEW_SESSION_ID` | unset |
| Date of run | 2026-05-23 |

## Critical finding — token expired

The provided JWT (`exp: 1778766082` = `2026-05-14T13:41:22Z`) was **already expired by 9 days** at the time of the run (`2026-05-23T15:21Z`). The AuthStore's `loadFromStorage()` validates the token by calling `/api/auth/me`, which returns 401, which triggers a redirect to `/login`. Every test in this file (and the existing wave-4 suite — verified by running `wave4-newsession.spec.ts -g "Form fields exist"`) lands on the login screen and times out.

**Required to unblock the suite:** a non-expired access token in `E2E_AUTH_TOKEN`. With a fresh token, the mock-mode and toggle tests should all pass against the current stage frontend (no backend changes needed) because:
* The `/api/sessions/:id` GET is intercepted via `page.route()` and stubbed with `status: 'awaiting_visual_review'`, which auto-opens `VisualReviewPanel` via the existing `useEffect` in `SessionDetailPage.tsx`.
* `?mock_visual_review=1` makes `VisualReviewPanel` use `buildMockCandidates(2)` instead of calling `getVisualReview()`, so the panel renders with no real backend.
* The toggle tests just visit `/sessions/new` and exercise `#skip-visual-review-checkbox` / `#force-visual-review-checkbox`.

## Test case → status table

| # | Case | Group | Result on this run | Will pass with fresh token? | Notes |
|---|---|---|---|---|---|
| 1 | Mock mode renders panel: header, "Mock" badge, 2 candidates, 5 thumbs each, slider | mock | FAIL (login redirect) | YES (frontend-only) | |
| 2 | Submit disabled until both candidates scored | mock | FAIL (login redirect) | YES (frontend-only) | Uses `dispatchEvent('input')` to drive the range input. |
| 3 | Skip button always enabled | mock | FAIL (login redirect) | YES (frontend-only) | |
| 4 | Live-preview modal opens + Esc closes | mock | FAIL (login redirect) | YES (frontend-only) | |
| 5 | Thumbnail click opens zoom modal + Esc closes | mock | FAIL (login redirect) | YES (frontend-only) | |
| 6 | NewSession — "Skip" toggle persists across reload (localStorage `codeforge.newSession.skipVisualReview`) | newsession | FAIL (login redirect) | YES (frontend-only) | localStorage value is the string `'true'`, NOT `'1'` — confirmed by reading `NewSessionPage.tsx` lines 79-124. |
| 7 | NewSession — "Force" toggle persists across reload (localStorage `codeforge.newSession.forceVisualReview`) | newsession | FAIL (login redirect) | YES (frontend-only) | Same string-`'true'` semantics. |
| 8 | Skip ↔ Force mutual exclusion | newsession | FAIL (login redirect) | YES (frontend-only) | |
| 9 | Tournament — banner + Start button appear for N=5, opens Round 1 view | tournament | FAIL (login redirect) | YES (frontend-only) | Sends a 5-candidate payload through `page.route('/visual-review')`. |
| 10 | Tournament — "Prefer this one" advances the match counter | tournament | FAIL (login redirect) | YES (frontend-only) | Permissive: also accepts landing on the summary screen. |
| 11 | Tournament — "Undo last match" disabled on first match | tournament | FAIL (login redirect) | YES (frontend-only) | |
| 12 | Tournament — final summary shows `X.X / 10` scores after all matches | tournament | FAIL (login redirect) | YES (frontend-only) | Clicks left-pref repeatedly with a safety cap of 30 iterations. |
| 13 | Status pill 🎨 Awaiting Visual Review + Review/Skip buttons in header | backend | **SKIPPED** (no `E2E_VR_BACKEND_READY`/`E2E_VISUAL_REVIEW_SESSION_ID`) | Needs backend deploy AND a real awaiting-visual-review session id | |
| 14 | `createSession` POST body carries `settings.skip_visual_review: true` | backend | FAIL (login redirect) | YES (frontend-only) | Intercepts `POST /api/sessions/` with a 422 to avoid creating any session. |

## What needs a real backend deploy on stage

Only **case 13**. Everything else uses `page.route()` to intercept the relevant endpoints, so the tests are completely frontend-driven.

To enable case 13 once the backend lands:
```
E2E_VR_BACKEND_READY=1 \
E2E_VISUAL_REVIEW_SESSION_ID=<uuid-of-a-session-currently-awaiting-visual-review> \
  npx playwright test tests/wave5-visual-review.spec.ts -g "13\."
```

## What needs a fresh token

**All cases.** Without a non-expired `E2E_AUTH_TOKEN`, every test that exercises `/sessions/*` or `/sessions/new` hits the login wall. The token currently provided to this task expired 2026-05-14; today is 2026-05-23.

## Implementation notes / assumptions baked into the spec

1. **Auto-open trigger.** `VisualReviewPanel` only mounts when `showVisualReview === true` in `SessionDetailPage`. That flag flips on the `useEffect` watching `session.status === 'awaiting_visual_review'` (lines 1441-1455 of `frontend/src/pages/SessionDetailPage.tsx`). The `?mock_visual_review=1` URL param alone does NOT auto-open the panel; it only changes the panel's data source once it is opened. The tests therefore stub `GET /api/sessions/:id` with `status: 'awaiting_visual_review'` to trigger auto-open, and ALSO add `?mock_visual_review=1` so the panel uses its in-component fixture data.

   If the team wants the panel to auto-open from the URL param alone (so tests can run without any route stubbing), that's a small frontend tweak — add a `useEffect` that calls `switchToPanel('visualReview')` when the URL param is present. Not done as part of this task per the non-degradation rule.

2. **localStorage values are strings.** `NewSessionPage.tsx` stores `String(skipVisualReview)` (i.e. `'true'` / `'false'`), not `'1'`. The task brief mentioned `'1'` as a guess — the spec uses the actual key/value.

3. **Slider interaction.** Playwright's `fill()` doesn't reliably dispatch React's controlled-input change for `input[type=range]`. The spec uses an `evaluate()` that invokes the native `value` setter and dispatches both `input` and `change` events, which is the standard idiom and triggers the React onChange.

4. **Tournament progression.** `TournamentMode` auto-resolves byes via `queueMicrotask`, so the spec polls (`waitForTimeout(80–150ms)`) between clicks rather than expecting the next match to be synchronously visible.

5. **No real session creation.** Every test that touches `/api/sessions/` (POST) intercepts and 422s, so the suite leaves no residue on stage. There is no `afterAll` cleanup because there's nothing to clean.

## Files

* `e2e/tests/wave5-visual-review.spec.ts` — test file
* `e2e/tests/reports/w5_visual_review.md` — this report
