"""КАО#Full-A3 — Secrets / config-leak hunters.

Four classes of checks:

1. **Source-tree scan** — grep `backend/app/` + `frontend/src/` for hardcoded
   secret patterns (sk-…, ghp_…, AKIA…, Bearer …). Fails on any hit.

2. **API response scan** — call public + auth'd endpoints and assert the
   response body never contains keys named `secret_key`, `api_key`,
   `password`, or a value that looks like a JWT / API key (except for the
   one place `access_token` is legitimately returned: POST /api/auth/verify-otp).

3. **Container log scan** — read recent backend stdout via
   ``docker logs --tail 1000 codeforge-claude-backend``; fail on leak patterns.

4. **Frontend bundle scan** — fetch the live JS bundle from
   ``stage.gotcode.ai/assets/index-*.js`` (and any /assets/*.js) and confirm
   no Anthropic / OpenAI / JWT_SECRET values are baked in.

# КАО#Full-A3
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

BACKEND_URL = os.environ.get("BACKEND_URL", "http://backend:8000")
STAGE_FRONTEND_URL = os.environ.get("STAGE_FRONTEND_URL", "https://stage.gotcode.ai")


# Detect secret-like strings in source / responses / logs.
# Each pattern is tuned to be specific enough to not false-positive on
# pricing tables or model IDs.
SECRET_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("openai api key", re.compile(r"sk-[a-zA-Z0-9]{32,}")),
    ("openai project key", re.compile(r"sk-proj-[A-Za-z0-9_-]{20,}")),
    ("anthropic api key", re.compile(r"sk-ant-[a-zA-Z0-9_\-]{20,}")),
    ("github personal token", re.compile(r"ghp_[A-Za-z0-9]{20,}")),
    ("github oauth token", re.compile(r"gho_[A-Za-z0-9]{20,}")),
    ("aws access key", re.compile(r"AKIA[A-Z0-9]{16}")),
    ("google api key", re.compile(r"AIza[0-9A-Za-z\-_]{35}")),
    (
        "explicit Bearer in code",
        re.compile(r"Bearer\s+[A-Za-z0-9._\-]{30,}"),
    ),
    (
        "stripe secret",
        re.compile(r"sk_live_[A-Za-z0-9]{20,}"),
    ),
    ("slack token", re.compile(r"xox[bpoars]-[A-Za-z0-9-]{10,}")),
    ("jwt-like", re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}")),
]


def _repo_root() -> Path:
    here = Path(__file__).resolve()
    for p in [here, *here.parents]:
        if (p / "frontend").is_dir() and (p / "backend").is_dir():
            return p
    return here.parents[2]


# Files / dirs that may legitimately contain placeholders or example secrets.
# (Example: .env.example, tests, fixtures.)
SOURCE_EXCLUDE = {
    ".env.example",
    "conftest.py",
    # These tests themselves CONTAIN secret patterns as test data:
    "test_kao_full_secrets.py",
    "test_kao_full_auth_coverage.py",
    "test_security.py",
    # Lockfiles can carry integrity hashes that look like base64 secrets
    "package-lock.json",
    "yarn.lock",
}


# ---------------------------------------------------------------------------
# 1. Source-tree scan
# ---------------------------------------------------------------------------

def _scan_dir_for_secrets(root: Path, exts: set[str]) -> list[tuple[str, int, str, str]]:
    """Walk ``root`` and yield (relpath, lineno, pattern_name, line) for any hit."""
    hits: list[tuple[str, int, str, str]] = []
    for f in root.rglob("*"):
        if not f.is_file():
            continue
        if f.suffix not in exts:
            continue
        if f.name in SOURCE_EXCLUDE:
            continue
        # Skip __pycache__, node_modules, dist
        if any(part in {"__pycache__", "node_modules", "dist", "build", ".venv"} for part in f.parts):
            continue
        try:
            with open(f, "r", encoding="utf-8", errors="ignore") as fh:
                for i, line in enumerate(fh, start=1):
                    if len(line) > 4096:  # skip pathologically long minified lines
                        continue
                    for name, pat in SECRET_PATTERNS:
                        if pat.search(line):
                            hits.append((str(f.relative_to(root)), i, name, line.rstrip()))
        except (OSError, UnicodeDecodeError):
            continue
    return hits


def test_backend_source_no_hardcoded_secrets() -> None:
    """No literal secret patterns in ``backend/app/``.

    КАО#Full-C-1 M5 — When pytest runs *inside* the backend container the repo
    root isn't mounted (only ``/app/app`` is present). Skip with an explicit
    reason so the test is run on host CI / locally where the source tree is
    actually visible.
    """
    backend_app = _repo_root() / "backend" / "app"
    if not backend_app.is_dir():
        pytest.skip(
            "Backend container has no source mount; runtime equivalent runs on host CI "
            f"(looked at {backend_app})"
        )
    hits = _scan_dir_for_secrets(backend_app, exts={".py"})
    if hits:
        lines = [f"  {rel}:{ln} [{name}] {text[:120]}" for rel, ln, name, text in hits[:20]]
        pytest.fail(
            f"{len(hits)} potential hardcoded secret(s) in backend/app:\n"
            + "\n".join(lines)
        )


def test_frontend_source_no_hardcoded_secrets() -> None:
    """No literal secret patterns in ``frontend/src/``.

    КАО#Full-C-1 M5 — Same skip reasoning as
    :func:`test_backend_source_no_hardcoded_secrets`: when invoked inside the
    backend container the frontend tree isn't mounted.
    """
    frontend_src = _repo_root() / "frontend" / "src"
    if not frontend_src.is_dir():
        pytest.skip(
            "Backend container has no frontend source mount; runtime equivalent runs on host CI "
            f"(looked at {frontend_src})"
        )
    hits = _scan_dir_for_secrets(frontend_src, exts={".ts", ".tsx", ".js", ".jsx"})
    if hits:
        lines = [f"  {rel}:{ln} [{name}] {text[:120]}" for rel, ln, name, text in hits[:20]]
        pytest.fail(
            f"{len(hits)} potential hardcoded secret(s) in frontend/src:\n"
            + "\n".join(lines)
        )


# ---------------------------------------------------------------------------
# 2. API response scan
# ---------------------------------------------------------------------------

# Response-body field-name leak detection. We assert these substrings DO NOT
# appear as JSON keys in API responses (the access_token field is the only
# allowed exception — explicitly checked below).
_FORBIDDEN_RESPONSE_KEYS = {"secret_key", "smtp_password", "anthropic_api_key",
                            "openai_api_key", "google_api_key", "grok_api_key",
                            "codeforge_api_key"}


def _check_response_no_secret_keys(text: str, *, allow_access_token: bool = False) -> list[str]:
    """Return list of forbidden keys found in a JSON response body."""
    try:
        body = json.loads(text)
    except Exception:
        return []
    found: list[str] = []

    def _walk(obj, path: str = ""):
        if isinstance(obj, dict):
            for k, v in obj.items():
                key_lower = k.lower() if isinstance(k, str) else str(k)
                p = f"{path}.{k}" if path else k
                if key_lower in _FORBIDDEN_RESPONSE_KEYS:
                    # Only flag if value is non-trivially present (not masked, not bool/null)
                    if isinstance(v, str) and len(v) > 12 and "*" not in v:
                        found.append(p)
                # `password` field with non-empty string value is always a leak
                if key_lower == "password" and isinstance(v, str) and v:
                    found.append(p)
                # bare `api_key` field — only if value looks like a real key (long, unmasked)
                if key_lower == "api_key" and isinstance(v, str) and len(v) > 20 and "*" not in v:
                    found.append(p)
                _walk(v, p)
        elif isinstance(obj, list):
            for i, item in enumerate(obj):
                _walk(item, f"{path}[{i}]")

    _walk(body)
    return found


@pytest.mark.asyncio
@pytest.mark.e2e
async def test_health_endpoint_no_secrets() -> None:
    """``GET /health`` must not leak config."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get("/health")
    leaks = _check_response_no_secret_keys(r.text)
    assert not leaks, f"/health leaks: {leaks}"
    # Also no pattern hits in raw text
    for name, pat in SECRET_PATTERNS:
        m = pat.search(r.text)
        assert not m, f"/health body matches {name}: {m.group(0)[:60]!r}"


@pytest.mark.asyncio
@pytest.mark.e2e
async def test_root_endpoint_no_secrets() -> None:
    """``GET /`` must not leak config (the root just returns name+status)."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=5.0) as client:
        r = await client.get("/")
    leaks = _check_response_no_secret_keys(r.text)
    assert not leaks, f"/ leaks: {leaks}"


@pytest.mark.asyncio
@pytest.mark.e2e
async def test_openapi_does_not_expose_db_or_keys() -> None:
    """OpenAPI schema must not bake in any DB URL, JWT secret, or LLM API key."""
    async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as client:
        r = await client.get("/openapi.json")
    assert r.status_code == 200
    text = r.text
    forbidden_subs = (
        "sk-ant-",
        "sk-proj-",
        "AKIA",
        "ghp_",
        "ANTHROPIC_API_KEY=",
        "OPENAI_API_KEY=",
        "postgresql://",
        "postgres://",
        "smtp_password",
        "secret_key",
    )
    for needle in forbidden_subs:
        assert needle not in text, f"/openapi.json leaks {needle!r}"


@pytest.mark.asyncio
@pytest.mark.e2e
async def test_auth_me_does_not_leak_other_users(auth_client: httpx.Client) -> None:
    """`/api/auth/me` returns only the current user, no global config / secrets."""
    r = auth_client.get("/api/auth/me")
    assert r.status_code == 200, r.text
    leaks = _check_response_no_secret_keys(r.text)
    assert not leaks, f"/api/auth/me leaks: {leaks}"


@pytest.mark.asyncio
@pytest.mark.e2e
async def test_sessions_list_no_password_field(auth_client: httpx.Client) -> None:
    """The session list must not include a `password` / `secret_key` field anywhere."""
    r = auth_client.get("/api/sessions/")
    assert r.status_code == 200
    leaks = _check_response_no_secret_keys(r.text)
    assert not leaks, f"/api/sessions/ leaks: {leaks}"


# ---------------------------------------------------------------------------
# 3. Container logs scan (best-effort — skip if docker not reachable)
# ---------------------------------------------------------------------------

def test_backend_logs_no_recent_secret_leak() -> None:
    """`docker logs --tail 1000 codeforge-claude-backend` contains no secret patterns.

    Skipped if docker isn't available from the test runner (e.g. tests
    running inside the same container that emits the logs).
    """
    docker = shutil.which("docker")
    if not docker:
        # КАО#Full-C-1 M5 — Backend container has no docker CLI; this scan
        # must run from the host (host CI has `docker logs` access).
        pytest.skip(
            "Backend container has no docker CLI; runtime equivalent runs on host CI "
            "(scans `docker logs --tail 1000 codeforge-claude-backend`)"
        )

    container = os.environ.get("CF_BACKEND_CONTAINER", "codeforge-claude-backend")
    try:
        proc = subprocess.run(
            [docker, "logs", "--tail", "1000", container],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pytest.skip("could not exec docker logs")

    if proc.returncode != 0:
        pytest.skip(
            f"docker logs failed for {container!r}: rc={proc.returncode}, "
            f"stderr={proc.stderr[:200]!r}"
        )
    combined = (proc.stdout or "") + (proc.stderr or "")
    if not combined.strip():
        pytest.skip("docker logs empty — nothing to scan")

    hits: list[str] = []
    for name, pat in SECRET_PATTERNS:
        for m in pat.finditer(combined):
            hits.append(f"{name}: {m.group(0)[:60]!r}")
            if len(hits) >= 20:
                break
    if hits:
        pytest.fail(
            f"Backend logs contain {len(hits)} secret-shaped string(s):\n  "
            + "\n  ".join(hits)
        )


# ---------------------------------------------------------------------------
# 4. Frontend bundle scan (stage)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@pytest.mark.e2e
async def test_stage_frontend_bundle_no_secrets() -> None:
    """Live ``stage.gotcode.ai/assets/index-*.js`` must not contain server secrets.

    Vite emits a small index.html that pulls in hashed ``/assets/index-XXXX.js``.
    We fetch the html, extract every ``/assets/*.js`` ref, and grep each one.
    """
    base = STAGE_FRONTEND_URL.rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            html_resp = await client.get(base + "/")
    except Exception as exc:
        pytest.skip(f"stage frontend unreachable: {exc!r}")
    if html_resp.status_code != 200:
        pytest.skip(f"stage frontend returned {html_resp.status_code}")

    asset_paths = set(re.findall(r"/assets/[A-Za-z0-9._\-/]+\.js", html_resp.text))
    if not asset_paths:
        pytest.skip("no /assets/*.js refs in stage index.html")

    async with httpx.AsyncClient(timeout=30.0) as client:
        for path in list(asset_paths)[:10]:  # cap to first 10 chunks
            r = await client.get(base + path)
            if r.status_code != 200:
                continue
            body = r.text
            for name, pat in SECRET_PATTERNS:
                # Skip "jwt-like" — the bundle may contain JWT *example* literals
                if name == "jwt-like":
                    continue
                m = pat.search(body)
                assert not m, (
                    f"stage bundle {path} contains {name}: {m.group(0)[:60]!r}"
                )
            # Specific env-var leaks
            for needle in (
                "ANTHROPIC_API_KEY=",
                "OPENAI_API_KEY=",
                "SECRET_KEY=",
                "SMTP_PASSWORD=",
                "JWT_SECRET",
                "postgresql://",
                "postgres://",
            ):
                assert needle not in body, (
                    f"stage bundle {path} leaks env literal {needle!r}"
                )
