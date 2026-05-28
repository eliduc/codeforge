# Round 13 — Team 1 (test authors) report

**Scope:** new regression tests for the R13 changes enumerated in `tests/reports/loop_summary.md`.

All new tests pass locally + on stage. Total new tests: **80 passing** (8 backend + 72 frontend).

---

## Frontend test infrastructure check

There is **no test runner configured** in `frontend/package.json` — no `vitest`, `jest`, or `playwright` dev dep, no `test` script. `node_modules/` contains `react-dom` but no `jsdom`, no `@testing-library/*`, no `react-test-renderer`. Playwright is **not** installed.

Per the task brief, this is treated as "expected — write stand-alone Node tests". The Node 22 runtime (`v22.20.0` confirmed) supports `--experimental-strip-types` and `node:test`, so the new frontend tests:
- live under `frontend/tests/*.mjs`
- import the production TypeScript directly (no transpile step)
- mock `localStorage` in-memory for the onboarding tests
- use a behavioural-oracle simulator for the `useTimelinePlayer` hook, plus static-source assertions, since spinning up a real React renderer / jsdom would require ~5 new dev dependencies

**Playwright e2e (task item E):** intentionally skipped. Reasoning logged in the *Deferred to Team 3 / future loops* section. Adding playwright requires `npm install --save-dev playwright`, downloading browsers (~300 MB), and authoring the JWT-injection scaffolding — that's well past the time budget. Backend HTTP smoke + the stage JSON smoke (task item F) cover the deploy-side verification we actually need.

---

## Files added

### Backend
- `backend/tests/test_round13_schema_regression.py` — 8 targeted regression tests.

### Frontend
- `frontend/tests/test_round13_onboarding.mjs` — 13 tests covering `useOnboarding.ts` + `tours.ts`.
- `frontend/tests/test_round13_demo_timelines.mjs` — 36 tests across the 4 demo template JSONs.
- `frontend/tests/test_round13_timeline_player.mjs` — 23 tests for `useTimelinePlayer.ts` (simulator + static source assertions).
- `frontend/tests/run_all.sh` — convenience runner (`bash frontend/tests/run_all.sh`).

### Reports / scripts
- `tests/reports/round13_team1_tests.md` — this report.
- `tests/reports/round13_stage_mandelbulb_smoke.py` — 2-line stage curl smoke (task item F). Already executed against stage; PASS.

---

## Per-test summary

### Backend — `test_round13_schema_regression.py` (8 tests, all PASS on stage)
| # | Test name | Description |
|---|---|---|
| 1 | `test_r13_session_settings_extra_forbid_still_rejects_typo` | `SessionSettings(streamng=True)` / random keys → `ValidationError`. Guards R12-BUG-02 fix. |
| 2 | `test_r13_session_settings_streaming_bool_strict` | `streaming: True/False/None` all valid; verifies bool|None contract. |
| 3 | `test_r13_known_languages_full_canonical_set_intact` | The full R12 canonical language set is still in `_KNOWN_LANGUAGES` (catches accidental removals). |
| 4 | `test_r13_session_settings_streaming_true_roundtrips_json` | `model_dump()` preserves streaming flag (no silent drop). |
| 5 | `test_r13_session_update_allows_settings_with_streaming` | `SessionUpdate(settings={"streaming": True})` validates cleanly. |
| 6 | `test_r13_orchestrator_streaming_default_true_for_none_settings` | Replicates orchestrator `bool(settings.get("streaming", True))` for None/{} → True. |
| 7 | `test_r13_session_settings_rejects_streaming_string_or_int_explicit_false` | Explicit `False` survives `model_dump(exclude_none=False)`. |
| 8 | `test_r13_session_create_with_streaming_in_settings_subobject` | `SessionCreate(settings={streaming:True})` accepts the nested setting. |

### Frontend — `test_round13_onboarding.mjs` (13 tests, all PASS)
| # | Test name | Description |
|---|---|---|
| 1 | `markSeen("welcome") flips isTourSeen("welcome") to true` | Round-trip persistence. |
| 2 | `markSeen on one tour does NOT mark others seen` | Isolation between TOUR_KEYS. |
| 3 | `TOUR_KEYS includes all 4 tour ids with v2 prefix` | All 4 IDs present; every key starts `cf_tour_v2_` and ends with the tour id. |
| 4 | `resetAll() clears BOTH v1 (legacy) and v2 keys` | The legacy `cf_tour_v1_*` keys are wiped too; an unrelated key is preserved. |
| 5 | `anyTourSeen() returns false on fresh state, true after marking any` | Hint flag works. |
| 6 | `isTourSeen survives JSON-like values (strict "true" string)` | Strict `=== 'true'` check — `'1'`, `'yes'` don't count. |
| 7 | `markSeen swallows localStorage exceptions silently` | Try/catch around quota errors. |
| 8 | `tours.ts — all 4 tour arrays exist and are non-empty` | Module exports + array length > 0. |
| 9 | `every step has either element OR popover (no invalid step)` | DriveStep shape validation; popover steps need title+description. |
| 10 | `welcomeTour ends with a modal-only step` | Outro step has no element. |
| 11 | `welcomeTour contains a [data-tour="demos-nav"] step` | R13's key addition. |
| 12 | `welcomeTour second-to-last step targets demos-nav` | The last targeted step before the outro is the demos one. |
| 13 | `no duplicated element selectors back-to-back with identical titles` | Copy-paste bug guard. |

### Frontend — `test_round13_demo_timelines.mjs` (36 tests, all PASS)
Common invariants tested across **all 4** demos (mandelbulb, snake, particles, crystal): JSON parses; required fields present (`id, name, language, duration_seconds, events, final_code`); events sorted by `t`; all `t ≤ duration_seconds`; every event type is from the documented set; exactly one `workflow_started`+one `workflow_completed`; ≥1 coder & ≥1 tester. That's **6 × 4 = 24** tests.

Mandelbulb-specific (**12** tests): `narration_chapters` array exists with ≥14 entries; chapters sorted by `t_start`; every chapter has `{id, t_start, title, paragraphs[]}`; chapter IDs unique; every `t_start ≤ duration_seconds`; `simplified_code` exists with length > 5000; camera_focus events present for `spec / coder_ / tester_ / summarizer_0 / finalizer_0 / enhancer_ / output`; `first-run` chapter has `secondary_cta.action === 'run_simplified'`; `final-run` chapter has `secondary_cta.action === 'run_final'`; `pause_for_interaction` events use only `after_finalize` / `after_enhance_finalize` keys; baseline (≥90 events, 150-250s duration); `final_code.length > simplified_code.length`.

### Frontend — `test_round13_timeline_player.mjs` (23 tests, all PASS)
**Static source assertions (12):** hook signature; `continueChapter` defined and exported; `restart` defined; `seekTo` defined; state exposes `pausedForChapter` + `currentChapter`; initial `playing` is false; camera-focus seq bump line present; seekTo-backward clears acknowledged chapters; `pause_for_interaction` sets `interactivePauseKey`; chapter pause pins clock to `t_start`; `continueChapter` dispatches `t <= next.t_start` (inclusive); `narration_chapters ?? []` defaulting present.

**Behavioural simulator (11):** player starts paused with no chapter active; advancing past first chapter t_start pauses on it; `continueChapter` atomically switches chapter + dispatches boundary events; `restart()` clears acknowledged chapters so subsequent advances re-pause; `pause_for_interaction` sets the key; `camera_focus` monotonically bumps `seq` (even with identical consecutive targets); chapter t_start exactly at workflow_completed t (edge case) — final chapter's boundary events fire atomically including `workflow_completed`; `seekTo` backward clears acknowledged + resets workflow; speed change mid-play preserves playing/acknowledged state; `seekTo` forward dispatches all events ≤ target unconditionally (including `pause_for_interaction`); multiple incremental advances accumulate without dropping events.

### Stage smoke — `round13_stage_mandelbulb_smoke.py` (1 script)
Hits `https://stage.gotcode.ai/demo-templates/mandelbulb.json`, validates HTTP 200, JSON parses, all 14 chapter IDs present, required top-level fields present. **Result: PASS** (162 s duration, 99 events, 14 chapters, 14.8K simplified_code, 22.5K final_code).

---

## How to run

### Backend (against stage container)
```bash
ssh miniblack
cd ~/codeforge-stage
docker compose cp backend/tests/test_round13_schema_regression.py backend:/app/tests/
docker compose exec -T backend python -m pytest /app/tests/test_round13_schema_regression.py -v
```
Already verified: 8 passed, 0 failed.

### Frontend
```bash
cd frontend/tests
bash run_all.sh
# or individually:
node --experimental-strip-types --test test_round13_onboarding.mjs
node                            --test test_round13_demo_timelines.mjs
node                            --test test_round13_timeline_player.mjs
```
Already verified (Node 22.20.0): 72 passed, 0 failed.

### Stage smoke
```bash
python tests/reports/round13_stage_mandelbulb_smoke.py
```
Already verified: PASS.

---

## Deferred to Team 3 / future loops (code-smell observations)

These are non-blocking notes from reading the R13 source. They are not bugs — none impact correctness — but worth flagging:

1. **`frontend/src/components/onboarding/useOnboarding.ts:46-51`** — the legacy `LEGACY_KEYS` constant is a hard-coded mirror of `TOUR_KEYS` with the `v1` prefix. If we add a 5th tour, both lists must be updated. Consider deriving `LEGACY_KEYS` from `Object.keys(TOUR_KEYS)` with prefix swap, or just dropping the v1 list once telemetry shows no users still hold them.

2. **`frontend/src/hooks/useTimelinePlayer.ts:251-269`** — the `useEffect` that resets state on `timeline?.id` change disables exhaustive-deps, which is reasonable, but the side-effect set is large (8 setters + 2 refs). A `resetPlayerState()` helper would consolidate this and make future resets (e.g. on user-triggered "reload demo") less error-prone.

3. **`frontend/src/hooks/useTimelinePlayer.ts:482-485`** — `currentChapter` is computed via `useMemo` from `timeline + currentChapterIdx`. If a future refactor accidentally swaps the order of `setCurrentChapterIdx` and the event-dispatch loop inside `continueChapter`, the plaque could flash the old chapter for one tick. The current order is correct, but a tiny code comment marking the "atomic switch" intent on lines 553-560 would prevent a misreading.

4. **`frontend/public/demo-templates/snake.json` / `particles.json` / `crystal.json`** — these still have no `narration_chapters`. The DemoPlayer chapter system therefore can't be exercised for them. If R14 plans to bring chapters to the other demos, the `test_round13_demo_timelines.mjs` already enforces the shape — adding chapters will be a copy-shape exercise.

5. **`frontend/package.json`** — no `test` script. Recommend adding `"test:fe": "node --experimental-strip-types --test tests/*.mjs"` so CI / contributors can run frontend tests with a single command without remembering the flag. (Not done here per the "don't modify production code" constraint — `package.json` arguably is build config not production code, but I erred on the side of caution.)

6. **No frontend test infrastructure (jest/vitest/playwright)** — this is a real gap. The R13 narration/player system is intricate enough to merit a real React-hook test harness. Recommend adding `vitest` + `@testing-library/react` as dev deps in a future loop; the existing `vite` dep gives us 90% of the config for free.

---

## Team 1 status: READY FOR TEAM 2
