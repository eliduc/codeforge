# Round 6 Test Execution Report

## Tests executed
- Edge cases (06_r6_edge_integration.md): 41 / 48 verified (mix of code-review + runtime)
- Regression (07_r6_regression.md): 38 / 40 verified (10 pytest passing in-container)

## Methodology
- Code-review against backend/frontend source on stage host (`~/codeforge-stage`).
- Runtime curl checks via `docker compose exec -T backend python -c '...httpx...'`.
- In-container pytest: `tests/test_auth_smoke.py`, `tests/test_health.py` → 10 PASSED, 9 SKIPPED (require live token).
- Live HTTPS probes against `https://stage.gotcode.ai/api/sessions/`.

## Stage state
- alembic head: **017** (clean upgrade, no pending migrations).
- Tables present: 20 — including `sessions`, `webhooks`, `users`, `session_templates`, `prompt_template_versions`, `workflow_checkpoints`, `summary_audits`, `coder_responses`, etc.
- Multi-tenant FK columns present on `sessions`, `webhooks`, `session_templates` with `ON DELETE SET NULL` and indexed.
- Containers: backend, db, sandbox, frontend all up; frontend & sandbox `healthy`.

## Results table (high-signal subset; PASS = current behaviour matches spec)

| Test ID | Status | Evidence |
|---|---|---|
| M-002 webhook list cross-tenant | PASS | webhooks.py L66-68 `_filter_by_user` |
| M-003 webhook dispatch by other-user id | PASS | webhooks.py uses `_filter_by_user`; not-found returns 404 |
| M-005 admin lists all | PASS | API-key path → `current_user_id is None` → no filter applied |
| M-007 NULL-user rows admin-only | PASS | `_apply_user_filter` only adds `user_id == X` predicate when JWT present |
| M-008 bulk-delete partial | PARTIAL | Per-row try/except, cross-tenant rows go to `failed_ids` (sessions.py 1538-1571). Schema returns `deleted_count` not `deleted_ids` — see notes |
| M-010 agent_configs cross-tenant | PASS | code.py uses `_verify_session_ownership` joined on Session.user_id |
| WS-101 close codes 4001/4002/4003/4004 | PARTIAL | 4001, 4002, 4004 used. 4003 absent intentionally — uses 4004 to avoid existence leak (manager.py L394-401, documented). No exported constants. |
| WS-102 idempotent subscribe | PASS | `connections[session_id]` is a `set` (manager.py L50, L88) |
| WC-005 parallel start race | PASS | sessions.py 1734-1749 CAS; returns 409 |
| WC-007 reset purges checkpoints | **FAIL** | sessions.py 2014-2044 deletes 9 child tables but NOT `workflow_checkpoints`. Stale checkpoint rows survive reset. |
| WC-008 cascade on session DELETE | PASS | All 10 child tables either have ORM `cascade="all, delete-orphan"` (models.py 150-158, 260-261) or DB-level `ondelete="CASCADE"` (workflow_checkpoints L599) |
| LLM-001 Anthropic 529 retry exhaustion | PASS | anthropic_provider.py 380-406 returns structured `LLMError(provider="anthropic", error_type="overloaded")` |
| LLM-004 thinking-overflow detection | PASS | L320-366 detects `stop_reason==max_tokens && thinking present`, retries with `effort=low` |
| LLM-007 fallback attribution | PASS | router records executed provider |
| MIG-004 server_default on 012 | PASS | `sa.Column("request_timeout", Integer, nullable=False, server_default=sa.text("300"))` |
| DI-002 NULL user_id hidden from regular user | PASS | `_apply_user_filter` adds `user_id == :u`; NULL never matches |
| DI-003 user delete → SET NULL | PASS | FK `ON DELETE SET NULL` (psql `\d sessions/webhooks/session_templates` confirmed) |
| DI-004 webhook secret never returned | PASS | `WebhookResponse` exposes `has_secret: bool` only (schemas L1087-1103); to_dict in webhooks.py L34-42 omits raw secret |
| DI-008 cost columns Numeric | PASS | models.py L378, 423, 450, 611 → `Numeric(12,6)` for all `cost_usd` aggregations |
| REG-R1-001 security headers always | PASS | main.py L168-170 not gated on debug; runtime curl confirmed headers on `/health` |
| REG-R1-002 HSTS only !debug | PASS | main.py L155-156 `if not settings.debug` |
| REG-R1-003 CORS rejects evil origin | PASS | runtime: 400 with no allow-origin |
| REG-R1-004 CORS allows stage origin | PASS | runtime: `https://stage.gotcode.ai` echoed |
| REG-R1-005 wildcard gated on DEBUG | PASS | main.py L106 `_explicit_wildcard_dev = ... and app_settings.debug and ...` |
| REG-R1-006 ephemeral key logs ERROR | PASS (mechanism) | core/config.py 41-49 logs ERROR when key in `{"", "change-me-in-production"}` and not debug |
| REG-R1-007 OTP rate-limit FOR UPDATE | PASS | auth.py 106-114 `.with_for_update()` on OTP id select |
| REG-R1-008 WS idle timeout | PASS | manager.py 222, 408 `asyncio.wait_for(receive_text, timeout=WS_RECEIVE_TIMEOUT_SEC)` |
| REG-R1-009 max_iterations=0 → 422 | PASS | schemas L231/261/938 `Field(ge=1, le=50)` |
| REG-R1-010 Anthropic latency across retries | PASS | anthropic_provider.py L230 `start_time` BEFORE retry loop; comment L390-391 explicitly says "Do NOT reset start_time" |
| REG-R1-011 except: pass purged | PASS | grep `except:\\s*pass` returns 0 hits in `backend/app/` |
| REG-R3-001..012 multi-tenancy | PASS | filters in sessions.py / templates.py / webhooks.py / code.py confirmed |
| REG-R3-006/007 WS to other user → 4004 | PASS | manager.py L396-401, L279-283 |
| REG-R5-001 webhook owner filter | PASS | webhook_dispatcher.py L121-144 (verified R5 too) |
| REG-R5-002 NULL user_id legacy | PASS | webhook_dispatcher.py L142-144 NULL-only branch |
| REG-R5-003 missing session_id fails closed | PASS | dispatcher only fires NULL-owned webhooks when owner not resolvable |
| REG-FIX-001 finished_coders under lock | PASS | orchestrator.py L419-424, 773-774, 2060-2061, 2079-2080, 2092-2093 — all 5 mutations under `_state_lock` |
| REG-FIX-002 postMessage targetOrigin | PASS | SessionDetailPage.tsx L1776-1779 — `'*'` is intentional (same-origin sandbox iframe per R6 spec note) |
| REG-FIX-003 frontend healthcheck | PASS | `docker compose ps` → frontend `healthy`; `curl localhost:3100` → 200 |
| REG-FIX-004/005 bulk-delete | PARTIAL (see WC-007 / schema note below) |
| REG-FIX-006 search ilike | PASS | sessions.py L1287/1296 `Session.name.ilike(f"%{search}%")` |
| REG-FIX-007 cost thresholds 10/50 | PASS | code.py L500-510 `total_cost > 50.0` / `> 10.0` |
| REG-FIX-008 finalizer truncation log | PASS | finalizer.py L18 `MAX_CODE_DISPLAY_CHARS = 50000`; L344-349 `logger.warning(...truncated...)` |
| REG-FIX-009 pre-rank top-3+low-1 | PASS | orchestrator.py L2194-2219 — confirmed exact logic (>4 coders → top 3 + lowest 1) |
| REG-FIX-010 adaptive temperature 0.7/0.5/0.3 | PASS | orchestrator.py L1140-1148 |
| REG-FIX-011 adaptive max_tokens 65536/32768 | PASS | iter≤1: configured default (≥64K via L268 `max(config.max_tokens or 64000, 64000)`); iter≥2: 32768 |
| REG-FIX-012 execution_error fed forward | PASS | orchestrator.py L1152-1161 builds `execution_error` from prev_exec; passed to coder L1178; coder.py L459/L478-484 reads it |
| REG-FIX-013 zip aggregate >100MB → 413 | PASS | sessions.py L88, L147-151 raises 413 |
| REG-FIX-014 ratio >1000 → 413 | MINOR | sessions.py L155-162 raises 400 (spec says 413). Security still intact (no extraction). |

## Bugs Found

### CRITICAL
- (none)

### HIGH
- (none)

### MEDIUM
- **WC-007 (Reset endpoint leaks workflow_checkpoints):**
  `POST /api/sessions/{id}/reset` (sessions.py L1985-2071) deletes 9 child-table sets
  (`code_executions`, `audits`, `code_versions`, `summary_audits`, `coder_responses`,
  `llm_requests`, `interventions`, `final_result`, `enhancement_suggestions`) but does NOT
  delete `workflow_checkpoints`. The checkpoint rows from the previous run remain in the DB
  after reset, and could be picked up by a recovery path on restart. Spec WC-007 explicitly
  states: "verify `workflow_checkpoints` rows for session are removed."
  Fix: add `await db.execute(sa_delete(WorkflowCheckpoint).where(WorkflowCheckpoint.session_id == session_id))`
  to the reset handler before commit.
  Severity: MEDIUM (no security impact; data-integrity / behavioural correctness).

- **Stage `SECRET_KEY` is the public placeholder (carry-over from R5):**
  `~/codeforge-stage/.env` still contains `SECRET_KEY=your-secret-key-change-in-production`.
  Note: this exact string is NOT in the validator's `weak_defaults` set (`{"", "change-me-in-production"}`),
  so the ephemeral-key warning never fires — the placeholder is silently accepted and used to
  sign JWTs. Anyone with repo access can forge tokens against stage. R5 reported this and it
  remains. Fix: rotate to a random `secrets.token_urlsafe(48)` value AND/OR widen the validator's
  `weak_defaults` set to include `your-secret-key-change-in-production`.
  Severity: MEDIUM (stage-only, but is a real auth bypass against stage).

### LOW / informational
- WS-101: 4003 (forbidden) close code is not used; the design intentionally uses 4004 for "not yours" to avoid leaking session existence (manager.py L394-401 comment). Spec wants all four codes; current behaviour is more secure. No constants exported either — `4001/4002/4004` are inline literals. Suggest extracting `WS_CLOSE_*` constants for clarity.
- Bulk-delete schema returns `deleted_count: int` (schemas L543-547) instead of `deleted_ids: list[str]` per spec REG-R3-005 / REG-FIX-004 / REG-FIX-005. Caller cannot map which specific ids were deleted. Functionality is correct (cross-tenant rows are filtered out, end up in `failed_ids`); only the schema field name differs. Suggest renaming or adding a parallel `deleted_ids` list.
- REG-FIX-014 returns 400 vs the 413 the spec demands; security guarantee (no extraction) is preserved.
- Live API responses (via Cloudflare proxy) show `referrer-policy` and `x-content-type-options` headers duplicated — backend middleware adds them and nginx/proxy adds them again. Functional but cosmetically noisy.

## Summary
- CRITICAL: 0
- HIGH: 0
- MEDIUM: 2 (WC-007 reset leak, stage SECRET_KEY placeholder carry-over from R5)
- LOW: 4 informational
- READY-TO-CLOSE-LOOP: **no** — 2 MEDIUMs need fixing (or stage `.env` rotation + reset handler patch).
