# Round 13 — Team 2 (test executors + classifiers) findings

**Date:** 2026-05-13
**Scope:** independent re-run of R13 tests authored by Team 1 + full regression + live stage HTTP/browser smoke.

---

## 1. R13 targeted tests — re-run

### Backend — `tests/test_round13_schema_regression.py`
Copied into stage `backend` container and executed:
```
docker compose exec -T -e PYTHONPATH=/app backend pytest tests/test_round13_schema_regression.py -v
============================== 8 passed in 0.35s ===============================
```
**Result: 8 / 0 / 0** — confirmed green.

### Frontend — Node 22 native tests
```
cd frontend && node --experimental-strip-types --test \
  tests/test_round13_onboarding.mjs \
  tests/test_round13_demo_timelines.mjs \
  tests/test_round13_timeline_player.mjs
# tests 72
# pass 72
# fail 0
# duration_ms 124
```
**Result: 72 / 0 / 0** — confirmed green.

### Combined R13: **80 / 0 / 0** ✅

---

## 2. Full regression — stage backend

```
docker compose exec -T -e PYTHONPATH=/app backend pytest tests/ --tb=short
============== 209 passed, 1 skipped in 17.97s ==============
```
Per-file:
- test_auth_smoke.py: 7 + 1 skipped
- test_authenticated_flow.py: 9
- test_features.py: 11
- test_health.py: 3
- test_multitenancy.py: 12
- test_round12_anthropic_family.py: 23
- test_round12_pipeline.py: 22
- test_round12_streaming_schema.py: 22
- **test_round13_schema_regression.py: 8** (new)
- test_security.py: 19
- test_sessions_crud.py: 19
- test_sprint10_endpoints.py: 29
- test_sprint10_schema.py: 11
- test_workflow_lifecycle.py: 14

**Result: 209 / 0 / 1** — vs R12 baseline 201 / 0 / 1 → +8 new R13 tests, **zero regressions**.

---

## 3. Live stage HTTP smoke — R13 endpoints

All 7 endpoints **200 OK**:

| URL | Status | Body shape |
|-----|--------|-----------|
| `https://stage.gotcode.ai/demo-templates/index.json` | 200 | JSON, 4 demos (mandelbulb, snake, particles, crystal) |
| `https://stage.gotcode.ai/demo-templates/mandelbulb.json` | 200 | 14 chapters, 99 events, 162s duration, JSON parses |
| `https://stage.gotcode.ai/demo-templates/snake.json` | 200 | JSON, 84 KB |
| `https://stage.gotcode.ai/demo-templates/particles.json` | 200 | JSON, 82 KB |
| `https://stage.gotcode.ai/demo-templates/crystal.json` | 200 | JSON, 97 KB |
| `https://stage.gotcode.ai/demos` | 200 | HTML (SPA shell) |
| `https://stage.gotcode.ai/demo/mandelbulb` | 200 | HTML (SPA shell) |

### Bundle string check (`/assets/index-B8N2Iogq.js`, 791 KB)
| Marker | Present? |
|---|---|
| `useTimelinePlayer` (function name) | minified — but **hook content present** (see below) |
| `narration_chapters` | yes |
| `pause_for_interaction` | yes |
| `cf_tour_v2_` | yes |
| `data-tour="demos-nav"` | yes (context: `…demos-nav"],popover:{title:"Watch a demo first"…`) |
| `📖` (book emoji, raw UTF-8 bytes 0xF0 0x9F 0x93 0x96) | yes (found at byte offset 798084) |
| `currentChapter`, `pausedForChapter`, `continueChapter` | yes |
| `cameraFocus`, `interactivePauseKey`, `camera_focus` | yes |

Note: Vite minified the React hook identifier `useTimelinePlayer` but the entire hook body and exported `continueChapter`/`pause`/`play`/`restart` API survives.

---

## 4. Live stage browser smoke — chrome-devtools

JWT issued by seeding an OTP for `r13-team2-c76a097e@example.com` and posting to `/api/auth/verify-otp` inside the stage backend container, then injected into `localStorage['codeforge_token']` before navigating to `/demo/mandelbulb`.

Viewport: 1200×800.

### Initial screenshot — `tests/reports/round13_layout_check.png`
Observations from the captured PNG + a11y snapshot (uid mapping):

- **Tour plaque** (uid 1_30, "complementary" landmark) on the **LEFT**, ~270px wide, containing `📖 TOUR` heading + chapter `Specification — your conversation with CodeForge` + paragraphs + `▶ Continue` button (uid 1_42). **Does NOT overlap the graph.** ✅
- **Specification node** (uid 1_65, heading "Specification", state "Complete") visible to the **right** of the plaque, anchored under the heading area. ✅
- **Group labels** `CODERS (2)` (1_135), `TESTERS (2)` (1_137), `ENHANCERS (4)` (1_139) all visible **below the top of the plaque**, rendered as dashed group frames. ✅
- **Compact metrics chip top-right**: `TOP 1 0 $0.00 6/6` (uids 1_141…1_149 = ITER / cost / AGENTS counters). ✅
- No console errors / warnings during initial render.

### After clicking Continue — `tests/reports/round13_layout_check_after_continue.png`
- Plaque chapter advanced to **"Coding round 1 — two coders in parallel"** (uid 1_34). ✅
- Clock progressed from 0.0s → **21.3s** (uid 1_152). ✅
- Coder 1 (claude-opus-4.5) and Coder 2 (gpt-5.1-codex) both `Coding...` with `STREAMING` badge (uids 2_20, 2_26) and live token output (uids 2_21, 2_27). ✅
- Continue button correctly **disabled** with description "Playing — continue activates when paused" (uid 1_42). ✅
- Atomic chapter switch + boundary events confirmed working.

### One bug observed in the post-Continue snapshot
On both Coder nodes, the elapsed-time chip reads **`T:29644297:03`** and **`T:29644297:02`** (uids 2_19, 2_25). That's MM:SS format on ~1.78×10⁹ seconds — clearly nonsense (≈56 years). Confirmed reproducible bug — see R13-BUG-01 below.

---

## 5. Bug list

### R13-BUG-01 — HIGH — Demo-player elapsed timer reads ~30M minutes (degrades R12 functionality)

- **Severity:** HIGH (visible regression vs R12 — in normal sessions the timer reads correctly as `T:00:21`-style values, but in the demo player every active agent shows nonsense).
- **Classification:** REAL_BUG. Violates the project Non-Degradation Rule (R12 introduced the elapsed timer; R13's demo player should preserve it).
- **Site:**
  - `frontend/src/hooks/useTimelinePlayer.ts:274` and `:285` — sets `startedAt: performance.now()`. `performance.now()` is a small monotonic clock (~ms since page load).
  - `frontend/src/pages/DemoPlayerPage.tsx:200, 234, 269, 303, 378, 407` — maps `activeSince: a?.startedAt`.
  - `frontend/src/components/graph/AgentNode.tsx:286-287` — computes `(Date.now() - startedAt) / 1000`. Mixing `Date.now()` (unix epoch ms ≈ 1.78e12) with `performance.now()` (≈ thousands) yields ~1.78e9 seconds → displayed as `29644297:NN` minutes.
- **Repro:** Open `https://stage.gotcode.ai/demo/mandelbulb`, click Continue once → both Coder nodes immediately show `T:29644297:XX` instead of `T:00:01`-style elapsed.
- **Reference for correct behaviour:** `frontend/src/pages/SessionDetailPage.tsx:2126` — real sessions set `activeSince: Date.now()` (unix epoch ms), which is the contract AgentNode expects.
- **Suggested fix direction:** in `useTimelinePlayer.ts:274` change `const now = performance.now()` to `const now = Date.now()`, or — better — keep the simulation clock independent of wall-clock and have DemoPlayerPage map `activeSince` from a *real-time* anchor:
  - Simplest: replace `performance.now()` with `Date.now()` on line 274. The value is only used for `startedAt` and a few other places where it represents wall-clock, not the timeline clock (the timeline clock is the separate `clock` state advanced by `dt * speed`).

### No other bugs found

The 6 Team 1 deferred observations are all code-smells / future-work notes, none are runtime defects.

---

## 6. Verdict on Team 1's 6 deferred observations

| # | Team 1 observation | Verdict | File:line | Notes |
|---|---|---|---|---|
| 1 | `useOnboarding.ts:46-51` LEGACY_KEYS hard-coded duplicates `TOUR_KEYS` w/ v1 prefix | NOT_A_BUG (cosmetic / future maintenance) | `frontend/src/components/onboarding/useOnboarding.ts:46-51` | Verified — `LEGACY_KEYS` is an explicit array. Both runtime correctness + the matching v2 keys test pass. Worth a refactor when v1 users are gone. |
| 2 | `useTimelinePlayer.ts:251-269` reset-effect has 8 setters + 2 refs | NOT_A_BUG (code-smell) | `frontend/src/hooks/useTimelinePlayer.ts:251-270` | Verified — block is correct, just verbose. A `resetPlayerState()` helper would be cleaner. |
| 3 | `useTimelinePlayer.ts:482-485` `currentChapter` useMemo coupled to setCurrentChapterIdx order | NOT_A_BUG (intent-comment recommended) | `frontend/src/hooks/useTimelinePlayer.ts:482-485` | Verified — `useMemo` is on `[timeline, currentChapterIdx]`. The atomic-switch order in `continueChapter` is correct today; an intent comment would help. |
| 4 | snake/particles/crystal still lack `narration_chapters` | NOT_A_BUG (intentional — only mandelbulb has chapters in R13) | `frontend/public/demo-templates/{snake,particles,crystal}.json` | Verified — all three are ABSENT, mandelbulb has 14. Test shape is in place when R14 wants to extend. |
| 5 | `frontend/package.json` has no `test` script | NOT_A_BUG (build-config) | `frontend/package.json:6-11` | Verified — only `dev`, `build`, `lint`, `preview`. Should be added but Team 1 correctly didn't modify production config. |
| 6 | No frontend test infrastructure (jest/vitest/playwright) | NOT_A_BUG (test-infra gap) | `frontend/package.json` | Verified — `devDependencies` only contains build/lint tooling. Future loop should add vitest. |

All 6 confirmed as code-smells / future-work, **none are runtime defects**. No `REAL_BUG` / `TEST_BUG` / `ALREADY_FIXED` in the list.

---

## 7. Final summary

- **R13 targeted tests** (re-run by Team 2): backend 8 / 0 / 0 + frontend 72 / 0 / 0 = **80 / 0 / 0** ✅
- **Full regression (stage)**: **209 / 0 / 1** — vs R12 baseline 201 / 0 / 1, no regressions, +8 new R13 tests ✅
- **HTTP smoke**: 7 / 7 endpoints 200, all R13 bundle markers present, mandelbulb.json valid (14 chapters / 99 events / 162s) ✅
- **Browser smoke** (`tests/reports/round13_layout_check.png` + `..._after_continue.png`): layout correct (plaque left / Spec right / groups below / compact metrics top-right), Continue advances to "Coding round 1", clock progresses, streaming visible ✅
- **Bug found**: 1 × HIGH (R13-BUG-01, demo-player elapsed-timer regression)

### CRITICAL: 0 HIGH: 1 MEDIUM: 0 LOW: 0

## Team 2 status: HANDOFF TO TEAM 3

Team 3 needs to fix **R13-BUG-01** (single-line change in `useTimelinePlayer.ts:274`, optionally with verification in `DemoPlayerPage.tsx`). After fix is deployed to stage, Team 2 will re-run browser smoke to verify the elapsed timer shows sensible values (T:00:01 → T:00:21 etc.) before closing R13 under the 0/0/0/0 stop condition.

---

## R13 RE-VERIFY (post-Team-3)

**Date:** 2026-05-13
**Scope:** Confirm Team 3's 1-line fix for R13-BUG-01 (demo-player elapsed timer)
holds across all R13 tests, full regression, the deployed bundle, and the live
stage browser smoke. No production code modified.

### Test results (independent re-run)

| Suite | Result |
|---|---|
| Backend `tests/test_round13_schema_regression.py` | **8 passed / 0 failed / 0 skipped** |
| Frontend `tests/test_round13_{onboarding,demo_timelines,timeline_player}.mjs` | **72 passed / 0 failed / 0 skipped** |
| **R13 total** | **80 / 0 / 0** — matches Team 1 baseline |
| Full backend regression `tests/` | **209 passed / 0 failed / 1 skipped** — matches Team 2 baseline |

No regressions introduced by Team 3's fix.

### Bundle verification (stage)

- `curl -s https://stage.gotcode.ai/ | grep -oE 'index-[A-Za-z0-9_-]+\.js'`
  → `index-DMMQI6HA.js` (the post-fix bundle Team 3 deployed; NOT the broken
  `index-B8N2Iogq.js`).
- Clock-source audit of the bundle:
  `curl -s https://stage.gotcode.ai/assets/index-DMMQI6HA.js | grep -oE 'Date\.now\(\)|performance\.now\(\)' | sort | uniq -c`
  → **25 × `Date.now()`, 0 × `performance.now()`**. The fix is present and the
  buggy clock source has been fully removed from the JS bundle.

### Browser smoke (chrome-devtools, stage.gotcode.ai)

Flow: `/demo/mandelbulb` → reload (fresh playback state) → click ▶ Continue
→ wait ~5 s during Coding round 1.

- **t ≈ 5 s** after Continue, snapshot showed both active Coder nodes with the
  elapsed chip:
  - Coder 1: `T: 0:05` (then `T: 0:14` on a second pass at full playback speed)
  - Coder 2: `T: 0:05` (then `T: 0:14` on a second pass)
  - Plaque: **"Coding round 1 — two coders in parallel"** (changed from
    "Specification — your conversation with CodeForge" as expected).
  - Screenshot saved to `tests/reports/round13_reverify.png`.
  - **No occurrences of `T:29644297:XX` or any 7+ digit minute value anywhere
    in the rendered DOM.**

- **t ≈ 15 s** after Continue, the demo had progressed past Coding round 1 into
  Testing round 1 (Coders had completed and the T chips cleared, as designed).
  Plaque: **"Testing round 1 — deep audit"**.
  - Screenshot saved to `tests/reports/round13_reverify_15s.png`.

The 0:05 → 0:14 progression observed during streaming confirms the elapsed
timer is now derived from `Date.now() - startedAt` consistently across both
`AgentNode` and the timeline player's `playback.currentTime`, exactly as
intended by Team 3's `performance.now()` → `Date.now()` patch in
`frontend/src/hooks/useTimelinePlayer.ts:274`.

### Bug-by-bug verdict

| Bug | Status |
|---|---|
| R13-BUG-01 — demo-player elapsed timer showing ~56 years on Coder T-chips | **FIXED** (verified on `index-DMMQI6HA.js`, live stage browser smoke + bundle grep + targeted tests) |

### Stop-condition checklist

- R13 tests green: **80 / 0 / 0** ✓
- Full regression green: **209 / 0 / 1** ✓
- Live demo functional: tour plaque advances, Continue works, T chips show
  sensible single-digit-minute values ✓
- Bundle deployed: `index-DMMQI6HA.js` with only `Date.now()` references ✓
- No new bugs surfaced by the re-verify pass ✓

## LOOP CLOSED — R13 verified, 0/0/0/0 met
