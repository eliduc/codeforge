# Round 10 — Team 3 Fix Report

**Team:** 3 (Fix the 5 REAL_BUG LOW items identified by Team 1)
**Date:** 2026-05-10
**Stop condition:** 0 CRITICAL + 0 HIGH + 0 MEDIUM + 0 LOW

---

## Fix results

### LOW-11: BulkDeleteResponse missing `deleted_ids` — **FIXED**
- `backend/app/schemas/__init__.py:569` — added `deleted_ids: list[str] = Field(default_factory=list)` alongside the existing `deleted_count` (kept for frontend compat).
- `backend/app/api/routes/sessions.py:1537,1565,1577-1581` — populate `deleted_ids` with each successfully-deleted session UUID and return it in the response.
- Frontend (`api.ts:473-476`) keeps consuming `deleted_count`/`failed_ids`; new `deleted_ids` field is purely additive — no frontend change required.

### LOW-12: Zip-bomb compression-ratio rejection wrong HTTP code — **FIXED**
- `backend/app/api/routes/sessions.py:159-162` — `status_code=400` → `status_code=413`, detail clarified to `"Archive compression ratio suspicious — refusing to extract"`. Now consistent with the aggregate-size 413 a few lines earlier.

### LOW-14: `pytest.mark.slow` not registered — **FIXED**
- `backend/tests/conftest.py:52-55` — added second `config.addinivalue_line("markers", "slow: tests that perform direct DB writes; not run by default smoke")`. `PytestUnknownMarkWarning` no longer emitted (verified: pytest output shows zero warnings now).

### LOW-15: Lifecycle tests left orphan session rows — **FIXED**
- `backend/tests/conftest.py:314-353` — `created_session` fixture cleanup now does a sync DB UPDATE (`status='cancelled'`) via `create_engine(get_settings().sync_database_url)` BEFORE issuing DELETE. This neutralizes the lifecycle tests' direct `_set_status('running')` writes that were causing the API DELETE to return 400 (`Cannot delete session while running or enhancing`).
- Verified: ran full pytest suite twice in succession; `SELECT status, COUNT(*) FROM sessions WHERE name LIKE 'cf-test-%' OR name LIKE 'iter-%'` returns 0 rows after each run.

### LOW-17: Conftest sync/async fixture conflict — **CLOSED (already-resolved)**
- Already addressed in R9: `async_auth_client` and `auth_client` coexist with distinct names. `test_authenticated_flow.py` (9 tests) uses `async_auth_client`; Phase 2 tests use `auth_client`. No collision.
- Verified: all 9 tests in `test_authenticated_flow.py` pass alongside the 19 tests in `test_sessions_crud.py`. No `TypeError: object Response can't be used in 'await' expression`. Coverage is intentionally complementary (auth-flow vs CRUD) — neither set is redundant.

---

## Final pytest result

```
tests/test_auth_smoke.py .......s
tests/test_authenticated_flow.py .........
tests/test_features.py ...........
tests/test_health.py ...
tests/test_multitenancy.py ............
tests/test_security.py ...................
tests/test_sessions_crud.py ...................
tests/test_workflow_lifecycle.py ..............
======================== 94 passed, 1 skipped in 9.39s =========================
```

- **94 passed / 0 failed / 1 skipped**
- Zero `PytestUnknownMarkWarning` (LOW-14 fix verified).
- Zero pytest deprecation warnings related to fixtures.

## Test residue check

After two consecutive `pytest tests/` runs:
```sql
SELECT status, COUNT(*) FROM sessions WHERE name LIKE 'cf-test-%' OR name LIKE 'iter-%' GROUP BY status;
-- (0 rows)
```
All test sessions cleaned up correctly. LOW-15 fix verified.

## Other regressions

None. All 94 tests still pass. No frontend change required (additive schema field). Backend restarted cleanly (`/health` → 200).

## Files changed

- `backend/app/schemas/__init__.py`
- `backend/app/api/routes/sessions.py`
- `backend/tests/conftest.py`

Deployed to `miniblack:/home/lev/codeforge-stage/...` via scp + `docker cp` into running backend container; backend restarted; pytest re-run inside container.
