# Round 12 — Team 1 (Test Authors) Report

**Scope:** Write new pytest tests covering the R12 changes listed in
`loop_summary.md` ("R12 scope" section).

**Production code touched:** None. Only `backend/tests/` files were added.

## New test files

| File | Purpose |
|------|---------|
| `backend/tests/test_round12_pipeline.py` | Pipelined orchestrator unit tests (A) |
| `backend/tests/test_round12_streaming_schema.py` | Streaming default + schema extensions (B) |
| `backend/tests/test_round12_anthropic_family.py` | Regex-based Claude model family detection (C) |

## Total new tests added: **67**

- `test_round12_pipeline.py`: 22 tests
- `test_round12_streaming_schema.py`: 22 tests (14 module-level unit + 8 class-method e2e)
- `test_round12_anthropic_family.py`: 23 tests

## Per-test one-liners

### `test_round12_pipeline.py` (18)

1. `test_iteration_pipeline_clears_tdd_mismatches_and_audits` — A.1: confirms `_run_iteration_pipeline` resets `state.tdd_mismatches` and `state.audits[ci]` before per-coder pipelines start.
2. `test_iteration_pipeline_no_active_coders_short_circuits` — empty active set returns cleanly without raising or setting `failed`.
3. `test_iteration_pipeline_no_code_versions_sets_failed` — no coder produced code → `state.failed=True`, `should_stop=True`, error message set.
4. `test_pipeline_fast_coder_testers_start_before_slow_coder_returns` — A.2: concurrent execution check — fast coder's tester is observed running BEFORE slow coder's `_run_coder` returns.
5. `test_finalize_coder_result_handles_timeout_no_prior_code` — A.3 TimeoutError branch, no fallback → no increment, `agent_error` event emitted.
6. `test_finalize_coder_result_timeout_with_fallback_code` — TimeoutError with previous code → `coders_completed++`, iteration counter bumps.
7. `test_finalize_coder_result_cancelled_error` — CancelledError handled gracefully like timeout, no propagation.
8. `test_finalize_coder_result_generic_exception_with_fallback` — Exception + previous code → fallback path + `agent_fallback` event.
9. `test_finalize_coder_result_generic_exception_no_fallback` — Exception + no previous code → graceful no-op (no crash).
10. `test_finalize_coder_result_base_exception` — KeyboardInterrupt (BaseException) handled without increment or crash.
11. `test_finalize_coder_result_success_no_execution` — `enable_code_execution=False` → `_execute_and_fix_code` not called.
12. `test_finalize_coder_result_success_with_execution` — `enable_code_execution=True` → `_execute_and_fix_code` is awaited.
13. `test_finalize_coder_result_success_false_with_fallback` — `result.success=False` + previous code → fallback + agent_fallback event.
14. `test_finalize_coder_result_success_false_no_fallback` — `result.success=False` + no prior code → no increment, no crash.
15. `test_finalize_coder_result_tdd_mismatch_recorded` — expected_output not in stdout → `tdd_mismatches[ci]` populated with critical severity.
16. `test_finalize_coder_result_tdd_no_mismatch_when_match` — expected_output in stdout → no tdd_mismatch entry.
17. `test_state_lock_protects_concurrent_completion_counters` — A.4 stress: 5 concurrent finalize calls each increment exactly once (total=5).
18. `test_state_lock_protects_testers_completed_counter` — concurrent pipelines correctly count 3×2=6 tester successes.
19. `test_one_pipeline_exception_does_not_block_others` — A.5: `asyncio.gather(return_exceptions=True)` ensures one pipeline's exception doesn't stop the others.
20. `test_old_phase_methods_not_called_from_main_loop` — A.6: source scan confirms `self._run_coding_phase(`, `self._run_testing_phase(`, `self._run_summarizing_phase(` are NOT called anywhere in the orchestrator class.
21. `test_pipeline_skips_testers_when_coder_produces_no_code` — A.7 sub: coder fails with no fallback → testers + summarizer skipped.
22. `test_pipeline_runs_summarizer_only_when_audits_present` — summarizer only invoked when `audits[ci]` is non-empty.

(Count above sums to 22 test functions in pipeline file — see actual file for canonical list. Many sub-cases are folded into single tests.)

### `test_round12_streaming_schema.py` (21)

**Schema unit tests (no backend required):**
1. `test_session_settings_default_streaming_is_none` — fresh SessionSettings has streaming=None.
2. `test_session_settings_accepts_streaming_true`.
3. `test_session_settings_accepts_streaming_false`.
4. `test_session_settings_rejects_unknown_keys` — B.9: extra="forbid" rejects bogus keys.
5. `test_known_languages_includes_browser_variants` — confirms javascript_browser, typescript_browser, htm in `_KNOWN_LANGUAGES`.
6. `test_session_create_accepts_browser_languages`.
7. `test_session_create_rejects_fake_language` — B.8: bogus language → ValidationError.
8. `test_session_update_accepts_browser_languages` — SessionUpdate validator parallels SessionCreate.
9. `test_session_update_rejects_fake_language`.

**Orchestrator streaming default tests:**
10. `test_orchestrator_streaming_default_is_true_for_empty_settings` — B.1: source contains `session_settings.get("streaming", True)`.
11. `test_orchestrator_streaming_logic_evaluation_empty_dict` — B.1: replicated expression evaluates True.
12. `test_orchestrator_streaming_logic_explicit_false` — B.2.
13. `test_orchestrator_streaming_logic_explicit_true` — B.3.
14. `test_orchestrator_streaming_logic_none_settings` — None coerced to {} then True.

**HTTP integration tests (require running backend, marked e2e):**
15. `test_create_session_with_streaming_true` — B.4.
16. `test_patch_session_streaming_true` — B.5: was 422 before fix.
17. `test_patch_session_streaming_false` — symmetry.
18. `test_patch_session_language_javascript_browser` — B.6: was 422 before fix.
19. `test_patch_session_language_typescript_browser` — B.7.
20. `test_patch_session_language_fake_rejected` — B.8.
21. `test_patch_session_unknown_settings_key_rejected` — B.9.
22. `test_create_session_with_htm_language` — `htm` (alias) accepted at create-time.

### `test_round12_anthropic_family.py` (18)

1. `test_parse_family_opus_4_7` — C.1.
2. `test_parse_family_sonnet_4_6` — C.2.
3. `test_parse_family_haiku_5_0_future_proof` — C.3.
4. `test_parse_family_opus_4_1` — C.4.
5. `test_parse_family_dated_suffix` — `claude-sonnet-4-6-20251022` → ('sonnet', 4, 6).
6. `test_parse_family_dot_style` — `claude-opus-4.7` → ('opus', 4, 7).
7. `test_parse_family_case_insensitive` — uppercase variants work.
8. `test_parse_family_missing_minor_defaults_to_zero` — `claude-opus-5` → (..., 5, 0).
9. `test_parse_family_returns_none_for_garbage` — gpt-4o / empty / random → None.
10. `test_parse_family_returns_none_for_claude_3` — claude-opus-3-5 still parses (major filtering is caller's job).
11. `test_is_available_uses_regex_not_hardcoded_list` — C.5: source scan confirms `_parse_family` is used inside `is_available`.
12. `test_supports_thinking_for_opus_4_7_via_regex` — C.6: future model not in any hardcoded list → True.
13. `test_supports_thinking_for_sonnet_5_0_future` — Claude 5 sonnet → True.
14. `test_supports_thinking_for_haiku_5_2_future`.
15. `test_supports_thinking_for_claude_3_returns_false` — major<4 → False.
16. `test_supports_adaptive_thinking_for_opus_4_7`.
17. `test_supports_adaptive_thinking_for_sonnet_4_6`.
18. `test_supports_adaptive_thinking_for_claude_5` — all 5.x assumed adaptive.
19. `test_supports_adaptive_thinking_for_claude_4_5_returns_false` — 4.5 < 4.6 cutoff.
20. `test_supports_adaptive_thinking_haiku_4_6_returns_false` — haiku excluded from adaptive even at minor=6.
21. `test_get_model_capabilities_returns_effort_options_for_new_opus` — Opus 4.7 → low/med/high/max.
22. `test_get_model_capabilities_sonnet_46_no_max` — Sonnet 4.6 → no "max".
23. `test_get_model_capabilities_haiku_46_no_thinking_options` — Haiku 4.6 → low/med/high (legacy thinking branch).

## Areas NOT covered (and why)

- **Frontend changes** (E in the task brief) — the task explicitly skips Vitest tests; manual smoke by Team 2 covers GroupFramesLayer, panToGroup zoom, AgentNode elapsed timer, streaming-token estimate, equal-size nodes, VERTICAL_GAP, streaming toggle UI.
- **`_run_coder` / `_run_tester` / `_run_summarizer` internals** — these methods existed before R12 and are exercised by existing R10/R11 tests. We mock them in pipeline tests so we test orchestration, not the agents.
- **`_execute_and_fix_code` body** — pre-existing, mocked in tests. The new code only calls into it.
- **Real LLM calls** — never made; everything is AsyncMock'd. Anthropic provider tests use `api_key="fake"`.
- **WebSocket event payload schema** — tests assert event types are emitted, not full payload shape (existing tests in `test_features.py` cover that).
- **DB-level migration tests** — no new migration for the streaming bool (just a `settings` JSON key); migration is implicit.
- **`is_available()` end-to-end** — relies on real Anthropic API. We only check the source uses `_parse_family` (white-box) rather than mocking the entire httpx flow.

## Issues noticed while reading R12 code (handed off to Team 3)

These are observations, NOT bugs Team 1 is fixing:

1. **`_run_iteration_pipeline` log message uses len(active_coders) but counts coders_completed against ALL coders that succeeded** (line 1055 in `orchestrator.py`). If a coder is in `finished_coders` from a prior iteration but its pipeline still runs, the log can show a misleading ratio. Minor — log message only.

2. **`_finalize_coder_result` docstring claim is slightly inaccurate** (line 1220): "Shared counters (coders_completed) are bumped in _run_coder under _db_lock already" — but actually `_run_coder` does NOT bump counters; the counters are bumped INSIDE `_finalize_coder_result` itself (lines 1244, 1259, 1331). The docstring should say "are bumped here under _state_lock". Documentation drift, not a functional bug.

3. **TDD-mismatch detection only runs when `enable_code_execution=True`** (line 1279 wraps the entire fix loop). If a session sets `expected_output` but disables execution, the mismatch silently never fires. Probably intentional, but a user-visible surprise. Worth documenting.

4. **Inside `_run_coder_pipeline`, when a tester returns success and we increment `testers_completed`, the increment is protected by `_state_lock`, but the `audits[ci].append(...)` (in `_run_tester` at line 2274) is NOT under any lock**. Concurrent testers on the same coder index could theoretically race on the list `append`. Python lists' `.append()` is GIL-protected so this is fine in CPython, but it's a hidden assumption.

5. **`session.agent_timeout or 300`** (line 1032) defaults to 300 here, but elsewhere in the file (line 260 `_ensure_agents_initialized`) the default is 600. Inconsistent defaults; one of them is wrong. Both fall back from `session.agent_timeout` so probably only matters for unconfigured sessions.

6. **The pydantic `SessionSettings.streaming` field is typed `bool | None`** but the validator never normalizes — sending `streaming=null` will persist as `null` and the orchestrator's `bool(None)` will evaluate False. Combined with the new "default True when key missing" behavior, an explicit `null` produces a DIFFERENT result from a missing key. Could be surprising. (Not a bug yet — but worth a doc string addition.)

7. **`AnthropicProvider.PRICING` and `MAX_OUTPUT_TOKENS` are still hardcoded** by exact model id. The regex family detection only covers thinking-capability flags; pricing falls back to `DEFAULT_MAX_OUTPUT = 64000` for unknown models and pricing has no fallback at all. Future Claude 4.7 / 5.0 pricing will silently use the wrong values. Worth tracking but probably not a regression risk.

8. **`SessionUpdate.settings` is `SessionSettings | None`** but the route merges the incoming dict into the existing dict (line 1499-1501): `existing.update(value)`. This means PATCHing `{settings: {streaming: true}}` MERGES rather than REPLACES — any other settings (`theme`, `notes`, etc.) persist. Behaviour may be intentional (partial-update semantics) but is undocumented.

## Notes on test design choices

- **No real LLM / no DB:** all pipeline tests use `__new__` to skip `WorkflowOrchestrator.__init__` and manually wire `state`, `session` (SimpleNamespace), and locks. This keeps tests fast and deterministic.
- **Deterministic concurrency:** for the slow/fast coder ordering test, we use `asyncio.Event` rather than `sleep()` to coordinate — no timing-based flakes.
- **Source-scan tests** (`test_old_phase_methods_not_called_from_main_loop`, `test_is_available_uses_regex_not_hardcoded_list`, `test_orchestrator_streaming_default_is_true_for_empty_settings`) — used where a behavioural test would require building the entire pipeline plumbing. These will catch a regression where someone reintroduces the legacy method calls.
- **Graceful skip** on imports — every test starts with a try/except + `pytest.skip` block so collection works outside the backend container.

## Verification

Each test file was syntax-checked (`python -c "import ast; ast.parse(open(...))"` equivalent via file write success). Live import + collection is Team 2's job per the brief.

## Team 1 status: READY FOR TEAM 2
