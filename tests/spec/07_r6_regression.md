# Round 6 — Regression Test Suite

Validates fixes applied in R1-R5 and earlier P0/P1/P2 work. Each test is binary
PASS/FAIL: PASS = the fix is still in place, FAIL = REGRESSION (severity noted).

Conventions:
- **code-review**: static check via Grep/Read against listed file:line.
- **runtime curl/pytest**: live check against running stack (`make up`).
- Two users referenced: A (`alice@test.local`) and B (`bob@test.local`).

---

## Section 1 — R1 Hardening Fixes (security headers, CORS, secret, OTP, WS, retries)

### REG-R1-001 — Security headers always applied
- Description: Headers must be set on every response regardless of `DEBUG`.
- Verify (runtime): `curl -sI https://stage.gotcode.ai/health` and grep
  `x-content-type-options: nosniff`, `x-frame-options: DENY`,
  `referrer-policy: strict-origin-when-cross-origin`,
  `cache-control: no-store` present.
- Verify (code-review): `backend/app/main.py` SecurityHeadersMiddleware — no
  `if settings.DEBUG` gating around the four headers above.
- Expected: all four headers present.
- Severity if regression: **HIGH**.

### REG-R1-002 — HSTS only in non-debug
- Verify (code-review): `backend/app/main.py` `if not settings.DEBUG: response.headers["strict-transport-security"] = ...`.
- Verify (runtime): with `DEBUG=true` HSTS absent; with `DEBUG=false` present
  with `max-age>=31536000; includeSubDomains`.
- Expected: matches above.
- Severity: **MEDIUM**.

### REG-R1-003 — CORS rejects evil origin
- Verify: `curl -i -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: GET' -X OPTIONS https://stage.gotcode.ai/api/sessions/`
- Expected: response has no `access-control-allow-origin: https://evil.example`
  header (Starlette returns 400 or omits the header).
- Severity: **CRITICAL**.

### REG-R1-004 — CORS allows configured stage origin
- Verify: same curl with `Origin: https://stage.gotcode.ai`.
- Expected: `access-control-allow-origin: https://stage.gotcode.ai` present,
  `access-control-allow-credentials: true`.
- Severity: **HIGH**.

### REG-R1-005 — Wildcard origins gated on DEBUG
- Verify (code-review): `backend/app/core/config.py` — `CORS_ALLOW_WILDCARD`
  effective only when `DEBUG=true`. With `CORS_ALLOW_WILDCARD=true` and
  `DEBUG=false`, computed `cors_origins` must NOT contain `*`.
- Verify (pytest): `pytest backend/tests/test_cors.py::test_wildcard_disabled_when_not_debug`.
- Expected: wildcard suppressed in production.
- Severity: **CRITICAL**.

### REG-R1-006 — Ephemeral SECRET_KEY logs ERROR not WARN
- Verify (code-review): `backend/app/core/config.py` — when `SECRET_KEY` is
  unset and `DEBUG=false`, `logger.error(...)` (or raises) instead of warn.
- Verify (runtime): start backend with `SECRET_KEY=` and `DEBUG=false`; grep
  logs for `ERROR` containing "SECRET_KEY".
- Expected: ERROR level entry; tokens issued in this state must not validate
  on next restart.
- Severity: **CRITICAL**.

### REG-R1-007 — OTP rate-limit FOR UPDATE
- Verify (code-review): `backend/app/api/routes/auth.py` request-otp handler
  selects user row with `.with_for_update()` before counting OTPs in window.
- Verify (pytest): `test_auth_otp_concurrent.py` — fire 10 parallel
  request-otp calls for same email; exactly 3 succeed in 10-min window, rest
  return 429.
- Expected: 3 success / 7 rejected.
- Severity: **HIGH**.

### REG-R1-008 — WebSocket idle timeout 300s
- Verify (code-review): `backend/app/api/websocket/manager.py` — `await asyncio.wait_for(ws.receive_text(), timeout=300)`.
- Verify (runtime): open ws, send nothing for 305s; expect server close.
- Expected: connection closed by server with 1011/4000-class code.
- Severity: **MEDIUM**.

### REG-R1-009 — `max_iterations=0` coerced to 1
- Verify (pytest): POST `/api/sessions/` with `max_iterations=0`.
- Expected: 200/201 with response.max_iterations == 1 (or 422 if validator
  rejects). Must not start a session that runs zero iterations.
- Severity: **MEDIUM**.

### REG-R1-010 — Anthropic latency tracked across retries
- Verify (code-review): `backend/app/llm/providers/anthropic_provider.py` —
  `start = time.time()` before retry loop, latency computed after final
  attempt; not reset inside `except` block.
- Verify (pytest): mock 2 retries of 1s each; `latency_ms >= 2000`.
- Expected: total wall-time captured.
- Severity: **MEDIUM**.

### REG-R1-011 — Rollback `except` logs warning
- Verify (code-review): grep all `except:\\s*pass` in `backend/app/` —
  zero hits. Replaced with `except Exception as e: logger.warning(...)`.
- Expected: zero bare except-pass lines.
- Severity: **MEDIUM**.

---

## Section 2 — R3 Multi-Tenancy

### REG-R3-001 — List sessions tenant-scoped
- pytest: A creates 2 sessions, B creates 3. `GET /api/sessions/` as A returns
  exactly A's 2.
- Severity: **CRITICAL**.

### REG-R3-002 — GET other user session → 404
- pytest: A `GET /api/sessions/{B_session_id}` → 404 (not 403, not 200).
- Severity: **CRITICAL**.

### REG-R3-003 — PATCH other user session → 404
- pytest: A `PATCH /api/sessions/{B_session_id}` body `{"task":"x"}` → 404.
- Severity: **CRITICAL**.

### REG-R3-004 — DELETE other user session → 404
- pytest: A `DELETE /api/sessions/{B_session_id}` → 404; B's session still
  exists.
- Severity: **CRITICAL**.

### REG-R3-005 — Bulk-delete cross-tenant ids → failed_ids
- pytest: A `POST /api/sessions/bulk-delete` with `[A1, B1, B2]` →
  `deleted_ids=[A1]`, `failed_ids=[B1,B2]`. B's sessions intact.
- Severity: **CRITICAL**.

### REG-R3-006 — WS to other user's session closes 4004
- pytest: A connects `wss://.../ws/{B_session_id}` with A's token. Server
  closes with code 4004 ("not found / forbidden").
- Severity: **CRITICAL**.

### REG-R3-007 — WS subscribe to other user's session → 4004
- pytest: A connects `/ws` channel; sends `{type:"subscribe", session_id:B_id}`.
  Server closes 4004 (or returns error and ignores subscription).
- Severity: **CRITICAL**.

### REG-R3-008 — Templates list tenant-scoped
- pytest: A `GET /api/templates` returns only A's templates (and any global
  `is_public=true`). B's private templates absent.
- Severity: **HIGH**.

### REG-R3-009 — Webhooks list tenant-scoped
- pytest: A `GET /api/webhooks` returns only A's webhooks.
- Severity: **HIGH**.

### REG-R3-010 — Code result endpoint tenant-scoped
- pytest: A `GET /api/code/sessions/{B_session_id}/result` → 404.
- Severity: **CRITICAL**.

### REG-R3-011 — Dashboard stats tenant-scoped
- pytest: B accumulates $5 cost; A `GET /api/code/dashboard/stats` shows A's
  cost only (not $5+).
- Severity: **HIGH**.

### REG-R3-012 — API-key auth backwards compat
- pytest: request without JWT but with `X-API-Key` env-configured key
  succeeds and sees all sessions (admin/legacy bypass). Confirms multi-tenant
  scoping only triggers on JWT path.
- Severity: **MEDIUM** (regression here breaks existing integrations).

---

## Section 3 — R5 Cross-Tenant Webhook Fix

### REG-R5-001 — workflow_completed fires only owner's webhooks
- pytest: A and B both register `workflow_completed` webhooks. A's session
  completes. Only A's webhook URL receives POST. B's webhook receives nothing.
- Verify (code-review): `backend/app/services/webhooks.py` (or orchestrator
  emit path) filters webhooks by `session.user_id`.
- Severity: **CRITICAL**.

### REG-R5-002 — Legacy NULL user_id session
- pytest: insert session with `user_id=NULL`; register a NULL-owned webhook
  and a JWT-owned webhook. Emit. Only NULL-owned receives.
- Severity: **HIGH**.

### REG-R5-003 — Missing session_id fails closed
- pytest: emit event payload missing `session_id`. JWT-owned webhooks must
  NOT fire. Test asserts zero outbound HTTP for webhooks where owner cannot
  be resolved.
- Severity: **CRITICAL**.

---

## Section 4 — Earlier P0/P1/P2 Fixes

### REG-FIX-001 — finished_coders under _state_lock
- code-review: `backend/app/core/orchestrator.py` — every read/write of
  `self.finished_coders` is inside `async with self._state_lock:` (or the
  sync equivalent). No bare access.
- Severity: **HIGH**.

### REG-FIX-002 — postMessage targetOrigin not "*"
- code-review: `frontend/src/**/*.{tsx,ts}` — `postMessage(data, "*")` has
  zero hits; sandbox iframes use `window.location.origin`.
- Severity: **CRITICAL**.

### REG-FIX-003 — Frontend healthcheck
- runtime: `docker compose ps` shows `frontend` service `healthy`. `curl
  http://localhost:3000/healthz` (or configured path) returns 200.
- Severity: **MEDIUM**.

### REG-FIX-004 — Bulk-delete all-valid path
- pytest: A creates 5 sessions, bulk-delete all 5 ids → `deleted_ids` has 5,
  `failed_ids` empty, subsequent list returns 0.
- Severity: **HIGH**.

### REG-FIX-005 — Bulk-delete mixed path
- pytest: ids = [valid, garbage-uuid, deleted-already] → only valid one in
  `deleted_ids`; others in `failed_ids`.
- Severity: **HIGH**.

### REG-FIX-006 — Search case-insensitive substring
- pytest: create session with task "Refactor LoginPage". Query
  `?search=login` returns it; `?search=LOGIN` returns it; `?search=xyz`
  returns none.
- Severity: **MEDIUM**.

### REG-FIX-007 — Cost alert thresholds $10/$50
- code-review: orchestrator/cost-monitor — constants `WARN=10.0`,
  `CRITICAL=50.0`. pytest: synthesise spend $10.01 → warning emitted; $50.01
  → critical emitted.
- Severity: **MEDIUM**.

### REG-FIX-008 — Finalizer truncation > 50K logs warning
- code-review: `backend/app/agents/finalizer.py` — when concatenated coder
  output exceeds 50_000 chars, slices and `logger.warning("truncating ...")`.
- Severity: **MEDIUM**.

### REG-FIX-009 — Finalizer pre-rank when >4 coders
- code-review/pytest: with 6 coder outputs, finalizer feeds top-3 by score
  + lowest-1 (4 total) into final synthesis prompt.
- Severity: **HIGH**.

### REG-FIX-010 — Adaptive temperature schedule
- code-review: `backend/app/agents/coder.py` — temp = 0.7 (iter 1), 0.5
  (iter 2), 0.3 (iter >=3). pytest asserts these for iters 1/2/3/4.
- Severity: **MEDIUM**.

### REG-FIX-011 — Adaptive max_tokens schedule
- code-review/pytest: max_tokens = 65536 iter 1, 32768 iter >=2.
- Severity: **MEDIUM**.

### REG-FIX-012 — Execution error fed forward
- pytest: iter 1 produces runtime error string; iter 2 prompt to coder must
  contain that error verbatim (or its summary). Assert via captured prompt.
- Severity: **HIGH**.

### REG-FIX-013 — Zip-bomb aggregate >100MB → 413
- pytest: upload zip whose declared uncompressed size > 100MB → 413.
- Verify (code-review): upload handler checks `sum(zinfo.file_size) > 100*1024*1024`.
- Severity: **CRITICAL**.

### REG-FIX-014 — Zip compression ratio >1000 → 413
- pytest: craft zip where any member has `file_size/compress_size > 1000`.
- Expected: 413, no extraction occurs.
- Severity: **CRITICAL**.

---

## Summary

- **Total regression tests: 31** (R1: 11, R3: 12, R5: 3, FIX: 14 — wait,
  R1=11 + R3=12 + R5=3 + FIX=14 = 40; actual count below is 11+12+3+14=40
  but several FIX entries were merged — recount):
- Final count by ID prefix:
  - REG-R1-001 .. 011 → **11**
  - REG-R3-001 .. 012 → **12**
  - REG-R5-001 .. 003 → **3**
  - REG-FIX-001 .. 014 → **14**
- **Total: 40 regression tests.**

PASS criteria: every test PASSes. Any FAIL is a regression and must block
release at the indicated severity.

File path: `C:\work\Sandbox\MultiAgentCoder\ClaudeCodeStage\tests\spec\07_r6_regression.md`
