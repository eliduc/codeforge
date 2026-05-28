# R14 Team 1 — Live Session UI test report

**Suite:** `e2e/tests/wave3-live.spec.ts`
**Target:** `https://stage.gotcode.ai`
**Run command:**

```
cd e2e && E2E_BASE_URL=https://stage.gotcode.ai npx playwright test tests/wave3-live.spec.ts --reporter=list
```

**Initial run result:** 1 passed, 10 skipped, 0 failed (26.8s)

The skipped tests are all gated on `E2E_AUTH_TOKEN` and/or `E2E_TEST_SESSION_ID`
env vars. None of those were provided in this run, so the auth-gated tests
skipped cleanly without flaking — exactly the behaviour the task asked for.
Once Team 3 wires up a stage test account and seeds a session id, re-running
with both env vars set will exercise every case.

## Cases

| # | Wave | Case | Auth needed | Initial state | Notes |
|---|------|------|-------------|---------------|-------|
| 1 | smoke | `/sessions/:id` redirects anonymous → `/login` | no | **pass** | Real end-to-end check against stage. |
| 2 | W1 P0·M | WS status pill renders (or status text appears) | yes | skipped + `fixme` | Pill is hidden when steady-connected; cannot reliably observe without forcing a reconnect path. Marked `test.fixme` per task brief. |
| 3 | W2 P1·M | Lock viewport: toggle exists, title flips, persists ON across reload | yes | skipped | Asserts `title` attr (component uses `title=`, not `aria-label=`; locator accepts either) + `aria-pressed` + `localStorage['codeforge.session.lockViewport']`. |
| 4 | W2 P1·M | Lock viewport: persists OFF across reload | yes | skipped | Pre-seeds `'1'` in localStorage, then toggles off and reloads. |
| 5 | W2 P1·S | `?` opens keyboard help modal listing all 6 shortcuts | yes | skipped | Sends `Shift+Slash`, verifies title + every documented label + a `<kbd>` for each key (?, Esc, p, Space, c, i). |
| 6 | W2 P1·S | `Esc` closes the keyboard help modal | yes | skipped | Opens then asserts hidden after Escape. |
| 7 | W2 P1·S | Phase indicator humanized (no raw enum) | yes | skipped | Sub-skips at runtime if no phase indicator is currently rendered. Asserts text matches `(Coding (iteration N) \| Testing (iteration N) \| Summarizing audits \| Finalizing winner \| Enhancing \| Enhancement) phase`. |
| 8 | W2 P1·S | MetricsPanel status badge humanized | yes | skipped | Looks up `[data-tour="metrics-panel"]` → first rounded-full span; asserts label is never raw `awaiting_enhancement_review` / `awaiting_enhancement` / lowercase-underscore, and matches a known humanized label. |
| 9 | W3 P2·S | Spec node has `cursor-help` + Info icon | yes | skipped | Locates outer container via `title="Click to view full specification"`, asserts class contains `cursor-help`, and an `aria-hidden=true` Info indicator with an inner `<svg>` is present. |
| 10 | W3 P3·S | 600×800 viewport: secondary buttons hidden, `⋯` visible | yes | skipped | Resizes BEFORE auth, asserts `button[title="More actions"]` visible, `[data-tour="settings-btn"]` hidden, "Save as Template" button hidden; opens menu and asserts menuitems present. |
| 11 | W3 P3·S | Mini-map status palette covers active states | yes | skipped | Sub-skips at runtime if no `<rect>` in `.react-flow__minimap` carries a non-grey fill (i.e., no active session state). Otherwise asserts at least one node fill is in the documented palette `(3B82F6\|F59E0B\|10B981\|EF4444\|DC2626)`. |

## Skip reasoning summary

- **`E2E_AUTH_TOKEN` missing → `test.skip`.** All session-page tests require a
  logged-in browser. Token is read via `window.localStorage.setItem('codeforge_token', …)`
  (verified by reading `frontend/src/services/api.ts:164` — `AUTH_TOKEN_KEY = 'codeforge_token'`).
- **`E2E_TEST_SESSION_ID` missing → `test.skip`.** Sessions that don't belong
  to the auth user 404 — there's no public "demo session" route, so we need a
  preseeded id.
- **WS pill test → `test.fixme`.** The pill is intentionally hidden when the
  socket is steady-connected (`SessionDetailPage.tsx:177`). Asserting its
  presence reliably would require forcing the socket into
  connecting/reconnecting/disconnected from outside, which isn't feasible from
  an external Playwright run. Documented as fixme so it surfaces in reports
  without flaking.
- **Phase indicator** and **mini-map palette** tests sub-skip at runtime if
  the configured session happens not to be in a state that exercises them
  (completed session = no phase chip; idle session = all grey nodes). This
  is a property of the chosen `E2E_TEST_SESSION_ID`, not of the tests.

## Files touched

- `e2e/tests/wave3-live.spec.ts` (new, 11 cases)
- `e2e/tests/reports/r14_team1_live.md` (this file)

## Pre-flight finding

`npx playwright install chromium` was required before the first run — the
local Playwright cache did not have a Chromium binary. Subsequent runs are
clean.
