# КАО Wave-4 — Closed

**Final stage run (serial, workers=1):**
```
92 passed · 19 skipped · 0 failed · 11.8 min
```

## Lifecycle

| Phase | Outcome |
|-------|---------|
| Phase 1 — 7 parallel Test Writers | 111 specs written across 7 wave4-*.spec.ts files |
| Initial parallel run | 90 passed, 1 fail (HIGH: Dashboard filter URL), 20 skipped (state-gated) |
| Severity classification | 1 HIGH, 1 MEDIUM, 2 LOW |
| Phase 2 — Fixer agent | 4 bugs closed in 1 pass, `tsc` exit 0 |
| Phase 3 — Re-run + spec fixes | 4 spec/infra bugs surfaced and fixed inline (selectors, focus-trap-vs-keypress, panel positioning) |
| Final closure run | 0/0/0/0 |

## Bugs closed by Fixer

| ID | Sev | Fix |
|----|-----|-----|
| W4-FIX-01 | HIGH | `SessionsPage` reads `?status=<enum>` from URL via `useSearchParams`; setStatusFilter mirrors back to URL. Dashboard pill clicks now apply the filter (Wave 3 P2·S contract). |
| W4-FIX-02 | MED | First attempt (Option B: pointer-events on Panel) didn't fully work — inner card still overlapped Spec node. **v2** moved MetricsPanel to `top-right` Panel position; spec node click now reaches dialog cleanly. |
| W4-FIX-03 | LOW | Keyboard shortcut `i` now calls `pushPanel('intervention')` to match the header Intervene button (1-line). |
| W4-FIX-04 | LOW | ThemeToggle: added 'system' option, `matchMedia` listener auto-refreshes effective theme; new users default to 'system' for OS-matched first paint. |

## Spec/infra fixes (inline by me, not Fixer)

| Test | Issue | Fix |
|------|-------|-----|
| wave4-dashboard test 5 | `hasText: /^All$/i` didn't match button "All (7)" because of trailing count span | Relaxed to `/^All\b/i` |
| wave4-demo test 13 (Cancel selector) | Malformed mixed CSS+text locator `[role="dialog"], text=/.../i` | Switched to Playwright's `getByText()` |
| wave4-demo test 13 (Space activates Cancel) | Headless UI Dialog auto-focuses Cancel; `page.keyboard.press('Space')` activated it instead of firing global handler | Used `window.dispatchEvent(KeyboardEvent('keydown', {key:' '}))` to bypass focused element |
| wave4-demo test 13 (auth race) | `useAuthStore.loadFromStorage()` is async; clicking before `isAuthenticated=true` → /login redirect | Added `page.waitForResponse('/api/auth/me' 200)` race-tied to `goto` |
| wave4-live test 8 (Spec node click) | Test panned canvas assuming top-left panel; after FIX-02-v2 (panel top-right), panning broke targeting | Removed manual panning; click directly |

## Coverage statistics

| Spec | Cases | Pass | Skip |
|------|-------|------|------|
| wave4-anonymous | 17 | 16 | 1 |
| wave4-dashboard | 7 | 5 | 2 |
| wave4-newsession | 10 | 10 | 0 |
| wave4-sessions | 24 | 21 | 3 |
| wave4-live | 18 | 10 | 8 |
| wave4-settings | 21 | 17 | 4 |
| wave4-demo | 14 | 13 | 1 |
| **TOTAL** | **111** | **92** | **19** |

**Skip rationale** (intentional, not failures):
- Auth-gated cases that need a state we don't have (no active agents on test session, no error agents, no completed-with-final_code, no enhancers in disabled state)
- Surfaces gated on backend features not yet shipped (intervention `consumed` ACK, retry-agent endpoint, ErrorBoundary trigger)
- ApiKeySetupDialog auto-opens only for first-time users; E2E user has keys → unreachable
- One open-redirect input that needs `E2E_NOT_ALLOWED_EMAIL` env var to reach the rare state

## Stage state

Final bundle on stage: `index-CFF7OapV.js` / `index-DPfmwdS2.css`

Backups (rollback paths):
- `/home/lev/cf-stage-backups/20260513-175949-w4-fixes/html` (before W4 fixes)
- `/home/lev/cf-stage-backups/20260513-191320-w4-fix02-v2/html` (before MetricsPanel reposition)

## Mutation discipline audit

- **NewSessionPage** spec: created 1 session, captured ID, cancelled + deleted in afterAll. Verified 0 `_e2e_w4_*` sessions remaining on stage post-run.
- **Settings/Webhooks** spec: created up to 3 webhooks per run with `_e2e_w4_<ts>_` prefix, cleaned in `afterEach` + sweeper in `afterAll`. Verified `/api/webhooks/` returned `[]` post-run.
- **Live Session** spec: completely read-only on `8af46f53-00e8-4dad-9a82-817de2e3bbae` (Attractor Mandelbulb). Never clicked Start/Run/Pause/Cancel/Reset.

## Ready for prod

All Wave 4 fixes pass on stage. Bundle `CFF7OapV.js` ready to ship to gotcode.ai when you say so.
