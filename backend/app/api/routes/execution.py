"""
Code execution API routes.
"""
from uuid import UUID
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.auth import get_current_user_id, require_auth
from app.db.database import get_db
from app.db.models import Session, FinalResult, CodeVersion, CodeExecution
from app.sandbox import get_sandbox_client

router = APIRouter()


@router.post("/sessions/{session_id}/run")
async def run_final_code(
    session_id: UUID,
    timeout_sec: int = Query(default=60, ge=10, le=300),
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Run the final code for a completed session."""
    # КАО#VR-35 — ownership filter: a JWT caller may only run their own
    # session's code. API-key / dev-mode (current_user_id None) keeps full
    # access for backwards compatibility. A non-owner gets a clean 404 (the
    # session is invisible) rather than a 400 that would confirm it exists.
    current_user_id = get_current_user_id(auth)
    # Get session
    stmt = select(Session).where(Session.id == session_id)
    if current_user_id is not None:
        stmt = stmt.where(Session.user_id == current_user_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Allow execution for any status that has a final result (completed, awaiting_enhancement, etc.)
    status_str = session.status.value if hasattr(session.status, 'value') else str(session.status)
    allowed_statuses = {"completed", "awaiting_enhancement", "awaiting_enhancement_review", "enhancing"}
    if status_str not in allowed_statuses:
        raise HTTPException(status_code=400, detail="Session is not completed yet")

    # Get final result
    stmt = select(FinalResult).where(FinalResult.session_id == session_id)
    result = await db.execute(stmt)
    final_result = result.scalar_one_or_none()

    if not final_result:
        raise HTTPException(status_code=404, detail="Final result not found")

    # Extract just the code (remove ### ANALYSIS section if present)
    code = final_result.final_code

    # Try to extract code from markdown code block
    code_block_match = re.search(r'```(?:python|javascript|typescript|java|cpp|c|go|rust|bash|html)?\s*\n(.*?)```', code, re.DOTALL)
    if code_block_match:
        code = code_block_match.group(1).strip()
    elif code.startswith("### ANALYSIS"):
        # Find the actual code after analysis
        lines = code.split('\n')
        code_started = False
        code_lines = []
        for line in lines:
            if line.startswith('"""') or line.startswith("'''") or line.startswith('import ') or line.startswith('from ') or line.startswith('def ') or line.startswith('class '):
                code_started = True
            if code_started:
                code_lines.append(line)
        if code_lines:
            code = '\n'.join(code_lines)

    # Browser languages generate HTML pages — they run in the browser, not Node.js
    browser_language = session.language.lower() in (
        'javascript_browser', 'typescript_browser', 'html',
    )
    if browser_language:
        return {
            "success": True,
            "exit_code": 0,
            "stdout": code[:200] + ("..." if len(code) > 200 else ""),
            "stderr": "",
            "execution_time_ms": 0,
            "memory_used_mb": 0,
            "timeout_exceeded": False,
            "error": None,
            "html": code,
        }

    # Execute code using sandbox
    sandbox = get_sandbox_client()
    exec_result = await sandbox.execute(
        code=code,
        language=session.language,
        timeout=timeout_sec,
        auto_install_deps=getattr(session, 'auto_install_deps', True),
    )

    return {
        "success": exec_result.success,
        "exit_code": exec_result.exit_code,
        "stdout": exec_result.stdout,
        "stderr": exec_result.stderr,
        "execution_time_ms": exec_result.execution_time_ms,
        "memory_used_mb": exec_result.memory_used_mb,
        "timeout_exceeded": exec_result.timeout_exceeded,
        "error": exec_result.error,
    }


@router.post("/code-versions/{version_id}/run")
async def run_code_version(
    version_id: UUID,
    timeout_sec: int = Query(default=60, ge=10, le=300),
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Run code from a specific code version (coder iteration)."""
    # КАО#VR-35 — ownership enforced via the owning session below.
    current_user_id = get_current_user_id(auth)
    # Get code version
    stmt = select(CodeVersion).where(CodeVersion.id == version_id)
    result = await db.execute(stmt)
    code_version = result.scalar_one_or_none()

    if not code_version:
        raise HTTPException(status_code=404, detail="Code version not found")

    # Get session for language
    stmt = select(Session).where(Session.id == code_version.session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # КАО#VR-35 — a JWT caller may only run code versions of their own session.
    # 404 (not 403) so we don't confirm the version exists for another tenant.
    if current_user_id is not None and session.user_id != current_user_id:
        raise HTTPException(status_code=404, detail="Code version not found")

    # Check for failed executions on this version → warning
    warning = None
    stmt = select(CodeExecution).where(
        CodeExecution.code_version_id == version_id,
        CodeExecution.exit_code != 0,
    )
    result = await db.execute(stmt)
    failed_execs = result.scalars().all()
    if failed_execs:
        warning = f"This code had {len(failed_execs)} failed execution(s) during testing"

    # Extract code
    code = code_version.code_content

    code_block_match = re.search(
        r'```(?:python|javascript|typescript|java|cpp|c|go|rust|bash|html)?\s*\n(.*?)```',
        code, re.DOTALL,
    )
    if code_block_match:
        code = code_block_match.group(1).strip()
    elif code.startswith("### ANALYSIS"):
        lines = code.split('\n')
        code_started = False
        code_lines = []
        for line in lines:
            if line.startswith('"""') or line.startswith("'''") or line.startswith('import ') or line.startswith('from ') or line.startswith('def ') or line.startswith('class '):
                code_started = True
            if code_started:
                code_lines.append(line)
        if code_lines:
            code = '\n'.join(code_lines)

    # Browser languages
    browser_language = session.language.lower() in (
        'javascript_browser', 'typescript_browser', 'html',
    )
    if browser_language:
        return {
            "success": True,
            "exit_code": 0,
            "stdout": code[:200] + ("..." if len(code) > 200 else ""),
            "stderr": "",
            "execution_time_ms": 0,
            "memory_used_mb": 0,
            "timeout_exceeded": False,
            "error": None,
            "warning": warning,
            "html": code,
        }

    # Execute code using sandbox
    sandbox = get_sandbox_client()
    exec_result = await sandbox.execute(
        code=code,
        language=session.language,
        timeout=timeout_sec,
        auto_install_deps=getattr(session, 'auto_install_deps', True),
    )

    return {
        "success": exec_result.success,
        "exit_code": exec_result.exit_code,
        "stdout": exec_result.stdout,
        "stderr": exec_result.stderr,
        "execution_time_ms": exec_result.execution_time_ms,
        "memory_used_mb": exec_result.memory_used_mb,
        "timeout_exceeded": exec_result.timeout_exceeded,
        "error": exec_result.error,
        "warning": warning,
    }


@router.post("/sessions/{session_id}/bundle")
async def bundle_final_code(
    session_id: UUID,
    timeout_sec: int = Query(default=60, ge=10, le=120),
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Bundle the final JS/TS code into a browser-ready HTML page."""
    # КАО#VR-35 — ownership filter (see run_final_code).
    current_user_id = get_current_user_id(auth)
    # Get session
    stmt = select(Session).where(Session.id == session_id)
    if current_user_id is not None:
        stmt = stmt.where(Session.user_id == current_user_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Allow execution for any status that has a final result
    status_str = session.status.value if hasattr(session.status, 'value') else str(session.status)
    allowed_statuses = {"completed", "awaiting_enhancement", "awaiting_enhancement_review", "enhancing"}
    if status_str not in allowed_statuses:
        raise HTTPException(status_code=400, detail="Session is not completed yet")

    # Check language
    lang = session.language.lower()
    if lang not in ("javascript", "javascript_browser", "js", "typescript", "typescript_browser", "ts"):
        raise HTTPException(status_code=400, detail=f"Bundling not supported for {session.language}. Only JS/TS.")

    # Get final result
    stmt = select(FinalResult).where(FinalResult.session_id == session_id)
    result = await db.execute(stmt)
    final_result = result.scalar_one_or_none()

    if not final_result:
        raise HTTPException(status_code=404, detail="Final result not found")

    code = final_result.final_code

    # Try to extract code from markdown code block
    code_block_match = re.search(r'```(?:javascript|typescript|js|ts)?\s*\n(.*?)```', code, re.DOTALL)
    if code_block_match:
        code = code_block_match.group(1).strip()

    # Bundle via sandbox
    sandbox = get_sandbox_client()
    bundle_result = await sandbox.bundle(
        code=code,
        language=session.language,
        timeout=timeout_sec,
        auto_install_deps=getattr(session, 'auto_install_deps', True),
    )

    return bundle_result


@router.post("/code/{code_version_id}/execute")
async def execute_code_version(
    code_version_id: UUID,
    timeout_sec: int = Query(default=60, ge=10, le=300),
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Execute a specific code version."""
    # КАО#VR-35 — ownership enforced via the owning session below.
    current_user_id = get_current_user_id(auth)
    # Get code version
    stmt = select(CodeVersion).where(CodeVersion.id == code_version_id)
    result = await db.execute(stmt)
    version = result.scalar_one_or_none()

    if not version:
        raise HTTPException(status_code=404, detail="Code version not found")

    # Get session for language
    stmt = select(Session).where(Session.id == version.session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Code version not found")

    # КАО#VR-35 — a JWT caller may only execute their own session's versions.
    if current_user_id is not None and session.user_id != current_user_id:
        raise HTTPException(status_code=404, detail="Code version not found")

    # Browser languages generate HTML — they run in the browser, not sandbox
    browser_language = session.language.lower() in (
        'javascript_browser', 'typescript_browser', 'html',
    )
    if browser_language:
        return {
            "success": True,
            "exit_code": 0,
            "stdout": "",
            "stderr": "",
            "execution_time_ms": 0,
            "memory_used_mb": 0,
            "timeout_exceeded": False,
            "error": None,
            "html": version.code_content,
        }

    # Execute code using sandbox
    sandbox = get_sandbox_client()
    exec_result = await sandbox.execute(
        code=version.code_content,
        language=session.language,
        timeout=timeout_sec,
        auto_install_deps=getattr(session, 'auto_install_deps', True),
    )

    # Save execution result
    execution = CodeExecution(
        code_version_id=str(version.id),
        executor_type="sandbox",
        exit_code=exec_result.exit_code,
        stdout=exec_result.stdout,
        stderr=exec_result.stderr,
        execution_time_ms=exec_result.execution_time_ms,
        memory_used_mb=exec_result.memory_used_mb,
    )
    db.add(execution)
    await db.commit()

    return {
        "success": exec_result.success,
        "exit_code": exec_result.exit_code,
        "stdout": exec_result.stdout,
        "stderr": exec_result.stderr,
        "execution_time_ms": exec_result.execution_time_ms,
        "memory_used_mb": exec_result.memory_used_mb,
        "timeout_exceeded": exec_result.timeout_exceeded,
        "error": exec_result.error,
    }


@router.get("/code/{code_version_id}/executions")
async def list_code_executions(
    code_version_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """List all executions for a code version."""
    # КАО#VR-35 — ownership check: a JWT caller may only list executions for
    # code versions of their own session. Resolve version → session and verify
    # the owner before returning any execution rows. 404 (not 403) on mismatch.
    current_user_id = get_current_user_id(auth)
    if current_user_id is not None:
        cv_stmt = select(CodeVersion).where(CodeVersion.id == code_version_id)
        code_version = (await db.execute(cv_stmt)).scalar_one_or_none()
        if code_version is None:
            raise HTTPException(status_code=404, detail="Code version not found")
        sess_stmt = select(Session).where(Session.id == code_version.session_id)
        session = (await db.execute(sess_stmt)).scalar_one_or_none()
        if session is None or session.user_id != current_user_id:
            raise HTTPException(status_code=404, detail="Code version not found")

    stmt = select(CodeExecution).where(
        CodeExecution.code_version_id == str(code_version_id)
    ).order_by(CodeExecution.created_at.desc())

    result = await db.execute(stmt)
    executions = result.scalars().all()

    return [
        {
            "id": str(e.id),
            "exit_code": e.exit_code,
            "stdout": e.stdout,
            "stderr": e.stderr,
            "execution_time_ms": e.execution_time_ms,
            "memory_used_mb": e.memory_used_mb,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in executions
    ]
