# W4-Dashboard — Test Report

**Target:** `https://stage.gotcode.ai`
**Spec:** `e2e/tests/wave4-dashboard.spec.ts`
**Surface under test:** `frontend/src/pages/DashboardPage.tsx` + `frontend/src/lib/sessionLabels.ts`
**Run:**
```
cd e2e && E2E_BASE_URL=https://stage.gotcode.ai E2E_AUTH_TOKEN=$TOKEN \
  npx playwright test tests/wave4-dashboard.spec.ts --reporter=list
```

## Summary

| #   | Test                                                                              | Result    |
| --- | --------------------------------------------------------------------------------- | --------- |
| 1   | `/dashboard` loads for authenticated user                                          | **PASS**  |
| 2   | stat cards render (Total Cost / Total Tokens / Requests / Avg Iterations)         | **PASS**  |
| 3   | status pills are humanized — no raw enum strings                                  | **PASS**  |
| 4   | pills are `<a>` Links to `/sessions?status=<enum>` and navigate on click          | **PASS**  |
| 5   | clicking a pill activates the matching status filter on `/sessions`               | **FAIL**  |
| 6   | welcome / onboarding card visible when no sessions                                | **SKIP** (fixme) |
| 7   | recent sessions list shows 3-5 most recent sessions                               | **SKIP** (fixme) |

Totals: **4 passed · 1 failed · 2 skipped** in ~28 s.

## Findings

### PASS — Stat cards & humanized pills

The Dashboard surface live on stage matches `DashboardPage.tsx` exactly:

- Four stat tiles: **Total Cost**, **Total Tokens**, **Requests**, **Avg Iterations** (the brief mentioned "Total sessions" — that tile does **not** exist; the closest analogue is the *Sessions by Status* panel below the cards).
- Pills under *Sessions by Status* are humanized via `sessionLabels.humanizeStatus()` — no raw `awaiting_enhancement_review` strings appear in the rendered text. Wave 3 P2·S work is verified.
- Each pill is a real `<a href="/sessions?status=<enum>">` (React Router `<Link>`). Clicking navigates to `/sessions?status=...`.

### Routing note (not a failure)

The brief said *"Page loads at `/`"*. `/` actually redirects to `/sessions` (`frontend/src/App.tsx:72`). The Dashboard lives at `/dashboard` (`App.tsx:73`). Test #1 hits `/dashboard` accordingly.

### FAIL — Test #5: URL `?status=` does **not** activate the SessionsPage filter

```
Locator: locator('button').filter({ hasText: /^All$/i }).locator('..').locator('button.border-current').first()
Expected: visible — Error: element(s) not found
```

**Root cause (verified by reading `frontend/src/pages/SessionsPage.tsx`):**

`SessionsPage` initializes `statusFilter` via plain `useState('all')` at line 91, and there is **no** `useSearchParams` / `URLSearchParams` consumer anywhere in the file. Grep confirms zero references to `searchParams`, `useSearchParams`, or `location.search` in `frontend/src/pages/SessionsPage.tsx`.

Consequence: clicking a Dashboard status pill correctly navigates to `/sessions?status=completed` (verified in test #4), but the active filter chip on `/sessions` stays on **All**. The filter is rendered using `border-current` on the active pill only (line ~872), so the active state never moves off "All" when the destination is reached via a Dashboard link — the user must click the filter pill again on the Sessions page to apply it. The whole point of the pill being a link (the Улучшатели#3 P2·S contract: *"clicking filters the Sessions list"*) is broken end-to-end.

**Suggested fix:** wire `SessionsPage` to read `?status=` from `useSearchParams()` on mount and seed `statusFilter` from it (and ideally keep the URL in sync when the filter chip is clicked). Comment in `DashboardPage.tsx:71-72` explicitly promises this behavior.

### SKIP (fixme) — Tests #6 and #7: surfaces don't exist

- **#6 welcome / onboarding card:** `DashboardPage.tsx` has no onboarding card. The only empty-state cue is the inline text *"No sessions in window"* inside the *Sessions by Status* panel (line 67-68). Re-enable when a real onboarding card ships.
- **#7 recent sessions list:** `DashboardPage.tsx` has no Recent Sessions list. The full surface is: header, stat cards, Sessions by Status, Daily Cost bars, Top Providers, Top Models. Re-enable when a recent-sessions list ships.

Both are marked `test.fixme(true, '...reason...')` so they appear in reports as **skipped (fixme)** rather than silently passing or asserting fictional UI.

## Artifacts

- Failed-test screenshot/video: `e2e/test-results/wave4-dashboard-Wave-4-—-D-17144-g-status-filter-on-sessions-chromium/`
- Spec file: `e2e/tests/wave4-dashboard.spec.ts`
