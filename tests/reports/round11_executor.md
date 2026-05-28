# Round 11 Test Execution Report

Date: 2026-05-10
Branch: main (stage)
Migration head: 019 (head) — confirmed
Sessions table sprint-10 columns present: cost_limit_usd numeric(10,2), session_timeout_sec integer, expected_output text, share_token varchar(64) UNIQUE — confirmed

## Sprint-10 backend tests
- Tests run: 40
- Passed: 33
- Failed: 7
- Skipped: 0

Failed IDs:
- tests/test_sprint10_endpoints.py::test_generate_tests_returns_scaffold
- tests/test_sprint10_endpoints.py::test_generate_docs_returns_readme
- tests/test_sprint10_endpoints.py::test_vercel_deploy_python_unsupported
- tests/test_sprint10_endpoints.py::test_vercel_deploy_bad_token_returns_502
- tests/test_sprint10_schema.py::test_cost_limit_usd_round_trip
- tests/test_sprint10_schema.py::test_session_timeout_sec_round_trip
- tests/test_sprint10_schema.py::test_expected_output_round_trip

## Full regression suite
- Tests run: 135
- Passed: 127
- Failed: 7 (same set as above — no NEW regressions outside sprint-10)
- Skipped: 1

## Frontend critical tests (code-review)

| ID | Status | Evidence |
|----|--------|----------|
| SP10-FE-12 Share modal | PASS | `frontend/src/components/common/ResultActionsExtras.tsx` — modal type `'share'` (L34), `openShare` (L204) calls `createShareLink`, modal render at L367 with copy button + revoke handler. |
| SP10-FE-19 /share/:token public | PASS | `frontend/src/App.tsx` L19: `<Route path="/share/:token" element={<SharedSessionPage />} />` placed OUTSIDE the RequireAuth block (which starts L22-25). |
| SP10-FE-28 Preview does not create session | PASS | `frontend/src/components/graph/EnhancerPanel.tsx` `handlePreview` (L186) only flips local state (`setPreviewedAgents`, `setPreviewMode`); does NOT call `enhanceSession`. TODO comment at L180-185 acknowledges backend `?preview=true` not yet wired (handled locally for now). |
| SP10-FE-01 Spec panel mount | PASS (code) | `SpecHelperPanel.tsx` imports `scoreSpec`, `estimateCost`. |
| SP10-FE-06 Cost+tokens | PASS (code) | `estimateCost` API wired via `/api/spec-helper/cost-estimate`. |
| SP10-FE-07 Streaming PATCH | PASS (code) | `SessionDetailPage.tsx` streaming consumer at L2510 `case 'agent_streaming'`. |
| SP10-FE-08 Live streaming text | PASS (code) | `streamingContent` accumulation L2525-L2530. |
| SP10-FE-11 Tests scaffold call | PASS (code) | `ResultActionsExtras.tsx` L260 calls `generateTests`. |
| SP10-FE-17 Docs/deploy call | PASS (code) | `ResultActionsExtras.tsx` L311 calls `generateDocs`; deploy via `/api/sessions/${id}/deploy/vercel`. |
| SP10-FE-23 REPLPreview | PASS (code) | `DetailPanel.tsx` L1160 `REPLPreview` component, rendered L1538. |

## HTTP smoke tests

| Endpoint | Expected | Actual |
|---|---|---|
| GET /health | 200 | 200 |
| POST /api/spec-helper/spec-score | 401 | 401 |
| POST /api/spec-helper/cost-estimate | 401 | 401 |
| GET /api/share/nonexistent_token_test | 404 | 404 |
| POST /api/sessions/.../share | 401 | 401 |
| DELETE /api/sessions/.../share | 401 | 401 |
| POST /api/sessions/.../generate-tests | 401 | 401 |
| POST /api/sessions/.../generate-docs | 401 | 401 |
| POST /api/sessions/.../deploy/vercel | 401 | 401 |
| POST /api/sessions/.../enhance?preview=true | 401 | 401 |

All endpoints reachable and correctly auth-gated.

## Bugs Found

### CRITICAL
None.

### HIGH

- **SP10-BE-BUG-01 (HIGH) — Sprint-10 session fields silently dropped on POST and PATCH**
  - Files: `backend/app/api/routes/sessions.py`
  - Evidence: In `create_session` (L1355-1387), the `Session(...)` model constructor does NOT pass `cost_limit_usd`, `session_timeout_sec`, or `expected_output` from `session_data`. They land as NULL in DB.
  - In `update_session` (L1473), `_ALLOWED_UPDATE_FIELDS` (L1474) does NOT include these three fields. Any PATCH attempting to set them is rejected with `400 "Field 'cost_limit_usd' cannot be updated"`.
  - Schemas correctly define the fields on `SessionCreate`, `SessionUpdate`, and `SessionResponse`; ORM model columns also exist (per `models.py:128-131`). Only the route handler is missing the wiring.
  - Test impact: `test_cost_limit_usd_round_trip`, `test_session_timeout_sec_round_trip`, `test_expected_output_round_trip` all fail because round-tripped values are `None`.
  - User impact: User submits cost cap / session timeout / expected output via API; values are silently discarded. Cost guards and test-driven mode (Features #3a/#3b/#7) are non-functional.
  - **VIOLATES Non-Degradation Rule** — fields are part of advertised SessionCreate/Update schema but produce no effect.

- **SP10-BE-BUG-02 (HIGH) — FinalResult model missing `final_summary` column expected by sprint-10 test helper / endpoints**
  - Files: `backend/app/db/models.py:420-444` (FinalResult), `backend/tests/test_sprint10_endpoints.py:66`
  - Evidence: The shared test helper `_seed_final_code` inserts `FinalResult(... final_summary="seeded for tests")`. SQLAlchemy raises `CompileError: Unconsumed column names: final_summary` — the column does not exist on `FinalResult`.
  - Impact: 4 endpoint tests (generate-tests, generate-docs, vercel-deploy variants) cannot exercise their happy-paths. The generate-tests / generate-docs endpoints likely consume `final_summary` too (otherwise tests wouldn't be authored to seed it); if they reference a non-existent column at runtime, they will 500.
  - Either the column needs to be added (with a new migration ≥ 020) OR the test helper needs to drop `final_summary` if the field was intentionally removed. Either way the codebase is inconsistent with the tests authored to validate it.

### MEDIUM
None.

## Summary
- New bugs: 0 CRITICAL / 2 HIGH / 0 MEDIUM
- READY-TO-CLOSE-LOOP: **no**

Both bugs are sprint-10 specific (R11 introduced new tests; previous rounds closed at 0/0/0/0 against the pre-sprint-10 codebase, so these are genuinely new defects shipped with sprint-10).
