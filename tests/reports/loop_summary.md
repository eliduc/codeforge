# Test Loop Live Summary

**Current Round:** R13 — IN PROGRESS (onboarding + demo player + chapter narration system)
**Stop condition (R13):** 0 CRITICAL + 0 HIGH + 0 MEDIUM + 0 LOW — strict

## R13 Team 2 status (2026-05-13)
- R13 targeted tests re-run: 80 / 0 / 0 (8 backend + 72 frontend) ✅
- Full regression (stage): 209 / 0 / 1 (vs R12 baseline 201/0/1, +8 R13 tests, no regressions) ✅
- HTTP smoke 7/7 endpoints 200, bundle markers all present ✅
- Browser smoke: layout correct, Continue advances chapter ✅
- **1 HIGH bug found: R13-BUG-01** — demo-player elapsed timer in AgentNode shows `T:29644297:XX` because `useTimelinePlayer.ts:274` uses `performance.now()` while `AgentNode.tsx:287` computes `Date.now() - startedAt`. Fix: change `performance.now()` → `Date.now()` on `useTimelinePlayer.ts:274`. See `round13_team2_findings.md`.
- Verdict on Team 1's 6 deferred observations: all 6 confirmed as NOT_A_BUG (code-smells / future work).
- **HANDOFF TO TEAM 3.**

## R13 scope (changes since R12 closed)

Frontend (mostly):
- **Onboarding tour v2** — `frontend/src/components/onboarding/`: `OnboardingTour.tsx`, `tours.ts`, `useOnboarding.ts`, `onboarding.css`. 4 chapters (welcome, session_anatomy, session_live, session_done). v1→v2 key migration. Tour 1 navigates to `/demos` on completion.
- **Demos page + gallery** — new `DemosPage.tsx` route `/demos`, sidebar nav `data-tour="demos-nav"`. `DemoGallery` moved from SessionsPage.
- **DemoPlayerPage with timeline playback engine** — `frontend/src/pages/DemoPlayerPage.tsx` + `frontend/src/hooks/useTimelinePlayer.ts`. New event types: `camera_focus`, `pause_for_interaction`. Plus narration chapters with auto-pause + Continue.
- **Mandelbulb demo v5** — `frontend/public/demo-templates/mandelbulb.json`: 14 narration chapters, 99 events, 162s duration, simplified_code (14.8K) + final_code (22.5K).
- **Chapter system in player** — `useTimelinePlayer.ts`: `NarrationChapter` interface, `currentChapter` / `pausedForChapter` state, `continueChapter()` method that advances atomically through chapter boundary.
- **DemoGroupFrames** — dashed group frames in the demo player (CODERS/TESTERS/ENHANCERS), measures real node heights via DOM to expand frames when streaming widens nodes.
- **CameraFocusBridge** — subscribes to `state.cameraFocus` and pans/zooms RF viewport.
- **ChapterSidePanel** — left-sidebar narration plaque (scrollable, rewind icon, Continue + secondary CTA buttons, closing_paragraph on pause, code preview iframe modal).
- **Layout refactor** — DemoPlayerPage: left sidebar (300px) with Tour plaque ON TOP + Spec card below; graph fills the rest. Invisible `_pad_left` spacer node to give Spec breathing room in fitView pack.
- **Compact MetricsPanel** for demo player (single-row chip instead of full panel).
- **Onboarding sidebar nav item** with `data-tour="demos-nav"` in `Layout.tsx`.

Backend (smaller scope):
- **Onboarding deferred-init regression fix** (if any). Nothing major.

## R13 plan
1. Team 1 — write new pytest tests (mostly schema / API / regression) AND playwright/browser tests for the new frontend features.
2. Team 2 — execute + classify findings.
3. Team 3 — fix any REAL_BUG.
4. Loop Team 2 ↔ Team 3 until 0/0/0/0.

---

## Prior R12 — CLOSED (2 HIGH bugs fixed; Team 2 re-verified live on stage + prod)
**Stop condition (R12):** 0 CRITICAL + 0 HIGH + 0 MEDIUM + 0 LOW — **MET ✅**

## R12 final state (2026-05-12)
- R12 targeted tests: **67 / 0 / 0** ✅
- Full regression (stage): **201 / 0 / 1** ✅
- HTTP smoke stage + prod: streaming-toggle PATCH roundtrip green on both
- 2 HIGH REAL_BUGs found by Team 2, fixed by Team 3, re-verified by Team 2:
  - **R12-BUG-01** — `coders_completed` not bumped on success in `_finalize_coder_result` → fixed with snapshot-based dedup to avoid double-counting when `_run_coder` already increments in production.
  - **R12-BUG-02** — PATCH `/api/sessions/{id}` silently dropped `settings` mutations (SQLAlchemy `JSON` column doesn't detect in-place dict mutation) → fixed by replacing in-place update with fresh-dict literal `session.settings = {**old, **new}` in `sessions.py:1498`.

**Cumulative through R12**: CRITICAL 4/4, HIGH 24/24, MEDIUM 23/23, LOW 5/5 (all real bugs). Reports: `round12_team1_tests.md`, `round12_team2_findings.md`, `round12_team3_fixes.md`.

---

## R12 scope (changes since R11 closed)

Backend:
- **Pipelined orchestrator** (`backend/app/core/orchestrator.py`): new `_run_iteration_pipeline()` / `_run_coder_pipeline()` / `_finalize_coder_result()` replacing sequential coding→testing→summarizing phases. Each coder runs its full pipeline concurrently.
- **Streaming default ON** (`orchestrator.py:1600`): `session_settings.get("streaming", True)`.
- **Schema extensions** (`backend/app/schemas/__init__.py`): `SessionSettings.streaming: bool | None`, `_KNOWN_LANGUAGES` extended with `javascript_browser` / `typescript_browser` / `htm`.
- **Anthropic provider regex-based model family detection** (`backend/app/llm/providers/anthropic_provider.py`).

Frontend:
- **Group frames** (`SessionDetailPage.tsx:GroupFramesLayer`): per-group dashed frame with click-and-hold drag strips on empty zones → moves whole group concurrently.
- **panToGroup + ~25% relative zoom** (`SessionDetailPage.tsx:panToGroup` + `autoPanBaseZoomRef`): captures user's base zoom, all transitions = baseZoom × 1.25.
- **Elapsed timer T:M:SS** on every active AgentNode (`AgentNode.tsx`): driven by `data.activeSince` (set in `agent_started` handler) with `activeSinceFallbackRef` for nodes started before deploy.
- **Streaming token estimate** in metrics row (`~N` while streaming, real value on completion).
- **min-h-[140px]** instead of `h-[140px]` on AgentNode (`AgentNode.tsx:355`) — node grows when streaming.
- **Equal-size nodes** (`AgentNode.tsx`): `w-[220px]` + `min-h-[140px]`.
- **VERTICAL_GAP=160** between nodes; `enhVerticalGap=VERTICAL_GAP`.
- **Streaming UI toggle** with default ON (`SessionDetailPage.tsx` settings panel).

Critical: ensure none of the above broke previous functionality (multitenancy, auth, session lifecycle, code execution, enhancement loop, finalization, share links, etc.).

## R12 plan
1. **Team 1** — write new tests covering R12 scope (backend pipelined orchestrator, schema extensions, streaming default; frontend changes are integration-tested via API smoke + manual screenshot diff in HTTP smoke). Output: `round12_team1_tests.md` + new `tests/test_round12_*.py` files.
2. **Team 2** — execute new tests + run full regression. Classify findings as CRITICAL / HIGH / MEDIUM / LOW. Output: `round12_team2_findings.md`.
3. **Team 3** — fix all real bugs. Output: `round12_team3_fixes.md`.
4. Loop **Team 2 → Team 3** until 0/0/0/0.

---

## Prior round R11 — CLOSED (sprint-10 scope; 2 HIGH bugs fixed by Team 3, Team 2 re-verified)
**Stop condition (R11):** 0 CRITICAL + 0 HIGH + 0 MEDIUM — **MET ✅**

## R11 final state
- Sprint-10 backend tests: **40 passed / 0 failed** ✅
- Full regression suite: **134 passed / 0 failed / 1 skipped** ✅
- 2 HIGH bugs fixed:
  - **SP10-BE-BUG-01**: cost_limit_usd / session_timeout_sec / expected_output silently dropped — added to create_session constructor + _ALLOWED_UPDATE_FIELDS in sessions.py
  - **SP10-BE-BUG-02**: test helper referenced non-existent `final_summary` column — replaced with required readme_content + selection_reasoning fields

## R11 history (initial Team 2 run)
- Sprint-10 backend tests: 33 passed / 7 failed / 0 skipped
- Full regression: 127 passed / 7 failed / 1 skipped (no regressions outside sprint-10)
- Frontend critical (SP10-FE-12/19/28) + HIGH (01/06/07/08/11/17/23): all PASS via code review
- HTTP smoke (10 endpoints): all match expected status codes

### R11 active bugs
- CRITICAL: 0
- HIGH: 2
  - SP10-BE-BUG-01 — `cost_limit_usd`, `session_timeout_sec`, `expected_output` silently dropped on POST `/api/sessions/` and rejected on PATCH (`backend/app/api/routes/sessions.py:1367-1387` and `_ALLOWED_UPDATE_FIELDS` at L1473). Schemas + ORM columns exist; route wiring missing.
  - SP10-BE-BUG-02 — `FinalResult` model has no `final_summary` column (`backend/app/db/models.py:420-444`) but the sprint-10 test helper `_seed_final_code` (and likely the generate-tests/docs/deploy endpoints) reference it. SQLAlchemy `CompileError: Unconsumed column names: final_summary`.
- MEDIUM: 0

**LOOP NOT CLOSED — see `round11_executor.md` for details.**

---

## Prior state (R10 — pre-sprint-10 codebase)

**R10 Stop condition:** 0 CRITICAL + 0 HIGH + 0 MEDIUM + 0 LOW — **MET**

## Active bugs (FINAL)
- CRITICAL: 0
- HIGH: 0
- MEDIUM: 0
- LOW: 0 (all 5 REAL_BUGs fixed; 5 INTENTIONAL documented; 4 ALREADY_FIXED verified; 3 NOT_A_BUG closed)

## Cumulative (R1-R10)
- CRITICAL: 4 / 4 fixed (100%)
- HIGH: 22 / 22 fixed (100%)
- MEDIUM: 23 / 23 fixed (100%)
- LOW: 5 / 5 REAL_BUGs fixed (100%); other 12 LOW classified as non-defects

## R10 progress
1. Team 1 — DONE: enumerated all 17 LOW items, classified 5 REAL_BUG / 5 INTENTIONAL / 4 ALREADY_FIXED / 3 NOT_A_BUG (`round10_low_items.md`).
2. Team 2 — DONE: verified ALREADY_FIXED items (LOW-03, LOW-04, LOW-06, LOW-16) all PASS.
3. Team 3 — DONE: 5 REAL_BUGs fixed (LOW-11, LOW-12, LOW-14, LOW-15, LOW-17); see `round10_team3_fixes.md`.
4. Team 2 — DONE: re-verified pytest (94 passed / 1 skipped / 0 warnings) + DB residue (0 rows). See `round10_final_verification.md`.
5. **LOOP CLOSED** — Team 2 independent verification confirms 0/0/0/0.

## R10 Team 3 deliverables
- LOW-11 — BulkDeleteResponse now includes `deleted_ids` (`schemas/__init__.py:569`, `sessions.py` bulk-delete handler).
- LOW-12 — Zip-bomb ratio rejection now returns 413 (`sessions.py:159-162`).
- LOW-14 — `slow` marker registered in `conftest.py:pytest_configure`.
- LOW-15 — `created_session` fixture force-resets status to `cancelled` via sync DB UPDATE before DELETE; verified zero residue across two consecutive pytest runs.
- LOW-17 — already-resolved (sync/async fixtures coexist with distinct names); all 9 `test_authenticated_flow.py` tests pass alongside Phase 2 tests.

## Test status
- pytest: **94 passed, 0 failed, 1 skipped** (`docker compose exec backend pytest tests/`)
- DB residue post-run: **0 cf-test/iter rows** in `sessions` (verified twice)
- No `PytestUnknownMarkWarning`, no fixture conflicts

**LOOP CLOSED — Independent Team 2 verification under stricter 0/0/0/0 condition: CONFIRMED 2026-05-10**
