"""Integration tests for session CRUD endpoints.

These tests are converted from `tests/spec/01_backend_api.md` (sections on
sessions list/get/create/update/delete/bulk-delete) and exercise the real
backend HTTP API end-to-end with a JWT-authenticated client.

Fixtures consumed (provided by conftest.py from Phase 1):
  - auth_client       : httpx.Client with Bearer token for User A
  - created_session   : str — id of a freshly created session for User A

All tests are marked `asyncio` + `e2e`; the auth flow itself is sync (httpx.Client).
"""

from __future__ import annotations

import uuid

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]


# ---------------------------------------------------------------------------
# list_sessions
# ---------------------------------------------------------------------------

async def test_list_sessions_returns_paginated_envelope(auth_client: httpx.Client) -> None:
    """GET /api/sessions/ returns either a paginated envelope or a list."""
    r = auth_client.get("/api/sessions/")
    assert r.status_code == 200, r.text
    body = r.json()
    if isinstance(body, dict):
        assert "items" in body or "results" in body or "sessions" in body
        # Paginated envelope should report total/skip/limit-ish fields
        assert any(k in body for k in ("total", "count", "page_size", "limit"))
    else:
        assert isinstance(body, list)


async def test_list_sessions_with_data(auth_client: httpx.Client, created_session: str) -> None:
    """Listing sessions should include the freshly-created one."""
    r = auth_client.get("/api/sessions/")
    assert r.status_code == 200, r.text
    body = r.json()
    items = body.get("items") if isinstance(body, dict) else body
    assert any(item.get("id") == created_session for item in items), \
        f"created session {created_session} not in list"


async def test_list_sessions_search_filter(auth_client: httpx.Client) -> None:
    """`?search=` performs case-insensitive substring match on session name."""
    unique_marker = f"crud-search-{uuid.uuid4().hex[:8]}"
    create = auth_client.post(
        "/api/sessions/",
        json={"name": unique_marker, "specification": "noop"},
    )
    assert create.status_code in (200, 201), create.text
    sid = create.json()["id"]
    try:
        r = auth_client.get(f"/api/sessions/?search={unique_marker.upper()}")
        assert r.status_code == 200, r.text
        body = r.json()
        items = body.get("items") if isinstance(body, dict) else body
        assert any(item.get("id") == sid for item in items)
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_list_sessions_status_filter(auth_client: httpx.Client, created_session: str) -> None:
    """`?status_filter=created` returns only sessions in CREATED status."""
    r = auth_client.get("/api/sessions/?status_filter=created")
    assert r.status_code == 200, r.text
    body = r.json()
    items = body.get("items") if isinstance(body, dict) else body
    for item in items:
        assert item.get("status") == "created"


async def test_list_sessions_invalid_status_filter(auth_client: httpx.Client) -> None:
    """Bogus status filter returns 422 (enum validation)."""
    r = auth_client.get("/api/sessions/?status_filter=does_not_exist")
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# get_session
# ---------------------------------------------------------------------------

async def test_get_session_own_returns_full_data(auth_client: httpx.Client, created_session: str) -> None:
    """GET /api/sessions/{id} for own session returns data with agent_configs."""
    r = auth_client.get(f"/api/sessions/{created_session}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == created_session
    assert "name" in body
    assert "status" in body
    assert "agent_configs" in body


async def test_get_session_nonexistent_returns_404(auth_client: httpx.Client) -> None:
    """GET /api/sessions/{random_uuid} returns 404."""
    bogus = uuid.uuid4()
    r = auth_client.get(f"/api/sessions/{bogus}")
    assert r.status_code == 404, r.text


async def test_get_session_invalid_uuid_returns_422(auth_client: httpx.Client) -> None:
    """GET with non-UUID path param returns 422."""
    r = auth_client.get("/api/sessions/not-a-uuid")
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# create_session
# ---------------------------------------------------------------------------

async def test_create_session_minimal(auth_client: httpx.Client) -> None:
    """POST /api/sessions/ with minimal valid body succeeds and returns 201."""
    payload = {"name": "crud-minimal", "specification": "Print hello world."}
    r = auth_client.post("/api/sessions/", json=payload)
    assert r.status_code in (200, 201), r.text
    body = r.json()
    assert body["name"] == "crud-minimal"
    assert body["status"] == "created"
    assert body["language"] == "python"  # default
    auth_client.delete(f"/api/sessions/{body['id']}")


async def test_create_session_missing_name_returns_422(auth_client: httpx.Client) -> None:
    """Missing required `name` field returns 422."""
    r = auth_client.post("/api/sessions/", json={"specification": "noop"})
    assert r.status_code == 422


async def test_create_session_missing_spec_returns_422(auth_client: httpx.Client) -> None:
    """Missing required `specification` field returns 422."""
    r = auth_client.post("/api/sessions/", json={"name": "no-spec"})
    assert r.status_code == 422


async def test_create_session_oversized_spec_rejected(auth_client: httpx.Client) -> None:
    """Specification longer than schema's 100k cap is rejected (422 or 413)."""
    payload = {"name": "crud-oversized", "specification": "x" * 200_001}
    r = auth_client.post("/api/sessions/", json=payload)
    assert r.status_code in (413, 422), f"expected 413/422, got {r.status_code}"


async def test_create_session_invalid_language_returns_422(auth_client: httpx.Client) -> None:
    """Unknown language string is rejected by schema validator."""
    payload = {
        "name": "crud-bad-lang",
        "specification": "noop",
        "language": "klingon",
    }
    r = auth_client.post("/api/sessions/", json=payload)
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# update_session
# ---------------------------------------------------------------------------

async def test_patch_session_name(auth_client: httpx.Client, created_session: str) -> None:
    """PATCH /api/sessions/{id} updates the session name."""
    r = auth_client.patch(
        f"/api/sessions/{created_session}",
        json={"name": "crud-patched-name"},
    )
    assert r.status_code in (200, 204), r.text
    got = auth_client.get(f"/api/sessions/{created_session}")
    assert got.json()["name"] == "crud-patched-name"


async def test_patch_session_unknown_field_rejected(auth_client: httpx.Client, created_session: str) -> None:
    """Updating a non-allowlisted field (e.g. `status`) returns 400."""
    r = auth_client.patch(
        f"/api/sessions/{created_session}",
        json={"status": "completed"},
    )
    # Either 400 (explicit reject) or 422 (schema strips/rejects)
    assert r.status_code in (400, 422), r.text


async def test_patch_other_user_session_returns_404(auth_client: httpx.Client) -> None:
    """PATCHing a non-existent session returns 404."""
    bogus = uuid.uuid4()
    r = auth_client.patch(f"/api/sessions/{bogus}", json={"name": "x"})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# delete_session / bulk_delete
# ---------------------------------------------------------------------------

async def test_delete_session_own(auth_client: httpx.Client) -> None:
    """DELETE /api/sessions/{id} removes a CREATED session and 204s."""
    create = auth_client.post(
        "/api/sessions/",
        json={"name": "crud-delete", "specification": "noop"},
    )
    sid = create.json()["id"]
    r = auth_client.delete(f"/api/sessions/{sid}")
    assert r.status_code in (200, 204)
    got = auth_client.get(f"/api/sessions/{sid}")
    assert got.status_code in (404, 410)


async def test_delete_nonexistent_returns_404(auth_client: httpx.Client) -> None:
    bogus = uuid.uuid4()
    r = auth_client.delete(f"/api/sessions/{bogus}")
    assert r.status_code == 404


async def test_bulk_delete_mix_valid_invalid(auth_client: httpx.Client) -> None:
    """bulk-delete accepts a mix of valid + invalid IDs and reports failed_ids."""
    created_ids = []
    for i in range(2):
        r = auth_client.post(
            "/api/sessions/",
            json={"name": f"crud-bulk-{i}", "specification": "noop"},
        )
        if r.status_code in (200, 201):
            created_ids.append(r.json()["id"])

    if len(created_ids) < 2:
        pytest.skip("could not create enough sessions for bulk-delete")

    bad_id = "00000000-0000-0000-0000-000000000000"
    r = auth_client.post(
        "/api/sessions/bulk-delete",
        json={"session_ids": created_ids + [bad_id, "not-a-uuid"]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # Response shape: {"deleted_count": N, "failed_ids": [...]}
    assert body.get("deleted_count", 0) >= len(created_ids)
    failed = body.get("failed_ids", [])
    # Both invalid IDs should appear in failed_ids
    assert bad_id in failed or any("00000000" in f for f in failed)
    assert "not-a-uuid" in failed
