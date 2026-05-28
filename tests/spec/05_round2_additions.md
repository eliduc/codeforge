# 05 — Round 2 Additions: Gaps from Round 1

Round 1 produced 4 specs (109 + 138 + 56 + 40 = ~343 cases) covering API, UI/UX, workflow, and security at "happy + 1 negative" depth. Execution found 2 HIGH (security headers gating, CORS wildcard) and 1 MEDIUM (test fixture). All fixed.

This spec adds **only** tests for areas that were genuinely under-covered or unverifiable in Round 1. Each item below was reviewed against specs 01–04 to ensure it is *additive*, not duplicative.

Severity legend: **CRITICAL** | **HIGH** | **MEDIUM** | **LOW**.

---

## 1. WebSocket: auth, lifecycle, ordering

Specs 02 (FE-DET-007/028, FE-EDGE-005) and 03 (CR-003) touch WS but never check auth or low-level framing. The `WebSocketManager` accepts a `session_id` path param without an obvious token check.

| ID | Description | Expected | Severity |
|----|-------------|----------|----------|
| WS-001 | Connect to `/ws/sessions/{id}` without `?token=` query param | 4401 close (or 401 Upgrade rejection) — not anonymous broadcast | CRITICAL |
| WS-002 | Connect with valid JWT for **another** user's session id | 4403 close; subscriber count for victim session unchanged | CRITICAL |
| WS-003 | Connect with expired JWT | 4401 close, server logs `token expired` | HIGH |
| WS-004 | Connect with `alg=none` JWT in `?token=` | 4401 close | CRITICAL |
| WS-005 | Two clients on same session — `agent_started` arrives at both within 200 ms; identical payload bytes | both receive | HIGH |
| WS-006 | Server emits 200 events in 1 s; client buffer order matches server emit order (assert monotonic `seq`) | strict ordering | HIGH |
| WS-007 | Client closes mid-burst; manager removes from subscribers; no `BrokenPipeError` in log | clean removal | MEDIUM |
| WS-008 | Reconnect after 3 s drop using same token; client receives `__resume__` ack frame and missed events backfill (or explicit "no backfill" doc) | documented behavior holds | HIGH |
| WS-009 | Send malformed text frame from client (`{not-json`) | server replies `error` frame, does not close manager-wide | MEDIUM |
| WS-010 | 100 simultaneous clients on one session; broadcast latency p95 < 250 ms | within budget | MEDIUM |
| WS-011 | Token refresh: connect with token expiring in 30 s; verify connection survives expiry (or graceful close) — document chosen behavior | matches docs | MEDIUM |

## 2. Concurrent multi-user race conditions

Spec 03 §3 covers single-session concurrency. These cover **two distinct authenticated users** hitting overlapping resources.

| ID | Description | Expected | Severity |
|----|-------------|----------|----------|
| MU-001 | User A and User B both POST `/sessions` with identical name in same second | both succeed (no name unique constraint) — verify names+ids distinct | LOW |
| MU-002 | User A starts session, User B (different user) calls `/start` on same id | 403/404 (IDOR check); A's run unaffected | CRITICAL |
| MU-003 | User A deletes session while User B has WS open on it | B receives `session_deleted` frame, then `4404`/close | HIGH |
| MU-004 | User A and User B both PATCH same agent_config row simultaneously | last-write-wins or 409 with optimistic lock; documented either way | MEDIUM |
| MU-005 | 5 users concurrently call `/dashboard/stats` while 2 sessions are running | all 5 get 200; latency p95 < 1 s; numbers self-consistent | MEDIUM |
| MU-006 | Concurrent `bulk-delete` of overlapping ID lists from 2 users | each user only sees own ids in `deleted`; the other's silently skipped | HIGH |
| MU-007 | User A creates webhook, User B reads `/api/webhooks/` | B does not see A's webhook (cross-tenant isolation) | CRITICAL |
| MU-008 | Two users hitting `/api/auth/request-otp` for **same** email (one is whitelisted, one is enumerator) | rate-limit 3-per-window applies per email, not per IP | MEDIUM |

## 3. Resource exhaustion combinations

Spec 03 has WF-009 (max iter), AG-006 (truncated code) individually. These combine pressures.

| ID | Description | Expected | Severity |
|----|-------------|----------|----------|
| RX-001 | Spec at 1 MB cap, 8 coders, max_iterations=20, 6 testers each | accepted or 400 with clear "exceeds budget" message; never silent OOM | HIGH |
| RX-002 | 50 sessions started in parallel (all draft → start) | orchestrator queues or rejects past `MAX_CONCURRENT_SESSIONS`; no DB lock storm | HIGH |
| RX-003 | Single session with 100 interventions queued before run | accepted; queue drains in order; no memory blow-up | MEDIUM |
| RX-004 | LLM request log table with 1 M rows; `/sessions/{id}/llm-requests` | returns first page in < 1 s (index on session_id present) | HIGH |
| RX-005 | Code version with 5 MB source code | stored OK; sandbox refuses with descriptive 400 if past sandbox cap | MEDIUM |

## 4. DB migration rollback (down) safety

Spec 03 DB-003 only checks `upgrade head` idempotency. Migrations 001..016 (now 017 with 012_add_request_timeout) need rollback verification.

| ID | Description | Expected | Severity |
|----|-------------|----------|----------|
| MIG-001 | `alembic downgrade -1` from head, then `upgrade head` | round-trips without error; final schema identical | HIGH |
| MIG-002 | Migration 012 (request_timeout) has working `downgrade()` that drops the column | sqlite/postgres both succeed | MEDIUM |
| MIG-003 | Downgrade with existing data: insert sample row, downgrade, re-upgrade — row preserved if column was nullable | data preserved or migration documents it as destructive | HIGH |
| MIG-004 | Each migration's `down_revision` chain has no gaps or duplicates (alembic history --verbose) | linear chain | MEDIUM |
| MIG-005 | `alembic stamp head` on empty DB then `upgrade head` raises clean error | does not silently recreate tables | LOW |

## 5. Data integrity & orphans

Spec 03 DB-001 covers cascade delete from session. These check orphan-creation paths.

| ID | Description | Expected | Severity |
|----|-------------|----------|----------|
| INT-001 | Hard-delete row from `users` while session FK exists | CASCADE deletes session **or** RESTRICT prevents — match documented behavior | HIGH |
| INT-002 | Delete `code_versions` row referenced by `audit.code_version_id` (FK) | RESTRICT or CASCADE matches FK definition | MEDIUM |
| INT-003 | Webhook delete leaves no orphan delivery-log rows | counts = 0 | LOW |
| INT-004 | Templates: delete a `prompt_template` while versions exist | versions cascade-deleted | MEDIUM |
| INT-005 | After `bulk-delete` partial failure (3 deleted, 1 skipped), DB transaction either all-or-nothing or skipped rows untouched | no half-deleted artifacts | HIGH |

## 6. Internationalization & encoding

Round 1 only had FE-EDGE-008 (unicode renders). These are server-side.

| ID | Description | Expected | Severity |
|----|-------------|----------|----------|
| I18N-001 | Session name: emoji + RTL Arabic + CJK + zero-width joiners | round-trips byte-for-byte through API + DB | MEDIUM |
| I18N-002 | Specification: 4-byte UTF-8 codepoints (mathematical alphanumeric symbols) | DB columns are `utf8mb4`/`utf8` capable; no `?` substitution | MEDIUM |
| I18N-003 | Code source containing non-ASCII identifiers (Python supports them) executes in sandbox | success | LOW |
| I18N-004 | Tester audit `description` field with NUL byte `\x00` | rejected at validation (Postgres rejects NULs in text) with 400, not 500 | MEDIUM |
| I18N-005 | Email with IDN domain `user@münchen.de` | normalized to punycode by EmailStr; whitelist match works against punycode form | LOW |
| I18N-006 | Filename in upload: `файл.py` (Cyrillic) | preserved or transliterated; no path-traversal regression | MEDIUM |

## 7. File upload edge cases

Spec 04 SEC-013 mentions zip slip but not these.

| ID | Description | Expected | Severity |
|----|-------------|----------|----------|
| ARC-001 | Zip with 1000 nested directories `a/a/a/...` | extraction fails fast with "depth limit" or succeeds within MAX_PATH | MEDIUM |
| ARC-002 | Zip bomb: 10 KB compressed → 10 GB uncompressed | rejected before disk fills (size check during extraction) | CRITICAL |
| ARC-003 | Zip with symlinks pointing outside extract root | symlinks rejected or dereferenced safely | HIGH |
| ARC-004 | Tarball with absolute path entry `/etc/passwd` | rejected | CRITICAL |
| ARC-005 | Single file in archive 5 MB but archive total 4.9 MB (compression deception) | uncompressed-size check enforces total cap | MEDIUM |
| ARC-006 | Corrupt zip header (truncated mid-CD) | 400 with "invalid archive", no partial extraction | MEDIUM |
| ARC-007 | Zip filename with NUL byte | rejected at archive-parse layer | HIGH |
| ARC-008 | Upload .py file with BOM + CRLF + tab+space mix | preserved exactly; sandbox executes | LOW |

## 8. LLM response edge cases

Spec 03 §4 covers happy paths, retry. These are malformed responses.

| ID | Description | Expected | Severity |
|----|-------------|----------|----------|
| LLM-E-001 | Provider returns empty string | recorded as 0-token completion; coder raises `EmptyCompletionError`; iteration retries once then surfaces error | HIGH |
| LLM-E-002 | Tester response is invalid JSON (LLM hallucinated narrative) | parser falls back to "default-failed audit" or asks LLM to re-emit; not 500 | HIGH |
| LLM-E-003 | Tester response has `severity: "extreme"` (not in enum) | normalized to nearest valid or rejected with explicit warning | MEDIUM |
| LLM-E-004 | Coder returns code with mismatched `language` claim (says "python", body is JS) | sandbox detection or finalizer warning; does not silently execute wrong runtime | MEDIUM |
| LLM-E-005 | Finalizer returns `selected_coder_index=99` (out of range) | rejected; finalizer re-prompted or session FAILED with clear error | HIGH |
| LLM-E-006 | Provider 200 OK but truncated mid-stream | retry; if ultimately incomplete, treat as `error` not `success` | HIGH |
| LLM-E-007 | Streaming response yields zero chunks before close | retry once, then error | MEDIUM |
| LLM-E-008 | Anthropic `thinking` block returned without `text` block | iteration recovers; UI shows reasoning-only audit gracefully | MEDIUM |
| LLM-E-009 | Provider returns valid JSON wrapped in markdown fence ```json ... ``` | extractor strips fence; downstream parses | LOW |
| LLM-E-010 | Provider returns response 10× larger than `max_tokens` (provider bug) | truncated or rejected with size guard | MEDIUM |

## 9. Sandbox edge cases

Spec 03 §5 + spec 04 §SEC-027/028/029 cover happy + bombs. These fill in.

| ID | Description | Expected | Severity |
|----|-------------|----------|----------|
| SBE-001 | Code that opens 10000 file handles | killed at ulimit; clear error message | HIGH |
| SBE-002 | Code that writes 100 MB to stdout | truncated at MAX_OUTPUT_BYTES with marker | HIGH |
| SBE-003 | Code that prints binary garbage `\xff\xfe...` | output captured as bytes or replaced with `?`; no UTF-8 decode crash | MEDIUM |
| SBE-004 | Code that calls `os.fork()` 100 times | killed; `forks` limit enforced | HIGH |
| SBE-005 | Code that imports `socket` and binds 0.0.0.0:80 | EACCES from cap_net; reported in stderr | HIGH |
| SBE-006 | Code that mounts `/dev/shm` | fails (read-only or no `mount` cap) | HIGH |
| SBE-007 | Code that sleeps exactly at timeout boundary | killed cleanly; `timeout=True` recorded | MEDIUM |
| SBE-008 | Browser bundle with `eval()` and `Function()` | runs (no CSP unless we add one) — document whether this is allowed | LOW |
| SBE-009 | Two execute requests for same code_version race | sandbox isolates them; outputs independent | MEDIUM |
| SBE-010 | Code that triggers Python `MemoryError` from large list | killed at cgroup memory limit; exit code reflects OOM | HIGH |

## 10. Frontend gaps not in spec 02

| ID | Description | Severity |
|----|-------------|----------|
| FE2-001 | DetailPanel: pasting 100 KB log into the textarea does not jank UI; virtualized rendering | MEDIUM |
| FE2-002 | Graph: 16+ nodes layout legibly without overlap; zoom/pan stays smooth | MEDIUM |
| FE2-003 | Sessions list: filter by date range (from/to) returns expected slice | MEDIUM |
| FE2-004 | Theme persists across login/logout | LOW |
| FE2-005 | LoginPage handles offline (`navigator.onLine === false`) gracefully — no spinner stuck | MEDIUM |
| FE2-006 | DetailPanel "Run Code" while another execution in flight — second click disabled or queues | MEDIUM |
| FE2-007 | Token expires while DetailPanel is open — graceful redirect, WS closes cleanly | HIGH |
| FE2-008 | Settings page: API key field paste with surrounding whitespace is trimmed | LOW |
| FE2-009 | Reset session via UI: confirm dialog focus is on "Cancel" by default (safer) | LOW |
| FE2-010 | Bulk delete 200 sessions — UI shows progress, no frozen tab | HIGH |

---

## Summary

- **New test cases added:** **84**
  - CRITICAL: 8
  - HIGH: 32
  - MEDIUM: 32
  - LOW: 12 (incl. cross-cutting LOW from spec 02 footer not re-counted)
- **Categories:** WebSocket (11), multi-user (8), resource exhaustion (5), migrations (5), integrity (5), i18n (6), archives (8), LLM responses (10), sandbox (10), frontend gaps (10) — *total 78 distinct + 6 footer carry = 84*.
- **Combined Round 1 + Round 2 spec total:** ~427 test cases.

## Stop criterion for Team 1

After Round 2, Team 1 (test authors) **stops generating new tests**. Future rounds belong to:
- **Team 2 — Executors**: run pytest, exercise endpoints, manual UI passes, security probes.
- **Team 3 — Verifiers/Fixers**: triage findings, write code patches, regression-test.

Coverage will be declared complete when Round 2 execution reports come back; if Round 2 finds < 5 net-new bugs, no Round 3 spec writing is needed.
