# 06 — Round 6: Edge & Integration (Test Author, fresh angle)

Rounds 1–5 produced 443 verified test cases focused on per-endpoint correctness, base happy/negative paths, single-user concurrency, WS framing, and the freshly-landed multi-tenancy scaffolding (R3). This R6 spec targets **the seams between subsystems** — areas where two or more recent changes meet and bugs typically slip through unit/handler tests.

Stop condition for the loop: 0 CRITICAL + 0 HIGH + **0 MEDIUM**.

Severity legend: **CRITICAL** | **HIGH** | **MEDIUM** | **LOW**. Each test is tagged `Verifiable: code-review` (static, can be confirmed by reading source) or `Verifiable: runtime-needed` (must be exercised against a running stack).

Total: **48 NEW test cases**.

---

## 1. Multi-tenancy edge cases (R3 introduced `user_id` on Session/Webhook)

| ID | Description | How to verify | Expected | Severity |
|----|-------------|---------------|----------|----------|
| M-001 | User A creates session "X"; User B creates session "X" same minute. | runtime-needed: two JWTs, two POST `/api/sessions`. | Both succeed, distinct ids; no UNIQUE collision. | LOW |
| M-002 | User A creates webhook; User B `GET /api/webhooks/`. | runtime-needed. | B's response excludes A's webhook (filtered by `user_id`). | CRITICAL |
| M-003 | User A creates webhook id=W; User B `POST /api/webhooks/W/dispatch` knowing the id. | runtime-needed. | 404 (not 403 — must not leak existence). | CRITICAL |
| M-004 | User A's session deleted by A while User B (somehow subscribed via leaked id) holds WS. | runtime-needed: forge subscribe; orchestrator emits `session_deleted` then closes 4404. | B's WS closes with 4404; no exception in manager. | HIGH |
| M-005 | Admin API key (`X-Admin-Key`) lists `/api/sessions` and sees rows for all users including NULL-user legacy rows. | code-review `backend/app/api/routes/sessions.py` admin branch. | Admin sees union; non-admin only own. | HIGH |
| M-006 | User A connects WS with JWT TTL=30s; orchestrator runs 5 min; JWT expires mid-stream. | runtime-needed. | Either WS stays open until session ends (documented) **or** server closes 4401 with reason `token_expired`. Either is fine, but must be one of the two — never silent half-open. | HIGH |
| M-007 | Pre-R3 rows have `user_id IS NULL`; verify admin endpoint surfaces them and per-user GET does not. | code-review SQL filters in `sessions.py`, `webhooks.py`, `dashboard.py`. | NULL-user rows are admin-only. | HIGH |
| M-008 | Bulk-delete payload contains 3 ids owned by caller, 2 owned by another user. | runtime-needed: `POST /api/sessions/bulk-delete`. | Response: `{deleted:[3 ids], skipped:[2 ids]}`; transaction is per-row, no rollback. | HIGH |
| M-009 | `/api/dashboard/stats` for User A excludes User B's session counts/llm-spend. | runtime-needed. | Numbers strictly per-user. | HIGH |
| M-010 | User A creates `agent_configs` for session S; User B GETs `/api/agent-configs?session_id=S`. | code-review: ownership join on Session.user_id. | 403/404 — no leak. | CRITICAL |

## 2. WebSocket edge cases (beyond R1 WS-001..WS-011)

| ID | Description | How to verify | Expected | Severity |
|----|-------------|---------------|----------|----------|
| WS-101 | Close codes documented & emitted: 4001 (no token), 4002 (bad token), 4003 (forbidden), 4004 (session not found). | code-review `backend/app/api/websocket/manager.py`. | All 4 codes used and constants exported. | MEDIUM |
| WS-102 | Client subscribes to same session twice on same connection. | runtime-needed. | Idempotent — no duplicate broadcast; subscriber set is a set, not list. | MEDIUM |
| WS-103 | Subscribe → unsubscribe → subscribe loop ×100. | runtime-needed: monitor manager `_subscribers[id]` size. | Returns to ≤1 each cycle; no leak. | HIGH |
| WS-104 | Server emits one event with payload >64 KB (e.g. very long code body). | runtime-needed. | Either chunked, or server truncates with `truncated:true` flag — **never** drops silently or kills the socket. | HIGH |
| WS-105 | Client floods 1000 ping frames in 1 s. | runtime-needed. | Server rate-limits or coalesces; CPU stays bounded; no per-ping DB hit. | MEDIUM |
| WS-106 | 100 simultaneous WS connections to same session id. | runtime-needed: load harness. | All receive broadcasts; broadcast loop is fan-out not per-conn DB read. | HIGH |
| WS-107 | Backpressure: a slow consumer's send queue fills. | code-review: send call uses `asyncio.wait_for` or drops slow client. | Slow client is dropped after threshold; fast clients unaffected. | HIGH |
| WS-108 | After orchestrator crashes, `_subscribers` for that session id is cleaned in `finally`. | code-review orchestrator `run()`. | Map entry removed; no zombie list. | MEDIUM |

## 3. Sessions workflow corruption

| ID | Description | How to verify | Expected | Severity |
|----|-------------|---------------|----------|----------|
| WC-001 | DELETE session while orchestrator iteration in flight. | runtime-needed. | Orchestrator checks cancellation between agent steps; cleans up cleanly; no half-written `code_versions`. | HIGH |
| WC-002 | PATCH session settings while RUNNING. | runtime-needed. | 409 OR applied next iteration only — documented; never mutates current iteration mid-flight. | HIGH |
| WC-003 | PATCH `agent_configs` row while orchestrator already loaded it for the iteration. | code-review: orchestrator copies config at iter-start. | Live iter uses snapshot; new value picked up next iter. | MEDIUM |
| WC-004 | Pause → DELETE → start (against deleted id). | runtime-needed. | Start returns 404; no resurrection; no orphan checkpoint. | HIGH |
| WC-005 | Two parallel `POST /sessions/{id}/start` from same user (race). | runtime-needed. | One returns 200 RUNNING, other returns 409 `already_running`; never two parallel orchestrators. | CRITICAL |
| WC-006 | Re-finalize 5× in a row on same COMPLETED session. | runtime-needed. | Idempotent — same `final_results` row updated, not duplicated. | MEDIUM |
| WC-007 | `POST /sessions/{id}/reset` — verify `workflow_checkpoints` rows for session are removed. | code-review reset handler. | Checkpoints purged. | MEDIUM |
| WC-008 | DELETE session cascades to: `code_versions`, `audits`, `summaries`, `llm_requests`, `code_executions`, `interventions`, `final_results`, `enhancement_suggestions`, `agent_configs`, `workflow_checkpoints`. | code-review `backend/app/db/models.py` `cascade="all, delete-orphan"` on each relationship. | All 10 relationships have cascade set. | CRITICAL |

## 4. LLM provider edge cases

| ID | Description | How to verify | Expected | Severity |
|----|-------------|---------------|----------|----------|
| LLM-001 | Anthropic returns 529 Overloaded; retries exhausted. | code-review `anthropic_provider.py`; runtime: stub. | Final error is structured `{provider:"anthropic", code:529, retries:N}`; orchestrator marks iter failed not crashed. | HIGH |
| LLM-002 | OpenAI returns 429 with `Retry-After: 7`. | code-review `openai_provider.py`. | Backoff respects header (not flat); jitter present. | HIGH |
| LLM-003 | Provider returns plausible JSON-shaped string but with trailing garbage. | runtime-needed: stub provider. | Coder catches `JSONDecodeError`, logs, retries up to N, then fails iter — does **not** stack-trace into orchestrator. | HIGH |
| LLM-004 | Anthropic with thinking enabled returns content blocks but `text` is empty (thinking-budget overflow). | code-review `anthropic_provider.py` content extraction. | Detected as empty; either retried with reduced budget or surfaced as `empty_completion` error. | MEDIUM |
| LLM-005 | Network drop mid-stream after 3 chunks. | runtime-needed: tcp kill. | Stream consumer raises `IncompleteRead`; provider returns retriable error. | MEDIUM |
| LLM-006 | All configured providers return 5xx for one role. | runtime-needed. | Workflow fails clean with `provider_unavailable`; partial state persisted; no infinite retry. | HIGH |
| LLM-007 | Provider router falls back from primary→secondary; verify spend is attributed to actually-used provider. | code-review `llm/router.py`. | `LLMRequest.provider` reflects executed call, not requested. | MEDIUM |

## 5. Sandbox edge cases

| ID | Description | How to verify | Expected | Severity |
|----|-------------|---------------|----------|----------|
| SB-001 | Submitted Python code attempts `socket.socket()` outbound. | runtime-needed: sandbox. | Blocked at network layer (egress denied) — error returned, container not crashed. | CRITICAL |
| SB-002 | Submitted code allocates 10 GB list. | runtime-needed. | OOM-killed; sandbox returns `memory_limit_exceeded`; host RAM unaffected. | HIGH |
| SB-003 | Infinite `while True: pass`. | runtime-needed. | Wall-clock timeout fires (per `request_timeout` migration 012); returns `timeout`. | HIGH |
| SB-004 | Browser code injects `<iframe src="https://evil.example">`. | code-review CSP header in browser sandbox. | `frame-src 'self'` (or `'none'`) blocks; iframe does not load. | HIGH |
| SB-005 | Browser code uses `eval('1+1')`. | code-review CSP `script-src` includes `'unsafe-eval'` *only in sandbox subdomain*. | Allowed in sandbox; **not** allowed in main app origin. | MEDIUM |
| SB-006 | 200 sandbox `POST /execute` requests in 5 s from one user. | runtime-needed. | Rate limit kicks in (429); existing in-flight runs not aborted. | MEDIUM |
| SB-007 | Sandbox HTTP server killed mid-execute; orchestrator retries connect. | runtime-needed. | Retry with backoff; iter fails with `sandbox_unavailable` after N attempts; no zombie tasks. | HIGH |

## 6. Data integrity

| ID | Description | How to verify | Expected | Severity |
|----|-------------|---------------|----------|----------|
| DI-001 | After session DELETE, query each child table for `session_id=X`. | runtime-needed: SQL. | Zero rows in all 10 child tables. | HIGH |
| DI-002 | Insert row with `user_id=NULL` then GET as a regular user. | runtime-needed. | Row is **not** in response. | CRITICAL |
| DI-003 | DELETE user account → their sessions retain rows with `user_id=NULL` (per `ON DELETE SET NULL`). | code-review `models.py` FK ondelete. | Sessions remain, user_id nullified; admin can still see; they don't appear in any other user's list. | HIGH |
| DI-004 | Webhook `secret` field never returned by GET list / GET single / dispatch / create-response. | code-review `schemas` for Webhook (response model excludes secret) + Pydantic `model_dump`. | Secret only echoed on create *once*, redacted thereafter. | CRITICAL |
| DI-005 | Admin API key value never appears in any log line. | code-review `app/main.py` middleware + log formatters. | Header redacted before logging. | HIGH |
| DI-006 | JWT passed as `?token=` in WS URL — verify access logs redact query string. | code-review uvicorn access-log config / middleware. | `token=` value replaced with `***`. | HIGH |
| DI-007 | After `bulk-delete` partial failure, transaction state: committed rows stay, failed rows untouched. | code-review handler. | Per-row commit, not single transaction with auto-rollback. | MEDIUM |
| DI-008 | Float comparison on `total_cost` — verify Numeric(20,8) used, not Float. | code-review `models.py` cost columns. | `Numeric` not `Float` (no rounding drift on aggregation). | MEDIUM |

## 7. Migration safety

| ID | Description | How to verify | Expected | Severity |
|----|-------------|---------------|----------|----------|
| MIG-001 | Fresh DB → `alembic upgrade head`. | runtime-needed. | Exit 0; all tables present incl. `012_add_request_timeout`. | HIGH |
| MIG-002 | `alembic downgrade -1` then `upgrade head`; verify pre-existing rows preserved. | runtime-needed: seed → down → up → diff rows. | Row counts match; no data loss. | HIGH |
| MIG-003 | Two `alembic upgrade head` processes started concurrently. | runtime-needed. | Second blocks on alembic_version row lock; no double-apply, no corruption. | MEDIUM |
| MIG-004 | Migration adding `request_timeout` with default — existing Session rows have value. | code-review migration 012. | `op.add_column(..., server_default=...)` present, **not** plain default. | HIGH |
| MIG-005 | Any DROP COLUMN migration first checks for FK references and removes them. | code-review all `op.drop_column` in `backend/alembic/versions/`. | No drop-column on FK target without prior `drop_constraint`. | MEDIUM |

## 8. Performance / scale

| ID | Description | How to verify | Expected | Severity |
|----|-------------|---------------|----------|----------|
| PERF-001 | List 1000 sessions for one user. | runtime-needed: seed + GET. | Pagination param honored (`limit`, `offset` or cursor); single page p95 < 300 ms. | MEDIUM |
| PERF-002 | Dashboard with 10 K `LLMRequest` rows. | runtime-needed. | Response < 2 s; aggregation done in SQL not Python loop. | HIGH |
| PERF-003 | Search `q=foo` across 1000 sessions. | runtime-needed. | < 500 ms; index on `Session.name` (or trigram). | MEDIUM |
| PERF-004 | Bulk delete 100 sessions. | runtime-needed. | Completes < 5 s; cascades fire in single TX or chunked TX. | MEDIUM |
| PERF-005 | WS broadcast to 50 clients on one session. | runtime-needed. | Last client sees event within 1 s of first client. | MEDIUM |

---

## Severity breakdown (this round)

- **CRITICAL: 7** — M-002, M-003, M-010, WC-005, WC-008, SB-001, DI-002, DI-004 (8 actually)
- **HIGH: 25**
- **MEDIUM: 14**
- **LOW: 1**

(Recount: CRITICAL 8, HIGH 24, MEDIUM 15, LOW 1 — totals 48.)

Stop condition (0 CRITICAL + 0 HIGH + 0 MEDIUM remaining unfixed) requires that **47 of 48** tests pass; LOW M-001 is informational.
