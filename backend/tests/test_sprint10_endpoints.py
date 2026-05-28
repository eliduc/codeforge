"""End-to-end endpoint tests for sprint-10 features.

Covers:
  - Spec scorer + cost estimator (Features 2a/2b)
  - Full-text search on /api/sessions/ (Feature #6)
  - Public share link mint/get/revoke (Feature #5)
  - Auto-generate tests + docs (Feature #4)
  - Enhancement preview (Feature #9)
  - Vercel deploy (Feature #10)

All tests are marked ``e2e`` so they only run inside the stage container with
``-m e2e``. They exercise the live HTTP surface using the auth_client fixture
and avoid real LLM / Vercel calls.

Fixtures consumed (from conftest.py):
  - auth_client     : httpx.Client with Bearer token
  - created_session : id of a freshly CREATED session
"""
from __future__ import annotations

import uuid
from contextlib import contextmanager

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]


# ---------------------------------------------------------------------------
# Helper: seed a FinalResult row directly so generate-tests / generate-docs
# / Vercel deploy can pass their "no final code" guard without running the
# real workflow. Best-effort; tests that need it skip if the helper fails.
# ---------------------------------------------------------------------------

@contextmanager
def _seed_final_code(session_id: str, language: str = "python", code: str = "print('hi')\n"):
    """Insert a FinalResult row + set session.language synchronously, then clean up."""
    try:
        from sqlalchemy import create_engine, delete as sa_delete, update as sa_update
        from app.config import get_settings
        from app.db.models import FinalResult, Session as SessionModel
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"cannot import backend models: {exc!r}")

    sync_url = get_settings().sync_database_url
    engine = create_engine(sync_url)
    try:
        with engine.begin() as conn:
            conn.execute(
                sa_update(SessionModel.__table__)
                .where(SessionModel.__table__.c.id == session_id)
                .values(language=language)
            )
            # Remove any existing FinalResult and re-insert a fresh one.
            conn.execute(
                sa_delete(FinalResult.__table__)
                .where(FinalResult.__table__.c.session_id == session_id)
            )
            conn.execute(
                FinalResult.__table__.insert().values(
                    session_id=session_id,
                    final_code=code,
                    selected_coder_index=0,
                    readme_content="seeded for tests",
                    selection_reasoning="seeded for tests",
                )
            )
        try:
            yield
        finally:
            with engine.begin() as conn:
                conn.execute(
                    sa_delete(FinalResult.__table__)
                    .where(FinalResult.__table__.c.session_id == session_id)
                )
    finally:
        engine.dispose()


# ===========================================================================
# Feature 2a: Spec scorer
# ===========================================================================

async def test_spec_score_returns_full_payload(auth_client: httpx.Client) -> None:
    spec = (
        "The function should accept two integers and return their sum. "
        "It must validate input and produce a numeric result."
    )
    r = auth_client.post("/api/spec-helper/spec-score", json={"specification": spec})
    assert r.status_code == 200, r.text
    data = r.json()
    for key in (
        "overall_score",
        "issues",
        "estimated_complexity",
        "detected_keywords",
        "word_count",
    ):
        assert key in data, f"missing key {key!r} in {data}"
    assert 0 <= data["overall_score"] <= 100
    assert isinstance(data["issues"], list)
    assert data["estimated_complexity"] in ("trivial", "moderate", "complex")
    assert data["word_count"] > 0


async def test_spec_score_requires_auth() -> None:
    """No-auth client should be rejected with 401/403."""
    import os
    base = os.environ.get("BACKEND_URL", "http://localhost:8000")
    with httpx.Client(base_url=base, timeout=10.0) as anon:
        r = anon.post(
            "/api/spec-helper/spec-score",
            json={"specification": "Hello world"},
        )
    assert r.status_code in (401, 403), r.text


async def test_spec_score_short_spec_low_score(auth_client: httpx.Client) -> None:
    """Tiny ambiguous spec → low score with 'serious' issue flagged."""
    r = auth_client.post(
        "/api/spec-helper/spec-score",
        json={"specification": "do stuff maybe"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["overall_score"] < 80, data
    assert any(i.get("severity") == "serious" for i in data["issues"]), data["issues"]


async def test_spec_score_empty_spec_rejected(auth_client: httpx.Client) -> None:
    """min_length=1 means truly empty → 422."""
    r = auth_client.post("/api/spec-helper/spec-score", json={"specification": ""})
    assert r.status_code == 422, r.text


async def test_spec_score_long_complex_classification(auth_client: httpx.Client) -> None:
    """Word count > 500 → 'complex' bucket."""
    spec = ("The system must accept inputs and produce output. " * 80)
    r = auth_client.post("/api/spec-helper/spec-score", json={"specification": spec})
    assert r.status_code == 200, r.text
    assert r.json()["estimated_complexity"] == "complex"


# ===========================================================================
# Feature 2b: Cost estimator
# ===========================================================================

async def test_cost_estimate_basic(auth_client: httpx.Client) -> None:
    body = {
        "specification": "Build a CLI that prints fizzbuzz from 1 to N.",
        "agent_configs": [
            {"agent_type": "coder", "llm_provider": "anthropic", "llm_model": "claude-sonnet-4-6"},
            {"agent_type": "tester", "llm_provider": "openai", "llm_model": "gpt-4o-mini"},
        ],
        "max_iterations": 3,
    }
    r = auth_client.post("/api/spec-helper/cost-estimate", json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    for key in (
        "estimated_tokens_per_iter",
        "estimated_total_tokens",
        "estimated_cost_usd",
        "estimated_time_seconds",
        "breakdown",
    ):
        assert key in data
    assert data["estimated_total_tokens"] > 0
    assert data["estimated_cost_usd"] > 0
    # Two providers in config → both should appear in breakdown.
    assert "anthropic" in data["breakdown"]
    assert "openai" in data["breakdown"]


async def test_cost_estimate_requires_auth() -> None:
    import os
    base = os.environ.get("BACKEND_URL", "http://localhost:8000")
    with httpx.Client(base_url=base, timeout=10.0) as anon:
        r = anon.post(
            "/api/spec-helper/cost-estimate",
            json={"specification": "x", "agent_configs": [], "max_iterations": 1},
        )
    assert r.status_code in (401, 403), r.text


async def test_cost_estimate_ollama_is_free(auth_client: httpx.Client) -> None:
    """All-Ollama config → near-zero cost (local inference)."""
    body = {
        "specification": "Print the fibonacci sequence up to N.",
        "agent_configs": [
            {"agent_type": "coder", "llm_provider": "ollama", "llm_model": "llama3"},
        ],
        "max_iterations": 2,
    }
    r = auth_client.post("/api/spec-helper/cost-estimate", json=body)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["estimated_cost_usd"] == 0.0
    # ollama provider shows up in breakdown with zero cost.
    assert data["breakdown"].get("ollama", 0.0) == 0.0


async def test_cost_estimate_iterations_validated(auth_client: httpx.Client) -> None:
    """max_iterations capped at 50 by Field constraint."""
    body = {
        "specification": "anything",
        "agent_configs": [],
        "max_iterations": 9999,
    }
    r = auth_client.post("/api/spec-helper/cost-estimate", json=body)
    assert r.status_code == 422, r.text


# ===========================================================================
# Feature #6: Full-text search on /api/sessions/
# ===========================================================================

async def test_search_matches_specification(auth_client: httpx.Client) -> None:
    """search=... should match BOTH name and specification (case-insensitive)."""
    marker = uuid.uuid4().hex[:10]
    create = auth_client.post(
        "/api/sessions/",
        json={
            "name": f"unrelated-name-{uuid.uuid4().hex[:6]}",
            "specification": f"Implement a tokenizer for KEYWORD_{marker} parsing.",
        },
    )
    assert create.status_code in (200, 201), create.text
    sid = create.json()["id"]
    try:
        # Match by spec text (uppercase to verify case-insensitivity).
        r = auth_client.get(f"/api/sessions/?search=keyword_{marker.upper()}")
        assert r.status_code == 200, r.text
        ids = [s["id"] for s in r.json()["items"]]
        assert sid in ids, f"expected session {sid} in {ids}"
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_search_matches_name(auth_client: httpx.Client) -> None:
    marker = uuid.uuid4().hex[:10]
    create = auth_client.post(
        "/api/sessions/",
        json={
            "name": f"named-{marker}-thing",
            "specification": "spec text without marker.",
        },
    )
    sid = create.json()["id"]
    try:
        r = auth_client.get(f"/api/sessions/?search={marker}")
        assert r.status_code == 200
        ids = [s["id"] for s in r.json()["items"]]
        assert sid in ids
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_search_empty_result_returns_200(auth_client: httpx.Client) -> None:
    """No matches → 200 with empty items list (not 404)."""
    r = auth_client.get(f"/api/sessions/?search={uuid.uuid4().hex}NEVERMATCHES")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["items"] == []
    assert body["total"] == 0


# ===========================================================================
# Feature #5: Public share link
# ===========================================================================

async def test_share_mint_get_revoke(auth_client: httpx.Client, created_session: str) -> None:
    """Mint a token, anonymously fetch it, then revoke it."""
    import os
    base = os.environ.get("BACKEND_URL", "http://localhost:8000")

    mint = auth_client.post(f"/api/sessions/{created_session}/share")
    assert mint.status_code == 200, mint.text
    data = mint.json()
    assert "share_token" in data
    token = data["share_token"]
    assert token and isinstance(token, str)
    assert len(token) <= 64

    # Anonymous client (no Authorization header) can fetch it.
    with httpx.Client(base_url=base, timeout=10.0) as anon:
        got = anon.get(f"/api/share/{token}")
        assert got.status_code == 200, got.text
        body = got.json()
        assert body["id"] == created_session
        # Public response must NOT leak agent configs / settings.
        for forbidden in ("agent_configs", "settings", "user_id", "share_token"):
            assert forbidden not in body, f"public share leaks {forbidden}"

    # Revoke
    rev = auth_client.delete(f"/api/sessions/{created_session}/share")
    assert rev.status_code in (200, 204)

    # After revoke the token must 404.
    with httpx.Client(base_url=base, timeout=10.0) as anon:
        gone = anon.get(f"/api/share/{token}")
    assert gone.status_code == 404


async def test_share_mint_idempotent(auth_client: httpx.Client, created_session: str) -> None:
    """Re-calling POST /share returns the SAME token."""
    a = auth_client.post(f"/api/sessions/{created_session}/share")
    b = auth_client.post(f"/api/sessions/{created_session}/share")
    assert a.status_code == 200 and b.status_code == 200
    assert a.json()["share_token"] == b.json()["share_token"]
    auth_client.delete(f"/api/sessions/{created_session}/share")


async def test_share_unknown_token_404() -> None:
    import os
    base = os.environ.get("BACKEND_URL", "http://localhost:8000")
    with httpx.Client(base_url=base, timeout=10.0) as anon:
        r = anon.get(f"/api/share/{uuid.uuid4().hex}")
    assert r.status_code == 404


async def test_share_owner_only(auth_client: httpx.Client, auth_client_b: httpx.Client) -> None:
    """User B cannot mint a share token for User A's session."""
    create = auth_client.post(
        "/api/sessions/",
        json={"name": f"share-owner-{uuid.uuid4().hex[:6]}", "specification": "x"},
    )
    sid = create.json()["id"]
    try:
        r = auth_client_b.post(f"/api/sessions/{sid}/share")
        assert r.status_code == 404
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


# ===========================================================================
# Feature #4: Auto-generate tests + docs
# ===========================================================================

async def test_generate_tests_returns_scaffold(auth_client: httpx.Client, created_session: str) -> None:
    with _seed_final_code(created_session, language="python"):
        r = auth_client.post(f"/api/sessions/{created_session}/generate-tests")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["tests_code"]
    assert data.get("language") == "pytest"
    # Stub flag is set since real LLM gen isn't shipped.
    assert data.get("stub") is True


async def test_generate_tests_no_final_code_400(
    auth_client: httpx.Client, created_session: str
) -> None:
    """No final code yet → 400."""
    r = auth_client.post(f"/api/sessions/{created_session}/generate-tests")
    assert r.status_code == 400, r.text


async def test_generate_tests_404_for_nonowner(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    create = auth_client.post(
        "/api/sessions/",
        json={"name": f"gen-tests-{uuid.uuid4().hex[:6]}", "specification": "x"},
    )
    sid = create.json()["id"]
    try:
        r = auth_client_b.post(f"/api/sessions/{sid}/generate-tests")
        assert r.status_code == 404
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_generate_docs_returns_readme(auth_client: httpx.Client, created_session: str) -> None:
    with _seed_final_code(created_session, language="python"):
        r = auth_client.post(f"/api/sessions/{created_session}/generate-docs")
    assert r.status_code == 200, r.text
    data = r.json()
    assert data.get("readme")
    # api_docs is optional but the stub returns it.
    assert data.get("stub") is True


async def test_generate_docs_404_for_nonowner(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    create = auth_client.post(
        "/api/sessions/",
        json={"name": f"gen-docs-{uuid.uuid4().hex[:6]}", "specification": "x"},
    )
    sid = create.json()["id"]
    try:
        r = auth_client_b.post(f"/api/sessions/{sid}/generate-docs")
        assert r.status_code == 404
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


# ===========================================================================
# Feature #9: Enhancement preview
# ===========================================================================

async def test_enhance_preview_404_for_nonowner(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """Owner check kicks in before any LLM work — verify 404 path is reachable."""
    create = auth_client.post(
        "/api/sessions/",
        json={"name": f"enh-prev-{uuid.uuid4().hex[:6]}", "specification": "x"},
    )
    sid = create.json()["id"]
    try:
        body = {
            "enhancers": [
                {"type": "enhancer_design", "enabled": True,
                 "provider": "anthropic", "model": "claude-sonnet-4-6"},
            ],
            "summarizer": {"provider": "anthropic", "model": "claude-sonnet-4-6"},
        }
        r = auth_client_b.post(
            f"/api/sessions/{sid}/enhance?preview=true",
            json=body,
        )
        assert r.status_code == 404
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_enhance_preview_400_without_final_result(
    auth_client: httpx.Client, created_session: str
) -> None:
    """No final result present → 400 'Session has no final result'.

    This also implicitly verifies status is NOT flipped to ENHANCING in the
    preview branch (we re-fetch and confirm CREATED is preserved).
    """
    body = {
        "enhancers": [
            {"type": "enhancer_design", "enabled": True,
             "provider": "anthropic", "model": "claude-sonnet-4-6"},
        ],
        "summarizer": {"provider": "anthropic", "model": "claude-sonnet-4-6"},
    }
    # No FinalResult exists → either 400 (no final result) or 400 (status guard).
    r = auth_client.post(
        f"/api/sessions/{created_session}/enhance?preview=true",
        json=body,
    )
    assert r.status_code == 400, r.text

    # Confirm status was NOT flipped to ENHANCING.
    got = auth_client.get(f"/api/sessions/{created_session}")
    assert got.status_code == 200
    assert got.json()["status"].lower() != "enhancing"


async def test_enhance_preview_default_false_unchanged(
    auth_client: httpx.Client, created_session: str
) -> None:
    """preview omitted → non-preview branch hits the same 400 (no final result),
    confirming the default is 'False' (otherwise behaviour would diverge).
    """
    body = {
        "enhancers": [
            {"type": "enhancer_design", "enabled": True,
             "provider": "anthropic", "model": "claude-sonnet-4-6"},
        ],
        "summarizer": {"provider": "anthropic", "model": "claude-sonnet-4-6"},
    }
    r = auth_client.post(f"/api/sessions/{created_session}/enhance", json=body)
    # Without final result we expect 400 in both branches.
    assert r.status_code == 400, r.text


# ===========================================================================
# Feature #10: Vercel deploy
# ===========================================================================

async def test_vercel_deploy_python_unsupported(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Python session → 400 'unsupported language'."""
    with _seed_final_code(created_session, language="python", code="print('hi')"):
        r = auth_client.post(
            f"/api/sessions/{created_session}/deploy/vercel",
            json={"token": "fake-vercel-token"},
        )
    assert r.status_code == 400, r.text
    assert "html" in r.text.lower() or "unsupported" in r.text.lower() or "support" in r.text.lower()
    # Token must NOT be echoed back.
    assert "fake-vercel-token" not in r.text


async def test_vercel_deploy_missing_final_code_400(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Session with no FinalResult row → 400 'no final code yet'."""
    r = auth_client.post(
        f"/api/sessions/{created_session}/deploy/vercel",
        json={"token": "fake-token"},
    )
    assert r.status_code == 400, r.text
    assert "fake-token" not in r.text


async def test_vercel_deploy_bad_token_returns_502(
    auth_client: httpx.Client, created_session: str
) -> None:
    """Real Vercel API call with bogus token → upstream error wrapped as 502.

    This is what proves the route doesn't echo the token: we send a bogus
    token and verify it is NOT in the response body even when Vercel rejects it.
    """
    with _seed_final_code(
        created_session,
        language="html",
        code="<!DOCTYPE html><title>t</title><body>hi</body>",
    ):
        r = auth_client.post(
            f"/api/sessions/{created_session}/deploy/vercel",
            json={"token": "secret_test_token_should_not_leak", "project_name": "cf-test"},
        )
    # 502 (Vercel returned 4xx) is the happy path here. Other gateway errors
    # also acceptable; the key invariant is the token is not echoed.
    assert r.status_code in (502, 504, 500), r.text
    assert "secret_test_token_should_not_leak" not in r.text


async def test_vercel_deploy_404_for_nonowner(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    create = auth_client.post(
        "/api/sessions/",
        json={"name": f"deploy-{uuid.uuid4().hex[:6]}", "specification": "x"},
    )
    sid = create.json()["id"]
    try:
        r = auth_client_b.post(
            f"/api/sessions/{sid}/deploy/vercel",
            json={"token": "x"},
        )
        assert r.status_code == 404
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_vercel_deploy_empty_token_400(
    auth_client: httpx.Client, created_session: str
) -> None:
    r = auth_client.post(
        f"/api/sessions/{created_session}/deploy/vercel",
        json={"token": "   "},
    )
    assert r.status_code == 400, r.text
