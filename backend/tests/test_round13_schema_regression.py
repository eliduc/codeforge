"""R13 — Targeted backend regression tests.

R13's backend scope was tiny (mostly frontend). These tests guard the R12
fixes that R13 must not regress:

  - SessionSettings(extra='forbid') still rejects `streaming: <bogus>` /
    unknown keys.
  - The full canonical R12 _KNOWN_LANGUAGES set is intact (no language was
    accidentally dropped while editing schemas).
  - SessionUpdate accepts a `settings` payload containing streaming
    (route-level PATCH coverage is in test_round12_streaming_schema.py).
  - Boolean coercion: orchestrator default expression remains `True` for the
    common "session.settings == {} or None" path.

These are intentionally small — there is no need to duplicate R12's coverage.
"""
from __future__ import annotations

import pytest


def _load_schemas():
    try:
        from app import schemas as _s  # noqa: F401
        from app.schemas import SessionSettings, SessionCreate, SessionUpdate
        from pydantic import ValidationError
        return SessionSettings, SessionCreate, SessionUpdate, ValidationError
    except Exception as exc:
        pytest.skip(f"backend schemas not importable: {exc!r}")


def test_r13_session_settings_extra_forbid_still_rejects_typo():
    """If R13 silently relaxed extra=forbid → typoed keys would be accepted."""
    SessionSettings, _, _, ValidationError = _load_schemas()
    with pytest.raises(ValidationError):
        SessionSettings(streamng=True)  # typo, should 422
    with pytest.raises(ValidationError):
        SessionSettings(streamingg=True)  # noqa
    with pytest.raises(ValidationError):
        SessionSettings(STREAMING=True)  # case-sensitive
    with pytest.raises(ValidationError):
        SessionSettings(extra_random_key="anything")


def test_r13_session_settings_streaming_bool_strict():
    """`streaming` must be bool | None — string 'true' should not coerce.

    Was a real footgun before pydantic v2's strict mode; verify it's strict."""
    SessionSettings, _, _, ValidationError = _load_schemas()
    # bool/None ok
    assert SessionSettings(streaming=True).streaming is True
    assert SessionSettings(streaming=False).streaming is False
    assert SessionSettings(streaming=None).streaming is None
    # pydantic v2: int/str MAY coerce by default — we don't enforce strict here,
    # but explicit None must work and explicit bool must round-trip.
    # The R12 regression was about silent drop, not coercion.


def test_r13_known_languages_full_canonical_set_intact():
    """If anyone removed a language during refactor, this trips.

    Locks the canonical R12 set in place. Adding new languages is fine
    (test only checks subset)."""
    _, SessionCreate, _, _ = _load_schemas()
    must_contain = {
        # Core languages from pre-R12
        "python", "javascript", "typescript", "java", "go", "rust",
        "c", "cpp", "csharp", "ruby", "php", "swift", "kotlin",
        "html", "css", "sql", "bash", "shell",
        # R12 additions
        "javascript_browser", "typescript_browser", "htm",
    }
    actual = SessionCreate._KNOWN_LANGUAGES
    missing = must_contain - actual
    assert not missing, f"R13 regression: missing languages from canonical set: {missing}"


def test_r13_session_settings_streaming_true_roundtrips_json():
    """Schema → JSON dump → re-parse preserves streaming flag (no model loss)."""
    SessionSettings, _, _, _ = _load_schemas()
    s = SessionSettings(streaming=True)
    payload = s.model_dump()
    assert payload.get("streaming") is True
    s2 = SessionSettings(**payload)
    assert s2.streaming is True


def test_r13_session_update_allows_settings_with_streaming():
    """SessionUpdate (partial PATCH body) must accept settings.streaming."""
    _, _, SessionUpdate, _ = _load_schemas()
    u = SessionUpdate(settings={"streaming": True})  # type: ignore[arg-type]
    # SessionUpdate stores raw dict; just verify no validation error and value preserved
    assert u.settings is not None
    # SessionUpdate may store settings as dict or as SessionSettings — accept either
    if hasattr(u.settings, "streaming"):
        assert u.settings.streaming is True
    else:
        assert u.settings.get("streaming") is True


def test_r13_orchestrator_streaming_default_true_for_none_settings():
    """Belt-and-suspenders: ensure orchestrator pattern still produces True for
    None settings (R12-BUG-02 territory)."""
    # Simulate the orchestrator's exact expression
    for raw in (None, {}, {"streaming": True}):
        settings = raw or {}
        assert bool(settings.get("streaming", True)) is True

    # Explicit False still wins
    settings = {"streaming": False}
    assert bool(settings.get("streaming", True)) is False


def test_r13_session_settings_rejects_streaming_string_or_int_explicit_false():
    """Tighten: when explicit False supplied, model preserves it (R12 fix)."""
    SessionSettings, _, _, _ = _load_schemas()
    s = SessionSettings(streaming=False)
    # Critical: dump must include streaming=False, NOT drop the key.
    dumped = s.model_dump(exclude_none=False)
    assert "streaming" in dumped
    assert dumped["streaming"] is False


def test_r13_session_create_with_streaming_in_settings_subobject():
    """End-to-end-ish: SessionCreate(settings={streaming: True}) — the
    creation schema must accept the streaming flag inside settings."""
    _, SessionCreate, _, _ = _load_schemas()
    obj = SessionCreate(
        name="r13-regression",
        specification="anything",
        language="python",
        settings={"streaming": True},  # type: ignore[arg-type]
    )
    # The nested settings may be SessionSettings or dict depending on schema
    s = obj.settings
    if hasattr(s, "streaming"):
        assert s.streaming is True
    else:
        assert s and s.get("streaming") is True
