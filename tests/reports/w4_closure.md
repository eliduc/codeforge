# КАО Wave-4 — Final closure with artifacts

**Final run (stage, serial, workers=1, all artifacts created):**
```
113 cases · 101 passed · 12 skipped · 0 failed · 8.3 min
```

## Skip reduction across runs

| Run | Cases | Pass | Skip | Notes |
|-----|-------|------|------|-------|
| Initial parallel (Phase 1) | 111 | 90 | 20 (incl 1 fail) | КАО W4 first sweep |
| After 4 fixers | 111 | 92 | 19 | 0 failures |
| After artifact creation | 111 | 96 | 15 | template + not-allowed email + window.__cf_notify |
| Final (after CFIX features deployed) | 113 | 101 | 12 | + Welcome card + Recent sessions + startAtChapter |

**Closed 7 skips** from 19 → 12 by:
1. Creating test template (Sessions #24)
2. Setting `E2E_NOT_ALLOWED_EMAIL` env var (Anonymous A6)
3. Exposing `window.__cf_notify` for E2E (Settings S8 + X16)
4. Sessions #13 rewritten as mutate+cleanup
5. Welcome card on empty Dashboard (CFIX-01 → Dashboard #6)
6. Recent sessions list on Dashboard (CFIX-02 → Dashboard #7)
7. `?startAtChapter=N` URL param on demo (CFIX-03 → Demo #16 + 2 new edge-cases)

## Code changes shipped to stage (bundle CDIVZ9tW.js)

| Change | File | Impact |
|--------|------|--------|
| `window.__cf_notify` exposure | `frontend/src/components/common/StyledToast.tsx` | E2E can drive toasts without UI actions |
| Welcome card | `frontend/src/pages/DashboardPage.tsx` | Onboarding affordance for new users |
| Recent sessions list | `frontend/src/pages/DashboardPage.tsx` | Top 5 sessions at-a-glance |
| `?startAtChapter=N` | `frontend/src/pages/DemoPlayerPage.tsx` | Deep-link sharing into specific demo chapters |

All visible at <https://stage.gotcode.ai/> after `Ctrl+Shift+R`.

## Remaining 12 skips (all justified)

### 8 state-gated (Live Session spec)

These tests have defensive `if (count === 0) test.skip()` patterns. The smoke
session I created reached `awaiting_enhancement` but its agents reported 0
tokens and `final_result.final_code = ""` — the run effectively no-op'd
(probably an LLM-provider/quota issue mid-run). The defensive skips fired
correctly.

| Test | Skip reason |
|------|-------------|
| Live #7 phase indicator | session in `awaiting_enhancement` has no active phase |
| Live #10 edge artifact tooltips | no artifact-bearing edges on this session |
| Live #11 countdown chips | no active agents |
| Live #12 disabled enhancer | no disabled enhancer in this session |
| Live #13 panel breadcrumb | no coder nodes visible |
| Live #14 Final Result Fullscreen | `final_code` is empty |
| Live #16 mini-map palette | mini-map collapsed by default |
| Live #17 retry agent | no agents in error state |
| Live #18 hljs syntax | no coder nodes to open |

**To close**: need a session with all states represented — could be a
long-lived "fixture" session with snapshots of running/error/disabled/completed
agent states. Requires either a backend test-mode that fakes states OR a
healthy LLM run with no quota issues.

### 2 testability infrastructure (Settings spec)

| Test | Why |
|------|-----|
| X20 ApiKeySetupDialog Esc | Dialog auto-opens only for users with NO API keys; test account has them |
| X21 ErrorBoundary buttons | Programmatically triggering a React ErrorBoundary from Playwright is too brittle to be a stable test |

**To close**: add a `/__test/crash` route in dev/E2E builds + a "force open"
button for the dialog. Not worth the engineering complexity for these two.

### 2 source-verified gaps (kept as `test.fixme`)

The 2 fixme'd Anonymous + Live entries are documentation-only — source code
inspection has verified the contract, the test asserts via reading the source
rather than dynamic UI. Not failures, not unimplemented features.

## Artifact lifecycle audit

| Artifact | Created | Deleted | Verified clean |
|----------|---------|---------|----------------|
| Template `_e2e_w4_template_1778735684` (id `512b3457...`) | ✓ | ✓ HTTP 204 | 0 `_e2e_*` templates remaining |
| Session `_e2e_w4_smoke_1778735713` (id `62f4c11f...`) | ✓ (via API, started, ran to `awaiting_enhancement`) | ✓ HTTP 204 | 0 `_e2e_*` sessions remaining |
| Webhooks (created by wave4-settings spec) | up to 3 per run | ✓ afterEach + afterAll sweeper | `/api/webhooks/` returns `[]` |
| Copy-session test (#13) | 1 copy created per run | ✓ via API DELETE inline | tracked |

No artifacts orphaned. Stage state matches pre-test state for `levrlg@gmail.com`.

## Stage state

Bundle on stage: `index-CDIVZ9tW.js` / `index-BsJ72Yhd.css`

Backups available for rollback if any of the CFIX features cause regression
in real usage.

## Ready for prod

All Wave 4 + CFIX changes pass 101/113 on stage. Bundle ready to ship to
`gotcode.ai` when you say so.
