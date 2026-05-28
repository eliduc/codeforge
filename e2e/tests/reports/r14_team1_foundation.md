# R14 Team 1 — Foundation / Cross-cutting Test Report

**Phase:** R14 Test-Writer (Team 1)
**Target:** `https://stage.gotcode.ai`
**Spec file:** `e2e/tests/wave3-foundation.spec.ts`
**Framework:** Playwright (chromium)
**Run command:**

```
cd e2e && E2E_BASE_URL=https://stage.gotcode.ai \
  npx playwright test tests/wave3-foundation.spec.ts --reporter=list
```

## Initial run results

15 tests defined. With **no** `E2E_AUTH_TOKEN` set against stage:

```
15 skipped
```

11 tests skip via `test.skip(!process.env.E2E_AUTH_TOKEN, ...)` because
`CommandPalette`, `Toaster`, `<Layout>` chrome, and `<SettingsPage>` only
mount on authenticated routes. 4 tests are marked `test.fixme` for reasons
documented inline (see Skip reasoning below).

To exercise the auth-gated tests, set both env vars before running:

```
E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=<jwt> \
  npx playwright test tests/wave3-foundation.spec.ts --reporter=list
```

## Case-by-case coverage

| # | Case | Wave | Status | Notes |
|---|------|------|--------|-------|
| 1 | Cmd-K / Ctrl-K opens command palette | 2 P1·M | needs auth | Layout-mounted palette; skips without token. |
| 2 | Cmd-K filter narrows commands ("demos") | 2 P1·M | needs auth | Asserts only "Go to Demos" remains. |
| 3 | Esc closes the palette | 2 P1·M | needs auth | Verifies `Dialog` closes via Headless UI's Esc handler. |
| 4 | Theme toggle in Settings pill + sidebar icon | 1 P1·M | needs auth | Both `pill` and `icon` variants of `ThemeToggle`. |
| 5 | Light theme leaves ConfirmDialog readable | 1 P1·S | needs auth | Asserts `--cf-panel` is not a near-black hex in light mode. Cannot reach a delete-template flow anonymously, so we sample tokens on `documentElement` instead. |
| 6 | Toaster container offset ≥56px below top | 2 P1·S | needs auth | Asserts inline-styled top from `<Toaster containerStyle={{ top: 80 }} />`. |
| 7 | Dismiss-all chip at ≥3 toasts | 2 P1·S | **fixme** | `notify.*` is not exposed on `window`; cannot drive 3 toasts deterministically on stage. |
| 8 | ConfirmDialog corner X gated by loading | 3 P2·S | **fixme** | Cannot drive a real delete-template loading state without mocking the dialog. Contract recorded in test body comment. |
| 9 | ApiKeySetupDialog Esc dismisses | 3 P2·S | **fixme** | Dialog auto-opens only for new users with zero providers; stage users always have at least one provider. |
| 10 | Sidebar Help menu items + version footer | 3 P2·S | needs auth | Asserts Keyboard shortcuts / Documentation / What's new / Log out / `CodeForge v…` / `2026` line. |
| 11 | Settings skeleton rows render | 3 P2·S | needs auth | Routes `**/api/settings/providers` through a 1.5s delay and asserts `.animate-pulse` is visible. |
| 12 | `toastVerbosity=silent` persists across reload | 2 P1·M | needs auth | Writes via the radio, reloads, asserts radio is checked + `localStorage.codeforge.prefs.toastVerbosity === 'silent'`. |
| 13 | Silent mode mutes `notify.success`, not `notify.error` | 2 P1·M | needs auth | `notify.*` not on `window` → asserts the `shouldShow()` contract from `StyledToast.tsx` as the closest in-browser proxy. |
| 14 | ErrorBoundary recovery buttons render on crash | 3 P2·S | **fixme** | Forcing a React render error from outside React requires either a known-broken route or component-level instrumentation that doesn't exist on stage. |
| 15 | Sentence-case button copy | 3 P2·S | needs auth | Asserts "Refresh models" + "Add webhook" exist, and the title-case forms ("Refresh Models", "Add Webhook", "Save Configuration") do NOT appear. |

## Skip reasoning

### Auth-gated (11 tests)

These all `test.skip(!process.env.E2E_AUTH_TOKEN, ...)`. Justification per
test type:

- **Tests 1–3, 6 (Cmd-K palette + Toaster):** both components are mounted
  inside `Layout.tsx`. The `Layout` component wraps authenticated routes
  only — anonymous visitors land on `/login`, which renders `LoginPage` at
  the top level with no sidebar, no Toaster container, and no
  `CommandPalette` mount. There is no way to exercise these without auth.
- **Tests 4–5, 10–13, 15 (Settings page + sidebar):** `/settings` and `/`
  redirect to `/login` when unauthenticated. Settings provides the theme
  pill, the Notifications fieldset, the provider list (skeleton rows),
  and the Refresh-models / Add-webhook buttons. The sidebar Help menu lives
  in `Layout`. All require auth.

### Fixme (4 tests)

- **Test 7 (Dismiss-all chip):** firing toasts requires importing
  `notify` from inside the React bundle. `notify` is not exposed on
  `window`, and the Toaster only renders inside `Layout`. A reliable
  trigger would require either (a) a dev-only `window.notify` shim added
  to stage, or (b) a UI control that fires three toasts in sequence, which
  doesn't exist anonymously.
- **Test 8 (ConfirmDialog corner-X gating):** the `loading` prop is owned
  by the parent component (e.g. delete-template handler in SettingsPage /
  SessionsPage). Reaching it requires (a) being authenticated, (b) having
  at least one template/session to delete, and (c) intercepting the
  in-flight delete to keep `loading=true` long enough for an assertion.
  Cleanly mockable inside a Jest/RTL component test, not anonymously
  through Playwright on stage.
- **Test 9 (ApiKeySetupDialog Esc-dismissal):** the dialog auto-opens in
  `Layout` only when `useProvidersStore().hasAnyConfigured === false`.
  Stage users with any configured provider — all of them — will never see
  this dialog. To exercise, we'd need a fresh account with zero providers,
  or a feature-flag override.
- **Test 14 (ErrorBoundary recovery):** `page.evaluate(() => { throw 'boom'
  })` runs outside the React render tree and does NOT trigger the
  `componentDidCatch` boundary; it just rejects the evaluate promise. The
  only reliable way is to navigate to a route known to crash on render,
  which doesn't exist on stage by design. Recommend a `?devCrash=1`
  hidden flag added to Layout for testability.

## Failures observed

Initial run produced **0 failures** because all 15 tests skipped/fixme'd
in the no-token environment. Once `E2E_AUTH_TOKEN` is provided, any
failures should be reported to **Team 3** as Wave-1-to-3 bugs to triage.

## Recommended follow-ups for testability

1. Expose `window.__cf_notify = notify` in stage builds (gated by a query
   flag) so tests 7 and 13 can drive toasts deterministically.
2. Add a `?devCrash=1` query-string handler in `Layout` that throws on
   render, so test 14 can exercise the ErrorBoundary recovery buttons.
3. Add a `data-testid` to the Toaster viewport container so test 6 can
   locate it without traversing all `<div>` elements.
4. Consider a `?welcome=1` query-string that forces the
   `ApiKeySetupDialog` to mount for test 9.
