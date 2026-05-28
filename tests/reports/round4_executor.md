# Round 4 Test Execution Report

## Round 3 fix verification

### Multi-tenancy schema: PASS
- `sessions.user_id` (UUID, nullable, FK -> users.id ON DELETE SET NULL, indexed) — present
- `webhooks.user_id` (UUID, nullable, FK, indexed) — present
- `session_templates.user_id` (UUID, nullable, FK, indexed) — present
- alembic head = `017` — applied

### Multi-tenancy enforcement (per route)

| File / Endpoint                                              | Filter | Status |
|--------------------------------------------------------------|--------|--------|
| sessions.py — list/get/create/update/delete (incl. bulk)     | `_apply_user_filter` on Session | PASS |
| sessions.py — start/pause/resume/cancel/reset/re-finalize    | `_apply_user_filter` | PASS |
| sessions.py — copy / copy-structure / complete / checkpoints | `_apply_user_filter` | PASS |
| sessions.py — agents (list/create/update/delete)             | `_apply_user_filter` on parent | PASS |
| sessions.py — enhance / suggestions / apply-enhancements     | `_apply_user_filter` on parent | PASS |
| sessions.py — download-zip, git/commits, git/diff, export    | `_apply_user_filter` | PASS |
| sessions.py — import (per-row check on duplicates), creates with `user_id=current_user_id` | PASS |
| code.py — code/audits/summaries/responses/result/llm-requests/metrics/interventions/intervene | `_verify_session_ownership` or join Session.user_id | PASS |
| code.py — `/dashboard/stats` — sessions, cost, daily, top providers/models | All 6 sub-queries gated by `Session.user_id` / subquery | PASS |
| code.py — `get_code_version`, `get_audit` (direct ID lookup) | join Session and filter by user_id | PASS |
| webhooks.py — list/create/update/delete/test                 | `_filter_by_user` (user_id == current) | PASS |
| templates.py — list/create/get/update/delete/apply/from-session | `_filter_template_by_user` + `_filter_session_by_user` | PASS |
| websocket/manager.py — `/ws/{session_id}` connect            | JWT -> `Session.user_id` check, 4004 close on mismatch | PASS |
| websocket/manager.py — `/ws` global subscribe action          | Same ownership check inside `subscribe` handler | PASS |

### Zip-bomb fix: PASS
`MAX_TOTAL_UNCOMPRESSED_BYTES = 100 MiB` and `MAX_COMPRESSION_RATIO = 1000` defined (sessions.py:88-89). Both zip and tar branches (lines 145-151 and 191-197) accumulate `total_bytes` across ALL entries (not just text) and raise `HTTPException(413)` when exceeded. Zip branch additionally checks per-entry compression ratio (lines 152-162) and raises 400. The `try/except HTTPException: raise` (line 215) ensures rejections propagate cleanly past the generic catch-all.

### WebSocket ownership: PASS
- `/ws/{session_id}`: JWT user verified against `Session.user_id`; missing-OR-foreign session both close with 4004 (no existence leak).
- `/ws` (global) `subscribe`: same ownership probe inside the subscribe handler before adding the connection. API-key callers (no `sub` claim) keep full access intentionally for backwards compat.
- `send_to_session` only delivers to connections that successfully subscribed, so per-session messages are tenant-isolated.

## Regressions
- Smoke tests: **10 passed, 1 skipped, 0 failed** (`tests/test_health.py`, `tests/test_auth_smoke.py`).
  - Note: tests live at `/app/tests/...` not `/app/backend/tests/...` — the runbook command path is wrong, but the tests run and pass.
- Live app probe: `/health` 200, `/api/sessions/` (no auth) 401, CORS valid origin 200 with ACAO=`https://stage.gotcode.ai`, CORS evil origin 400 / no ACAO, `X-Frame-Options: DENY` present.

## NEW Bugs Found

### CRITICAL

#### C1. Cross-tenant webhook dispatch leak — `webhook_dispatcher.dispatch_event`
**File:** `backend/app/services/webhook_dispatcher.py` lines 119-123.
```python
result = await db.execute(
    select(Webhook).where(Webhook.enabled == True)
)
```
The query selects EVERY enabled webhook in the database regardless of owner. The orchestrator (`core/orchestrator.py:551-581`) emits `workflow_completed` / `workflow_error` / `workflow_cancelled` / `awaiting_enhancement` for user A's session, and `dispatch_event` then fires those to **every user's** Slack/Discord/HMAC endpoints. Payload includes `session_id` and `session_name` — i.e., user B receives a notification (and Slack card) revealing user A's private session name. This is exactly the cross-tenant leak the runbook flagged as "likely". **Severity: CRITICAL** (PII leak via attacker-registered webhook + unauthorized notification spam).

**Fix:** Look up `Session.user_id` from the `session_id` in `data`, then add `Webhook.user_id == session_owner_id` to the where clause (skip filter only when owner is NULL, for backwards compat with pre-migration rows). Test: register two webhooks under different users; trigger workflow on user A's session; assert only user A's webhook is hit.

### HIGH
None.

### MEDIUM

#### M1. `Intervention` table has no `user_id`
`backend/app/db/models.py` Intervention is filtered transitively via `Session.id` only. Functionally OK today (route always joins), but if a future endpoint queries Interventions directly without joining, it would leak. Low impact, easy hardening.

#### M2. `LLMRequest` direct queries rely on caller adding session-subquery
`code.py:get_dashboard_stats` correctly applies `LLMRequest.session_id.in_(user_session_ids)` on every aggregate. No bug today, but the model lacks denormalized `user_id`, so any new aggregate that forgets the subquery will leak cost data. Consider adding `user_id` (denorm) for defense-in-depth.

#### M3. Smoke-test path in runbook is stale
`backend/tests/test_health.py` doesn't exist inside the container — they're at `tests/...`. Runbook should be updated to `tests/test_health.py tests/test_auth_smoke.py`. Not a code bug.

## Summary
- Total NEW bugs found: **4** (1 CRITICAL, 0 HIGH, 3 MEDIUM)
- CRITICAL: 1
- HIGH: 0
- MEDIUM: 3
- READY-TO-CLOSE-LOOP: **no** (1 critical open)
