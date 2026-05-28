"""КАО regression tests for the Visual Review changes landed in this session.

Covers three jira-tracked fixes:

  * **VR-22** — `sign_screenshot_url` / `verify_screenshot_signature` HMAC helpers
    AND the `serve_screenshot` route's dual-auth path (signed URL OR Bearer).
  * **VR-23** — `GET /api/sessions/{sid}/visual-review/{cvid}/preview` endpoint:
    returns the candidate's raw HTML (wrapped in a minimal scaffold for non-HTML
    payloads) so the panel's "Live preview" iframe can render via `srcdoc`.
  * **VR-27** — `visual_review_scores.score` widened from `Integer` to
    `Numeric(3, 1)` (migration 021) so half-step scores from the frontend slider
    (step=0.5) submit cleanly instead of triggering Pydantic 422.

Each test has a docstring spelling out the concrete regression it catches.
The tests are unit-level: DB-bearing tests mock `get_db` via FastAPI's
`dependency_overrides` so no live Postgres is required. The static SQLAlchemy
model checks introspect `VisualReviewScore.__table__` directly, which is also
DB-free.

Conventions:
  * `monkeypatch` is used to set a stable `SECRET_KEY` and bust the cached
    settings before every signing/verifying call (the helper reads
    `get_settings().secret_key` lazily).
  * The TestClient is built from `app.main.app`, with `app.api.routes.visual_review`
    swapped to use in-memory fake DB sessions so the actual ORM round-trip is
    bypassed but the route's auth and serialization paths still execute.
"""
from __future__ import annotations

import hashlib
import hmac
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


SECRET_A = "kao-test-secret-A-please-rotate-32+chars-long"
SECRET_B = "kao-test-secret-B-DIFFERENT-32+chars-long-xxx"


def _reset_settings_cache() -> None:
    """Bust the lru_cache on get_settings so subsequent calls re-read env vars."""
    from app.core.config import get_settings as core_get_settings
    try:
        core_get_settings.cache_clear()
    except AttributeError:
        pass


@contextmanager
def _with_secret(monkeypatch: pytest.MonkeyPatch, secret: str):
    """Temporarily set SECRET_KEY and reset the settings cache around the block."""
    monkeypatch.setenv("SECRET_KEY", secret)
    _reset_settings_cache()
    try:
        yield
    finally:
        _reset_settings_cache()


def _parse_signed_url(url: str) -> dict[str, str]:
    """Return {exp, sig} parsed from the query string of a signed URL."""
    assert "?" in url, f"URL has no query string: {url!r}"
    qs = url.split("?", 1)[1]
    return dict(p.split("=", 1) for p in qs.split("&"))


# ===========================================================================
# VR-22 — sign_screenshot_url / verify_screenshot_signature unit tests
# ===========================================================================


def test_vr22_signed_url_secret_rotation_invalidates_old_sig(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches the regression where the HMAC is computed against a constant
    salt rather than against `settings.secret_key`. If sign/verify hard-coded
    the secret, rotating SECRET_KEY would NOT invalidate old URLs — which
    would mean a leaked SECRET_KEY couldn't be remediated by rotation."""
    from app.core.visual_review import (
        sign_screenshot_url,
        verify_screenshot_signature,
    )

    sid, cvid = "sess-A", "cv-A"
    with _with_secret(monkeypatch, SECRET_A):
        url = sign_screenshot_url(sid, cvid, frame_index=0)
        parts = _parse_signed_url(url)
        # Sanity: round-trip works with the SAME secret.
        assert verify_screenshot_signature(
            sid, cvid, frame_index=0,
            exp=int(parts["exp"]), sig=parts["sig"],
        ) is True

    with _with_secret(monkeypatch, SECRET_B):
        # The exp+sig pair signed under SECRET_A must now FAIL under SECRET_B.
        assert verify_screenshot_signature(
            sid, cvid, frame_index=0,
            exp=int(parts["exp"]), sig=parts["sig"],
        ) is False


def test_vr22_signed_url_ttl_boundary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Catches an off-by-one in the expiry check. The well-defined contract is:

      * `exp < now`  → expired (definitely invalid)
      * `exp == now` → boundary — must be treated as expired (no grace second)
      * `exp > now`  → valid

    A regression where the check drifts to `<=` would let leaked URLs survive
    one extra second past their stated expiry. We pin all three cases here.
    """
    from app.core.visual_review import (
        verify_screenshot_signature,
        _signed_url_payload,
        _signing_secret,
    )

    sid, cvid = "sess-B", "cv-B"
    pinned_now = 1_700_000_000
    with _with_secret(monkeypatch, SECRET_A):
        # exp = now - 1 → definitely expired
        for delta, expected in [(-1, False), (0, False), (+1, True)]:
            exp = pinned_now + delta
            payload = _signed_url_payload(sid, cvid, 0, exp)
            sig = hmac.new(
                _signing_secret(), payload.encode("utf-8"), hashlib.sha256
            ).hexdigest()
            got = verify_screenshot_signature(
                sid, cvid, frame_index=0, exp=exp, sig=sig, now=pinned_now,
            )
            assert got is expected, (
                f"exp = now + {delta}: expected verify -> {expected}, got {got}. "
                "If exp==now starts returning True, the comparison drifted from "
                "strict-less-than to less-than-or-equal — fix verify_screenshot_signature."
            )


def test_vr22_signed_url_cross_session_isolation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A signature minted for (session_A, cv, frame) MUST NOT validate against
    (session_B, cv, frame). Catches a regression where session_id is dropped
    from the HMAC payload, which would let a URL leaked from session A unlock
    the same code-version+frame in any other session."""
    from app.core.visual_review import (
        sign_screenshot_url,
        verify_screenshot_signature,
    )

    cvid = "shared-cv-id"
    with _with_secret(monkeypatch, SECRET_A):
        url_a = sign_screenshot_url("session-A", cvid, frame_index=0)
        parts = _parse_signed_url(url_a)
        # Try to use the sig minted for session-A against session-B — must fail.
        assert verify_screenshot_signature(
            "session-B", cvid, frame_index=0,
            exp=int(parts["exp"]), sig=parts["sig"],
        ) is False


def test_vr22_signed_url_format_invariants(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The URL the frontend stuffs into `<img src>` must satisfy: exactly one
    `?`, exactly one `exp=`, exactly one `sig=`, sig is 64 hex chars (sha256).
    A regression here usually means a second query param was concatenated with
    `?` rather than `&` (which the browser then drops silently)."""
    from app.core.visual_review import sign_screenshot_url

    with _with_secret(monkeypatch, SECRET_A):
        url = sign_screenshot_url("sid-xyz", "cv-xyz", frame_index=3)

    assert url.count("?") == 1, f"Expected exactly one '?' in {url!r}"
    assert url.count("exp=") == 1, f"Expected exactly one exp= in {url!r}"
    assert url.count("sig=") == 1, f"Expected exactly one sig= in {url!r}"

    parts = _parse_signed_url(url)
    sig = parts["sig"]
    assert len(sig) == 64, f"sig should be 64 hex chars (sha256), got {len(sig)}"
    assert all(c in "0123456789abcdef" for c in sig), (
        f"sig must be lowercase hex, got {sig!r}"
    )


# ===========================================================================
# VR-22 — serve_screenshot route auth (signed URL OR Bearer) via TestClient
# ===========================================================================
#
# We mock the DB at the FastAPI dependency level and replace `get_storage_root`
# with a temp dir containing one real PNG. Auth is forced ON by populating
# settings.codeforge_api_key for the test.


@pytest.fixture
def screenshot_test_setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Provision an in-memory route fixture: temp PNG on disk + mocked DB +
    forced-on auth. Returns (client, sid, cvid, frame_index, owner_user_id)."""
    try:
        from fastapi.testclient import TestClient
        from app.main import app
        from app.db.database import get_db
        from app.core import visual_review as vr_core
        from app.api.routes import visual_review as vr_routes
        from app.config import get_settings as cfg_get_settings
    except Exception as exc:  # pragma: no cover - import-time skip
        pytest.skip(f"backend modules not importable: {exc!r}")

    # 1. Build a real PNG on disk under a temp STORAGE_ROOT.
    sid = str(uuid4())
    cvid = str(uuid4())
    frame_idx = 0
    storage_root = tmp_path / "storage"
    shot_dir = storage_root / "screenshots" / sid / cvid
    shot_dir.mkdir(parents=True, exist_ok=True)
    png_path = shot_dir / f"frame_{frame_idx}.png"
    # Minimal valid 1x1 PNG (89 50 4E 47 ... IEND chunk).
    png_path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
        b"\x00\x00\x00\rIDATx\x9cc\xf8\xcf\xc0\x00\x00\x00\x03\x00\x01\x5b\xb6\xee\x56"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )

    # 2. Pin storage root + SECRET_KEY + force-on auth via API key.
    monkeypatch.setenv("STORAGE_ROOT", str(storage_root))
    monkeypatch.setenv("SECRET_KEY", SECRET_A)
    monkeypatch.setenv("CODEFORGE_API_KEY", "test-api-key-for-bearer-path")
    # Bust caches in both config modules (the route imports from app.core.config;
    # app.config also caches independently).
    _reset_settings_cache()
    try:
        cfg_get_settings.cache_clear()
    except AttributeError:
        pass

    # Also override get_storage_root inside both the core module and the route
    # module (the latter re-imported it by name).
    monkeypatch.setattr(vr_core, "get_storage_root", lambda: storage_root)
    monkeypatch.setattr(vr_routes, "get_storage_root", lambda: storage_root)

    # 3. Mock the DB execute() chain to return the expected (shot, owner_id) row.
    owner_user_id = str(uuid4())

    class _Row:
        def __init__(self, owner: str):
            self._owner = owner
        def first(self):
            return (object(), self._owner)  # (_shot, owner_id) — _shot is unused

    class _MissingRow:
        def first(self):
            return None

    state = {"return_owner": owner_user_id, "missing": False}

    async def fake_execute(*args, **kwargs):
        if state["missing"]:
            return _MissingRow()
        return _Row(state["return_owner"])

    fake_db = MagicMock()
    fake_db.execute = AsyncMock(side_effect=fake_execute)

    async def _override_get_db():
        yield fake_db

    app.dependency_overrides[get_db] = _override_get_db
    client = TestClient(app)
    try:
        yield {
            "client": client,
            "sid": sid,
            "cvid": cvid,
            "frame_idx": frame_idx,
            "owner_user_id": owner_user_id,
            "state": state,
            "png_path": png_path,
        }
    finally:
        app.dependency_overrides.pop(get_db, None)


def test_vr22_serve_screenshot_valid_signed_url_returns_png(screenshot_test_setup) -> None:
    """A correctly signed URL must serve the PNG with Content-Type image/png.
    This is the path the browser <img> tag hits — if it 401s, every thumbnail
    in the Visual Review panel renders broken."""
    from app.core.visual_review import sign_screenshot_url
    setup = screenshot_test_setup
    url = sign_screenshot_url(setup["sid"], setup["cvid"], frame_index=setup["frame_idx"])
    resp = setup["client"].get(url)
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "image/png"
    assert resp.content.startswith(b"\x89PNG")


def test_vr22_serve_screenshot_tampered_sig_returns_404(screenshot_test_setup) -> None:
    """A tampered sig must NOT leak existence — server returns 404 (not 401/403)
    so an attacker can't enumerate frames by signature error code."""
    from app.core.visual_review import sign_screenshot_url
    setup = screenshot_test_setup
    url = sign_screenshot_url(setup["sid"], setup["cvid"], frame_index=setup["frame_idx"])
    # Replace sig with a deterministically-wrong value of the right shape.
    base, qs = url.split("?", 1)
    parts = dict(p.split("=", 1) for p in qs.split("&"))
    bad_sig = ("0" * 64) if parts["sig"][0] != "0" else ("f" * 64)
    tampered = f"{base}?exp={parts['exp']}&sig={bad_sig}"
    resp = setup["client"].get(tampered)
    assert resp.status_code == 404, resp.text


def test_vr22_serve_screenshot_expired_returns_404(screenshot_test_setup) -> None:
    """An expired signed URL must 404 (not 410, not 401) — symmetric with the
    tampered-sig case, again to avoid leaking existence."""
    from app.core.visual_review import sign_screenshot_url
    setup = screenshot_test_setup
    # Sign with the time pinned 1 hour in the past and ttl=1s → exp is way past.
    url = sign_screenshot_url(
        setup["sid"], setup["cvid"], frame_index=setup["frame_idx"],
        ttl_seconds=1, now=int(time.time()) - 3600,
    )
    resp = setup["client"].get(url)
    assert resp.status_code == 404, resp.text


def test_vr22_serve_screenshot_bearer_no_sig_returns_png(screenshot_test_setup) -> None:
    """Backward-compat: CLI / E2E callers without a signed URL but WITH a valid
    Bearer (API key in this fixture) must still receive the PNG. Catches a
    regression where the signed-URL path is made mandatory."""
    setup = screenshot_test_setup
    # Make owner_id match the authenticated context — API-key auth has no
    # user_id, so the ownership branch (`current_user_id is not None`) is
    # skipped and any owner is OK.
    setup["state"]["return_owner"] = "any-owner-uuid"
    url = (
        f"/api/screenshots/{setup['sid']}/{setup['cvid']}/"
        f"frame_{setup['frame_idx']}.png"
    )
    resp = setup["client"].get(
        url, headers={"Authorization": "Bearer test-api-key-for-bearer-path"}
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers["content-type"] == "image/png"


def test_vr22_serve_screenshot_no_auth_no_sig_returns_401(screenshot_test_setup) -> None:
    """Neither a Bearer header NOR a sig → 401. The route must NOT silently
    serve PNGs to fully anonymous callers; that would break multi-tenancy."""
    setup = screenshot_test_setup
    url = (
        f"/api/screenshots/{setup['sid']}/{setup['cvid']}/"
        f"frame_{setup['frame_idx']}.png"
    )
    resp = setup["client"].get(url)
    assert resp.status_code == 401, resp.text


def test_vr22_serve_screenshot_bearer_wrong_owner_returns_404(screenshot_test_setup) -> None:
    """A Bearer JWT whose `sub` doesn't match the session's user_id must 404
    (not 200, not 403) — same anti-enumeration property as the signed-URL
    branch. This pins the multi-tenancy guard on the Bearer path."""
    setup = screenshot_test_setup
    # We need to simulate a JWT with a `sub` claim. Easiest: monkeypatch
    # require_auth on the route module to return a foreign user_id.
    from app.api.routes import visual_review as vr_routes

    async def fake_require_auth(*_a, **_k):
        return {"sub": "DIFFERENT-user-uuid"}

    # The route imports `require_auth` by name, so patch the binding there.
    original = vr_routes.require_auth
    vr_routes.require_auth = fake_require_auth  # type: ignore[assignment]
    # Make the DB return a row whose owner_id is some OTHER user.
    setup["state"]["return_owner"] = "owner-uuid-A"
    try:
        url = (
            f"/api/screenshots/{setup['sid']}/{setup['cvid']}/"
            f"frame_{setup['frame_idx']}.png"
        )
        resp = setup["client"].get(url, headers={"Authorization": "Bearer something"})
        assert resp.status_code == 404, resp.text
    finally:
        vr_routes.require_auth = original  # type: ignore[assignment]


# ===========================================================================
# VR-23 — /preview endpoint
# ===========================================================================


class _FakeSession:
    """Mimics the few fields the preview route reads from db.models.Session."""

    def __init__(self, *, id: str, status: Any, user_id: str | None = None):
        self.id = id
        self.status = status
        self.user_id = user_id


class _FakeCodeVersion:
    """Mimics db.models.CodeVersion (only code_content + id are read)."""

    def __init__(self, *, id: str, session_id: str, code_content: str):
        self.id = id
        self.session_id = session_id
        self.code_content = code_content


def _build_preview_client(
    monkeypatch: pytest.MonkeyPatch,
    *,
    session_obj: Any,
    code_version_obj: Any | None,
):
    """Build a TestClient with get_db mocked so the preview route can run
    without a real DB. Sequentially returns session_obj then code_version_obj."""
    from fastapi.testclient import TestClient
    from app.main import app
    from app.db.database import get_db
    from app.config import get_settings as cfg_get_settings

    # Force auth ON so the route exercises the real Depends(require_auth).
    monkeypatch.setenv("CODEFORGE_API_KEY", "preview-test-key")
    _reset_settings_cache()
    try:
        cfg_get_settings.cache_clear()
    except AttributeError:
        pass

    call_count = {"n": 0}

    class _FakeScalarResult:
        def __init__(self, val):
            self._val = val
        def scalar_one_or_none(self):
            return self._val

    async def fake_execute(*args, **kwargs):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _FakeScalarResult(session_obj)
        return _FakeScalarResult(code_version_obj)

    fake_db = MagicMock()
    fake_db.execute = AsyncMock(side_effect=fake_execute)

    async def _override_get_db():
        yield fake_db

    app.dependency_overrides[get_db] = _override_get_db
    client = TestClient(app)
    return client, app


def _preview_headers() -> dict[str, str]:
    return {"Authorization": "Bearer preview-test-key"}


def test_vr23_preview_returns_html_for_awaiting_session(monkeypatch: pytest.MonkeyPatch) -> None:
    """When the session is in awaiting_visual_review and the code_version exists,
    the route must return the raw HTML with Content-Type text/html. This is
    the happy path the panel's iframe srcdoc relies on."""
    from app.db.models import SessionStatus
    sid = str(uuid4())
    cvid = str(uuid4())
    html = "<!DOCTYPE html><html><body>Hello World</body></html>"
    sess = _FakeSession(id=sid, status=SessionStatus.AWAITING_VISUAL_REVIEW)
    cv = _FakeCodeVersion(id=cvid, session_id=sid, code_content=html)

    client, app = _build_preview_client(monkeypatch, session_obj=sess, code_version_obj=cv)
    try:
        resp = client.get(
            f"/api/sessions/{sid}/visual-review/{cvid}/preview",
            headers=_preview_headers(),
        )
        assert resp.status_code == 200, resp.text
        assert resp.headers["content-type"].startswith("text/html")
        assert resp.text == html
    finally:
        from app.db.database import get_db
        app.dependency_overrides.pop(get_db, None)


def test_vr23_preview_wrong_status_returns_404(monkeypatch: pytest.MonkeyPatch) -> None:
    """Sessions not in awaiting_visual_review must 404 — otherwise the panel
    would let users peek at completed/failed sessions through this endpoint,
    breaking the "preview is a review-time tool only" invariant."""
    from app.db.models import SessionStatus
    sid = str(uuid4())
    cvid = str(uuid4())
    sess = _FakeSession(id=sid, status=SessionStatus.COMPLETED)
    client, app = _build_preview_client(monkeypatch, session_obj=sess, code_version_obj=None)
    try:
        resp = client.get(
            f"/api/sessions/{sid}/visual-review/{cvid}/preview",
            headers=_preview_headers(),
        )
        assert resp.status_code == 404, resp.text
    finally:
        from app.db.database import get_db
        app.dependency_overrides.pop(get_db, None)


def test_vr23_preview_wrong_session_id_returns_404(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unknown session_id → 404 (the DB scalar_one_or_none returns None)."""
    sid = str(uuid4())
    cvid = str(uuid4())
    client, app = _build_preview_client(monkeypatch, session_obj=None, code_version_obj=None)
    try:
        resp = client.get(
            f"/api/sessions/{sid}/visual-review/{cvid}/preview",
            headers=_preview_headers(),
        )
        assert resp.status_code == 404, resp.text
    finally:
        from app.db.database import get_db
        app.dependency_overrides.pop(get_db, None)


def test_vr23_preview_wrong_code_version_id_returns_404(monkeypatch: pytest.MonkeyPatch) -> None:
    """Session exists & is in awaiting_visual_review, but the code_version_id
    is not present (e.g. it belongs to a different session). Must 404."""
    from app.db.models import SessionStatus
    sid = str(uuid4())
    cvid = str(uuid4())
    sess = _FakeSession(id=sid, status=SessionStatus.AWAITING_VISUAL_REVIEW)
    client, app = _build_preview_client(monkeypatch, session_obj=sess, code_version_obj=None)
    try:
        resp = client.get(
            f"/api/sessions/{sid}/visual-review/{cvid}/preview",
            headers=_preview_headers(),
        )
        assert resp.status_code == 404, resp.text
    finally:
        from app.db.database import get_db
        app.dependency_overrides.pop(get_db, None)


def test_vr23_preview_non_html_payload_is_wrapped_in_scaffold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Coders sometimes return a bare JS body instead of full HTML. The route
    MUST wrap it in a minimal `<!DOCTYPE html>...<script>...</script>` scaffold
    so the iframe still shows SOMETHING usable. Without this wrap, the iframe
    would render the raw JS as text."""
    from app.db.models import SessionStatus
    sid = str(uuid4())
    cvid = str(uuid4())
    js_body = "console.log('hi');"
    sess = _FakeSession(id=sid, status=SessionStatus.AWAITING_VISUAL_REVIEW)
    cv = _FakeCodeVersion(id=cvid, session_id=sid, code_content=js_body)

    client, app = _build_preview_client(monkeypatch, session_obj=sess, code_version_obj=cv)
    try:
        resp = client.get(
            f"/api/sessions/{sid}/visual-review/{cvid}/preview",
            headers=_preview_headers(),
        )
        assert resp.status_code == 200, resp.text
        body = resp.text
        assert "<!DOCTYPE html>" in body
        assert "<html" in body
        assert f"<script>{js_body}</script>" in body
    finally:
        from app.db.database import get_db
        app.dependency_overrides.pop(get_db, None)


def test_vr23_preview_already_html_is_passthrough(monkeypatch: pytest.MonkeyPatch) -> None:
    """If the candidate already begins with `<!doctype` or `<html`, the route
    must NOT double-wrap it. Wrapping HTML inside another <script> tag would
    turn the page into a syntax-error blob."""
    from app.db.models import SessionStatus
    sid = str(uuid4())
    cvid = str(uuid4())
    # Mixed-case + leading whitespace to exercise the lstrip + lower() path.
    html = "   <!DocType html><html><head></head><body>x</body></html>"
    sess = _FakeSession(id=sid, status=SessionStatus.AWAITING_VISUAL_REVIEW)
    cv = _FakeCodeVersion(id=cvid, session_id=sid, code_content=html)

    client, app = _build_preview_client(monkeypatch, session_obj=sess, code_version_obj=cv)
    try:
        resp = client.get(
            f"/api/sessions/{sid}/visual-review/{cvid}/preview",
            headers=_preview_headers(),
        )
        assert resp.status_code == 200, resp.text
        # Returned as-is — the route only re-wraps when stripped lower() does
        # not start with <!doctype / <html.
        assert resp.text == html
        # And it must NOT have introduced an extra <script> wrapper.
        assert "<script>" not in resp.text
    finally:
        from app.db.database import get_db
        app.dependency_overrides.pop(get_db, None)


# ===========================================================================
# VR-27 — score is float (Pydantic) + Numeric(3,1) (SQLAlchemy + migration)
# ===========================================================================


def test_vr27_score_item_accepts_half_step_float() -> None:
    """The whole point of VR-27. Pydantic must accept `score=7.5` without
    raising ValidationError. Before migration 021 + schema change, this was
    blocked because `_ScoreItem.score` was `int`."""
    from app.api.routes.visual_review import _ScoreItem
    item = _ScoreItem(code_version_id=uuid4(), score=7.5)
    assert item.score == 7.5


@pytest.mark.parametrize("value", [0.0, 10.0, 0.5, 9.5])
def test_vr27_score_item_accepts_in_range_floats(value: float) -> None:
    """Boundaries (0.0, 10.0) and arbitrary half-steps must all parse. Catches
    a regression where someone re-narrowed the bound to `gt=0` or `lt=10`."""
    from app.api.routes.visual_review import _ScoreItem
    item = _ScoreItem(code_version_id=uuid4(), score=value)
    assert item.score == value


@pytest.mark.parametrize("value", [10.5, -0.5, 100.0, -100.0])
def test_vr27_score_item_rejects_out_of_range(value: float) -> None:
    """Out-of-range values must still raise ValidationError. We widened the
    type from int to float but the 0..10 range MUST still be enforced —
    otherwise the DB CHECK constraint would be the only line of defence."""
    from pydantic import ValidationError
    from app.api.routes.visual_review import _ScoreItem
    with pytest.raises(ValidationError):
        _ScoreItem(code_version_id=uuid4(), score=value)


def test_vr27_db_column_is_numeric_not_integer() -> None:
    """SQLAlchemy model reflection: `VisualReviewScore.score` MUST be a
    `Numeric` type (not Integer). If someone reverts the model declaration to
    `Integer` without also reverting the migration, the ORM would coerce
    decimals to ints on read and Pydantic would receive whole numbers only —
    silent data loss."""
    import sqlalchemy as sa
    from app.db.models import VisualReviewScore

    col_type = VisualReviewScore.__table__.c.score.type
    assert isinstance(col_type, sa.Numeric), (
        f"Expected Numeric, got {type(col_type).__name__}: {col_type!r}"
    )
    # Numeric(3, 1): precision=3 (max 3 digits total), scale=1 (one after decimal).
    assert getattr(col_type, "precision", None) == 3, (
        f"Expected precision=3, got {col_type.precision!r}"
    )
    assert getattr(col_type, "scale", None) == 1, (
        f"Expected scale=1, got {col_type.scale!r}"
    )


def test_vr27_migration_021_alters_column_to_numeric_and_recreates_check() -> None:
    """Static check on migration 021: it MUST contain both the alter_column
    to Numeric(3, 1) AND the recreation of `ck_visual_review_score_range`.
    Postgres drops CHECK constraints when the underlying column type changes,
    so dropping the recreation would silently allow scores like 15.5 to land
    in the DB."""
    # Walk up from this test file to /app/alembic/versions/021_vr_score_numeric.py.
    # In the container, the test file is at /app/tests/test_kao_vr22_to_27.py,
    # and the migration is at /app/alembic/versions/021_vr_score_numeric.py.
    here = Path(__file__).resolve()
    # /app/tests/<this>.py  →  /app/alembic/versions/021_vr_score_numeric.py
    candidate = here.parent.parent / "alembic" / "versions" / "021_vr_score_numeric.py"
    if not candidate.exists():
        # Fallback: search the project for it (test may be invoked from a
        # different working dir layout).
        root = here.parent.parent
        matches = list(root.rglob("021_vr_score_numeric.py"))
        if not matches:
            pytest.skip(
                f"Migration 021 file not found near {here}; checked {candidate}"
            )
        candidate = matches[0]
    text = candidate.read_text(encoding="utf-8")

    assert "op.alter_column" in text, (
        "Migration 021 must call op.alter_column — without it, the DB column "
        "type stays Integer and half-step scores fail at insert time."
    )
    # The widening MUST be to Numeric(3, 1) specifically.
    assert "sa.Numeric(3, 1)" in text or "sa.Numeric(3,1)" in text, (
        "Migration 021 must widen score to sa.Numeric(3, 1). Any other type "
        "(Float, Numeric(5,2), …) silently changes precision and breaks the "
        "matching SQLAlchemy model declaration."
    )
    # The CHECK constraint MUST be recreated after the column-type change.
    assert "ck_visual_review_score_range" in text, (
        "Migration 021 must reference ck_visual_review_score_range — Postgres "
        "drops CHECKs when the underlying column type changes, so the migration "
        "must recreate it explicitly."
    )
    assert "create_check_constraint" in text, (
        "Migration 021 must call op.create_check_constraint to re-add the "
        "0..10 range check after the alter_column."
    )
