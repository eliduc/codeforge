"""КАО#R5-cost-test — behavioral unit tests for the cost circuit breaker.

The cost circuit breaker (``WorkflowOrchestrator._apply_cost_circuit_breaker``)
is money-loss prevention: it must stop a session once accumulated spend passes
the configured cap. Previously it had ZERO test coverage, so a refactor that
flipped the comparison, dropped ``should_stop = True``, or mishandled a
``Decimal`` cap could let a session keep spending unnoticed.

These are pure unit tests: we bypass the real constructor (no DB / no agents)
via ``__new__`` and drive the extracted method directly, asserting on the
resulting orchestrator STATE (behavioral) rather than on source text.
"""
from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

pytestmark = pytest.mark.asyncio


def _make_orch(*, cost_limit, total_cost):
    """Bare orchestrator wired with just enough state for the breaker."""
    try:
        from app.core.orchestrator import WorkflowOrchestrator, WorkflowState
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"backend modules not importable: {exc!r}")

    import uuid

    orch = WorkflowOrchestrator.__new__(WorkflowOrchestrator)
    orch.state = WorkflowState(session_id=uuid.uuid4(), max_iterations=3)
    orch.state.total_cost = total_cost
    orch.session = SimpleNamespace(cost_limit_usd=cost_limit)
    orch.emit_event = AsyncMock(return_value=None)
    return orch


async def test_stops_when_cost_exceeds_limit():
    orch = _make_orch(cost_limit=0.10, total_cost=0.50)

    await orch._apply_cost_circuit_breaker()

    assert orch.state.should_stop is True
    assert orch.state.failed is True
    assert orch.state.error == "Cost limit exceeded"
    orch.emit_event.assert_awaited_once()
    event_name, payload = orch.emit_event.await_args.args
    assert event_name == "cost_limit_exceeded"
    assert payload["limit"] == 0.10
    assert payload["cost_usd"] == 0.50


async def test_does_not_stop_when_under_limit():
    orch = _make_orch(cost_limit=1.00, total_cost=0.50)

    await orch._apply_cost_circuit_breaker()

    assert orch.state.should_stop is False
    assert orch.state.failed is False
    orch.emit_event.assert_not_awaited()


async def test_does_not_stop_at_exactly_the_limit():
    # Strictly greater-than is the intended boundary — at the cap we keep going.
    orch = _make_orch(cost_limit=0.50, total_cost=0.50)

    await orch._apply_cost_circuit_breaker()

    assert orch.state.should_stop is False


async def test_no_limit_configured_never_stops():
    orch = _make_orch(cost_limit=None, total_cost=999.0)

    await orch._apply_cost_circuit_breaker()

    assert orch.state.should_stop is False
    orch.emit_event.assert_not_awaited()


async def test_decimal_limit_is_honored():
    # cost_limit_usd may arrive as a Decimal from the DB — it must still trip.
    orch = _make_orch(cost_limit=Decimal("0.10"), total_cost=0.50)

    await orch._apply_cost_circuit_breaker()

    assert orch.state.should_stop is True
    assert orch.state.error == "Cost limit exceeded"


async def test_unparseable_limit_does_not_crash_or_stop():
    orch = _make_orch(cost_limit="not-a-number", total_cost=999.0)

    await orch._apply_cost_circuit_breaker()  # must not raise

    assert orch.state.should_stop is False
    orch.emit_event.assert_not_awaited()
