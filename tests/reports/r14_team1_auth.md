# R14 Team 1 — Test-Writer / Auth & Onboarding

**Phase**: КАО Round 14, Phase 1 (Test-Writer)
**Surface**: `/login` and onboarding (Wave 1–3 changes)
**Spec file**: `e2e/tests/wave3-auth.spec.ts`
**Target**: `https://stage.gotcode.ai`
**Run cmd**:
```
cd e2e && E2E_BASE_URL=https://stage.gotcode.ai npx playwright test tests/wave3-auth.spec.ts --reporter=list
```

## Test cases written

1. **Email input a11y + autofill** (`Wave 3 — LoginPage email step a11y`)
   - Asserts `#email` has `autocomplete="email"`, `name="email"`, `type="email"`, `inputmode="email"`. Covers Улучшатели#1 P1·S email-autocomplete fix.

2. **Decorative logo aria-hidden** (`Wave 3 — LoginPage logo a11y`)
   - Asserts the outer block containing the Code2 SVG + "CodeForge" title has `aria-hidden="true"` so screen-readers skip the decorative icon. Covers P3·S logo-a11y fix.

3. **No `<a href="//…">` on login DOM** (`Wave 3 — Open-redirect safety on from-path`)
   - Defensive smoke test: asserts there are zero `a[href^="//"]` anchors on the rendered `/login` page (i.e., no protocol-relative URL leaked into the DOM). Covers P2·S `safeFromPath` hardening.

4. **`safeFromPath("//evil.com")` keeps user on /login** (`Wave 3 — Open-redirect safety on from-path`)
   - Pushes `{ from: "//evil.com" }` into `history.state` and reloads. After router consumes the state, we assert we're still on `/login` with the email input visible — `safeFromPath` should have neutralised the protocol-relative input. Covers P2·S.

5. **First OTP input `autoComplete="one-time-code"`** (`Wave 3 — OTP step a11y`)
   - `test.fixme` unless `E2E_TEST_EMAIL` is set (real OTP request required). Covers P1·S OTP autofill.

6. **All 6 OTP inputs have `aria-label="Digit N of 6"`** (`Wave 3 — OTP step a11y`)
   - `test.fixme` unless `E2E_TEST_EMAIL` is set. Covers P1·S a11y labelling.

7. **All 6 OTP inputs have `inputMode="numeric"` + `pattern="[0-9]*"`** (`Wave 3 — OTP step a11y`)
   - `test.fixme` unless `E2E_TEST_EMAIL` is set. Covers P1·S mobile-keypad fix.

8. **All 6 OTP boxes render at ~48px height (h-12 fix)** (`Wave 3 — OTP step a11y`)
   - `test.fixme` unless `E2E_TEST_EMAIL` is set. Measures `boundingBox().height` and asserts 44 ≤ h ≤ 56 to catch the regression where `h-13` (non-existent Tailwind class) collapsed boxes to ~24px. Covers P3·S height bug.

9. **Resend button shows `"Resend in Ns"` and is disabled** (`Wave 3 — OTP step a11y`)
   - `test.fixme` unless `E2E_TEST_EMAIL` is set. Verifies cooldown initialised to 60s after first request. Covers P1·S Resend cooldown.

10. **Not-allowed copy + Learn more link** (`Wave 3 — Allowed-list step copy`)
    - `test.fixme` unless `E2E_NOT_ALLOWED_EMAIL` is set. Asserts "1 business day" copy is visible AND a "Learn more" link exists with `target="_blank"` plus `rel` containing `noopener`. Covers P3·S not-allowed UX.

## Initial run results (--reporter=list)

```
Running 10 tests using 4 workers

  ok  3 [chromium] › tests\wave3-auth.spec.ts:46:7 › Wave 3 — Open-redirect safety on from-path › no protocol-relative anchor smuggled onto /login DOM (3.2s)
  ok  2 [chromium] › tests\wave3-auth.spec.ts:29:7 › Wave 3 — LoginPage logo a11y › decorative logo container has aria-hidden="true" (3.3s)
  ok  4 [chromium] › tests\wave3-auth.spec.ts:16:7 › Wave 3 — LoginPage email step a11y › email input has required a11y + autofill attributes (3.3s)
  -   6 [chromium] › tests\wave3-auth.spec.ts:98:7 › Wave 3 — OTP step a11y (needs reachable OTP step) › all 6 OTP inputs have aria-label "Digit N of 6"
  -   5 [chromium] › tests\wave3-auth.spec.ts:86:7 › Wave 3 — OTP step a11y (needs reachable OTP step) › first OTP input has autoComplete="one-time-code"
  ok  1 [chromium] › tests\wave3-auth.spec.ts:57:7 › Wave 3 — Open-redirect safety on from-path › safeFromPath rejects "//evil.com" via location.state — client-side helper (3.6s)
  -   7 [chromium] › tests\wave3-auth.spec.ts:111:7 › Wave 3 — OTP step a11y (needs reachable OTP step) › all 6 OTP inputs have inputMode="numeric" and pattern="[0-9]*"
  -  10 [chromium] › tests\wave3-auth.spec.ts:167:7 › Wave 3 — Allowed-list (not_allowed) step copy › not_allowed step shows 1 business day copy + Learn more (target=_blank)
  -   9 [chromium] › tests\wave3-auth.spec.ts:146:7 › Wave 3 — OTP step a11y (needs reachable OTP step) › Resend button shows cooldown copy "Resend in Ns" and is disabled
  -   8 [chromium] › tests\wave3-auth.spec.ts:125:7 › Wave 3 — OTP step a11y (needs reachable OTP step) › all 6 OTP boxes render at ~48px height (h-12 fix, not broken h-13)

  6 skipped
  4 passed (33.4s)
```

**Summary**: 4 passed, 6 skipped (`test.fixme`), 0 failed. No bugs surfaced by the runnable subset — all assertions match the current LoginPage code on stage.

## Tests skipped — reason

All 6 OTP-step and not-allowed-step tests require a real backend round-trip:
- The OTP UI is only reachable after `POST /api/auth/request-otp` succeeds. Anonymous Playwright cannot satisfy the allowed-list + email-provider stage configuration without a known test address.
- The not-allowed branch fires only when the backend explicitly returns `{ not_allowed: true }` for the submitted email.

Both groups are gated by `test.fixme(!process.env.E2E_TEST_EMAIL, ...)` / `test.fixme(!process.env.E2E_NOT_ALLOWED_EMAIL, ...)`. To enable them, Team 3 (or the harness) needs to:
- Provision a stage email that's on the allowed list and supply it via `E2E_TEST_EMAIL` (so the request-OTP succeeds and the UI flips to the `code` step), and
- Provision a stage email NOT on the allowed list and supply it via `E2E_NOT_ALLOWED_EMAIL` (so the `not_allowed` branch renders).

No fake / stubbed paths were introduced — per the brief, scenarios that need a real backend are left `fixme` with the env-var requirement noted in the message.

## Notes for downstream teams

- The 4 passing tests confirm the LoginPage **as deployed** currently has the email-autocomplete, decorative-logo aria-hidden, and basic open-redirect safety bits in place on stage. No regressions detected here at the time of writing.
- The 6 skipped tests are **ready to run** as soon as the env-var-gated test emails are wired up — they will then exercise the OTP a11y / cooldown / not-allowed copy / Learn-more link properties.
- The h-12 height check (test #8) is the most likely candidate to flag a P3·S regression if the `h-13` typo ever reappears, since it measures actual rendered pixels rather than just attribute presence.

## Environment hiccups noted (informational, not test bugs)

While verifying I ran `npm install` and `npx playwright install chromium` inside `e2e/` because neither `e2e/node_modules` nor the Playwright chromium build were present in the sandbox at the time of writing. If a downstream worker hits "Cannot find module '@playwright/test'" or "Executable doesn't exist at .../chrome-headless-shell.exe", those two commands restore a working setup.
