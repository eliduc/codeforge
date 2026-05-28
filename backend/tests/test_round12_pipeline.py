"""R12 — Pipelined orchestrator tests.

Covers the new `_run_iteration_pipeline()` / `_run_coder_pipeline()` /
`_finalize_coder_result()` methods in `app/core/orchestrator.py`.

These are pure unit tests that bypass the real WorkflowOrchestrator
constructor (which needs a DB session + ORM Session row) and inject a
minimal stub state. We mock every external dependency (`_run_coder`,
`_run_tester`, `_run_summarizer`, `_execute_and_fix_code`, `emit_event`)
with AsyncMock so the pipeline logic is exercised in isolation.

Patterns adopted from existing tests in this folder:
  - `@pytest.mark.asyncio` marker at module level.
  - `pytest.skip` if backend modules are unimportable (matches conftest).
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Helper: build a bare-bones orchestrator instance without touching DB / agents.
# ---------------------------------------------------------------------------


def _make_orchestrator(
    *,
    n_coders: int = 1,
    n_testers: int = 1,
    has_summarizer: bool = True,
    agent_timeout: int = 30,
    expected_output: str | None = None,
    enable_code_execution: bool = False,
    attachments: list | None = None,
    max_fix_attempts: int = 1,
):
    """Construct a WorkflowOrchestrator without running __init__.

    We bypass __init__ entirely (no DB / no agent setup) and wire up just
    enough state for the pipeline methods to operate.
    """
    try:
        from app.core.orchestrator import (
            WorkflowOrchestrator,
            WorkflowState,
            WorkflowPhase,
        )
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"backend modules not importable: {exc!r}")

    orch = WorkflowOrchestrator.__new__(WorkflowOrchestrator)

    # State
    sid = uuid.uuid4()
    orch.state = WorkflowState(session_id=sid, max_iterations=3)
    orch.state.phase = WorkflowPhase.INITIALIZING
    orch.state.current_iteration = 1

    # Synchronization primitives
    orch._db_lock = asyncio.Lock()
    orch._DB_LOCK_TIMEOUT = 5.0
    orch._state_lock = asyncio.Lock()
    orch._session_id = str(sid)

    # Mock session row
    orch.session = SimpleNamespace(
        id=sid,
        agent_timeout=agent_timeout,
        max_fix_attempts=max_fix_attempts,
        enable_code_execution=enable_code_execution,
        expected_output=expected_output,
        attachments=attachments or [],
        settings={},
        language="python",
        specification="noop",
        agent_configs=[],
    )
    orch.db = MagicMock()
    orch.event_callback = None

    # Agents — fake objects with agent_index attribute.
    orch.coders = [SimpleNamespace(agent_index=i) for i in range(n_coders)]
    orch.testers = [SimpleNamespace(agent_index=i) for i in range(n_testers)]
    orch.summarizer = SimpleNamespace(agent_index=0) if has_summarizer else None
    orch.finalizer = None

    # Stub emit_event so the pipeline can call it freely.
    orch.emit_event = AsyncMock(return_value=None)

    # Default mocks for internal sub-routines used by the pipeline.
    orch._run_coder = AsyncMock()
    orch._run_tester = AsyncMock()
    orch._run_summarizer = AsyncMock()
    orch._execute_and_fix_code = AsyncMock()
    orch._update_code_version_content = AsyncMock()

    return orch


def _make_agent_result(success: bool = True, error: str | None = None):
    """Build a stand-in for AgentResult."""
    return SimpleNamespace(
        success=success,
        content="print('ok')",
        parsed_data=None,
        input_tokens=10,
        output_tokens=20,
        thinking_tokens=0,
        cost_usd=0.0,
        latency_ms=10,
        error=error,
        raw_response=None,
        stop_reason="end_turn",
    )


# ===========================================================================
# A1. _run_iteration_pipeline clears tdd_mismatches + audits for active coders
# ===========================================================================


async def test_iteration_pipeline_clears_tdd_mismatches_and_audits():
    """A.1 — `_run_iteration_pipeline` must clear stale tdd_mismatches +
    audits for each active coder before running pipelines."""
    orch = _make_orchestrator(n_coders=2, n_testers=0, has_summarizer=False)

    # Seed leftover state from a previous iteration.
    orch.state.tdd_mismatches[0] = {"description": "stale"}
    orch.state.tdd_mismatches[1] = {"description": "stale-2"}
    orch.state.audits[0] = [{"old": "audit"}]
    orch.state.audits[1] = [{"old": "audit"}]

    # Stub _run_coder_pipeline to a noop so we can observe the pre-clear.
    seen_audits: dict[int, list] = {}
    seen_tdd: dict[int, dict] = {}

    async def _fake_pipeline(*, coder, **_kw):
        # Capture state at the moment the pipeline starts running.
        seen_audits[coder.agent_index] = list(orch.state.audits.get(coder.agent_index, []))
        seen_tdd[coder.agent_index] = dict(orch.state.tdd_mismatches)

    orch._run_coder_pipeline = AsyncMock(side_effect=_fake_pipeline)

    await orch._run_iteration_pipeline()

    # By the time per-coder pipelines run, audits[ci] must already be []
    # and tdd_mismatches must be fully cleared.
    assert seen_audits[0] == []
    assert seen_audits[1] == []
    # tdd_mismatches dict should be empty when the first pipeline starts.
    assert seen_tdd[0] == {}
    assert seen_tdd[1] == {}


async def test_iteration_pipeline_no_active_coders_short_circuits():
    """No active coders → returns without raising, no failure flag."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=False)
    orch.state.finished_coders.add(0)  # all coders done

    orch._run_coder_pipeline = AsyncMock()
    await orch._run_iteration_pipeline()

    orch._run_coder_pipeline.assert_not_awaited()
    assert orch.state.failed is False
    assert orch.state.should_stop is False


async def test_iteration_pipeline_no_code_versions_sets_failed():
    """If no coder produced any code, workflow flips to failed/should_stop."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=False)
    orch._run_coder_pipeline = AsyncMock(return_value=None)
    # State.code_versions stays empty → guard triggers.

    await orch._run_iteration_pipeline()

    assert orch.state.failed is True
    assert orch.state.should_stop is True
    assert orch.state.error and "no code generated" in orch.state.error.lower()


# ===========================================================================
# A2. Concurrent execution — slow coder doesn't block fast coder's testers
# ===========================================================================


async def test_pipeline_fast_coder_testers_start_before_slow_coder_returns():
    """A.2 — Coder 0 finishes immediately, Coder 1 finishes slowly. The
    tester call for coder_index=0 MUST occur before coder_index=1's
    `_run_coder` returns."""
    orch = _make_orchestrator(n_coders=2, n_testers=1, has_summarizer=False)

    # Tracking events for ordering verification.
    coder_1_returned = asyncio.Event()
    tester_for_0_started = asyncio.Event()
    timeline: list[str] = []

    async def fake_coder(*, coder, **_kw):
        if coder.agent_index == 0:
            orch.state.code_versions[0] = "print('fast')"
            timeline.append("coder0_done")
            return _make_agent_result()
        else:
            # Slow coder — wait until the tester for coder 0 has started.
            try:
                await asyncio.wait_for(tester_for_0_started.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                pass
            orch.state.code_versions[1] = "print('slow')"
            timeline.append("coder1_done")
            coder_1_returned.set()
            return _make_agent_result()

    async def fake_tester(*, tester, code, coder_index, execution_result):
        if coder_index == 0:
            timeline.append("tester_for_coder0_started")
            tester_for_0_started.set()
            # Hold briefly to make ordering unambiguous.
            await asyncio.sleep(0.01)
        return SimpleNamespace(success=True)

    orch._run_coder = AsyncMock(side_effect=fake_coder)
    orch._run_tester = AsyncMock(side_effect=fake_tester)

    await orch._run_iteration_pipeline()

    # Tester for coder 0 must appear in timeline BEFORE coder1_done.
    assert "tester_for_coder0_started" in timeline, timeline
    assert "coder1_done" in timeline, timeline
    assert timeline.index("tester_for_coder0_started") < timeline.index("coder1_done"), (
        f"Expected tester(coder=0) to start before coder 1 returns; got {timeline}"
    )


# ===========================================================================
# A3. _finalize_coder_result — all branches
# ===========================================================================


async def test_finalize_coder_result_handles_timeout_no_prior_code():
    """TimeoutError with no fallback code: emits agent_error, no increment."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=False)
    coder = orch.coders[0]
    snap = {0: 0}

    await orch._finalize_coder_result(
        coder, asyncio.TimeoutError(), snap, agent_timeout=10
    )

    # No increment when no fallback.
    assert orch.state.coders_completed == 0
    # agent_error emit happened.
    types = [c.args[0] for c in orch.emit_event.await_args_list]
    assert "agent_error" in types


async def test_finalize_coder_result_timeout_with_fallback_code():
    """TimeoutError WITH previous code: increments coders_completed."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=False)
    coder = orch.coders[0]
    orch.state.code_versions[0] = "print('prev')"
    snap = {0: 0}

    await orch._finalize_coder_result(
        coder, asyncio.TimeoutError(), snap, agent_timeout=10
    )

    assert orch.state.coders_completed == 1
    assert orch.state.coder_iterations[0] == 1


async def test_finalize_coder_result_cancelled_error():
    """CancelledError treated like timeout: graceful, doesn't propagate."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=False)
    coder = orch.coders[0]
    orch.state.code_versions[0] = "print('prev')"
    snap = {0: 0}

    # Must not raise.
    await orch._finalize_coder_result(
        coder, asyncio.CancelledError(), snap, agent_timeout=10
    )
    assert orch.state.coders_completed == 1


async def test_finalize_coder_result_generic_exception_with_fallback():
    """Generic Exception + previous code → fallback, emits agent_fallback."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=False)
    coder = orch.coders[0]
    orch.state.code_versions[0] = "print('prev')"
    snap = {0: 0}

    await orch._finalize_coder_result(
        coder, RuntimeError("boom"), snap, agent_timeout=10
    )

    assert orch.state.coders_completed == 1
    types = [c.args[0] for c in orch.emit_event.await_args_list]
    assert "agent_fallback" in types


async def test_finalize_coder_result_generic_exception_no_fallback():
    """Generic Exception with NO previous code: no fallback, no increment, no crash."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=False)
    coder = orch.coders[0]
    snap = {0: 0}

    # Must not raise.
    await orch._finalize_coder_result(
        coder, RuntimeError("boom"), snap, agent_timeout=10
    )
    assert orch.state.coders_completed == 0


async def test_finalize_coder_result_base_exception():
    """A BaseException (not Exception) is logged + agent_error emitted, no increment."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=False)
    coder = orch.coders[0]
    snap = {0: 0}

    # KeyboardInterrupt is a BaseException (but not Exception).
    await orch._finalize_coder_result(
        coder, KeyboardInterrupt(), snap, agent_timeout=10
    )

    assert orch.state.coders_completed == 0


async def test_finalize_coder_result_success_no_execution():
    """AgentResult success=True with execution disabled → no exec path."""
    orch = _make_orchestrator(
        n_coders=1, n_testers=0, has_summarizer=False, enable_code_execution=False
    )
    coder = orch.coders[0]
    orch.state.code_versions[0] = "print('hi')"
    snap = {0: 0}

    await orch._finalize_coder_result(
        coder, _make_agent_result(success=True), snap, agent_timeout=10
    )

    orch._execute_and_fix_code.assert_not_awaited()


async def test_finalize_coder_result_success_with_execution():
    """AgentResult success=True with execution enabled → _execute_and_fix_code runs."""
    orch = _make_orchestrator(
        n_coders=1, n_testers=0, has_summarizer=False, enable_code_execution=True
    )
    coder = orch.coders[0]
    orch.state.code_versions[0] = "print('hi')"
    snap = {0: 0}

    exec_result = SimpleNamespace(
        stdout="hi\n", stderr="", exit_code=0, timeout_exceeded=False,
        to_dict=lambda: {"stdout": "hi\n", "stderr": "", "exit_code": 0},
    )
    orch._execute_and_fix_code.return_value = ("print('hi')", exec_result)

    await orch._finalize_coder_result(
        coder, _make_agent_result(success=True), snap, agent_timeout=10
    )

    orch._execute_and_fix_code.assert_awaited_once()


async def test_finalize_coder_result_success_false_with_fallback():
    """result.success=False + previous code → fallback path, coders_completed++."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=False)
    coder = orch.coders[0]
    orch.state.code_versions[0] = "print('prev')"
    snap = {0: 0}

    await orch._finalize_coder_result(
        coder, _make_agent_result(success=False, error="LLM error"), snap, agent_timeout=10
    )

    assert orch.state.coders_completed == 1
    types = [c.args[0] for c in orch.emit_event.await_args_list]
    assert "agent_fallback" in types


async def test_finalize_coder_result_success_false_no_fallback():
    """result.success=False + NO previous code → no increment, no crash."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=False)
    coder = orch.coders[0]
    snap = {0: 0}

    await orch._finalize_coder_result(
        coder, _make_agent_result(success=False, error="no code"), snap, agent_timeout=10
    )
    assert orch.state.coders_completed == 0


async def test_finalize_coder_result_tdd_mismatch_recorded():
    """Expected output set + actual stdout doesn't contain it → tdd_mismatch recorded."""
    orch = _make_orchestrator(
        n_coders=1,
        n_testers=0,
        has_summarizer=False,
        enable_code_execution=True,
        expected_output="WANTED",
    )
    coder = orch.coders[0]
    orch.state.code_versions[0] = "print('something else')"
    snap = {0: 0}

    exec_result = SimpleNamespace(
        stdout="actual output without the wanted marker",
        stderr="",
        exit_code=0,
        timeout_exceeded=False,
        to_dict=lambda: {"stdout": "actual output", "stderr": "", "exit_code": 0},
    )
    orch._execute_and_fix_code.return_value = ("print('something else')", exec_result)

    await orch._finalize_coder_result(
        coder, _make_agent_result(success=True), snap, agent_timeout=10
    )

    assert 0 in orch.state.tdd_mismatches
    mismatch = orch.state.tdd_mismatches[0]
    assert mismatch["severity"] == "critical"
    assert mismatch["category"] == "test_driven"


async def test_finalize_coder_result_tdd_no_mismatch_when_match():
    """Expected output is present in actual output → no tdd_mismatch added."""
    orch = _make_orchestrator(
        n_coders=1,
        n_testers=0,
        has_summarizer=False,
        enable_code_execution=True,
        expected_output="hello",
    )
    coder = orch.coders[0]
    orch.state.code_versions[0] = "print('hello world')"
    snap = {0: 0}

    exec_result = SimpleNamespace(
        stdout="hello world\n",
        stderr="",
        exit_code=0,
        timeout_exceeded=False,
        to_dict=lambda: {"stdout": "hello world\n", "stderr": "", "exit_code": 0},
    )
    orch._execute_and_fix_code.return_value = ("print('hello world')", exec_result)

    await orch._finalize_coder_result(
        coder, _make_agent_result(success=True), snap, agent_timeout=10
    )

    assert 0 not in orch.state.tdd_mismatches


# ===========================================================================
# A4. _state_lock stress — concurrent pipelines must not race on counters.
# ===========================================================================


async def test_state_lock_protects_concurrent_completion_counters():
    """A.4 — Run 5 pipelines concurrently; coders_completed must equal 5
    (no lost increments due to race)."""
    orch = _make_orchestrator(n_coders=5, n_testers=0, has_summarizer=False)

    # Each coder fails with previous code → goes through async-with lock path.
    for i in range(5):
        orch.state.code_versions[i] = f"prev_{i}"
    snap = {i: 0 for i in range(5)}

    async def _run(i):
        await orch._finalize_coder_result(
            orch.coders[i],
            RuntimeError("fail"),  # Exception path uses _state_lock
            snap,
            agent_timeout=10,
        )

    await asyncio.gather(*(_run(i) for i in range(5)))

    assert orch.state.coders_completed == 5
    # And each coder's iteration counter bumped exactly once.
    assert all(orch.state.coder_iterations[i] == 1 for i in range(5))


async def test_state_lock_protects_testers_completed_counter():
    """Tester increment is also under _state_lock — concurrent pipelines OK."""
    orch = _make_orchestrator(n_coders=3, n_testers=2, has_summarizer=False)

    async def fake_coder(*, coder, **_kw):
        orch.state.code_versions[coder.agent_index] = f"print({coder.agent_index})"
        return _make_agent_result()

    async def fake_tester(*, tester, code, coder_index, execution_result):
        # All testers succeed.
        return SimpleNamespace(success=True)

    orch._run_coder = AsyncMock(side_effect=fake_coder)
    orch._run_tester = AsyncMock(side_effect=fake_tester)

    await orch._run_iteration_pipeline()

    # 3 coders × 2 testers each = 6 successful tester results
    assert orch.state.testers_completed == 6
    assert orch.state.coders_completed == 3


# ===========================================================================
# A5. asyncio.gather(return_exceptions=True) — one pipeline raises, others continue
# ===========================================================================


async def test_one_pipeline_exception_does_not_block_others():
    """A.5 — If one coder pipeline raises, other pipelines still complete."""
    orch = _make_orchestrator(n_coders=3, n_testers=0, has_summarizer=False)

    async def fake_pipeline(*, coder, **_kw):
        if coder.agent_index == 1:
            raise RuntimeError("pipeline 1 exploded")
        # Pipelines 0 and 2 succeed and bump counter directly.
        orch.state.code_versions[coder.agent_index] = "ok"
        async with orch._state_lock:
            orch.state.coders_completed += 1

    orch._run_coder_pipeline = AsyncMock(side_effect=fake_pipeline)

    # Should not raise even though pipeline 1 errored.
    await orch._run_iteration_pipeline()

    # Coders 0 and 2 successfully recorded.
    assert orch.state.coders_completed == 2
    assert 0 in orch.state.code_versions
    assert 2 in orch.state.code_versions
    assert orch.state.failed is False  # Workflow not failed because some code exists


# ===========================================================================
# A6. Old phase methods are not called from the main workflow loop
# ===========================================================================


async def test_old_phase_methods_not_called_from_main_loop():
    """The pipelined orchestrator must NOT call the legacy `_run_coding_phase`,
    `_run_testing_phase`, or `_run_summarizing_phase` from the main workflow
    loop. We verify by scanning the orchestrator source for direct method
    calls."""
    try:
        from app.core import orchestrator as orch_mod
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"orchestrator not importable: {exc!r}")

    import inspect

    src = inspect.getsource(orch_mod.WorkflowOrchestrator)
    # The methods may still exist as DEAD code, but their `self.X` callsite
    # must not appear anywhere except the main loop's replacement.
    for legacy in ("self._run_coding_phase(", "self._run_testing_phase(", "self._run_summarizing_phase("):
        assert legacy not in src, f"legacy callsite found: {legacy!r}"


# ===========================================================================
# A7. _run_coder_pipeline — skip testers/summarizer when no code produced
# ===========================================================================


async def test_pipeline_skips_testers_when_coder_produces_no_code():
    """If `_finalize_coder_result` doesn't write code_versions, the pipeline
    must skip testers + summarizer (otherwise testers run against no code)."""
    orch = _make_orchestrator(n_coders=1, n_testers=2, has_summarizer=True)

    # _run_coder raises → finalize handles exception but no fallback code,
    # so state.code_versions[0] stays empty.
    orch._run_coder = AsyncMock(side_effect=RuntimeError("coder broke"))

    await orch._run_coder_pipeline(
        coder=orch.coders[0],
        previous_code=None,
        audit_summary=None,
        coder_iter_snapshot={0: 0},
        agent_timeout=10,
    )

    orch._run_tester.assert_not_awaited()
    orch._run_summarizer.assert_not_awaited()


async def test_pipeline_runs_summarizer_only_when_audits_present():
    """Summarizer is only invoked if there are audits for the coder."""
    orch = _make_orchestrator(n_coders=1, n_testers=0, has_summarizer=True)
    orch._run_coder = AsyncMock(return_value=_make_agent_result())

    async def coder_writes(*, coder, **_kw):
        orch.state.code_versions[coder.agent_index] = "print('ok')"
        return _make_agent_result()

    orch._run_coder = AsyncMock(side_effect=coder_writes)

    # No testers → no audits will be appended → summarizer must not run.
    await orch._run_coder_pipeline(
        coder=orch.coders[0],
        previous_code=None,
        audit_summary=None,
        coder_iter_snapshot={0: 0},
        agent_timeout=10,
    )

    orch._run_summarizer.assert_not_awaited()
