"""Tests for num_coders / num_testers expansion in POST /api/sessions/.

Bug fixed: CreateSessionRequest accepted num_coders / num_testers integer
fields but the create_session endpoint silently ignored them and always
created the same default 1-coder / 2-tester layout.

Two test tiers:

1. Schema-level (always run): exercises the Pydantic validator on
   SessionCreate, so the 422 cases (num_coders=0 / =10) can be verified
   without a live backend.

2. E2E (require auth_client + backend, marked ``e2e``): exercises the actual
   POST /api/sessions/ endpoint, verifying the resulting agent_configs rows
   contain the right counts.

This pairs with the changes in:
  - backend/app/schemas/__init__.py  (added num_coders / num_testers fields)
  - backend/app/api/routes/sessions.py (expanded create_session)
"""
from __future__ import annotations

import uuid

import httpx
import pytest


# ---------------------------------------------------------------------------
# Schema-level tests: validation. These run without backend, ALLOWED_EMAILS,
# or a database — they just instantiate the Pydantic model.
# ---------------------------------------------------------------------------


def _load_create_schema():
    try:
        from app.schemas import SessionCreate
        from pydantic import ValidationError
        return SessionCreate, ValidationError
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")


def test_schema_num_coders_zero_rejected():
    """num_coders=0 must fail Pydantic validation (ge=1 → 422 at route)."""
    SessionCreate, ValidationError = _load_create_schema()
    with pytest.raises(ValidationError) as exc_info:
        SessionCreate(name="x", specification="noop", num_coders=0)
    # Make sure the failure points at num_coders, not something else.
    errs = exc_info.value.errors()
    assert any("num_coders" in str(e.get("loc", ())) for e in errs), errs


def test_schema_num_coders_ten_rejected():
    """num_coders=10 exceeds the [1,4] cap and must fail validation."""
    SessionCreate, ValidationError = _load_create_schema()
    with pytest.raises(ValidationError) as exc_info:
        SessionCreate(name="x", specification="noop", num_coders=10)
    errs = exc_info.value.errors()
    assert any("num_coders" in str(e.get("loc", ())) for e in errs), errs


def test_schema_num_testers_zero_rejected():
    SessionCreate, ValidationError = _load_create_schema()
    with pytest.raises(ValidationError) as exc_info:
        SessionCreate(name="x", specification="noop", num_testers=0)
    errs = exc_info.value.errors()
    assert any("num_testers" in str(e.get("loc", ())) for e in errs), errs


def test_schema_num_testers_ten_rejected():
    SessionCreate, ValidationError = _load_create_schema()
    with pytest.raises(ValidationError) as exc_info:
        SessionCreate(name="x", specification="noop", num_testers=10)
    errs = exc_info.value.errors()
    assert any("num_testers" in str(e.get("loc", ())) for e in errs), errs


def test_schema_defaults_are_one_and_two():
    """When neither field is supplied, defaults must match the legacy layout
    (1 coder + 2 testers) so callers that omit the fields don't regress."""
    SessionCreate, _ = _load_create_schema()
    s = SessionCreate(name="x", specification="noop")
    assert s.num_coders == 1
    assert s.num_testers == 2


def test_schema_accepts_in_range_values():
    """All boundary-valid values 1..4 should round-trip cleanly."""
    SessionCreate, _ = _load_create_schema()
    for n in (1, 2, 3, 4):
        s = SessionCreate(name="x", specification="noop", num_coders=n, num_testers=n)
        assert s.num_coders == n and s.num_testers == n


# ---------------------------------------------------------------------------
# E2E tests: exercise the live POST /api/sessions/ endpoint. These need an
# authenticated httpx.Client (provided by conftest's ``auth_client`` fixture)
# and a running backend. Skipped automatically when those aren't available.
# ---------------------------------------------------------------------------

pytestmark_e2e = [pytest.mark.asyncio, pytest.mark.e2e]


def _count_by_type(configs: list[dict], agent_type: str) -> int:
    return sum(1 for c in configs if c.get("agent_type") == agent_type)


@pytest.mark.asyncio
@pytest.mark.e2e
async def test_create_session_num_coders_3_num_testers_2(auth_client: httpx.Client) -> None:
    """num_coders=3, num_testers=2 → 3 coder rows + 2 tester rows in DB."""
    payload = {
        "name": f"cf-expand-{uuid.uuid4().hex[:8]}",
        "specification": "Print hello world.",
        "language": "javascript_browser",
        "max_iterations": 2,
        "num_coders": 3,
        "num_testers": 2,
    }
    r = auth_client.post("/api/sessions/", json=payload)
    assert r.status_code in (200, 201), r.text
    body = r.json()
    sid = body["id"]
    try:
        # Fetch to get agent_configs with full data
        got = auth_client.get(f"/api/sessions/{sid}")
        assert got.status_code == 200, got.text
        configs = got.json().get("agent_configs", [])
        assert _count_by_type(configs, "coder") == 3, configs
        assert _count_by_type(configs, "tester") == 2, configs
        # Coder indices must be 0..N-1 (contiguous, no dupes).
        coder_idx = sorted(c["agent_index"] for c in configs if c["agent_type"] == "coder")
        assert coder_idx == [0, 1, 2], coder_idx
        tester_idx = sorted(c["agent_index"] for c in configs if c["agent_type"] == "tester")
        assert tester_idx == [0, 1], tester_idx
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


@pytest.mark.asyncio
@pytest.mark.e2e
async def test_create_session_num_coders_1_num_testers_1(auth_client: httpx.Client) -> None:
    """num_coders=1, num_testers=1 → exactly 1 + 1 rows."""
    payload = {
        "name": f"cf-expand-{uuid.uuid4().hex[:8]}",
        "specification": "noop",
        "num_coders": 1,
        "num_testers": 1,
    }
    r = auth_client.post("/api/sessions/", json=payload)
    assert r.status_code in (200, 201), r.text
    sid = r.json()["id"]
    try:
        got = auth_client.get(f"/api/sessions/{sid}")
        configs = got.json().get("agent_configs", [])
        assert _count_by_type(configs, "coder") == 1, configs
        assert _count_by_type(configs, "tester") == 1, configs
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


@pytest.mark.asyncio
@pytest.mark.e2e
async def test_create_session_explicit_agent_configs_wins(auth_client: httpx.Client) -> None:
    """When agent_configs is explicit, num_coders/num_testers must be ignored."""
    payload = {
        "name": f"cf-expand-{uuid.uuid4().hex[:8]}",
        "specification": "noop",
        # Explicit list with only one config; ignore num_coders=4.
        "num_coders": 4,
        "num_testers": 4,
        "agent_configs": [
            {
                "agent_type": "coder",
                "agent_index": 0,
                "llm_provider": "anthropic",
                "llm_model": "claude-sonnet-4-6",
            },
        ],
    }
    r = auth_client.post("/api/sessions/", json=payload)
    assert r.status_code in (200, 201), r.text
    sid = r.json()["id"]
    try:
        got = auth_client.get(f"/api/sessions/{sid}")
        configs = got.json().get("agent_configs", [])
        # Only the explicit config → 1 coder, no testers.
        assert _count_by_type(configs, "coder") == 1, configs
        assert _count_by_type(configs, "tester") == 0, configs
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


@pytest.mark.asyncio
@pytest.mark.e2e
async def test_create_session_num_coders_zero_returns_422(auth_client: httpx.Client) -> None:
    """num_coders=0 must be rejected by FastAPI/Pydantic with 422."""
    payload = {
        "name": f"cf-expand-{uuid.uuid4().hex[:8]}",
        "specification": "noop",
        "num_coders": 0,
    }
    r = auth_client.post("/api/sessions/", json=payload)
    assert r.status_code == 422, r.text


@pytest.mark.asyncio
@pytest.mark.e2e
async def test_create_session_num_coders_ten_returns_422(auth_client: httpx.Client) -> None:
    """num_coders=10 exceeds the [1,4] cap → 422."""
    payload = {
        "name": f"cf-expand-{uuid.uuid4().hex[:8]}",
        "specification": "noop",
        "num_coders": 10,
    }
    r = auth_client.post("/api/sessions/", json=payload)
    assert r.status_code == 422, r.text
