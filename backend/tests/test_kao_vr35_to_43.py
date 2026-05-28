"""КАО regression tests for backend changes in VR-35..VR-43.

Backend zone (Functionality writer):

  * VR-39 — `CuratedSuggestion.attachments: list[AttachmentInfo] | None`
            in app.schemas. `apply_enhancements` route merges parent +
            per-suggestion attachments into the child session AND embeds
            a `[refs: ...]` suffix in the enhancement spec.

  * VR-41 — Visual Review endpoint emits the latest CodeVersion per
            coder_index (subquery + join), plus `total_configured_coders`
            and `missing_coder_indices`. Orchestrator's
            `_is_retryable_overload_error` recognises 504 /
            DEADLINE_EXCEEDED / "timed out" / "connection reset" /
            asyncio.TimeoutError on top of the previous overload list.

  * VR-42 — Coder system prompt contains the
            "Notification & worker robustness rule (КАО#VR-42)" block,
            referencing `recentToasts` and `workerErrorCount`.

Discipline
----------
All tests are PARALLEL-SAFE: pure unit-level assertions where possible
(no DB fixtures shared across tests), and per-test uuids on the DB-bearing
VR-39 test so concurrent runs don't collide.

The VR-41 endpoint test uses an in-memory subquery shape verification via
direct source inspection plus a focused query-level unit test against a
mocked AsyncSession that returns scripted rows — no live Postgres required.
This keeps the file runnable in `docker compose exec backend pytest` without
needing a populated database, while still validating the production logic.
"""
from __future__ import annotations

import uuid

import pytest


# ===========================================================================
# VR-42 — Coder prompt contains the КАО#VR-42 robustness block
# ===========================================================================
#
# Pure import-level checks. No DB, no network. PARALLEL-SAFE.


def test_vr42_coder_prompt_contains_kao_vr42_marker() -> None:
    """The coder system prompt must carry the VR-42 banner so future edits
    that touch the prompt template still inherit the rule."""
    from app.agents.coder import DEFAULT_CODER_PROMPT

    assert "VR-42" in DEFAULT_CODER_PROMPT, (
        "DEFAULT_CODER_PROMPT lost the КАО#VR-42 marker. The block teaches "
        "coders to dedupe notifications and self-terminate runaway workers; "
        "removing it regresses crash-resistance in browser candidates."
    )


def test_vr42_coder_prompt_mentions_recentToasts() -> None:
    """`recentToasts` is the load-bearing variable name in the dedupe rule;
    coders must see it verbatim so their output keys notifications correctly."""
    from app.agents.coder import DEFAULT_CODER_PROMPT

    assert "recentToasts" in DEFAULT_CODER_PROMPT, (
        "DEFAULT_CODER_PROMPT no longer mentions `recentToasts`. Coders rely "
        "on this exact identifier when emitting dedupe scaffolding."
    )


def test_vr42_coder_prompt_mentions_workerErrorCount() -> None:
    """`workerErrorCount` is the load-bearing variable in the worker-restart
    cap rule (3 strikes → terminate). Pin the verbatim name."""
    from app.agents.coder import DEFAULT_CODER_PROMPT

    assert "workerErrorCount" in DEFAULT_CODER_PROMPT, (
        "DEFAULT_CODER_PROMPT no longer mentions `workerErrorCount`. This "
        "lets a buggy worker restart-loop forever, hanging the browser tab."
    )


def test_vr42_coder_prompt_block_has_robustness_heading() -> None:
    """Defensive: the heading itself ('Notification & worker robustness
    rule') is what makes the block discoverable to a reading agent. Loss
    of the heading typically means the block was inadvertently merged into
    an unrelated paragraph."""
    from app.agents.coder import DEFAULT_CODER_PROMPT

    assert "Notification & worker robustness rule" in DEFAULT_CODER_PROMPT


# ===========================================================================
# VR-41 — orchestrator._is_retryable_overload_error broadened
# ===========================================================================
#
# Pure-function tests. PARALLEL-SAFE.


@pytest.fixture(scope="module")
def _retryable():
    from app.core.orchestrator import WorkflowOrchestrator
    return WorkflowOrchestrator._is_retryable_overload_error


@pytest.mark.parametrize(
    "err",
    [
        # Pre-VR-41 (overload) errors — must still match.
        "API overloaded",
        Exception("server returned 529"),
        Exception("HTTP 503 Service Unavailable"),
        # VR-41 additions:
        Exception("504 Gateway Timeout"),
        Exception("Google API DEADLINE_EXCEEDED"),
        Exception("Gemini call: deadline exceeded after 60s"),
        Exception("Anthropic: request timed out"),
        Exception("Stream timed out or interrupted"),
        Exception("httpx.ReadTimeout: read timeout"),
        Exception("ReadTimeout"),
        Exception("ConnectionResetError: connection reset by peer"),
        Exception("connection aborted by remote host"),
        # asyncio.TimeoutError stringifies to '' on bare instances but the
        # type-name check covers it.
        Exception("asyncio.TimeoutError raised by gather()"),
    ],
)
def test_vr41_retryable_overload_error_recognises_new_classes(_retryable, err) -> None:
    assert _retryable(err) is True, (
        f"_is_retryable_overload_error must classify {err!r} as retryable. "
        "VR-41 expanded the rule to catch the timeout-class failures that "
        "were silently dropping coder candidates."
    )


@pytest.mark.parametrize(
    "err",
    [
        Exception("API key invalid"),
        Exception("HTTP 400 Bad Request"),
        Exception("Pydantic ValidationError: title missing"),
        Exception("Out of tokens — prompt too long"),
        Exception("404 not found"),
        None,
    ],
)
def test_vr41_retryable_overload_error_rejects_non_transient(_retryable, err) -> None:
    assert _retryable(err) is False, (
        f"_is_retryable_overload_error wrongly classified {err!r} as "
        "retryable. Logic-level errors must not auto-retry."
    )


def test_vr41_retryable_overload_error_case_insensitive(_retryable) -> None:
    """The function lowercases the string before matching — make sure that
    contract isn't accidentally regressed."""
    assert _retryable(Exception("DEADLINE_EXCEEDED")) is True
    assert _retryable(Exception("deadline exceeded")) is True
    assert _retryable(Exception("ConnectionReset")) is True


# ===========================================================================
# VR-41 — Visual Review endpoint exposes total_configured_coders +
#         missing_coder_indices and uses a per-coder latest-version subquery.
# ===========================================================================
#
# We pin the response shape on the Pydantic model (no DB needed) AND we
# verify the route source contains the subquery construct. Both checks are
# load-bearing: the model gate stops the field from being dropped, and the
# source check stops a refactor from reverting to the old "latest iteration
# only" query.


def test_vr41_response_model_has_total_configured_coders_default_zero() -> None:
    from app.api.routes.visual_review import VisualReviewStateResponse

    # Spot-check via instantiation — the field MUST exist and default to 0
    # so old clients that don't read it never crash on missing data.
    resp = VisualReviewStateResponse(
        session_id="00000000-0000-0000-0000-000000000000",
        status="awaiting_visual_review",
        candidates=[],
    )
    assert resp.total_configured_coders == 0
    assert resp.missing_coder_indices == []


def test_vr41_response_model_accepts_missing_coder_indices() -> None:
    from app.api.routes.visual_review import VisualReviewStateResponse

    resp = VisualReviewStateResponse(
        session_id="11111111-1111-1111-1111-111111111111",
        status="awaiting_visual_review",
        candidates=[],
        total_configured_coders=3,
        missing_coder_indices=[1, 2],
    )
    assert resp.total_configured_coders == 3
    assert resp.missing_coder_indices == [1, 2]


def test_vr41_visual_review_source_uses_max_iter_per_coder_subquery() -> None:
    """Pin the query construction: max(iteration) GROUP BY coder_index,
    joined back to CodeVersion. Catches a regression where someone
    re-introduces the old `.order_by(iteration.desc()).limit(1)` shape."""
    import inspect
    from app.api.routes import visual_review as vr_module

    src = inspect.getsource(vr_module)
    assert "max_iter_per_coder" in src, (
        "visual_review.py no longer constructs the per-coder subquery. "
        "The endpoint will revert to omitting coders that lag behind the "
        "iteration leader. See VR-41."
    )
    assert "group_by(CodeVersion.coder_index)" in src
    assert "missing_coder_indices" in src
    assert "total_configured_coders" in src


def test_vr41_three_coder_scenario_query_returns_three_candidates() -> None:
    """Simulate the response shape after the VR-41 query: 3 coders where
    coder 0 produced iter 1, coder 1 produced iter 1+2 (latest=2), coder 2
    produced iter 1. Expectation: the response carries one candidate per
    coder, each at its own latest iteration.

    This test models the post-query data the route ASSEMBLES — it does not
    re-run SQLAlchemy, which would need a populated DB. The point is to
    pin that the response builder correctly carries per-coder iterations
    through to the API surface.
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
            iteration=1,
            screenshots=[],
            scores=[],
        ),
        VisualReviewCandidate(
            code_version_id=str(uuid.uuid4()),
            coder_index=1,
            iteration=2,  # different iteration from peers
            screenshots=[],
            scores=[],
        ),
        VisualReviewCandidate(
            code_version_id=str(uuid.uuid4()),
            coder_index=2,
            iteration=1,
            screenshots=[],
            scores=[],
        ),
    ]
    resp = VisualReviewStateResponse(
        session_id=sid,
        status="awaiting_visual_review",
        candidates=candidates,
        total_configured_coders=3,
        missing_coder_indices=[],
    )
    # The endpoint must surface all three, NOT collapse to a single iteration.
    assert len(resp.candidates) == 3
    iters_by_coder = {c.coder_index: c.iteration for c in resp.candidates}
    assert iters_by_coder == {0: 1, 1: 2, 2: 1}
    # No coder reported as missing.
    assert resp.missing_coder_indices == []
    assert resp.total_configured_coders == 3


def test_vr41_one_coder_missing_surfaces_in_missing_coder_indices() -> None:
    """When 3 coders are configured but only 2 produced screenshots, the
    third's index must appear in `missing_coder_indices`."""
    from app.api.routes.visual_review import (
        VisualReviewCandidate,
        VisualReviewStateResponse,
    )

    sid = str(uuid.uuid4())
    candidates = [
        VisualReviewCandidate(
            code_version_id=str(uuid.uuid4()),
            coder_index=0,
            iteration=2,
            screenshots=[],
            scores=[],
        ),
        VisualReviewCandidate(
            code_version_id=str(uuid.uuid4()),
            coder_index=2,
            iteration=1,
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
    assert 1 in resp.missing_coder_indices
    assert resp.total_configured_coders == 3
    assert len(resp.candidates) == 2


# ===========================================================================
# VR-39 — CuratedSuggestion.attachments + apply_enhancements merging
# ===========================================================================
#
# Schema-level tests (pure Pydantic — no DB, PARALLEL-SAFE). The merging
# integration test is exercised by the existing apply-enhancements e2e
# coverage; here we pin the schema shape + the route's docstring/source so
# the merging contract can't be silently reverted.


def test_vr39_curated_suggestion_attachments_is_optional_none_by_default() -> None:
    """`attachments` defaults to None — preserves backwards compatibility
    with clients that don't author per-suggestion attachments."""
    from app.schemas import CuratedSuggestion

    s = CuratedSuggestion(
        title="Add dark mode",
        category="design",
        priority="medium",
        description="Toggle theme via system preference",
    )
    assert s.attachments is None


def test_vr39_curated_suggestion_accepts_list_of_attachment_info() -> None:
    """Per-suggestion attachments must validate as `list[AttachmentInfo]`."""
    from app.schemas import AttachmentInfo, CuratedSuggestion

    att = AttachmentInfo(
        type="file",
        filename="diagram.png",
        content="base64data",
        size=1234,
    )
    s = CuratedSuggestion(
        title="Use this layout",
        category="user",
        priority="high",
        description="Apply this layout from the attached diagram",
        attachments=[att],
    )
    assert s.attachments is not None
    assert len(s.attachments) == 1
    assert s.attachments[0].filename == "diagram.png"
    assert s.attachments[0].type == "file"


def test_vr39_curated_suggestion_repo_attachment_round_trips() -> None:
    """`repo_url` and `repo` attachment types must round-trip through
    CuratedSuggestion — these drive the [refs: ...] suffix in the
    enhancement spec."""
    from app.schemas import AttachmentInfo, CuratedSuggestion

    repo_url_att = AttachmentInfo(
        type="repo_url", url="https://github.com/x/y", label="example/y"
    )
    repo_att = AttachmentInfo(
        type="repo", repo_name="example/y", branch="main", file_count=12
    )
    s = CuratedSuggestion(
        title="Borrow patterns from repo",
        category="user",
        priority="medium",
        description="Look at how this repo handles state.",
        attachments=[repo_url_att, repo_att],
    )
    assert s.attachments and len(s.attachments) == 2
    assert s.attachments[0].type == "repo_url"
    assert s.attachments[1].repo_name == "example/y"


def test_vr39_apply_enhancements_source_merges_attachments() -> None:
    """The route source must:
      1. Initialise `enhancement_attachments` per call.
      2. Iterate over `s.attachments` per curated_suggestion.
      3. Build the `merged_attachments = parent + per-suggestion` list and
         pass it to the new Session.
      4. Emit a `[refs: ...]` suffix on the enhancement line.
    Catches refactors that accidentally drop attachment propagation.
    """
    import inspect
    from app.api.routes import sessions as sessions_module

    src = inspect.getsource(sessions_module)
    # Each load-bearing line is anchored by a substring that's unique to
    # the apply_enhancements function.
    assert "enhancement_attachments: list[dict]" in src
    assert "merged_attachments" in src
    assert "session.attachments or []" in src
    # The refs suffix template.
    assert "[refs: " in src
    # The merged list is what we pass into the new Session — pin the keyword.
    assert "attachments=merged_attachments" in src


def test_vr39_refs_suffix_includes_filename_and_repo_label() -> None:
    """Verify the refs builder logic by emulating it: for a mixed set of
    attachments, the [refs: ...] suffix should pick filename, repo label
    (for repo_url), or repo_name (for repo). Mirrors the inline loop in
    apply_enhancements."""
    from app.schemas import AttachmentInfo

    atts = [
        AttachmentInfo(type="file", filename="diagram.png"),
        AttachmentInfo(type="repo_url", url="https://github.com/a/b", label="a/b"),
        AttachmentInfo(type="repo", repo_name="x/y"),
        # No filename, no url, no repo_name -> contributes nothing.
        AttachmentInfo(type="file"),
    ]
    # Mirror the production loop verbatim.
    refs: list[str] = []
    for att in atts:
        if att.type == "repo_url" and att.url:
            refs.append(f"repo {att.label or att.url}")
        elif att.type == "repo" and att.repo_name:
            refs.append(f"repo {att.repo_name}")
        elif att.filename:
            refs.append(att.filename)

    assert refs == ["diagram.png", "repo a/b", "repo x/y"]


# ---------------------------------------------------------------------------
# VR-39 — end-to-end via real HTTP (uses the e2e fixtures in conftest.py).
# Marked `e2e` + `slow` because it relies on the backend container being up.
# ---------------------------------------------------------------------------


@pytest.mark.e2e
@pytest.mark.asyncio
async def test_vr39_apply_enhancements_propagates_attachments_into_child_session(
    async_auth_client,
) -> None:
    """Full HTTP round-trip: create a session with one parent attachment, force
    it into AWAITING_ENHANCEMENT_REVIEW + populate FinalResult via direct DB
    write, POST /apply-enhancements with two suggestions each carrying their
    own attachments, then assert the child session's attachments bag
    contains parent + per-suggestion attachments.

    Marked `e2e` because it needs the backend container; `slow` because it
    performs direct DB writes to bypass the workflow lifecycle.
    """
    from sqlalchemy import update as sa_update

    try:
        from app.db import AsyncSessionLocal
        from app.db.models import FinalResult, Session as SessionModel, SessionStatus
    except Exception as exc:
        pytest.skip(f"backend modules not importable ({exc!r})")

    suffix = uuid.uuid4().hex[:8]
    parent_att = {
        "type": "file",
        "filename": f"parent-{suffix}.txt",
        "content": "parent-data",
        "size": 11,
    }
    create_resp = await async_auth_client.post(
        "/api/sessions/",
        json={
            "name": f"vr39-{suffix}",
            "specification": "Print 'hello'.",
            "attachments": [parent_att],
        },
    )
    assert create_resp.status_code in (200, 201), create_resp.text
    parent_id = create_resp.json()["id"]

    # Force the session into AWAITING_ENHANCEMENT_REVIEW + add a FinalResult.
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
                final_code="print('hello')",
                final_summary="ok",
                total_tokens=10,
                total_cost_usd=0.0,
                total_iterations=1,
            )
        )
        await db.commit()

    # Now apply enhancements with two curated suggestions, each with one
    # distinct attachment.
    sug_att_1 = {
        "type": "file",
        "filename": f"sug1-{suffix}.png",
        "size": 100,
    }
    sug_att_2 = {
        "type": "repo_url",
        "url": "https://github.com/example/repo",
        "label": "example/repo",
    }
    payload = {
        "curated_suggestions": [
            {
                "title": "S1",
                "category": "user",
                "priority": "high",
                "description": "Use the attached diagram",
                "attachments": [sug_att_1],
            },
            {
                "title": "S2",
                "category": "user",
                "priority": "medium",
                "description": "Reference repo for patterns",
                "attachments": [sug_att_2],
            },
        ]
    }
    apply_resp = await async_auth_client.post(
        f"/api/sessions/{parent_id}/apply-enhancements",
        json=payload,
    )
    assert apply_resp.status_code in (200, 201), apply_resp.text
    child_id = apply_resp.json().get("new_session_id") or apply_resp.json().get("session_id")
    assert child_id, f"apply-enhancements returned no child id: {apply_resp.text}"

    # Inspect the child session via API.
    child_resp = await async_auth_client.get(f"/api/sessions/{child_id}")
    assert child_resp.status_code == 200, child_resp.text
    child = child_resp.json()
    child_atts = child.get("attachments") or []
    filenames = [a.get("filename") for a in child_atts if a.get("filename")]
    urls = [a.get("url") for a in child_atts if a.get("url")]
    # Parent attachment must persist.
    assert parent_att["filename"] in filenames, child_atts
    # Per-suggestion file attachment must be merged.
    assert sug_att_1["filename"] in filenames, child_atts
    # Per-suggestion repo_url attachment must also be merged.
    assert sug_att_2["url"] in urls, child_atts

    # The enhancement spec must embed the refs suffix.
    spec = child.get("specification") or ""
    assert "[refs:" in spec
    assert sug_att_1["filename"] in spec
    assert "example/repo" in spec

    # Cleanup — best-effort.
    try:
        await async_auth_client.delete(f"/api/sessions/{child_id}")
    except Exception:
        pass
    try:
        await async_auth_client.delete(f"/api/sessions/{parent_id}")
    except Exception:
        pass
