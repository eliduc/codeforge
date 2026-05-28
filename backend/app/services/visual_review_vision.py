"""Vision-LLM auto-ranking for the Visual Review feature (Wave 3).

Glue between the Anthropic vision API (Claude Opus 4.5 by default) and the
``VisualReviewScore`` table. The ranker fires ~1 hour into the
``AWAITING_VISUAL_REVIEW`` window if no user submission has landed, ranks
each candidate's screenshots, and writes ``source='vision_llm'`` rows.

Optional "fast path" — if the ranker comes back with a clear winner
(``max_score - min_score >= VISION_LLM_AUTO_RESUME_THRESHOLD``), the
session is resumed immediately rather than waiting for the 24h timeout.

This module deliberately keeps the *capture* of screenshots and the
*resume-after-visual-review* logic in ``services/visual_review.py`` —
we only add the vision ranking step.

Wave-3 follow-ups for the E2E wave (Wave 4):
  * Re-arm the 1h timer on app startup for sessions already in
    AWAITING_VISUAL_REVIEW (same problem the 24h timer has — see the
    Wave 1 follow-up note in services/visual_review.py).
  * Surface vision scores in the frontend AwaitingReviewPanel so the
    user can see what the model thought before deciding whether to
    override.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.visual_review import (
    VISION_LLM_AUTO_RESUME_THRESHOLD,
    VISION_LLM_FRAMES_PER_CANDIDATE,
    VISION_LLM_MODEL,
    VISION_LLM_PROVIDER,
    VISION_LLM_RANKER_DELAY_SEC,
    get_storage_root,
)
from app.db.database import AsyncSessionLocal
from app.db.models import (
    CodeVersion,
    CodeVersionScreenshot,
    Session as SessionModel,
    SessionStatus,
    VisualReviewScore,
)

logger = logging.getLogger(__name__)


EventCallback = Callable[[str, dict[str, Any]], Awaitable[None]]


# Per-session timers for the 1h pre-vision delay. Same pattern as the 24h
# timer in services/visual_review.py — best-effort, lost on process restart.
_vision_timers: dict[str, asyncio.Task[None]] = {}
_vision_timers_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# Public dataclass: vision-ranker output
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VisionRankingResult:
    """Result of a single ``rank_with_vision_llm`` call.

    ``scores`` is the list of :class:`VisualReviewScore` ORM rows the
    caller should persist (one per candidate). They are *not* added to
    the DB by ``rank_with_vision_llm`` — the caller decides whether to
    commit them (so unit tests can inspect without DB).

    ``spread`` is ``max_score - min_score`` across the 0-10 scores;
    callers use it to decide whether to trigger the auto-resume fast
    path. When the ranker had fewer than 2 candidates ``spread`` is 0.0.
    """

    scores: list[VisualReviewScore] = field(default_factory=list)
    spread: float = 0.0
    raw_reasoning: dict[str, str] = field(default_factory=dict)
    model: str = ""
    error: str | None = None


# ---------------------------------------------------------------------------
# Frame selection + base64 encoding
# ---------------------------------------------------------------------------


def _pick_representative_frames(
    screenshots: list[CodeVersionScreenshot],
    n: int = VISION_LLM_FRAMES_PER_CANDIDATE,
) -> list[CodeVersionScreenshot]:
    """Pick ``n`` evenly-spaced frames from the sorted screenshot list.

    For the common case (5 frames captured, n=3) this returns
    ``[first, middle, last]``. For fewer frames we just return them all.
    """
    if not screenshots:
        return []
    ordered = sorted(screenshots, key=lambda s: s.frame_index)
    if len(ordered) <= n:
        return ordered
    if n <= 1:
        return [ordered[0]]
    # Evenly-spaced indices including endpoints.
    step = (len(ordered) - 1) / (n - 1)
    indices = [int(round(i * step)) for i in range(n)]
    # Deduplicate while preserving order (rounding can collide).
    seen: set[int] = set()
    out: list[CodeVersionScreenshot] = []
    for i in indices:
        if i not in seen:
            seen.add(i)
            out.append(ordered[i])
    return out


def _read_and_encode(image_path_relative: str) -> str | None:
    """Read a screenshot file from STORAGE_ROOT and return its base64 payload.

    Returns ``None`` if the file is missing or unreadable. The caller
    should skip the frame rather than abort the whole ranking pass.
    """
    storage_root = get_storage_root()
    target = (storage_root / image_path_relative).resolve()
    try:
        # Defence-in-depth — never let a bad image_path escape STORAGE_ROOT.
        target.relative_to(storage_root.resolve())
    except ValueError:
        logger.warning(
            "vision-ranker refusing image_path outside storage root: %s",
            image_path_relative,
        )
        return None
    try:
        data = target.read_bytes()
    except OSError as e:
        logger.warning("vision-ranker failed to read %s: %s", target, e)
        return None
    return base64.b64encode(data).decode("ascii")


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------


VISION_RANKER_SYSTEM_PROMPT = (
    "You are a senior UX / visual reviewer. You will see N candidate "
    "implementations of the same specification. Each candidate has a "
    "small number of still frames (typically 3) showing how its output "
    "renders. Rank them from best to worst by:\n"
    "  1. Visual correctness — does it match the spec?\n"
    "  2. Aesthetic quality — is it pleasing, balanced, well-rendered?\n"
    "  3. Robustness — any visual artifacts, glitches, broken rendering?\n"
    "\n"
    "Output JSON ONLY (no prose, no markdown fences). Schema:\n"
    '  {"ranking": [{"code_version_id": "<uuid>", "score_0_10": <int 0-10>, '
    '"reasoning": "<short string>"}, ...]}\n'
    "\n"
    "Rules:\n"
    "  * One entry per code_version_id you were given. Do not invent ids.\n"
    "  * score_0_10 is an integer between 0 and 10 inclusive. Higher is better.\n"
    "  * Use the full range — if one candidate is clearly best give it 8-10 "
    "and put the weakest at 0-3. Avoid clustering all scores in a narrow band."
)


def _build_user_prompt(spec: str, candidate_ids: list[str]) -> str:
    """Wrap the spec + candidate-id list as the user-turn text content."""
    return (
        f"Specification:\n{spec or '(no specification provided)'}\n\n"
        f"You will see {len(candidate_ids)} candidates, identified by these "
        f"code_version_ids in order:\n"
        + "\n".join(f"  - {cid}" for cid in candidate_ids)
        + "\n\nRank them and emit the JSON object described in the system prompt."
    )


# ---------------------------------------------------------------------------
# Anthropic vision call (minimal multimodal wrapper)
# ---------------------------------------------------------------------------


async def _call_anthropic_vision(
    system_prompt: str,
    user_text: str,
    images_per_candidate: list[tuple[str, list[str]]],
    model: str,
    max_tokens: int = 4096,
) -> tuple[str, str | None]:
    """Call the Anthropic SDK with mixed text+image content.

    ``images_per_candidate`` is a list of ``(code_version_id, [b64_image, ...])``
    so we can label each image group in the user turn. We rely on the
    existing :class:`AnthropicProvider` for the configured client (api
    key, base url, timeouts) — we just use its ``.client`` attribute to
    build a vision-shaped messages.create call, since the provider's
    ``generate()`` is text-only.

    Returns ``(content_text, error_message_or_none)``. If the LLM router
    has no anthropic provider configured (e.g. tests, missing API key),
    returns ``("", "anthropic provider not configured")``.
    """
    # Lazy import to keep this module loadable without an LLM router (tests
    # mock at a higher layer).
    try:
        from app.llm.router import llm_router
    except Exception as e:  # noqa: BLE001
        return "", f"could not import llm_router: {e}"

    await llm_router.initialize()
    provider = llm_router.get_provider(VISION_LLM_PROVIDER)
    if provider is None:
        return "", f"provider '{VISION_LLM_PROVIDER}' not configured"
    client = getattr(provider, "client", None)
    if client is None:
        return "", "anthropic provider has no client attribute"

    # Build the user content blocks: a short label, then the images for
    # that candidate, repeated.
    content_blocks: list[dict[str, Any]] = [{"type": "text", "text": user_text}]
    for cid, b64_images in images_per_candidate:
        content_blocks.append(
            {"type": "text", "text": f"\n--- Candidate {cid} ---"}
        )
        for b64 in b64_images:
            content_blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/png",
                        "data": b64,
                    },
                }
            )

    try:
        response = await client.messages.create(
            model=model,
            max_tokens=max_tokens,
            system=system_prompt,
            messages=[{"role": "user", "content": content_blocks}],
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("vision-ranker anthropic call failed")
        return "", f"vision call failed: {e}"

    text = ""
    try:
        for block in response.content:
            if hasattr(block, "text"):
                text += block.text
    except Exception as e:  # noqa: BLE001
        return "", f"could not parse anthropic response: {e}"
    return text, None


# ---------------------------------------------------------------------------
# JSON parsing
# ---------------------------------------------------------------------------


_JSON_FENCE_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


def _parse_ranking_json(raw: str) -> list[dict[str, Any]]:
    """Parse the model's response and return the ``ranking`` list.

    Tolerant of stray markdown code fences and leading/trailing prose,
    but the system prompt explicitly asks for JSON-only output so this
    is defence-in-depth.

    Raises ``ValueError`` if no usable ranking can be extracted.
    """
    text = (raw or "").strip()
    if not text:
        raise ValueError("empty vision-LLM response")

    # Try a direct json.loads first; fall back to extracting the first
    # JSON-looking object via regex.
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        # Strip markdown fences if present.
        m = _JSON_FENCE_RE.search(text)
        if m:
            try:
                obj = json.loads(m.group(1))
            except json.JSONDecodeError as e:
                raise ValueError(f"could not parse fenced JSON: {e}") from e
        else:
            # Last-ditch: find first { ... } balanced substring.
            start = text.find("{")
            end = text.rfind("}")
            if start == -1 or end <= start:
                raise ValueError("no JSON object found in vision-LLM response")
            try:
                obj = json.loads(text[start : end + 1])
            except json.JSONDecodeError as e:
                raise ValueError(f"could not parse extracted JSON: {e}") from e

    if not isinstance(obj, dict):
        raise ValueError("vision-LLM response is not a JSON object")
    ranking = obj.get("ranking")
    if not isinstance(ranking, list) or not ranking:
        raise ValueError("vision-LLM response missing non-empty 'ranking' array")
    return ranking


def _clamp_score(value: Any) -> int:
    """Coerce any numeric-ish value to an int in [0, 10]."""
    try:
        f = float(value)
    except (TypeError, ValueError):
        return 0
    if f < 0:
        return 0
    if f > 10:
        return 10
    return int(round(f))


# ---------------------------------------------------------------------------
# Main entry point — rank the candidates
# ---------------------------------------------------------------------------


async def rank_with_vision_llm(
    db: AsyncSession,
    session_id: str,
    *,
    model: str = VISION_LLM_MODEL,
    frames_per_candidate: int = VISION_LLM_FRAMES_PER_CANDIDATE,
) -> VisionRankingResult:
    """Run the vision-LLM ranker for a session's latest-iteration candidates.

    Steps:
      1. Resolve the latest iteration's CodeVersions (same heuristic as
         ``capture_for_latest_iteration`` in the screenshot service).
      2. Load each candidate's screenshots and pick representative frames.
      3. Base64-encode the PNGs, build the multimodal Anthropic request.
      4. Parse the JSON response, build :class:`VisualReviewScore` rows.

    The returned rows are *not* added to the DB — the caller (the 1h
    timer, or a future API endpoint) decides whether to persist them.

    If the call fails for any reason (missing API key, parse failure,
    no screenshots) we return an empty ``VisionRankingResult`` with
    ``error`` set; callers should treat that as "no vision signal —
    leave the existing 24h timer to do its thing".
    """
    # --- 1. Load session + latest-iteration candidates ---
    session_row = (
        await db.execute(select(SessionModel).where(SessionModel.id == session_id))
    ).scalar_one_or_none()
    if session_row is None:
        return VisionRankingResult(error=f"session {session_id} not found", model=model)

    from sqlalchemy import func as sa_func

    max_iter = (
        await db.execute(
            select(sa_func.max(CodeVersion.iteration))
            .where(CodeVersion.session_id == session_id)
        )
    ).scalar_one_or_none()
    if max_iter is None:
        return VisionRankingResult(
            error="no code versions for session", model=model
        )

    cvs = (
        await db.execute(
            select(CodeVersion)
            .where(CodeVersion.session_id == session_id)
            .where(CodeVersion.iteration == max_iter)
        )
    ).scalars().all()
    if not cvs:
        return VisionRankingResult(
            error="no candidates at latest iteration", model=model
        )

    # --- 2. Pull screenshots for each candidate ---
    candidates_with_frames: list[tuple[str, list[CodeVersionScreenshot]]] = []
    for cv in cvs:
        shots = (
            await db.execute(
                select(CodeVersionScreenshot)
                .where(CodeVersionScreenshot.code_version_id == str(cv.id))
            )
        ).scalars().all()
        picked = _pick_representative_frames(list(shots), n=frames_per_candidate)
        if picked:
            candidates_with_frames.append((str(cv.id), picked))

    if not candidates_with_frames:
        return VisionRankingResult(
            error="no screenshots available for any candidate", model=model
        )

    # --- 3. Encode frames + build prompt ---
    images_per_candidate: list[tuple[str, list[str]]] = []
    for cv_id, shots in candidates_with_frames:
        b64s: list[str] = []
        for s in shots:
            b64 = _read_and_encode(s.image_path)
            if b64 is not None:
                b64s.append(b64)
        if b64s:
            images_per_candidate.append((cv_id, b64s))

    if not images_per_candidate:
        return VisionRankingResult(
            error="all candidate screenshots failed to read", model=model
        )

    spec_text = getattr(session_row, "specification", "") or ""
    candidate_ids = [cid for cid, _ in images_per_candidate]
    user_prompt = _build_user_prompt(spec_text, candidate_ids)

    # --- 4. Call the model ---
    started = time.time()
    raw_text, err = await _call_anthropic_vision(
        system_prompt=VISION_RANKER_SYSTEM_PROMPT,
        user_text=user_prompt,
        images_per_candidate=images_per_candidate,
        model=model,
    )
    if err:
        logger.warning(
            "vision-ranker for session %s failed: %s (%.1fs)",
            session_id, err, time.time() - started,
        )
        return VisionRankingResult(error=err, model=model)

    # --- 5. Parse + map to VisualReviewScore rows ---
    try:
        ranking = _parse_ranking_json(raw_text)
    except ValueError as e:
        logger.warning(
            "vision-ranker for session %s returned unparseable text "
            "(%.1fs): %s\n%s",
            session_id, time.time() - started, e, raw_text[:500],
        )
        return VisionRankingResult(error=f"parse error: {e}", model=model)

    valid_ids = {cid for cid, _ in images_per_candidate}
    scores: list[VisualReviewScore] = []
    raw_reasoning: dict[str, str] = {}
    for item in ranking:
        if not isinstance(item, dict):
            continue
        cv_id = item.get("code_version_id")
        if not cv_id or cv_id not in valid_ids:
            logger.debug(
                "vision-ranker dropping unknown code_version_id=%r", cv_id
            )
            continue
        score = _clamp_score(item.get("score_0_10"))
        scores.append(
            VisualReviewScore(
                session_id=session_id,
                code_version_id=cv_id,
                score=score,
                source="vision_llm",
                submitted_by=None,
            )
        )
        reason = item.get("reasoning")
        if isinstance(reason, str):
            raw_reasoning[cv_id] = reason

    if not scores:
        return VisionRankingResult(
            error="vision-LLM produced no usable rankings", model=model
        )

    score_values = [s.score for s in scores]
    spread = float(max(score_values) - min(score_values)) if len(score_values) >= 2 else 0.0

    logger.info(
        "vision-ranker session=%s candidates=%d spread=%.1f model=%s (%.1fs)",
        session_id, len(scores), spread, model, time.time() - started,
    )
    return VisionRankingResult(
        scores=scores,
        spread=spread,
        raw_reasoning=raw_reasoning,
        model=model,
        error=None,
    )


# ---------------------------------------------------------------------------
# Timer wiring — schedule_vision_ranker / cancel_vision_timer
# ---------------------------------------------------------------------------


async def schedule_vision_ranker(
    session_id: str,
    *,
    delay_sec: float = float(VISION_LLM_RANKER_DELAY_SEC),
    event_callback: EventCallback | None = None,
    on_resume: Callable[[str, str], Awaitable[None]] | None = None,
    auto_resume_threshold: float = VISION_LLM_AUTO_RESUME_THRESHOLD,
    model: str = VISION_LLM_MODEL,
) -> None:
    """Arm a background task that runs the vision ranker after ``delay_sec``.

    Idempotent — if a timer is already running for this session it is
    cancelled and replaced. Cancelled silently when the user submits or
    skips (via :func:`cancel_vision_timer`).

    The runner:
      1. Re-checks the session status (must still be AWAITING_VISUAL_REVIEW).
      2. Bails if any 'user' scores have already landed.
      3. Calls :func:`rank_with_vision_llm`, persists the rows.
      4. Emits ``vision_llm_scored``.
      5. If ``spread >= auto_resume_threshold`` *and* ``on_resume`` was
         provided, fires the auto-resume fast path (emits
         ``visual_review_auto_resumed_by_vision`` then calls ``on_resume``).
    """

    async def _runner() -> None:
        try:
            await asyncio.sleep(delay_sec)
        except asyncio.CancelledError:
            return

        try:
            await _run_vision_ranker_once(
                session_id=session_id,
                event_callback=event_callback,
                on_resume=on_resume,
                auto_resume_threshold=auto_resume_threshold,
                model=model,
            )
        finally:
            async with _vision_timers_lock:
                _vision_timers.pop(session_id, None)

    async with _vision_timers_lock:
        existing = _vision_timers.pop(session_id, None)
        if existing is not None and not existing.done():
            existing.cancel()
        task = asyncio.create_task(_runner())
        _vision_timers[session_id] = task


async def cancel_vision_timer(session_id: str) -> None:
    """Cancel a pending 1h vision-ranker timer (called when user submits/skips)."""
    async with _vision_timers_lock:
        task = _vision_timers.pop(session_id, None)
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


async def _run_vision_ranker_once(
    session_id: str,
    event_callback: EventCallback | None,
    on_resume: Callable[[str, str], Awaitable[None]] | None,
    auto_resume_threshold: float,
    model: str,
) -> None:
    """Actual body of the 1h timer — split out so it's easy to call from tests."""
    async with AsyncSessionLocal() as db:
        # Re-check status — user may have skipped/submitted in the past hour.
        status = (
            await db.execute(
                select(SessionModel.status).where(SessionModel.id == session_id)
            )
        ).scalar_one_or_none()
        if status != SessionStatus.AWAITING_VISUAL_REVIEW:
            logger.info(
                "vision-ranker skipping session %s — status=%s",
                session_id, status,
            )
            return

        # If a user already submitted scores, don't pollute with vision_llm
        # rows — they would only confuse the audit-trail (the aggregator
        # already prefers user > vision_llm).
        existing_user = (
            await db.execute(
                select(VisualReviewScore.id)
                .where(VisualReviewScore.session_id == session_id)
                .where(VisualReviewScore.source == "user")
                .limit(1)
            )
        ).first()
        if existing_user is not None:
            logger.info(
                "vision-ranker skipping session %s — user scores already present",
                session_id,
            )
            return

        result = await rank_with_vision_llm(db, session_id, model=model)
        if result.error or not result.scores:
            logger.warning(
                "vision-ranker produced no scores for session %s: %s",
                session_id, result.error or "<empty>",
            )
            return

        # Persist the rows. The uq_visual_review_score (session, cv, source)
        # constraint would block a second vision pass for the same candidate,
        # but the 1h timer only fires once so we don't currently retry.
        for row in result.scores:
            db.add(row)
        try:
            await db.commit()
        except Exception as e:  # noqa: BLE001
            logger.error(
                "vision-ranker failed to persist scores for session %s: %s",
                session_id, e,
            )
            try:
                await db.rollback()
            except Exception:
                pass
            return

        if event_callback:
            try:
                await event_callback("vision_llm_scored", {
                    "session_id": session_id,
                    "model": result.model,
                    "spread": result.spread,
                    "scores": [
                        {
                            "code_version_id": row.code_version_id,
                            "score": row.score,
                            "reasoning": result.raw_reasoning.get(
                                row.code_version_id, ""
                            ),
                        }
                        for row in result.scores
                    ],
                })
            except Exception as e:  # noqa: BLE001
                logger.warning(f"Failed to emit vision_llm_scored: {e}")

        # --- Fast-path auto-resume ---
        if (
            on_resume is not None
            and result.spread >= auto_resume_threshold
            and len(result.scores) >= 2
        ):
            logger.info(
                "vision-ranker auto-resume for session %s: spread=%.1f >= %.1f",
                session_id, result.spread, auto_resume_threshold,
            )
            if event_callback:
                try:
                    await event_callback("visual_review_auto_resumed_by_vision", {
                        "session_id": session_id,
                        "model": result.model,
                        "spread": result.spread,
                        "threshold": auto_resume_threshold,
                    })
                except Exception:
                    pass
            try:
                await on_resume(session_id, "vision_llm_auto")
            except Exception as e:  # noqa: BLE001
                logger.error(
                    "vision-ranker on_resume failed for session %s: %s",
                    session_id, e,
                )


# ---------------------------------------------------------------------------
# Threshold reasoning (Wave 3 notes — kept inline for future maintainers)
# ---------------------------------------------------------------------------
#
# Why VISION_LLM_AUTO_RESUME_THRESHOLD = 3.0 (out of 10)?
#
#   * Scores in [0, 10]. A spread of 3.0 means the best candidate is at
#     least 3 points above the worst (e.g. 8 vs 5, or 9 vs 6).
#   * Empirically — and per the system-prompt instruction to "use the
#     full range" — a 3-point gap maps to a noticeable visual quality
#     difference (clean render vs visible artifact, complete vs partially
#     broken layout).
#   * A spread under 3 means the candidates are roughly tied; in that
#     regime it's safer to let the human reviewer break the tie within
#     the remaining 23h rather than commit to a marginal pick.
#   * 3.0 is operator-tunable via the VISION_LLM_AUTO_RESUME_THRESHOLD
#     env var, so we can dial it up (more conservative, fewer auto-
#     resumes) or down (faster pipeline, more vision-led picks) without
#     a code change.
