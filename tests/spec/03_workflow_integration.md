# 03 — Workflow & Integration Test Spec (Team 1C)

Scope: workflow state machine (`backend/app/core/orchestrator.py`), agent algorithms, concurrency, LLM providers, sandbox, cost/metrics, DB consistency, recovery, perf baselines.

Conventions:
- "DB invariants" = SQL assertions after the trigger settles.
- "Side effects" = WS frames on `/ws/sessions/{id}` and webhook deliveries.
- "Phase" refers to `WorkflowPhase` enum.

---

## 1. Workflow State Machine

### WF-001 — Happy path, 2 coders, 5 iters
- Initial: new session, status=PENDING, agent_configs has 2 coders, 4 testers, max_iterations=5.
- Trigger: POST `/sessions/{id}/start`.
- End: phase=COMPLETED, session.status=COMPLETED.
- DB: `code_versions` has rows for each (coder_index, iteration) up to finish; `final_results` row exists; every coder has `coder_finish_reasons` set ("no_issues" or "max_iterations"); `summaries` row per coder per iter.
- Side effects: WS frames in order `phase_change(initializing→coding→executing→testing→summarizing→reviewing→…→finalizing→completed)`; one `final_result` frame; webhook `session.completed` fires.

### WF-002 — One coder fails, other survives → finalizer picks survivor
- Initial: 2 coders. Force coder_index=0 to throw on iter 1 (stub LLM).
- Trigger: start.
- End: status=COMPLETED. Final result references coder_index=1.
- DB: `coder_finish_reasons[0]="error"`, `final_results.selected_coder_index=1`.
- Side effects: `agent_error` WS frame for coder 0; no webhook fail.

### WF-003 — All coders fail → workflow_error
- Initial: 2 coders, both stubbed to raise.
- End: status=FAILED, `state.failed=True`, `state.error` populated.
- DB: no `final_results` row; session.error_message non-null.
- Side effects: `workflow_error` WS frame; webhook `session.failed` fires.

### WF-004 — User cancels mid-iteration → CANCELLED
- Initial: workflow in TESTING phase.
- Trigger: POST `/sessions/{id}/stop`.
- End: status=CANCELLED, `should_stop=True`, in-flight tasks cancelled cleanly.
- DB: session.status=CANCELLED, no orphan locks held.
- Side effects: `phase_change(failed_or_cancelled)` WS; no `session.completed` webhook.

### WF-005 — Pause then resume
- Initial: phase=CODING.
- Trigger: POST `/sessions/{id}/pause` then `/resume`.
- End: status transitions RUNNING→PAUSED→RUNNING; iteration counter does not reset; previously-finished coders stay in `finished_coders`.
- DB: checkpoint row written on pause; on resume, work continues from same iter.

### WF-006 — Reset cleans up state
- Initial: COMPLETED session.
- Trigger: POST `/sessions/{id}/reset`.
- End: session.status=PENDING; `code_versions`, `audits`, `summaries`, `final_results`, `llm_requests`, `checkpoints` for that session deleted; agent_configs preserved.

### WF-007 — Re-finalize without re-coding
- Initial: COMPLETED session with code_versions intact.
- Trigger: POST `/sessions/{id}/finalize` (re-run finalizer only).
- End: new `final_results` row replaces old; no new `code_versions` written; `llm_requests` only for finalizer agent.

### WF-008 — Auto-finish at 0 critical / 0 serious
- Initial: tester audits all return zero critical and zero serious.
- End: `coder_finish_reasons[i]="no_issues"` for every coder before reaching max_iterations; phase advances to FINALIZING.

### WF-009 — Force-finish at max_iterations
- Initial: max_iterations=2, audits always return ≥1 critical issue.
- End: at iter 2 completion, all coders forced into `finished_coders` with `coder_finish_reasons[i]="max_iterations"`.

### WF-010 — Per-agent timeout exceeded
- Initial: agent stub sleeps longer than `request_timeout` (see migration 012).
- End: that agent's coroutine cancelled; `AgentResult.error="timeout"`; workflow continues with remaining agents (if any).
- DB: `llm_requests` row marked failed with timeout reason.

### WF-011 — max_iterations=1 (smallest valid)
- Initial: max_iterations=1.
- End: exactly one coding pass per coder, then finalize. `coder_iterations[i]==1`.

### WF-012 — Single coder session
- Initial: 1 coder, 4 testers, max_iterations=3.
- End: finalizer runs without ranking branch; `final_results.selected_coder_index=0`; no pre-rank invoked.

---

## 2. Agent Behavior

### AG-001 — Coder generates valid code
Stub LLM returns Python function; sandbox executes successfully; `code_versions.status=PASSED_EXECUTION`.

### AG-002 — Coder receives execution_error from prior iter
Iter 1 execution fails. Iter 2 prompt MUST include the prior `execution_error` text. Assert prompt body contains the stderr substring.

### AG-003 — Tester returns valid JSON
Tester output parses to `Audit` with `issues` list; each issue has severity in {critical, serious, minor}. Reject if any unknown severity.

### AG-004 — Summarizer aggregates ≥2 tester audits
Given 4 audits, summarizer dedupes overlapping issues (by hash of description); `SummaryAudit.issues` count ≤ sum(audit.issues).

### AG-005 — Finalizer picks highest-scored coder
Coders score: [7.2, 8.5, 6.0]. `final_results.selected_coder_index=1`.

### AG-006 — Finalizer with truncated code (>50K chars)
Coder code length 60_000. Finalizer prompt includes truncation marker; `final_results.warnings` contains "code_truncated".

### AG-007 — Pre-rank when >4 coders
6 coders. Pre-rank reduces to top-3 + lowest-1 = 4 candidates passed to finalizer ranker. Asserts which indices are filtered.

### AG-008 — Adaptive temperature
Iter 1 temperature=0.7, iter 2=0.5, iter ≥3=0.3. Inspect `llm_requests.temperature` per iter.

---

## 3. Concurrency & Race Conditions

### CR-001 — 2 coders run in parallel
Both finish; no interleaved writes to `state.code_versions`; both rows written.

### CR-002 — 4 testers in parallel
Per-coder, 4 testers spawned via `asyncio.gather`. All audits land; no missing rows.

### CR-003 — WS event order under load
Inject 100 events rapidly; client receives them in monotonically increasing `seq`.

### CR-004 — DB lock contention
Two concurrent `INSERT` on `code_versions` with same (session,coder,iter) → exactly one wins, other raises `IntegrityError` and is logged.

### CR-005 — `finished_coders` mutation safety
20 concurrent calls to mark coders finished under `_state_lock`; final set size = unique inputs.

### CR-006 — Checkpoint save non-blocking
Checkpoint write runs concurrently with iteration; iteration latency increase < 50 ms.

---

## 4. LLM Provider Integration

### LLM-001 — Anthropic Sonnet adaptive thinking
Configured with thinking enabled; `llm_requests.thinking_tokens > 0`; budget within configured cap.

### LLM-002 — Anthropic Opus thinking_effort=max
Request sets `thinking.budget_tokens=max`; response captures full reasoning; cost reflects extended budget.

### LLM-003 — OpenAI gpt-5
Round-trip succeeds; `llm_requests.model="gpt-5"`; usage recorded.

### LLM-004 — Ollama local model
If Ollama reachable, `llama3` echoes prompt; `llm_requests.cost=0.0`; no remote calls.

### LLM-005 — 529 retry & latency continuity
First call returns 529, retry succeeds. `llm_requests.latency_ms` reflects total wall time including retry (start_time NOT reset).

---

## 5. Sandbox Correctness

### SB-001 — Browser HTML+JS validated headless Chromium
Run produces console output; no uncaught errors → `ExecutionResult.success=True`.

### SB-002 — Python with timeout
Code with `time.sleep(60)`, timeout=5s → result.timeout=True.

### SB-003 — Auto-install deps
Code imports `requests` not preinstalled → installer runs; second run skips (cached).

### SB-004 — Sandbox crash recovery
Kill sandbox container mid-exec → orchestrator retries once, then surfaces `execution_error`; workflow not aborted.

### SB-005 — Output truncation
stdout > MAX_OUTPUT_BYTES → result.stdout truncated with marker; `truncated=True`.

---

## 6. Cost & Metrics

### CM-001 — LLMRequest token tracking
Sum of `prompt_tokens+completion_tokens` matches provider response.

### CM-002 — Total cost across providers
Mix Anthropic + OpenAI in one session; `session.total_cost` = sum of per-request costs (±$0.0001).

### CM-003 — Dashboard 7/30/90-day aggregation
Insert dated rows; `/dashboard/stats?range=7d|30d|90d` returns correct counts.

### CM-004 — Cost alert thresholds
Set thresholds $5/$10/$50; crossing each emits one alert event (no duplicates).

### CM-005 — Per-provider/per-model breakdowns
`/dashboard/breakdown` totals match SQL `GROUP BY provider, model`.

---

## 7. Database Consistency

### DB-001 — Cascade delete
DELETE session → `code_versions, audits, summaries, llm_requests, checkpoints, final_results, interventions, code_executions` rows for that session removed. Verify with COUNT=0 each.

### DB-002 — Webhook HMAC matches
Compute `hmac_sha256(secret, body)` server-side equals `X-CodeForge-Signature` header.

### DB-003 — Migrations idempotent
`alembic upgrade head` twice → no error; schema unchanged on second run.

### DB-004 — Unique constraint (session, coder_index, iteration)
Second insert of same triple raises IntegrityError.

### DB-005 — FK enforcement
Insert audit with bogus `code_version_id` rejected.

### DB-006 — JSON round-trip
Set `agent_configs={...nested...}`, fetch, deep-equal.

### DB-007 — Session template copy preserves agent_configs
POST `/sessions/from-template/{id}` → new session has identical `agent_configs` shape.

### DB-008 — Prompt template versions snapshot
Update prompt → previous content stored in `prompt_template_versions` with old `version` and timestamp.

---

## 8. Recovery Scenarios

### RC-001 — Backend restart mid-workflow
Kill backend during CODING; restart → on startup, sessions in RUNNING transitioned to FAILED with `error_message="zombie_recovered"`.

### RC-002 — DB connection lost mid-iteration
Drop DB; iteration's transaction rolls back; orchestrator marks session FAILED, no partial rows.

### RC-003 — Sandbox unreachable
Stop sandbox service; coder iter records `execution_error="sandbox_unreachable"`; tester still runs on code-only review; workflow degrades gracefully.

### RC-004 — LLM API down
All providers return 5xx; retries exhausted; session FAILED with clear `error_message` referencing provider.

---

## 9. Performance Baselines

### PF-001 — Single iteration < 90s (stubbed LLMs)
2 coders + 4 testers + summarizer, all stubbed with 100 ms latency → wall < 90 s.

### PF-002 — Sessions list pagination < 500 ms
GET `/sessions?limit=50&offset=0` with 1000 rows → p95 < 500 ms.

### PF-003 — Dashboard stats < 1 s for 1000 sessions
`/dashboard/stats` p95 < 1 s.

### PF-004 — WS message latency < 100 ms
Server emit → client receive p95 < 100 ms (loopback).
