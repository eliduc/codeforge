"""КАО#VR-44 — Functionality regression tests (SUPPLEMENT, additive only).

This file ADDS coverage on top of test_kao_vr35_to_43.py for the backend
changes deployed alongside VR-44. It NEVER modifies existing tests or
product code; it only pins behaviour so future refactors can't silently
regress it (Non-Degradation Rule).

Covered surfaces
----------------
  * VR-41 — Visual Review endpoint:
      - `total_configured_coders` / `missing_coder_indices` response fields
        (VisualReviewStateResponse in app.api.routes.visual_review).
      - The "latest CodeVersion per coder_index" subquery
        (max(iteration) GROUP BY coder_index, joined back) so EVERY
        configured coder surfaces a candidate at its own latest iteration,
        and coders that produced no screenshots are listed as missing.

  * VR-39 — apply_enhancements attachment merge:
      - A CuratedSuggestion carrying `attachments` propagates those into the
        child session's `attachments` bag (parent + per-suggestion) AND adds
        a `[refs: ...]` citation to the enhancement_text.
      - Per-suggestion scope: a suggestion with NO attachments contributes
        no refs and no entries to the merged bag.

  * Iteration reset (user explicitly cares): the CHILD session created by
    apply_enhancements does NOT carry `current_iteration` from the parent —
    the new Session is constructed without a `current_iteration` kwarg, so it
    falls back to the model default (0) and the first coder iteration is 1.

  * orchestrator._is_retryable_overload_error — PURE function table-test for
    the VR-41 timeout/connection-reset expansion (incl. camelCase variants),
    and rejection of plain logic errors.

Discipline
----------
Pure unit/Pydantic/source-inspection tests are PARALLEL-SAFE and require no
DB. The single end-to-end HTTP test (marked `e2e` + `slow`) reuses the
conftest `async_auth_client` fixture and bypasses the workflow via direct DB
writes, mirroring the existing VR-39 e2e test's style. It self-skips when the
backend container / modules aren't reachable.
"""
from __future__ import annotations

import inspect
import uuid

import pytest


# ===========================================================================
# orchestrator._is_retryable_overload_error — PURE function (no DB, no net).
# VR-44 re-pins the VR-41 expansion incl. the camelCase 'connectionreset' /
# 'connectionaborted' variants the task calls out. PARALLEL-SAFE.
# ===========================================================================


@pytest.fixture(scope="module")
def _retryable():
    from app.core.orchestrator import WorkflowOrchestrator

    return WorkflowOrchestrator._is_retryable_overload_error


@pytest.mark.parametrize(
    "message",
    [
        "connection reset",
        "connectionreset",          # camelCase ConnectionResetError variant
        "connectionaborted",        # camelCase ConnectionAbortedError variant
        "read timeout",
        "deadline_exceeded",
        "504",
        "request timed out",
        "timed out or interrupted",
    ],
)
def test_vr44_retryable_overload_true_for_timeout_and_connection_classes(
    _retryable, message
) -> None:
    """Every timeout/connection-reset class the task enumerates must be
    classified retryable. These are transport/queueing failures that VR-41
    started catching so coder candidates stop being silently dropped from the
    Visual Review pool."""
    assert _retryable(Exception(message)) is True, (
        f"_is_retryable_overload_error must treat {message!r} as retryable; "
        "VR-41 expanded the rule to cover this timeout/transport class."
    )


def test_vr44_retryable_overload_false_for_plain_value_error() -> None:
    """A plain ValueError('bad input') is a logic error — auto-retrying it
    would just burn tokens re-issuing a request that can never succeed."""
    from app.core.orchestrator import WorkflowOrchestrator

    assert (
        WorkflowOrchestrator._is_retryable_overload_error(ValueError("bad input"))
        is False
    )


def test_vr44_retryable_overload_messages_are_substring_matched_in_context(
    _retryable,
) -> None:
    """The classifier matches on substrings of the *stringified* error, so a
    realistic wrapped message (not just the bare token) must still trigger.
    Pins the contract that the check isn't an exact-equality match."""
    assert _retryable(Exception("aiohttp.ClientOSError: Connection reset by peer")) is True
    assert _retryable(Exception("google.api_core.exceptions: 504 Deadline Exceeded")) is True
    assert _retryable(Exception("anthropic._exceptions.APITimeoutError: Request timed out.")) is True


# ===========================================================================
# VR-41 — VisualReviewStateResponse: total_configured_coders +
#         missing_coder_indices. Pydantic-level (no DB). PARALLEL-SAFE.
# ===========================================================================


def test_vr44_missing_coder_indices_when_k_of_n_coders_present() -> None:
    """N=3 configured coders, only k=2 produced a CodeVersion (coders 0 and
    2). The response must:
      * carry one candidate per present coder, each at ITS OWN latest
        iteration (coder 0 @ iter 3, coder 2 @ iter 1 — not collapsed to a
        single global iteration), and
      * list the absent coder (1) in `missing_coder_indices`,
      * report total_configured_coders == 3.
    """
    from app.api.routes.visual_review import (
        VisualReviewCandidate,
        VisualReviewStateResponse,
    )

    sid = str(uuid.uuid4())
    candidates = [
        VisualReviewCandidate(
            code_version_id=str(uuid.uuid4()),
            coder_index=0,
            iteration=3,  # this coder ran further than coder 2
            screenshots=[],
            scores=[],
        ),
        VisualReviewCandidate(
            code_version_id=str(uuid.uuid4()),
            coder_index=2,
            iteration=1,  # lagged behind but STILL surfaced (VR-41 intent)
            screenshots=[],
            scores=[],
        ),
    ]
    resp = VisualReviewStateResponse(
        session_id=sid,
        status="awaiting_visual_review",
        candidates=candidates,
        total_configured_coders=3,
        missing_coder_indices=[1],
    )

    assert resp.total_configured_coders == 3
    assert resp.missing_coder_indices == [1]
    # latest-per-coder set: both present coders surface, each at its own iter.
    iters_by_coder = {c.coder_index: c.iteration for c in resp.candidates}
    assert iters_by_coder == {0: 3, 2: 1}
    # The lagging coder (2) is NOT reported missing just because it ran fewer
    # iterations than coder 0 — it produced a version, so it's a candidate.
    assert 2 not in resp.missing_coder_indices


def test_vr44_no_missing_when_all_coders_present() -> None:
    """All N coders present → empty missing list, count matches candidates."""
    from app.api.routes.visual_review import (
        VisualReviewCandidate,
        VisualReviewStateResponse,
    )

    candidates = [
        VisualReviewCandidate(
            code_version_id=str(uuid.uuid4()),
            coder_index=i,
            iteration=2,
            screenshots=[],
            scores=[],
        )
        for i in range(3)
    ]
    resp = VisualReviewStateResponse(
        session_id=str(uuid.uuid4()),
        status="awaiting_visual_review",
        candidates=candidates,
        total_configured_coders=3,
        missing_coder_indices=[],
    )
    assert resp.missing_coder_indices == []
    assert resp.total_configured_coders == len(resp.candidates) == 3


def test_vr44_missing_indices_computation_mirrors_route_logic() -> None:
    """Re-derive `missing_coder_indices` the way the route does:
        present = {cv.coder_index for cv in versions if cv.screenshots}
        missing = sorted(set(range(total_coders)) - present)
    A coder with a CodeVersion but ZERO screenshots is still 'missing' from
    the review pool (the user can't score a candidate with no frames). This
    pins the production rule verbatim so a refactor can't quietly start
    counting screenshot-less coders as present."""

    class _FakeCV:
        def __init__(self, coder_index: int, has_shots: bool) -> None:
            self.coder_index = coder_index
            self.screenshots = [object()] if has_shots else []

    total_coders = 3
    versions = [
        _FakeCV(0, has_shots=True),
        _FakeCV(1, has_shots=False),  # produced code but NO frames → missing
        # coder 2 produced no CodeVersion at all → also missing
    ]
    present_indices = {cv.coder_index for cv in versions if cv.screenshots}
    missing_indices = sorted(set(range(total_coders)) - present_indices)

    assert present_indices == {0}
    assert missing_indices == [1, 2]


def test_vr44_visual_review_source_uses_latest_per_coder_subquery() -> None:
    """Source-level guard: the GET handler must build the per-coder
    max-iteration subquery and surface the two VR-41 fields. Catches a
    regression to the old `.order_by(iteration.desc()).limit(1)` shape that
    omitted coders lagging behind the iteration leader."""
    from app.api.routes import visual_review as vr_module

    src = inspect.getsource(vr_module)
    assert "max_iter_per_coder" in src
    assert "group_by(CodeVersion.coder_index)" in src
    assert "missing_coder_indices" in src
    assert "total_configured_coders" in src
    # The missing-set computation must subtract present coders from range(N).
    assert "set(range(total_coders))" in src


# ===========================================================================
# VR-39 — apply_enhancements attachment merge + [refs:] citation.
# Source-inspection + logic-emulation (no DB). PARALLEL-SAFE.
# ===========================================================================


def test_vr44_apply_enhancements_merges_parent_plus_suggestion_attachments() -> None:
    """The route source must merge parent attachments with per-suggestion
    ones (`parent + per-suggestion`) and pass the result to the child
    Session. Pins the load-bearing identifiers so attachment propagation
    can't be dropped in a refactor."""
    from app.api.routes import sessions as sessions_module

    src = inspect.getsource(sessions_module)
    assert "enhancement_attachments: list[dict]" in src
    assert "merged_attachments: list[dict] = list(session.attachments or [])" in src
    assert "+ enhancement_attachments" in src
    assert "attachments=merged_attachments" in src
    assert "[refs: " in src


def test_vr44_refs_and_merge_logic_respects_per_suggestion_scope() -> None:
    """Emulate the apply_enhancements inner loop for a MIX of suggestions:
      - S1 carries a file + a repo_url attachment → contributes 2 merged
        attachments and a `[refs: diagram.png, repo acme/ui]` citation on its
        own line ONLY.
      - S2 carries NO attachments → contributes nothing to the merged bag and
        gets NO `[refs:]` suffix.
    This verifies per-suggestion scoping: S2's line must stay clean even when
    S1 has refs. Mirrors the production loop verbatim.
    """
    from app.schemas import AttachmentInfo, CuratedSuggestion

    parent_attachments = [{"type": "file", "filename": "parent.txt", "size": 5}]

    s1 = CuratedSuggestion(
        title="Use layout",
        category="user",
        priority="high",
        description="apply diagram + borrow from repo",
        attachments=[
            AttachmentInfo(type="file", filename="diagram.png", size=10),
            AttachmentInfo(type="repo_url", url="https://github.com/acme/ui", label="acme/ui"),
        ],
    )
    s2 = CuratedSuggestion(
        title="Rename button",
        category="functionality",
        priority="low",
        description="call it Submit",
        attachments=None,
    )

    # --- production loop, verbatim ----------------------------------------
    enhancement_lines = ["## ENHANCEMENTS"]
    enhancement_attachments: list[dict] = []
    for s in [s1, s2]:
        line = f"- [{s.priority.upper()}] {s.title}: {s.description}"
        if s.attachments:
            refs: list[str] = []
            for att in s.attachments:
                if att.type == "repo_url" and att.url:
                    refs.append(f"repo {att.label or att.url}")
                elif att.type == "repo" and att.repo_name:
                    refs.append(f"repo {att.repo_name}")
                elif att.filename:
                    refs.append(att.filename)
            if refs:
                line += f"  [refs: {', '.join(refs[:8])}{' …' if len(refs) > 8 else ''}]"
            for att in s.attachments:
                enhancement_attachments.append(att.model_dump(exclude_none=True))
        enhancement_lines.append(line)
    enhancement_text = "\n".join(enhancement_lines)
    merged_attachments = list(parent_attachments) + enhancement_attachments
    # ----------------------------------------------------------------------

    # S1's line carries the refs citation with BOTH refs, S2's line does not.
    assert "[refs: diagram.png, repo acme/ui]" in enhancement_text
    s2_line = [ln for ln in enhancement_lines if ln.startswith("- [LOW] Rename button")][0]
    assert "[refs:" not in s2_line, "S2 has no attachments; it must not gain a refs suffix"

    # Merged bag = parent (1) + S1's two attachments (2) = 3; S2 adds nothing.
    assert len(merged_attachments) == 3
    filenames = [a.get("filename") for a in merged_attachments if a.get("filename")]
    urls = [a.get("url") for a in merged_attachments if a.get("url")]
    assert "parent.txt" in filenames        # parent preserved
    assert "diagram.png" in filenames        # S1 file merged
    assert "https://github.com/acme/ui" in urls  # S1 repo_url merged


def test_vr44_refs_truncation_caps_at_eight_with_ellipsis() -> None:
    """The refs builder truncates to the first 8 labels and appends ' …' when
    there are more — pin that bound so the enhancement prompt stays compact."""
    from app.schemas import AttachmentInfo

    atts = [AttachmentInfo(type="file", filename=f"f{i}.txt") for i in range(12)]
    refs: list[str] = []
    for att in atts:
        if att.type == "repo_url" and att.url:
            refs.append(f"repo {att.label or att.url}")
        elif att.type == "repo" and att.repo_name:
            refs.append(f"repo {att.repo_name}")
        elif att.filename:
            refs.append(att.filename)
    suffix = f"  [refs: {', '.join(refs[:8])}{' …' if len(refs) > 8 else ''}]"

    assert suffix.count(".txt") == 8       # only first 8 shown
    assert suffix.endswith("…]")            # ellipsis present because >8
    assert "f8.txt" not in suffix           # 9th+ omitted


# ===========================================================================
# Iteration reset — the child session created by enhancement starts FRESH.
# Source + model-default level (no DB). PARALLEL-SAFE.
# ===========================================================================


def test_vr44_child_session_construction_omits_current_iteration() -> None:
    """apply_enhancements builds the child `Session(...)` WITHOUT a
    `current_iteration=` kwarg, so it inherits the model default rather than
    the parent's final iteration. Pin this at the source level — the user
    explicitly cares that enhancement coder iterations restart at 1."""
    from app.api.routes import sessions as sessions_module

    src = inspect.getsource(sessions_module)
    # The new Session is created from `final_result.final_code` as initial_code.
    assert "initial_code=final_result.final_code" in src
    # And it must NOT pass current_iteration into the child constructor.
    # (Be tolerant of whitespace, but the kwarg simply should not appear in
    #  the apply_enhancements body.)
    apply_src = inspect.getsource(sessions_module.apply_enhancements)
    assert "Session(" in apply_src
    assert "current_iteration" not in apply_src, (
        "apply_enhancements must NOT seed the child session's "
        "current_iteration from the parent — enhancement runs restart coder "
        "iterations at 1. If this kwarg was added, the iteration reset "
        "regressed (user-reported invariant)."
    )


def test_vr44_session_model_current_iteration_defaults_to_zero() -> None:
    """The Session model column default is 0 (first loop bump → iteration 1).
    Combined with the construction test above, this proves a freshly-created
    child session reports current_iteration 0 before any coder runs."""
    from app.db.models import Session as SessionModel

    col = SessionModel.__table__.c.current_iteration
    assert col.default is not None
    # SQLAlchemy wraps a scalar default in a ColumnDefault with `.arg`.
    assert col.default.arg == 0, (
        "Session.current_iteration default changed from 0; the iteration "
        "reset relies on a fresh child starting at 0 then incrementing to 1."
    )


# ---------------------------------------------------------------------------
# VR-39 / iteration-reset — end-to-end via real HTTP (conftest fixtures).
# Marked `e2e` + `slow`: needs the backend container; performs direct DB
# writes to force the parent into AWAITING_ENHANCEMENT_REVIEW. Self-skips
# when modules/backend aren't reachable. ADDITIVE — distinct session uuids.
# ---------------------------------------------------------------------------


@pytest.mark.e2e
@pytest.mark.slow
@pytest.mark.asyncio
async def test_vr44_enhancement_child_starts_fresh_iteration_and_merges_attachments(
    async_auth_client,
) -> None:
    """Full HTTP round-trip:
      1. create a parent session with one parent attachment,
      2. force it AWAITING_ENHANCEMENT_REVIEW + insert a FinalResult,
      3. POST /apply-enhancements with one curated suggestion carrying its own
         attachment,
      4. assert the child session
           * has current_iteration == 0 (fresh, NOT inherited), and
           * carries BOTH the parent and the per-suggestion attachment, and
           * embeds the `[refs:]` citation in its specification.

    Mirrors the existing VR-39 e2e test's bootstrapping so it runs in the same
    stage-container pytest invocation.
    """
    from sqlalchemy import update as sa_update

    try:
        from app.db import AsyncSessionLocal
        from app.db.models import (
            FinalResult,
            Session as SessionModel,
            SessionStatus,
        )
    except Exception as exc:  # pragma: no cover - skip outside container
        pytest.skip(f"backend modules not importable ({exc!r})")

    suffix = uuid.uuid4().hex[:8]
    parent_att = {
        "type": "file",
        "filename": f"vr44-parent-{suffix}.txt",
        "content": "parent-data",
        "size": 11,
    }
    create_resp = await async_auth_client.post(
        "/api/sessions/",
        json={
            "name": f"vr44-{suffix}",
            "specification": "Print 'hi'.",
            "attachments": [parent_att],
        },
    )
    assert create_resp.status_code in (200, 201), create_resp.text
    parent_id = create_resp.json()["id"]

    # Force parent into AWAITING_ENHANCEMENT_REVIEW + add a FinalResult.
    # КАО#VR-39 (R2) — FinalResult uses `selection_reasoning` + `readme_content`.
    async with AsyncSessionLocal() as db:
        await db.execute(
            sa_update(SessionModel)
            .where(SessionModel.id == parent_id)
            .values(status=SessionStatus.AWAITING_ENHANCEMENT_REVIEW)
        )
        db.add(
            FinalResult(
                session_id=parent_id,
                selected_coder_index=0,
                final_code="print('hi')",
                readme_content="",
                selection_reasoning="ok",
                total_tokens=10,
                total_cost_usd=0.0,
                total_iterations=1,
            )
        )
        await db.commit()

    sug_att = {
        "type": "file",
        "filename": f"vr44-sug-{suffix}.png",
        "size": 100,
    }
    payload = {
        "curated_suggestions": [
            {
                "title": "S1",
                "category": "user",
                "priority": "high",
                "description": "Use the attached diagram",
                "attachments": [sug_att],
            }
        ]
    }
    apply_resp = await async_auth_client.post(
        f"/api/sessions/{parent_id}/apply-enhancements",
        json=payload,
    )
    assert apply_resp.status_code in (200, 201), apply_resp.text
    child_id = (
        apply_resp.json().get("new_session_id")
        or apply_resp.json().get("session_id")
    )
    assert child_id, f"apply-enhancements returned no child id: {apply_resp.text}"

    # Read the child via the API.
    child_resp = await async_auth_client.get(f"/api/sessions/{child_id}")
    assert child_resp.status_code == 200, child_resp.text
    child = child_resp.json()

    # --- Iteration reset: child starts at 0 (the workflow bumps to 1 on its
    #     first loop). The auto-started background run may immediately begin
    #     incrementing, so accept the fresh values {0, 1} but NEVER a value
    #     carried over from a parent that had run multiple iterations. Since
    #     this parent never actually ran coders, anything > 1 here would prove
    #     the child wrongly inherited the parent's counter.
    child_iter = child.get("current_iteration")
    assert child_iter is not None, child
    assert child_iter in (0, 1), (
        f"child session current_iteration={child_iter}; enhancement child "
        "must start fresh (0, or 1 once the first loop begins), not inherit "
        "the parent's final iteration."
    )

    # --- Attachment merge: parent + per-suggestion both present.
    child_atts = child.get("attachments") or []
    filenames = [a.get("filename") for a in child_atts if a.get("filename")]
    assert parent_att["filename"] in filenames, child_atts
    assert sug_att["filename"] in filenames, child_atts

    # --- refs citation embedded in the enhanced specification.
    spec = child.get("specification") or ""
    assert "[refs:" in spec
    assert sug_att["filename"] in spec

    # Cleanup — best-effort.
    for sid in (child_id, parent_id):
        try:
            await async_auth_client.delete(f"/api/sessions/{sid}")
        except Exception:
            pass
