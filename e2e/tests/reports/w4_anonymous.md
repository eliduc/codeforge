# Wave-4 — Anonymous Tester report

**Scope:** anonymous / public-facing surfaces only — Login UX, PublicChrome
(`/demos` & `/demo/:templateId`), demo gallery contents, and onboarding-tour
anonymous gating.

**Spec file:** `e2e/tests/wave4-anonymous.spec.ts` (17 cases)
**Stage URL:** `https://stage.gotcode.ai`
**Run command:**
```
cd e2e && E2E_BASE_URL=https://stage.gotcode.ai \
  npx playwright test tests/wave4-anonymous.spec.ts --reporter=list
```

## Run result

| Metric  | Count |
|---------|-------|
| Total   | 17    |
| Passed  | 16    |
| Failed  | 0     |
| Skipped | 1 (deliberate `test.fixme`) |
| Duration | 23.6s |

## Cases

### Login UX (anonymous)

| ID | Case | Result |
|----|------|--------|
| A1 | `/sessions` (unauth) redirects to `/login` | passed |
| A2 | Email input: `autoComplete="email"`, `name="email"`, `inputMode="email"`, `type="email"` | passed |
| A3 | Logo cluster wrapper has `aria-hidden="true"` | passed |
| A4 | "Send Code" disabled on empty email, enabled after valid email, re-disabled on clear | passed |
| A5 | `safeFromPath()` open-redirect neutralisation for `//evil.com`, `/\\evil`, `\\evil`, `%2F%2Fevil.com` — origin stays same-origin | passed |
| A6 | "Not in list" copy + Learn-more `target="_blank"` | **skipped (test.fixme)** — requires a known-rejected email; verified by source inspection (`frontend/src/pages/LoginPage.tsx` lines 330-340: "1 business day" + `https://docs.gotcode.ai` with `target="_blank"` and `rel="noopener noreferrer"`) |

### PublicChrome rendering (R14-FIX-01)

| ID | Case | Result |
|----|------|--------|
| B1 | `/demos` loads anonymously, no /login redirect, "Demos" heading visible | passed |
| B2 | `/demo/mandelbulb` loads anonymously, Mandelbulb h1 visible | passed |
| B3 | Anonymous `/demo/mandelbulb` shows logo + Sign-in header; no Layout sidebar (`Sessions` nav link count == 0) | passed |
| B4 | PublicChrome Sign-in link has `href="/login"` and navigates there | passed |
| B5 | "Try it yourself" click while anonymous → redirects to `/login` (matches КАО R14-FIX-01) | passed |

### Demo gallery `/demos` (anonymous)

| ID | Case | Result |
|----|------|--------|
| C1 | All 4 cards render — `a[href="/demo/<id>"]` present for mandelbulb, crystal, particles, snake | passed |
| C2 | Clicking a card navigates to `/demo/:templateId` (verified with crystal) | passed |
| C3 | "Real multi-agent runs, replayed" copy present (Wave 1 P1·S) | passed |
| C4 | All four card titles render (Mandelbulb 3D Attractor, Neon Snake, Flow-Field Particles, WebGL Glass Crystal) | passed |

### Onboarding tour `?tour=1` anonymous gating (Wave 3 P3·S)

| ID | Case | Result |
|----|------|--------|
| D1 | `/?tour=1` anonymous — RequireAuth redirects to `/login`; tour-prompt toast (`[aria-label="Onboarding tour prompt"]`) never appears (gated by `if (!isAuthenticated) return` in `OnboardingTour.tsx:274`) | passed |
| D2 | `/demos?tour=1` anonymous — page loads via PublicChrome (no Layout, so OnboardingTour orchestrator is never mounted); toast absent | passed |

## Failures

None.

## Notes

- A5 (open-redirect neutralisation): The `safeFromPath()` guard in
  `LoginPage.tsx` lives on `location.state.from`, not the `?from=` query
  string. Driving `location.state` from Playwright is not straightforward
  without a synthetic navigation, so this test asserts the looser
  observable invariant: regardless of the malicious `?from=` value
  attempted, the browser never lands on an external origin. The four
  test inputs cover the conditions the helper explicitly rejects
  (`startsWith("//")`, `startsWith("/\\")`, `startsWith("\\")`,
  URL-encoded `//`). Direct unit coverage of `safeFromPath()` would
  strengthen this, but was out of scope for an E2E pass.

- A6 is `test.fixme` per the spec instruction ("skip with fixme if you
  can't easily reach this state"). The not_allowed step is gated behind
  the backend's allowed-list logic; reaching it from a black-box E2E
  needs a dedicated test email that we don't have on stage. The
  contract is verified in source. To turn this green, route an
  intentionally-blocked email through the OTP flow and assert
  `"1 business day"` and the Learn-more anchor attributes.

- D1 documents an important detail of the `?tour=1` override semantics:
  the override unblocks tours in dev-mode auto-login, but it does NOT
  bypass the `isAuthenticated` gate (see `OnboardingTour.tsx:274-277`).
  Anonymous visitors cannot trigger the tour, which is the intended
  behaviour — the override is for frontend engineers with auth-disabled
  backends, not unauthenticated users.

## Files

- Test spec — `C:\work\Sandbox\MultiAgentCoder\ClaudeCodeStage\e2e\tests\wave4-anonymous.spec.ts`
- This report — `C:\work\Sandbox\MultiAgentCoder\ClaudeCodeStage\e2e\tests\reports\w4_anonymous.md`
