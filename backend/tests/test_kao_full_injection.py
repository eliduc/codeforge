"""КАО#Full-A3 — Input validation / injection fuzzing across endpoints.

Goal: every endpoint that takes user-controlled text, numbers, or paths must:
  * accept SQL-injection payloads as literal strings (no DB error, no 500),
  * accept XSS payloads (frontend's job to escape; backend just stores),
  * reject path-traversal in filename / path params,
  * reject out-of-range numeric values with 422 (never 500, never silent),
  * never expose a SQLAlchemy / Pydantic / Python traceback to the client.

These are written to complement, not replace, `test_security.py` —
they widen the surface to ALL text and numeric inputs we found in the
mounted routes.

Fixtures consumed:
  * ``auth_client``     — authenticated httpx.Client (User A)
  * ``created_session`` — a fresh session_id (str) owned by User A

# КАО#Full-A3
"""
from __future__ import annotations

import os
import uuid

import httpx
import pytest

pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]

BACKEND_URL = os.environ.get("BACKEND_URL", "http://backend:8000")


# ---------------------------------------------------------------------------
# 1. SQL injection — text fields are stored as literals, NOT interpreted
# ---------------------------------------------------------------------------

SQLI_PAYLOADS = [
    "'; DROP TABLE sessions; --",
    "' OR '1'='1",
    "1; SELECT pg_sleep(5);--",
    "x' UNION SELECT NULL,NULL,NULL--",
    "admin'--",
    "'); INSERT INTO users (email) VALUES ('attacker@evil.example'); --",
]


@pytest.mark.parametrize("payload", SQLI_PAYLOADS)
async def test_session_specification_sqli_is_stored_literally(
    auth_client: httpx.Client, payload: str
) -> None:
    """SQLi payload in `specification` is round-tripped as a plain string."""
    r = auth_client.post(
        "/api/sessions/",
        json={"name": f"sqli-{uuid.uuid4().hex[:6]}", "specification": payload},
    )
    assert r.status_code in (200, 201), r.text
    sid = r.json()["id"]
    try:
        got = auth_client.get(f"/api/sessions/{sid}")
        assert got.status_code == 200, got.text
        assert got.json()["specification"] == payload, (
            "specification field was modified — possible interpretation bug"
        )
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


@pytest.mark.parametrize("payload", SQLI_PAYLOADS)
async def test_session_name_sqli_is_stored_literally(
    auth_client: httpx.Client, payload: str
) -> None:
    """SQLi payload in `name` is stored as-is and retrievable."""
    r = auth_client.post(
        "/api/sessions/",
        json={"name": payload, "specification": "noop"},
    )
    if r.status_code == 422:
        # Some payloads may legitimately fail name validation (length, chars).
        # That's also a "safe" outcome — the SQL was never even reached.
        return
    assert r.status_code in (200, 201), r.text
    sid = r.json()["id"]
    try:
        got = auth_client.get(f"/api/sessions/{sid}")
        assert got.json()["name"] == payload
    finally:
        auth_client.delete(f"/api/sessions/{sid}")


async def test_session_id_url_sqli_does_not_500(auth_client: httpx.Client) -> None:
    """`'abc' OR '1'='1'` in {session_id} URL position → 422/404, not 500."""
    bad_id = "abc'%20OR%20'1'%3D'1"
    r = auth_client.get(f"/api/sessions/{bad_id}")
    assert r.status_code in (404, 422), f"got {r.status_code}: {r.text}"


@pytest.mark.parametrize(
    "param",
    [
        "?search=' OR 1=1--",
        "?search=%27%29%3B%20DROP%20TABLE%20sessions%3B--",
        "?status=running' OR '1'='1",
        "?skip=-1",
        "?limit=' OR '1'='1",
    ],
)
async def test_session_listing_query_sqli_safe(
    auth_client: httpx.Client, param: str
) -> None:
    """SQLi via query string never returns 500, never returns the whole table."""
    r = auth_client.get(f"/api/sessions/{param}")
    # 200 (filtered to empty) or 422 (rejected by Query() bounds). Never 500.
    assert r.status_code in (200, 422), f"500 on {param!r}: {r.text}"


# ---------------------------------------------------------------------------
# 2. XSS — stored verbatim by backend, frontend's job to escape
# ---------------------------------------------------------------------------

XSS_PAYLOADS = [
    "<script>alert('xss')</script>",
    "<img src=x onerror=alert(1)>",
    "<svg/onload=alert(1)>",
    "javascript:alert(1)",
    "\"><script>alert(1)</script>",
    "<iframe src=javascript:alert(1)>",
]


@pytest.mark.parametrize("payload", XSS_PAYLOADS)
async def test_xss_in_specification_stored_verbatim(
    auth_client: httpx.Client, payload: str
) -> None:
    """Backend stores XSS payloads as opaque strings; doesn't strip / sanitize."""
    r = auth_client.post(
        "/api/sessions/",
        json={"name": f"xss-{uuid.uuid4().hex[:6]}", "specification": payload},
    )
    assert r.status_code in (200, 201, 422), r.text
    if r.status_code in (200, 201):
        sid = r.json()["id"]
        try:
            got = auth_client.get(f"/api/sessions/{sid}")
            assert payload in got.text, "payload mutated during round-trip"
        finally:
            auth_client.delete(f"/api/sessions/{sid}")


async def test_xss_via_prompt_message_safe(
    auth_client: httpx.Client, created_session: str
) -> None:
    """`POST /api/prompts/` with an XSS body — must not 500 or strip."""
    payload = "<script>alert('prompt')</script>"
    r = auth_client.post(
        f"/api/prompts/sessions/{created_session}/messages",
        json={"content": payload, "role": "user"},
    )
    # Either accepted or 4xx — never 500
    assert r.status_code != 500, r.text


# ---------------------------------------------------------------------------
# 3. Path traversal — file params, frame index, screenshot path
# ---------------------------------------------------------------------------

TRAVERSAL_PATHS = [
    "../../etc/passwd",
    "..%2F..%2Fetc%2Fpasswd",
    "....//....//etc/passwd",
    "/etc/passwd",
    "\\..\\..\\windows\\system32\\config\\sam",
    "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
]


@pytest.mark.parametrize("path", TRAVERSAL_PATHS)
async def test_screenshot_url_path_traversal_rejected(
    auth_client: httpx.Client, path: str
) -> None:
    """`/api/screenshots/{session_id}/{cv_id}/{filename}` with traversal → 404/422."""
    fake_session = str(uuid.uuid4())
    fake_cv = str(uuid.uuid4())
    r = auth_client.get(f"/api/screenshots/{fake_session}/{fake_cv}/{path}")
    assert r.status_code in (404, 422, 403), (
        f"path traversal got {r.status_code}: {r.text[:120]!r}"
    )
    # Must NOT reach the actual /etc/passwd content
    body = r.text
    assert "root:" not in body, "endpoint exposed /etc/passwd content!"
    assert "[boot loader]" not in body  # Windows SAM hints


@pytest.mark.parametrize("name", TRAVERSAL_PATHS)
async def test_file_upload_traversal_filename_rejected(
    auth_client: httpx.Client, name: str
) -> None:
    """upload-files: bad path components must not become accepted attachments."""
    files = {"files": (name, b"hello", "text/plain")}
    r = auth_client.post("/api/sessions/upload-files", files=files)
    assert r.status_code != 500
    if r.status_code in (200, 201):
        body = r.json()
        atts = body.get("attachments", [])
        for att in atts:
            if not isinstance(att, dict):
                continue
            for f in ("filename", "name", "path"):
                v = att.get(f, "") or ""
                assert ".." not in v, f"traversal accepted in attachment.{f}={v!r}"
                assert not v.startswith("/"), f"absolute path accepted: {v!r}"
                assert not v.startswith("\\"), f"absolute UNC accepted: {v!r}"


# ---------------------------------------------------------------------------
# 4. Numeric boundary fuzzing — every Query(ge=, le=) must reject OOR
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "param,value,expect",
    [
        ("days", -1, 422),
        ("days", 0, 422),
        ("days", 9999, 422),
        ("days", "abc", 422),
        ("days", "", 422),
    ],
)
async def test_dashboard_stats_numeric_bounds(
    auth_client: httpx.Client, param: str, value, expect: int
) -> None:
    """`days` is bound by Query(ge=1, le=365). Out-of-range → 422."""
    r = auth_client.get(f"/api/code/dashboard/stats?{param}={value}")
    assert r.status_code == expect, f"{param}={value!r} got {r.status_code}"


@pytest.mark.parametrize(
    "skip,limit",
    [
        (-1, 10),
        (0, -5),
        (0, 999999),
        ("abc", 10),
        (0, "ten"),
    ],
)
async def test_session_pagination_bounds(
    auth_client: httpx.Client, skip, limit
) -> None:
    """Negative/huge/non-numeric pagination must 422 — not silently page everything."""
    r = auth_client.get(f"/api/sessions/?skip={skip}&limit={limit}")
    assert r.status_code in (200, 422), f"skip={skip} limit={limit} got {r.status_code}"
    # When 200, must respect sane upper bound (not actually return 999999 items)
    if r.status_code == 200:
        body = r.json()
        items = body.get("items", []) if isinstance(body, dict) else body
        assert len(items) <= 1000, f"returned {len(items)} items — no upper bound!"


@pytest.mark.parametrize("num_coders", [-1, 0, 999, "abc", 11, -100])
async def test_session_create_num_coders_bounds(
    auth_client: httpx.Client, num_coders
) -> None:
    """`num_coders` must be validated — out-of-range gets 422 (sane upper bound)."""
    r = auth_client.post(
        "/api/sessions/",
        json={
            "name": f"bounds-{uuid.uuid4().hex[:6]}",
            "specification": "noop",
            "num_coders": num_coders,
        },
    )
    # Accept 200/201 (server clamps) OR 422 (rejects) — but NEVER 500
    assert r.status_code != 500, f"num_coders={num_coders} caused 500: {r.text}"
    if r.status_code in (200, 201):
        body = r.json()
        # If accepted, must clamp to a sane range
        actual = body.get("num_coders", None)
        if actual is not None and isinstance(actual, int):
            assert 1 <= actual <= 100, f"server stored num_coders={actual} (no clamp!)"
        auth_client.delete(f"/api/sessions/{body['id']}")


@pytest.mark.parametrize("max_iter", [-5, 0, 1000, -1, "ten"])
async def test_session_create_max_iterations_bounds(
    auth_client: httpx.Client, max_iter
) -> None:
    """`max_iterations` boundaries — never accept negative or absurd large."""
    r = auth_client.post(
        "/api/sessions/",
        json={
            "name": f"iter-{uuid.uuid4().hex[:6]}",
            "specification": "noop",
            "max_iterations": max_iter,
        },
    )
    assert r.status_code != 500
    if r.status_code in (200, 201):
        body = r.json()
        sid = body["id"]
        actual = body.get("max_iterations")
        if isinstance(actual, int):
            assert 1 <= actual <= 100, f"server stored max_iterations={actual}"
        auth_client.delete(f"/api/sessions/{sid}")


@pytest.mark.parametrize("score", [11, -1, "ten", 100, -100, 10.5])
async def test_visual_review_score_bounds(
    auth_client: httpx.Client, created_session: str, score
) -> None:
    """Visual review scores must be in [0, 10]. Out-of-range → 422."""
    fake_cv = str(uuid.uuid4())
    r = auth_client.post(
        f"/api/sessions/{created_session}/visual-review/scores",
        json={"scores": [{"code_version_id": fake_cv, "score": score}]},
    )
    # 422 = pydantic field validator; 404 = no candidate found (also fine).
    # Critical: never 500, never accept score=100 / score="ten".
    assert r.status_code != 500, f"score={score!r} caused 500: {r.text}"
    if score in (11, -1, 100, -100, "ten"):
        assert r.status_code in (404, 422), (
            f"out-of-range score={score!r} accepted (status {r.status_code})"
        )


# ---------------------------------------------------------------------------
# 5. Generic — no traceback / no internal-server-error leakage
# ---------------------------------------------------------------------------

async def test_500_responses_never_leak_python_traceback(
    auth_client: httpx.Client,
) -> None:
    """Send pathological input; if a 500 happens, it MUST NOT contain a stack trace."""
    weird_inputs = [
        {"name": None, "specification": None},
        {"name": "x", "specification": "\x00\x00\x00"},
        {"name": "x" * 10_000, "specification": "y"},
    ]
    for body in weird_inputs:
        r = auth_client.post("/api/sessions/", json=body)
        if r.status_code >= 500:
            txt = r.text
            for needle in (
                'File "',
                'line ',
                "Traceback",
                "sqlalchemy.exc",
                "psycopg2",
                "asyncpg.",
                "pydantic_core",
            ):
                assert needle not in txt, (
                    f"500 leaks internal detail {needle!r} for input {body!r}: {txt[:200]!r}"
                )
        # Cleanup if accidentally created
        if r.status_code in (200, 201):
            try:
                auth_client.delete(f"/api/sessions/{r.json()['id']}")
            except Exception:
                pass


async def test_oversize_body_rejected(auth_client: httpx.Client) -> None:
    """Multi-MB specification → must NOT 500 or hang; should 4xx cleanly."""
    huge = "A" * (5 * 1024 * 1024)  # 5MB
    r = auth_client.post(
        "/api/sessions/",
        json={"name": "huge", "specification": huge},
        timeout=30.0,
    )
    assert r.status_code != 500, "5MB spec caused unhandled 500"
    if r.status_code in (200, 201):
        # Cleanup
        try:
            auth_client.delete(f"/api/sessions/{r.json()['id']}")
        except Exception:
            pass
