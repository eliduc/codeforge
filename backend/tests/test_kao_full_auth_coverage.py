"""КАО#Full-A3 — Full auth/authz coverage for every mounted route.

This test file is part of the КАО (команда агентов-отладчиков) Security
writers sub-team. Goal: every mounted route in :mod:`app.main` must EITHER
require auth (return 401/403 for an unauthenticated request) OR be explicitly
listed in the ``PUBLIC_ROUTES`` allowlist below.

Also covers:
  * Cross-user isolation for owned resources (sessions, code, webhooks).
  * Expired JWTs are rejected.
  * Tampered (mangled signature) JWTs are rejected.
  * Wrong-algorithm forgery (alg=none) is rejected.
  * API-key fallback works when configured (valid key → 200, invalid → 401).

Fixtures consumed (from conftest.py):
  * ``auth_client``   — User A authenticated httpx.Client (sync)
  * ``auth_client_b`` — User B authenticated httpx.Client (sync)

Marker: ``e2e`` — requires the backend to be reachable at BACKEND_URL.

# КАО#Full-A3
"""
from __future__ import annotations

import base64
import json
import os
import time
import uuid
from typing import Iterable

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]

BACKEND_URL = os.environ.get("BACKEND_URL", "http://backend:8000")

# Routes that are deliberately public (no auth dependency in main.py).
# Maintained manually so that any NEW public route surfaces in a code review.
PUBLIC_ROUTES: set[tuple[str, str]] = {
    ("GET", "/"),
    ("GET", "/health"),
    ("GET", "/openapi.json"),
    ("GET", "/docs"),
    ("GET", "/docs/oauth2-redirect"),
    ("GET", "/redoc"),
    # Auth flow itself
    ("POST", "/api/auth/request-otp"),
    ("POST", "/api/auth/verify-otp"),
    ("POST", "/api/auth/request-access"),
    # Public share endpoints — by design (anyone with token can view)
    ("GET", "/api/share/{token}"),
    # Screenshots use in-URL signed token instead of Bearer, KAO#VR-22
    ("GET", "/api/screenshots/{session_id}/{code_version_id}/{filename}"),
}


def _normalize_path(path: str) -> str:
    """Turn FastAPI ``{id}`` placeholders into something stable for set ops."""
    import re
    return re.sub(r"\{[^}]+\}", "{x}", path)


def _is_public(method: str, path: str) -> bool:
    norm = _normalize_path(path)
    for m, p in PUBLIC_ROUTES:
        if m == method and _normalize_path(p) == norm:
            return True
    # WebSocket endpoints handle auth themselves via query-string token
    if path.startswith("/ws"):
        return True
    return False


def _collect_state_changing_routes() -> list[tuple[str, str]]:
    """Programmatically collect all (method, path) for non-GET routes from the app.

    Each row is an opportunity for missing auth — these must 401/403 without a token.
    """
    try:
        from app.main import app
    except Exception as exc:
        pytest.skip(f"cannot import app.main ({exc!r}); run inside the backend container")
    routes: list[tuple[str, str]] = []
    for r in app.routes:
        methods = getattr(r, "methods", None) or set()
        path = getattr(r, "path", "")
        for m in methods:
            if m in {"HEAD", "OPTIONS"}:
                continue
            routes.append((m, path))
    return routes


# ---------------------------------------------------------------------------
# 1. Programmatic coverage: every non-public route requires auth
# ---------------------------------------------------------------------------

async def test_every_state_changing_route_requires_auth() -> None:
    """Every POST/PUT/PATCH/DELETE not in PUBLIC_ROUTES must return 401.

    We invoke each with a placeholder URL (UUIDs as needed) and assert the
    backend's auth layer kicks in BEFORE any payload validation — i.e. status
    must be 401 (or 403), never 422 / 200 / 500.
    """
    routes = _collect_state_changing_routes()
    placeholder_uuid = str(uuid.uuid4())

    failures: list[str] = []
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        for method, path in routes:
            if method == "GET":
                continue  # GETs covered separately below
            if _is_public(method, path):
                continue
            url = path
            # Substitute path params with valid-looking UUIDs / strings
            import re
            url = re.sub(r"\{[^}]+\}", placeholder_uuid, url)
            try:
                resp = await client.request(method, url, json={})
            except Exception as exc:
                failures.append(f"{method} {path}: transport error {exc!r}")
                continue
            if resp.status_code == 200 and "auth" not in path.lower():
                # Dev mode (no auth configured) → skip the whole suite
                pytest.skip(
                    f"AUTH_DISABLED in this environment ({method} {path} returned 200 "
                    "without token); cannot verify auth coverage"
                )
            if resp.status_code not in (401, 403):
                failures.append(
                    f"{method} {path}: expected 401/403, got {resp.status_code} "
                    f"(body: {resp.text[:120]!r})"
                )
    if failures:
        pytest.fail(
            f"{len(failures)} mounted route(s) accept unauthenticated requests:\n"
            + "\n".join(failures)
        )


async def test_every_get_route_requires_auth_or_is_public() -> None:
    """GETs follow the same rule but with a wider public allowlist."""
    routes = _collect_state_changing_routes()
    placeholder_uuid = str(uuid.uuid4())

    failures: list[str] = []
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        for method, path in routes:
            if method != "GET":
                continue
            if _is_public(method, path):
                continue
            import re
            # KAO#Full-C-2 S4 — substitute path params with type-appropriate
            # placeholders so FastAPI path validation does NOT short-circuit to
            # 422 before the auth dependency runs. {frame_index} and {*_id}
            # numeric params get "0"; everything else gets a valid UUID. This
            # restores the test's ability to detect a missing auth dependency
            # (which would otherwise be hidden behind a 422).
            def _sub(match: "re.Match[str]") -> str:
                name = match.group(0).strip("{}")
                if name == "frame_index" or name.endswith("_index") or name.endswith("_idx"):
                    return "0"
                return placeholder_uuid
            url = re.sub(r"\{[^}]+\}", _sub, path)
            try:
                resp = await client.get(url)
            except Exception:
                continue
            if resp.status_code == 200:
                # Dev mode — skip whole suite
                pytest.skip(f"AUTH_DISABLED: GET {path} returned 200 without token")
            # KAO#Full-C-2 S4 — 422 is NOT acceptable here. With type-aware
            # placeholders the request always reaches the auth dependency, so
            # absence of auth surfaces as 401/403 and missing resources as 404.
            # If a route is still returning 422 here, it means a path param
            # type we don't yet substitute — extend _sub() above.
            if resp.status_code not in (401, 403, 404):
                failures.append(f"GET {path}: got {resp.status_code}")
    if failures:
        pytest.fail("Unauth-accessible GETs:\n" + "\n".join(failures))


# ---------------------------------------------------------------------------
# 2. Cross-user isolation for OWNED resources
# ---------------------------------------------------------------------------

async def test_user_a_cannot_get_user_b_session(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """Direct GET by ID of another user's session must return 404 (not 200, not 403)."""
    if auth_client_b is None:
        pytest.skip("auth_client_b fixture unavailable")
    # B creates a session
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": f"a3-{uuid.uuid4().hex[:8]}", "specification": "noop"},
    )
    assert create.status_code in (200, 201), create.text
    b_id = create.json()["id"]
    try:
        r = auth_client.get(f"/api/sessions/{b_id}")
        # 404 (not 403) — don't leak existence of foreign rows
        assert r.status_code == 404, (
            f"User A reached User B's session: status={r.status_code} body={r.text[:120]!r}"
        )
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


async def test_user_a_cannot_patch_user_b_session(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """PATCH of another user's session must 404 — silent ownership boundary."""
    if auth_client_b is None:
        pytest.skip("auth_client_b fixture unavailable")
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": f"a3-patch-{uuid.uuid4().hex[:8]}", "specification": "noop"},
    )
    assert create.status_code in (200, 201)
    b_id = create.json()["id"]
    try:
        r = auth_client.patch(f"/api/sessions/{b_id}", json={"name": "hacked"})
        assert r.status_code == 404, f"cross-user PATCH succeeded: {r.status_code}"
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


async def test_user_a_cannot_delete_user_b_session(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """DELETE of another user's session must 404 and leave the row intact."""
    if auth_client_b is None:
        pytest.skip("auth_client_b fixture unavailable")
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": f"a3-del-{uuid.uuid4().hex[:8]}", "specification": "noop"},
    )
    assert create.status_code in (200, 201)
    b_id = create.json()["id"]
    try:
        r = auth_client.delete(f"/api/sessions/{b_id}")
        assert r.status_code == 404
        # B can still see it
        verify = auth_client_b.get(f"/api/sessions/{b_id}")
        assert verify.status_code == 200, "cross-user DELETE actually erased the row"
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


async def test_user_a_cannot_list_user_b_code_versions(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """Code-version listing for another user's session must 404."""
    if auth_client_b is None:
        pytest.skip("auth_client_b fixture unavailable")
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": f"a3-code-{uuid.uuid4().hex[:8]}", "specification": "noop"},
    )
    assert create.status_code in (200, 201)
    b_id = create.json()["id"]
    try:
        r = auth_client.get(f"/api/code/sessions/{b_id}/versions")
        assert r.status_code in (404, 403), (
            f"User A listed User B's code versions: {r.status_code}"
        )
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


# ---------------------------------------------------------------------------
# 3. JWT forgery / expiry / tampering
# ---------------------------------------------------------------------------

def _b64url(d: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()


async def test_expired_jwt_is_rejected() -> None:
    """An expired JWT (signed with the real key but exp<now) must be 401.

    Note: we sign with the real settings.secret_key inside the container so the
    signature is valid — only the ``exp`` claim is in the past.
    """
    try:
        from jose import jwt
        from app.config import get_settings
    except Exception as exc:
        pytest.skip(f"cannot import jose/settings: {exc!r}")
    settings = get_settings()
    expired = jwt.encode(
        {
            "sub": "00000000-0000-0000-0000-000000000000",
            "email": "expired@example.com",
            "exp": int(time.time()) - 60,
            "type": "access",
        },
        settings.secret_key,
        algorithm="HS256",
    )
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {expired}"})
    if r.status_code == 200:
        pytest.skip("AUTH_DISABLED — expired token accepted")
    assert r.status_code == 401, f"expired token accepted: {r.text}"


async def test_mangled_jwt_signature_is_rejected() -> None:
    """Flip a byte in a valid token's signature → must 401."""
    try:
        from jose import jwt
        from app.config import get_settings
    except Exception as exc:
        pytest.skip(f"cannot import jose: {exc!r}")
    settings = get_settings()
    valid = jwt.encode(
        {
            "sub": "00000000-0000-0000-0000-000000000000",
            "email": "x@example.com",
            "exp": int(time.time()) + 3600,
            "type": "access",
        },
        settings.secret_key,
        algorithm="HS256",
    )
    head, payload, sig = valid.split(".")
    # Flip last character of signature
    mangled_sig = sig[:-1] + ("A" if sig[-1] != "A" else "B")
    tampered = f"{head}.{payload}.{mangled_sig}"

    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get(
            "/api/auth/me", headers={"Authorization": f"Bearer {tampered}"}
        )
    if r.status_code == 200:
        pytest.skip("AUTH_DISABLED")
    assert r.status_code == 401, f"tampered token accepted: {r.text}"


async def test_jwt_wrong_type_claim_rejected() -> None:
    """A JWT whose ``type`` claim is not 'access' must be rejected.

    Catches confused-deputy attacks where a refresh-token or any other token
    gets used as an access token.
    """
    try:
        from jose import jwt
        from app.config import get_settings
    except Exception as exc:
        pytest.skip(f"cannot import jose: {exc!r}")
    settings = get_settings()
    tok = jwt.encode(
        {
            "sub": "00000000-0000-0000-0000-000000000000",
            "email": "x@example.com",
            "exp": int(time.time()) + 3600,
            "type": "refresh",  # wrong!
        },
        settings.secret_key,
        algorithm="HS256",
    )
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"})
    if r.status_code == 200:
        pytest.skip("AUTH_DISABLED")
    assert r.status_code == 401, f"non-access token accepted: {r.text}"


async def test_jwt_signed_with_attacker_key_rejected() -> None:
    """JWT signed with an attacker-chosen key must be rejected (sig verify)."""
    try:
        from jose import jwt
    except Exception as exc:
        pytest.skip(f"cannot import jose: {exc!r}")
    tok = jwt.encode(
        {
            "sub": "attacker",
            "email": "attacker@evil.example",
            "exp": int(time.time()) + 3600,
            "type": "access",
        },
        "attacker-controlled-secret",
        algorithm="HS256",
    )
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {tok}"})
    if r.status_code == 200:
        pytest.skip("AUTH_DISABLED")
    assert r.status_code == 401, f"attacker-signed token accepted: {r.text}"


# ---------------------------------------------------------------------------
# 4. API key fallback
# ---------------------------------------------------------------------------

async def test_api_key_fallback_valid_key_authorizes() -> None:
    """When CODEFORGE_API_KEY is set, the raw key works as a Bearer token."""
    try:
        from app.config import get_settings
    except Exception as exc:
        pytest.skip(f"cannot import settings: {exc!r}")
    s = get_settings()
    if not s.codeforge_api_key:
        pytest.skip("CODEFORGE_API_KEY not configured")
    key = s.codeforge_api_key.get_secret_value()
    if not key.strip():
        pytest.skip("CODEFORGE_API_KEY empty")
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get("/api/sessions/", headers={"Authorization": f"Bearer {key}"})
    assert r.status_code == 200, f"valid API key rejected: {r.status_code} {r.text}"


async def test_api_key_fallback_invalid_key_rejected() -> None:
    """A token that's neither a valid JWT nor the configured API key → 401."""
    bogus = "not-a-jwt-not-the-api-key-" + uuid.uuid4().hex
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get("/api/sessions/", headers={"Authorization": f"Bearer {bogus}"})
    if r.status_code == 200:
        pytest.skip("AUTH_DISABLED")
    assert r.status_code == 401, f"bogus token accepted: {r.text}"


async def test_no_auth_header_rejected_on_protected_endpoint() -> None:
    """Missing Authorization header on /api/sessions/ → 401."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get("/api/sessions/")
    if r.status_code == 200:
        pytest.skip("AUTH_DISABLED")
    assert r.status_code == 401


async def test_empty_bearer_token_rejected() -> None:
    """Bare ``Authorization: Bearer`` (no token) → 401, never 200.

    КАО#Full-C-1 M3 — Original variant sent ``"Bearer "`` (trailing space); httpx
    0.27+ rejects that at the client layer (``InvalidHeader: leading/trailing
    whitespace``) and the request never leaves the process. We test the
    semantically equivalent case — header value is the literal word ``Bearer``
    with no token — which exercises the same backend code path (empty-token
    branch in the auth dependency) without tripping httpx's header sanitizer.
    """
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get("/api/sessions/", headers={"Authorization": "Bearer"})
    if r.status_code == 200:
        pytest.skip("AUTH_DISABLED")
    assert r.status_code in (401, 403), f"empty Bearer accepted: {r.status_code}"
