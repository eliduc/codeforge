"""End-to-end authenticated tests for CodeForge.

Auth fixtures (``async_auth_client``, ``auth_token``, ``test_email``,
``async_created_session``) live in ``conftest.py`` and are shared with any
future test files that need a real JWT and an async HTTP client.

All tests in this file are marked ``e2e`` — run with::

    docker compose exec backend python -m pytest backend/tests/ -v -m e2e

Strategy
--------
``conftest.py`` inserts an OTPCode row directly into the database with a known
plaintext, then calls ``POST /api/auth/verify-otp`` to obtain a real JWT.
This exercises the actual auth code path without scraping email logs.
"""
from __future__ import annotations

import uuid

import httpx
import pytest


pytestmark = [pytest.mark.e2e, pytest.mark.asyncio]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_me_returns_user(async_auth_client: httpx.AsyncClient, test_email: str) -> None:
    """GET /api/auth/me with a valid JWT returns the authenticated user."""
    r = await async_auth_client.get("/api/auth/me")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["email"].lower() == test_email.lower()
    assert body["is_active"] is True
    assert "id" in body


async def test_list_sessions(async_auth_client: httpx.AsyncClient) -> None:
    """GET /api/sessions/ returns either a paginated envelope or a list."""
    r = await async_auth_client.get("/api/sessions/")
    assert r.status_code == 200, r.text
    body = r.json()
    if isinstance(body, dict):
        assert "items" in body or "results" in body or "sessions" in body, body
    else:
        assert isinstance(body, list)


async def test_create_session_minimal(async_auth_client: httpx.AsyncClient) -> None:
    """POST /api/sessions/ with a minimal valid body creates a session."""
    payload = {
        "name": f"auth-flow-smoke-{uuid.uuid4().hex[:6]}",
        "specification": "Print 'hello world' in Python.",
    }
    r = await async_auth_client.post("/api/sessions/", json=payload)
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body.get("id"), f"no id in response: {body}"
    assert body.get("name") == payload["name"]
    # cleanup
    await async_auth_client.delete(f"/api/sessions/{body['id']}")


async def test_create_session_and_get(
    async_auth_client: httpx.AsyncClient, async_created_session: dict
) -> None:
    """Created session is fetchable by id."""
    sid = async_created_session["id"]
    r = await async_auth_client.get(f"/api/sessions/{sid}")
    assert r.status_code == 200, r.text
    assert r.json()["id"] == sid


async def test_patch_session_name(async_auth_client: httpx.AsyncClient) -> None:
    """PATCH /api/sessions/{id} updates a draft session's name."""
    create = await async_auth_client.post(
        "/api/sessions/",
        json={"name": "auth-flow-patch-orig", "specification": "noop"},
    )
    assert create.status_code in (200, 201), create.text
    sid = create.json()["id"]

    try:
        r = await async_auth_client.patch(
            f"/api/sessions/{sid}", json={"name": "auth-flow-patch-new"}
        )
        assert r.status_code in (200, 204), r.text
        got = await async_auth_client.get(f"/api/sessions/{sid}")
        assert got.status_code == 200
        assert got.json().get("name") == "auth-flow-patch-new"
    finally:
        await async_auth_client.delete(f"/api/sessions/{sid}")


async def test_delete_session(async_auth_client: httpx.AsyncClient) -> None:
    """DELETE /api/sessions/{id} removes a draft session."""
    create = await async_auth_client.post(
        "/api/sessions/",
        json={"name": "auth-flow-delete", "specification": "noop"},
    )
    assert create.status_code in (200, 201), create.text
    sid = create.json()["id"]

    r = await async_auth_client.delete(f"/api/sessions/{sid}")
    assert r.status_code in (200, 204), r.text

    got = await async_auth_client.get(f"/api/sessions/{sid}")
    assert got.status_code in (404, 410), f"deleted session still fetchable: {got.status_code}"


async def test_bulk_delete_sessions(async_auth_client: httpx.AsyncClient) -> None:
    """POST /api/sessions/bulk-delete handles a mix of valid + invalid ids."""
    created_ids: list[str] = []
    for i in range(3):
        r = await async_auth_client.post(
            "/api/sessions/",
            json={"name": f"auth-flow-bulk-{i}", "specification": "noop"},
        )
        if r.status_code in (200, 201):
            created_ids.append(r.json()["id"])

    if len(created_ids) < 2:
        pytest.skip("could not create enough sessions for bulk-delete test")

    payload = {"session_ids": created_ids + ["00000000-0000-0000-0000-000000000000"]}
    r = await async_auth_client.post("/api/sessions/bulk-delete", json=payload)
    assert r.status_code in (200, 207), r.text

    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if isinstance(body, dict):
        deleted = body.get("deleted") or body.get("succeeded") or []
        if deleted:
            assert any(cid in deleted for cid in created_ids), (
                f"none of our ids in deleted set: {deleted}"
            )


async def test_dashboard_stats(async_auth_client: httpx.AsyncClient) -> None:
    """GET dashboard stats returns a stats object."""
    last_status = None
    for path in ("/api/code/dashboard/stats", "/api/dashboard/stats"):
        r = await async_auth_client.get(path)
        last_status = r.status_code
        if r.status_code == 200:
            body = r.json()
            assert isinstance(body, dict), f"stats not a dict: {body}"
            return
    pytest.fail(f"dashboard stats endpoint not reachable (last={last_status})")


async def test_token_works_repeatedly(async_auth_client: httpx.AsyncClient) -> None:
    """A JWT remains valid for multiple requests within its TTL."""
    for _ in range(3):
        r = await async_auth_client.get("/api/auth/me")
        assert r.status_code == 200, r.text
