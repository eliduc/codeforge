# CodeForge Test Suite

## Layout
- `backend/tests/` — pytest integration tests (run inside backend container)
- `e2e/` — Playwright frontend E2E
- `load-tests/` — k6 load tests
- `tests/spec/` — test specifications (markdown)
- `tests/reports/` — per-round execution reports

## Quick start

```
chmod +x tests/run_all.sh
./tests/run_all.sh                    # full suite, local stage
./tests/run_all.sh --quick            # skip slow (k6 stress, workflow LLM)
./tests/run_all.sh --backend-only     # only pytest
STAGE=remote ./tests/run_all.sh       # via ssh miniblack
```

## Test counts
- Backend: 71 integration + 19 smoke + 9 authenticated = 99 pytest
- E2E: 12 Playwright tests
- Load: 3 k6 scenarios (smoke, read-heavy, stress)
- **Total: ~114 runnable tests + 531 spec checklist**

## Stop conditions
0 CRITICAL + 0 HIGH + 0 MEDIUM bugs (per current loop strictness).

## Test data
Tests use `*@codeforge-test.example.com` whitelist; conftest.py automates OTP via direct DB insert.

## Reports
Latest summary: `tests/reports/loop_summary.md`
