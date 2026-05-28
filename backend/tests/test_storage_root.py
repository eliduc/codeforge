"""Unit tests for the Visual Review storage-root bootstrap.

These tests verify the three-layer defence against the
``[Errno 13] Permission denied: '/var/lib/codeforge'`` failure mode:

  * ``ensure_storage_root()`` is idempotent (safe to call repeatedly).
  * On a write-protected primary path, it falls through to ``/tmp/codeforge``
    and logs a WARNING.
  * It returns a working path the rest of the app can write into.
"""
from __future__ import annotations

import logging
import os
import stat
from pathlib import Path

import pytest

from app.core import visual_review as vr


@pytest.fixture(autouse=True)
def _restore_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make sure STORAGE_ROOT mutations in one test don't leak into the next."""
    monkeypatch.delenv("STORAGE_ROOT", raising=False)
    yield


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_ensure_storage_root_creates_screenshots_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A writable env-supplied STORAGE_ROOT yields a usable screenshots/ dir."""
    monkeypatch.setenv("STORAGE_ROOT", str(tmp_path))

    result = vr.ensure_storage_root()

    assert result == tmp_path
    assert (tmp_path / "screenshots").is_dir()


def test_ensure_storage_root_returns_working_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The returned path must actually be writable by the caller."""
    monkeypatch.setenv("STORAGE_ROOT", str(tmp_path))

    result = vr.ensure_storage_root()

    probe = result / "screenshots" / "probe.txt"
    probe.write_text("ok")
    assert probe.read_text() == "ok"


def test_ensure_storage_root_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Calling it many times in a row must not error or change the result."""
    monkeypatch.setenv("STORAGE_ROOT", str(tmp_path))

    first = vr.ensure_storage_root()
    second = vr.ensure_storage_root()
    third = vr.ensure_storage_root()

    assert first == second == third == tmp_path
    assert (tmp_path / "screenshots").is_dir()


def test_ensure_storage_root_idempotent_with_pre_existing_dir(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Pre-existing screenshots/ dir is fine — no error, no clobber."""
    monkeypatch.setenv("STORAGE_ROOT", str(tmp_path))
    pre = tmp_path / "screenshots"
    pre.mkdir()
    sentinel = pre / "existing.png"
    sentinel.write_bytes(b"\x89PNG fake")

    result = vr.ensure_storage_root()

    assert result == tmp_path
    assert sentinel.exists(), "Existing files must not be deleted"
    assert sentinel.read_bytes() == b"\x89PNG fake"


# ---------------------------------------------------------------------------
# Fallback path
# ---------------------------------------------------------------------------


def test_ensure_storage_root_falls_back_to_tmp_when_primary_unwritable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """If the primary path can't be created, fall through to /tmp/codeforge."""
    # Point STORAGE_ROOT at a path whose parent doesn't exist AND make
    # _try_make_writable refuse it. We monkeypatch the helper so the test
    # works on Windows too (where chmod tricks are unreliable).
    bad_primary = tmp_path / "definitely-not-writable"
    good_fallback = tmp_path / "fallback-codeforge"

    monkeypatch.setenv("STORAGE_ROOT", str(bad_primary))
    monkeypatch.setattr(vr, "_TMP_STORAGE_FALLBACK", good_fallback)

    original_try = vr._try_make_writable

    def fake_try(root: Path) -> bool:
        if root == bad_primary:
            return False
        return original_try(root)

    monkeypatch.setattr(vr, "_try_make_writable", fake_try)

    with caplog.at_level(logging.WARNING, logger=vr.__name__):
        result = vr.ensure_storage_root()

    assert result == good_fallback
    assert (good_fallback / "screenshots").is_dir()
    # The fallback should be exposed via STORAGE_ROOT so the rest of the
    # process points at the same place.
    assert os.environ.get("STORAGE_ROOT") == str(good_fallback)
    # And we must have shouted about it.
    assert any(
        "falling back" in record.message.lower()
        for record in caplog.records
        if record.levelno >= logging.WARNING
    ), f"Expected a WARNING about the fallback, got: {[r.message for r in caplog.records]}"


def test_ensure_storage_root_warns_when_both_paths_fail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Total failure must WARN, not raise."""
    monkeypatch.setenv("STORAGE_ROOT", str(tmp_path / "primary"))
    monkeypatch.setattr(vr, "_TMP_STORAGE_FALLBACK", tmp_path / "fallback")
    monkeypatch.setattr(vr, "_try_make_writable", lambda root: False)

    with caplog.at_level(logging.WARNING, logger=vr.__name__):
        # Must not raise.
        result = vr.ensure_storage_root()

    # Returns the primary as a best-effort sentinel.
    assert isinstance(result, Path)
    assert any(
        "neither" in record.message.lower() and record.levelno >= logging.WARNING
        for record in caplog.records
    ), f"Expected a 'neither' WARNING, got: {[r.message for r in caplog.records]}"


# ---------------------------------------------------------------------------
# _try_make_writable internals
# ---------------------------------------------------------------------------


def test_try_make_writable_on_fresh_dir(tmp_path: Path) -> None:
    target = tmp_path / "new"
    assert vr._try_make_writable(target) is True
    assert (target / "screenshots").is_dir()
    # Probe file must be cleaned up.
    assert not (target / "screenshots" / ".write_probe").exists()


def test_try_make_writable_returns_false_on_readonly(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """If mkdir raises PermissionError, return False (not crash)."""
    target = tmp_path / "ro"

    def boom(self: Path, *a, **kw) -> None:
        raise PermissionError("simulated read-only filesystem")

    monkeypatch.setattr(Path, "mkdir", boom)
    assert vr._try_make_writable(target) is False
