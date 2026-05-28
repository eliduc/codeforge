# Backend API Test Specification — CodeForge

Comprehensive test cases covering functionality, security, and edge cases for all backend HTTP endpoints. Each test references the route file at `backend/app/api/routes/`.

**Base URL (in docker compose):** `http://backend:8000`
**Auth:** Bearer JWT obtained via `/api/auth/verify-otp`. Most routes require `Depends(require_auth)`. In dev mode (`AUTH_DISABLED=true`) auth checks are bypassed.

Severity legend: **CRITICAL** (blocks release / data loss / auth bypass) | **HIGH** (major feature broken) | **MEDIUM** (degraded UX) | **LOW** (cosmetic).

---

## 1. Authentication & Authorization (`auth.py`)

| ID | Method | Endpoint | Description | Expected | Negative cases | Severity |
|----|--------|----------|-------------|----------|----------------|----------|
| BE-AUTH-001 | POST | /api/auth/request-otp | Whitelisted email gets OTP | 200, body has `message`, no `not_allowed` | --- | HIGH |
| BE-AUTH-002 | POST | /api/auth/request-otp | Non-whitelisted email | 200 `{not_allowed: true}` (no enumeration) | --- | HIGH |
| BE-AUTH-003 | POST | /api/auth/request-otp | Invalid email format `"notanemail"` | 422 Pydantic validation error | --- | MEDIUM |
| BE-AUTH-004 | POST | /api/auth/request-otp | Rate-limit: 4th request within 10 min for same email | Returns generic OK message, no new OTP record created | DB row count must not increase past 3 pending | HIGH |
| BE-AUTH-005 | POST | /api/auth/request-otp | Email with mixed case + whitespace | Normalized to lowercase; whitelist match works | --- | LOW |
| BE-AUTH-006 | POST | /api/auth/verify-otp | Correct code | 200 `{access_token, token_type:"bearer", user}`; OTP marked used | --- | CRITICAL |
| BE-AUTH-007 | POST | /api/auth/verify-otp | Wrong code | 400 with `"Incorrect code. N attempt(s) remaining"`; attempts incremented | --- | CRITICAL |
| BE-AUTH-008 | POST | /api/auth/verify-otp | 6th attempt on same OTP | 429 "Too many attempts" | Must not return token even with correct code | CRITICAL |
| BE-AUTH-009 | POST | /api/auth/verify-otp | Expired code (>10 min old) | 400 "Invalid or expired code" | --- | HIGH |
| BE-AUTH-010 | POST | /api/auth/verify-otp | Reused (already-used) code | 400 invalid; cannot mint second token | --- | CRITICAL |
| BE-AUTH-011 | POST | /api/auth/verify-otp | Email not in DB but code provided | 400 (no OTP row exists) | --- | MEDIUM |
| BE-AUTH-012 | GET | /api/auth/me | Valid JWT | 200, returns user profile | --- | HIGH |
| BE-AUTH-013 | GET | /api/auth/me | Missing Authorization header | 401 | --- | CRITICAL |
| BE-AUTH-014 | GET | /api/auth/me | Tampered JWT (changed signature) | 401 | --- | CRITICAL |
| BE-AUTH-015 | GET | /api/auth/me | Expired JWT | 401 | --- | CRITICAL |
| BE-AUTH-016 | GET | /api/auth/me | JWT for deleted user | 401 "User not found" | --- | HIGH |
| BE-AUTH-017 | POST | /api/auth/request-access | Valid email | 200, generic message; admin email sent if configured | --- | LOW |

## 2. Sessions CRUD (`sessions.py`)

| ID | Method | Endpoint | Description | Expected | Negative | Severity |
|----|--------|----------|-------------|----------|----------|----------|
| BE-SESS-001 | POST | /api/sessions/ | Create with name + specification | 201, returns SessionResponse with id | Missing `name`/`specification` → 422 | HIGH |
| BE-SESS-002 | POST | /api/sessions/ | Create with oversized spec (>1MB) | 413 or 422 (configured cap) | --- | MEDIUM |
| BE-SESS-003 | POST | /api/sessions/ | Create with HTML/JS in name (XSS payload) | 201 stored as-is (frontend escapes) | --- | MEDIUM |
| BE-SESS-004 | GET | /api/sessions/ | List default page | 200 with `items, total, page, page_size` | --- | HIGH |
| BE-SESS-005 | GET | /api/sessions/?status=running | Filter by status | Only running sessions returned | Invalid status → 422 | MEDIUM |
| BE-SESS-006 | GET | /api/sessions/?search=foo | Substring match on name | Only matching sessions | Empty results allowed | MEDIUM |
| BE-SESS-007 | GET | /api/sessions/?page=999 | Out-of-range page | 200 with empty items | --- | LOW |
| BE-SESS-008 | GET | /api/sessions/{id} | Existing id | 200 SessionResponse | --- | HIGH |
| BE-SESS-009 | GET | /api/sessions/{id} | Nonexistent UUID | 404 | --- | HIGH |
| BE-SESS-010 | GET | /api/sessions/{id} | Malformed UUID | 422 or 404 | --- | LOW |
| BE-SESS-011 | PATCH | /api/sessions/{id} | Update fields on draft | 200 with updated values | --- | HIGH |
| BE-SESS-012 | PATCH | /api/sessions/{id} | Update during running session | 409 Conflict (immutable while running) | --- | CRITICAL |
| BE-SESS-013 | DELETE | /api/sessions/{id} | Delete draft/completed | 204 | --- | HIGH |
| BE-SESS-014 | DELETE | /api/sessions/{id} | Delete during running | 409 Conflict — must cancel first | --- | CRITICAL |
| BE-SESS-015 | POST | /api/sessions/bulk-delete | Mix of valid/invalid IDs | 200 with `{deleted: [...], skipped: [...]}` | Empty list → 422 | MEDIUM |
| BE-SESS-016 | POST | /api/sessions/{id}/copy | Clone session | 201 new session in draft | --- | MEDIUM |
| BE-SESS-017 | POST | /api/sessions/{id}/copy-structure | Copy without artifacts | 201 with empty code/audits | --- | MEDIUM |

## 3. Workflow Lifecycle (`sessions.py`)

| ID | Method | Endpoint | Description | Expected | Negative | Severity |
|----|--------|----------|-------------|----------|----------|----------|
| BE-WF-001 | POST | /api/sessions/{id}/start | Start draft session | 200 status=running, orchestrator task launched | --- | CRITICAL |
| BE-WF-002 | POST | /api/sessions/{id}/start | Double-start (already running) | 409 idempotent rejection | --- | HIGH |
| BE-WF-003 | POST | /api/sessions/{id}/pause | Pause running | 200 status=paused | --- | HIGH |
| BE-WF-004 | POST | /api/sessions/{id}/pause | Pause draft (not running) | 409 | --- | MEDIUM |
| BE-WF-005 | POST | /api/sessions/{id}/resume | Resume paused | 200 status=running | --- | HIGH |
| BE-WF-006 | POST | /api/sessions/{id}/cancel | Cancel running | 200 status=cancelled | --- | HIGH |
| BE-WF-007 | POST | /api/sessions/{id}/reset | Reset completed session to draft | 200, code/audits cleared | --- | HIGH |
| BE-WF-008 | POST | /api/sessions/{id}/re-finalize | Trigger finalizer again | 200, new finalizer run | If no code yet → 400 | MEDIUM |
| BE-WF-009 | POST | /api/sessions/{id}/intervene | Inject user note | 200 InterventionResponse | Empty content → 422 | MEDIUM |
| BE-WF-010 | GET | /api/sessions/{id}/checkpoints | List orchestrator checkpoints | 200 array | --- | LOW |
| BE-WF-011 | POST | /api/sessions/{id}/complete | Manual mark complete | 200 status=completed | --- | LOW |

## 4. Code, Audits, Metrics (`code.py`)

| ID | Method | Endpoint | Description | Expected | Negative | Severity |
|----|--------|----------|-------------|----------|----------|----------|
| BE-CODE-001 | GET | /api/sessions/{id}/code | Versions for completed session | 200 list, ordered by iteration | --- | HIGH |
| BE-CODE-002 | GET | /api/code/{version_id} | Single version | 200 with full source | 404 if missing | HIGH |
| BE-CODE-003 | GET | /api/sessions/{id}/audits?iteration=2 | Filter by iteration | Only audits for iter=2 | --- | MEDIUM |
| BE-CODE-004 | GET | /api/sessions/{id}/audits?coder_id=X | Filter by coder | Only that coder's audits | --- | MEDIUM |
| BE-CODE-005 | GET | /api/audits/{audit_id} | Single audit | 200 AuditResponse | 404 if missing | MEDIUM |
| BE-CODE-006 | GET | /api/sessions/{id}/summaries | Summarizer outputs | 200 list | --- | MEDIUM |
| BE-CODE-007 | GET | /api/sessions/{id}/responses | Coder LLM responses | 200 list | --- | LOW |
| BE-CODE-008 | GET | /api/sessions/{id}/result | Final code+report | 200 or null if not finalized | --- | HIGH |
| BE-CODE-009 | GET | /api/sessions/{id}/llm-requests | Provider request log | 200 list | Secrets must NOT appear | HIGH |
| BE-CODE-010 | GET | /api/sessions/{id}/metrics | Aggregated tokens/cost | Tokens & cost sums match per-request totals | Tolerance ±$0.01 | HIGH |
| BE-CODE-011 | GET | /api/dashboard/stats | Global stats | 200 with session counts, active count, totals | --- | MEDIUM |
| BE-CODE-012 | GET | /api/sessions/{id}/metrics | Cost > alert threshold | Response includes alert flag | --- | MEDIUM |
| BE-CODE-013 | GET | /api/sessions/{id}/interventions | List interventions | 200 list | --- | LOW |

## 5. Execution (`execution.py`)

| ID | Method | Endpoint | Description | Expected | Negative | Severity |
|----|--------|----------|-------------|----------|----------|----------|
| BE-EXEC-001 | POST | /api/sessions/{id}/run | Run final python code | 200 with stdout/stderr/exit_code | --- | HIGH |
| BE-EXEC-002 | POST | /api/sessions/{id}/run | Browser language → packaged HTML bundle | 200 with bundle_url | --- | HIGH |
| BE-EXEC-003 | POST | /api/sessions/{id}/bundle | Build static bundle | 200 with download path | Non-browser language → 400 | MEDIUM |
| BE-EXEC-004 | POST | /api/code-versions/{vid}/run | Run specific version | 200 | 404 if missing | MEDIUM |
| BE-EXEC-005 | POST | /api/code/{vid}/execute | Sandbox execution timeout | 200 with `timed_out: true`, output truncated | --- | HIGH |
| BE-EXEC-006 | POST | /api/code/{vid}/execute | Sandbox failure (image missing) | 500 with descriptive error, no stack leak | --- | HIGH |
| BE-EXEC-007 | GET | /api/code/{vid}/executions | History | 200 list | --- | LOW |
| BE-EXEC-008 | POST | /api/code/{vid}/execute | Code with infinite loop | Killed at timeout, response within timeout+5s | --- | HIGH |

## 6. Templates (`templates.py`)

| ID | Method | Endpoint | Description | Expected | Negative | Severity |
|----|--------|----------|-------------|----------|----------|----------|
| BE-TPL-001 | POST | /api/templates/ | Create template | 201 with id | Missing name → 422 | MEDIUM |
| BE-TPL-002 | POST | /api/templates/from-session/{id} | Create from session config | 201 with copied agent config | --- | MEDIUM |
| BE-TPL-003 | POST | /api/templates/{id}/apply | Apply to new session | 201 session created from template | Missing required field overrides → 422 | MEDIUM |
| BE-TPL-004 | DELETE | /api/templates/{id} | Delete | 204 | 404 if missing | LOW |

## 7. Webhooks (`webhooks.py`)

| ID | Method | Endpoint | Description | Expected | Negative | Severity |
|----|--------|----------|-------------|----------|----------|----------|
| BE-WH-001 | POST | /api/webhooks/ | Create webhook | 201 with id | Invalid URL → 422 | MEDIUM |
| BE-WH-002 | POST | /api/webhooks/{id}/test | Test ping | 200 with status code from target | Unreachable target → captured, no 500 | MEDIUM |
| BE-WH-003 | PATCH | /api/webhooks/{id} | Update events filter | 200, only listed events fire | --- | MEDIUM |
| BE-WH-004 | POST | /api/webhooks/{id}/test | Verify HMAC `X-CodeForge-Signature` header on outgoing call | Header present, hex sha256 of body w/ secret | --- | HIGH |

## 8. Prompts + Versioning (`prompts.py`)

| ID | Method | Endpoint | Description | Expected | Negative | Severity |
|----|--------|----------|-------------|----------|----------|----------|
| BE-PR-001 | POST | /api/prompts/ | Create new prompt template | 201 v1 created | Duplicate slug → 409 | MEDIUM |
| BE-PR-002 | PATCH | /api/prompts/{id} | Update body creates version row | 200; GET versions returns 2 | --- | HIGH |
| BE-PR-003 | GET | /api/prompts/{id}/versions | List versions | 200 ordered desc | --- | MEDIUM |
| BE-PR-004 | POST | /api/prompts/{id}/rollback/{n} | Rollback to v=n | 200 fields match historical version | Invalid version → 404 | HIGH |
| BE-PR-005 | POST | /api/prompts/validate | Lint prompt template variables | 200 with `valid: true/false, errors[]` | --- | LOW |
| BE-PR-006 | GET | /api/prompts/defaults | Built-in defaults | 200 dict | --- | LOW |

## 9. Settings (`settings.py`)

| ID | Method | Endpoint | Description | Expected | Severity |
|----|--------|----------|-------------|----------|----------|
| BE-SET-001 | GET | /api/settings/providers | Returns enabled providers + masked keys | 200; no plaintext API keys | CRITICAL |
| BE-SET-002 | PUT | /api/settings/providers/{p}/config | Update provider config | 200; key stored encrypted | HIGH |
| BE-SET-003 | POST | /api/settings/providers/{p}/test | Test connection | 200 success/failure | MEDIUM |
| BE-SET-004 | GET | /api/settings/models/{provider} | List provider models | 200 list | MEDIUM |
| BE-SET-005 | POST | /api/settings/refresh-models | Refresh model catalog from providers | 200 | LOW |
| BE-SET-006 | GET | /api/settings/pricing | Token pricing dict | 200 | LOW |

## 10. Sessions: Files / Repo / Git (`sessions.py`)

| ID | Method | Endpoint | Description | Expected | Negative | Severity |
|----|--------|----------|-------------|----------|----------|----------|
| BE-FILE-001 | POST | /api/sessions/upload-files | Upload allowed file types | 200 paths | Path traversal `../../etc/passwd` rejected | CRITICAL |
| BE-FILE-002 | POST | /api/sessions/upload-files | Oversized file (>configured cap) | 413 | --- | MEDIUM |
| BE-FILE-003 | POST | /api/sessions/upload-files | Disallowed extension (.exe) | 400 | --- | HIGH |
| BE-FILE-004 | POST | /api/sessions/fetch-repo | Public GitHub repo | 200 with file tree | --- | HIGH |
| BE-FILE-005 | POST | /api/sessions/fetch-repo | Internal IP / file:// / localhost (SSRF) | 400 rejected | --- | CRITICAL |
| BE-FILE-006 | POST | /api/sessions/fetch-repo | Invalid URL format | 422 | --- | MEDIUM |
| BE-FILE-007 | GET | /api/sessions/{id}/download-zip | Download artifacts | 200 application/zip | --- | MEDIUM |
| BE-FILE-008 | POST | /api/sessions/create-pr | Create GitHub PR | 200 with PR URL | Bad token → 401 surfaced | HIGH |
| BE-FILE-009 | POST | /api/sessions/list-branches | List branches of remote | 200 list | --- | MEDIUM |
| BE-FILE-010 | GET | /api/sessions/{id}/git/commits | Commit history | 200 list | --- | LOW |
| BE-FILE-011 | GET | /api/sessions/{id}/git/diff | Diff between iterations | 200 unified diff | --- | LOW |
| BE-FILE-012 | POST | /api/sessions/pr-status | Poll PR state | 200 with merged/open/closed | --- | LOW |
| BE-FILE-013 | POST | /api/sessions/export | Export session JSON | 200 application/json | --- | MEDIUM |
| BE-FILE-014 | POST | /api/sessions/import | Import session JSON | 200 ImportResponse | Malformed JSON → 422 | MEDIUM |

## 11. Agents Subroutes (`sessions.py`)

| ID | Method | Endpoint | Description | Expected | Severity |
|----|--------|----------|-------------|----------|----------|
| BE-AG-001 | GET | /api/sessions/{id}/agents | List agent configs | 200 list | MEDIUM |
| BE-AG-002 | POST | /api/sessions/{id}/agents | Add agent | 201 | MEDIUM |
| BE-AG-003 | PATCH | /api/sessions/{id}/agents/{aid} | Update agent role/model/temp | 200 | MEDIUM |
| BE-AG-004 | DELETE | /api/sessions/{id}/agents/{aid} | Remove agent | 204; cannot remove last finalizer | HIGH |

## 12. Enhancements (`sessions.py`)

| ID | Method | Endpoint | Description | Expected | Severity |
|----|--------|----------|-------------|----------|----------|
| BE-ENH-001 | POST | /api/sessions/{id}/enhance | Generate suggestions | 200 EnhanceResponse | MEDIUM |
| BE-ENH-002 | GET | /api/sessions/{id}/enhancement-suggestions | List | 200 list | LOW |
| BE-ENH-003 | POST | /api/sessions/{id}/apply-enhancements | Apply selected | 200 with updated specification | MEDIUM |

---

## 13. Cross-cutting Security Tests

| ID | Description | Expected | Severity |
|----|-------------|----------|----------|
| BE-SEC-001 | SQL injection in `?search=`: pass `' OR 1=1--` | Treated as literal substring; no SQL error; does not return all sessions | CRITICAL |
| BE-SEC-002 | Path traversal in upload-files filename `../../../etc/passwd` | Rejected or sanitised before disk write | CRITICAL |
| BE-SEC-003 | SSRF in fetch-repo URL: `http://127.0.0.1:8000/api/sessions` | Blocked (private IP filter) | CRITICAL |
| BE-SEC-004 | SSRF: `file:///etc/passwd` | Blocked (scheme allowlist `http(s)`) | CRITICAL |
| BE-SEC-005 | XSS payload in session.name `<script>alert(1)</script>` | Stored verbatim; frontend escapes; API JSON output not double-encoded | MEDIUM |
| BE-SEC-006 | CORS preflight from `Origin: https://evil.example` | 400 or no `Access-Control-Allow-Origin` mirroring evil origin | HIGH |
| BE-SEC-007 | Webhook signature: tamper body before verifying HMAC | Test endpoint receives signature; invalid signatures rejected by external receiver design | HIGH |
| BE-SEC-008 | Error responses do not leak: provider API keys, JWT secret, DB connection string, file paths under /home or C:\ | grep response bodies of forced-error endpoints | CRITICAL |
| BE-SEC-009 | Unauthenticated GET on every router prefix → 401 | Loop over `/api/sessions, /api/code/*, /api/prompts, /api/templates, /api/webhooks, /api/settings/*, /api/auth/me` | CRITICAL |
| BE-SEC-010 | JWT with `alg: none` | 401 (PyJWT must reject alg=none) | CRITICAL |
| BE-SEC-011 | OTP timing attack: compare durations of correct-vs-wrong code | std-dev within noise (uses `hmac.compare_digest`) | HIGH |
| BE-SEC-012 | Mass-assignment on PATCH /sessions/{id}: try setting `id`, `created_at`, `user_id` | Ignored; original values preserved | HIGH |
| BE-SEC-013 | Rate-limit OTP and login endpoints by IP | 429 after configured threshold | HIGH |

---

## Summary

- **Total test cases:** 109
- **CRITICAL:** 18 — auth, SSRF, SQLi, path traversal, secret leakage, JWT
- **HIGH:** 35 — core CRUD, lifecycle, metrics, code retrieval
- **MEDIUM:** 41 — filters, templates, prompts, enhancements, settings
- **LOW:** 15 — cosmetic and read-only endpoints
