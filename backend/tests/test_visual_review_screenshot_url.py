"""Regression tests for КАО#VR-22 — screenshot URL must live under /api/.

Background: the frontend nginx in front of the backend only proxies ``/api/*``
and ``/ws/*`` to the backend container. Everything else falls through to the
SPA's catch-all ``try_files $uri /index.html``. If the screenshot route ever
gets re-registered at the bare ``/screenshots/...`` prefix again, every
``<img src>`` in the Visual Review panel will receive ``index.html`` (1.1 KB
HTML, ``Content-Type: text/html``) and the browser will render a broken image.

This file pins two invariants that together prevent the regression:

  1. The route the backend exposes for serving PNG screenshots starts with
     ``/api/`` so the frontend nginx proxies it.
  2. The ``image_url`` field derived by the GET visual-review handler ALSO
     starts with ``/api/screenshots/`` so it matches the registered route.

Either invariant alone is necessary but not sufficient — both are checked.
"""
from __future__ import annotations

from app.api.routes import visual_review as visual_review_routes


# ---------------------------------------------------------------------------
# Invariant 1: route registration
# ---------------------------------------------------------------------------


def _screenshot_route_paths() -> list[str]:
    """Return all route paths declared on the static_router that mention
    ``screenshot``. Lets us assert against the FastAPI route table directly
    rather than re-importing internal handler symbols."""
    paths: list[str] = []
    for route in visual_review_routes.static_router.routes:
        path = getattr(route, "path", "")
        if "screenshot" in path.lower():
            paths.append(path)
    return paths


def test_static_router_screenshot_route_is_under_api_prefix() -> None:
    """The PNG-serving route must be registered under ``/api/`` so the
    frontend nginx proxies it to the backend.

    If this test fails, every ``<img>`` in the Visual Review panel will
    receive index.html and render as a broken image (КАО#VR-22)."""
    paths = _screenshot_route_paths()
    assert paths, (
        "No screenshot route found on static_router — has the route been "
        "removed entirely? Check app/api/routes/visual_review.py."
    )
    for path in paths:
        assert path.startswith("/api/"), (
            f"Screenshot route {path!r} does NOT start with /api/. The "
            "frontend nginx only proxies /api/* and /ws/* to the backend, "
            "so this URL would fall through to the SPA's index.html catch-all "
            "and the browser would try to render HTML as an image. "
            "See КАО#VR-22."
        )


def test_static_router_does_not_register_bare_screenshots_path() -> None:
    """Explicitly assert the OLD broken path is gone. We keep this as a
    separate test (rather than only the positive assertion above) so the
    failure message in CI directly names the regression."""
    paths = _screenshot_route_paths()
    bad = [p for p in paths if p.startswith("/screenshots/")]
    assert not bad, (
        f"Found legacy bare /screenshots/ route(s): {bad}. These are not "
        "reachable through the frontend nginx and cause broken images in "
        "the Visual Review panel. Move them under /api/screenshots/. "
        "See КАО#VR-22."
    )


# ---------------------------------------------------------------------------
# Invariant 2: image_url derivation
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Invariant 2: image_url derivation produces a SIGNED URL (КАО#VR-22)
# ---------------------------------------------------------------------------
#
# A bare ``/api/screenshots/...`` URL with no signature would still 401 in the
# browser because <img src> cannot send an Authorization header. The fix is
# a short-lived HMAC signature embedded in the URL itself. These tests pin
# that the URL produced by sign_screenshot_url contains the signature query
# params AND that verify_screenshot_signature accepts what was just signed.


def test_signed_url_has_required_query_params(monkeypatch) -> None:
    """``sign_screenshot_url`` must produce a URL that includes ``exp`` and
    ``sig`` query params. Without them the browser can't fetch the PNG."""
    monkeypatch.setenv("SECRET_KEY", "test-secret-please-rotate-32+chars-long-x")
    # Clear cached settings so the new env var takes effect.
    from app.core.config import get_settings
    get_settings.cache_clear()

    from app.core.visual_review import sign_screenshot_url

    url = sign_screenshot_url(
        session_id="f49ce972-ccc0-4fb0-a876-0f57834e71b4",
        code_version_id="31b60985-b065-4d60-bfcd-3d33f3b247f6",
        frame_index=0,
    )
    assert url.startswith("/api/screenshots/"), f"Wrong prefix: {url!r}"
    assert "?exp=" in url, f"Missing ?exp= in {url!r}"
    assert "&sig=" in url, f"Missing &sig= in {url!r}"
    # sig should be 64 hex chars (sha256)
    sig = url.split("&sig=")[1]
    assert len(sig) == 64 and all(c in "0123456789abcdef" for c in sig), (
        f"sig is not 64 hex chars: {sig!r}"
    )


def test_signed_url_round_trip(monkeypatch) -> None:
    """A URL produced by sign_screenshot_url must verify true with
    verify_screenshot_signature using the same args."""
    monkeypatch.setenv("SECRET_KEY", "test-secret-please-rotate-32+chars-long-x")
    from app.core.config import get_settings
    get_settings.cache_clear()

    from app.core.visual_review import (
        sign_screenshot_url,
        verify_screenshot_signature,
    )

    sid = "f49ce972-ccc0-4fb0-a876-0f57834e71b4"
    cvid = "31b60985-b065-4d60-bfcd-3d33f3b247f6"
    url = sign_screenshot_url(sid, cvid, frame_index=2)
    # parse exp + sig back out of the URL
    qs = url.split("?", 1)[1]
    parts = dict(p.split("=") for p in qs.split("&"))
    assert verify_screenshot_signature(
        sid, cvid, frame_index=2, exp=int(parts["exp"]), sig=parts["sig"]
    ) is True


def test_signed_url_rejects_tampered_sig(monkeypatch) -> None:
    """Any change to sig must fail verification (catches accidental
    truncation, hex-case bugs, or someone disabling the HMAC)."""
    monkeypatch.setenv("SECRET_KEY", "test-secret-please-rotate-32+chars-long-x")
    from app.core.config import get_settings
    get_settings.cache_clear()

    from app.core.visual_review import (
        sign_screenshot_url,
        verify_screenshot_signature,
    )

    sid, cvid = "s", "c"
    url = sign_screenshot_url(sid, cvid, frame_index=0)
    qs = url.split("?", 1)[1]
    parts = dict(p.split("=") for p in qs.split("&"))
    tampered = ("0" * 64) if parts["sig"][0] != "0" else ("f" * 64)
    assert verify_screenshot_signature(
        sid, cvid, frame_index=0, exp=int(parts["exp"]), sig=tampered
    ) is False


def test_signed_url_rejects_expired(monkeypatch) -> None:
    """An exp in the past must fail even with a valid signature."""
    monkeypatch.setenv("SECRET_KEY", "test-secret-please-rotate-32+chars-long-x")
    from app.core.config import get_settings
    get_settings.cache_clear()

    from app.core.visual_review import (
        sign_screenshot_url,
        verify_screenshot_signature,
    )

    sid, cvid = "s", "c"
    # Sign with ttl=1 anchored 1 hour in the past → exp is 1 hour - 1 sec ago.
    url = sign_screenshot_url(sid, cvid, frame_index=0, ttl_seconds=1, now=int(__import__("time").time()) - 3600)
    qs = url.split("?", 1)[1]
    parts = dict(p.split("=") for p in qs.split("&"))
    assert verify_screenshot_signature(
        sid, cvid, frame_index=0, exp=int(parts["exp"]), sig=parts["sig"]
    ) is False


def test_signed_url_rejects_wrong_frame(monkeypatch) -> None:
    """A sig for frame 0 must NOT validate for frame 1 (scope tight)."""
    monkeypatch.setenv("SECRET_KEY", "test-secret-please-rotate-32+chars-long-x")
    from app.core.config import get_settings
    get_settings.cache_clear()

    from app.core.visual_review import (
        sign_screenshot_url,
        verify_screenshot_signature,
    )

    sid, cvid = "s", "c"
    url = sign_screenshot_url(sid, cvid, frame_index=0)
    qs = url.split("?", 1)[1]
    parts = dict(p.split("=") for p in qs.split("&"))
    # Try to use frame 0's sig for frame 1 → must fail.
    assert verify_screenshot_signature(
        sid, cvid, frame_index=1, exp=int(parts["exp"]), sig=parts["sig"]
    ) is False
