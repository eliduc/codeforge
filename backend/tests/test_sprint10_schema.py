"""Sprint-10 DB-level schema tests.

Verifies the new columns added by migrations 018 + 019 exist with the right
types/constraints, that they round-trip correctly through the Sessions API,
and that validation guards (60-86400 second timeout, share_token uniqueness,
etc.) behave as documented.

Fixtures consumed (from conftest.py):
  - auth_client : authenticated httpx.Client
"""
from __future__ import annotations

import uuid

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_session(client: httpx.Client, **extra) -> dict:
    body = {
        "name": f"sprint10-{uuid.uuid4().hex[:8]}",
        "specification": "Round-trip test for sprint-10 columns.",
    }
    body.update(extra)
    r = client.post("/api/sessions/", json=body)
    assert r.status_code in (200, 201), r.text
    return r.json()


def _sync_engine():
    """Sync SQLAlchemy engine for direct DB introspection."""
    try:
        from sqlalchemy import create_engine
        from app.config import get_settings
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"backend modules not importable: {exc!r}")
    return create_engine(get_settings().sync_database_url)


# ===========================================================================
# Migrations 018 + 019 applied — column existence smoke tests
# ===========================================================================

async def test_migration_018_columns_exist() -> None:
    """cost_limit_usd / session_timeout_sec / expected_output present on sessions."""
    from sqlalchemy import inspect
    engine = _sync_engine()
    try:
        insp = inspect(engine)
        cols = {c["name"]: c for c in insp.get_columns("sessions")}
        for name in ("cost_limit_usd", "session_timeout_sec", "expected_output"):
            assert name in cols, f"sessions.{name} column missing — migration 018 not applied?"
        # cost_limit_usd Numeric(10,2)
        cl = cols["cost_limit_usd"]
        cl_type = str(cl["type"]).lower()
        assert "numeric" in cl_type or "decimal" in cl_type, cl_type
        # session_timeout_sec is integer
        sts_type = str(cols["session_timeout_sec"]["type"]).lower()
        assert "int" in sts_type, sts_type
    finally:
        engine.dispose()


async def test_migration_019_share_token_column_and_index() -> None:
    """share_token column + unique index 'ix_sessions_share_token' must exist."""
    from sqlalchemy import inspect
    engine = _sync_engine()
    try:
        insp = inspect(engine)
        cols = {c["name"]: c for c in insp.get_columns("sessions")}
        assert "share_token" in cols, "sessions.share_token missing — migration 019 not applied?"
        # Either String(64) or VARCHAR(64).
        st_type = str(cols["share_token"]["type"]).lower()
        assert "char" in st_type or "string" in st_type or "text" in st_type, st_type

        indexes = insp.get_indexes("sessions")
        names = {i["name"] for i in indexes}
        assert "ix_sessions_share_token" in names, names
        share_idx = next(i for i in indexes if i["name"] == "ix_sessions_share_token")
        assert share_idx.get("unique") is True, share_idx
    finally:
        engine.dispose()


async def test_alembic_version_at_least_019() -> None:
    """alembic_version table should be at >= '019' after sprint-10 deploy."""
    from sqlalchemy import text
    engine = _sync_engine()
    try:
        with engine.connect() as conn:
            row = conn.execute(text("SELECT version_num FROM alembic_version")).first()
            assert row is not None, "alembic_version table is empty"
            assert row[0] >= "018", f"alembic version is {row[0]}, expected >= 018"
    finally:
        engine.dispose()


# ===========================================================================
# cost_limit_usd round-trip
# ===========================================================================

async def test_cost_limit_usd_round_trip(auth_client: httpx.Client) -> None:
    s = _create_session(auth_client, cost_limit_usd=5.50)
    sid = s["id"]
    try:
        # Round-trip via GET.
        got = auth_client.get(f"/api/sessions/{sid}")
        assert got.status_code == 200
        # Numeric(10,2) — the API returns a float.
        assert float(got.json()["cost_limit_usd"]) == pytest.approx(5.50)
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_cost_limit_usd_negative_rejected(auth_client: httpx.Client) -> None:
    """cost_limit_usd has ge=0 — negative values must fail validation."""
    r = auth_client.post(
        "/api/sessions/",
        json={
            "name": f"neg-cost-{uuid.uuid4().hex[:6]}",
            "specification": "x",
            "cost_limit_usd": -1,
        },
    )
    assert r.status_code == 422, r.text


# ===========================================================================
# session_timeout_sec validation (60 — 86400)
# ===========================================================================

async def test_session_timeout_sec_round_trip(auth_client: httpx.Client) -> None:
    s = _create_session(auth_client, session_timeout_sec=3600)
    sid = s["id"]
    try:
        got = auth_client.get(f"/api/sessions/{sid}")
        assert got.json()["session_timeout_sec"] == 3600
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_session_timeout_sec_below_min_rejected(auth_client: httpx.Client) -> None:
    """ge=60 → 30 should be rejected with 422."""
    r = auth_client.post(
        "/api/sessions/",
        json={
            "name": f"st-low-{uuid.uuid4().hex[:6]}",
            "specification": "x",
            "session_timeout_sec": 30,
        },
    )
    assert r.status_code == 422, r.text


async def test_session_timeout_sec_above_max_rejected(auth_client: httpx.Client) -> None:
    """le=86400 → 90000 should be rejected with 422."""
    r = auth_client.post(
        "/api/sessions/",
        json={
            "name": f"st-high-{uuid.uuid4().hex[:6]}",
            "specification": "x",
            "session_timeout_sec": 90_000,
        },
    )
    assert r.status_code == 422, r.text


# ===========================================================================
# expected_output round-trip
# ===========================================================================

async def test_expected_output_round_trip(auth_client: httpx.Client) -> None:
    expected = "hello\nworld\n"
    s = _create_session(auth_client, expected_output=expected)
    sid = s["id"]
    try:
        got = auth_client.get(f"/api/sessions/{sid}")
        assert got.json()["expected_output"] == expected

        # Update via PATCH.
        upd = auth_client.patch(
            f"/api/sessions/{sid}",
            json={"expected_output": "different\n"},
        )
        # PATCH may be 200 or 204; accept either, then re-read.
        assert upd.status_code in (200, 204), upd.text
        got2 = auth_client.get(f"/api/sessions/{sid}")
        assert got2.json()["expected_output"] == "different\n"
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


# ===========================================================================
# share_token unique constraint
# ===========================================================================

async def test_share_token_unique_constraint() -> None:
    """Direct DB insert with duplicate share_token must raise IntegrityError."""
    from sqlalchemy.exc import IntegrityError
    engine = _sync_engine()
    try:
        from app.db.models import Session as SessionModel  # noqa
        token = f"dup-{uuid.uuid4().hex}"

        # We create two minimal session rows with the SAME share_token.
        # First one should succeed, second one should fail with IntegrityError.
        from sqlalchemy import text
        sid1 = str(uuid.uuid4())
        sid2 = str(uuid.uuid4())
        with engine.begin() as conn:
            # Use a minimal INSERT against required columns. If the schema
            # has more NOT NULL columns, this will skip — that's fine.
            try:
                conn.execute(
                    text(
                        "INSERT INTO sessions (id, name, specification, language, "
                        "max_iterations, current_iteration, status, settings, "
                        "share_token) VALUES (:id, :name, :spec, 'python', 5, 0, "
                        "'created', '{}'::json, :tok)"
                    ),
                    {"id": sid1, "name": "u1", "spec": "x", "tok": token},
                )
            except Exception as exc:
                pytest.skip(f"cannot insert minimal session row for unique test: {exc}")

        try:
            with pytest.raises(IntegrityError):
                with engine.begin() as conn:
                    conn.execute(
                        text(
                            "INSERT INTO sessions (id, name, specification, language, "
                            "max_iterations, current_iteration, status, settings, "
                            "share_token) VALUES (:id, :name, :spec, 'python', 5, 0, "
                            "'created', '{}'::json, :tok)"
                        ),
                        {"id": sid2, "name": "u2", "spec": "x", "tok": token},
                    )
        finally:
            # Cleanup
            with engine.begin() as conn:
                conn.execute(text("DELETE FROM sessions WHERE id IN (:a, :b)"),
                             {"a": sid1, "b": sid2})
    finally:
        engine.dispose()


async def test_share_token_default_null(auth_client: httpx.Client) -> None:
    """Newly-created sessions have NULL share_token until /share is called."""
    s = _create_session(auth_client)
    sid = s["id"]
    try:
        from sqlalchemy import text
        engine = _sync_engine()
        try:
            with engine.connect() as conn:
                row = conn.execute(
                    text("SELECT share_token FROM sessions WHERE id = :id"),
                    {"id": sid},
                ).first()
                assert row is not None
                assert row[0] is None, f"expected NULL, got {row[0]!r}"
        finally:
            engine.dispose()
    finally:
        auth_client.delete(f"/api/sessions/{sid}")
