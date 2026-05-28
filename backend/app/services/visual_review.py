"""Visual Review orchestration helpers (Wave 1).

Glue between the orchestrator, the sandbox screenshot endpoint, the DB,
the WebSocket layer, and the 24h auto-finalize timer.

Wave 1 scope:
  * ``capture_and_persist_screenshots`` — call the sandbox, save PNGs to
    STORAGE_ROOT, insert CodeVersionScreenshot rows.
  * ``enter_awaiting_visual_review`` — flip session status, emit
    ``visual_review_ready``, schedule the 24h auto-finalize timer.
  * ``resume_after_visual_review`` — used by the user-score and skip
    endpoints (and the 24h timer) to flip the session out of
    AWAITING_VISUAL_REVIEW. Finalizer integration itself lands in Wave 2.

Open Wave 2 follow-ups are marked with ``TODO(visual-review wave 2)``.
"""
from __future__ import annotations

import asyncio
import base64
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.visual_review import (
    DEFAULT_SCREENSHOT_TIMESTAMPS,
    SCREENSHOT_TIME_BUDGET_SEC,
    VISUAL_REVIEW_TIMEOUT_SEC,
    relative_screenshot_path,
    screenshot_dir,
)
from app.db.database import AsyncSessionLocal
from app.db.models import (
    CodeVersion,
    CodeVersionScreenshot,
    Session as SessionModel,
    SessionStatus,
    SummaryAudit,
    VisualReviewScore,
)
from app.sandbox import get_sandbox_client

logger = logging.getLogger(__name__)


# Per-session timer tasks so we can cancel the 24h timeout when the user
# scores or skips. Keyed by session_id (str). Best-effort: if the process
# restarts the timer is lost — sessions stuck in AWAITING_VISUAL_REVIEW on
# startup will be re-armed by app.main.lifespan in a follow-up (see
# Wave 1 follow-up note at the bottom of this file).
_active_timers: dict[str, asyncio.Task[None]] = {}
_timers_lock = asyncio.Lock()


EventCallback = Callable[[str, dict[str, Any]], Awaitable[None]]


# ---------------------------------------------------------------------------
# Screenshot capture + persistence
# ---------------------------------------------------------------------------


def _wrap_as_html(code: str, language: str) -> str:
    """Best-effort wrap of raw JS/canvas/p5js code into a complete HTML page.

    HTML code is returned as-is. For JavaScript-style code we inject a minimal
    scaffold with a full-window canvas so the snippet renders without the
    user having to author the surrounding page. The Finalizer's bundler
    (sandbox.bundle) would normally produce a richer page; for Wave 1 we keep
    the scaffold minimal and let Wave 2 wire in the bundler.
    """
    lang = (language or "").lower()
    stripped = code.lstrip()[:200].lower()
    if lang == "html" or stripped.startswith("<!doctype") or "<html" in stripped:
        return code

    if lang == "p5js":
        # p5.js needs the library; pull it from a CDN. If the sandbox blocks
        # outbound HTTP this will fail gracefully (no frames).
        return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>p5</title>
<script src="https://cdn.jsdelivr.net/npm/p5@1.9.0/lib/p5.min.js"></script>
<style>html,body{{margin:0;padding:0;overflow:hidden;background:#000;}}</style>
</head><body><script>
{code}
</script></body></html>"""

    # canvas / javascript_browser / typescript_browser — generic scaffold
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>preview</title>
<style>html,body{{margin:0;padding:0;overflow:hidden;background:#000;}}
canvas{{display:block;width:100vw;height:100vh;}}</style>
</head><body>
<canvas id="canvas" width="1280" height="720"></canvas>
<script>
{code}
</script></body></html>"""


async def capture_and_persist_screenshots(
    db: AsyncSession,
    session_id: str,
    code_version_id: str,
    code: str,
    language: str,
    timestamps: Iterable[float] = DEFAULT_SCREENSHOT_TIMESTAMPS,
) -> list[CodeVersionScreenshot]:
    """Capture screenshots for a single CodeVersion and persist them.

    Returns the persisted ``CodeVersionScreenshot`` rows (committed). On
    failure returns an empty list; callers should treat that as "no
    visual evidence for this candidate" without aborting the workflow.
    """
    sandbox = get_sandbox_client()
    html = _wrap_as_html(code, language)
    ts_list = list(timestamps)

    result = await sandbox.capture_screenshots(
        html=html,
        timestamps=ts_list,
        timeout=SCREENSHOT_TIME_BUDGET_SEC,
    )
    if not result.get("success"):
        logger.warning(
            f"Screenshot capture failed for code_version {code_version_id}: "
            f"{result.get('error')}"
        )
        return []

    out_dir = screenshot_dir(session_id, code_version_id)
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.error(f"Failed to create screenshot dir {out_dir}: {e}")
        return []

    rows: list[CodeVersionScreenshot] = []
    for frame in result.get("frames", []):
        frame_index = int(frame.get("frame_index", 0))
        b64 = frame.get("image_b64") or ""
        try:
            png_bytes = base64.b64decode(b64)
        except (ValueError, TypeError) as e:
            logger.warning(f"Bad base64 for frame {frame_index}: {e}")
            continue

        target = out_dir / f"frame_{frame_index}.png"
        try:
            target.write_bytes(png_bytes)
        except OSError as e:
            logger.warning(f"Failed to write {target}: {e}")
            continue

        row = CodeVersionScreenshot(
            code_version_id=code_version_id,
            frame_index=frame_index,
            t_seconds=float(frame.get("t_seconds", 0.0)),
            image_path=relative_screenshot_path(session_id, code_version_id, frame_index),
            width=int(frame.get("width", 0)),
            height=int(frame.get("height", 0)),
        )
        db.add(row)
        rows.append(row)

    try:
        await db.commit()
    except Exception as e:
        logger.error(f"Failed to commit screenshot rows: {e}")
        try:
            await db.rollback()
        except Exception:
            pass
        return []

    for row in rows:
        await db.refresh(row)

    return rows


async def capture_for_latest_iteration(
    db: AsyncSession,
    session_id: str,
    language: str,
    event_callback: EventCallback | None = None,
) -> dict[str, list[CodeVersionScreenshot]]:
    """Capture screenshots for the LATEST CodeVersion of EACH coder_index.

    VR-41 — Previously selected only `iteration == max_iter`. If a coder
    failed mid-pipeline (LLM timeout, 504, etc.) its last successful version
    was at iter N while peers were at iter N+1, so it got dropped from the
    visual review pool entirely. Now we pick the latest version each coder
    DID produce, so Visual Review always shows the best-effort comparison.

    Returns a mapping ``{code_version_id: [screenshots]}``. Failed captures
    are simply absent from the mapping.
    """
    from sqlalchemy import and_, func as sa_func

    max_iter_per_coder = (
        select(
            CodeVersion.coder_index.label("coder_index"),
            sa_func.max(CodeVersion.iteration).label("max_iter"),
        )
        .where(CodeVersion.session_id == session_id)
        .group_by(CodeVersion.coder_index)
        .subquery()
    )

    cv_stmt = (
        select(CodeVersion)
        .join(
            max_iter_per_coder,
            and_(
                CodeVersion.coder_index == max_iter_per_coder.c.coder_index,
                CodeVersion.iteration == max_iter_per_coder.c.max_iter,
            ),
        )
        .where(CodeVersion.session_id == session_id)
        .order_by(CodeVersion.coder_index)
    )
    cv_res = await db.execute(cv_stmt)
    versions = cv_res.scalars().all()

    if not versions:
        logger.warning(f"No CodeVersions for session {session_id}; nothing to screenshot")
        return {}

    out: dict[str, list[CodeVersionScreenshot]] = {}
    for cv in versions:
        if not cv.code_content or not cv.code_content.strip():
            continue
        if event_callback:
            try:
                await event_callback("visual_review_capturing", {
                    "session_id": session_id,
                    "code_version_id": str(cv.id),
                    "coder_index": cv.coder_index,
                })
            except Exception:
                pass

        screenshots = await capture_and_persist_screenshots(
            db=db,
            session_id=session_id,
            code_version_id=str(cv.id),
            code=cv.code_content,
            language=language,
        )
        if screenshots:
            out[str(cv.id)] = screenshots

    return out


# ---------------------------------------------------------------------------
# Lifecycle hooks — enter / resume / timeout
# ---------------------------------------------------------------------------


def _serialize_screenshots(rows: list[CodeVersionScreenshot]) -> list[dict[str, Any]]:
    return [
        {
            "id": s.id,
            "frame_index": s.frame_index,
            "t_seconds": s.t_seconds,
            "image_path": s.image_path,
            "width": s.width,
            "height": s.height,
        }
        for s in rows
    ]


async def enter_awaiting_visual_review(
    db: AsyncSession,
    session_id: str,
    language: str,
    event_callback: EventCallback | None = None,
    on_resume: Callable[[str, str], Awaitable[None]] | None = None,
) -> bool:
    """Capture screenshots, flip status to AWAITING_VISUAL_REVIEW, emit event,
    arm the 24h timer.

    ``on_resume`` is invoked by the auto-finalize timer or by the API route
    handlers with arguments ``(session_id, reason)`` where reason is one of
    ``"submitted" | "skipped" | "timeout"``. Wave 2 will wire this to the
    Finalizer; Wave 1 just emits the corresponding WS event and returns.

    Returns True if we successfully entered the visual-review phase.
    """
    captured = await capture_for_latest_iteration(
        db=db,
        session_id=session_id,
        language=language,
        event_callback=event_callback,
    )

    # Flip session status atomically only if it's still in a transitional state.
    cas_stmt = (
        update(SessionModel)
        .where(SessionModel.id == session_id)
        .where(
            SessionModel.status.in_(
                [SessionStatus.RUNNING, SessionStatus.PAUSED]
            )
        )
        .values(status=SessionStatus.AWAITING_VISUAL_REVIEW)
    )
    res = await db.execute(cas_stmt)
    await db.commit()
    if res.rowcount == 0:
        logger.warning(
            f"Could not flip session {session_id} to AWAITING_VISUAL_REVIEW — "
            f"status changed concurrently"
        )
        return False

    if event_callback:
        candidates = [
            {
                "code_version_id": cv_id,
                "screenshots": _serialize_screenshots(rows),
            }
            for cv_id, rows in captured.items()
        ]
        try:
            await event_callback("visual_review_ready", {
                "session_id": session_id,
                "candidates": candidates,
                "timeout_sec": VISUAL_REVIEW_TIMEOUT_SEC,
            })
        except Exception as e:
            logger.warning(f"Failed to emit visual_review_ready: {e}")

    # Arm the 24h auto-finalize timer.
    await _arm_timeout(session_id, on_resume=on_resume, event_callback=event_callback)

    # Wave 3: arm the 1h vision-LLM ranker. Best-effort — never let a
    # vision-ranker scheduling failure block entering the visual-review
    # phase. Cancelled by ``cancel_timeout`` (below) when the user
    # submits/skips, alongside the 24h timer.
    try:
        from app.services.visual_review_vision import schedule_vision_ranker

        await schedule_vision_ranker(
            session_id=session_id,
            event_callback=event_callback,
            on_resume=on_resume,
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(
            f"Failed to arm vision-LLM ranker for session {session_id}: {e}"
        )
    return True


async def _arm_timeout(
    session_id: str,
    on_resume: Callable[[str, str], Awaitable[None]] | None,
    event_callback: EventCallback | None,
    delay_sec: float = float(VISUAL_REVIEW_TIMEOUT_SEC),
) -> None:
    """Start a background task that fires after ``delay_sec`` if the session
    is still AWAITING_VISUAL_REVIEW. Idempotent — replaces any prior timer."""

    async def _runner() -> None:
        try:
            await asyncio.sleep(delay_sec)
        except asyncio.CancelledError:
            return

        try:
            async with AsyncSessionLocal() as db:
                row = await db.execute(
                    select(SessionModel.status).where(SessionModel.id == session_id)
                )
                status = row.scalar_one_or_none()
                if status != SessionStatus.AWAITING_VISUAL_REVIEW:
                    logger.info(
                        f"Visual-review timer fired for {session_id} but status is "
                        f"{status} — no-op"
                    )
                    return

                if event_callback:
                    try:
                        await event_callback("visual_review_timeout", {
                            "session_id": session_id,
                            "timeout_sec": int(delay_sec),
                        })
                    except Exception:
                        pass

                if on_resume:
                    try:
                        await on_resume(session_id, "timeout")
                    except Exception as e:
                        logger.error(f"on_resume(timeout) failed for {session_id}: {e}")
        finally:
            async with _timers_lock:
                _active_timers.pop(session_id, None)

    async with _timers_lock:
        existing = _active_timers.pop(session_id, None)
        if existing is not None and not existing.done():
            existing.cancel()
        task = asyncio.create_task(_runner())
        _active_timers[session_id] = task


async def cancel_timeout(session_id: str) -> None:
    """Cancel the pending visual-review timers (24h auto-finalize + 1h vision).

    Called from the submit/skip endpoints and from
    ``resume_after_visual_review`` so the user's input wins immediately
    without waiting for either fallback to fire.
    """
    async with _timers_lock:
        task = _active_timers.pop(session_id, None)
    if task is not None and not task.done():
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass

    # Wave 3: also tear down the 1h vision-ranker timer if it's still
    # pending. Imported lazily — the vision module imports this one for
    # the auto-resume path, so a top-level import would be circular.
    try:
        from app.services.visual_review_vision import cancel_vision_timer

        await cancel_vision_timer(session_id)
    except Exception as e:  # noqa: BLE001
        logger.debug(f"Could not cancel vision-ranker timer for {session_id}: {e}")


@dataclass(frozen=True)
class VisualReviewDecision:
    """Outcome of aggregating VisualReviewScore rows for a session.

    ``selection_source`` is one of ``'user'``, ``'vision_llm'``, or
    ``'finalizer_llm'``. When ``forced_winner_code_version_id`` is
    ``None`` the caller must fall back to the default Finalizer LLM
    selection (which corresponds to ``selection_source == 'finalizer_llm'``).
    """

    forced_winner_code_version_id: str | None
    selection_source: str  # 'user' | 'vision_llm' | 'finalizer_llm'
    reasoning: str
    per_candidate_user_avg: dict[str, float]
    per_candidate_vision_avg: dict[str, float]


def _avg(values: list[int]) -> float:
    return (sum(values) / len(values)) if values else 0.0


async def aggregate_visual_review_scores(
    db: AsyncSession,
    session_id: str,
) -> VisualReviewDecision:
    """Read all VisualReviewScore rows for a session and pick the winner.

    Tiebreaker order:
      1. Highest avg user score (if any user scores exist) — HARD override.
      2. Highest avg vision_llm score (if any).
      3. None — fall back to the default Finalizer LLM selection.

    Returns a :class:`VisualReviewDecision` describing the chosen
    code_version_id (if any), the source of the signal, and a human-
    readable reasoning string suitable for
    ``FinalResult.selection_reasoning``.
    """
    stmt = select(VisualReviewScore).where(VisualReviewScore.session_id == session_id)
    rows = (await db.execute(stmt)).scalars().all()

    # Group by source then by code_version_id.
    user_scores: dict[str, list[int]] = {}
    vision_scores: dict[str, list[int]] = {}
    for row in rows:
        cv_id = str(row.code_version_id)
        if row.source == "user":
            user_scores.setdefault(cv_id, []).append(int(row.score))
        elif row.source == "vision_llm":
            vision_scores.setdefault(cv_id, []).append(int(row.score))
        else:
            logger.debug(f"Ignoring unknown VisualReviewScore source: {row.source!r}")

    user_avg = {cv: _avg(vals) for cv, vals in user_scores.items()}
    vision_avg = {cv: _avg(vals) for cv, vals in vision_scores.items()}

    # Pull per-coder tester-issue counts so the audit trail can describe
    # what the default Finalizer would likely have picked.
    cv_to_coder: dict[str, int] = {}
    coder_tester_issues: dict[int, int] = {}
    try:
        cv_stmt = select(CodeVersion.id, CodeVersion.coder_index).where(
            CodeVersion.session_id == session_id,
        )
        for cv_id, coder_idx in (await db.execute(cv_stmt)).all():
            cv_to_coder[str(cv_id)] = int(coder_idx)

        from sqlalchemy import func as sa_func
        sa_stmt = (
            select(
                SummaryAudit.coder_index,
                sa_func.max(SummaryAudit.iteration).label("max_iter"),
            )
            .where(SummaryAudit.session_id == session_id)
            .group_by(SummaryAudit.coder_index)
            .subquery()
        )
        s_stmt = select(SummaryAudit).join(
            sa_stmt,
            (SummaryAudit.coder_index == sa_stmt.c.coder_index)
            & (SummaryAudit.iteration == sa_stmt.c.max_iter),
        ).where(SummaryAudit.session_id == session_id)
        for summary in (await db.execute(s_stmt)).scalars().all():
            issues = (
                len(summary.critical_issues or [])
                + len(summary.serious_issues or [])
            )
            coder_tester_issues[int(summary.coder_index)] = issues
    except Exception as e:
        logger.debug(f"Could not load tester issue counts for audit: {e}")

    def _coder_for(cv_id: str) -> int | None:
        c = cv_to_coder.get(cv_id)
        return c if c is not None else None

    def _default_finalizer_pick() -> int | None:
        """Best-effort guess at what the default Finalizer would pick.

        We use the heuristic 'fewest tester issues' as a proxy for the
        LLM's likely choice; this is only used for the audit-trail string
        and is *not* used to actually select code.
        """
        if not coder_tester_issues:
            return None
        return min(coder_tester_issues.items(), key=lambda kv: kv[1])[0]

    # --- Priority 1: user scores ---
    if user_avg:
        winner_cv = max(user_avg.items(), key=lambda kv: kv[1])[0]
        coder_idx = _coder_for(winner_cv)
        winner_user_score = user_avg[winner_cv]
        winner_vision_score = vision_avg.get(winner_cv)
        winner_tester_issues = (
            coder_tester_issues.get(coder_idx) if coder_idx is not None else None
        )
        default_pick = _default_finalizer_pick()

        parts = [
            f"Selected coder {coder_idx if coder_idx is not None else '?'} "
            f"(user_score={winner_user_score:.1f}/10"
        ]
        if winner_vision_score is not None:
            parts.append(f", vision_llm={winner_vision_score:.1f}")
        if winner_tester_issues is not None:
            parts.append(f", tester_issues={winner_tester_issues}")
        parts.append(")")
        reasoning = "".join(parts)
        if default_pick is not None and default_pick != coder_idx:
            reasoning += (
                f". User signal overrode default Finalizer pick "
                f"(which would have been coder {default_pick} based on tester_issues)."
            )
        else:
            reasoning += "."

        return VisualReviewDecision(
            forced_winner_code_version_id=winner_cv,
            selection_source="user",
            reasoning=reasoning,
            per_candidate_user_avg=user_avg,
            per_candidate_vision_avg=vision_avg,
        )

    # --- Priority 2: vision_llm scores ---
    if vision_avg:
        winner_cv = max(vision_avg.items(), key=lambda kv: kv[1])[0]
        coder_idx = _coder_for(winner_cv)
        winner_vision_score = vision_avg[winner_cv]
        reasoning = (
            f"Selected coder {coder_idx if coder_idx is not None else '?'} "
            f"(no user input; vision_llm={winner_vision_score:.1f}). "
            f"Used vision-LLM ranking as fallback."
        )
        return VisualReviewDecision(
            forced_winner_code_version_id=winner_cv,
            selection_source="vision_llm",
            reasoning=reasoning,
            per_candidate_user_avg=user_avg,
            per_candidate_vision_avg=vision_avg,
        )

    # --- Priority 3: no signal — defer to default Finalizer LLM. ---
    return VisualReviewDecision(
        forced_winner_code_version_id=None,
        selection_source="finalizer_llm",
        reasoning=(
            "Selected coder (no user/vision input; fell back to default Finalizer LLM)."
        ),
        per_candidate_user_avg=user_avg,
        per_candidate_vision_avg=vision_avg,
    )


async def resume_after_visual_review(
    db: AsyncSession,
    session_id: str,
    reason: str,
    event_callback: EventCallback | None = None,
) -> bool:
    """Flip session out of AWAITING_VISUAL_REVIEW and hand off to the Finalizer.

    Wave 2 implementation:
      1. Aggregate VisualReviewScore rows for the session.
      2. Compute a forced winner (user scores > vision_llm > LLM fallback).
      3. Flip session status: AWAITING_VISUAL_REVIEW -> RUNNING (CAS).
      4. Cancel the 24h timer.
      5. Spawn a background orchestrator task that calls
         ``run_finalization_only(forced_winner_code_version_id=...)``
         with the audit-trail string for ``FinalResult.selection_reasoning``.

    Returns True if the CAS succeeded and the finalizer was scheduled.
    """
    # 1+2. Decide the winner before flipping state — that way an aggregation
    # failure doesn't leave the session orphaned in RUNNING with no follow-up.
    try:
        decision = await aggregate_visual_review_scores(db, session_id)
    except Exception as e:
        logger.error(f"Failed to aggregate visual review scores for {session_id}: {e}")
        decision = VisualReviewDecision(
            forced_winner_code_version_id=None,
            selection_source="finalizer_llm",
            reasoning=(
                "Selected coder (no user/vision input; "
                "fell back to default Finalizer LLM after score-aggregation error)."
            ),
            per_candidate_user_avg={},
            per_candidate_vision_avg={},
        )

    # 3. CAS to RUNNING.
    cas_stmt = (
        update(SessionModel)
        .where(SessionModel.id == session_id)
        .where(SessionModel.status == SessionStatus.AWAITING_VISUAL_REVIEW)
        .values(status=SessionStatus.RUNNING)
    )
    res = await db.execute(cas_stmt)
    await db.commit()
    if res.rowcount == 0:
        return False

    # 4. Cancel the 24h timer (idempotent — submit/skip routes also call this).
    await cancel_timeout(session_id)

    if reason not in {"submitted", "skipped", "timeout"}:
        logger.warning(f"resume_after_visual_review: unknown reason {reason!r}")

    logger.info(
        f"Resuming session {session_id} after visual review "
        f"(reason={reason}, source={decision.selection_source}, "
        f"forced_winner_code_version_id={decision.forced_winner_code_version_id})"
    )

    # 5. Hand off to the Finalizer in a background task.
    asyncio.create_task(
        _run_finalizer_after_visual_review(
            session_id=session_id,
            forced_winner_code_version_id=decision.forced_winner_code_version_id,
            forced_winner_reasoning=decision.reasoning,
            event_callback=event_callback,
        )
    )

    return True


async def _run_finalizer_after_visual_review(
    session_id: str,
    forced_winner_code_version_id: str | None,
    forced_winner_reasoning: str | None,
    event_callback: EventCallback | None,
) -> None:
    """Background task: spin up a fresh DB session + orchestrator and run
    only the finalization phase with the provided forced winner.

    Mirrors the re-finalize endpoint's background pattern. Any error is
    logged and swallowed; the orchestrator itself emits ``workflow_error``
    on its way down so the frontend isn't left hanging.
    """
    try:
        # Import lazily to avoid an import cycle (orchestrator imports
        # services indirectly via the visual-review hook).
        from sqlalchemy.orm import selectinload

        from app.api.websocket.manager import session_manager
        from app.core.orchestrator import WorkflowOrchestrator
        from app.db.models import Session as SessionORM
    except Exception as e:
        logger.error(f"Visual-review finalizer handoff import failed: {e}")
        return

    try:
        async with AsyncSessionLocal() as db_session:
            stmt = (
                select(SessionORM)
                .where(SessionORM.id == session_id)
                .options(selectinload(SessionORM.agent_configs))
            )
            session_obj = (await db_session.execute(stmt)).scalar_one_or_none()
            if session_obj is None:
                logger.error(
                    f"Visual-review handoff: session {session_id} not found"
                )
                return

            callback = event_callback
            if callback is None:
                try:
                    callback = session_manager.broadcast
                except Exception:
                    callback = None

            orchestrator = WorkflowOrchestrator(
                db=db_session,
                session=session_obj,
                event_callback=callback,
            )
            try:
                await session_manager.register_orchestrator(session_id, orchestrator)
            except Exception:
                pass
            try:
                await orchestrator.run_finalization_only(
                    forced_winner_code_version_id=forced_winner_code_version_id,
                    forced_winner_reasoning=forced_winner_reasoning,
                )
            finally:
                try:
                    await session_manager.unregister_orchestrator(session_id)
                except Exception:
                    pass
    except Exception as e:
        logger.error(
            f"Visual-review finalizer handoff failed for {session_id}: {e}",
            exc_info=True,
        )


# ---------------------------------------------------------------------------
# Wave 1 follow-ups (for the Wave 2 / Wave 3 agents):
#
#   * Re-arm pending timers on app startup by scanning for sessions in
#     AWAITING_VISUAL_REVIEW and computing the remaining delay from
#     ``updated_at``. (Currently the timer is lost across restarts; the
#     status remains valid so manual user score still works, but the
#     auto-finalize fallback won't fire.)
#
#   * Wave 2: have the Finalizer read VisualReviewScore rows from this
#     session and use them as a tiebreaker when selecting the best
#     code version. resume_after_visual_review() should call into the
#     orchestrator's _run_finalization_phase() once that wiring exists.
#
#   * Wave 3 (optional): integrate a vision-LLM that posts scores with
#     source='vision_llm' when no user input arrives within e.g. 1 hour.
# ---------------------------------------------------------------------------
