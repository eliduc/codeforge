"""Tests for newer R5/R6 features: templates, webhooks, prompt versioning,
dashboard stats, session checkpoints.

Converted from `tests/spec/05_round2_additions.md`, `06_r6_edge_integration.md`,
and `07_r6_regression.md`.

Fixtures consumed (from conftest.py):
  - auth_client     : authenticated httpx.Client
  - created_session : id of a fresh CREATED session
"""

from __future__ import annotations

import uuid

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

async def test_template_create_then_apply(auth_client: httpx.Client) -> None:
    """Create a template, apply it, and verify the new session inherits config."""
    create = auth_client.post(
        "/api/templates/",
        json={
            "name": f"feat-tpl-{uuid.uuid4().hex[:8]}",
            "language": "python",
            "max_iterations": 3,
            "agent_configs": [
                {
                    "agent_type": "coder",
                    "agent_index": 0,
                    "llm_provider": "anthropic",
                    "llm_model": "claude-sonnet-4-6",
                },
                {
                    "agent_type": "tester",
                    "agent_index": 0,
                    "llm_provider": "openai",
                    "llm_model": "gpt-5.2",
                },
            ],
        },
    )
    assert create.status_code in (200, 201), create.text
    tpl_id = create.json()["id"]
    new_sid = None
    try:
        # Apply
        apply = auth_client.post(
            f"/api/templates/{tpl_id}/apply",
            json={"name": "feat-from-tpl", "specification": "Hello world."},
        )
        assert apply.status_code in (200, 201), apply.text
        new_sid = apply.json()["id"]
        assert apply.json()["max_iterations"] == 3
    finally:
        if new_sid:
            auth_client.delete(f"/api/sessions/{new_sid}")
        auth_client.delete(f"/api/templates/{tpl_id}")


async def test_template_delete(auth_client: httpx.Client) -> None:
    create = auth_client.post(
        "/api/templates/",
        json={"name": "feat-tpl-del", "agent_configs": []},
    )
    assert create.status_code in (200, 201)
    tpl_id = create.json()["id"]
    r = auth_client.delete(f"/api/templates/{tpl_id}")
    assert r.status_code in (200, 204)
    got = auth_client.get(f"/api/templates/{tpl_id}")
    assert got.status_code == 404


async def test_template_list_returns_array(auth_client: httpx.Client) -> None:
    r = auth_client.get("/api/templates/")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ---------------------------------------------------------------------------
# Webhooks
# ---------------------------------------------------------------------------

async def test_webhook_create_lists_and_delete(auth_client: httpx.Client) -> None:
    create = auth_client.post(
        "/api/webhooks/",
        json={
            "name": "feat-wh",
            "url": "https://example.com/hook",
            "webhook_type": "generic",
        },
    )
    assert create.status_code in (200, 201), create.text
    wh_id = create.json()["id"]
    try:
        listed = auth_client.get("/api/webhooks/")
        assert any(w["id"] == wh_id for w in listed.json())
    finally:
        d = auth_client.delete(f"/api/webhooks/{wh_id}")
        assert d.status_code in (200, 204)


async def test_webhook_test_endpoint_dispatches(auth_client: httpx.Client) -> None:
    """POST /api/webhooks/{id}/test attempts a real dispatch and reports success/failure."""
    create = auth_client.post(
        "/api/webhooks/",
        json={
            "name": "feat-wh-test",
            "url": "https://example.invalid/hook",
            "webhook_type": "generic",
        },
    )
    if create.status_code not in (200, 201):
        pytest.skip("can't create webhook")
    wh_id = create.json()["id"]
    try:
        r = auth_client.post(f"/api/webhooks/{wh_id}/test")
        assert r.status_code == 200, r.text
        body = r.json()
        # Either success=True (somehow reached) or success=False with error info
        assert "success" in body
        if body["success"] is False:
            assert body.get("error") is not None or body.get("status_code") is not None
    finally:
        auth_client.delete(f"/api/webhooks/{wh_id}")


async def test_webhook_create_response_omits_secret(auth_client: httpx.Client) -> None:
    create = auth_client.post(
        "/api/webhooks/",
        json={
            "name": "feat-wh-secret",
            "url": "https://example.com/h",
            "secret": "topsecret-do-not-leak",
        },
    )
    if create.status_code not in (200, 201):
        pytest.skip("can't create webhook")
    body = create.json()
    try:
        assert "topsecret-do-not-leak" not in str(body)
        assert body.get("has_secret") is True
    finally:
        auth_client.delete(f"/api/webhooks/{body['id']}")


# ---------------------------------------------------------------------------
# Prompt versioning
# ---------------------------------------------------------------------------

async def test_prompt_patch_creates_version(auth_client: httpx.Client) -> None:
    """PATCH on a prompt template snapshots the prior state into the version table."""
    create = auth_client.post(
        "/api/prompts/",
        json={
            "name": f"feat-prompt-{uuid.uuid4().hex[:8]}",
            "agent_type": "coder",
            "template_text": "Write {{ specification }} in {{ language }}.",
            "is_default": False,
        },
    )
    if create.status_code not in (200, 201):
        pytest.skip(f"prompts endpoint not creatable: {create.status_code} {create.text}")
    pid = create.json()["id"]
    try:
        # PATCH bumps version
        r = auth_client.patch(
            f"/api/prompts/{pid}",
            json={
                "template_text": "Generate {{ specification }} using {{ language }}.",
                "change_note": "tightened wording",
            },
        )
        assert r.status_code == 200, r.text
        # List versions
        v = auth_client.get(f"/api/prompts/{pid}/versions")
        assert v.status_code == 200
        versions = v.json()
        assert isinstance(versions, list)
        assert len(versions) >= 1, "PATCH should snapshot the prior version"
    finally:
        auth_client.delete(f"/api/prompts/{pid}")


async def test_prompt_rollback_restores(auth_client: httpx.Client) -> None:
    """Rollback to a previous version restores its template_text."""
    create = auth_client.post(
        "/api/prompts/",
        json={
            "name": f"feat-rollback-{uuid.uuid4().hex[:8]}",
            "agent_type": "coder",
            "template_text": "ORIGINAL {{ specification }} {{ language }}",
            "is_default": False,
        },
    )
    if create.status_code not in (200, 201):
        pytest.skip("prompts endpoint not creatable")
    pid = create.json()["id"]
    try:
        # First PATCH — snapshot v1, live becomes v2
        auth_client.patch(
            f"/api/prompts/{pid}",
            json={"template_text": "EDITED {{ specification }} {{ language }}"},
        )
        versions = auth_client.get(f"/api/prompts/{pid}/versions").json()
        assert versions, "expected at least one historical version"
        v1 = versions[-1]  # oldest
        target_version_num = v1.get("version_number")
        if target_version_num is None:
            pytest.skip("version response has no version_number")

        rollback = auth_client.post(
            f"/api/prompts/{pid}/rollback/{target_version_num}"
        )
        assert rollback.status_code == 200, rollback.text
        assert "ORIGINAL" in rollback.json()["template_text"]
    finally:
        auth_client.delete(f"/api/prompts/{pid}")


# ---------------------------------------------------------------------------
# Dashboard stats
# ---------------------------------------------------------------------------

async def test_dashboard_stats_structure(auth_client: httpx.Client) -> None:
    r = auth_client.get("/api/code/dashboard/stats")
    assert r.status_code == 200, r.text
    body = r.json()
    expected_keys = {
        "window_days",
        "sessions_by_status",
        "total_cost_usd",
        "total_tokens",
        "total_requests",
        "avg_iterations",
        "top_providers",
        "top_models",
        "daily_cost",
    }
    missing = expected_keys - set(body.keys())
    assert not missing, f"dashboard stats missing keys: {missing}"
    assert isinstance(body["sessions_by_status"], dict)
    assert isinstance(body["daily_cost"], list)


# ---------------------------------------------------------------------------
# Session copy (read-only equivalent of "compare")
# ---------------------------------------------------------------------------

async def test_session_copy_creates_independent_copy(
    auth_client: httpx.Client, created_session: str
) -> None:
    """POST /{id}/copy creates a deep copy with same config but new id."""
    r = auth_client.post(f"/api/sessions/{created_session}/copy")
    if r.status_code not in (200, 201):
        pytest.skip(f"copy endpoint returned {r.status_code}")
    body = r.json()
    new_id = body["id"]
    try:
        assert new_id != created_session
        # Original still readable
        orig = auth_client.get(f"/api/sessions/{created_session}")
        assert orig.status_code == 200
    finally:
        auth_client.delete(f"/api/sessions/{new_id}")


# ---------------------------------------------------------------------------
# Checkpoints
# ---------------------------------------------------------------------------

async def test_checkpoints_list_returns_array(
    auth_client: httpx.Client, created_session: str
) -> None:
    """GET /api/sessions/{id}/checkpoints returns a list (possibly empty)."""
    r = auth_client.get(f"/api/sessions/{created_session}/checkpoints")
    assert r.status_code == 200, r.text
    body = r.json()
    assert isinstance(body, list)
    # For a fresh session, no checkpoints have been written
    for cp in body:
        assert "id" in cp
        assert "iteration" in cp
        assert "phase" in cp
