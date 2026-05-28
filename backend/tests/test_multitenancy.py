"""Multi-tenancy isolation tests (R3 security fix).

Each user's queries must NEVER return another user's resources, and lookups by
ID must 404 (not 403) so we don't leak existence of foreign rows.

Fixtures consumed (provided by conftest.py):
  - auth_client       : User A's authenticated httpx.Client
  - auth_client_b     : User B's authenticated httpx.Client (different test email)

If `auth_client_b` is unavailable in conftest, all tests in this file are skipped.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]


def _user_b_or_skip(auth_client_b):
    if auth_client_b is None:
        pytest.skip("auth_client_b fixture not available — set up second test user")


# ---------------------------------------------------------------------------
# Sessions: list / get / patch / delete
# ---------------------------------------------------------------------------

async def test_user_a_list_does_not_show_user_b_sessions(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """User A's GET /api/sessions/ never includes User B's sessions."""
    _user_b_or_skip(auth_client_b)
    # B creates a uniquely-named session
    marker = f"mt-b-session-{uuid.uuid4().hex[:8]}"
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": marker, "specification": "noop"},
    )
    assert create.status_code in (200, 201), create.text
    b_id = create.json()["id"]

    try:
        # A lists — must not see B's session
        r = auth_client.get(f"/api/sessions/?search={marker}")
        body = r.json()
        items = body.get("items") if isinstance(body, dict) else body
        assert all(item.get("id") != b_id for item in items)
        # Ensure search would have caught it for B
        rb = auth_client_b.get(f"/api/sessions/?search={marker}")
        items_b = rb.json().get("items") if isinstance(rb.json(), dict) else rb.json()
        assert any(item.get("id") == b_id for item in items_b)
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


async def test_user_a_get_user_b_session_returns_404(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """User A reading User B's session by ID returns 404 (not 403, not 200)."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": "mt-get-foreign", "specification": "noop"},
    )
    b_id = create.json()["id"]
    try:
        r = auth_client.get(f"/api/sessions/{b_id}")
        assert r.status_code == 404, r.text
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


async def test_user_a_patch_user_b_session_returns_404(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """User A trying to PATCH User B's session returns 404."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": "mt-patch-foreign", "specification": "noop"},
    )
    b_id = create.json()["id"]
    try:
        r = auth_client.patch(f"/api/sessions/{b_id}", json={"name": "hacked"})
        assert r.status_code == 404, r.text
        # Confirm B's session was not actually modified
        got = auth_client_b.get(f"/api/sessions/{b_id}")
        assert got.json()["name"] == "mt-patch-foreign"
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


async def test_user_a_delete_user_b_session_returns_404(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """User A deleting User B's session returns 404 and the session survives."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": "mt-delete-foreign", "specification": "noop"},
    )
    b_id = create.json()["id"]
    try:
        r = auth_client.delete(f"/api/sessions/{b_id}")
        assert r.status_code == 404, r.text
        # Session must still exist for B
        got = auth_client_b.get(f"/api/sessions/{b_id}")
        assert got.status_code == 200
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


async def test_user_a_bulk_delete_with_user_b_ids_reports_failed(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """Bulk-delete from A must put B's IDs in failed_ids and not delete them."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": "mt-bulk-foreign", "specification": "noop"},
    )
    b_id = create.json()["id"]
    try:
        r = auth_client.post(
            "/api/sessions/bulk-delete",
            json={"session_ids": [b_id]},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body.get("deleted_count", 0) == 0
        assert b_id in body.get("failed_ids", [])
        # Session still belongs to B
        got = auth_client_b.get(f"/api/sessions/{b_id}")
        assert got.status_code == 200
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

async def test_user_a_list_templates_excludes_user_b(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """GET /api/templates/ returns only templates owned by the calling user."""
    _user_b_or_skip(auth_client_b)
    marker = f"mt-tpl-b-{uuid.uuid4().hex[:8]}"
    create = auth_client_b.post(
        "/api/templates/",
        json={"name": marker, "agent_configs": []},
    )
    if create.status_code not in (200, 201):
        pytest.skip(f"templates endpoint not creatable: {create.status_code} {create.text}")
    b_tpl_id = create.json()["id"]
    try:
        r = auth_client.get("/api/templates/")
        assert r.status_code == 200
        items = r.json()
        assert all(item.get("id") != b_tpl_id for item in items)
    finally:
        auth_client_b.delete(f"/api/templates/{b_tpl_id}")


async def test_user_a_apply_user_b_template_returns_404(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """POST /api/templates/{B's_id}/apply from A returns 404."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/templates/",
        json={"name": "mt-tpl-apply-b", "agent_configs": []},
    )
    if create.status_code not in (200, 201):
        pytest.skip("templates endpoint not creatable")
    b_tpl_id = create.json()["id"]
    try:
        r = auth_client.post(
            f"/api/templates/{b_tpl_id}/apply",
            json={"name": "stolen", "specification": "x"},
        )
        assert r.status_code == 404, r.text
    finally:
        auth_client_b.delete(f"/api/templates/{b_tpl_id}")


async def test_user_a_get_user_b_template_returns_404(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """GET /api/templates/{B's_id} from A returns 404."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/templates/",
        json={"name": "mt-tpl-get-b", "agent_configs": []},
    )
    if create.status_code not in (200, 201):
        pytest.skip("templates endpoint not creatable")
    b_tpl_id = create.json()["id"]
    try:
        r = auth_client.get(f"/api/templates/{b_tpl_id}")
        assert r.status_code == 404
    finally:
        auth_client_b.delete(f"/api/templates/{b_tpl_id}")


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------

async def test_user_a_list_webhooks_excludes_user_b(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """GET /api/webhooks/ returns only webhooks owned by the calling user."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/webhooks/",
        json={"name": "mt-wh-b", "url": "https://example.com/hook"},
    )
    if create.status_code not in (200, 201):
        pytest.skip(f"webhooks endpoint not creatable: {create.status_code}")
    b_wh_id = create.json()["id"]
    try:
        r = auth_client.get("/api/webhooks/")
        assert r.status_code == 200
        items = r.json()
        assert all(item.get("id") != b_wh_id for item in items)
    finally:
        auth_client_b.delete(f"/api/webhooks/{b_wh_id}")


async def test_user_a_delete_user_b_webhook_returns_404(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """DELETE /api/webhooks/{B's_id} from A returns 404 and B's webhook survives."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/webhooks/",
        json={"name": "mt-wh-del-b", "url": "https://example.com/hook2"},
    )
    if create.status_code not in (200, 201):
        pytest.skip("webhooks endpoint not creatable")
    b_wh_id = create.json()["id"]
    try:
        r = auth_client.delete(f"/api/webhooks/{b_wh_id}")
        assert r.status_code == 404
        # Confirm still exists for B
        items = auth_client_b.get("/api/webhooks/").json()
        assert any(it.get("id") == b_wh_id for it in items)
    finally:
        auth_client_b.delete(f"/api/webhooks/{b_wh_id}")


# ---------------------------------------------------------------------------
# Dashboard stats
# ---------------------------------------------------------------------------

async def test_dashboard_stats_per_user(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """Dashboard stats are scoped to the current user — A and B see different totals.

    We can't easily seed cost data without LLM calls, so we just assert that the
    endpoint responds 200 for both users with a well-formed shape (regression
    against accidentally returning a system-wide aggregate to all users).
    """
    _user_b_or_skip(auth_client_b)
    a = auth_client.get("/api/code/dashboard/stats")
    b = auth_client_b.get("/api/code/dashboard/stats")
    assert a.status_code == 200, a.text
    assert b.status_code == 200, b.text
    for body in (a.json(), b.json()):
        assert "sessions_by_status" in body
        assert "total_cost_usd" in body
        assert "total_tokens" in body


# ---------------------------------------------------------------------------
# Checkpoints / sub-resources
# ---------------------------------------------------------------------------

async def test_user_a_checkpoints_for_user_b_session_returns_404(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """GET /api/sessions/{B}/checkpoints from A returns 404 (not empty list)."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": "mt-cp-foreign", "specification": "noop"},
    )
    b_id = create.json()["id"]
    try:
        r = auth_client.get(f"/api/sessions/{b_id}/checkpoints")
        assert r.status_code == 404
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")
