"""Visual Review trigger detection and helpers (Wave 1).

This module owns the decision logic for whether a session should pause for
a visual-review step after the Coders have completed but BEFORE the Finalizer
runs. The Finalizer integration itself lands in Wave 2 — this module only
exposes the predicate and the constants used by the orchestrator hook and
the API routes.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re
import time
from pathlib import Path
from typing import Any
from uuid import UUID

from app.db.models import Session

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Signed-URL helpers (КАО#VR-22)
# ---------------------------------------------------------------------------
#
# Why this exists: browser <img src> requests do NOT carry the Authorization
# header (Bearer JWT). The screenshot route therefore can't gate on Bearer
# auth — we'd return 401 and every image would be broken in the panel.
#
# Solution: embed a short-lived HMAC signature in the URL itself. The URL
# becomes the bearer token. The server signs (session_id, code_version_id,
# frame_index, exp) with settings.secret_key (same key used for JWT). On
# fetch, the route either accepts a valid signature OR a valid Bearer header
# (the latter keeps E2E and CLI tools working).
#
# We keep the signing scope tight (single frame, not a wildcard) so a leaked
# URL only exposes one PNG, not the whole session.

_SIGNED_URL_DEFAULT_TTL_SEC: int = 24 * 60 * 60  # matches VR auto-finalize timer


def _signing_secret() -> bytes:
    """Return the bytes used to HMAC screenshot URLs.

    Imported lazily so this module stays importable in tests that don't set
    SECRET_KEY (the secret is only needed when sign/verify is actually called).
    """
    from app.core.config import get_settings

    return get_settings().secret_key.encode("utf-8")


def _signed_url_payload(
    session_id: str | UUID,
    code_version_id: str | UUID,
    frame_index: int,
    exp: int,
) -> str:
    """Canonical message that's HMAC'd. Keep this stable — changing the
    layout invalidates every URL the user's browser is holding right now."""
    return f"{session_id}/{code_version_id}/{frame_index}:{exp}"


def sign_screenshot_url(
    session_id: str | UUID,
    code_version_id: str | UUID,
    frame_index: int,
    ttl_seconds: int = _SIGNED_URL_DEFAULT_TTL_SEC,
    *,
    now: int | None = None,
) -> str:
    """Build a signed ``/api/screenshots/...`` URL the browser can fetch
    without an Authorization header. The signature expires after
    ``ttl_seconds``. ``now`` lets tests pin the clock."""
    base_now = now if now is not None else int(time.time())
    exp = base_now + int(ttl_seconds)
    payload = _signed_url_payload(session_id, code_version_id, frame_index, exp)
    sig = hmac.new(_signing_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return (
        f"/api/screenshots/{session_id}/{code_version_id}/frame_{frame_index}.png"
        f"?exp={exp}&sig={sig}"
    )


def verify_screenshot_signature(
    session_id: str | UUID,
    code_version_id: str | UUID,
    frame_index: int,
    exp: int | None,
    sig: str | None,
    *,
    now: int | None = None,
) -> bool:
    """Return True iff exp+sig form a valid, non-expired signature for the
    (session, code_version, frame_index) tuple."""
    if exp is None or sig is None:
        return False
    base_now = now if now is not None else int(time.time())
    if exp <= base_now:
        return False
    payload = _signed_url_payload(session_id, code_version_id, frame_index, exp)
    expected = hmac.new(_signing_secret(), payload.encode("utf-8"), hashlib.sha256).hexdigest()
    # constant-time compare to avoid timing leaks
    return hmac.compare_digest(expected, sig)


# Languages that produce a visual artifact when executed in a headless browser.
# Anything outside this set (Python, Go, Rust, etc.) cannot meaningfully be
# scored visually, so we never trigger visual review for them.
VISUAL_LANGUAGES: frozenset[str] = frozenset(
    {
        "html",
        "javascript_browser",
        "typescript_browser",
        "canvas",
        "p5js",
    }
)

# Case-insensitive keywords in the spec that hint at a visual/graphical
# deliverable. ASCII keywords are matched with word boundaries (so "render"
# hits, "rendering_engine" also hits). Cyrillic/Unicode keywords are matched
# as substrings — Python's \b does NOT work on non-ASCII letters, so we
# scan for them separately. Frontend `visualReviewHints.ts` mirrors this list.
VISUAL_KEYWORDS_ASCII: frozenset[str] = frozenset(
    {
        "visualize",
        "visualise",
        "render",
        "ui",
        "animation",
        "design",
        "color",
        "colour",
        "shader",
        "plot",
        "game",
        "animate",
        "draw",
        "paint",
        "fractal",
        "simulation",
        "particle",
        "glow",
        "canvas",
        "webgl",
    }
)

# Cyrillic/Unicode visual keywords (substring match — \b is unreliable for
# non-ASCII in Python's `re`). Use lowercase, the comparison is .lower()'d.
VISUAL_KEYWORDS_UNICODE: frozenset[str] = frozenset(
    {
        # КАО#Full-C-1 S2 — 'визуал' prefix substring catches визуальный/визуальная
        # adjective forms that 'визуализ' (verb/noun stem) misses. Kept alongside
        # the longer roots so existing matches stay intact.
        "визуал",      # visual (adj root: визуальный, визуальная, визуально, визуализация)
        "визуально",   # visually
        "визуализ",    # visualization (catches визуализация, визуализировать, …)
        "анимаци",     # animation (анимация, анимировать)
        "графика",
        "графич",      # graphical, графически
        "рисов",       # drawing (рисование, рисовать, нарисовать)
        "игра",        # game
        "игру",        # game (acc)
        "игры",        # games / of-the-game
        "рендер",      # render
        "канвас",      # canvas (Cyrillic spelling)
        "цвет",        # color
        "красив",      # beautiful — strong visual signal in спецификации
        "симуляц",     # simulation
        "фрактал",     # fractal
        "шейдер",      # shader
    }
)

# Combined public name kept for backwards compat (other modules may import it).
VISUAL_KEYWORDS: frozenset[str] = VISUAL_KEYWORDS_ASCII | VISUAL_KEYWORDS_UNICODE


# Precompiled regex for ASCII keywords with word boundaries. We build it
# once at import time so should_run_visual_review() stays O(spec_length).
_KEYWORD_ASCII_RE = re.compile(
    r"\b(" + "|".join(re.escape(k) for k in VISUAL_KEYWORDS_ASCII) + r")\b",
    re.IGNORECASE,
)


def _spec_has_visual_keyword(spec: str | None) -> bool:
    """Return True if the spec text contains at least one visual keyword.

    ASCII keywords use \\b word boundaries; Cyrillic/Unicode keywords use
    simple lowercase substring match (Python's \\b does not work on Cyrillic).
    """
    if not spec:
        return False
    if _KEYWORD_ASCII_RE.search(spec) is not None:
        return True
    spec_lower = spec.lower()
    return any(kw in spec_lower for kw in VISUAL_KEYWORDS_UNICODE)


def _is_visual_language(language: str | None) -> bool:
    """Return True if the session's language produces a browser-renderable
    artifact (case-insensitive)."""
    if not language:
        return False
    return language.strip().lower() in VISUAL_LANGUAGES


def should_run_visual_review(session: Session) -> bool:
    """Decide whether a session needs the visual-review pause.

    Returns True iff:
      * ``session.settings.skip_visual_review`` is NOT True, AND
      * ``session.settings.force_visual_review`` is True, OR
      * the language is a visual one AND the spec contains a visual keyword.

    The skip flag is a hard veto so users can always opt out per-session.
    The force flag bypasses the keyword/language heuristic for cases where
    the user knows they want visual review but the detector wouldn't trigger.
    """
    settings_dict: dict[str, Any] = getattr(session, "settings", None) or {}
    if settings_dict.get("skip_visual_review") is True:
        return False
    if settings_dict.get("force_visual_review") is True:
        return True

    if not _is_visual_language(getattr(session, "language", None)):
        return False

    spec = getattr(session, "specification", None)
    return _spec_has_visual_keyword(spec)


# ---------------------------------------------------------------------------
# Storage helpers
# ---------------------------------------------------------------------------

# 24h auto-finalize timeout for sessions stuck in AWAITING_VISUAL_REVIEW.
VISUAL_REVIEW_TIMEOUT_SEC: int = 24 * 60 * 60

# Delay before the vision-LLM ranker kicks in if no user submission arrives
# (Wave 3). 1 hour gives a human reviewer first crack at the candidates;
# the vision-LLM is purely a fallback / fast-path.
VISION_LLM_RANKER_DELAY_SEC: int = int(
    os.environ.get("VISION_LLM_RANKER_DELAY_SEC", str(60 * 60))
)

# Score-spread threshold (out of 10) above which we consider the vision-LLM
# ranking "confident enough" to short-circuit the remaining 23h wait and
# auto-resume the Finalizer immediately. Calibrated at 3.0 — see Wave 3
# notes in services/visual_review_vision.py for the reasoning.
VISION_LLM_AUTO_RESUME_THRESHOLD: float = float(
    os.environ.get("VISION_LLM_AUTO_RESUME_THRESHOLD", "3.0")
)

# Provider + model used for vision ranking. Defaults pick Claude Opus 4.5
# (vision-capable); env overrides let ops swap models without code changes.
VISION_LLM_PROVIDER: str = os.environ.get("VISION_LLM_PROVIDER", "anthropic")
VISION_LLM_MODEL: str = os.environ.get("VISION_LLM_MODEL", "claude-opus-4-5")

# Per-candidate frame budget — pick this many evenly-spaced screenshots from
# each candidate to feed the vision model. Keeping this small bounds the
# input-token cost and per-request latency.
VISION_LLM_FRAMES_PER_CANDIDATE: int = 3

# Default capture schedule: 5 stills at these wall-clock offsets (seconds
# after the page-load event fired in the sandbox).
DEFAULT_SCREENSHOT_TIMESTAMPS: tuple[float, ...] = (0.5, 2.0, 5.0, 8.0, 12.0)

# Hard ceiling on total time spent capturing screenshots for a single
# code version, regardless of the schedule. The sandbox enforces its own
# inner timeout; this is a defence-in-depth for the orchestrator side.
SCREENSHOT_TIME_BUDGET_SEC: int = 20


# Fallback path used when the primary storage root is not writable.
# Picked under /tmp so it always exists and is writable for any uid; obviously
# data here is ephemeral, but losing screenshots is strictly better than the
# whole Visual Review pipeline crashing on PermissionError.
_TMP_STORAGE_FALLBACK = Path("/tmp/codeforge")


def get_storage_root() -> Path:
    """Resolve the on-disk root for visual-review artifacts.

    Honours the ``STORAGE_ROOT`` env var (matches the convention used by
    other persisted artifacts like Finalizer report PDFs). Falls back to
    ``/var/lib/codeforge`` inside the container (writable) and the
    backend working directory otherwise.
    """
    env_root = os.environ.get("STORAGE_ROOT")
    if env_root:
        return Path(env_root)
    # Container default — matches docker-compose volume mount conventions
    # elsewhere in the project. Callers should mkdir(parents=True, exist_ok=True).
    fallback = Path("/var/lib/codeforge")
    if fallback.parent.exists():
        return fallback
    return Path.cwd() / "storage"


def ensure_storage_root() -> Path:
    """Ensure the storage root + ``screenshots/`` subdir exist and are writable.

    Called once at backend startup (from the FastAPI lifespan hook) so we
    surface permission problems immediately rather than at first capture.

    Tries, in order:
      1. The resolved ``get_storage_root()`` path (env var or default).
      2. ``/tmp/codeforge`` as a last-ditch fallback.

    Logs a WARNING (but does NOT raise) if neither is writable — visual review
    will fail at capture time, but the backend itself stays up so the rest of
    the platform keeps working.

    Returns the path that ended up usable (the primary, the /tmp fallback,
    or the primary again if both failed — callers should treat the return
    as best-effort).
    """
    primary = get_storage_root()
    if _try_make_writable(primary):
        return primary

    logger.warning(
        "Primary storage root %s is not writable; falling back to %s. "
        "Screenshots will be ephemeral (lost on container restart).",
        primary,
        _TMP_STORAGE_FALLBACK,
    )
    if _try_make_writable(_TMP_STORAGE_FALLBACK):
        # Make the rest of the process honour the fallback so subsequent
        # calls to get_storage_root() return the same path.
        os.environ["STORAGE_ROOT"] = str(_TMP_STORAGE_FALLBACK)
        return _TMP_STORAGE_FALLBACK

    logger.warning(
        "Neither %s nor %s is writable. Visual Review captures will fail.",
        primary,
        _TMP_STORAGE_FALLBACK,
    )
    return primary


def _try_make_writable(root: Path) -> bool:
    """Best-effort: create ``root/screenshots`` and chmod 0755. Return success."""
    try:
        screenshots = root / "screenshots"
        screenshots.mkdir(parents=True, exist_ok=True)
        # chmod is best-effort — on filesystems that don't support it (e.g.
        # some Windows mounts) we don't want to fail. We DO want to fail the
        # outer check if mkdir itself raised, which is why this is split.
        try:
            os.chmod(root, 0o755)
            os.chmod(screenshots, 0o755)
        except (OSError, PermissionError) as e:
            logger.debug("chmod on %s failed (non-fatal): %s", root, e)
        # Probe writability with a tiny file — mkdir(exist_ok=True) succeeds
        # on a pre-existing read-only dir, so we need the extra check.
        probe = screenshots / ".write_probe"
        try:
            probe.touch()
            probe.unlink()
        except (OSError, PermissionError) as e:
            logger.debug("Write probe in %s failed: %s", screenshots, e)
            return False
        return True
    except (OSError, PermissionError) as e:
        logger.debug("Could not create %s: %s", root, e)
        return False


def screenshot_dir(session_id: str, code_version_id: str) -> Path:
    """Directory path for a code-version's screenshots (relative-safe)."""
    return (
        get_storage_root()
        / "screenshots"
        / str(session_id)
        / str(code_version_id)
    )


def relative_screenshot_path(session_id: str, code_version_id: str, frame_index: int) -> str:
    """The relative path stored in CodeVersionScreenshot.image_path."""
    return f"screenshots/{session_id}/{code_version_id}/frame_{frame_index}.png"
