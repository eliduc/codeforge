"""
Session management API routes. v1.1.0
"""
import io
import json
import logging
import os
import re as _re
import tarfile
import zipfile
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum as PyEnum
from typing import Any, List, Optional
from urllib.parse import urlparse
from uuid import UUID, uuid4

from fastapi import APIRouter, Body, Depends, File, HTTPException, Query, UploadFile, status, BackgroundTasks
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.db.database import get_db
from app.schemas import (
    SessionCreate, SessionUpdate, SessionResponse, SessionListResponse,
    AgentConfigCreate, AgentConfigUpdate, AgentConfigResponse,
    SessionStatus, AgentType, LLMProvider,
    AttachmentInfo, AttachmentFile, FileUploadResponse,
    FetchRepoRequest, FetchRepoResponse,
    CreatePRRequest, CreatePRResponse,
    EnhanceRequest, EnhanceResponse, EnhancementSuggestionResponse,
    ApplyEnhancementsRequest, ApplyEnhancementsResponse,
    ImportCheckResponse, ImportResponse,
    ImportDuplicateInfo, ImportNewInfo,
    PaginatedResponse,
)
from app.core.orchestrator import WorkflowOrchestrator
from app.api.websocket.manager import session_manager
from app.db.models import (
    Session, AgentConfig, FinalResult, EnhancementSuggestion,
    CodeVersion, Audit, SummaryAudit, CoderResponse, LLMRequest as LLMRequestModel,
    Intervention, CodeExecution,
)

logger = logging.getLogger(__name__)

router = APIRouter()

# Allowed text file extensions
TEXT_EXTENSIONS = {
    '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.hpp',
    '.cs', '.rb', '.php', '.swift', '.kt', '.scala', '.r', '.m', '.mm',
    '.html', '.css', '.scss', '.less', '.xml', '.svg',
    '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
    '.md', '.txt', '.rst', '.csv', '.tsv', '.log',
    '.sql', '.graphql', '.proto', '.dockerfile',
    '.sh', '.bash', '.zsh', '.bat', '.ps1', '.cmd',
    '.gitignore', '.dockerignore', '.editorconfig',
    'makefile', 'dockerfile', 'gemfile', 'rakefile',
}

ARCHIVE_EXTENSIONS = {'.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2'}

MAX_FILE_SIZE = 5 * 1024 * 1024  # 5MB per file
MAX_TOTAL_SIZE = 20 * 1024 * 1024  # 20MB total
MAX_FILES = 50  # max files from archives


def _is_text_file(filename: str) -> bool:
    """Check if a file is a text/code file by extension."""
    name_lower = filename.lower()
    # Check exact filename matches (Makefile, Dockerfile, etc.)
    base_name = name_lower.rsplit('/', 1)[-1] if '/' in name_lower else name_lower
    if base_name in TEXT_EXTENSIONS:
        return True
    # Check extensions
    for ext in TEXT_EXTENSIONS:
        if ext.startswith('.') and name_lower.endswith(ext):
            return True
    return False


def _is_archive(filename: str) -> bool:
    """Check if file is a supported archive."""
    name_lower = filename.lower()
    return any(name_lower.endswith(ext) for ext in ARCHIVE_EXTENSIONS)


def _read_text_safe(data: bytes, filename: str) -> str | None:
    """Try to read file content as UTF-8 text, return None if binary."""
    try:
        return data.decode('utf-8')
    except UnicodeDecodeError:
        try:
            return data.decode('latin-1')
        except Exception:
            return None


def _extract_archive(data: bytes, filename: str) -> tuple[list[AttachmentFile], list[str]]:
    """Extract text files from a zip or tar archive."""
    files = []
    errors = []
    name_lower = filename.lower()

    try:
        if name_lower.endswith('.zip'):
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for info in zf.infolist():
                    if info.is_dir():
                        continue
                    # Prevent path traversal (Zip Slip) attacks — #85
                    resolved = os.path.normpath(info.filename)
                    if resolved.startswith('..') or os.path.isabs(resolved):
                        errors.append(f"Skipped {info.filename}: unsafe path")
                        continue
                    # Skip symbolic links
                    if (info.external_attr >> 16) & 0o170000 == 0o120000:
                        errors.append(f"Skipped {info.filename}: symbolic link")
                        continue
                    if not _is_text_file(info.filename):
                        continue
                    if info.file_size > MAX_FILE_SIZE:
                        errors.append(f"Skipped {info.filename}: too large ({info.file_size} bytes)")
                        continue
                    if len(files) >= MAX_FILES:
                        errors.append(f"Archive has too many files, stopped at {MAX_FILES}")
                        break
                    content = _read_text_safe(zf.read(info.filename), info.filename)
                    if content is not None:
                        files.append(AttachmentFile(
                            path=info.filename,
                            content=content,
                            size=info.file_size,
                        ))
        elif name_lower.endswith(('.tar', '.tar.gz', '.tgz', '.tar.bz2')):
            mode = 'r:gz' if name_lower.endswith(('.tar.gz', '.tgz')) else \
                   'r:bz2' if name_lower.endswith('.tar.bz2') else 'r'
            with tarfile.open(fileobj=io.BytesIO(data), mode=mode) as tf:
                for member in tf.getmembers():
                    if not member.isfile():
                        continue
                    # Prevent path traversal (Zip Slip) attacks — #85
                    resolved = os.path.normpath(member.name)
                    if resolved.startswith('..') or os.path.isabs(resolved):
                        errors.append(f"Skipped {member.name}: unsafe path")
                        continue
                    if not _is_text_file(member.name):
                        continue
                    if member.size > MAX_FILE_SIZE:
                        errors.append(f"Skipped {member.name}: too large ({member.size} bytes)")
                        continue
                    if len(files) >= MAX_FILES:
                        errors.append(f"Archive has too many files, stopped at {MAX_FILES}")
                        break
                    f = tf.extractfile(member)
                    if f:
                        content = _read_text_safe(f.read(), member.name)
                        if content is not None:
                            files.append(AttachmentFile(
                                path=member.name,
                                content=content,
                                size=member.size,
                            ))
    except Exception as e:
        errors.append(f"Failed to extract {filename}: {str(e)}")

    return files, errors


@router.post("/upload-files", response_model=FileUploadResponse)
async def upload_files(
    files: List[UploadFile] = File(...),
):
    """Upload files for session specification. Reads text files and extracts archives.

    Returns attachment info with file contents that can be included
    in the session creation request.
    """
    attachments = []
    errors = []
    total_size = 0

    for upload in files:
        filename = upload.filename or "unknown"
        data = await upload.read()
        file_size = len(data)
        total_size += file_size

        if total_size > MAX_TOTAL_SIZE:
            errors.append(f"Total upload size exceeds {MAX_TOTAL_SIZE // (1024*1024)}MB limit")
            break

        if file_size > MAX_FILE_SIZE:
            errors.append(f"{filename}: exceeds {MAX_FILE_SIZE // (1024*1024)}MB file size limit")
            continue

        if _is_archive(filename):
            # Extract archive
            archive_files, extract_errors = _extract_archive(data, filename)
            errors.extend(extract_errors)
            if archive_files:
                attachments.append(AttachmentInfo(
                    type="archive",
                    filename=filename,
                    size=file_size,
                    files=archive_files,
                ))
        elif _is_text_file(filename):
            # Read text file
            content = _read_text_safe(data, filename)
            if content is not None:
                attachments.append(AttachmentInfo(
                    type="file",
                    filename=filename,
                    content=content,
                    size=file_size,
                ))
            else:
                errors.append(f"{filename}: could not read as text")
        else:
            errors.append(f"{filename}: unsupported file type")

    logger.info(f"Uploaded {len(attachments)} attachments, {len(errors)} errors")
    return FileUploadResponse(attachments=attachments, errors=errors)


@router.post("/fetch-repo", response_model=FetchRepoResponse)
async def fetch_repo(request: FetchRepoRequest):
    """Fetch a git repository, clone it, and extract text/code files.

    Returns attachment info with file contents that can be included
    in the session creation request.
    """
    # #32 SSRF validation: reject private/internal URLs
    parsed = urlparse(request.url)
    if parsed.hostname in ('localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254') or \
       (parsed.hostname and parsed.hostname.startswith('10.')) or \
       (parsed.hostname and parsed.hostname.startswith('192.168.')):
        raise HTTPException(400, "Internal/private URLs are not allowed")

    from app.services.repo_service import clone_and_extract

    try:
        result = await clone_and_extract(
            url=request.url,
            branch=request.branch,
            token=request.token,
        )

        attachment = AttachmentInfo(
            type="repo",
            url=result["url"],
            branch=result["branch"],
            commit=result["commit"],
            repo_name=result.get("repo_name"),
            size=result["total_size"],
            file_count=result["file_count"],
            files=[
                AttachmentFile(path=f["path"], content=f["content"], size=f["size"])
                for f in result["files"]
            ],
        )

        return FetchRepoResponse(
            attachment=attachment,
            errors=result.get("errors", []),
        )

    except RuntimeError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to fetch repo: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch repository: {str(e)}")


@router.get("/{session_id}/download-zip")
async def download_result_zip(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Download the final result as a ZIP file with the complete project structure.

    For repo mode sessions, merges original repo files with modifications.
    For standard sessions, creates a ZIP with the final code file.
    """
    # Get session with attachments
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get final result
    stmt = select(FinalResult).where(FinalResult.session_id == session_id)
    result = await db.execute(stmt)
    final = result.scalar_one_or_none()

    if not final:
        raise HTTPException(status_code=404, detail="Final result not found")

    from app.services.repo_service import build_result_zip

    # Get original files from repo attachment
    original_files = {}
    attachments = getattr(session, 'attachments', None) or []
    for att in attachments:
        att_type = att.get('type', '') if isinstance(att, dict) else getattr(att, 'type', '')
        if att_type == 'repo':
            att_files = att.get('files', []) if isinstance(att, dict) else getattr(att, 'files', [])
            for f in att_files:
                fpath = f.get('path', '') if isinstance(f, dict) else getattr(f, 'path', '')
                fcontent = f.get('content', '') if isinstance(f, dict) else getattr(f, 'content', '')
                if fpath and fcontent:
                    original_files[fpath] = fcontent

    # Determine if file_structure contains actual file contents (repo mode)
    # or just descriptions (standard mode).  Repo mode values are dicts
    # like {"content": "...", "action": "modified"}, while standard mode
    # values are plain strings like "Main application file".
    has_repo_structure = False
    if final.file_structure:
        first_value = next(iter(final.file_structure.values()), None)
        has_repo_structure = isinstance(first_value, dict)

    if has_repo_structure:
        # Repo mode: merge original + changes
        zip_bytes = await build_result_zip(original_files, final.file_structure)
    elif final.final_code:
        # Standard mode: create ZIP with single file
        import zipfile as _zf
        buf = io.BytesIO()
        ext_map = {
            'python': '.py', 'javascript': '.js', 'typescript': '.ts',
            'javascript_browser': '.html', 'typescript_browser': '.html',
            'html': '.html', 'go': '.go', 'rust': '.rs',
            'java': '.java', 'c': '.c', 'cpp': '.cpp',
        }
        # Use filename from file_structure if available (e.g. "index.html"),
        # otherwise fall back to "main{ext}"
        if final.file_structure and len(final.file_structure) == 1:
            filename = next(iter(final.file_structure.keys()))
        else:
            ext = ext_map.get(session.language, '.txt')
            filename = f"main{ext}"
        with _zf.ZipFile(buf, 'w', _zf.ZIP_DEFLATED) as zf:
            zf.writestr(filename, final.final_code)
            if final.readme_content:
                zf.writestr("README.md", final.readme_content)
        zip_bytes = buf.getvalue()
    else:
        raise HTTPException(status_code=404, detail="No code available for download")

    # Determine filename
    repo_name = None
    for att in attachments:
        att_type = att.get('type', '') if isinstance(att, dict) else getattr(att, 'type', '')
        if att_type == 'repo':
            repo_name = att.get('repo_name', '') if isinstance(att, dict) else getattr(att, 'repo_name', '')
            break
    raw_name = repo_name or session.name or 'codeforge-result'
    # Sanitize: keep only alphanumeric, dash, underscore, dot characters
    safe_name = _re.sub(r'[^a-zA-Z0-9._-]', '_', raw_name)
    filename = f"{safe_name}.zip"

    return StreamingResponse(
        io.BytesIO(zip_bytes),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/create-pr", response_model=CreatePRResponse)
async def create_pull_request(
    request: CreatePRRequest,
    db: AsyncSession = Depends(get_db),
):
    """Create a GitHub Pull Request with the session's final result.

    Requires a GitHub personal access token with repo write permissions.
    """
    from app.services.repo_service import create_github_pr

    # Get session
    stmt = select(Session).where(Session.id == request.session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get final result
    stmt = select(FinalResult).where(FinalResult.session_id == request.session_id)
    result = await db.execute(stmt)
    final = result.scalar_one_or_none()

    if not final:
        raise HTTPException(status_code=404, detail="Final result not found")

    if not final.file_structure:
        raise HTTPException(status_code=400, detail="No file structure available. PR creation requires repo mode session.")

    # Find repo URL from attachments
    repo_url = None
    original_files = {}
    attachments = getattr(session, 'attachments', None) or []
    for att in attachments:
        att_type = att.get('type', '') if isinstance(att, dict) else getattr(att, 'type', '')
        if att_type == 'repo':
            repo_url = att.get('url', '') if isinstance(att, dict) else getattr(att, 'url', '')
            att_files = att.get('files', []) if isinstance(att, dict) else getattr(att, 'files', [])
            for f in att_files:
                fpath = f.get('path', '') if isinstance(f, dict) else getattr(f, 'path', '')
                fcontent = f.get('content', '') if isinstance(f, dict) else getattr(f, 'content', '')
                if fpath and fcontent:
                    original_files[fpath] = fcontent
            break

    if not repo_url:
        raise HTTPException(status_code=400, detail="No repository URL found in session attachments")

    # Build PR body
    pr_body = request.pr_body
    if not pr_body:
        changed = [p for p, i in final.file_structure.items() if i.get("action") == "modified"]
        created = [p for p, i in final.file_structure.items() if i.get("action") == "created"]
        deleted = [p for p, i in final.file_structure.items() if i.get("action") == "deleted"]

        parts = ["## Changes by CodeForge\n"]
        if changed:
            parts.append("### Modified Files\n" + "\n".join(f"- `{p}`" for p in changed))
        if created:
            parts.append("### New Files\n" + "\n".join(f"- `{p}`" for p in created))
        if deleted:
            parts.append("### Deleted Files\n" + "\n".join(f"- `{p}`" for p in deleted))
        if final.readme_content:
            parts.append(f"\n### Summary\n{final.readme_content[:2000]}")
        pr_body = "\n\n".join(parts)

    try:
        pr_result = await create_github_pr(
            repo_url=repo_url,
            file_structure=final.file_structure,
            original_files=original_files,
            branch_name=request.branch_name,
            pr_title=request.pr_title,
            pr_body=pr_body,
            token=request.token,
        )
        return CreatePRResponse(**pr_result)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to create PR: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create Pull Request: {str(e)}")


# ============================================================================
# Helper: ORM model -> dict for export/serialization
# ============================================================================


def _model_to_dict(instance: Any) -> dict[str, Any]:
    """Convert an ORM model instance to a plain dict for JSON serialization."""
    d: dict[str, Any] = {}
    for col in instance.__table__.columns:
        val = getattr(instance, col.name)
        if isinstance(val, datetime):
            val = val.isoformat()
        elif isinstance(val, Decimal):
            val = float(val)
        elif isinstance(val, PyEnum):
            val = val.value
        d[col.name] = val
    return d


def _full_session_load_options():
    """Return selectinload options for loading a session with ALL relationships."""
    return [
        selectinload(Session.agent_configs),
        selectinload(Session.code_versions).selectinload(CodeVersion.audits),
        selectinload(Session.code_versions).selectinload(CodeVersion.executions),
        selectinload(Session.audits),
        selectinload(Session.summary_audits),
        selectinload(Session.coder_responses),
        selectinload(Session.llm_requests),
        selectinload(Session.interventions),
        selectinload(Session.final_result),
        selectinload(Session.enhancement_suggestions),
    ]


def _serialize_session(session: Session) -> dict[str, Any]:
    """Serialize a fully-loaded session to a SessionExportData-compatible dict."""
    # Collect code executions from code_versions
    code_executions = []
    for cv in session.code_versions:
        for exe in cv.executions:
            code_executions.append(_model_to_dict(exe))

    return {
        "session": _model_to_dict(session),
        "agent_configs": [_model_to_dict(ac) for ac in session.agent_configs],
        "code_versions": [_model_to_dict(cv) for cv in session.code_versions],
        "audits": [_model_to_dict(a) for a in session.audits],
        "summary_audits": [_model_to_dict(sa) for sa in session.summary_audits],
        "coder_responses": [_model_to_dict(cr) for cr in session.coder_responses],
        "llm_requests": [_model_to_dict(lr) for lr in session.llm_requests],
        "interventions": [_model_to_dict(iv) for iv in session.interventions],
        "final_result": _model_to_dict(session.final_result) if session.final_result else None,
        "enhancement_suggestions": [_model_to_dict(es) for es in session.enhancement_suggestions],
        "code_executions": code_executions,
    }


async def _create_session_from_data(
    db: AsyncSession,
    data: dict[str, Any],
    rename: bool = False,
) -> str:
    """Create a full session with all child records from export data dict.
    Returns the new session id.
    """
    # Validate that required fields exist and have correct types
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Invalid import data: expected a dict")
    if "session" not in data or not isinstance(data["session"], dict):
        raise HTTPException(status_code=400, detail="Invalid import data: missing or invalid 'session' key")
    sd = data["session"]
    if "name" not in sd or not isinstance(sd["name"], str) or not sd["name"].strip():
        raise HTTPException(status_code=400, detail="Invalid import data: session must have a non-empty 'name' string")
    if "specification" not in sd or not isinstance(sd["specification"], str) or not sd["specification"].strip():
        raise HTTPException(status_code=400, detail="Invalid import data: session must have a non-empty 'specification' string")

    new_session_id = str(uuid4())
    name = sd["name"] + " (Copy)" if rename else sd["name"]

    new_session = Session(
        id=new_session_id,
        name=name,
        specification=sd["specification"],
        original_specification=sd.get("original_specification", sd["specification"]),
        initial_code=sd.get("initial_code"),
        initial_docs=sd.get("initial_docs"),
        attachments=sd.get("attachments", []),
        language=sd.get("language", "python"),
        max_iterations=sd.get("max_iterations", 5),
        current_iteration=0,
        auto_continue=sd.get("auto_continue", True),
        enable_code_execution=sd.get("enable_code_execution", True),
        execution_timeout=sd.get("execution_timeout", 60),
        max_fix_attempts=sd.get("max_fix_attempts", 3),
        auto_install_deps=sd.get("auto_install_deps", True),
        agent_timeout=sd.get("agent_timeout", 300),
        status=SessionStatus.CREATED,
        settings=sd.get("settings", {}),
        parent_session_id=None,
        enhancement_round=0,
    )
    db.add(new_session)
    await db.flush()

    # Agent configs
    for ac in data.get("agent_configs", []):
        db.add(AgentConfig(
            session_id=new_session_id,
            agent_type=ac["agent_type"],
            agent_index=ac.get("agent_index", 0),
            llm_provider=ac["llm_provider"],
            llm_model=ac["llm_model"],
            prompt_template_id=ac.get("prompt_template_id"),
            custom_prompt=ac.get("custom_prompt"),
            temperature=ac.get("temperature", 0.7),
            max_tokens=ac.get("max_tokens", 64000),
            enabled=ac.get("enabled", True),
        ))

    # Code versions -- build old->new ID map
    cv_id_map: dict[str, str] = {}
    for cv in data.get("code_versions", []):
        new_cv_id = str(uuid4())
        old_cv_id = cv["id"]
        cv_id_map[old_cv_id] = new_cv_id
        db.add(CodeVersion(
            id=new_cv_id,
            session_id=new_session_id,
            coder_index=cv["coder_index"],
            iteration=cv["iteration"],
            code_content=cv["code_content"],
            file_structure=cv.get("file_structure"),
            analysis=cv.get("analysis"),
            status=cv.get("status", "generated"),
        ))
    await db.flush()

    # Audits -- remap code_version_id
    for a in data.get("audits", []):
        new_cv_id = cv_id_map.get(a["code_version_id"])
        if not new_cv_id:
            continue  # skip orphaned audits
        db.add(Audit(
            id=str(uuid4()),
            session_id=new_session_id,
            code_version_id=new_cv_id,
            tester_index=a["tester_index"],
            iteration=a["iteration"],
            audit_content=a["audit_content"],
            overall_assessment=a.get("overall_assessment"),
            specification_compliance=a.get("specification_compliance"),
            issues=a.get("issues", []),
            positive_aspects=a.get("positive_aspects", []),
            test_cases_needed=a.get("test_cases_needed", []),
        ))

    # Code executions -- remap code_version_id
    for exe in data.get("code_executions", []):
        new_cv_id = cv_id_map.get(exe["code_version_id"])
        if not new_cv_id:
            continue
        db.add(CodeExecution(
            id=str(uuid4()),
            code_version_id=new_cv_id,
            executor_type=exe.get("executor_type", "docker"),
            command=exe.get("command"),
            exit_code=exe.get("exit_code"),
            stdout=exe.get("stdout"),
            stderr=exe.get("stderr"),
            execution_time_ms=exe.get("execution_time_ms"),
            memory_used_mb=exe.get("memory_used_mb"),
        ))

    # Summary audits
    for sa in data.get("summary_audits", []):
        db.add(SummaryAudit(
            id=str(uuid4()),
            session_id=new_session_id,
            coder_index=sa["coder_index"],
            iteration=sa["iteration"],
            summary_content=sa["summary_content"],
            critical_issues=sa.get("critical_issues", []),
            serious_issues=sa.get("serious_issues", []),
            minor_issues=sa.get("minor_issues", []),
            suggestions=sa.get("suggestions", []),
            consensus_notes=sa.get("consensus_notes"),
            recommended_focus=sa.get("recommended_focus", []),
        ))

    # Coder responses
    for cr in data.get("coder_responses", []):
        db.add(CoderResponse(
            id=str(uuid4()),
            session_id=new_session_id,
            coder_index=cr["coder_index"],
            iteration=cr["iteration"],
            accepted_issues=cr.get("accepted_issues", []),
            partial_issues=cr.get("partial_issues", []),
            rejected_issues=cr.get("rejected_issues", []),
            rejection_reasons=cr.get("rejection_reasons", {}),
        ))

    # LLM requests
    for lr in data.get("llm_requests", []):
        db.add(LLMRequestModel(
            id=str(uuid4()),
            session_id=new_session_id,
            agent_type=lr["agent_type"],
            agent_index=lr.get("agent_index", 0),
            iteration=lr["iteration"],
            llm_provider=lr["llm_provider"],
            llm_model=lr["llm_model"],
            prompt_sent=lr.get("prompt_sent", ""),
            response_received=lr.get("response_received", ""),
            input_tokens=lr.get("input_tokens", 0),
            output_tokens=lr.get("output_tokens", 0),
            cost_usd=lr.get("cost_usd", 0),
            latency_ms=lr.get("latency_ms", 0),
            success=lr.get("success", True),
            error_message=lr.get("error_message"),
        ))

    # Interventions
    for iv in data.get("interventions", []):
        db.add(Intervention(
            id=str(uuid4()),
            session_id=new_session_id,
            iteration=iv["iteration"],
            intervention_type=iv["intervention_type"],
            target_agent_type=iv.get("target_agent_type"),
            target_agent_index=iv.get("target_agent_index"),
            content=iv["content"],
            applied=iv.get("applied", False),
        ))

    # Enhancement suggestions
    for es in data.get("enhancement_suggestions", []):
        db.add(EnhancementSuggestion(
            id=str(uuid4()),
            session_id=new_session_id,
            agent_type=es["agent_type"],
            content=es["content"],
            user_recommendations=es.get("user_recommendations"),
            llm_provider=es["llm_provider"],
            llm_model=es["llm_model"],
            input_tokens=es.get("input_tokens", 0),
            output_tokens=es.get("output_tokens", 0),
            cost_usd=es.get("cost_usd", 0),
            latency_ms=es.get("latency_ms", 0),
        ))

    # Final result
    fr = data.get("final_result")
    if fr:
        db.add(FinalResult(
            id=str(uuid4()),
            session_id=new_session_id,
            selected_coder_index=fr["selected_coder_index"],
            final_code=fr["final_code"],
            file_structure=fr.get("file_structure"),
            readme_content=fr.get("readme_content", ""),
            api_docs=fr.get("api_docs"),
            report_pdf_path=None,  # not portable
            selection_reasoning=fr.get("selection_reasoning", ""),
            total_iterations=fr.get("total_iterations", 0),
            total_tokens=fr.get("total_tokens", 0),
            total_cost_usd=fr.get("total_cost_usd", 0),
            known_limitations=fr.get("known_limitations", []),
        ))

    return new_session_id


# ============================================================================
# Export / Import endpoints (must be before /{session_id} routes)
# ============================================================================


@router.post("/export")
async def export_sessions(
    session_ids: list[str] = Body(..., embed=True),
    db: AsyncSession = Depends(get_db),
):
    """Export one or more sessions to a JSON file."""
    MAX_EXPORT_SESSIONS = 100

    if not session_ids:
        raise HTTPException(status_code=400, detail="No session IDs provided")
    if len(session_ids) > MAX_EXPORT_SESSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Too many sessions requested for export (max {MAX_EXPORT_SESSIONS})",
        )

    stmt = (
        select(Session)
        .where(Session.id.in_(session_ids))
        .options(*_full_session_load_options())
    )
    result = await db.execute(stmt)
    sessions = result.scalars().unique().all()

    found_ids = {s.id for s in sessions}
    missing = [sid for sid in session_ids if sid not in found_ids]
    if missing:
        raise HTTPException(status_code=404, detail=f"Sessions not found: {', '.join(missing)}")

    export_data = {
        "version": "1.0",
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "sessions": [_serialize_session(s) for s in sessions],
    }

    json_bytes = json.dumps(export_data, ensure_ascii=False, indent=2).encode("utf-8")
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"codeforge-export-{timestamp}.json"

    return StreamingResponse(
        io.BytesIO(json_bytes),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.post("/import", response_model=ImportResponse | ImportCheckResponse)
async def import_sessions(
    file: UploadFile = File(...),
    confirm: bool = Query(default=False),
    db: AsyncSession = Depends(get_db),
):
    """Import sessions from an exported JSON file.

    First call (confirm=false): parses file and checks for duplicates.
    Second call (confirm=true): performs the actual import.
    """
    MAX_IMPORT_SIZE = 50 * 1024 * 1024  # 50 MB
    MAX_IMPORT_SESSIONS = 100

    content = await file.read(MAX_IMPORT_SIZE + 1)
    if len(content) > MAX_IMPORT_SIZE:
        raise HTTPException(status_code=413, detail=f"Import file too large (max {MAX_IMPORT_SIZE // (1024*1024)} MB)")

    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON file")

    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Invalid import format: expected JSON object")

    if data.get("version") != "1.0":
        raise HTTPException(status_code=400, detail="Unsupported export file version")

    sessions_data = data.get("sessions", [])
    if not isinstance(sessions_data, list):
        raise HTTPException(status_code=400, detail="Invalid import format: 'sessions' must be a list")
    if not sessions_data:
        raise HTTPException(status_code=400, detail="No sessions found in file")
    if len(sessions_data) > MAX_IMPORT_SESSIONS:
        raise HTTPException(status_code=400, detail=f"Too many sessions (max {MAX_IMPORT_SESSIONS})")

    # Check for duplicates
    duplicates: list[ImportDuplicateInfo] = []
    new_sessions: list[ImportNewInfo] = []

    for sd in sessions_data:
        sess = sd.get("session", {})
        name = sess.get("name", "")
        spec = sess.get("specification", "")
        spec_preview = spec[:200] + "..." if len(spec) > 200 else spec

        stmt = select(Session).where(
            Session.name == name,
            Session.specification == spec,
        )
        result = await db.execute(stmt)
        existing = result.scalar_one_or_none()

        if existing:
            duplicates.append(ImportDuplicateInfo(
                name=name,
                specification_preview=spec_preview,
                existing_session_id=str(existing.id),
            ))
        else:
            new_sessions.append(ImportNewInfo(
                name=name,
                specification_preview=spec_preview,
            ))

    has_duplicates = len(duplicates) > 0

    # Phase 1: just report duplicates
    if not confirm and has_duplicates:
        return ImportCheckResponse(
            duplicates=duplicates,
            new_sessions=new_sessions,
            total=len(sessions_data),
            has_duplicates=True,
        )

    # Phase 2: actually import
    imported_ids: list[str] = []
    dup_names = {d.name for d in duplicates}

    for sd in sessions_data:
        sess = sd.get("session", {})
        name = sess.get("name", "")
        rename = name in dup_names
        new_id = await _create_session_from_data(db, sd, rename=rename)
        imported_ids.append(new_id)

    await db.commit()

    return ImportResponse(
        imported_count=len(imported_ids),
        session_ids=imported_ids,
        message=f"Successfully imported {len(imported_ids)} session(s)",
    )


# Session CRUD
@router.get("/", response_model=PaginatedResponse[SessionListResponse])
async def list_sessions(
    status_filter: Optional[SessionStatus] = None,
    skip: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    """List all sessions with optional status filter."""
    # Count total matching sessions
    count_stmt = select(func.count(Session.id))
    if status_filter:
        count_stmt = count_stmt.where(Session.status == status_filter)
    total = (await db.execute(count_stmt)).scalar() or 0

    # Fetch paginated results
    stmt = select(Session).order_by(Session.created_at.desc())
    if status_filter:
        stmt = stmt.where(Session.status == status_filter)
    stmt = stmt.offset(skip).limit(limit)

    result = await db.execute(stmt)
    sessions = result.scalars().all()

    return PaginatedResponse(items=sessions, total=total, skip=skip, limit=limit)


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get session by ID with agent configs."""
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )

    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    return session


async def _validate_max_tokens(provider: str, model: str, max_tokens: int | None) -> int | None:
    """Validate max_tokens -- accept any reasonable value; each provider clamps to its own limit at runtime."""
    if max_tokens is None:
        return None
    if max_tokens < 1:
        raise HTTPException(status_code=400, detail="max_tokens must be at least 1")
    # No upper-bound rejection -- providers auto-clamp (e.g. Anthropic: Clamping 120000 -> 64000)
    return max_tokens


@router.post("/", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(
    session_data: SessionCreate,
    db: AsyncSession = Depends(get_db),
):
    """Create a new session with optional agent configs."""
    logger.info(f"Creating session: name={session_data.name}, language={session_data.language}, agents={len(session_data.agent_configs)}, attachments={len(session_data.attachments)}")
    if session_data.attachments:
        for att in session_data.attachments:
            logger.info(f"  Attachment: type={att.type}, files={len(att.files)}, url={att.url}")

    session = Session(
        name=session_data.name,
        specification=session_data.specification,
        original_specification=session_data.specification,
        initial_code=session_data.initial_code,
        initial_docs=session_data.initial_docs,
        attachments=[a.model_dump() for a in session_data.attachments],
        language=session_data.language,
        max_iterations=session_data.max_iterations,
        auto_continue=session_data.auto_continue,
        # Code execution settings
        enable_code_execution=session_data.enable_code_execution,
        execution_timeout=session_data.execution_timeout,
        max_fix_attempts=session_data.max_fix_attempts,
        auto_install_deps=session_data.auto_install_deps,
        agent_timeout=session_data.agent_timeout,
        status=SessionStatus.CREATED,
        settings=session_data.settings.model_dump(exclude_none=True) if session_data.settings else {},
    )
    db.add(session)
    await db.flush()

    # Add agent configs if provided
    if session_data.agent_configs:
        # Validate max_tokens for each agent config
        for config_data in session_data.agent_configs:
            if config_data.max_tokens:
                await _validate_max_tokens(config_data.llm_provider, config_data.llm_model, config_data.max_tokens)

        for config_data in session_data.agent_configs:
            config = AgentConfig(
                session_id=session.id,
                agent_type=config_data.agent_type,
                agent_index=config_data.agent_index,
                llm_provider=config_data.llm_provider,
                llm_model=config_data.llm_model,
                prompt_template_id=config_data.prompt_template_id,
                custom_prompt=config_data.custom_prompt,
                temperature=config_data.temperature,
                max_tokens=config_data.max_tokens,
            )
            db.add(config)
    else:
        # Add default agent config: 1 coder, 2 testers, 1 summarizer, 1 finalizer + 3 enhancers
        default_configs = [
            {"type": AgentType.CODER, "index": 0, "model": "claude-sonnet-4-6"},
            {"type": AgentType.TESTER, "index": 0, "model": "gpt-5.2-chat-latest"},
            {"type": AgentType.TESTER, "index": 1, "model": "gpt-5.2-chat-latest"},
            {"type": AgentType.SUMMARIZER, "index": 0, "model": "claude-sonnet-4-6"},
            {"type": AgentType.FINALIZER, "index": 0, "model": "claude-sonnet-4-6"},
            {"type": AgentType.ENHANCER_DESIGN, "index": 0, "model": "claude-sonnet-4-6"},
            {"type": AgentType.ENHANCER_FUNC, "index": 0, "model": "claude-sonnet-4-6"},
            {"type": AgentType.ENHANCER_SECURITY, "index": 0, "model": "claude-sonnet-4-6"},
        ]

        for cfg in default_configs:
            # Check if provider is available, fallback to another
            provider = LLMProvider.ANTHROPIC if "claude" in cfg["model"] else LLMProvider.OPENAI

            config = AgentConfig(
                session_id=session.id,
                agent_type=cfg["type"],
                agent_index=cfg["index"],
                llm_provider=provider,
                llm_model=cfg["model"],
            )
            db.add(config)

    await db.commit()

    # Re-query to get fresh data with relationships
    stmt = select(Session).where(Session.id == session.id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    fresh_session = result.scalar_one()

    return fresh_session


@router.patch("/{session_id}", response_model=SessionResponse)
async def update_session(
    session_id: UUID,
    session_data: SessionUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update session settings."""
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Fields that can always be updated (even while running)
    _ALWAYS_ALLOWED = {"name"}

    # Update only explicitly allowed fields (prevent overwriting id, status, etc.)
    _ALLOWED_UPDATE_FIELDS = {
        "name", "specification", "initial_code", "initial_docs",
        "language", "max_iterations", "enable_code_execution",
        "execution_timeout", "max_fix_attempts", "auto_install_deps",
        "auto_continue", "agent_timeout", "settings",
    }
    update_data = session_data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        if field not in _ALLOWED_UPDATE_FIELDS:
            raise HTTPException(
                status_code=400,
                detail=f"Field '{field}' cannot be updated",
            )
        # Block non-safe fields while session is running
        if session.status == SessionStatus.RUNNING and field not in _ALWAYS_ALLOWED:
            raise HTTPException(
                status_code=400,
                detail=f"Cannot update '{field}' while session is running",
            )
        if field == "settings" and isinstance(value, dict):
            existing = session.settings or {}
            existing.update(value)
            session.settings = existing
        else:
            setattr(session, field, value)
        # Keep original_specification in sync when user edits specification
        if field == "specification":
            session.original_specification = value

    await db.commit()

    # Re-query to get fresh data with relationships
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    fresh_session = result.scalar_one()

    return fresh_session


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Delete a session."""
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Don't allow deletion of running or enhancing sessions — #58
    if session.status in [SessionStatus.RUNNING, SessionStatus.ENHANCING]:
        raise HTTPException(
            status_code=400,
            detail="Cannot delete session while running or enhancing"
        )

    await db.delete(session)
    await db.commit()


# ============================================================================
# Copy session
# ============================================================================


@router.post("/{session_id}/copy", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def copy_session(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Create a full deep copy of a session with all related data."""
    stmt = (
        select(Session)
        .where(Session.id == session_id)
        .options(*_full_session_load_options())
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Serialize and recreate
    serialized = _serialize_session(session)
    new_id = await _create_session_from_data(db, serialized, rename=True)
    await db.commit()

    # Re-query new session with agent_configs for response
    stmt2 = (
        select(Session)
        .where(Session.id == new_id)
        .options(selectinload(Session.agent_configs))
    )
    result2 = await db.execute(stmt2)
    new_session = result2.scalar_one()
    return new_session


@router.post("/{session_id}/copy-structure", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def copy_session_structure(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Copy only the structure (agent configs + settings) of a session, without content or iteration data."""
    stmt = (
        select(Session)
        .where(Session.id == session_id)
        .options(selectinload(Session.agent_configs))
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    new_id = str(uuid4())
    new_session = Session(
        id=new_id,
        name=session.name + " (Structure)",
        specification="",
        original_specification="",
        initial_code=None,
        initial_docs=None,
        attachments=[],
        language=session.language,
        max_iterations=session.max_iterations,
        current_iteration=0,
        auto_continue=session.auto_continue,
        enable_code_execution=session.enable_code_execution,
        execution_timeout=session.execution_timeout,
        max_fix_attempts=session.max_fix_attempts,
        auto_install_deps=session.auto_install_deps,
        agent_timeout=session.agent_timeout,
        status=SessionStatus.CREATED,
        settings=session.settings or {},
        parent_session_id=None,
        enhancement_round=0,
    )
    db.add(new_session)
    await db.flush()

    for ac in session.agent_configs:
        new_ac = AgentConfig(
            session_id=new_id,
            agent_type=ac.agent_type,
            agent_index=ac.agent_index,
            llm_provider=ac.llm_provider,
            llm_model=ac.llm_model,
            prompt_template_id=ac.prompt_template_id,
            custom_prompt=ac.custom_prompt,
            temperature=ac.temperature,
            max_tokens=ac.max_tokens,
            thinking_effort=ac.thinking_effort,
            enabled=ac.enabled,
        )
        db.add(new_ac)

    await db.commit()

    stmt2 = (
        select(Session)
        .where(Session.id == new_id)
        .options(selectinload(Session.agent_configs))
    )
    result2 = await db.execute(stmt2)
    return result2.scalar_one()


# Session workflow control
@router.post("/{session_id}/start", response_model=SessionResponse)
async def start_session(
    session_id: UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Start the workflow for a session."""
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status not in [SessionStatus.CREATED, SessionStatus.PAUSED]:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot start session in {session.status} status"
        )

    # Validate agent configs
    has_coder = any(c.agent_type == AgentType.CODER for c in session.agent_configs)
    has_tester = any(c.agent_type == AgentType.TESTER for c in session.agent_configs)

    if not has_coder:
        raise HTTPException(
            status_code=400,
            detail="Session must have at least one coder agent"
        )

    if not has_tester:
        raise HTTPException(
            status_code=400,
            detail="Session must have at least one tester agent"
        )

    # Compare-and-swap: atomically set status to RUNNING only if it is still
    # in a startable state.  If another request already flipped the status,
    # the WHERE clause won't match and rowcount will be 0.
    cas_stmt = (
        update(Session)
        .where(Session.id == session_id)
        .where(Session.status.in_([SessionStatus.CREATED, SessionStatus.PAUSED]))
        .values(status=SessionStatus.RUNNING)
    )
    cas_result = await db.execute(cas_stmt)
    await db.commit()

    if cas_result.rowcount == 0:
        raise HTTPException(
            status_code=409,
            detail="Session is already running or was started by another request",
        )

    # Expire the cached ORM object so subsequent reads see the new status
    await db.refresh(session)

    # Create orchestrator and run in background
    async def run_workflow():
        from app.db.database import AsyncSessionLocal
        async with AsyncSessionLocal() as db_session:
            # Reload session with fresh db session
            stmt = select(Session).where(Session.id == session_id).options(
                selectinload(Session.agent_configs)
            )
            result = await db_session.execute(stmt)
            session_obj = result.scalar_one()

            orchestrator = WorkflowOrchestrator(
                db=db_session,
                session=session_obj,
                event_callback=session_manager.broadcast,
            )
            sid = str(session_id)
            await session_manager.register_orchestrator(sid, orchestrator)
            try:
                await orchestrator.run()
            finally:
                await session_manager.unregister_orchestrator(sid)

    background_tasks.add_task(run_workflow)

    # Re-query to get fresh data with relationships
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    fresh_session = result.scalar_one()

    return fresh_session


@router.post("/{session_id}/pause", response_model=SessionResponse)
async def pause_session(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Pause a running session.

    Signals the orchestrator to pause between phases.  The orchestrator
    will update the DB status to PAUSED when it actually stops.  We
    don't overwrite the status here to avoid a race where the
    orchestrator is mid-commit.
    """
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status != SessionStatus.RUNNING:
        raise HTTPException(
            status_code=400,
            detail="Can only pause running sessions"
        )

    # Signal orchestrator to pause (it will update DB status itself)
    paused = await session_manager.pause_session(str(session_id))
    if not paused:
        # Orchestrator not registered (already finished?) -- use CAS to mark paused (#59)
        cas_stmt = (
            update(Session)
            .where(Session.id == session_id)
            .where(Session.status == SessionStatus.RUNNING)
            .values(status=SessionStatus.PAUSED)
        )
        cas_result = await db.execute(cas_stmt)
        await db.commit()
        if cas_result.rowcount == 0:
            raise HTTPException(
                status_code=409,
                detail="Session cannot be paused in its current state",
            )

    # Re-query to get fresh data with relationships
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    fresh_session = result.scalar_one()

    return fresh_session


@router.post("/{session_id}/resume", response_model=SessionResponse)
async def resume_session(
    session_id: UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Resume a paused session.

    Signals the orchestrator to un-pause.  The orchestrator (still
    running its ``run()`` loop) picks up the flag and continues.
    The DB status is set back to RUNNING by the orchestrator.
    """
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status != SessionStatus.PAUSED:
        raise HTTPException(
            status_code=400,
            detail="Can only resume paused sessions"
        )

    # Signal orchestrator to resume (non-blocking -- the orchestrator
    # loop is sleeping inside _wait_if_paused and will wake up)
    resumed = await session_manager.resume_session(str(session_id))
    if not resumed:
        # Orchestrator not registered (e.g. server restarted while paused).
        # Use CAS to avoid double-start race, then re-create orchestrator.
        cas_stmt = (
            update(Session)
            .where(Session.id == session_id)
            .where(Session.status == SessionStatus.PAUSED)
            .values(status=SessionStatus.RUNNING)
        )
        cas_result = await db.execute(cas_stmt)
        await db.commit()

        if cas_result.rowcount == 0:
            raise HTTPException(
                status_code=409,
                detail="Session was already resumed by another request",
            )

        # Re-create orchestrator and run in background to avoid zombie
        async def resume_workflow():
            from app.db.database import AsyncSessionLocal
            async with AsyncSessionLocal() as db_session:
                stmt_inner = select(Session).where(Session.id == session_id).options(
                    selectinload(Session.agent_configs)
                )
                result_inner = await db_session.execute(stmt_inner)
                session_obj = result_inner.scalar_one()

                orchestrator = WorkflowOrchestrator(
                    db=db_session,
                    session=session_obj,
                    event_callback=session_manager.broadcast,
                )
                sid = str(session_id)
                await session_manager.register_orchestrator(sid, orchestrator)
                try:
                    await orchestrator.run()
                finally:
                    await session_manager.unregister_orchestrator(sid)

        background_tasks.add_task(resume_workflow)

    # Re-query to get fresh data with relationships
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    fresh_session = result.scalar_one()

    return fresh_session


@router.post("/{session_id}/cancel", response_model=SessionResponse)
async def cancel_session(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Cancel a session.

    Signals the orchestrator to stop.  Uses CAS to atomically set
    CANCELLED status only from valid source states.
    """
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status in [SessionStatus.COMPLETED, SessionStatus.FAILED]:
        raise HTTPException(
            status_code=400,
            detail="Cannot cancel completed or failed sessions"
        )

    # Signal cancellation -- also wakes up a paused orchestrator
    await session_manager.cancel_session(str(session_id))

    # #6 CAS guard: atomically set CANCELLED only from RUNNING or PAUSED
    cas_stmt = (
        update(Session)
        .where(Session.id == session_id)
        .where(Session.status.in_([SessionStatus.RUNNING, SessionStatus.PAUSED]))
        .values(status=SessionStatus.CANCELLED)
    )
    cas_result = await db.execute(cas_stmt)
    await db.commit()
    if cas_result.rowcount == 0:
        raise HTTPException(status_code=409, detail="Session cannot be cancelled in its current state")

    # Re-query to get fresh data with relationships
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    fresh_session = result.scalar_one()

    return fresh_session


@router.post("/{session_id}/reset", response_model=SessionResponse)
async def reset_session(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Reset a session back to 'created' status so it can be re-started.

    Deletes all run artifacts (code versions, audits, LLM requests, etc.)
    while preserving the session itself and its agent configs.
    """
    from sqlalchemy import delete as sa_delete

    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status in [SessionStatus.RUNNING, SessionStatus.ENHANCING]:
        # Stop the running orchestrator / enhancement agents first
        await session_manager.cancel_session(str(session_id))

    # Delete all run artifacts (order matters for FK constraints)
    # 1. Code executions (FK -> code_versions)
    cv_ids_stmt = select(CodeVersion.id).where(CodeVersion.session_id == session_id)
    await db.execute(
        sa_delete(CodeExecution).where(CodeExecution.code_version_id.in_(cv_ids_stmt))
    )
    # 2. Audits (FK -> code_versions)
    await db.execute(sa_delete(Audit).where(Audit.session_id == session_id))
    # 3. Code versions
    await db.execute(sa_delete(CodeVersion).where(CodeVersion.session_id == session_id))
    # 4. Summary audits
    await db.execute(sa_delete(SummaryAudit).where(SummaryAudit.session_id == session_id))
    # 5. Coder responses
    await db.execute(sa_delete(CoderResponse).where(CoderResponse.session_id == session_id))
    # 6. LLM requests
    await db.execute(sa_delete(LLMRequestModel).where(LLMRequestModel.session_id == session_id))
    # 7. Interventions
    await db.execute(sa_delete(Intervention).where(Intervention.session_id == session_id))
    # 8. Final result
    await db.execute(sa_delete(FinalResult).where(FinalResult.session_id == session_id))
    # 9. Enhancement suggestions
    await db.execute(sa_delete(EnhancementSuggestion).where(EnhancementSuggestion.session_id == session_id))

    # Delete enhancer agent configs (they are only relevant for enhancement flow)
    enhancer_types = ['enhancer_design', 'enhancer_func', 'enhancer_security', 'enhancer_summary']
    await db.execute(
        sa_delete(AgentConfig).where(
            AgentConfig.session_id == session_id,
            AgentConfig.agent_type.in_(enhancer_types),
        )
    )

    # Reset session state -- preserve initial_docs and settings (#60, #109)
    session.status = SessionStatus.CREATED
    session.current_iteration = 0
    session.parent_session_id = None
    session.enhancement_round = 0
    # Restore original specification (strip enhancement text added by apply_enhancements)
    if session.original_specification:
        session.specification = session.original_specification
        session.original_specification = None
    # Clear initial_code that was injected by apply_enhancements
    # (the final code of the parent session). Without this, reset
    # sessions start coders from old code instead of from scratch.
    session.initial_code = None
    await db.commit()
    db.expire_all()  # Clear ORM cache so re-query picks up deleted enhancer configs

    logger.info(f"Session {session_id} reset: all run artifacts and enhancement data cleared")

    # Re-query to get fresh data with relationships
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    fresh_session = result.scalar_one()

    return fresh_session


@router.post("/{session_id}/re-finalize", response_model=SessionResponse)
async def re_finalize_session(
    session_id: UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Re-run only the finalization phase on existing coder outputs.

    Requires the session to have completed at least one coding cycle
    (code versions must exist). Replaces the current final result.
    """
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    allowed_statuses = [
        SessionStatus.COMPLETED,
        SessionStatus.FAILED,
        SessionStatus.AWAITING_ENHANCEMENT,
    ]
    if session.status not in allowed_statuses:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot re-finalize session in '{session.status}' status. "
                   f"Allowed: {[s.value for s in allowed_statuses]}"
        )

    # Verify code versions exist
    cv_count = (await db.execute(
        select(func.count(CodeVersion.id)).where(CodeVersion.session_id == session_id)
    )).scalar() or 0
    if cv_count == 0:
        raise HTTPException(
            status_code=400,
            detail="No code versions found. Run the full workflow first."
        )

    # Verify finalizer agent is configured
    has_finalizer = any(
        c.agent_type == AgentType.FINALIZER
        for c in session.agent_configs
    )
    if not has_finalizer:
        raise HTTPException(
            status_code=400,
            detail="Session must have a finalizer agent configured"
        )

    # CAS: atomically set status to RUNNING
    cas_stmt = (
        update(Session)
        .where(Session.id == session_id)
        .where(Session.status.in_([s.value for s in allowed_statuses]))
        .values(status=SessionStatus.RUNNING)
    )
    cas_result = await db.execute(cas_stmt)
    await db.commit()

    if cas_result.rowcount == 0:
        raise HTTPException(
            status_code=409,
            detail="Session status changed concurrently. Try again.",
        )

    await db.refresh(session)

    # Delete enhancement suggestions (they reference the old final result)
    from sqlalchemy import delete as sa_delete
    await db.execute(
        sa_delete(EnhancementSuggestion).where(
            EnhancementSuggestion.session_id == session_id
        )
    )
    await db.commit()

    # Run re-finalization in background
    async def run_refinalize():
        from app.db.database import AsyncSessionLocal
        async with AsyncSessionLocal() as db_session:
            stmt = select(Session).where(Session.id == session_id).options(
                selectinload(Session.agent_configs)
            )
            result = await db_session.execute(stmt)
            session_obj = result.scalar_one()

            orchestrator = WorkflowOrchestrator(
                db=db_session,
                session=session_obj,
                event_callback=session_manager.broadcast,
            )
            sid = str(session_id)
            await session_manager.register_orchestrator(sid, orchestrator)
            try:
                await orchestrator.run_finalization_only()
            finally:
                await session_manager.unregister_orchestrator(sid)

    background_tasks.add_task(run_refinalize)

    # Re-query to get fresh data with relationships
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    fresh_session = result.scalar_one()

    return fresh_session


# Agent config management
@router.get("/{session_id}/agents", response_model=List[AgentConfigResponse])
async def list_agent_configs(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """List all agent configs for a session."""
    stmt = select(AgentConfig).where(AgentConfig.session_id == session_id)
    result = await db.execute(stmt)
    configs = result.scalars().all()
    return configs


@router.post("/{session_id}/agents", response_model=AgentConfigResponse)
async def add_agent_config(
    session_id: UUID,
    config_data: AgentConfigCreate,
    db: AsyncSession = Depends(get_db),
):
    """Add an agent config to a session."""
    # Verify session exists and is configurable
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    if session.status in [SessionStatus.RUNNING, SessionStatus.ENHANCING]:
        raise HTTPException(
            status_code=400,
            detail="Cannot modify agents while session is running"
        )

    # Check for duplicate -- if exists, update instead of rejecting
    stmt = select(AgentConfig).where(
        AgentConfig.session_id == session_id,
        AgentConfig.agent_type == config_data.agent_type,
        AgentConfig.agent_index == config_data.agent_index,
    )
    result = await db.execute(stmt)
    existing = result.scalar_one_or_none()
    if existing:
        existing.llm_provider = config_data.llm_provider
        existing.llm_model = config_data.llm_model
        if config_data.thinking_effort is not None:
            existing.thinking_effort = config_data.thinking_effort
        if config_data.max_tokens is not None:
            existing.max_tokens = config_data.max_tokens
        await db.commit()
        await db.refresh(existing)
        return existing

    config = AgentConfig(
        session_id=session_id,
        agent_type=config_data.agent_type,
        agent_index=config_data.agent_index,
        llm_provider=config_data.llm_provider,
        llm_model=config_data.llm_model,
        prompt_template_id=config_data.prompt_template_id,
        custom_prompt=config_data.custom_prompt,
        thinking_effort=config_data.thinking_effort,
        max_tokens=config_data.max_tokens,
    )
    db.add(config)
    await db.commit()
    await db.refresh(config)

    return config


@router.patch("/{session_id}/agents/{agent_id}", response_model=AgentConfigResponse)
async def update_agent_config(
    session_id: UUID,
    agent_id: int,
    config_data: AgentConfigUpdate,
    db: AsyncSession = Depends(get_db),
):
    """Update an agent config."""
    stmt = select(AgentConfig).where(
        AgentConfig.id == agent_id,
        AgentConfig.session_id == session_id,
    )
    result = await db.execute(stmt)
    config = result.scalar_one_or_none()

    if not config:
        raise HTTPException(status_code=404, detail="Agent config not found")

    # Verify session is not actively running
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one()

    # Enhancer agents can be configured while main pipeline runs (they execute later).
    # Block only when enhancement is actively running. Non-enhancer agents blocked in both.
    is_enhancer_agent = config.agent_type in (
        "enhancer_design", "enhancer_func", "enhancer_security", "enhancer_summary"
    )
    if session.status == SessionStatus.ENHANCING:
        raise HTTPException(
            status_code=400,
            detail="Cannot modify agents while enhancement is running"
        )
    if session.status == SessionStatus.RUNNING and not is_enhancer_agent:
        raise HTTPException(
            status_code=400,
            detail="Cannot modify agents while session is running"
        )

    # Update fields
    update_data = config_data.model_dump(exclude_unset=True)

    # Validate max_tokens against model limit
    if "max_tokens" in update_data and update_data["max_tokens"] is not None:
        # Use the new model if being changed, otherwise the existing one
        provider = update_data.get("llm_provider") or config.llm_provider
        model = update_data.get("llm_model") or config.llm_model
        await _validate_max_tokens(provider, model, update_data["max_tokens"])

    for field, value in update_data.items():
        setattr(config, field, value)

    await db.commit()
    await db.refresh(config)

    return config


@router.delete("/{session_id}/agents/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_agent_config(
    session_id: UUID,
    agent_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Delete an agent config."""
    stmt = select(AgentConfig).where(
        AgentConfig.id == agent_id,
        AgentConfig.session_id == session_id,
    )
    result = await db.execute(stmt)
    config = result.scalar_one_or_none()

    if not config:
        raise HTTPException(status_code=404, detail="Agent config not found")

    # Verify session is not actively running
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one()

    if session.status in [SessionStatus.RUNNING, SessionStatus.ENHANCING]:
        raise HTTPException(
            status_code=400,
            detail="Cannot modify agents while session is running"
        )

    await db.delete(config)
    await db.commit()


# ============================================================================
# Enhancement Endpoint
# ============================================================================


async def _run_enhancement(
    session_id: UUID,
    enhance_request: EnhanceRequest,
    db: AsyncSession,
):
    """Background task: run enhancer agents, summarize, stop for user review."""
    import asyncio
    import json
    from app.llm.router import get_llm_router
    from app.agents.enhancer import (
        DesignEnhancerAgent,
        FunctionalityEnhancerAgent,
        SecurityEnhancerAgent,
        EnhancementSummarizerAgent,
    )

    llm_router = await get_llm_router()

    # 1. Load session + final result and set status to ENHANCING
    stmt = select(Session).options(selectinload(Session.agent_configs)).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one()

    session.status = SessionStatus.ENHANCING
    await db.commit()

    try:
        stmt_fr = select(FinalResult).where(FinalResult.session_id == session_id)
        result_fr = await db.execute(stmt_fr)
        final_result = result_fr.scalar_one()

        final_code = final_result.final_code
        specification = session.specification

        # Build full specification with attachments
        full_specification = specification
        attachments = session.attachments or []
        if attachments:
            file_sections = []
            for att in attachments:
                att_type = att.get('type', '') if isinstance(att, dict) else ''
                if att_type in ('file', 'archive', 'repo'):
                    files = att.get('files', []) if att_type in ('archive', 'repo') else [att]
                    for f in files:
                        path = f.get('path', f.get('filename', ''))
                        content = f.get('content', '')
                        if content:
                            file_sections.append(f"### File: {path}\n```\n{content}\n```")
            if file_sections:
                full_specification += "\n\n## ATTACHED FILES\n" + "\n\n".join(file_sections)

        await session_manager.broadcast("enhancer_started", {
            "session_id": session_id,
            "agents": [e.type for e in enhance_request.enhancers if e.enabled],
        })

        # 2. Run enabled enhancer agents in parallel
        agent_map = {
            "enhancer_design": DesignEnhancerAgent,
            "enhancer_func": FunctionalityEnhancerAgent,
            "enhancer_security": SecurityEnhancerAgent,
        }

        agent_timeout = session.agent_timeout or 300
        tasks = []
        task_configs = []
        for cfg in enhance_request.enhancers:
            if not cfg.enabled:
                continue
            agent_cls = agent_map.get(cfg.type)
            if not agent_cls:
                logger.warning(f"Unknown enhancer type: {cfg.type}")
                continue

            agent = agent_cls(
                llm_router=llm_router,
                provider=cfg.provider,
                model=cfg.model,
            )
            tasks.append(asyncio.wait_for(
                agent.execute(
                    specification=full_specification,
                    code=final_code,
                    language=session.language,
                    recommendations=cfg.recommendations,
                ),
                timeout=agent_timeout,
            ))
            task_configs.append(cfg)

            await session_manager.broadcast("enhancer_agent_started", {
                "session_id": session_id,
                "agent_type": cfg.type,
            })

        results = await asyncio.gather(*tasks, return_exceptions=True)

        # 3. Save suggestions and collect for summarizer
        all_suggestions = {"design": None, "functionality": None, "security": None}
        suggestion_type_map = {
            "enhancer_design": "design",
            "enhancer_func": "functionality",
            "enhancer_security": "security",
        }

        for cfg, agent_result in zip(task_configs, results):
            if isinstance(agent_result, asyncio.TimeoutError):
                logger.error(f"Enhancer {cfg.type} timed out after {agent_timeout}s")
                await session_manager.broadcast("enhancer_agent_error", {
                    "session_id": session_id,
                    "agent_type": cfg.type,
                    "error": f"Enhancer timed out after {agent_timeout}s",
                })
                continue
            if isinstance(agent_result, Exception):
                logger.error(f"Enhancer {cfg.type} failed: {agent_result}")
                await session_manager.broadcast("enhancer_agent_error", {
                    "session_id": session_id,
                    "agent_type": cfg.type,
                    "error": str(agent_result),
                })
                continue

            if not agent_result.success:
                logger.error(f"Enhancer {cfg.type} returned error: {agent_result.error}")
                await session_manager.broadcast("enhancer_agent_error", {
                    "session_id": session_id,
                    "agent_type": cfg.type,
                    "error": agent_result.error or "Unknown error",
                })
                continue

            # Save to DB
            suggestion = EnhancementSuggestion(
                session_id=session_id,
                agent_type=cfg.type,
                content=agent_result.content,
                user_recommendations=cfg.recommendations,
                llm_provider=cfg.provider,
                llm_model=cfg.model,
                input_tokens=agent_result.input_tokens,
                output_tokens=agent_result.output_tokens,
                cost_usd=agent_result.cost_usd,
                latency_ms=agent_result.latency_ms,
            )
            db.add(suggestion)

            key = suggestion_type_map.get(cfg.type)
            if key and agent_result.parsed_data:
                all_suggestions[key] = json.dumps(agent_result.parsed_data, indent=2)

            await session_manager.broadcast("enhancer_agent_completed", {
                "session_id": session_id,
                "agent_type": cfg.type,
                "suggestions_count": len(agent_result.parsed_data.get("suggestions", [])) if agent_result.parsed_data else 0,
            })

        await db.commit()

        # 4. Run Enhancement Summarizer
        await session_manager.broadcast("enhancer_summarizer_started", {
            "session_id": session_id,
        })

        summarizer_cfg = enhance_request.summarizer
        summarizer = EnhancementSummarizerAgent(
            llm_router=llm_router,
            provider=summarizer_cfg.provider,
            model=summarizer_cfg.model,
        )

        try:
            summary_result = await asyncio.wait_for(
                summarizer.execute(
                    specification=full_specification,
                    code=final_code,
                    language=session.language,
                    design_suggestions=all_suggestions["design"],
                    functionality_suggestions=all_suggestions["functionality"],
                    security_suggestions=all_suggestions["security"],
                ),
                timeout=agent_timeout,
            )
        except asyncio.TimeoutError:
            logger.error(f"Enhancement summarizer timed out after {agent_timeout}s")
            await session_manager.broadcast("enhancer_summarizer_error", {
                "session_id": session_id,
                "error": f"Enhancement summarizer timed out after {agent_timeout}s",
            })
            # Still proceed to review with whatever suggestions we have
            session.status = SessionStatus.AWAITING_ENHANCEMENT_REVIEW
            await db.commit()
            await session_manager.broadcast("awaiting_enhancement_review", {
                "session_id": session_id,
                "message": "Enhancement analysis partially complete (summarizer timed out). Review available suggestions.",
            })
            return

        # Save summary suggestion
        summary_suggestion = EnhancementSuggestion(
            session_id=session_id,
            agent_type="enhancer_summary",
            content=summary_result.content,
            llm_provider=summarizer_cfg.provider,
            llm_model=summarizer_cfg.model,
            input_tokens=summary_result.input_tokens,
            output_tokens=summary_result.output_tokens,
            cost_usd=summary_result.cost_usd,
            latency_ms=summary_result.latency_ms,
        )
        db.add(summary_suggestion)
        await db.commit()

        await session_manager.broadcast("enhancer_summarizer_completed", {
            "session_id": session_id,
        })

        # 5. Set status to awaiting review -- user will curate suggestions
        session.status = SessionStatus.AWAITING_ENHANCEMENT_REVIEW
        await db.commit()

        await session_manager.broadcast("awaiting_enhancement_review", {
            "session_id": session_id,
            "message": "Enhancement analysis complete. Review and curate suggestions.",
        })

        logger.info(f"Enhancement analysis complete for session {session_id}, awaiting user review")

    except Exception as exc:
        logger.exception(f"Enhancement failed for session {session_id}: {exc}")
        # Roll back any uncommitted changes; outer wrapper handles status update
        await db.rollback()
        raise


@router.post("/{session_id}/enhance", response_model=EnhanceResponse)
async def enhance_session(
    session_id: UUID,
    request: EnhanceRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Start enhancement process on a completed session.

    Runs enhancer agents (design/functionality/security), summarizes suggestions,
    creates a new session with enhanced specification, and auto-starts it.
    """
    # Validate session exists and is completed
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Allow re-running enhancements from review state too
    allowed = (
        SessionStatus.COMPLETED,
        SessionStatus.AWAITING_ENHANCEMENT,
        SessionStatus.AWAITING_ENHANCEMENT_REVIEW,
        SessionStatus.CREATED,
    )
    if session.status not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Session must be completed, awaiting enhancement, or created with code (current: {session.status})"
        )

    # Validate has final result
    stmt_fr = select(FinalResult).where(FinalResult.session_id == session_id)
    result_fr = await db.execute(stmt_fr)
    final_result = result_fr.scalar_one_or_none()

    if not final_result:
        raise HTTPException(status_code=400, detail="Session has no final result")

    # Validate at least one enhancer enabled
    enabled_enhancers = [e for e in request.enhancers if e.enabled]
    if not enabled_enhancers:
        raise HTTPException(status_code=400, detail="At least one enhancer must be enabled")

    # #7 CAS guard: prevent double-enhancement
    cas_stmt = (
        update(Session)
        .where(Session.id == session_id)
        .where(Session.status.in_([SessionStatus.COMPLETED, SessionStatus.AWAITING_ENHANCEMENT, SessionStatus.CREATED]))
        .values(status=SessionStatus.ENHANCING)
    )
    cas_result = await db.execute(cas_stmt)
    await db.commit()
    if cas_result.rowcount == 0:
        raise HTTPException(
            status_code=409,
            detail="Session is already being enhanced or has changed state",
        )

    # Remember original status so we can restore it on failure
    original_status = session.status

    # Run enhancement in background
    async def run_enhancement():
        from app.db.database import AsyncSessionLocal
        async with AsyncSessionLocal() as bg_db:
            try:
                await _run_enhancement(session_id, request, bg_db)
            except Exception as e:
                logger.exception(f"Enhancement failed for session {session_id}: {e}")
                # Reset status back to original (COMPLETED, AWAITING_ENHANCEMENT, or CREATED)
                rollback_status = (
                    original_status if original_status in (SessionStatus.COMPLETED, SessionStatus.CREATED)
                    else SessionStatus.AWAITING_ENHANCEMENT
                )
                try:
                    stmt = select(Session).where(Session.id == session_id)
                    r = await bg_db.execute(stmt)
                    s = r.scalar_one_or_none()
                    if s:
                        s.status = rollback_status
                        await bg_db.commit()
                except Exception as reset_exc:
                    logger.error(f"Failed to reset session {session_id} status after enhancement failure: {reset_exc}")
                await session_manager.broadcast("enhancer_error", {
                    "session_id": session_id,
                    "error": str(e),
                })

    background_tasks.add_task(run_enhancement)

    return EnhanceResponse(
        enhancement_session_id="pending",
        parent_session_id=str(session_id),
        enhancement_round=session.enhancement_round + 1,
        suggestions_count=len(enabled_enhancers),
        message=f"Enhancement started with {len(enabled_enhancers)} agent(s)",
    )


@router.get("/{session_id}/enhancement-suggestions", response_model=list[EnhancementSuggestionResponse])
async def get_enhancement_suggestions(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get enhancement suggestions for a session."""
    stmt = select(EnhancementSuggestion).where(
        EnhancementSuggestion.session_id == session_id
    ).order_by(EnhancementSuggestion.created_at)
    result = await db.execute(stmt)
    return result.scalars().all()


@router.post("/{session_id}/apply-enhancements", response_model=ApplyEnhancementsResponse)
async def apply_enhancements(
    session_id: UUID,
    request: ApplyEnhancementsRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    """Apply curated enhancement suggestions -- creates a new session with
    original specification + final code + curated enhancement list, then starts it.
    """
    # #8 CAS guard: prevent duplicate child sessions
    cas_stmt = (
        update(Session)
        .where(Session.id == session_id)
        .where(Session.status == SessionStatus.AWAITING_ENHANCEMENT_REVIEW)
        .values(status=SessionStatus.COMPLETED)
    )
    cas_result = await db.execute(cas_stmt)
    await db.commit()
    if cas_result.rowcount == 0:
        raise HTTPException(
            status_code=409,
            detail="Session is not awaiting enhancement review or was already applied",
        )

    # Validate session
    stmt = select(Session).options(selectinload(Session.agent_configs)).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Get final result
    stmt_fr = select(FinalResult).where(FinalResult.session_id == session_id)
    result_fr = await db.execute(stmt_fr)
    final_result = result_fr.scalar_one_or_none()

    if not final_result:
        raise HTTPException(status_code=400, detail="Session has no final result")

    # Build compact enhancement text from curated suggestions (one line per item)
    enhancement_lines = ["## ENHANCEMENTS"]
    for s in request.curated_suggestions:
        enhancement_lines.append(f"- [{s.priority.upper()}] {s.title}: {s.description}")
    enhancement_text = "\n".join(enhancement_lines)

    # Start from original specification (attachments handled by orchestrator at runtime)
    full_specification = session.specification

    # Strip any prior enhancement text to prevent cascading growth across rounds
    full_specification = _re.split(
        r'\n*## (?:ENHANCEMENTS|ENHANCEMENT IMPROVEMENTS TO IMPLEMENT)\b',
        full_specification, maxsplit=1,
    )[0].rstrip()

    # Strip any previously-embedded attachment sections (orchestrator adds them at runtime)
    full_specification = _re.split(
        r'\n*## ATTACHED FILES\b',
        full_specification, maxsplit=1,
    )[0].rstrip()

    enhanced_spec = full_specification + "\n\n" + enhancement_text
    enhancement_round = session.enhancement_round + 1

    # Strip prior enhancement suffix to prevent cascading names
    base_name = _re.sub(r'\s*—\s*(?:Enhancement|Enh)\s*#\d+$', '', session.name)

    # Create new session (preserve original_specification from parent for reset)
    new_session = Session(
        name=f"{base_name} — Enh #{enhancement_round}",
        specification=enhanced_spec,
        original_specification=session.original_specification or session.specification,
        initial_code=final_result.final_code,
        initial_docs=session.initial_docs,
        attachments=session.attachments or [],
        language=session.language,
        max_iterations=session.max_iterations,
        auto_continue=session.auto_continue,
        enable_code_execution=session.enable_code_execution,
        execution_timeout=session.execution_timeout,
        max_fix_attempts=session.max_fix_attempts,
        auto_install_deps=session.auto_install_deps,
        agent_timeout=session.agent_timeout,
        settings=session.settings or {},
        parent_session_id=session_id,
        enhancement_round=enhancement_round,
    )
    db.add(new_session)
    await db.flush()
    new_session_id = new_session.id

    # Copy only core agent configs (exclude enhancer types to prevent infinite loops)
    _CORE_AGENT_TYPES = {AgentType.CODER, AgentType.TESTER, AgentType.SUMMARIZER, AgentType.FINALIZER}
    for config in session.agent_configs:
        if config.agent_type not in _CORE_AGENT_TYPES:
            continue
        new_config = AgentConfig(
            session_id=new_session_id,
            agent_type=config.agent_type,
            agent_index=config.agent_index,
            llm_provider=config.llm_provider,
            llm_model=config.llm_model,
            prompt_template_id=config.prompt_template_id,
            custom_prompt=config.custom_prompt,
            temperature=config.temperature,
            max_tokens=config.max_tokens,
        )
        db.add(new_config)

    await db.commit()

    await session_manager.broadcast("enhancement_session_created", {
        "session_id": session_id,
        "new_session_id": new_session_id,
        "enhancement_round": enhancement_round,
        "suggestions_applied": len(request.curated_suggestions),
    })

    # Auto-start new session in background
    async def start_new_session():
        from app.db.database import AsyncSessionLocal
        async with AsyncSessionLocal() as bg_db:
            # CAS guard: only start if session is still in CREATED state
            cas = (
                update(Session)
                .where(Session.id == new_session_id)
                .where(Session.status == SessionStatus.CREATED)
                .values(status=SessionStatus.RUNNING)
            )
            cas_result = await bg_db.execute(cas)
            if cas_result.rowcount == 0:
                logger.warning(f"Session {new_session_id} already started, skipping")
                return
            await bg_db.commit()

            stmt = select(Session).options(selectinload(Session.agent_configs)).where(Session.id == new_session_id)
            result = await bg_db.execute(stmt)
            ns = result.scalar_one()

            orchestrator = WorkflowOrchestrator(
                db=bg_db,
                session=ns,
                event_callback=session_manager.broadcast,
            )
            await session_manager.register_orchestrator(str(new_session_id), orchestrator)
            try:
                await orchestrator.run()
            finally:
                await session_manager.unregister_orchestrator(str(new_session_id))

    background_tasks.add_task(start_new_session)

    return ApplyEnhancementsResponse(
        new_session_id=str(new_session_id),
        parent_session_id=str(session_id),
        enhancement_round=enhancement_round,
        suggestions_applied=len(request.curated_suggestions),
        message=f"Enhancement session created with {len(request.curated_suggestions)} improvements",
    )


@router.post("/{session_id}/complete", response_model=SessionResponse)
async def complete_session(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    """Mark a session as completed, skipping enhancement.
    Works for sessions in awaiting_enhancement or awaiting_enhancement_review status.
    """
    stmt = select(Session).where(Session.id == session_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    allowed = {SessionStatus.AWAITING_ENHANCEMENT, SessionStatus.AWAITING_ENHANCEMENT_REVIEW}
    if session.status not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"Session must be awaiting enhancement or review (current: {session.status})"
        )

    session.status = SessionStatus.COMPLETED
    await db.commit()

    await session_manager.broadcast("workflow_completed", {
        "session_id": session_id,
        "message": "Session completed (enhancement skipped)",
    })

    # Re-query to get fresh data with relationships
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    fresh_session = result.scalar_one()

    return fresh_session
