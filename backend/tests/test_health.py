"""Smoke tests for health and liveness endpoints.

Run inside docker compose:

    docker compose exec backend pytest backend/tests/test_health.py -v

Or against a backend reachable at $BACKEND_URL (default http://backend:8000).
"""

import os

import httpx
import pytest

BACKEND_URL = os.environ.get("BACKEND_URL", "http://backend:8000")


@pytest.mark.asyncio
async def test_health_endpoint_returns_200() -> None:
    """GET /health should return 200 with a JSON body indicating liveness."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.get("/health")
    assert resp.status_code == 200, f"expected 200, got {resp.status_code}: {resp.text}"
    body = resp.json()
    # Common shapes: {"status":"ok"} or {"status":"healthy"}
    assert "status" in body or "ok" in body, f"unexpected health body: {body}"


@pytest.mark.asyncio
async def test_root_or_docs_reachable() -> None:
    """OpenAPI docs should be served (FastAPI default /docs or /openapi.json)."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.get("/openapi.json")
    assert resp.status_code == 200
    spec = resp.json()
    assert spec.get("openapi", "").startswith("3."), "openapi.json must be v3"
    assert "paths" in spec and len(spec["paths"]) > 0


@pytest.mark.asyncio
async def test_unknown_route_returns_404() -> None:
    """Unknown paths must 404, not 500."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        resp = await client.get("/this-route-does-not-exist-xyz")
    assert resp.status_code == 404
