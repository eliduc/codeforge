"""R12 — Streaming default + schema extensions.

Verifies:
  - orchestrator computes `streaming_enabled = True` when settings is empty
    (default flipped from False → True in R12).
  - Explicit `{"streaming": False}` still wins (opt-out preserved).
  - Explicit `{"streaming": True}` evaluates True.
  - SessionSettings schema accepts `streaming: bool | None`.
  - _KNOWN_LANGUAGES accepts new browser-language hints.
  - PATCH /api/sessions/{id} with `{"settings": {"streaming": true}}` ⇒ 200.
  - PATCH with new language values ⇒ 200; bogus values ⇒ 422.
  - extra="forbid" still rejects unknown settings keys.
"""
from __future__ import annotations

import uuid

import httpx
import pytest


# ===========================================================================
# Part 1 — pure schema unit tests (no backend needed).
# ===========================================================================


# Mark only the API tests as e2e/asyncio. Schema tests run without backend.

def test_session_settings_default_streaming_is_none():
    """SessionSettings() default → streaming is None (orchestrator interprets → True)."""
    try:
        from app.schemas import SessionSettings
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")
    s = SessionSettings()
    assert s.streaming is None


def test_session_settings_accepts_streaming_true():
    try:
        from app.schemas import SessionSettings
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")
    s = SessionSettings(streaming=True)
    assert s.streaming is True


def test_session_settings_accepts_streaming_false():
    try:
        from app.schemas import SessionSettings
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")
    s = SessionSettings(streaming=False)
    assert s.streaming is False


def test_session_settings_rejects_unknown_keys():
    """B.9 — extra='forbid' must still reject unknown setting keys."""
    try:
        from app.schemas import SessionSettings
        from pydantic import ValidationError
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")
    with pytest.raises(ValidationError):
        SessionSettings(foo="bar")  # type: ignore[call-arg]


def test_known_languages_includes_browser_variants():
    """B.6/B.7 — javascript_browser, typescript_browser, htm allowed."""
    try:
        from app.schemas import SessionCreate
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")
    langs = SessionCreate._KNOWN_LANGUAGES
    assert "javascript_browser" in langs
    assert "typescript_browser" in langs
    assert "htm" in langs


def test_session_create_accepts_browser_languages():
    try:
        from app.schemas import SessionCreate
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")
    obj = SessionCreate(
        name="t", specification="x", language="javascript_browser"
    )
    assert obj.language == "javascript_browser"
    obj2 = SessionCreate(
        name="t", specification="x", language="typescript_browser"
    )
    assert obj2.language == "typescript_browser"


def test_session_create_rejects_fake_language():
    """B.8 — Unknown language values still 422 / ValidationError."""
    try:
        from app.schemas import SessionCreate
        from pydantic import ValidationError
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")
    with pytest.raises(ValidationError):
        SessionCreate(name="t", specification="x", language="totally_fake_lang")


def test_session_update_accepts_browser_languages():
    """B.6/B.7 — SessionUpdate also accepts new languages."""
    try:
        from app.schemas import SessionUpdate
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")
    o = SessionUpdate(language="javascript_browser")
    assert o.language == "javascript_browser"
    o2 = SessionUpdate(language="typescript_browser")
    assert o2.language == "typescript_browser"


def test_session_update_rejects_fake_language():
    try:
        from app.schemas import SessionUpdate
        from pydantic import ValidationError
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")
    with pytest.raises(ValidationError):
        SessionUpdate(language="not_a_real_lang")


# ===========================================================================
# Part 2 — streaming_enabled default in orchestrator
# ===========================================================================


def _resolve_streaming_enabled(settings):
    """Behaviorally exercise the REAL orchestrator logic (КАО#R5-streaming-test).

    Replaces the previous ``inspect.getsource`` substring assertion, which was
    brittle (a behavior-preserving refactor broke it) and not behavioral.
    """
    try:
        from app.core.orchestrator import WorkflowOrchestrator
    except Exception as exc:  # pragma: no cover
        pytest.skip(f"orchestrator not importable: {exc!r}")
    return WorkflowOrchestrator._resolve_streaming_enabled(settings)


def test_orchestrator_streaming_default_is_true_for_empty_settings():
    """B.1 — `settings = {}` → streaming_enabled = True (default ON)."""
    assert _resolve_streaming_enabled({}) is True


def test_orchestrator_streaming_logic_explicit_false():
    """B.2 — explicit False preserved."""
    assert _resolve_streaming_enabled({"streaming": False}) is False


def test_orchestrator_streaming_logic_explicit_true():
    """B.3 — explicit True preserved."""
    assert _resolve_streaming_enabled({"streaming": True}) is True


def test_orchestrator_streaming_logic_none_settings():
    """`session.settings` may be None; the resolver coerces to {} → True."""
    assert _resolve_streaming_enabled(None) is True


# ===========================================================================
# Part 3 — HTTP integration tests (require running backend).
# ===========================================================================


class TestStreamingAndLanguageEndpoints:
    """Backend-required tests. Marked e2e + asyncio."""

    pytestmark = [pytest.mark.asyncio, pytest.mark.e2e]

    async def test_create_session_with_streaming_true(
        self, auth_client: httpx.Client
    ) -> None:
        """B.4 — POST /api/sessions/ with settings.streaming=true returns 201/200
        and persists the value."""
        name = f"r12-stream-{uuid.uuid4().hex[:8]}"
        r = auth_client.post(
            "/api/sessions/",
            json={
                "name": name,
                "specification": "noop",
                "settings": {"streaming": True},
            },
        )
        assert r.status_code in (200, 201), r.text
        body = r.json()
        sid = body["id"]
        try:
            got = auth_client.get(f"/api/sessions/{sid}").json()
            assert got["settings"].get("streaming") is True
        finally:
            auth_client.delete(f"/api/sessions/{sid}")

    async def test_patch_session_streaming_true(
        self, auth_client: httpx.Client, created_session: str
    ) -> None:
        """B.5 — PATCH /api/sessions/{id} with settings.streaming=true returns 200.

        Was 422 before the fix (when settings was a bare dict — pydantic v2 rejected
        unknown keys; or when settings wasn't in _ALLOWED_UPDATE_FIELDS)."""
        r = auth_client.patch(
            f"/api/sessions/{created_session}",
            json={"settings": {"streaming": True}},
        )
        assert r.status_code in (200, 204), r.text
        got = auth_client.get(f"/api/sessions/{created_session}").json()
        assert got["settings"].get("streaming") is True

    async def test_patch_session_streaming_false(
        self, auth_client: httpx.Client, created_session: str
    ) -> None:
        """Symmetry: streaming=false also accepted."""
        r = auth_client.patch(
            f"/api/sessions/{created_session}",
            json={"settings": {"streaming": False}},
        )
        assert r.status_code in (200, 204), r.text
        got = auth_client.get(f"/api/sessions/{created_session}").json()
        assert got["settings"].get("streaming") is False

    async def test_patch_session_language_javascript_browser(
        self, auth_client: httpx.Client, created_session: str
    ) -> None:
        """B.6 — PATCH language=javascript_browser returns 200 (was 422)."""
        r = auth_client.patch(
            f"/api/sessions/{created_session}",
            json={"language": "javascript_browser"},
        )
        assert r.status_code in (200, 204), r.text
        got = auth_client.get(f"/api/sessions/{created_session}").json()
        assert got["language"] == "javascript_browser"

    async def test_patch_session_language_typescript_browser(
        self, auth_client: httpx.Client, created_session: str
    ) -> None:
        """B.7 — PATCH language=typescript_browser returns 200."""
        r = auth_client.patch(
            f"/api/sessions/{created_session}",
            json={"language": "typescript_browser"},
        )
        assert r.status_code in (200, 204), r.text

    async def test_patch_session_language_fake_rejected(
        self, auth_client: httpx.Client, created_session: str
    ) -> None:
        """B.8 — Bogus language still 422."""
        r = auth_client.patch(
            f"/api/sessions/{created_session}",
            json={"language": "totally_fake_lang"},
        )
        assert r.status_code == 422, r.text

    async def test_patch_session_unknown_settings_key_rejected(
        self, auth_client: httpx.Client, created_session: str
    ) -> None:
        """B.9 — settings={"foo": "bar"} → 422 (extra='forbid')."""
        r = auth_client.patch(
            f"/api/sessions/{created_session}",
            json={"settings": {"foo": "bar"}},
        )
        # 422 from pydantic; some routes may surface as 400.
        assert r.status_code in (400, 422), r.text

    async def test_create_session_with_htm_language(
        self, auth_client: httpx.Client
    ) -> None:
        """`htm` is whitelisted in _KNOWN_LANGUAGES (alias for html)."""
        r = auth_client.post(
            "/api/sessions/",
            json={
                "name": f"r12-htm-{uuid.uuid4().hex[:8]}",
                "specification": "noop",
                "language": "htm",
            },
        )
        assert r.status_code in (200, 201), r.text
        sid = r.json()["id"]
        try:
            assert r.json()["language"] == "htm"
        finally:
            auth_client.delete(f"/api/sessions/{sid}")
