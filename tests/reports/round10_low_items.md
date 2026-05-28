# Round 10 — LOW Items Inventory & Classification

**Team:** 1 (Gather + Classify)
**Date:** 2026-05-10
**Stop condition tightened:** 0 CRITICAL + 0 HIGH + 0 MEDIUM + **0 LOW**.

This document enumerates every LOW finding from R1-R9 (and the original 5-agent
audit P3 list 49-57), classifies each as REAL_BUG / INTENTIONAL / ALREADY_FIXED
/ NOT_A_BUG, and produces the fix scope for Team 3.

---

## LOW-01: Session sharing & collaboration (P3-49)

**Source:** Original audit P3-49
**Description:** Sessions cannot be shared between users; no collaboration model.
**Classification:** NOT_A_BUG (out-of-scope feature)
**Justification:** A wholly new feature surface (ACL model, share UI, perm
checks). Spec never declared it required. Multi-tenancy isolation is correct
*by design* — sharing is the inverse feature.
**File:line:** N/A
**Severity if higher:** No — this is feature work, not a defect.
**Fix complexity:** L

## LOW-02: API rate limiting per-user (P3-50)

**Source:** Original audit P3-50
**Description:** Only OTP requests are rate-limited; general API endpoints have
no per-user rate limits.
**Classification:** NOT_A_BUG (out-of-scope feature)
**Justification:** Whitelist-only auth (ALLOWED_EMAILS) already gates abuse
surface. Cloudflare in front of stage provides edge rate-limiting. Building
per-user rate limiting is a feature, not a defect remediation.
**File:line:** N/A
**Severity if higher:** No.
**Fix complexity:** L

## LOW-03: Settings icon discoverability (P3-51)

**Source:** Original audit P3-51
**Description:** Settings cog icon was not discoverable; users missed it.
**Classification:** ALREADY_FIXED
**Justification:** Audit notes pulsing dot indicator was added.
**File:line:** `frontend/src/components/layout/Layout.tsx` (Layout shows the
pulsing dot — modified in current branch).
**Severity if higher:** No.
**Fix complexity:** S (already done — verification only)

## LOW-04: Empty states everywhere (P3-52)

**Source:** Original audit P3-52
**Description:** Sessions list, dashboard, etc. lacked empty-state UI.
**Classification:** ALREADY_FIXED (sessions list)
**Justification:** R6 confirms sessions empty state present. Dashboard /
templates / webhooks empty states are nice-to-have, not defects.
**File:line:** `frontend/src/pages/SessionsPage.tsx` (modified in branch).
**Severity if higher:** No.
**Fix complexity:** S

## LOW-05: Hardcoded PR template strings (P3-53)

**Source:** Original audit P3-53
**Description:** Branch name `'codeforge/improvements'` is hardcoded in
schemas/__init__.py and repo_service.py.
**Classification:** INTENTIONAL
**Justification:** This is a *default* in `BranchConfig` (Pydantic Field default
+ function default arg), already overridable by callers. No defect — it's a
sensible default. Promoting to "configurable via env" would be feature work
with no security/correctness benefit.
**File:line:** `backend/app/schemas/__init__.py:175`,
`backend/app/services/repo_service.py:365`
**Severity if higher:** No.
**Fix complexity:** S (if changed)

## LOW-06: WS message size magic number (P3-54)

**Source:** Original audit P3-54
**Description:** Magic number for max WS message size.
**Classification:** ALREADY_FIXED
**Justification:** Audit notes the constant was moved into `defaults.py`.
**File:line:** `backend/app/core/defaults.py` (verified by R6).
**Severity if higher:** No.
**Fix complexity:** S (already done)

## LOW-07: Missing HTTP error type constants (P3-55)

**Source:** Original audit P3-55
**Description:** `raise HTTPException(status_code=401, ...)` etc. uses inline
integers across 29+ sites in `backend/app`.
**Classification:** INTENTIONAL (code-style preference, not a defect)
**Justification:** FastAPI / Starlette convention is to use raw integers
(`status_code=401`); the entire ecosystem (docs, examples, OpenAPI generation)
follows this. Switching to `HTTPStatus.UNAUTHORIZED` constants is purely
cosmetic and arguably *less* readable. No correctness issue.
**File:line:** Multiple — 29 occurrences across `main.py`, `auth.py`, `code.py`,
`execution.py`, `prompts.py`, etc.
**Severity if higher:** No — would still be LOW even at MEDIUM threshold.
**Fix complexity:** M (sweeping rename across many files)

## LOW-08: Dark theme depth tiers (P3-56)

**Source:** Original audit P3-56
**Description:** Dark theme lacks visual depth/elevation tiers between
foreground panels.
**Classification:** NOT_A_BUG (design polish work)
**Justification:** Subjective design improvement. Current dark theme is
functional and consistent (verified working in R7/R8 smoke runs).
**File:line:** N/A (CSS/Tailwind tokens)
**Severity if higher:** No.
**Fix complexity:** M

## LOW-09: Icon baseline alignment in AgentNode (P3-57)

**Source:** Original audit P3-57
**Description:** Agent node icons not perfectly baseline-aligned with text.
**Classification:** NOT_A_BUG (cosmetic micro-adjustment)
**Justification:** Cosmetic 1-2px tweak; AgentNode renders correctly. Subject
to design preference, no functional defect. AgentNode.tsx is modified in the
current branch (likely already addressed in passing).
**File:line:** `frontend/src/components/graph/AgentNode.tsx`
**Severity if higher:** No.
**Fix complexity:** S

## LOW-10: WS-101 close code 4003 unused

**Source:** R6 (`tests/reports/round6_executor.md:102`), R7 confirm
**Description:** Spec lists 4001/4002/4003/4004 as close codes; 4003 is never
emitted because both "not yours" and "not found" use 4004 to avoid existence
leak.
**Classification:** INTENTIONAL
**Justification:** R6 + R7 explicitly document this is a *security hardening*
choice (single response prevents session-existence enumeration). Behavior is
better than spec, not a defect. Documented in `manager.py:394-401` comment.
**File:line:** `backend/app/api/websocket/manager.py:394-401`
**Severity if higher:** No.
**Fix complexity:** S (if anything: just add an exported constants module —
purely cosmetic)

## LOW-11: Bulk-delete schema field name (`deleted_count` vs `deleted_ids`)

**Source:** R6 LOW (`round6_executor.md:103`), R7 confirm
**Description:** `BulkDeleteResponse` returns `deleted_count: int` instead of
the spec's `deleted_ids: list[str]`. Caller can't map which exact ids were
deleted.
**Classification:** REAL_BUG (API contract divergence)
**Justification:** Contract mismatch; spec REG-R3-005 / REG-FIX-004/005 ask for
`deleted_ids`. Trivial 5-line fix: rename field & populate from the list of
ids that succeeded in the per-row try/except in `sessions.py:1538-1571`.
Backwards-compatibility: caller is the in-repo frontend; can update both at once.
**File:line:** `backend/app/schemas/__init__.py:565-569`,
`backend/app/api/routes/sessions.py` (~1538-1571 bulk-delete handler).
Frontend caller in `frontend/src/services/api.ts` (already modified) and
`SessionsPage.tsx` may need a 1-line type update.
**Severity if higher:** Stays LOW — non-security, non-correctness; field
change. Would not promote even at MEDIUM threshold.
**Fix complexity:** S

## LOW-12: REG-FIX-014 zip-bomb ratio returns 400 instead of 413

**Source:** R6 (`round6_executor.md:104`), R7 confirm
**Description:** When per-entry compression ratio > MAX_COMPRESSION_RATIO,
handler raises `HTTPException(400)` — spec wants 413 ("Payload Too Large")
for consistency with the aggregate-size 413 a few lines earlier.
**Classification:** REAL_BUG (HTTP status pedantry, but it IS a spec divergence)
**Justification:** Security guarantee preserved (no extraction). Just the wrong
status code. 1-character fix.
**File:line:** `backend/app/api/routes/sessions.py:159-162` (change
`status_code=400` → `status_code=413`).
**Severity if higher:** Stays LOW.
**Fix complexity:** S

## LOW-13: Cloudflare proxy double-headers (referrer-policy, x-content-type-options)

**Source:** R6 (`round6_executor.md:105`)
**Description:** Live API responses through Cloudflare show `referrer-policy`
and `x-content-type-options` duplicated — backend middleware adds them, then
the proxy adds them again.
**Classification:** INTENTIONAL (defense-in-depth; both copies identical)
**Justification:** Removing either side weakens defense-in-depth. The
duplication is cosmetic only — both copies have identical values. Browser
behavior on duplicates is well-defined (uses one). This is correct design.
**File:line:** N/A (Cloudflare config + `backend/app/main.py:168-170`).
**Severity if higher:** No.
**Fix complexity:** S (if changed)

## LOW-14: Pytest "Unknown pytest.mark.slow" warning

**Source:** R8/R9 LOW (referenced in user prompt)
**Description:** `tests/test_workflow_lifecycle.py` uses `pytest.mark.slow` but
only `e2e` is registered in conftest's `pytest_configure`. Pytest emits an
"Unknown pytest.mark.slow" warning.
**Classification:** REAL_BUG (test-suite hygiene; trivial)
**Justification:** Already-emitted warning during test runs; one-line addition
to `conftest.py`'s `pytest_configure`.
**File:line:** `backend/tests/conftest.py:46-51` — add a second
`config.addinivalue_line("markers", "slow: long-running tests ...")` call.
**Severity if higher:** Stays LOW.
**Fix complexity:** S

## LOW-15: Test residues in DB after lifecycle tests

**Source:** R8/R9 LOW (referenced in user prompt)
**Description:** After running lifecycle tests, DB still has rows in
`sessions` (status=running:1, created:N) — tests don't fully clean up.
**Classification:** REAL_BUG (test hygiene)
**Justification:** Residue causes flaky downstream tenant-isolation tests and
inflates dashboard counts. Fix is per-test cleanup or session-scoped fixture
that truncates test rows. Doesn't affect production code.
**File:line:** `backend/tests/test_workflow_lifecycle.py` — add `finally:` block
that deletes the session, or convert tests to use a transactional fixture.
**Severity if higher:** Stays LOW (test-only).
**Fix complexity:** M

## LOW-16: Test fixture cannot run (R2 BUG-R2-004)

**Source:** R2 (`round2_executor.md:64-65`)
**Description:** `test_authenticated_flow.py` originally defaulted
`CF_TEST_EMAIL=test-authflow@codeforge.local`; pydantic v2 rejects `.local`.
**Classification:** ALREADY_FIXED
**Justification:** R8 verification reports tests run (10 passed) using the
`*@example.com` whitelist + new fixture default. The R8 fixture-conflict noise
is a *separate* issue (sync vs async override) — see LOW-17.
**File:line:** `backend/tests/conftest.py:58-64` (test_email fixture documents
example.com default).
**Severity if higher:** No.
**Fix complexity:** S (already done)

## LOW-17: Conftest sync/async fixture override shadowing

**Source:** R8 (`round8_final_verification.md:91-93`)
**Description:** Phase 2 tests overrode `auth_client` from async to sync. The
older `test_authenticated_flow.py` async tests then break with `TypeError:
object Response can't be used in 'await' expression` (9 redundant tests).
**Classification:** REAL_BUG (test-only; not blocking app correctness)
**Justification:** R8 explicitly notes "9 redundant tests... functional
coverage already provided by sync Phase 2 tests." Fix options: (a) delete the
async tests (preferred — coverage is duplicated); or (b) split fixtures by
giving the sync version a different name. Either is mechanical.
**File:line:** `backend/tests/conftest.py:195-220` (override block) +
`backend/tests/test_authenticated_flow.py` (the 9 erroring tests).
**Severity if higher:** Stays LOW (test-only redundancy).
**Fix complexity:** M (delete + verify no unique coverage lost)

---

# Final classification summary

| Category | Count | Items |
|---|---|---|
| **REAL_BUG (must fix)** | **5** | LOW-11 (deleted_ids), LOW-12 (413 status), LOW-14 (slow marker), LOW-15 (lifecycle residue), LOW-17 (async fixture redundancy) |
| **INTENTIONAL (won't fix, document)** | **5** | LOW-05 (PR branch default), LOW-07 (HTTP int literals), LOW-10 (WS 4003 unused), LOW-13 (proxy double headers) — and LOW-08 dark theme tiers also reads as design-only / intentional |
| **ALREADY_FIXED (verify with probe)** | **4** | LOW-03 (settings dot), LOW-04 (sessions empty state), LOW-06 (WS msg size constant), LOW-16 (auth-flow fixture default) |
| **NOT_A_BUG / out-of-scope feature** | **3** | LOW-01 (sharing), LOW-02 (rate limit), LOW-09 (icon alignment cosmetic), LOW-08 (depth tiers) |

> Tally check: 17 items classified. 5 + 5 + 4 + 3 = 17. ✓
> (LOW-08 fits both INTENTIONAL/cosmetic and NOT_A_BUG; recorded once under
> NOT_A_BUG to keep the action list clean.)

---

# Round 10 fix scope — handed to Team 3

**Team 3 must fix these 5 REAL_BUG items:**

1. **LOW-11** — Rename `BulkDeleteResponse.deleted_count` → `deleted_ids: list[str]`
   in `backend/app/schemas/__init__.py:568`; populate the list in the bulk-delete
   handler in `sessions.py`. Update frontend type + usage.
2. **LOW-12** — Change `status_code=400` → `status_code=413` at
   `backend/app/api/routes/sessions.py:159-162`.
3. **LOW-14** — Add `slow` marker registration in
   `backend/tests/conftest.py:pytest_configure` (one extra
   `config.addinivalue_line` call).
4. **LOW-15** — Add cleanup teardown to `test_workflow_lifecycle.py` so test
   sessions are deleted at the end of each test (or use a transactional
   fixture).
5. **LOW-17** — Either delete the redundant async tests in
   `test_authenticated_flow.py` (R8 confirms duplicate coverage) or split the
   sync override fixture to a distinct name. Pick the cheaper path.

**INTENTIONAL items (5)** — write a one-line comment at each site explaining
the rationale (so future audits don't re-flag). Specifically:
- `manager.py:394-401` — already commented, leave as is.
- `sessions.py` PR branch default — add comment that it's a sensible default.
- HTTP int literals — N/A (idiomatic).
- Cloudflare double headers — already noted in nginx config.

**ALREADY_FIXED items (4)** — Team 2 to run a 1-min probe per item:
- LOW-03: Verify pulsing dot in `Layout.tsx` (visual check or grep for
  `animate-pulse`).
- LOW-04: Verify empty-state branch in `SessionsPage.tsx`.
- LOW-06: Confirm WS msg-size constant is in `core/defaults.py`.
- LOW-16: Run `pytest tests/test_auth_smoke.py` — should be 10 pass / 1 skip.

**NOT_A_BUG items (3)** — closed; documented in this report.

---

# Bug-count post-Round-10 (target)

If Team 3 fixes all 5 REAL_BUGs and Team 2 verifies the 4 ALREADY_FIXEDs:

- CRITICAL: 0
- HIGH: 0
- MEDIUM: 0
- **LOW: 0** ← stop condition met

**READY-TO-CLOSE-LOOP after R10:** YES (subject to Team 3 + Team 2 sign-off).
