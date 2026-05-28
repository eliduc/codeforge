# R14 Team 1 — Sessions Surface Test Report

**Phase**: КАО Round 14, Team 1 (Test-Writer / Sessions surface)
**Target**: `https://stage.gotcode.ai`
**Spec**: `e2e/tests/wave3-sessions.spec.ts` (13 cases)
**Framework**: Playwright (chromium project, `--reporter=list`)

## Run command

```
cd e2e && E2E_BASE_URL=https://stage.gotcode.ai \
  npx playwright test tests/wave3-sessions.spec.ts --reporter=list
```

## Auth model verified from existing tests

From `e2e/tests/sessions-list.spec.ts`:

```ts
await page.addInitScript((t) => {
  localStorage.setItem('codeforge_token', t)
}, token)
```

So the JWT lives in `localStorage` under the key **`codeforge_token`** —
**not** a cookie named `cf_token` as the spec hinted. The new file uses the
verified pattern (`page.addInitScript` injecting localStorage before
navigation).

## Cases

| # | Title | Wave / Priority | Auth | Status (initial run) |
|---|-------|------|------|----------------------|
| 1 | `/sessions` redirects anonymous to `/login` | smoke | no | **PASS** (5.0 s) |
| 2 | Status pills always visible (zero-count muted) | W2 P1·M | yes | skipped — no `E2E_AUTH_TOKEN` |
| 3 | Sort dropdown present with all five options | W2 P1·S | yes | skipped — no `E2E_AUTH_TOKEN` |
| 4 | Kebab menu on each session row exposes Copy / Copy structure / Delete | W2 P1·S | yes | skipped — no `E2E_AUTH_TOKEN` |
| 5 | Header secondary actions collapse < md, expand at md+ | W2 P1·S | yes | skipped — no `E2E_AUTH_TOKEN` |
| 6 | Empty-state "Clear filters" resets search | W2 P1·S | yes | skipped — no `E2E_AUTH_TOKEN` |
| 7 | "Showing N of M sessions" line above Load More | W3 P3·S | yes | skipped — no `E2E_AUTH_TOKEN` |
| 8 | `/sessions/new` real form (all fields) | W1 P0·S | yes | skipped — no `E2E_AUTH_TOKEN` |
| 9 | NewSessionPage inline validation (min 20 chars) | W1 | yes | skipped — no `E2E_AUTH_TOKEN` |
| 10 | SessionCompareModal diff-mode tabs, side-by-side default | W3 P2·S | yes | skipped — no `E2E_AUTH_TOKEN` |
| 11 | Dashboard humanized status pills link to `/sessions?status=…` | W3 P2·S | yes | skipped — no `E2E_AUTH_TOKEN` |
| 12 | PipelineBuilder remove-with-confirm (Cancel) | W3 P2·S | yes | **skipped (unconditional)** — see Notes |
| 13 | `formatDate` is locale-aware | W3 P3·S | yes | skipped — no `E2E_AUTH_TOKEN` |

Run summary: **1 passed, 12 skipped, 0 failed** (~1m wall time including a
chromium install).

## Skip reasoning

* **Auth-required tests (2–11, 13)** — `test.skip(!process.env.E2E_AUTH_TOKEN, …)`
  per the prompt's rule. They will run in CI when the token is supplied. Each
  test also makes a fine-grained content-driven skip: e.g. case 2 skips
  cleanly when the account has zero sessions (pills are hidden by design),
  case 6 skips when the search bar is not rendered (no sessions loaded), case
  11 skips when "No sessions in window" is rendered on the Dashboard.

* **Test 12 (PipelineBuilder) — unconditional skip with a flag for Team 3.**
  The spec asks to "visit `/sessions/new` (if PipelineBuilder is reachable
  from there or via a link)". Verified via `Grep`:
  `frontend/src/components/PipelineBuilder.tsx` is the **only** file in
  `frontend/src` that imports the `PipelineBuilder` symbol — no page wires
  it in. Reading `frontend/src/pages/NewSessionPage.tsx` end-to-end confirms
  that route renders a plain form, not the pipeline graph. Rather than
  asserting against a surface that doesn't render PipelineBuilder (which
  would be a false positive against Wave 3 P2·S itself), the test is skipped
  with a comment explaining the discoverability gap so Team 3 can decide
  whether to:
    1. Wire PipelineBuilder into `/sessions/new` (or another reachable
       route), or
    2. Document that PipelineBuilder lives in a session-detail context, and
       update R14 spec accordingly.

  The intended assertion body is included in the test file as a commented
  block so the test is one-line-flip ready once discoverability is fixed.

## Findings already worth flagging to Team 3

These are not bugs the tests will catch (they belong to discovery), but they
surfaced while writing the tests:

* **Test 8 (NewSessionPage real form)** — the R14 spec says
  "Submit button is disabled (specification empty)". In code (`NewSessionPage.tsx:498`)
  `disabled={submitting}` — the button is only disabled while submitting, not
  on empty spec. Validation runs *after* the submit click (which is
  consistent with test 9). The test asserts the actual current behaviour
  (button is visible, validation surfaces inline) and adds an inline comment
  flagging the spec mismatch. Team 3 should decide whether to:
    1. Pre-disable the submit button when spec is empty / under 20 chars
       (matches the spec wording), or
    2. Keep validate-on-submit and adjust the Round-14 spec text.

* **Test 12 (PipelineBuilder)** — discoverability gap, see above.

* **Cookie name in R14 spec** — the spec hinted `cf_token` cookie. The actual
  app uses `localStorage` key `codeforge_token`. Test file uses the verified
  storage path.

## File locations

* Test file: `e2e/tests/wave3-sessions.spec.ts` (absolute:
  `C:\work\Sandbox\MultiAgentCoder\ClaudeCodeStage\e2e\tests\wave3-sessions.spec.ts`)
* This report: `tests/reports/r14_team1_sessions.md` (absolute:
  `C:\work\Sandbox\MultiAgentCoder\ClaudeCodeStage\tests\reports\r14_team1_sessions.md`)

## Source files read (load-bearing for assertions)

* `frontend/src/pages/SessionsPage.tsx` (status-pills logic at L846–873, kebab
  Menu at L1048–1149, footer "Showing N of M" at L1156–1162, formatDate at
  L443–451, Clear filters at L941–945, mobile More overflow at L564–627)
* `frontend/src/pages/NewSessionPage.tsx` (field IDs `spec-input`,
  `name-input`, `lang-select`, `iter-input`, `coders-input`, `testers-input`,
  `enhancement-checkbox`; submit button at L496–507; spec validation at
  L99–119; char counter at L334–338)
* `frontend/src/pages/DashboardPage.tsx` (Sessions by Status block at
  L65–87, humanizeStatus import at L6)
* `frontend/src/components/SessionCompareModal.tsx` (view-mode tablist at
  L165–195, ViewMode default `'side'` at L50)
* `frontend/src/components/PipelineBuilder.tsx` (ConfirmDialog wiring at
  L843–852 — title text `Remove Coder N?`)
* `e2e/tests/sessions-list.spec.ts` (auth pattern source of truth)
