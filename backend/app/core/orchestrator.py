"""
Workflow Orchestrator - manages the multi-agent code generation workflow. v1.1.0
"""
import asyncio
import logging
from typing import Any, Dict, List, Optional, Callable
from uuid import UUID
from datetime import datetime, timezone
from dataclasses import dataclass, field
from enum import Enum

from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Session, CodeVersion, Audit, SummaryAudit,
    CoderResponse, LLMRequest, FinalResult, Intervention, CodeExecution,
    AgentType, SessionStatus, CodeVersionStatus
)
from app.core.defaults import DEFAULT_CODER_MAX_TOKENS
from app.agents import (
    CoderAgent, TesterAgent, SummarizerAgent, FinalizerAgent, AgentResult
)
from app.llm.router import get_llm_router
from app.sandbox import get_sandbox_client, ExecutionResult

logger = logging.getLogger(__name__)


class WorkflowPhase(str, Enum):
    """Current phase of the workflow."""
    INITIALIZING = "initializing"
    CODING = "coding"
    EXECUTING = "executing"  # New phase for code execution
    TESTING = "testing"
    SUMMARIZING = "summarizing"
    REVIEWING = "reviewing"  # Coders reviewing audits
    FINALIZING = "finalizing"
    COMPLETED = "completed"
    PAUSED = "paused"
    FAILED = "failed"


@dataclass
class WorkflowState:
    """Current state of the workflow."""
    session_id: UUID
    phase: WorkflowPhase = WorkflowPhase.INITIALIZING
    current_iteration: int = 0
    max_iterations: int = 5

    # Agent tracking
    coders_completed: int = 0
    testers_completed: int = 0
    total_coders: int = 0
    total_testers: int = 0

    # Independent coder tracking (use a list; mutated from concurrent tasks — see _finished_coders_lock)
    finished_coders: set = field(default_factory=set)  # coder indices that finished (no issues)
    coder_iterations: Dict[int, int] = field(default_factory=dict)  # coder_index -> their current iteration
    coder_finish_reasons: Dict[int, str] = field(default_factory=dict)  # coder_index -> reason ("no_issues" or "max_iterations")

    # Results
    code_versions: Dict[int, str] = field(default_factory=dict)  # coder_index -> code
    repo_file_versions: Dict[int, dict] = field(default_factory=dict)  # coder_index -> {modified_files, new_files, deleted_files}
    execution_results: Dict[int, dict] = field(default_factory=dict)  # coder_index -> execution result
    audits: Dict[int, List[dict]] = field(default_factory=dict)  # coder_index -> [audits]
    summaries: Dict[int, dict] = field(default_factory=dict)  # coder_index -> summary
    # Feature #7: test-driven mode — synthetic critical issues injected when
    # actual output does not match the user-provided expected output. Mapped
    # by coder_index for the current iteration; cleared each iteration.
    tdd_mismatches: Dict[int, dict] = field(default_factory=dict)

    # Metrics
    total_tokens: int = 0
    total_cost: float = 0.0

    # Control flags
    should_stop: bool = False
    paused: bool = False
    failed: bool = False  # True when workflow fails (vs user cancel)
    error: Optional[str] = None

    def get_active_coders(self, all_coders: list) -> list:
        """Get coders that are still active (not finished)."""
        return [c for c in all_coders if c.agent_index not in self.finished_coders]

    def all_coders_finished(self, total_coders: int) -> bool:
        """Check if all coders have finished."""
        return len(self.finished_coders) >= total_coders


class WorkflowOrchestrator:
    """
    Orchestrates the multi-agent code generation workflow.

    Workflow:
    1. Coders generate initial code (parallel)
    2. Testers audit each code version (parallel)
    3. Summarizer consolidates audits for each coder
    4. If critical/serious issues exist and iterations < max:
       - Coders review and respond to audits
       - Coders generate new versions
       - Repeat from step 2
    5. Finalizer selects best version and generates docs
    """

    @staticmethod
    def _is_retryable_overload_error(error: Any) -> bool:
        """Check if an error indicates an overloaded / timed-out API that
        should be retried.

        VR-41 — broadened beyond overload (529 / 503) to also catch the
        timeout-class failures that were silently dropping coder candidates
        out of the Visual Review pool:
          * 504 / DEADLINE_EXCEEDED — Google Gemini deadline hit
          * "request timed out" / "timed out or interrupted" — Anthropic
          * read/connect/network timeouts — generic transport-level
          * asyncio.TimeoutError — Python-side cancellation
        These are all retryable: the error is transport/queueing, not a
        logic failure in the prompt or model output.
        """
        err_str = str(error).lower() if error else ""
        # Overload / capacity
        if "overloaded" in err_str or "529" in err_str or "503" in err_str:
            return True
        # Deadline / timeout (Google + generic HTTP)
        if "504" in err_str or "deadline_exceeded" in err_str or "deadline exceeded" in err_str:
            return True
        # Anthropic transient long-request failure
        if "request timed out" in err_str or "timed out or interrupted" in err_str:
            return True
        # Generic transport-level
        if "read timeout" in err_str or "readtimeout" in err_str:
            return True
        if "connection reset" in err_str or "connection aborted" in err_str:
            return True
        # КАО#VR-41 — также ловим camelCase варианты (ConnectionResetError / ConnectionAbortedError)
        if "connectionreset" in err_str or "connectionaborted" in err_str:
            return True
        # Python async cancellation
        if "asyncio.timeouterror" in err_str or "timeouterror" in err_str:
            return True
        return False

    def __init__(
        self,
        db: AsyncSession,
        session: Session,
        event_callback: Optional[Callable[[str, dict], None]] = None,
    ):
        self.db = db
        self.session = session
        self.event_callback = event_callback
        self._db_lock = asyncio.Lock()  # Lock for concurrent DB operations
        self._DB_LOCK_TIMEOUT = 30.0  # seconds — prevent deadlocks on _db_lock
        self._state_lock = asyncio.Lock()  # Lock for concurrent mutations of state.finished_coders / coder_finish_reasons
        # КАО#R4-S9 — per-run delivery ledger for NULL-target ("to all agents")
        # interventions: intervention_id -> set of coder indices it reached.
        self._intervention_deliveries: dict[str, set[int]] = {}
        # Cache immutable session ID to avoid lazy-load errors after DB rollback
        self._session_id = str(session.id)

        self.state = WorkflowState(
            session_id=session.id,
            max_iterations=max(session.max_iterations, 1),  # Ensure at least 1 iteration
        )

        # Initialize agents from config
        self.coders: List[CoderAgent] = []
        self.testers: List[TesterAgent] = []
        self.summarizer: Optional[SummarizerAgent] = None
        self.finalizer: Optional[FinalizerAgent] = None

        self._setup_agents()

    def get_full_specification(self) -> str:
        """Build enriched specification including attachment contents and repo URLs."""
        spec = self.session.specification
        attachments = self.session.attachments or []

        if not attachments:
            return spec

        parts = [spec]

        file_sections = []
        repo_urls = []

        for att in attachments:
            att_type = att.get('type', '') if isinstance(att, dict) else getattr(att, 'type', '')

            if att_type == 'file':
                filename = att.get('filename', '') if isinstance(att, dict) else getattr(att, 'filename', '')
                content = att.get('content', '') if isinstance(att, dict) else getattr(att, 'content', '')
                if content:
                    file_sections.append(f"### File: {filename}\n```\n{content}\n```")

            elif att_type == 'archive':
                filename = att.get('filename', '') if isinstance(att, dict) else getattr(att, 'filename', '')
                files = att.get('files', []) if isinstance(att, dict) else getattr(att, 'files', [])
                for f in files:
                    fpath = f.get('path', '') if isinstance(f, dict) else getattr(f, 'path', '')
                    fcontent = f.get('content', '') if isinstance(f, dict) else getattr(f, 'content', '')
                    if fcontent:
                        file_sections.append(f"### File: {fpath} (from {filename})\n```\n{fcontent}\n```")

            elif att_type == 'repo':
                url = att.get('url', '') if isinstance(att, dict) else getattr(att, 'url', '')
                branch = att.get('branch', '') if isinstance(att, dict) else getattr(att, 'branch', '')
                commit = att.get('commit', '') if isinstance(att, dict) else getattr(att, 'commit', '')
                files = att.get('files', []) if isinstance(att, dict) else getattr(att, 'files', [])
                repo_header = f"Repository: {url}"
                if branch:
                    repo_header += f" (branch: {branch})"
                if commit:
                    repo_header += f" @ {commit[:8]}"
                repo_urls.append(f"- {repo_header}")
                for f in files:
                    fpath = f.get('path', '') if isinstance(f, dict) else getattr(f, 'path', '')
                    fcontent = f.get('content', '') if isinstance(f, dict) else getattr(f, 'content', '')
                    if fcontent:
                        file_sections.append(f"### File: {fpath} (from repo)\n```\n{fcontent}\n```")

            elif att_type == 'repo_url':
                url = att.get('url', '') if isinstance(att, dict) else getattr(att, 'url', '')
                label = att.get('label', '') if isinstance(att, dict) else getattr(att, 'label', '')
                if url:
                    repo_urls.append(f"- {label + ': ' if label else ''}{url}")

        if file_sections:
            parts.append("\n\n## ATTACHED FILES (Reference Code / Context)\n" + "\n\n".join(file_sections))

        if repo_urls:
            parts.append("\n\n## REPOSITORY REFERENCES\n" + "\n".join(repo_urls))

        return "\n".join(parts)

    def _has_repo_attachment(self) -> bool:
        """Check if session has a repo-type attachment (cloned repository)."""
        attachments = self.session.attachments or []
        for att in attachments:
            att_type = att.get('type', '') if isinstance(att, dict) else getattr(att, 'type', '')
            if att_type == 'repo':
                return True
        return False

    def _get_repo_original_files(self) -> dict[str, str]:
        """Get original file contents from repo attachment as {path: content} dict."""
        attachments = self.session.attachments or []
        files = {}
        for att in attachments:
            att_type = att.get('type', '') if isinstance(att, dict) else getattr(att, 'type', '')
            if att_type == 'repo':
                att_files = att.get('files', []) if isinstance(att, dict) else getattr(att, 'files', [])
                for f in att_files:
                    fpath = f.get('path', '') if isinstance(f, dict) else getattr(f, 'path', '')
                    fcontent = f.get('content', '') if isinstance(f, dict) else getattr(f, 'content', '')
                    if fpath and fcontent:
                        files[fpath] = fcontent
        return files

    def _merge_repo_files(
        self,
        original_files: dict[str, str],
        modified_files: dict[str, str],
        new_files: dict[str, str],
        deleted_files: list[str],
    ) -> dict[str, str]:
        """Merge original repo files with coder's modifications.

        Returns complete file set: original files + modifications + new files - deleted files.
        """
        merged = dict(original_files)
        for path, content in modified_files.items():
            merged[path] = content
        for path, content in new_files.items():
            merged[path] = content
        for path in deleted_files:
            merged.pop(path, None)
        return merged

    def _setup_agents(self) -> None:
        """Store agent configs for lazy initialization (actual init in _ensure_agents_initialized)."""
        self._agent_configs = list(self.session.agent_configs)
        self._agents_initialized = False

    async def _ensure_agents_initialized(self) -> None:
        """Ensure agents are initialized (called before running workflow)."""
        if self._agents_initialized:
            return

        llm_router = await get_llm_router()

        # Per-request httpx timeout and overall agent timeout from session settings.
        agent_timeout = self.session.agent_timeout or 600
        llm_request_timeout = self.session.request_timeout or 300

        for config in self._agent_configs:
            effort = getattr(config, 'thinking_effort', None)
            if config.agent_type == AgentType.CODER:
                agent = CoderAgent(
                    llm_router=llm_router,
                    provider=config.llm_provider,
                    model=config.llm_model,
                    prompt_template=config.custom_prompt,
                    agent_index=config.agent_index,
                    temperature=config.temperature or 0.7,
                    # КАО#VR-29 — floor at DEFAULT_CODER_MAX_TOKENS (128k after raise)
                    # so even sessions with old DB rows pinned to 64k get enough
                    # budget to finish a non-trivial HTML+JS generation.
                    max_tokens=max(config.max_tokens or DEFAULT_CODER_MAX_TOKENS, DEFAULT_CODER_MAX_TOKENS),
                    thinking_effort=effort,
                    request_timeout=llm_request_timeout,
                )
                self.coders.append(agent)

            elif config.agent_type == AgentType.TESTER:
                agent = TesterAgent(
                    llm_router=llm_router,
                    provider=config.llm_provider,
                    model=config.llm_model,
                    prompt_template=config.custom_prompt,
                    agent_index=config.agent_index,
                    temperature=config.temperature or 0.3,
                    max_tokens=config.max_tokens or 32768,
                    thinking_effort=effort,
                    request_timeout=llm_request_timeout,
                )
                self.testers.append(agent)

            elif config.agent_type == AgentType.SUMMARIZER:
                self.summarizer = SummarizerAgent(
                    llm_router=llm_router,
                    provider=config.llm_provider,
                    model=config.llm_model,
                    prompt_template=config.custom_prompt,
                    temperature=config.temperature or 0.3,
                    max_tokens=config.max_tokens or 32768,
                    thinking_effort=effort,
                    request_timeout=llm_request_timeout,
                )

            elif config.agent_type == AgentType.FINALIZER:
                self.finalizer = FinalizerAgent(
                    llm_router=llm_router,
                    provider=config.llm_provider,
                    model=config.llm_model,
                    prompt_template=config.custom_prompt,
                    temperature=config.temperature or 0.4,
                    max_tokens=config.max_tokens or 32768,
                    thinking_effort=effort,
                    request_timeout=llm_request_timeout,
                )

        self.state.total_coders = len(self.coders)
        self.state.total_testers = len(self.testers)
        self._agents_initialized = True

        logger.info(f"Initialized workflow with {len(self.coders)} coders, "
                   f"{len(self.testers)} testers")

    async def load_state_from_db(self) -> None:
        """Reconstruct workflow state from existing DB records.

        Used by re-finalization to rebuild self.state from persisted data
        without re-running coding/testing/summarizing phases.
        """
        from sqlalchemy import select as sa_select, func as sa_func

        session_id = self.session.id

        # 1. Load latest code versions per coder (highest iteration)
        max_iter_subq = (
            sa_select(
                CodeVersion.coder_index,
                sa_func.max(CodeVersion.iteration).label("max_iter"),
            )
            .where(CodeVersion.session_id == session_id)
            .group_by(CodeVersion.coder_index)
            .subquery()
        )

        cv_stmt = (
            sa_select(CodeVersion)
            .join(
                max_iter_subq,
                (CodeVersion.coder_index == max_iter_subq.c.coder_index)
                & (CodeVersion.iteration == max_iter_subq.c.max_iter),
            )
            .where(CodeVersion.session_id == session_id)
        )
        cv_result = await self.db.execute(cv_stmt)
        code_version_rows = cv_result.scalars().all()

        for cv in code_version_rows:
            self.state.code_versions[cv.coder_index] = cv.code_content
            self.state.coder_iterations[cv.coder_index] = cv.iteration

            # Reconstruct repo_file_versions from file_structure if available
            if cv.file_structure:
                modified = {}
                new_files = {}
                deleted = []
                for path, info in cv.file_structure.items():
                    action = info.get("action", "modified")
                    content = info.get("content", "")
                    if action == "modified":
                        modified[path] = content
                    elif action == "created":
                        new_files[path] = content
                    elif action == "deleted":
                        deleted.append(path)
                self.state.repo_file_versions[cv.coder_index] = {
                    "modified_files": modified,
                    "new_files": new_files,
                    "deleted_files": deleted,
                    "change_summary": "",
                }

        # 2. Load latest summaries per coder (highest iteration)
        max_sum_subq = (
            sa_select(
                SummaryAudit.coder_index,
                sa_func.max(SummaryAudit.iteration).label("max_iter"),
            )
            .where(SummaryAudit.session_id == session_id)
            .group_by(SummaryAudit.coder_index)
            .subquery()
        )

        sum_stmt = (
            sa_select(SummaryAudit)
            .join(
                max_sum_subq,
                (SummaryAudit.coder_index == max_sum_subq.c.coder_index)
                & (SummaryAudit.iteration == max_sum_subq.c.max_iter),
            )
            .where(SummaryAudit.session_id == session_id)
        )
        sum_result = await self.db.execute(sum_stmt)
        summary_rows = sum_result.scalars().all()

        for sa in summary_rows:
            self.state.summaries[sa.coder_index] = {
                "overall_assessment": "",
                "average_scores": {},
                "critical_issues": sa.critical_issues or [],
                "serious_issues": sa.serious_issues or [],
                "minor_issues": sa.minor_issues or [],
                "suggestions": sa.suggestions or [],
                "positive_aspects": [],
                "consensus_notes": sa.consensus_notes or "",
                "recommended_focus": sa.recommended_focus or [],
            }

        # 3. Infer coder_finish_reasons from summaries
        for coder_index in self.state.code_versions:
            summary = self.state.summaries.get(coder_index, {})
            has_critical = bool(summary.get("critical_issues"))
            has_serious = bool(summary.get("serious_issues"))
            async with self._state_lock:
                if not has_critical and not has_serious:
                    self.state.coder_finish_reasons[coder_index] = "no_issues"
                else:
                    self.state.coder_finish_reasons[coder_index] = "max_iterations"
                self.state.finished_coders.add(coder_index)

        # 4. Load accumulated tokens/cost from LLM requests
        from sqlalchemy import func as sa_func2
        metrics_stmt = (
            sa_select(
                sa_func2.coalesce(sa_func2.sum(LLMRequest.input_tokens + LLMRequest.output_tokens), 0),
                sa_func2.coalesce(sa_func2.sum(LLMRequest.cost_usd), 0),
            )
            .where(LLMRequest.session_id == session_id)
        )
        metrics_result = await self.db.execute(metrics_stmt)
        row = metrics_result.one()
        self.state.total_tokens = int(row[0])
        self.state.total_cost = float(row[1])

        # 5. Set current_iteration to max of all coder iterations
        if self.state.coder_iterations:
            self.state.current_iteration = max(self.state.coder_iterations.values())

        logger.info(
            f"Loaded state from DB: {len(self.state.code_versions)} code versions, "
            f"{len(self.state.summaries)} summaries, "
            f"iteration={self.state.current_iteration}, "
            f"tokens={self.state.total_tokens}, cost=${self.state.total_cost:.4f}"
        )

    async def run_finalization_only(
        self,
        forced_winner_code_version_id: Optional[str] = None,
        forced_winner_reasoning: Optional[str] = None,
    ) -> bool:
        """Run only the finalization phase using existing DB state.

        Used by the re-finalize endpoint to re-run finalization without
        re-running coding/testing/summarizing phases.

        If ``forced_winner_code_version_id`` is provided, the finalizer's
        LLM-based selection is overridden in favour of that specific
        code_version_id (used by the Visual Review wave-2 flow when the
        user has scored candidates). ``forced_winner_reasoning`` is an
        optional audit-trail string that will be prepended to
        ``FinalResult.selection_reasoning``.
        """
        try:
            await self._ensure_agents_initialized()
            await self.load_state_from_db()

            if not self.state.code_versions:
                raise ValueError("No code versions found in DB for this session")

            # Update session status to RUNNING
            self.session.status = SessionStatus.RUNNING
            await self.db.commit()

            await self.emit_event("workflow_started", {
                "max_iterations": self.state.max_iterations,
                "total_coders": len(self.state.code_versions),
                "total_testers": 0,
                "re_finalize": True,
            })

            # Delete old FinalResult (unique constraint on session_id)
            from sqlalchemy import delete as sa_del
            await self.db.execute(
                sa_del(FinalResult).where(FinalResult.session_id == self.session.id)
            )
            await self.db.commit()

            # Run finalization (pre-execution + finalizer + save)
            await self._run_finalization_phase(
                forced_winner_code_version_id=forced_winner_code_version_id,
                forced_winner_reasoning=forced_winner_reasoning,
            )

            # КАО#R4-M8 — honour a cancel that arrived during finalization:
            # don't overwrite CANCELLED with COMPLETED/AWAITING_*.
            if self.state.should_stop:
                logger.info("Finalization-only run cancelled — skipping terminal status write")
                await self.emit_event("workflow_cancelled", {"re_finalize": True})
                return False

            from sqlalchemy import update as _sa_update

            # Determine post-finalization status
            enhancer_types = {
                AgentType.ENHANCER_DESIGN, AgentType.ENHANCER_FUNC,
                AgentType.ENHANCER_SECURITY, AgentType.ENHANCER_SUMMARY,
            }
            has_enhancers = any(
                c.agent_type in enhancer_types and getattr(c, 'enabled', True)
                for c in self.session.agent_configs
            ) if self.session.agent_configs else False

            if has_enhancers:
                self.state.phase = WorkflowPhase.COMPLETED
                # КАО#R4-M8 — CAS from RUNNING so a concurrent cancel/reset wins.
                _cas = await self.db.execute(
                    _sa_update(Session)
                    .where(Session.id == self.session.id)
                    .where(Session.status == SessionStatus.RUNNING)
                    .values(status=SessionStatus.AWAITING_ENHANCEMENT)
                )
                await self.db.commit()
                if _cas.rowcount:
                    self.session.status = SessionStatus.AWAITING_ENHANCEMENT
                else:
                    logger.info("Session no longer RUNNING after re-finalize; keeping its current status")
                    return True

                await self.emit_event("awaiting_enhancement", {
                    "total_iterations": self.state.current_iteration,
                    "total_tokens": self.state.total_tokens,
                    "total_cost": self.state.total_cost,
                    "message": "Re-finalization complete. Configure and run enhancement agents.",
                    "re_finalize": True,
                })
            else:
                self.state.phase = WorkflowPhase.COMPLETED
                # КАО#R4-M8 — CAS from RUNNING so a concurrent cancel/reset wins.
                _cas = await self.db.execute(
                    _sa_update(Session)
                    .where(Session.id == self.session.id)
                    .where(Session.status == SessionStatus.RUNNING)
                    .values(status=SessionStatus.COMPLETED)
                )
                await self.db.commit()
                if _cas.rowcount:
                    self.session.status = SessionStatus.COMPLETED
                else:
                    logger.info("Session no longer RUNNING after re-finalize; keeping its current status")
                    return True

                await self.emit_event("workflow_completed", {
                    "total_iterations": self.state.current_iteration,
                    "total_tokens": self.state.total_tokens,
                    "total_cost": self.state.total_cost,
                    "coder_iterations": self.state.coder_iterations,
                    "re_finalize": True,
                })

            return True

        except Exception as e:
            logger.error(f"Re-finalization error: {e}", exc_info=True)
            try:
                self.session.status = SessionStatus.FAILED
                await self.db.commit()
            except Exception:
                try:
                    await self.db.rollback()
                except Exception:
                    pass

            await self.emit_event("workflow_error", {
                "error": str(e),
                "phase": "finalizing",
                "re_finalize": True,
            })
            return False

    async def emit_event(self, event_type: str, data: dict) -> None:
        """Emit a workflow event.

        Broadcasts to the WebSocket subscribers via event_callback, then (for a
        small set of significant events) fires registered webhooks asynchronously.
        Webhook delivery is fire-and-forget — never blocks the workflow.
        """
        if self.event_callback:
            try:
                # Use state.session_id (cached str) instead of
                # self.session.id to avoid lazy-load after DB rollback.
                await self.event_callback(event_type, {
                    "session_id": str(self.state.session_id),
                    "timestamp": datetime.now(timezone.utc).isoformat(),
                    **data,
                })
            except Exception as e:
                logger.warning(f"Failed to emit WS event '{event_type}': {e}")

        # Webhook dispatch — only for significant lifecycle events.
        WEBHOOK_EVENTS = {
            "workflow_completed",
            "workflow_error",
            "workflow_cancelled",
            "awaiting_enhancement",
        }
        if event_type in WEBHOOK_EVENTS:
            try:
                from app.services.webhook_dispatcher import dispatch_event
                # Best-effort: pull session name without touching the DB.
                session_name = None
                try:
                    session_name = self.session.name if self.session else None
                except Exception:
                    session_name = None
                webhook_data = {
                    **data,
                    "session_id": str(self.state.session_id),
                    "session_name": session_name,
                }
                # Fire-and-forget — don't block workflow on webhook delays.
                asyncio.create_task(dispatch_event(event_type, webhook_data))
            except Exception as e:
                logger.warning(f"Failed to enqueue webhook for {event_type}: {e}")

    async def _wait_if_paused(self) -> None:
        """Block until the workflow is un-paused (or stopped).

        Polls every 0.5 s so the user doesn't have to wait long after clicking
        Resume.  When pausing, the session status is also synced to the DB so
        the frontend sees 'paused' immediately.
        """
        if not self.state.paused:
            return

        self.state.phase = WorkflowPhase.PAUSED
        self.session.status = SessionStatus.PAUSED
        async with self._db_lock:
            await self.db.commit()

        await self.emit_event("workflow_paused", {
            "reason": "user_paused",
            "iteration": self.state.current_iteration,
        })

        logger.info("Workflow paused, waiting for resume or stop…")
        while self.state.paused and not self.state.should_stop:
            await asyncio.sleep(0.5)

        if not self.state.should_stop:
            # Resuming
            self.state.phase = WorkflowPhase.CODING  # will be corrected by next phase
            self.session.status = SessionStatus.RUNNING
            async with self._db_lock:
                await self.db.commit()
            logger.info("Workflow resumed")

    async def run(self, resume_from_db: bool = False) -> bool:
        """Run the complete workflow.

        КАО#R4-M14 — ``resume_from_db=True`` (boot auto-resume / post-restart
        /resume) restores persisted work via load_state_from_db() instead of
        re-running the whole pipeline from iteration 1: loaded coders are
        marked finished, so the loop falls through to finalization with the
        already-produced code (no duplicated LLM spend, no FinalResult clobber).

        Returns True if workflow completed successfully, False if cancelled/failed.
        """
        # Feature #3b: session-level time budget.
        # If session.session_timeout_sec is set, wrap the entire run with
        # asyncio.wait_for. On timeout, mark session FAILED with a clear error.
        timeout_sec = getattr(self.session, "session_timeout_sec", None)
        try:
            if timeout_sec:
                try:
                    return await asyncio.wait_for(self._run_inner(resume_from_db=resume_from_db), timeout=float(timeout_sec))
                except asyncio.TimeoutError:
                    logger.error(f"Session exceeded time budget of {timeout_sec}s")
                    self.state.should_stop = True
                    self.state.failed = True
                    self.state.error = "Session exceeded time budget"
                    try:
                        self.session.status = SessionStatus.FAILED
                        await self.db.commit()
                    except Exception as commit_err:
                        logger.warning(f"Failed to persist FAILED status after timeout: {commit_err}")
                        try:
                            await self.db.rollback()
                        except Exception:
                            pass
                    try:
                        await self.emit_event("workflow_error", {
                            "error": "Session exceeded time budget",
                            "timeout_sec": int(timeout_sec),
                        })
                    except Exception:
                        pass
                    return False
            return await self._run_inner(resume_from_db=resume_from_db)
        except Exception as e:
            return await self._handle_workflow_exception(e)

    async def _run_inner(self, resume_from_db: bool = False) -> bool:
        """Inner workflow body — extracted so run() can wrap it with a timeout."""
        try:
            await self._initialize_workflow()
            # КАО#R4-M14 — restore half of checkpointing: seed state from the DB
            # on a post-restart resume so we DON'T re-run from iteration 1.
            if resume_from_db:
                try:
                    await self.load_state_from_db()
                    if self.state.code_versions:
                        logger.info(
                            "Resume-from-DB: restored persisted work "
                            f"(iteration={self.state.current_iteration}, "
                            f"{len(self.state.code_versions)} code versions) — "
                            "continuing to finalization instead of re-running"
                        )
                except Exception as resume_err:  # noqa: BLE001
                    logger.warning(f"Resume-from-DB load failed (running fresh): {resume_err}")
            # VR-54 — surface any configured model the provider doesn't actually
            # offer (the router silently falls back to its first available model).
            await self._warn_substituted_models()
            await self._run_iteration_loop()

            # If cancelled/stopped, do NOT run finalization — respect user intent
            if self.state.should_stop:
                return await self._handle_workflow_stopped()

            # Visual Review (Wave 1): if the session is a visual one and the
            # spec asks for a visual artifact, pause BEFORE the Finalizer to
            # collect user scores. The orchestrator returns control here;
            # the submit/skip/timeout API endpoints will drive the rest of
            # the lifecycle. Wave 2 will re-enter and run finalization with
            # the collected scores in hand.
            if await self._maybe_enter_visual_review():
                logger.info(
                    f"Session {self._session_id} entered AWAITING_VISUAL_REVIEW; "
                    f"orchestrator returning until user submits / skips / times out"
                )
                return True

            # Phase 4: Finalization
            await self._run_finalization_phase()

            # Mark complete or awaiting enhancement
            await self._handle_workflow_completed()
            return True

        except Exception as e:
            return await self._handle_workflow_exception(e)

    async def _warn_substituted_models(self) -> None:
        """VR-54 — surface (not silently swap) any configured model the provider
        doesn't actually offer. The router falls back to the provider's first
        available model; here we emit a ``model_substituted`` event per affected
        agent so the user isn't unknowingly running a different / weaker model.
        """
        agents = list(self.coders) + list(self.testers)
        if getattr(self, "summarizer", None):
            agents.append(self.summarizer)
        if getattr(self, "finalizer", None):
            agents.append(self.finalizer)
        seen: set[tuple[str, str]] = set()
        for agent in agents:
            try:
                provider_obj = agent.llm_router.get_provider(agent.provider)
                if not provider_obj or provider_obj.supports_model(agent.model):
                    continue
                available = provider_obj.available_models
                used = available[0] if available else None
            except Exception:
                continue
            key = (str(agent.provider), str(agent.model))
            if key in seen:
                continue
            seen.add(key)
            at = agent.agent_type.value if hasattr(agent.agent_type, "value") else str(agent.agent_type)
            logger.warning(
                f"VR-54: model '{agent.model}' not available for provider "
                f"'{agent.provider}' ({at}); router will use '{used}' instead"
            )
            await self.emit_event("model_substituted", {
                "agent_type": at,
                "provider": str(agent.provider),
                "requested_model": str(agent.model),
                "used_model": used,
            })

    async def _maybe_enter_visual_review(self) -> bool:
        """If the session qualifies for visual review, capture screenshots,
        flip status to AWAITING_VISUAL_REVIEW, and return True.

        Returns False if visual review is not triggered for this session
        (the orchestrator should then proceed normally to the Finalizer).
        Any failure inside the capture pipeline is logged and treated as
        a no-op so the workflow never breaks because of visual review.
        """
        try:
            from app.core.visual_review import should_run_visual_review
            from app.services.visual_review import enter_awaiting_visual_review
        except Exception as e:
            logger.warning(f"Visual review module unavailable: {e}")
            return False

        if not should_run_visual_review(self.session):
            return False

        if not self.state.code_versions:
            logger.info("Visual review skipped — no code versions to capture")
            return False

        try:
            # КАО#R2-04 — wire on_resume so the 24h auto-finalize timer AND the
            # 1h vision auto-resume actually advance the session. Previously the
            # orchestrator omitted it (→ None), so both timers fired but never
            # finalized — sessions sat in AWAITING_VISUAL_REVIEW forever unless a
            # user manually submitted/skipped. This mirrors the API route
            # handlers' handoff, but with a FRESH db session because the
            # request-scoped one is long closed when those background timers fire.
            async def _vr_on_resume(sid: str, reason: str) -> None:
                from app.db import AsyncSessionLocal
                from app.services.visual_review import resume_after_visual_review
                from app.api.websocket.manager import session_manager
                try:
                    async with AsyncSessionLocal() as fresh_db:
                        await resume_after_visual_review(
                            db=fresh_db,
                            session_id=sid,
                            reason=reason,
                            event_callback=session_manager.broadcast,
                        )
                except Exception as e:
                    logger.error(
                        f"visual-review auto-resume ({reason}) failed for {sid}: {e}",
                        exc_info=True,
                    )

            ok = await enter_awaiting_visual_review(
                db=self.db,
                session_id=self._session_id,
                language=self.session.language,
                event_callback=self.event_callback,
                on_resume=_vr_on_resume,
            )
            return ok
        except Exception as e:
            logger.error(f"Visual review entry failed: {e}", exc_info=True)
            # Fall through to normal finalization on any error — never break
            # the workflow because of an optional review step.
            return False

    async def _initialize_workflow(self) -> None:
        """Initialize agents, state, status; emit workflow_started; cache scalar values."""
        # Ensure agents are initialized
        await self._ensure_agents_initialized()

        # Initialize coder iterations tracking
        for coder in self.coders:
            self.state.coder_iterations[coder.agent_index] = 0

        self.state.phase = WorkflowPhase.INITIALIZING
        await self.emit_event("workflow_started", {
            "max_iterations": self.state.max_iterations,
            "total_coders": self.state.total_coders,
            "total_testers": self.state.total_testers,
        })

        # Update session status
        self.session.status = SessionStatus.RUNNING
        await self.db.commit()

        # Cache session scalar attributes so that DB rollbacks (from
        # duplicate-key or other transient errors) don't trigger
        # lazy-load MissingGreenlet exceptions later in the loop.
        self._cached_auto_continue = self.session.auto_continue
        # Also eagerly load all scalar fields that _run_coding_phase,
        # _run_testing_phase, and _run_finalization_phase read.
        _session_id = self.session.id
        _language = self.session.language
        _enable_exec = self.session.enable_code_execution
        _max_fix = self.session.max_fix_attempts
        _exec_timeout = self.session.execution_timeout
        _auto_install = self.session.auto_install_deps
        _agent_timeout = self.session.agent_timeout
        # These are now cached in Python; the code still reads via
        # self.session.* — force-load to populate the identity-map.

    async def _save_checkpoint(self, phase: str) -> None:
        """Save workflow state checkpoint for crash recovery.

        Best-effort: any failure is logged and swallowed so the workflow
        is never disrupted by checkpointing.
        """
        try:
            from app.db.models import WorkflowCheckpoint
            state_json = {
                "current_iteration": self.state.current_iteration,
                "phase": phase,
                "finished_coders": list(self.state.finished_coders),
                "coder_iterations": dict(self.state.coder_iterations),
                "coder_finish_reasons": dict(self.state.coder_finish_reasons),
                # Truncate code per-coder so checkpoint payload stays bounded
                "code_versions": {
                    str(k): (v[:1000] if isinstance(v, str) else "")
                    for k, v in self.state.code_versions.items()
                },
                "total_tokens": self.state.total_tokens,
                "total_cost": self.state.total_cost,
            }
            try:
                async with asyncio.timeout(self._DB_LOCK_TIMEOUT):
                    async with self._db_lock:
                        checkpoint = WorkflowCheckpoint(
                            session_id=self._session_id,
                            iteration=self.state.current_iteration,
                            phase=phase,
                            state_json=state_json,
                            total_tokens=self.state.total_tokens,
                            total_cost_usd=self.state.total_cost,
                        )
                        self.db.add(checkpoint)
                        try:
                            await self.db.commit()
                            logger.debug(
                                f"Checkpoint saved at iter {self.state.current_iteration}, phase {phase}"
                            )
                        except IntegrityError:
                            # Already exists for (session, iteration, phase) — ignore
                            await self.db.rollback()
            except AttributeError:
                # Python < 3.11 fallback: no asyncio.timeout — use plain lock
                async with self._db_lock:
                    checkpoint = WorkflowCheckpoint(
                        session_id=self._session_id,
                        iteration=self.state.current_iteration,
                        phase=phase,
                        state_json=state_json,
                        total_tokens=self.state.total_tokens,
                        total_cost_usd=self.state.total_cost,
                    )
                    self.db.add(checkpoint)
                    try:
                        await self.db.commit()
                    except IntegrityError:
                        await self.db.rollback()
        except Exception as e:
            logger.warning(f"Failed to save checkpoint: {e}")

    @staticmethod
    def _resolve_streaming_enabled(session_settings: Optional[dict]) -> bool:
        """КАО#R5-streaming-test — resolve the per-session streaming flag.

        Default ON: Anthropic enforces a long-request timeout (~10 min) on
        non-streaming calls; streaming avoids it (the provider falls back to a
        non-streaming generate() on stream errors, so this is strictly safer).
        Existing sessions with an explicit ``settings.streaming`` keep their
        value; only missing/unset → True. ``session.settings`` may be None.

        Extracted as a pure static method so the default can be unit-tested
        behaviorally instead of asserting on orchestrator source text.
        """
        settings = session_settings or {}
        return bool(settings.get("streaming", True))

    async def _apply_cost_circuit_breaker(self) -> None:
        """КАО#R5-cost-test — money-loss prevention: stop the session when the
        configured cost cap is exceeded.

        Extracted verbatim from the iteration-end block so this money-critical
        logic can be unit-tested directly (see
        ``backend/tests/test_kao_r5_cost_breaker.py``) instead of only running
        inside the full iteration loop. Behaviour is unchanged.
        """
        cost_limit = getattr(self.session, "cost_limit_usd", None)
        if cost_limit is None:
            return
        try:
            cost_limit_f = float(cost_limit)
        except (TypeError, ValueError):
            return
        if self.state.total_cost > cost_limit_f:
            logger.warning(
                f"Cost limit exceeded: ${self.state.total_cost:.4f} > ${cost_limit_f:.2f}"
            )
            await self.emit_event("cost_limit_exceeded", {
                "cost_usd": self.state.total_cost,
                "limit": cost_limit_f,
            })
            self.state.should_stop = True
            self.state.failed = True
            self.state.error = "Cost limit exceeded"

    async def _run_iteration_loop(self) -> None:
        """Run the main iteration loop until stop or all coders finish."""
        auto_continue = self._cached_auto_continue

        while not self.state.should_stop:
            # Check for user-initiated pause between iterations
            await self._wait_if_paused()
            if self.state.should_stop:
                break

            self.state.current_iteration += 1

            # Persist current_iteration to DB so API reads reflect real progress
            self.session.current_iteration = self.state.current_iteration
            await self.db.commit()

            # Check if all coders finished
            if self.state.all_coders_finished(len(self.coders)):
                logger.info("All coders finished, proceeding to finalization")
                break

            # Check max iterations for remaining active coders
            active_coders = self.state.get_active_coders(self.coders)
            if not active_coders:
                logger.info("No active coders remaining, proceeding to finalization")
                break

            # Check if all active coders reached max iterations
            all_at_max = all(
                self.state.coder_iterations.get(c.agent_index, 0) >= self.state.max_iterations
                for c in active_coders
            )
            if all_at_max:
                logger.info("All active coders reached max iterations, proceeding to finalization")
                # Mark them as finished with reason
                for coder in active_coders:
                    async with self._state_lock:
                        self.state.finished_coders.add(coder.agent_index)
                        self.state.coder_finish_reasons[coder.agent_index] = "max_iterations"
                    await self.emit_event("coder_finished", {
                        "coder_index": coder.agent_index,
                        "reason": "max_iterations",
                        "iteration": self.state.coder_iterations[coder.agent_index],
                    })
                break

            await self.emit_event("iteration_started", {
                "iteration": self.state.current_iteration,
                "active_coders": [c.agent_index for c in active_coders],
            })

            # Pipelined phases: each coder runs its own coder→testers→summarizer
            # chain concurrently with the others, so testers start auditing as
            # soon as their coder finishes (was: hard barrier where testers
            # waited for the slowest coder before any of them could begin).
            await self._run_iteration_pipeline()
            if self.state.should_stop:
                break
            await self._wait_if_paused()
            if self.state.should_stop:
                break

            # Check each active coder individually
            await self._check_and_finish_coders()

            await self.emit_event("iteration_completed", {
                "iteration": self.state.current_iteration,
                "active_coders": [c.agent_index for c in self.state.get_active_coders(self.coders)],
                "finished_coders": list(self.state.finished_coders),
            })

            # Feature #3a: cost circuit breaker.
            # Stop the session if the configured cost cap is exceeded.
            await self._apply_cost_circuit_breaker()

            # Auto-save checkpoint for crash recovery (best-effort, never breaks workflow)
            await self._save_checkpoint("iteration_end")

            # Check for auto-continue (use cached value to avoid lazy-load
            # errors if the DB session was rolled back during a save)
            if not auto_continue and not self.state.all_coders_finished(len(self.coders)):
                self.state.paused = True
                await self._wait_if_paused()
                if self.state.should_stop:
                    break

    async def _handle_workflow_stopped(self) -> bool:
        """Handle stopped workflow: failed vs user-cancelled paths. Returns False."""
        await self.db.refresh(self.session)

        if self.state.failed:
            # Workflow failed (e.g. all coders returned errors)
            logger.error(f"Workflow failed: {self.state.error}")
            self.state.phase = WorkflowPhase.FAILED
            # КАО#R4-S8 — write FAILED atomically, ONLY from RUNNING. The old
            # guard `status not in (CREATED, RUNNING)` skipped the NORMAL case —
            # a failing workflow IS RUNNING — so the session stayed RUNNING
            # forever. The CAS still avoids clobbering a concurrent reset
            # (CREATED) or cancel (CANCELLED).
            from sqlalchemy import update as _sa_update
            _cas = await self.db.execute(
                _sa_update(Session)
                .where(Session.id == self.session.id)
                .where(Session.status == SessionStatus.RUNNING)
                .values(status=SessionStatus.FAILED)
            )
            await self.db.commit()
            if _cas.rowcount:
                self.session.status = SessionStatus.FAILED
            else:
                logger.info(
                    f"Session not RUNNING at failure (status={self.session.status}); "
                    "skipping FAILED write to avoid clobbering a reset/cancel/restart"
                )
            await self.emit_event("workflow_error", {
                "error": self.state.error or "Workflow failed",
                "phase": "coding",
                "iteration": self.state.current_iteration,
            })
        else:
            # User-initiated cancel
            logger.info("Workflow stopped/cancelled by user")
            # Re-read current DB status to avoid overwriting a new start/reset.
            # If the session was already reset (CREATED) or re-started (RUNNING)
            # by the time we reach here, we must NOT clobber that status.
            await self.db.refresh(self.session)
            if self.session.status not in (
                SessionStatus.CANCELLED, SessionStatus.PAUSED,
                SessionStatus.CREATED, SessionStatus.RUNNING,
            ):
                self.session.status = SessionStatus.CANCELLED
                await self.db.commit()
            elif self.session.status in (SessionStatus.CREATED, SessionStatus.RUNNING):
                logger.info(
                    f"Session already in {self.session.status} state "
                    f"(likely reset/restarted), skipping cancel write"
                )
            await self.emit_event("workflow_cancelled", {
                "iteration": self.state.current_iteration,
                "total_tokens": self.state.total_tokens,
                "total_cost": self.state.total_cost,
            })
        return False

    async def _handle_workflow_completed(self) -> None:
        """Post-finalization: check enhancers; set COMPLETED or AWAITING_ENHANCEMENT."""
        # Check if session has enabled enhancer configs — if so, stop for user review
        enhancer_types = {AgentType.ENHANCER_DESIGN, AgentType.ENHANCER_FUNC, AgentType.ENHANCER_SECURITY, AgentType.ENHANCER_SUMMARY}
        has_enhancers = any(
            c.agent_type in enhancer_types and getattr(c, 'enabled', True)
            for c in self.session.agent_configs
        ) if self.session.agent_configs else False

        if has_enhancers:
            # Stop for enhancement workflow
            self.state.phase = WorkflowPhase.COMPLETED
            self.session.status = SessionStatus.AWAITING_ENHANCEMENT
            await self.db.commit()

            await self.emit_event("awaiting_enhancement", {
                # КАО#R1-11b — same real-executed-count fix as workflow_completed
                # (this has_enhancers sibling branch was missed in R1-11), so the
                # WS event and the persisted FinalResult report a consistent value.
                "total_iterations": max(self.state.coder_iterations.values(), default=self.state.current_iteration),
                "total_tokens": self.state.total_tokens,
                "total_cost": self.state.total_cost,
                "message": "Final code ready. Configure and run enhancement agents.",
            })
        else:
            # No enhancers configured — mark as completed
            self.state.phase = WorkflowPhase.COMPLETED
            self.session.status = SessionStatus.COMPLETED
            await self.db.commit()

            await self.emit_event("workflow_completed", {
                # КАО#R1-11 — report the real executed iteration count. The loop
                # increments current_iteration at the top before the terminal
                # break, so it ends one higher than iterations actually run.
                "total_iterations": max(self.state.coder_iterations.values(), default=self.state.current_iteration),
                "total_tokens": self.state.total_tokens,
                "total_cost": self.state.total_cost,
                "coder_iterations": self.state.coder_iterations,
            })

    async def _handle_workflow_exception(self, e: Exception) -> bool:
        """Top-level exception handler: set FAILED status and emit workflow_error."""
        logger.error(f"Workflow error: {e}", exc_info=True)
        self.state.phase = WorkflowPhase.FAILED
        self.state.error = str(e)
        try:
            self.session.status = SessionStatus.FAILED
            await self.db.commit()
        except Exception as db_err:
            logger.error(f"Failed to update session status to FAILED: {db_err}")
            try:
                await self.db.rollback()
            except Exception:
                pass

        await self.emit_event("workflow_error", {
            "error": str(e),
            "phase": self.state.phase.value,
            "iteration": self.state.current_iteration,
        })

        return False

    # ─── Pipelined per-coder pipeline (coder → testers → summarizer) ────────
    # Streaming orchestration: every coder runs its full coder→testers→summarizer
    # chain in its own task, so testers begin auditing as soon as their coder
    # finishes instead of waiting for the slowest coder. All coder pipelines
    # execute concurrently; this replaces the previous strict 3-phase barrier.

    async def _run_iteration_pipeline(self) -> None:
        """Pipelined replacement for sequential coding → testing → summarizing.

        Each active coder runs its full pipeline concurrently:
          1) coder.execute()
          2) post-process result (sandbox exec / fix loop / TDD check)
          3) all testers audit that coder's code in parallel
          4) summarizer consolidates the audits

        This dramatically reduces wall-clock time when coders finish at
        different speeds — fast coders no longer wait for slow ones at the
        coding→testing barrier.
        """
        self.state.phase = WorkflowPhase.CODING
        self.state.coders_completed = 0
        self.state.testers_completed = 0
        # Feature #7: clear any TDD mismatches from a previous iteration
        self.state.tdd_mismatches.clear()

        active_coders = self.state.get_active_coders(self.coders)
        if not active_coders:
            logger.info("No active coders to run in pipelined iteration")
            return

        # Clear audits for active coders before pipelines populate them
        for coder in active_coders:
            self.state.audits[coder.agent_index] = []

        await self.emit_event("phase_started", {
            "phase": "coding",
            "iteration": self.state.current_iteration,
            "active_coders": [c.agent_index for c in active_coders],
            "pipelined": True,
        })

        # Previous code & audit summaries (iteration > 1)
        previous_codes = {}
        audit_summaries = {}
        for coder in active_coders:
            coder_iter = self.state.coder_iterations.get(coder.agent_index, 0)
            if coder_iter > 0:
                previous_codes[coder.agent_index] = self.state.code_versions.get(coder.agent_index)
                audit_summaries[coder.agent_index] = self.state.summaries.get(coder.agent_index)

        agent_timeout = self.session.agent_timeout or 300
        coder_iter_snapshot = {
            c.agent_index: self.state.coder_iterations.get(c.agent_index, 0)
            for c in active_coders
        }

        pipeline_tasks = [
            asyncio.create_task(
                self._run_coder_pipeline(
                    coder=coder,
                    previous_code=previous_codes.get(coder.agent_index),
                    audit_summary=audit_summaries.get(coder.agent_index),
                    coder_iter_snapshot=coder_iter_snapshot,
                    agent_timeout=agent_timeout,
                )
            )
            for coder in active_coders
        ]

        # Wait for all per-coder pipelines to finish.
        # КАО#R4-S2sug — actually SURFACE the exceptions (they were silently
        # discarded before): log + emit an agent_error per crashed pipeline.
        _pipeline_results = await asyncio.gather(*pipeline_tasks, return_exceptions=True)
        for _coder, _res in zip(active_coders, _pipeline_results):
            if isinstance(_res, BaseException):
                logger.error(
                    f"Coder {_coder.agent_index} pipeline crashed: {_res!r}",
                    exc_info=_res,
                )
                await self.emit_event("agent_error", {
                    "agent_type": "coder_pipeline",
                    "agent_index": _coder.agent_index,
                    "error": str(_res) or repr(_res),
                })

        logger.info(
            f"Pipelined iteration complete: {self.state.coders_completed}/{len(active_coders)} coders, "
            f"{self.state.testers_completed} testers"
        )

        # If no coders succeeded, we can't continue (same guard as old coding phase)
        if not self.state.code_versions:
            logger.error("No coders succeeded, cannot continue workflow")
            self.state.error = "All coders failed - no code generated"
            self.state.failed = True
            self.state.should_stop = True

    async def _run_coder_pipeline(
        self,
        coder: CoderAgent,
        previous_code: Optional[str],
        audit_summary: Optional[dict],
        coder_iter_snapshot: dict,
        agent_timeout: int,
    ) -> None:
        """Pipeline for one coder: coder → testers → summarizer.

        Runs concurrently with other coders' pipelines so a fast coder doesn't
        block on a slow one. Per-coder errors are isolated (handled locally,
        never propagated out).
        """
        coder_index = coder.agent_index

        # === Stage 1: coder ===
        coder_result: Any
        try:
            coder_result = await asyncio.wait_for(
                self._run_coder(
                    coder=coder,
                    previous_code=previous_code,
                    audit_summary=audit_summary,
                ),
                timeout=agent_timeout,
            )
        except asyncio.TimeoutError as e:
            coder_result = e
        except asyncio.CancelledError as e:
            coder_result = e
        except Exception as e:
            coder_result = e

        # === Stage 2: post-process coder result ===
        await self._finalize_coder_result(
            coder, coder_result, coder_iter_snapshot, agent_timeout
        )

        # If this coder didn't produce code (and no prior version), skip downstream
        code = self.state.code_versions.get(coder_index)
        if not code:
            logger.info(f"Coder {coder_index}: no code produced, skipping testers/summarizer")
            return

        # === Stage 3: testers (parallel for this coder only) ===
        # Skip if no testers configured.
        if self.testers:
            execution_result = self.state.execution_results.get(coder_index)

            await self.emit_event("phase_started", {
                "phase": "testing",
                "iteration": self.state.current_iteration,
                "coder_index": coder_index,
                "pipelined": True,
            })

            tester_tasks = []
            tester_info = []
            for tester in self.testers:
                t = asyncio.wait_for(
                    self._run_tester(
                        tester=tester,
                        code=code,
                        coder_index=coder_index,
                        execution_result=execution_result,
                    ),
                    timeout=agent_timeout,
                )
                tester_tasks.append(t)
                tester_info.append(tester.agent_index)

            tester_results = await asyncio.gather(*tester_tasks, return_exceptions=True)

            for tester_index, tres in zip(tester_info, tester_results):
                if isinstance(tres, asyncio.TimeoutError):
                    logger.error(
                        f"Tester {tester_index} timed out on coder {coder_index} after {agent_timeout}s"
                    )
                    await self.emit_event("agent_error", {
                        "agent_type": "tester",
                        "agent_index": tester_index,
                        "coder_index": coder_index,
                        "error": f"Tester timed out after {agent_timeout}s",
                    })
                elif isinstance(tres, asyncio.CancelledError):
                    logger.warning(f"Tester {tester_index} cancelled on coder {coder_index}")
                    await self.emit_event("agent_error", {
                        "agent_type": "tester",
                        "agent_index": tester_index,
                        "coder_index": coder_index,
                        "error": "Tester task was cancelled",
                    })
                elif isinstance(tres, BaseException):
                    logger.error(
                        f"Tester {tester_index} critical exception on coder {coder_index}: {tres}"
                    )
                    await self.emit_event("agent_error", {
                        "agent_type": "tester",
                        "agent_index": tester_index,
                        "coder_index": coder_index,
                        "error": f"Critical error: {type(tres).__name__}: {tres}",
                    })
                elif hasattr(tres, "success") and tres.success:
                    async with self._state_lock:
                        self.state.testers_completed += 1

        # === Stage 4: summarizer for this coder ===
        if self.summarizer:
            audits = self.state.audits.get(coder_index, [])
            if audits:
                await self.emit_event("phase_started", {
                    "phase": "summarizing",
                    "iteration": self.state.current_iteration,
                    "coder_index": coder_index,
                    "pipelined": True,
                })
                try:
                    await asyncio.wait_for(
                        self._run_summarizer(coder_index, code, audits),
                        timeout=agent_timeout,
                    )
                except asyncio.TimeoutError:
                    logger.error(
                        f"Summarizer timed out after {agent_timeout}s for coder {coder_index}"
                    )
                    await self.emit_event("agent_error", {
                        "agent_type": "summarizer",
                        "agent_index": 0,
                        "coder_index": coder_index,
                        "error": f"Summarizer timed out after {agent_timeout}s",
                    })
                except Exception as e:
                    logger.error(f"Summarizer failed for coder {coder_index}: {e}")
                    await self.emit_event("agent_error", {
                        "agent_type": "summarizer",
                        "agent_index": 0,
                        "coder_index": coder_index,
                        "error": f"Summarizer error: {type(e).__name__}: {e}",
                    })

    async def _finalize_coder_result(
        self,
        coder: CoderAgent,
        result: Any,
        coder_iter_snapshot: dict,
        agent_timeout: int,
    ) -> None:
        """Post-process one coder's result (extracted from old _run_coding_phase
        post-gather loop). Handles timeouts/exceptions/fallbacks, runs sandbox
        execution + fix-loop, and checks TDD mismatches.

        Concurrency: callers run this concurrently for different coders, so
        all per-coder state mutations target distinct dict keys. Shared
        counters (coders_completed, testers_completed) are bumped here under
        _state_lock. The success branch uses the coder_iter_snapshot to avoid
        double-counting when _run_coder already incremented internally
        (production path) vs. when _run_coder was mocked/skipped (tests, or
        any caller that bypasses _run_coder's own counter logic).
        """
        if isinstance(result, (asyncio.TimeoutError, asyncio.CancelledError)):
            is_timeout = isinstance(result, asyncio.TimeoutError)
            label = "timed out" if is_timeout else "was cancelled"
            logger.error(f"Coder {coder.agent_index} {label} after {agent_timeout}s")
            error_msg = (
                f"Coder timed out after {agent_timeout}s — try increasing Agent Timeout in Settings"
                if is_timeout else "Coder task was cancelled"
            )
            await self.emit_event("agent_error", {
                "agent_type": "coder",
                "agent_index": coder.agent_index,
                "error": error_msg,
            })
            iter_before = coder_iter_snapshot.get(coder.agent_index, 0)
            iter_now = self.state.coder_iterations.get(coder.agent_index, 0)
            if iter_now > iter_before:
                logger.info(f"Coder {coder.agent_index}: state already updated before timeout, skipping increment")
            elif coder.agent_index in self.state.code_versions:
                logger.info(f"Coder {coder.agent_index}: using previous iteration code as fallback after {label}")
                async with self._state_lock:
                    self.state.coder_iterations[coder.agent_index] = iter_before + 1
                    self.state.coders_completed += 1
            return

        if isinstance(result, Exception):
            logger.error(f"Coder {coder.agent_index} failed with exception: {result}")
            if coder.agent_index in self.state.code_versions:
                logger.info(f"Coder {coder.agent_index}: using previous iteration code as fallback")
                await self.emit_event("agent_fallback", {
                    "agent_type": "coder",
                    "agent_index": coder.agent_index,
                    "reason": str(result),
                    "fallback": "previous_code",
                })
                async with self._state_lock:
                    self.state.coder_iterations[coder.agent_index] = self.state.coder_iterations.get(coder.agent_index, 0) + 1
                    self.state.coders_completed += 1
            return

        if isinstance(result, BaseException):
            logger.error(f"Coder {coder.agent_index} failed with critical exception: {result}")
            await self.emit_event("agent_error", {
                "agent_type": "coder",
                "agent_index": coder.agent_index,
                "error": f"Critical error: {type(result).__name__}: {result}",
            })
            return

        # result is AgentResult
        if result.success:
            code = self.state.code_versions.get(coder.agent_index)
            repo_mode = self._has_repo_attachment()

            if code and not (repo_mode and result.parsed_data and result.parsed_data.get("repo_mode")):
                enable_execution = self.session.enable_code_execution
                logger.info(f"Coder {coder.agent_index}: post-pipeline sandbox, enable_execution={enable_execution}")
                if enable_execution:
                    max_fix_attempts = self.session.max_fix_attempts
                    final_code, exec_result, fix_attempts = await self._execute_and_fix_code(
                        coder=coder,
                        code=code,
                        max_attempts=max_fix_attempts,
                    )

                    self.state.execution_results[coder.agent_index] = exec_result.to_dict()
                    self.state.code_versions[coder.agent_index] = final_code

                    await self._update_code_version_content(coder.agent_index, final_code, exec_result, fix_attempts=fix_attempts)

                    # Feature #7: test-driven mode mismatch detection
                    expected = getattr(self.session, "expected_output", None)
                    if expected:
                        actual_stdout = (exec_result.stdout or "")
                        expected_norm = expected.strip()
                        actual_norm = actual_stdout.strip()
                        if expected_norm and expected_norm not in actual_norm:
                            self.state.tdd_mismatches[coder.agent_index] = {
                                "description": "Output does not match expected",
                                "severity": "critical",
                                "category": "test_driven",
                                "actual": actual_stdout[:500],
                                "expected": expected[:500],
                            }
                            logger.info(
                                f"Coder {coder.agent_index}: TDD mismatch — actual output "
                                f"does not contain expected_output (will inject critical issue)"
                            )
                            try:
                                await self.emit_event("tdd_mismatch", {
                                    "coder_index": coder.agent_index,
                                    "iteration": self.state.current_iteration,
                                })
                            except Exception:
                                pass

                # R12-BUG-01: count this coder as completed on the success
                # happy-path. _run_coder normally increments coders_completed
                # itself when it extracts code, but we guard against
                # double-counting by checking coder_iterations vs. the
                # pre-iteration snapshot: if _run_coder already bumped
                # iterations for this coder, it also bumped coders_completed,
                # so we skip. If it didn't bump (e.g. test mocks _run_coder,
                # or any future refactor moves bookkeeping fully into the
                # pipeline), we increment here to keep the counter truthful.
                iter_before = coder_iter_snapshot.get(coder.agent_index, 0)
                iter_now = self.state.coder_iterations.get(coder.agent_index, 0)
                if iter_now <= iter_before:
                    async with self._state_lock:
                        self.state.coder_iterations[coder.agent_index] = iter_before + 1
                        self.state.coders_completed += 1
        else:
            # result.success is False
            error_msg = result.error or "Unknown error"
            logger.error(f"Coder {coder.agent_index} returned error: {error_msg}")
            if coder.agent_index in self.state.code_versions:
                logger.info(f"Coder {coder.agent_index}: using previous iteration code as fallback")
                await self.emit_event("agent_fallback", {
                    "agent_type": "coder",
                    "agent_index": coder.agent_index,
                    "reason": error_msg,
                    "fallback": "previous_code",
                })
                async with self._state_lock:
                    self.state.coder_iterations[coder.agent_index] = self.state.coder_iterations.get(coder.agent_index, 0) + 1
                    self.state.coders_completed += 1

    async def _run_coding_phase(self) -> None:
        """Run parallel coding by active coders only."""
        self.state.phase = WorkflowPhase.CODING
        self.state.coders_completed = 0
        # Feature #7: clear any TDD mismatches from a previous iteration
        self.state.tdd_mismatches.clear()

        # Get only active coders (not finished)
        active_coders = self.state.get_active_coders(self.coders)

        if not active_coders:
            logger.info("No active coders to run in coding phase")
            return

        await self.emit_event("phase_started", {
            "phase": "coding",
            "iteration": self.state.current_iteration,
            "active_coders": [c.agent_index for c in active_coders],
        })

        # Get previous code and audit summaries for iteration > 1
        previous_codes = {}
        audit_summaries = {}

        for coder in active_coders:
            coder_iter = self.state.coder_iterations.get(coder.agent_index, 0)
            if coder_iter > 0:
                previous_codes[coder.agent_index] = self.state.code_versions.get(coder.agent_index)
                audit_summaries[coder.agent_index] = self.state.summaries.get(coder.agent_index)

        # Run active coders in parallel (with per-coder timeout)
        agent_timeout = self.session.agent_timeout or 300
        tasks = []
        for coder in active_coders:
            previous_code = previous_codes.get(coder.agent_index)
            audit_summary = audit_summaries.get(coder.agent_index)

            task = asyncio.wait_for(
                self._run_coder(
                    coder=coder,
                    previous_code=previous_code,
                    audit_summary=audit_summary,
                ),
                timeout=agent_timeout,
            )
            tasks.append(task)

        # Snapshot coder_iterations before gather so post-gather timeout handler
        # can detect if _run_coder already incremented (avoid double-counting).
        coder_iter_snapshot = {c.agent_index: self.state.coder_iterations.get(c.agent_index, 0) for c in active_coders}

        logger.info(f"Waiting for {len(tasks)} coders via gather (timeout={agent_timeout}s each)")
        results = await asyncio.gather(*tasks, return_exceptions=True)
        logger.info(f"Gather returned {len(results)} results: {[type(r).__name__ for r in results]}")

        # Process results.
        # _run_coder already handled: code extraction, state updates, DB save,
        # and event emission for successful results.
        # Post-gather handles: exceptions/timeouts, sandbox execution, and
        # fallback for failed API results.
        for i, (coder, result) in enumerate(zip(active_coders, results)):
            logger.info(f"Processing coder {coder.agent_index} result (#{i}): type={type(result).__name__}, is_exc={isinstance(result, BaseException)}")

            if isinstance(result, (asyncio.TimeoutError, asyncio.CancelledError)):
                # Timeout or cancellation from asyncio.wait_for.
                # _run_coder may have already partially updated state before being
                # cancelled, so check whether it already incremented coder_iterations
                # to avoid double-counting.
                is_timeout = isinstance(result, asyncio.TimeoutError)
                label = "timed out" if is_timeout else "was cancelled"
                logger.error(f"Coder {coder.agent_index} {label} after {agent_timeout}s")

                error_msg = (
                    f"Coder timed out after {agent_timeout}s — try increasing Agent Timeout in Settings"
                    if is_timeout else "Coder task was cancelled"
                )
                await self.emit_event("agent_error", {
                    "agent_type": "coder",
                    "agent_index": coder.agent_index,
                    "error": error_msg,
                })

                # Check if _run_coder already incremented coder_iterations before
                # being cancelled (avoid double-counting).
                iter_before = coder_iter_snapshot.get(coder.agent_index, 0)
                iter_now = self.state.coder_iterations.get(coder.agent_index, 0)
                if iter_now > iter_before:
                    # _run_coder already incremented — don't double-count
                    logger.info(f"Coder {coder.agent_index}: state already updated before timeout, skipping increment")
                elif coder.agent_index in self.state.code_versions:
                    logger.info(f"Coder {coder.agent_index}: using previous iteration code as fallback after {label}")
                    self.state.coder_iterations[coder.agent_index] = iter_before + 1
                    self.state.coders_completed += 1

            elif isinstance(result, Exception):
                logger.error(f"Coder {coder.agent_index} failed with exception: {result}")
                if coder.agent_index in self.state.code_versions:
                    logger.info(f"Coder {coder.agent_index}: using previous iteration code as fallback")
                    await self.emit_event("agent_fallback", {
                        "agent_type": "coder",
                        "agent_index": coder.agent_index,
                        "reason": str(result),
                        "fallback": "previous_code",
                    })
                    self.state.coder_iterations[coder.agent_index] = self.state.coder_iterations.get(coder.agent_index, 0) + 1
                    self.state.coders_completed += 1

            elif isinstance(result, BaseException):
                logger.error(f"Coder {coder.agent_index} failed with critical exception: {result}")
                await self.emit_event("agent_error", {
                    "agent_type": "coder",
                    "agent_index": coder.agent_index,
                    "error": f"Critical error: {type(result).__name__}: {result}",
                })

            elif result.success:
                # Code extraction, state updates, and DB save already happened in _run_coder.
                # Here we only run sandbox execution if enabled.
                code = self.state.code_versions.get(coder.agent_index)
                repo_mode = self._has_repo_attachment()

                if code and not (repo_mode and result.parsed_data and result.parsed_data.get("repo_mode")):
                    enable_execution = self.session.enable_code_execution
                    logger.info(f"Coder {coder.agent_index}: post-gather sandbox, enable_execution={enable_execution}")
                    if enable_execution:
                        max_fix_attempts = self.session.max_fix_attempts
                        final_code, exec_result, fix_attempts = await self._execute_and_fix_code(
                            coder=coder,
                            code=code,
                            max_attempts=max_fix_attempts,
                        )

                        # Update state with sandbox-fixed code
                        self.state.execution_results[coder.agent_index] = exec_result.to_dict()
                        self.state.code_versions[coder.agent_index] = final_code

                        # Update DB code_version with the fixed code and save execution result
                        await self._update_code_version_content(coder.agent_index, final_code, exec_result, fix_attempts=fix_attempts)

                        # Feature #7: test-driven mode.
                        # If session.expected_output is set, compare actual stdout to it.
                        # On mismatch, record a synthetic critical issue that will be
                        # appended to the summary so the coder fixes it next iteration.
                        expected = getattr(self.session, "expected_output", None)
                        if expected:
                            actual_stdout = (exec_result.stdout or "")
                            expected_norm = expected.strip()
                            actual_norm = actual_stdout.strip()
                            if expected_norm and expected_norm not in actual_norm:
                                self.state.tdd_mismatches[coder.agent_index] = {
                                    "description": "Output does not match expected",
                                    "severity": "critical",
                                    "category": "test_driven",
                                    "actual": actual_stdout[:500],
                                    "expected": expected[:500],
                                }
                                logger.info(
                                    f"Coder {coder.agent_index}: TDD mismatch — actual output "
                                    f"does not contain expected_output (will inject critical issue)"
                                )
                                try:
                                    await self.emit_event("tdd_mismatch", {
                                        "coder_index": coder.agent_index,
                                        "iteration": self.state.current_iteration,
                                    })
                                except Exception:
                                    pass

            else:
                # result.success is False — API returned error.
                # _run_coder already emitted agent_error for this case.
                # Here we only handle fallback to previous code if available.
                error_msg = result.error or "Unknown error"
                logger.error(f"Coder {coder.agent_index} returned error: {error_msg}")

                if coder.agent_index in self.state.code_versions:
                    logger.info(f"Coder {coder.agent_index}: using previous iteration code as fallback")
                    await self.emit_event("agent_fallback", {
                        "agent_type": "coder",
                        "agent_index": coder.agent_index,
                        "reason": error_msg,
                        "fallback": "previous_code",
                    })
                    self.state.coder_iterations[coder.agent_index] = self.state.coder_iterations.get(coder.agent_index, 0) + 1
                    self.state.coders_completed += 1

        logger.info(f"Coding phase complete: {self.state.coders_completed}/{len(self.coders)} coders succeeded")

        # If no coders succeeded, we can't continue
        if not self.state.code_versions:
            logger.error("No coders succeeded, cannot continue workflow")
            self.state.error = "All coders failed - no code generated"
            self.state.failed = True
            self.state.should_stop = True

    # Retry configuration for overloaded APIs (orchestrator level)
    ORCHESTRATOR_RETRY_DELAYS = [15, 30, 60]  # Wait longer at orchestrator level
    # Retry configuration for tester agents (separate from orchestrator-level retries)
    TESTER_RETRY_DELAYS = [15, 30, 60]

    async def _run_coder(
        self,
        coder: CoderAgent,
        previous_code: Optional[str],
        audit_summary: Optional[dict],
    ) -> AgentResult:
        """Run a single coder with retry logic for overloaded errors."""
        logger.info(f"Starting coder {coder.agent_index} with provider={coder.provider}, model={coder.model}")

        repo_mode = self._has_repo_attachment()

        await self.emit_event("agent_started", {
            "agent_type": "coder",
            "agent_index": coder.agent_index,
            "iteration": self.state.current_iteration,
            "repo_mode": repo_mode,
        })

        # Get any user interventions (with lock for DB access)
        async with self._db_lock:
            interventions = await self._get_interventions_for_coder(coder.agent_index)
        intervention_text = "\n".join([f"- {i['type']}: {i['content']}" for i in interventions]) if interventions else None

        # For repo mode iteration > 1, get previous file modifications
        previous_files = None
        if repo_mode and self.state.current_iteration > 1:
            repo_data = self.state.repo_file_versions.get(coder.agent_index)
            if repo_data:
                previous_files = {**repo_data.get("modified_files", {}), **repo_data.get("new_files", {})}

        # Adaptive temperature & max_tokens based on iteration:
        # - Iteration 1: exploratory (configured temp, large max_tokens for initial gen)
        # - Iteration 2: more focused (0.5)
        # - Iteration 3+: conservative for fixes (0.3)
        # Lower temps reduce regressions where coders re-introduce old bugs.
        # Smaller max_tokens for iter 2+ since fixes are smaller than initial gen.
        iteration = self.state.current_iteration
        if iteration <= 1:
            temperature_override: Optional[float] = None  # use configured default
            max_tokens_override: Optional[int] = None     # keep large default (>=64K)
        elif iteration == 2:
            temperature_override = 0.5
            max_tokens_override = 32768
        else:
            temperature_override = 0.3
            max_tokens_override = 32768

        # If previous iteration's sandbox execution failed, surface that to the coder
        # so the next attempt has the actual error context (not just the audit summary).
        execution_error: Optional[dict] = None
        if iteration > 1:
            prev_exec = self.state.execution_results.get(coder.agent_index)
            if prev_exec and prev_exec.get("exit_code", 0) != 0:
                execution_error = {
                    "exit_code": prev_exec.get("exit_code"),
                    "stdout": prev_exec.get("stdout") or "",
                    "stderr": prev_exec.get("stderr") or "",
                    "timeout_exceeded": prev_exec.get("timeout_exceeded", False),
                }

        # Streaming: enabled per-session via settings.streaming.
        # When on, the coder uses the provider's streaming API and emits
        # `agent_streaming` WebSocket events for each text delta so the UI
        # can render code as it's generated. A final event with
        # is_final=True is emitted after the full response is assembled.
        # КАО#R5 — Default ON (see _resolve_streaming_enabled): streaming is
        # used unless settings.streaming is explicitly false.
        streaming_enabled = self._resolve_streaming_enabled(self.session.settings)

        async def _on_stream_chunk(chunk: str) -> None:
            try:
                await self.emit_event("agent_streaming", {
                    "agent_type": "coder",
                    "agent_index": coder.agent_index,
                    "iteration": self.state.current_iteration,
                    "partial_content": chunk,
                    "is_final": False,
                })
            except Exception as cb_err:  # noqa: BLE001
                # Streaming events are best-effort — never fail the LLM call.
                logger.warning(f"agent_streaming emit failed: {cb_err}")

        # Retry loop for overloaded errors
        last_result = None
        for attempt in range(len(self.ORCHESTRATOR_RETRY_DELAYS) + 1):
            try:
                result = await coder.execute(
                    specification=self.get_full_specification(),
                    language=self.session.language,
                    previous_code=previous_code,
                    iteration=self.state.current_iteration,
                    initial_code=self.session.initial_code,
                    initial_docs=self.session.initial_docs,
                    audit_summary=audit_summary,
                    intervention=intervention_text,
                    repo_mode=repo_mode,
                    previous_files=previous_files,
                    execution_error=execution_error,
                    temperature_override=temperature_override,
                    max_tokens_override=max_tokens_override,
                    enable_streaming=streaming_enabled,
                    on_stream_chunk=_on_stream_chunk if streaming_enabled else None,
                )
                logger.info(f"Coder {coder.agent_index} result: success={result.success}, error={result.error}")

                # Check if this is a retryable overloaded error
                if not result.success and result.error:
                    is_overloaded = self._is_retryable_overload_error(result.error)

                    if is_overloaded and attempt < len(self.ORCHESTRATOR_RETRY_DELAYS):
                        delay = self.ORCHESTRATOR_RETRY_DELAYS[attempt]
                        logger.warning(
                            f"Coder {coder.agent_index} got overloaded error, "
                            f"orchestrator retry {attempt + 1}/{len(self.ORCHESTRATOR_RETRY_DELAYS)} in {delay}s"
                        )
                        await self.emit_event("agent_retry", {
                            "agent_type": "coder",
                            "agent_index": coder.agent_index,
                            "attempt": attempt + 1,
                            "max_attempts": len(self.ORCHESTRATOR_RETRY_DELAYS),
                            "delay": delay,
                            "reason": "API overloaded",
                        })
                        await asyncio.sleep(delay)
                        last_result = result
                        continue

                # Success or non-retryable error
                last_result = result
                break

            except Exception as e:
                logger.exception(f"Coder {coder.agent_index} raised exception: {e}")

                # Check if exception is retryable
                is_overloaded = self._is_retryable_overload_error(e)

                if is_overloaded and attempt < len(self.ORCHESTRATOR_RETRY_DELAYS):
                    delay = self.ORCHESTRATOR_RETRY_DELAYS[attempt]
                    logger.warning(
                        f"Coder {coder.agent_index} exception (overloaded), "
                        f"orchestrator retry {attempt + 1}/{len(self.ORCHESTRATOR_RETRY_DELAYS)} in {delay}s"
                    )
                    await asyncio.sleep(delay)
                    continue

                await self.emit_event("agent_error", {
                    "agent_type": "coder",
                    "agent_index": coder.agent_index,
                    "error": str(e),
                })
                raise

        result = last_result

        # Safety check: if all retries exhausted via exceptions, last_result may be None
        if result is None:
            raise RuntimeError(f"Coder {coder.agent_index}: all retry attempts exhausted with no result")

        # Update metrics (lock protects concurrent access from parallel agents)
        async with self._db_lock:
            self.state.total_tokens += result.input_tokens + result.output_tokens
            self.state.total_cost += result.cost_usd

        # Save LLM request (with lock for DB access)
        async with self._db_lock:
            await self._save_llm_request(
                agent_type=AgentType.CODER,
                agent_index=coder.agent_index,
                result=result,
                provider=coder.provider,
                model=coder.model,
            )

        # For successful results, extract code and save to DB BEFORE emitting
        # agent_completed so the UI can fetch code immediately.
        if result.success:
            import re as _re

            repo_mode = self._has_repo_attachment()
            code = None

            # Handle repo mode - multi-file output
            if repo_mode and result.parsed_data and result.parsed_data.get("repo_mode"):
                parsed = result.parsed_data
                async with self._db_lock:
                    self.state.repo_file_versions[coder.agent_index] = {
                        "modified_files": parsed.get("modified_files", {}),
                        "new_files": parsed.get("new_files", {}),
                        "deleted_files": parsed.get("deleted_files", []),
                        "change_summary": parsed.get("change_summary", ""),
                    }
                    # Store concatenated code for backward compat (testers, summarizer)
                    code = parsed.get("code", "")
                    self.state.code_versions[coder.agent_index] = code

                    # Log file counts for debugging
                    logger.info(
                        f"Coder {coder.agent_index} (repo mode): "
                        f"{len(parsed.get('modified_files', {}))} modified, "
                        f"{len(parsed.get('new_files', {}))} new, "
                        f"{len(parsed.get('deleted_files', []))} deleted"
                    )

                    # Skip execution for repo mode (multi-file projects can't be run in sandbox)
                    self.state.coders_completed += 1
                    self.state.coder_iterations[coder.agent_index] = self.state.coder_iterations.get(coder.agent_index, 0) + 1

                await self._save_code_version(coder.agent_index, result)
            else:
                # Standard single-file mode
                # Use parsed code if available, otherwise fallback to raw content
                if result.parsed_data and result.parsed_data.get("code"):
                    code = result.parsed_data["code"]
                else:
                    # Fallback to raw content - strip markdown sections
                    logger.warning(f"Coder {coder.agent_index}: No parsed code, attempting to extract from raw content")
                    raw = result.content

                    # Try to extract everything after ### CODE header
                    # ACCEPTED RISK: This regex-based extraction can be tricked by
                    # LLM output containing misleading ### CODE markers.  A robust
                    # fix requires prompt-level changes; see BUG #28 audit note.
                    code_section = _re.search(
                        r"###\s*CODE\s*\n\s*(?:```\w*\n)?(.*)",
                        raw, _re.DOTALL | _re.IGNORECASE
                    )
                    if code_section:
                        code = code_section.group(1).strip()
                        # Remove trailing markdown artifacts
                        code = _re.sub(r"\n###\s+.*$", "", code, flags=_re.DOTALL)
                        code = _re.sub(r"```\s*$", "", code).strip()
                    else:
                        # Last resort: strip all ### headers and take what remains
                        lines = raw.split("\n")
                        code_lines = []
                        in_code = False
                        for line in lines:
                            if _re.match(r"^###\s+CODE", line, _re.IGNORECASE):
                                in_code = True
                                continue
                            if _re.match(r"^###\s+", line) and in_code:
                                break  # Hit next section
                            if in_code:
                                code_lines.append(line)
                            elif not _re.match(r"^###\s+", line):
                                code_lines.append(line)
                        code = "\n".join(code_lines).strip()

                    if not code:
                        code = raw
                        logger.warning(f"Coder {coder.agent_index}: Could not extract code, using full raw content")

                # Guard: if code is empty after extraction, treat as error
                if not code or not code.strip():
                    logger.warning(
                        f"Coder {coder.agent_index}: extracted code is empty "
                        f"(output_tokens={result.output_tokens}, "
                        f"thinking_tokens={getattr(result, 'thinking_tokens', 0)}, "
                        f"stop_reason={getattr(result, 'stop_reason', 'N/A')}, "
                        f"content_len={len(result.content)}), treating as error"
                    )
                    if coder.agent_index in self.state.code_versions:
                        logger.info(f"Coder {coder.agent_index}: using previous iteration code as fallback")
                        await self.emit_event("agent_fallback", {
                            "agent_type": "coder",
                            "agent_index": coder.agent_index,
                            "reason": "Empty code extracted (response may have been truncated)",
                            "fallback": "previous_code",
                        })
                        async with self._db_lock:
                            self.state.coder_iterations[coder.agent_index] = self.state.coder_iterations.get(coder.agent_index, 0) + 1
                            self.state.coders_completed += 1
                    else:
                        await self.emit_event("agent_error", {
                            "agent_type": "coder",
                            "agent_index": coder.agent_index,
                            "error": "Empty code extracted (response may have been truncated)",
                            "detail": "No code produced and no previous version available",
                        })
                else:
                    # Code extracted successfully - save to state and DB
                    logger.info(f"Coder {coder.agent_index}: code extracted ({len(code)} chars)")
                    async with self._db_lock:
                        self.state.code_versions[coder.agent_index] = code
                        self.state.coders_completed += 1
                        self.state.coder_iterations[coder.agent_index] = self.state.coder_iterations.get(coder.agent_index, 0) + 1

                    # Save to database
                    await self._save_code_version(coder.agent_index, result)

            # Streaming: emit terminating chunk so the UI knows the stream
            # is complete. No-op when streaming was not enabled.
            if streaming_enabled:
                try:
                    await self.emit_event("agent_streaming", {
                        "agent_type": "coder",
                        "agent_index": coder.agent_index,
                        "iteration": self.state.current_iteration,
                        "partial_content": "",
                        "is_final": True,
                    })
                except Exception as cb_err:  # noqa: BLE001
                    logger.warning(f"agent_streaming final emit failed: {cb_err}")

            # Emit completion event AFTER code is saved to DB
            await self.emit_event("agent_completed", {
                "agent_type": "coder",
                "agent_index": coder.agent_index,
                "iteration": self.state.current_iteration,
                "tokens": result.input_tokens + result.output_tokens,
                "cost": result.cost_usd,
            })
        else:
            await self.emit_event("agent_error", {
                "agent_type": "coder",
                "agent_index": coder.agent_index,
                "error": result.error or "Unknown error",
            })

        return result

    async def _execute_and_fix_code(
        self,
        coder: CoderAgent,
        code: str,
        max_attempts: int = 3,
    ) -> tuple[str, ExecutionResult, int]:
        """
        Execute code and attempt to fix it if execution fails.

        Returns:
            Tuple of (final_code, execution_result)
        """
        sandbox = get_sandbox_client()

        # Get execution settings from session
        timeout = self.session.execution_timeout
        auto_install = self.session.auto_install_deps

        current_code = code

        for attempt in range(max_attempts):
            # Emit execution started event
            await self.emit_event("code_execution_started", {
                "coder_index": coder.agent_index,
                "attempt": attempt + 1,
                "max_attempts": max_attempts,
            })

            # Execute code
            exec_result = await sandbox.execute(
                code=current_code,
                language=self.session.language,
                timeout=timeout,
                auto_install_deps=auto_install,
            )

            logger.info(
                f"Coder {coder.agent_index} execution attempt {attempt + 1}: "
                f"success={exec_result.success}, exit_code={exec_result.exit_code}"
            )

            # Emit execution result event
            await self.emit_event("code_execution_completed", {
                "coder_index": coder.agent_index,
                "attempt": attempt + 1,
                "success": exec_result.success,
                "exit_code": exec_result.exit_code,
                "execution_time_ms": exec_result.execution_time_ms,
                "timeout_exceeded": exec_result.timeout_exceeded,
            })

            # If execution succeeded, we're done
            if exec_result.success:
                # VR-47 — attempt is 0-based; +1 = runs performed to reach clean.
                return current_code, exec_result, attempt + 1

            # If this was the last attempt, return with failure
            if attempt >= max_attempts - 1:
                logger.warning(
                    f"Coder {coder.agent_index} code execution failed after {max_attempts} attempts"
                )
                # VR-47 — exhausted the fix limit; attempts used == max_attempts.
                return current_code, exec_result, attempt + 1

            # Emit fixing event
            await self.emit_event("code_fixing_started", {
                "coder_index": coder.agent_index,
                "attempt": attempt + 1,
                "error": exec_result.stderr[:500] if exec_result.stderr else exec_result.error,
            })

            # Try to fix the code
            fix_result = await coder.fix_execution_error(
                specification=self.get_full_specification(),
                code=current_code,
                language=self.session.language,
                exit_code=exec_result.exit_code,
                stdout=exec_result.stdout,
                stderr=exec_result.stderr,
                timeout_exceeded=exec_result.timeout_exceeded,
                timeout=timeout,
                attempt=attempt + 1,
                max_attempts=max_attempts,
            )

            # Update metrics (lock protects concurrent access)
            async with self._db_lock:
                self.state.total_tokens += fix_result.input_tokens + fix_result.output_tokens
                self.state.total_cost += fix_result.cost_usd
                # КАО#R4-M10 — persist the sandbox fix-loop call to LLMRequest;
                # previously these calls were invisible to metrics/llm_requests
                # and FinalResult totals shrank after a VR resume / re-finalize.
                await self._save_llm_request(
                    agent_type=AgentType.CODER,
                    agent_index=coder.agent_index,
                    result=fix_result,
                    provider=coder.provider,
                    model=coder.model,
                )

            if fix_result.success and fix_result.parsed_data and fix_result.parsed_data.get("code"):
                current_code = fix_result.parsed_data["code"]

                await self.emit_event("code_fixing_completed", {
                    "coder_index": coder.agent_index,
                    "attempt": attempt + 1,
                    "fix_description": fix_result.parsed_data.get("fix_description", ""),
                })
            else:
                # Fix failed, log and continue to next attempt anyway
                logger.warning(
                    f"Coder {coder.agent_index} fix attempt {attempt + 1} failed: "
                    f"{fix_result.error or 'No code in response'}"
                )
                await self.emit_event("code_fixing_failed", {
                    "coder_index": coder.agent_index,
                    "attempt": attempt + 1,
                    "error": fix_result.error or "No fixed code returned",
                })

        # This shouldn't be reached, but return current state
        return current_code, exec_result, max_attempts

    async def _update_code_version_content(
        self,
        coder_index: int,
        fixed_code: str,
        exec_result: ExecutionResult,
        fix_attempts: int = 0,
    ) -> None:
        """Update existing code_version with sandbox-fixed code and save execution result.

        Called after sandbox execution modifies the code.  Updates the existing
        DB record (created by _save_code_version in _run_coder) instead of
        creating a duplicate.
        """
        from sqlalchemy import select as sa_select

        async with self._db_lock:
            try:
                # Find the existing code_version for this coder/iteration
                stmt = (
                    sa_select(CodeVersion)
                    .where(
                        CodeVersion.session_id == self.session.id,
                        CodeVersion.coder_index == coder_index,
                        CodeVersion.iteration == self.state.current_iteration,
                    )
                    .order_by(CodeVersion.id.desc())
                    .limit(1)
                )
                result = await self.db.execute(stmt)
                cv = result.scalar_one_or_none()

                if cv:
                    # Update code content with sandbox-fixed version
                    cv.code_content = fixed_code
                    cv.status = CodeVersionStatus.TESTED if exec_result.success else CodeVersionStatus.GENERATED
                    # VR-47 — persist run→fix attempt count for the Coder node badge.
                    cv.fix_attempts = fix_attempts

                    # Save execution result linked to this code_version
                    execution = CodeExecution(
                        code_version_id=cv.id,
                        executor_type="sandbox",
                        exit_code=exec_result.exit_code,
                        stdout=exec_result.stdout[:50000] if exec_result.stdout else None,
                        stderr=exec_result.stderr[:50000] if exec_result.stderr else None,
                        execution_time_ms=exec_result.execution_time_ms,
                        memory_used_mb=exec_result.memory_used_mb,
                    )
                    self.db.add(execution)
                    await self.db.commit()
                    logger.info(f"Updated code_version {cv.id} with sandbox-fixed code ({len(fixed_code)} chars)")
                else:
                    logger.warning(f"No code_version found for coder {coder_index} iter {self.state.current_iteration} to update")
            except Exception as e:
                logger.error(f"Failed to update code_version after sandbox for coder {coder_index}: {e}")
                await self.db.rollback()
                try:
                    await self.db.refresh(self.session)
                except Exception:
                    pass

    async def _save_execution_result(
        self,
        coder_index: int,
        code_version_id: str,
        exec_result: ExecutionResult,
    ) -> None:
        """Save code execution result to database."""
        async with self._db_lock:
            try:
                execution = CodeExecution(
                    code_version_id=code_version_id,
                    executor_type="sandbox",
                    exit_code=exec_result.exit_code,
                    stdout=exec_result.stdout[:50000] if exec_result.stdout else None,
                    stderr=exec_result.stderr[:50000] if exec_result.stderr else None,
                    execution_time_ms=exec_result.execution_time_ms,
                    memory_used_mb=exec_result.memory_used_mb,
                )
                self.db.add(execution)
                await self.db.commit()
            except Exception as e:
                logger.error(f"Failed to save execution result for coder {coder_index}: {e}")
                await self.db.rollback()
                try:
                    await self.db.refresh(self.session)
                except Exception:
                    pass

    async def _run_testing_phase(self) -> None:
        """Run parallel testing of active coders' code versions only."""
        self.state.phase = WorkflowPhase.TESTING
        self.state.testers_completed = 0

        # Get active coder indices
        active_coder_indices = {c.agent_index for c in self.state.get_active_coders(self.coders)}

        if not active_coder_indices:
            logger.info("No active coders to test in testing phase")
            return

        # Clear audits only for active coders
        for coder_index in active_coder_indices:
            self.state.audits[coder_index] = []

        await self.emit_event("phase_started", {
            "phase": "testing",
            "iteration": self.state.current_iteration,
            "active_coders": list(active_coder_indices),
        })

        # Each tester tests each active coder's code version
        tasks = []
        task_info = []  # Track (tester_index, coder_index) for each task

        agent_timeout = self.session.agent_timeout or 300
        for coder_index in active_coder_indices:
            code = self.state.code_versions.get(coder_index)
            if not code:
                logger.warning(f"No code version for active coder {coder_index}")
                continue

            # Get execution result for this coder
            execution_result = self.state.execution_results.get(coder_index)

            for tester in self.testers:
                task = asyncio.wait_for(
                    self._run_tester(
                        tester=tester,
                        code=code,
                        coder_index=coder_index,
                        execution_result=execution_result,
                    ),
                    timeout=agent_timeout,
                )
                tasks.append(task)
                task_info.append((tester.agent_index, coder_index))

        results = await asyncio.gather(*tasks, return_exceptions=True)

        # Process results — audit saves and state updates now happen inside _run_tester
        # in parallel. This loop only handles timeout/cancellation errors.
        for (tester_index, coder_index), result in zip(task_info, results):
            if isinstance(result, asyncio.TimeoutError):
                logger.error(f"Tester {tester_index} timed out on coder {coder_index} after {agent_timeout}s")
                await self.emit_event("agent_error", {
                    "agent_type": "tester",
                    "agent_index": tester_index,
                    "error": f"Tester timed out after {agent_timeout}s",
                })
            elif isinstance(result, asyncio.CancelledError):
                logger.warning(f"Tester {tester_index} was cancelled on coder {coder_index}")
                await self.emit_event("agent_error", {
                    "agent_type": "tester",
                    "agent_index": tester_index,
                    "error": "Tester task was cancelled",
                })
            elif isinstance(result, BaseException):
                logger.error(f"Tester {tester_index} failed with critical exception on coder {coder_index}: {result}")
                await self.emit_event("agent_error", {
                    "agent_type": "tester",
                    "agent_index": tester_index,
                    "error": f"Critical error: {type(result).__name__}: {result}",
                })
            elif isinstance(result, Exception):
                logger.error(f"Tester {tester_index} failed on coder {coder_index}: {result}")
                # Error event already emitted in _run_tester

        self.state.testers_completed = len([r for r in results if not isinstance(r, BaseException) and hasattr(r, 'success') and r.success])
        logger.info(f"Testing phase complete: {self.state.testers_completed} audit(s) completed")

    async def _run_tester(
        self,
        tester: TesterAgent,
        code: str,
        coder_index: int,
        execution_result: Optional[dict] = None,
    ) -> AgentResult:
        """Run a single tester with retry logic for overloaded errors."""
        await self.emit_event("agent_started", {
            "agent_type": "tester",
            "agent_index": tester.agent_index,
            "coder_index": coder_index,
            "iteration": self.state.current_iteration,
        })

        # Execute code if enabled - tester runs code independently to verify it works.
        # Browser languages (javascript_browser, typescript_browser, html) are
        # automatically routed to headless Chromium validation by SandboxClient.
        enable_execution = self.session.enable_code_execution
        tester_execution_result = None

        if enable_execution:
            await self.emit_event("tester_executing_code", {
                "tester_index": tester.agent_index,
                "coder_index": coder_index,
            })

            sandbox = get_sandbox_client()
            timeout = self.session.execution_timeout
            auto_install = self.session.auto_install_deps

            exec_result = await sandbox.execute(
                code=code,
                language=self.session.language,
                timeout=timeout,
                auto_install_deps=auto_install,
            )

            tester_execution_result = exec_result.to_dict()

            logger.info(
                f"Tester {tester.agent_index} executed coder {coder_index}'s code: "
                f"success={exec_result.success}, exit_code={exec_result.exit_code}"
            )

            await self.emit_event("tester_execution_completed", {
                "tester_index": tester.agent_index,
                "coder_index": coder_index,
                "success": exec_result.success,
                "exit_code": exec_result.exit_code,
                "execution_time_ms": exec_result.execution_time_ms,
            })

        # Use tester's own execution result, fallback to coder's result
        final_execution_result = tester_execution_result or execution_result

        # Get coder's previous rejections if any (with lock for DB access)
        coder_rejections = None
        if self.state.current_iteration > 1:
            async with self._db_lock:
                coder_rejections = await self._get_coder_rejections(coder_index)

        # Retry loop for overloaded errors (shorter delays for testers)
        tester_retry_delays = self.TESTER_RETRY_DELAYS
        last_result = None

        for attempt in range(len(tester_retry_delays) + 1):
            try:
                result = await tester.execute(
                    specification=self.get_full_specification(),
                    code=code,
                    language=self.session.language,
                    coder_index=coder_index,
                    iteration=self.state.current_iteration,
                    initial_docs=self.session.initial_docs,
                    coder_rejections=coder_rejections,
                    execution_result=final_execution_result,
                )

                # Check if this is a retryable overloaded error
                if not result.success and result.error:
                    is_overloaded = self._is_retryable_overload_error(result.error)

                    if is_overloaded and attempt < len(tester_retry_delays):
                        delay = tester_retry_delays[attempt]
                        logger.warning(
                            f"Tester {tester.agent_index} got overloaded error on coder {coder_index}, "
                            f"retry {attempt + 1}/{len(tester_retry_delays)} in {delay}s"
                        )
                        await asyncio.sleep(delay)
                        last_result = result
                        continue

                last_result = result
                break

            except Exception as e:
                is_overloaded = self._is_retryable_overload_error(e)

                if is_overloaded and attempt < len(tester_retry_delays):
                    delay = tester_retry_delays[attempt]
                    logger.warning(
                        f"Tester {tester.agent_index} exception (overloaded), "
                        f"retry {attempt + 1}/{len(tester_retry_delays)} in {delay}s"
                    )
                    await asyncio.sleep(delay)
                    continue

                # Non-retryable exception
                raise

        result = last_result

        # Safety check: if all retries exhausted via exceptions, last_result may be None
        if result is None:
            raise RuntimeError(f"Tester {tester.agent_index}: all retry attempts exhausted with no result")

        # Update metrics + save LLM request + audit state in a SINGLE lock
        # acquisition to reduce contention between parallel tester tasks.
        # (Previously 3 separate lock acquisitions per tester.)
        tester_model = tester.model
        async with self._db_lock:
            self.state.total_tokens += result.input_tokens + result.output_tokens
            self.state.total_cost += result.cost_usd

            await self._save_llm_request(
                agent_type=AgentType.TESTER,
                agent_index=tester.agent_index,
                result=result,
                provider=tester.provider,
                model=tester.model,
            )

            # Append audit to in-memory state (DB save below, outside lock)
            if result.success and result.parsed_data:
                self.state.audits[coder_index].append({
                    "tester_index": tester.agent_index,
                    "audit_content": result.content,
                    "llm_model": tester_model,
                    **result.parsed_data,
                })

        # Save audit DB record INSIDE _run_tester (parallel) instead of
        # sequentially in the post-gather results loop — eliminates the delay
        # between testers finishing and summarizer starting.
        if result.success and result.parsed_data:
            await self._save_audit(coder_index, tester.agent_index, result)

            # Emit completion event IMMEDIATELY when this tester finishes
            await self.emit_event("agent_completed", {
                "agent_type": "tester",
                "agent_index": tester.agent_index,
                "coder_index": coder_index,
                "iteration": self.state.current_iteration,
                "issues_found": len(result.parsed_data.get("issues", [])),
            })
        elif not result.success:
            await self.emit_event("agent_error", {
                "agent_type": "tester",
                "agent_index": tester.agent_index,
                "coder_index": coder_index,
                "error": result.error or "Unknown error",
            })

        return result

    async def _run_summarizing_phase(self) -> None:
        """Run summarizer for each active coder's audits."""
        self.state.phase = WorkflowPhase.SUMMARIZING

        if not self.summarizer:
            logger.warning("No summarizer configured, skipping summarization")
            return

        # Get active coder indices
        active_coder_indices = {c.agent_index for c in self.state.get_active_coders(self.coders)}

        if not active_coder_indices:
            logger.info("No active coders to summarize in summarizing phase")
            return

        await self.emit_event("phase_started", {
            "phase": "summarizing",
            "iteration": self.state.current_iteration,
            "active_coders": list(active_coder_indices),
        })

        # Run summarizer for all active coders in PARALLEL (like testers).
        # Previously sequential — each coder waited for the previous one's
        # LLM call, causing unnecessary delay with multiple coders.
        agent_timeout = self.session.agent_timeout or 300
        tasks = []
        task_coders = []

        for coder_index in active_coder_indices:
            code = self.state.code_versions.get(coder_index)
            audits = self.state.audits.get(coder_index, [])
            if not code or not audits:
                continue

            task = asyncio.wait_for(
                self._run_summarizer(coder_index, code, audits),
                timeout=agent_timeout,
            )
            tasks.append(task)
            task_coders.append(coder_index)

        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)

            for coder_index, result in zip(task_coders, results):
                if isinstance(result, asyncio.TimeoutError):
                    logger.error(f"Summarizer timed out after {agent_timeout}s for coder {coder_index}")
                    await self.emit_event("agent_error", {
                        "agent_type": "summarizer",
                        "agent_index": 0,
                        "coder_index": coder_index,
                        "error": f"Summarizer timed out after {agent_timeout}s",
                    })
                elif isinstance(result, BaseException):
                    logger.error(f"Summarizer failed for coder {coder_index}: {result}")
                    await self.emit_event("agent_error", {
                        "agent_type": "summarizer",
                        "agent_index": 0,
                        "coder_index": coder_index,
                        "error": f"Summarizer error: {type(result).__name__}: {result}",
                    })

        logger.info(f"Summarizing phase complete for {len(active_coder_indices)} active coders")

    async def _run_summarizer(self, coder_index: int, code: str, audits: list) -> AgentResult:
        """Run summarizer for a single coder (designed to run in parallel via gather)."""
        await self.emit_event("agent_started", {
            "agent_type": "summarizer",
            "coder_index": coder_index,
            "iteration": self.state.current_iteration,
        })

        # Retry loop for overloaded errors (same pattern as testers)
        retry_delays = [15, 30, 60]
        last_result = None

        for attempt in range(len(retry_delays) + 1):
            try:
                result = await self.summarizer.execute(
                    specification=self.get_full_specification(),
                    code=code,
                    audits=audits,
                    language=self.session.language,
                    coder_index=coder_index,
                    iteration=self.state.coder_iterations.get(coder_index, self.state.current_iteration),
                )

                # Check if this is a retryable overloaded error
                if not result.success and result.error:
                    is_overloaded = self._is_retryable_overload_error(result.error)

                    if is_overloaded and attempt < len(retry_delays):
                        delay = retry_delays[attempt]
                        logger.warning(
                            f"Summarizer got overloaded error on coder {coder_index}, "
                            f"retry {attempt + 1}/{len(retry_delays)} in {delay}s"
                        )
                        await asyncio.sleep(delay)
                        last_result = result
                        continue

                last_result = result
                break

            except Exception as e:
                is_overloaded = self._is_retryable_overload_error(e)

                if is_overloaded and attempt < len(retry_delays):
                    delay = retry_delays[attempt]
                    logger.warning(
                        f"Summarizer exception (overloaded) on coder {coder_index}, "
                        f"retry {attempt + 1}/{len(retry_delays)} in {delay}s"
                    )
                    await asyncio.sleep(delay)
                    continue

                raise

        result = last_result
        if result is None:
            raise RuntimeError(f"Summarizer: all retry attempts exhausted for coder {coder_index}")

        # Update metrics (lock protects concurrent access from parallel tasks)
        async with self._db_lock:
            self.state.total_tokens += result.input_tokens + result.output_tokens
            self.state.total_cost += result.cost_usd

        if result.success and result.parsed_data:
            result.parsed_data["_summary_iteration"] = self.state.coder_iterations.get(coder_index, 0)
            # Feature #7: if a TDD mismatch was recorded for this coder during
            # the coding phase, inject it as a critical issue so the coder fixes
            # it on the next iteration.
            tdd_issue = self.state.tdd_mismatches.get(coder_index)
            if tdd_issue:
                critical = list(result.parsed_data.get("critical_issues") or [])
                critical.append(tdd_issue)
                result.parsed_data["critical_issues"] = critical
            self.state.summaries[coder_index] = result.parsed_data

            # Save to database
            await self._save_summary(coder_index, result)

            await self.emit_event("agent_completed", {
                "agent_type": "summarizer",
                "coder_index": coder_index,
                "critical_count": len(result.parsed_data.get("critical_issues", [])),
                "serious_count": len(result.parsed_data.get("serious_issues", [])),
            })
        else:
            await self.emit_event("agent_error", {
                "agent_type": "summarizer",
                "agent_index": 0,
                "coder_index": coder_index,
                "error": result.error or "Unknown summarizer error",
            })

        # Save LLM request (with lock for DB access)
        async with self._db_lock:
            await self._save_llm_request(
                agent_type=AgentType.SUMMARIZER,
                agent_index=0,
                result=result,
                provider=self.summarizer.provider,
                model=self.summarizer.model,
            )

        return result

    async def _check_and_finish_coders(self) -> None:
        """Check each active coder and mark as finished if no critical/serious issues."""
        active_coders = self.state.get_active_coders(self.coders)

        for coder in active_coders:
            coder_index = coder.agent_index
            summary = self.state.summaries.get(coder_index, {})
            coder_iteration = self.state.coder_iterations.get(coder_index, 0)

            # Verify summary is from current iteration (not stale from a previous one)
            summary_iteration = summary.get("_summary_iteration", -1)
            if summary and summary_iteration != coder_iteration:
                logger.warning(
                    f"Coder {coder_index}: summary is from iteration {summary_iteration}, "
                    f"current is {coder_iteration} — treating as no summary"
                )
                summary = {}

            critical_issues = summary.get("critical_issues", [])
            serious_issues = summary.get("serious_issues", [])
            minor_issues = summary.get("minor_issues", [])

            # Score-aware logging: surface average_scores so we can verify the
            # auto-finish heuristic (no critical/serious + scores>=9 = "high quality
            # consensus" finish via the not-has_issues branch below).
            avg_scores = summary.get("average_scores", {}) or {}
            score_parts = []
            min_score: float | None = None
            for key in ("spec_compliance", "correctness", "quality"):
                val = avg_scores.get(key)
                if val is not None:
                    try:
                        fval = float(val)
                        score_parts.append(f"{key}={fval:.1f}")
                        if min_score is None or fval < min_score:
                            min_score = fval
                    except (TypeError, ValueError):
                        pass
            scores_str = ", ".join(score_parts) if score_parts else "n/a"
            high_quality = (
                min_score is not None
                and min_score >= 9.0
                and not critical_issues
                and not serious_issues
            )

            # Detailed logging for debugging
            logger.info(
                f"Coder {coder_index} iteration {coder_iteration} issue check: "
                f"critical={len(critical_issues)}, serious={len(serious_issues)}, minor={len(minor_issues)}, "
                f"avg_scores=[{scores_str}], high_quality_consensus={high_quality}, "
                f"summary_keys={list(summary.keys()) if summary else 'empty'}"
            )

            has_issues = bool(critical_issues or serious_issues)
            at_max_iterations = coder_iteration >= self.state.max_iterations
            has_code = coder_index in self.state.code_versions

            if not has_code:
                # Coder never produced code — don't mark as finished,
                # let it retry on the next iteration (unless exhausted).
                # Use global workflow iteration as attempt counter since
                # coder_iterations only increments on SUCCESS.
                exhausted = (
                    at_max_iterations
                    or self.state.current_iteration >= self.state.max_iterations
                )
                if exhausted:
                    async with self._state_lock:
                        self.state.finished_coders.add(coder_index)
                        self.state.coder_finish_reasons[coder_index] = "failed_no_code"
                    logger.warning(
                        f"Coder {coder_index} giving up after {self.state.current_iteration} "
                        f"workflow iterations with NO code produced"
                    )
                    await self.emit_event("coder_finished", {
                        "coder_index": coder_index,
                        "reason": "failed_no_code",
                        "iteration": self.state.current_iteration,
                    })
                else:
                    logger.warning(
                        f"Coder {coder_index} has no code at workflow iteration "
                        f"{self.state.current_iteration} — will retry next iteration"
                    )
            elif not has_issues:
                # КАО#R4-M12 — "no issues" must mean "audited and clean", not
                # "nobody looked". An EMPTY summary (all testers/summarizer
                # failed this iteration) used to promote unaudited code as a
                # clean pass; now the coder retries unless iterations are spent.
                audited = bool(summary)
                if audited:
                    # No critical/serious issues - coder finished successfully
                    async with self._state_lock:
                        self.state.finished_coders.add(coder_index)
                        self.state.coder_finish_reasons[coder_index] = "no_issues"

                    logger.info(f"Coder {coder_index} finished at iteration {coder_iteration}: no critical/serious issues")

                    await self.emit_event("coder_finished", {
                        "coder_index": coder_index,
                        "reason": "no_issues",
                        "iteration": coder_iteration,
                    })
                elif at_max_iterations:
                    async with self._state_lock:
                        self.state.finished_coders.add(coder_index)
                        self.state.coder_finish_reasons[coder_index] = "max_iterations"
                    logger.warning(
                        f"Coder {coder_index} finished at iteration {coder_iteration}: "
                        "max iterations reached WITHOUT an audit (testers/summarizer failed)"
                    )
                    await self.emit_event("coder_finished", {
                        "coder_index": coder_index,
                        "reason": "max_iterations",
                        "iteration": coder_iteration,
                        "unaudited": True,
                    })
                else:
                    logger.warning(
                        f"Coder {coder_index}: no summary for iteration {coder_iteration} — "
                        "not finishing as no_issues; retrying next iteration"
                    )
                    await self.emit_event("coder_continuing", {
                        "coder_index": coder_index,
                        "iteration": coder_iteration,
                        "critical_issues": 0,
                        "serious_issues": 0,
                        "unaudited": True,
                    })
            elif at_max_iterations:
                # Reached max iterations - force finish
                async with self._state_lock:
                    self.state.finished_coders.add(coder_index)
                    self.state.coder_finish_reasons[coder_index] = "max_iterations"

                logger.info(f"Coder {coder_index} finished at iteration {coder_iteration}: max iterations reached")

                await self.emit_event("coder_finished", {
                    "coder_index": coder_index,
                    "reason": "max_iterations",
                    "iteration": coder_iteration,
                    "remaining_issues": {
                        "critical": len(critical_issues),
                        "serious": len(serious_issues),
                    },
                })
            else:
                logger.info(f"Coder {coder_index} continues: {len(critical_issues)} critical, {len(serious_issues)} serious issues")
                await self.emit_event("coder_continuing", {
                    "coder_index": coder_index,
                    "iteration": coder_iteration,
                    "critical_issues": len(critical_issues),
                    "serious_issues": len(serious_issues),
                })

    async def _run_finalization_phase(
        self,
        forced_winner_code_version_id: Optional[str] = None,
        forced_winner_reasoning: Optional[str] = None,
    ) -> None:
        """Run finalizer to select best code and generate docs.

        Args:
            forced_winner_code_version_id: If provided, bypasses the
                Finalizer LLM's selection step and forces the given
                code_version_id as the winner. The LLM is still invoked
                for documentation (README, api_docs, etc.) but its
                ``selected_coder_index`` output is ignored. Used by the
                Visual Review wave-2 flow when user (or vision_llm)
                scores have determined the winner.
            forced_winner_reasoning: Audit-trail text describing why the
                forced winner was picked (user_score / vision_llm /
                fallback). Prepended to FinalResult.selection_reasoning.
        """
        self.state.phase = WorkflowPhase.FINALIZING

        # Resolve forced_winner_code_version_id -> coder_index, if provided.
        # We look it up in the DB so the orchestrator doesn't need an
        # in-memory map of code_version_id -> coder_index (which only
        # exists in the visual-review service that produced the override).
        forced_winner_coder_index: Optional[int] = None
        forced_winner_reasoning_prefix: Optional[str] = None
        if forced_winner_code_version_id is not None:
            try:
                from sqlalchemy import select as sa_select
                stmt = sa_select(CodeVersion.coder_index).where(
                    CodeVersion.session_id == self.session.id,
                    CodeVersion.id == forced_winner_code_version_id,
                )
                row = (await self.db.execute(stmt)).scalar_one_or_none()
                if row is not None:
                    forced_winner_coder_index = int(row)
                    logger.info(
                        f"Visual review override: code_version_id={forced_winner_code_version_id} "
                        f"-> coder_index={forced_winner_coder_index}"
                    )
                else:
                    logger.warning(
                        f"forced_winner_code_version_id={forced_winner_code_version_id} "
                        f"not found in session {self._session_id} — falling back to LLM selection"
                    )
            except Exception as e:
                logger.error(f"Failed to resolve forced_winner_code_version_id: {e}")

        if not self.finalizer:
            # КАО#R4-M15 — the log claimed "using first coder's code" but wrote
            # NO FinalResult, so the session completed with no final result.
            # Persist the same fallback the finalizer-timeout branch builds.
            non_empty = {k: v for k, v in self.state.code_versions.items() if v and v.strip()}
            if non_empty:
                if forced_winner_coder_index is not None and forced_winner_coder_index in non_empty:
                    pick = forced_winner_coder_index
                    reasoning = (forced_winner_reasoning or "").strip() or "No finalizer configured."
                else:
                    pick = max(non_empty, key=lambda k: len(non_empty[k]))
                    reasoning = f"No finalizer configured — using coder {pick}'s code."
                self.db.add(FinalResult(
                    session_id=self.session.id,
                    selected_coder_index=pick,
                    final_code=non_empty[pick],
                    readme_content="",
                    total_iterations=self.state.current_iteration,
                    total_tokens=self.state.total_tokens,
                    total_cost_usd=self.state.total_cost,
                    selection_reasoning=reasoning,
                ))
                await self.db.commit()
                logger.warning(f"No finalizer configured — persisted fallback FinalResult from coder {pick}")
            else:
                logger.warning("No finalizer configured and no non-empty code — nothing to finalize")
            return

        # Check if we have any code to finalize
        if not self.state.code_versions:
            logger.warning("No code versions available for finalization")
            await self.emit_event("workflow_error", {
                "error": "No code versions available for finalization",
                "phase": "finalizing",
            })
            return

        await self.emit_event("phase_started", {
            "phase": "finalizing",
            "iteration": self.state.current_iteration,
        })

        # Execute all code versions if execution is enabled
        execution_results = []
        enable_execution = self.session.enable_code_execution
        browser_language = self.session.language.lower() in (
            'javascript_browser', 'typescript_browser', 'html',
        )

        if enable_execution:
            sandbox = get_sandbox_client()
            timeout = self.session.execution_timeout
            auto_install = self.session.auto_install_deps

            for coder_index, code in self.state.code_versions.items():
                if not code or not code.strip():
                    continue

                await self.emit_event("finalizer_executing_code", {
                    "coder_index": coder_index,
                })

                try:
                    if browser_language:
                        # Browser languages: validate in headless Chromium
                        exec_result = await sandbox.validate_browser(
                            code=code, timeout=timeout
                        )
                    else:
                        # Standard languages: execute in sandbox
                        exec_result = await sandbox.execute(
                            code=code,
                            language=self.session.language,
                            timeout=timeout,
                            auto_install_deps=auto_install,
                        )

                    execution_results.append({
                        "coder_index": coder_index,
                        "exit_code": exec_result.exit_code,
                        "stdout": exec_result.stdout[:2000] if exec_result.stdout else "",
                        "stderr": exec_result.stderr[:1000] if exec_result.stderr else "",
                        "execution_time_ms": exec_result.execution_time_ms,
                        "success": exec_result.success,
                        "timeout_exceeded": exec_result.timeout_exceeded,
                    })
                except Exception as exc:
                    logger.error(f"Failed to execute code for coder {coder_index}: {exc}")
                    execution_results.append({
                        "coder_index": coder_index,
                        "exit_code": -1,
                        "stdout": "",
                        "stderr": f"Execution failed: {exc}",
                        "execution_time_ms": 0,
                        "success": False,
                        "timeout_exceeded": False,
                    })

        # Pre-rank: if many coders, send only top 3 + lowest 1 to finalizer to save tokens.
        # Most sessions have <=2 coders so this is a no-op in the common case.
        coder_scores = []
        for coder_idx in self.state.code_versions.keys():
            summary = self.state.summaries.get(coder_idx, {}) or {}
            avg = summary.get("average_scores", {}) or {}
            score = (
                float(avg.get("spec_compliance") or 0)
                + float(avg.get("correctness") or 0)
                + float(avg.get("quality") or 0)
            )
            coder_scores.append((coder_idx, score))

        if len(coder_scores) > 4:
            coder_scores.sort(key=lambda x: x[1], reverse=True)
            # Keep top 3 + lowest 1 for comparison context
            selected_indices = {c[0] for c in coder_scores[:3]} | {coder_scores[-1][0]}
            logger.info(
                f"Pre-ranking finalizer candidates: {len(coder_scores)} coders -> "
                f"{len(selected_indices)} selected ({sorted(selected_indices)})"
            )
            finalizer_code_versions = {
                i: self.state.code_versions[i] for i in selected_indices
            }
        else:
            finalizer_code_versions = self.state.code_versions

        # Prepare versions for finalizer (skip empty code)
        repo_mode = self._has_repo_attachment()
        versions = []
        for coder_index, code in finalizer_code_versions.items():
            if not code or not code.strip():
                logger.warning(f"Skipping Coder {coder_index} from finalization - empty code")
                continue
            summary = self.state.summaries.get(coder_index, {})
            coder_iteration = self.state.coder_iterations.get(coder_index, self.state.current_iteration)
            finish_reason = self.state.coder_finish_reasons.get(coder_index, "unknown")

            # Get scores from summary's average_scores
            average_scores = summary.get("average_scores", {})

            version_data = {
                "coder_index": coder_index,
                "code": code,
                "iteration": coder_iteration,
                "finish_reason": finish_reason,
                "critical_count": len(summary.get("critical_issues", [])),
                "serious_count": len(summary.get("serious_issues", [])),
                "minor_count": len(summary.get("minor_issues", [])),
                "scores": {
                    "spec_compliance": average_scores.get("spec_compliance"),
                    "correctness": average_scores.get("correctness"),
                    "quality": average_scores.get("quality"),
                },
                "positive_aspects": summary.get("positive_aspects", []),
                "remaining_issues": {
                    "critical": summary.get("critical_issues", []),
                    "serious": summary.get("serious_issues", []),
                    "minor": summary.get("minor_issues", []),
                    "suggestions": summary.get("suggestions", []),
                },
                "tokens": 0,  # TODO: Calculate per-coder tokens
            }

            # Add repo file data if in repo mode
            if repo_mode and coder_index in self.state.repo_file_versions:
                version_data["repo_files"] = self.state.repo_file_versions[coder_index]

            versions.append(version_data)

        await self.emit_event("agent_started", {
            "agent_type": "finalizer",
            "iteration": self.state.current_iteration,
        })

        agent_timeout = self.session.agent_timeout or 300
        # If we pre-ranked, filter execution_results to match selected coders
        finalizer_exec_results = execution_results
        if enable_execution and len(coder_scores) > 4:
            selected_set = {v["coder_index"] for v in versions}
            finalizer_exec_results = [
                r for r in execution_results if r.get("coder_index") in selected_set
            ]
        try:
            result = await asyncio.wait_for(
                self.finalizer.execute(
                    specification=self.get_full_specification(),
                    versions=versions,
                    language=self.session.language,
                    execution_results=finalizer_exec_results if enable_execution else None,
                    repo_mode=repo_mode,
                ),
                timeout=agent_timeout,
            )
        except asyncio.TimeoutError:
            logger.error(f"Finalizer timed out after {agent_timeout}s")
            await self.emit_event("agent_error", {
                "agent_type": "finalizer",
                "agent_index": 0,
                "error": f"Finalizer timed out after {agent_timeout}s",
            })
            # Use fallback: pick best coder's code directly.
            # Honour the forced winner if present so visual-review scores
            # don't get lost to a finalizer timeout.
            non_empty_versions = {k: v for k, v in self.state.code_versions.items() if v and v.strip()}
            if non_empty_versions:
                if (
                    forced_winner_coder_index is not None
                    and forced_winner_coder_index in non_empty_versions
                ):
                    first_coder_index = forced_winner_coder_index
                    timeout_reasoning = (
                        (forced_winner_reasoning or "")
                        + "\n\n(Finalizer LLM timed out — documentation may be incomplete.)"
                    ).strip()
                else:
                    first_coder_index = max(non_empty_versions, key=lambda k: len(non_empty_versions[k]))
                    timeout_reasoning = "Finalizer timed out — using longest code as fallback."
                fallback_code = non_empty_versions[first_coder_index]
                final = FinalResult(
                    session_id=self.session.id,
                    selected_coder_index=first_coder_index,
                    final_code=fallback_code,
                    readme_content="",
                    total_iterations=self.state.current_iteration,
                    total_tokens=self.state.total_tokens,
                    total_cost_usd=self.state.total_cost,
                    selection_reasoning=timeout_reasoning,
                )
                self.db.add(final)
                await self.db.commit()
                logger.info(f"Finalizer timeout fallback: using coder {first_coder_index} code")
            return

        # Update metrics (lock protects concurrent access)
        async with self._db_lock:
            self.state.total_tokens += result.input_tokens + result.output_tokens
            self.state.total_cost += result.cost_usd

        if result.success and result.parsed_data:
            # --- Visual Review wave-2 override ---
            # If a forced winner came from user / vision_llm scores, ignore
            # whatever selected_coder_index the LLM picked and substitute
            # ours. The LLM's other output (README, api_docs, comparison)
            # is preserved.
            if forced_winner_coder_index is not None:
                llm_pick = result.parsed_data.get("selected_coder_index")
                logger.info(
                    f"Visual review override: replacing LLM pick "
                    f"(coder_index={llm_pick}) with forced winner "
                    f"(coder_index={forced_winner_coder_index})"
                )
                result.parsed_data["selected_coder_index"] = forced_winner_coder_index
                # Prepend audit-trail to whatever reasoning the LLM produced.
                if forced_winner_reasoning:
                    existing = result.parsed_data.get("selection_reasoning") or ""
                    result.parsed_data["selection_reasoning"] = (
                        f"{forced_winner_reasoning}\n\nLLM rationale (for documentation only): {existing}"
                        if existing.strip()
                        else forced_winner_reasoning
                    )

            # --- Always use REAL code from the selected coder ---
            # The finalizer's job is to SELECT the best version, not regenerate code.
            # The prompt may truncate code, causing LLM to produce a different version.
            # We always substitute with the actual full code from code_versions.
            selected_idx = result.parsed_data.get("selected_coder_index", 0)

            # Validate selected_coder_index — must exist in code_versions
            valid_indices = list(self.state.code_versions.keys())
            if selected_idx not in valid_indices and valid_indices:
                logger.warning(
                    f"Finalizer returned invalid selected_coder_index={selected_idx}. "
                    f"Valid indices: {valid_indices}. "
                    f"Falling back to first available coder."
                )
                # Try to detect off-by-one: if LLM used 1-based numbering
                if (selected_idx - 1) in valid_indices:
                    selected_idx = selected_idx - 1
                    logger.info(f"Corrected to {selected_idx} (likely 1-based confusion)")
                else:
                    selected_idx = valid_indices[0]
                result.parsed_data["selected_coder_index"] = selected_idx

            real_code = self.state.code_versions.get(selected_idx, "")
            if real_code and real_code.strip():
                llm_code_len = len(result.parsed_data.get("final_code", ""))
                logger.info(
                    f"Finalizer selected coder {selected_idx}. "
                    f"Using real code ({len(real_code)} chars) "
                    f"instead of LLM-generated final_code ({llm_code_len} chars)"
                )
                result.parsed_data["final_code"] = real_code
            else:
                logger.warning(
                    f"Finalizer selected coder {selected_idx} but no real code found. "
                    f"Using LLM final_code as fallback."
                )

            # Save final result
            await self._save_final_result(result)

            # --- Verify final code by executing it ---
            final_code = result.parsed_data.get("final_code", "")
            if enable_execution and final_code.strip() and not repo_mode:
                await self._verify_final_code(final_code, browser_language)

            await self.emit_event("agent_completed", {
                "agent_type": "finalizer",
                "selected_coder": result.parsed_data.get("selected_coder_index"),
            })
        else:
            # Finalizer failed - emit error event
            error_msg = result.error or "Unknown error"
            logger.error(f"Finalizer failed: {error_msg}")
            await self.emit_event("agent_error", {
                "agent_type": "finalizer",
                "agent_index": 0,
                "error": error_msg,
            })

            # Still try to save some result - use best available coder's code as fallback
            # Prefer the forced winner (if any) over the longest-code heuristic
            # so visual-review user scores survive even an LLM failure.
            non_empty_versions = {k: v for k, v in self.state.code_versions.items() if v and v.strip()}
            if non_empty_versions:
                if (
                    forced_winner_coder_index is not None
                    and forced_winner_coder_index in non_empty_versions
                ):
                    first_coder_index = forced_winner_coder_index
                else:
                    first_coder_index = max(non_empty_versions, key=lambda k: len(non_empty_versions[k]))
                fallback_code = non_empty_versions[first_coder_index]

                # Build file_structure for repo mode fallback
                fallback_file_structure = None
                if repo_mode and first_coder_index in self.state.repo_file_versions:
                    repo_data = self.state.repo_file_versions[first_coder_index]
                    fallback_file_structure = {}
                    for path, content in repo_data.get("modified_files", {}).items():
                        fallback_file_structure[path] = {"content": content, "action": "modified"}
                    for path, content in repo_data.get("new_files", {}).items():
                        fallback_file_structure[path] = {"content": content, "action": "created"}
                    for path in repo_data.get("deleted_files", []):
                        fallback_file_structure[path] = {"action": "deleted"}

                if forced_winner_coder_index is not None and forced_winner_reasoning:
                    fallback_reasoning = (
                        f"{forced_winner_reasoning}\n\n"
                        f"(Finalizer LLM failed: {error_msg} — documentation may be incomplete.)"
                    )
                else:
                    fallback_reasoning = (
                        f"Fallback: Finalizer failed ({error_msg}), "
                        f"using Coder {first_coder_index + 1}'s code"
                    )
                final = FinalResult(
                    session_id=self.session.id,
                    selected_coder_index=first_coder_index,
                    final_code=fallback_code,
                    file_structure=fallback_file_structure,
                    readme_content="",
                    selection_reasoning=fallback_reasoning,
                    total_iterations=self.state.current_iteration,
                    total_tokens=self.state.total_tokens,
                    total_cost_usd=self.state.total_cost,
                )
                self.db.add(final)
                await self.db.commit()

                logger.warning(
                    f"Finalizer failed, using fallback code from Coder {first_coder_index}: {error_msg}"
                )
                await self.emit_event("finalizer_fallback", {
                    "agent_type": "finalizer",
                    "selected_coder": first_coder_index,
                    "reason": error_msg,
                    "fallback": "first_coder_code",
                })

        # Save LLM request (with lock for DB access)
        async with self._db_lock:
            await self._save_llm_request(
                agent_type=AgentType.FINALIZER,
                agent_index=0,
                result=result,
                provider=self.finalizer.provider,
                model=self.finalizer.model,
            )

        logger.info("Finalization phase complete")

    def _has_critical_or_serious_issues(self) -> bool:
        """Check if any coder has critical or serious issues."""
        for summary in self.state.summaries.values():
            if summary.get("critical_issues") or summary.get("serious_issues"):
                return True
        return False

    # Database helpers
    async def _save_code_version(self, coder_index: int, result: AgentResult) -> Optional[str]:
        """Save code version to database. Returns the code_version_id.

        Handles unique constraint violations by replacing existing records
        (both CodeVersion and CoderResponse).  Uses the DB lock to prevent
        concurrent saves from corrupting the SQLAlchemy session.
        """
        from sqlalchemy import select as sa_select, delete as sa_delete

        async with self._db_lock:
            try:
                # Use parsed code if available, otherwise raw content
                code_content = (result.parsed_data.get("code") if result.parsed_data else None) or result.content

                # Check if a code_version already exists for this (session, coder, iteration)
                # and delete it to avoid unique constraint violations (e.g. after session reset
                # or duplicate orchestrator runs)
                existing_stmt = sa_select(CodeVersion.id).where(
                    CodeVersion.session_id == self.session.id,
                    CodeVersion.coder_index == coder_index,
                    CodeVersion.iteration == self.state.current_iteration,
                )
                existing_result = await self.db.execute(existing_stmt)
                existing_id = existing_result.scalar_one_or_none()
                if existing_id:
                    logger.warning(
                        f"Replacing existing code_version {existing_id} for "
                        f"coder {coder_index} iteration {self.state.current_iteration}"
                    )
                    await self.db.execute(
                        sa_delete(CodeVersion).where(CodeVersion.id == existing_id)
                    )

                # Also delete any existing CoderResponse for the same
                # (session, coder, iteration) to avoid UniqueViolationError
                await self.db.execute(
                    sa_delete(CoderResponse).where(
                        CoderResponse.session_id == self.session.id,
                        CoderResponse.coder_index == coder_index,
                        CoderResponse.iteration == self.state.current_iteration,
                    )
                )

                code_version = CodeVersion(
                    session_id=self.session.id,
                    coder_index=coder_index,
                    iteration=self.state.current_iteration,
                    code_content=code_content,
                    analysis=result.parsed_data.get("analysis") if result.parsed_data else None,
                    status=CodeVersionStatus.GENERATED,
                )
                self.db.add(code_version)

                # Save coder response if present
                if result.parsed_data:
                    coder_response = CoderResponse(
                        session_id=self.session.id,
                        coder_index=coder_index,
                        iteration=self.state.current_iteration,
                        accepted_issues=result.parsed_data.get("accepted_issues", []),
                        rejected_issues=result.parsed_data.get("rejected_issues", []),
                        rejection_reasons=result.parsed_data.get("rejection_reasons", {}),
                    )
                    self.db.add(coder_response)

                await self.db.commit()
                return code_version.id
            except Exception as e:
                logger.error(f"Failed to save code version for coder {coder_index}: {e}")
                await self.db.rollback()
                # Refresh the session ORM object so its attributes don't
                # trigger MissingGreenlet on subsequent access.
                try:
                    await self.db.refresh(self.session)
                except Exception:
                    pass
                return None

    async def _save_audit(self, coder_index: int, tester_index: int, result: AgentResult) -> None:
        """Save audit to database."""
        async with self._db_lock:
            try:
                # Get code version ID
                from sqlalchemy import select
                stmt = select(CodeVersion).where(
                    CodeVersion.session_id == self.session.id,
                    CodeVersion.coder_index == coder_index,
                    CodeVersion.iteration == self.state.current_iteration,
                )
                code_version = (await self.db.execute(stmt)).scalar_one_or_none()

                if code_version is None:
                    # КАО#R4-M13 — fallback paths audit code whose CodeVersion row
                    # carries an older iteration; attach the audit to the coder's
                    # LATEST version instead of silently dropping it.
                    fb_stmt = (
                        select(CodeVersion)
                        .where(
                            CodeVersion.session_id == self.session.id,
                            CodeVersion.coder_index == coder_index,
                        )
                        .order_by(CodeVersion.iteration.desc())
                        .limit(1)
                    )
                    code_version = (await self.db.execute(fb_stmt)).scalar_one_or_none()
                    if code_version is not None:
                        logger.warning(
                            f"Audit for coder {coder_index} iter {self.state.current_iteration}: "
                            f"no CodeVersion at that iteration — attaching to latest (iter {code_version.iteration})"
                        )
                    else:
                        logger.warning(
                            f"Audit for coder {coder_index} dropped: no CodeVersion rows exist at all"
                        )

                if code_version:
                    audit = Audit(
                        session_id=self.session.id,
                        code_version_id=code_version.id,
                        tester_index=tester_index,
                        iteration=self.state.current_iteration,
                        audit_content=result.content,
                        issues=result.parsed_data.get("issues", []) if result.parsed_data else [],
                        overall_assessment=result.parsed_data.get("overall_assessment") if result.parsed_data else None,
                        specification_compliance=(result.parsed_data.get("spec_compliance_score") or result.parsed_data.get("specification_compliance")) if result.parsed_data else None,
                        positive_aspects=result.parsed_data.get("positive_aspects", []) if result.parsed_data else [],
                    )
                    self.db.add(audit)
                    await self.db.commit()
            except IntegrityError as ie:
                logger.warning(
                    f"Duplicate audit for coder {coder_index}, tester {tester_index} "
                    f"iteration {self.state.current_iteration}, skipping: {ie}"
                )
                await self.db.rollback()
                try:
                    await self.db.refresh(self.session)
                except Exception as refresh_err:
                    logger.warning(f"Session refresh after audit IntegrityError also failed: {refresh_err}")
            except Exception as e:
                logger.error(f"Failed to save audit for coder {coder_index}, tester {tester_index}: {e}")
                await self.db.rollback()
                try:
                    await self.db.refresh(self.session)
                except Exception as refresh_err:
                    logger.warning(f"Session refresh after audit save error also failed: {refresh_err}")

    async def _save_summary(self, coder_index: int, result: AgentResult) -> None:
        """Save summary audit to database."""
        async with self._db_lock:
            try:
                # КАО#VR-21-follow — proactively drop any existing summary for this
                # (session, coder, iteration) before inserting. Reset already
                # clears summary_audits, but a run STARTED on a session with
                # leftover rows from an incomplete prior run (only iteration-1 rows
                # were seen colliding) would otherwise hit uq_summary_audit and the
                # old behaviour SKIPPED — leaving a STALE summary for the
                # issue-check to read. Delete-then-insert overwrites cleanly.
                from sqlalchemy import delete as _sa_delete
                await self.db.execute(
                    _sa_delete(SummaryAudit).where(
                        SummaryAudit.session_id == self.session.id,
                        SummaryAudit.coder_index == coder_index,
                        SummaryAudit.iteration == self.state.current_iteration,
                    )
                )
                summary = SummaryAudit(
                    session_id=self.session.id,
                    coder_index=coder_index,
                    iteration=self.state.current_iteration,
                    summary_content=result.content,
                    critical_issues=result.parsed_data.get("critical_issues", []) if result.parsed_data else [],
                    serious_issues=result.parsed_data.get("serious_issues", []) if result.parsed_data else [],
                    minor_issues=result.parsed_data.get("minor_issues", []) if result.parsed_data else [],
                    suggestions=result.parsed_data.get("suggestions", []) if result.parsed_data else [],
                    consensus_notes=result.parsed_data.get("consensus_notes") if result.parsed_data else None,
                    recommended_focus=result.parsed_data.get("recommended_focus", []) if result.parsed_data else [],
                )
                self.db.add(summary)
                await self.db.commit()
            except IntegrityError as ie:
                logger.warning(
                    f"Duplicate summary for coder {coder_index} iteration "
                    f"{self.state.current_iteration}, skipping: {ie}"
                )
                await self.db.rollback()
                try:
                    await self.db.refresh(self.session)
                except Exception as refresh_err:
                    logger.warning(f"Session refresh after summary IntegrityError also failed: {refresh_err}")
            except Exception as e:
                logger.error(f"Failed to save summary for coder {coder_index}: {e}")
                await self.db.rollback()
                try:
                    await self.db.refresh(self.session)
                except Exception as refresh_err:
                    logger.warning(f"Session refresh after summary save error also failed: {refresh_err}")

    async def _save_final_result(self, result: AgentResult) -> None:
        """Save final result to database."""
        async with self._db_lock:
            try:
                parsed = result.parsed_data or {}

                # Build file_structure with full content for repo mode
                file_structure = parsed.get("file_structure")
                if parsed.get("repo_mode") and not file_structure:
                    # Build file_structure from repo data
                    file_structure = {}
                    for path, content in parsed.get("modified_files", {}).items():
                        file_structure[path] = {"content": content, "action": "modified"}
                    for path, content in parsed.get("new_files", {}).items():
                        file_structure[path] = {"content": content, "action": "created"}
                    for path in parsed.get("deleted_files", []):
                        file_structure[path] = {"action": "deleted"}

                final = FinalResult(
                    session_id=self.session.id,
                    selected_coder_index=parsed.get("selected_coder_index", 0),
                    final_code=parsed.get("final_code", ""),
                    file_structure=file_structure,
                    readme_content=parsed.get("readme_content", ""),
                    selection_reasoning=parsed.get("selection_reasoning", ""),
                    # КАО#R1-11 — real executed iteration count (see workflow_completed).
                    total_iterations=max(self.state.coder_iterations.values(), default=self.state.current_iteration),
                    total_tokens=self.state.total_tokens,
                    total_cost_usd=self.state.total_cost,
                )
                self.db.add(final)

                # Update session
                self.session.current_iteration = self.state.current_iteration

                await self.db.commit()
            except Exception as e:
                logger.error(f"Failed to save final result: {e}")
                await self.db.rollback()
                try:
                    await self.db.refresh(self.session)
                except Exception as refresh_err:
                    logger.warning(f"Session refresh after final-result save error also failed: {refresh_err}")

    async def _verify_final_code(
        self, final_code: str, browser_language: bool
    ) -> None:
        """Execute final code to verify it runs correctly."""
        try:
            await self.emit_event("finalizer_verifying_code", {})

            sandbox = get_sandbox_client()
            timeout = self.session.execution_timeout
            auto_install = self.session.auto_install_deps

            if browser_language:
                verify_result = await sandbox.validate_browser(
                    code=final_code, timeout=timeout
                )
            else:
                verify_result = await sandbox.execute(
                    code=final_code,
                    language=self.session.language,
                    timeout=timeout,
                    auto_install_deps=auto_install,
                )

            passed = verify_result.exit_code == 0

            # Update the saved FinalResult with verification data
            async with self._db_lock:
                from sqlalchemy import select as _sel
                stmt = _sel(FinalResult).where(
                    FinalResult.session_id == self.session.id
                )
                final = (await self.db.execute(stmt)).scalar_one_or_none()
                if final:
                    final.verification_passed = passed
                    final.verification_exit_code = verify_result.exit_code
                    final.verification_stdout = (
                        verify_result.stdout[:5000] if verify_result.stdout else ""
                    )
                    final.verification_stderr = (
                        verify_result.stderr[:2000] if verify_result.stderr else ""
                    )
                    await self.db.commit()

            await self.emit_event("finalizer_verification_complete", {
                "passed": passed,
                "exit_code": verify_result.exit_code,
                "stdout": (verify_result.stdout[:500] if verify_result.stdout else ""),
                "stderr": (verify_result.stderr[:500] if verify_result.stderr else ""),
            })

            if passed:
                logger.info("Final code verification PASSED")
            else:
                logger.warning(
                    f"Final code verification FAILED (exit_code={verify_result.exit_code})"
                )
        except Exception as e:
            logger.error(f"Final code verification error: {e}")
            await self.emit_event("finalizer_verification_complete", {
                "passed": False,
                "exit_code": -1,
                "error": str(e),
            })

    async def _save_llm_request(
        self,
        agent_type: AgentType,
        agent_index: int,
        result: AgentResult,
        provider: str,
        model: str,
    ) -> None:
        """Save LLM request log to database.

        VR-56 — acquire ``_db_lock``: coders/testers run in PARALLEL on one shared
        AsyncSession, so concurrent commits here used to collide and roll back —
        only ~2 of dozens of calls per session ever persisted. Also log the
        ACTUAL model used (after any router substitution), not the requested one,
        so the audit trail truly reflects what each call hit.
        """
        # КАО#VR-56-FIX — do NOT acquire self._db_lock here. Every caller
        # (coder/tester/summarizer/finalizer result handlers at orchestrator.py
        # ~1862/2424/2626/3166) ALREADY holds it, and asyncio.Lock is
        # non-reentrant — re-acquiring it dead-locked the orchestrator right
        # after the coding phase (the first handler to reach the save block hung
        # forever holding the lock, freezing every session). The caller's lock
        # already serialises the shared AsyncSession, so VR-56's "persist every
        # request" intent is preserved without the second acquisition.
        raw = result.raw_response or {}
        actual_model = raw.get("model_used") or model
        try:
            request = LLMRequest(
                session_id=self.session.id,
                agent_type=agent_type,
                agent_index=agent_index,
                iteration=self.state.current_iteration,
                prompt_sent="[see agent]",  # TODO: store full prompt
                response_received=result.content[:10000] if result.content else "",
                input_tokens=result.input_tokens,
                output_tokens=result.output_tokens,
                cost_usd=result.cost_usd,
                latency_ms=result.latency_ms,
                llm_provider=provider,
                llm_model=actual_model,
                success=result.success,
                error_message=result.error,
            )
            self.db.add(request)
            await self.db.commit()
        except Exception as e:
            logger.error(f"Failed to save LLM request for {agent_type} {agent_index}: {e}")
            try:
                await self.db.rollback()
            except Exception:
                pass

    async def _get_interventions_for_coder(self, coder_index: int) -> List[dict]:
        """Get user interventions for a specific coder.

        Picks up interventions that haven't been applied yet, regardless
        of the iteration value stored in the DB (the REST API saves them
        with ``session.current_iteration`` which may lag behind the
        orchestrator's in-memory counter).
        """
        from sqlalchemy import select, or_
        stmt = select(Intervention).where(
            Intervention.session_id == self.session.id,
            Intervention.applied == False,  # noqa: E712 — SQLAlchemy filter
        ).where(
            or_(
                (Intervention.target_agent_type == AgentType.CODER) &
                (Intervention.target_agent_index == coder_index),
                Intervention.target_agent_type.is_(None)
            )
        )

        result = await self.db.execute(stmt)
        interventions = result.scalars().all()

        # КАО#R4-S9 — a NULL-target ("to all agents") intervention must reach
        # EVERY active coder, not just the first to fetch it. Track per-run
        # delivery and only mark such rows applied once all active coders have
        # received them. Targeted rows keep the old mark-on-first-fetch.
        active_indices = {c.agent_index for c in self.state.get_active_coders(self.coders)}
        delivered: list = []
        commit_needed = False
        for i in interventions:
            if i.target_agent_type is None:
                seen = self._intervention_deliveries.setdefault(str(i.id), set())
                if coder_index in seen:
                    continue  # this coder already got it this round
                seen.add(coder_index)
                delivered.append(i)
                if active_indices.issubset(seen):
                    i.applied = True
                    commit_needed = True
            else:
                delivered.append(i)
                i.applied = True
                commit_needed = True
        if commit_needed:
            await self.db.commit()

        return [
            {"type": i.intervention_type, "content": i.content}
            for i in delivered
        ]

    async def _get_coder_rejections(self, coder_index: int) -> Optional[dict]:
        """Get coder's rejected issues from previous iteration."""
        from sqlalchemy import select
        stmt = select(CoderResponse).where(
            CoderResponse.session_id == self.session.id,
            CoderResponse.coder_index == coder_index,
            CoderResponse.iteration == self.state.current_iteration - 1,
        )

        result = await self.db.execute(stmt)
        response = result.scalar_one_or_none()

        if response and response.rejection_reasons:
            return response.rejection_reasons
        return None

    # Control methods
    def pause(self) -> None:
        """Pause the workflow (takes effect between phases)."""
        self.state.paused = True

    def resume(self) -> None:
        """Resume the workflow from pause."""
        self.state.paused = False

    def stop(self) -> None:
        """Stop/cancel the workflow.

        Also clears the paused flag so _wait_if_paused exits immediately.
        """
        self.state.should_stop = True
        self.state.paused = False  # unblock _wait_if_paused
