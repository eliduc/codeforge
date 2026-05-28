# Round 2 Test Execution Report

## Round 1 fix re-verification

| Check | Status | Evidence |
|---|---|---|
| Security headers | PASS | `x-content-type-options=nosniff`, `x-frame-options=DENY`, `referrer-policy=strict-origin-when-cross-origin`, `cache-control=no-store` all present on `/health` |
| CORS restriction | PASS | OPTIONS with `Origin: https://evil.example` returns `400`, no `access-control-allow-origin` header |

## Authenticated pytest results

Ran `tests/test_authenticated_flow.py` (8 tests) inside backend container:
- Passed: 0
- Failed: 0
- **Skipped: 8** — all skipped because `request-otp` returned 422: pydantic `EmailStr` rejects `.local` TLD ("special-use or reserved name").
- All 10 pre-existing tests (`test_auth_smoke.py` + `test_health.py`) **PASS**.

**Setup gap (not a code bug)**: To run this suite, change `CF_TEST_EMAIL` to a real-domain whitelisted address (e.g. add `test-authflow@example.com` to `ALLOWED_EMAILS`). Test fixture path also needs `/app/tests/` (no bind mount in stage compose — used `docker compose cp`).

## Code-review verification of new spec tests (Round 2)

| Test ID | Status | Evidence | Severity if FAIL |
|---|---|---|---|
| WS-001 (no token) | PASS | `manager.py:202-205,320-323` close 4001 if `validate_ws_api_key(None)` fails | — |
| WS-002 (other user's session) | **FAIL** | `manager.py:309-325` validates token signature only; no check that `session_id` belongs to caller. No `user_id` on `Session` (models.py:93+) so impossible. | **CRITICAL** |
| WS-004 (alg=none JWT) | PASS | `auth.py:52` `jwt.decode(..., algorithms=["HS256"])` — strict allowlist | — |
| MU-002 (User B starts A's session) | **FAIL** | `sessions.py:1219-1235` `get_session` no user filter. Same for `/start`. | **CRITICAL** |
| MU-007 (cross-tenant webhook) | **FAIL** | `webhooks.py:49-54` `list_webhooks` returns ALL webhooks — no `user_id` column on `Webhook` model (models.py:521+) | **CRITICAL** |
| MU-008 (OTP rate limit per email) | PASS | `auth.py:101-118` per-email pending-count check (3 in 10 min) | — |
| ARC-002 (zip bomb) | **FAIL** | `sessions.py:113-140` checks per-entry `info.file_size <= MAX_FILE_SIZE` and `MAX_FILES`, but **no aggregate uncompressed-size cap**. 1000 entries × MAX_FILE_SIZE = unbounded extraction. | **HIGH** |
| ARC-003 (symlink in zip) | PASS | `sessions.py:122-125` skips entries with mode `0o120000` | — |
| ARC-004 (tar absolute path) | PASS | `sessions.py:148-152` `os.path.isabs(resolved)` rejected | — |
| ARC-007 (NUL in filename) | PARTIAL | No explicit NUL filter; would surface as Postgres text-NUL error, not graceful 400 | MEDIUM |
| INTL/I18N-005 (IDN email) | PASS | pydantic `EmailStr` normalizes to ASCII/punycode before whitelist match | — |
| LLM-E-005 (selected_coder_index out of range) | Need-runtime | finalizer.py validates index against coder count — not exercised here | — |
| SBE-004 (fork bomb) | PASS | `sandbox/executor.py:487-492` `RLIMIT_NPROC=256` enforced | — |
| SBE-001 (10000 fds) | PARTIAL | No `RLIMIT_NOFILE`; relies on docker default. Could exhaust container fds. | MEDIUM |
| INT-001 (delete user with sessions) | **FAIL** | No FK from `sessions.user_id` to `users.id` exists at all (User table is orphan) | **CRITICAL** (root cause of IDOR) |
| FE2-007 (token expiry while open) | Need-runtime | client-side, not verified | — |

## Bugs / Vulnerabilities Found in Round 2

### CRITICAL

**BUG-R2-001: Multi-tenant isolation is completely missing (IDOR)**
- The `User` table exists (`backend/app/db/models.py:466-481`) but **no other table references `users.id`**.
- `Session`, `Webhook`, `SessionTemplate`, `EnhancementSuggestion`, `LLMRequest`, `Intervention` — none have a `user_id` FK.
- `list_sessions` (`backend/app/api/routes/sessions.py:1188-1216`) queries with no user filter.
- `get_session` (`sessions.py:1219-1235`) — any authenticated user can read any session by ID.
- `list_webhooks` (`backend/app/api/routes/webhooks.py:49-54`) — any user sees all users' webhooks (including HMAC `secret` flag and URLs).
- `delete_session`, `start_session`, `bulk-delete`, `download-zip`, `templates` CRUD — all unscoped.
- **Impact**: Any whitelisted email enumerates / reads / modifies / deletes all other users' work, including LLM cost data and webhook URLs.
- **Spec tests this fails**: WS-002, MU-002, MU-003, MU-006, MU-007, INT-001.

**BUG-R2-002: WebSocket has no per-session authorization**
- `validate_ws_token` (`backend/app/api/auth.py:143-166`) verifies token, never checks `session_id`.
- `session_websocket_endpoint` (`backend/app/api/websocket/manager.py:309-325`) accepts any valid token for any session — broadcasts include intervention data and code excerpts.

### HIGH

**BUG-R2-003: Zip bomb defense missing total-size cap**
- `_extract_archive` (`backend/app/api/routes/sessions.py:105-173`) enforces `MAX_FILE_SIZE` per entry and `MAX_FILES` count, but no cumulative uncompressed-bytes accumulator. A 50 MB zip with 1000 entries × 5 MB each extracts 5 GB and exhausts memory before the file-count guard fires (the guard fires AFTER `zf.read(info.filename)`).

**BUG-R2-004: Test fixture cannot run**
- `test_authenticated_flow.py` defaults `CF_TEST_EMAIL=test-authflow@codeforge.local`; pydantic v2 `EmailStr` rejects `.local`. Documented setup issue, not code bug, but blocks the entire authenticated suite.

### MEDIUM

**BUG-R2-005: NUL byte in archive filename**
- No explicit `\x00` filter in `_extract_archive`; if a malicious zip contains `foo\x00.py`, behavior depends on lower layers — likely 500, not the spec'd 400.

**BUG-R2-006: No `RLIMIT_NOFILE` in sandbox**
- `sandbox/executor.py:480-492` sets `RLIMIT_AS` and `RLIMIT_NPROC` but not file-descriptor limit. SBE-001 partially mitigated by docker defaults only.

## Summary

- New tests verified by code review: **16** of 84
- New bugs CRITICAL: **2** (multi-tenancy IDOR across all resources; WS authorization)
- New bugs HIGH: **2** (zip bomb total-size; auth-flow fixture blocked)
- New bugs MEDIUM: **2** (NUL filename; RLIMIT_NOFILE)

**Round 3 fix scope must address multi-tenancy first** (add `user_id` FK to `Session`, `Webhook`, `SessionTemplate`; thread `current_user` into every router via `Depends(require_auth)` and filter all queries; reject WS upgrade unless caller owns the session). This unblocks INT-001, MU-002/003/006/007, WS-002 in one structural change. Zip-bomb fix is an isolated 5-line accumulator.
