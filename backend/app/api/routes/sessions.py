"""
Session management API routes. v1.1.0
"""
import asyncio
import io
import ipaddress
import json
import logging
import os
import re as _re
import socket
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
from sqlalchemy import func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.auth import get_current_user_id, require_auth
from app.db.database import get_db
from app.schemas import (
    SessionCreate, SessionUpdate, SessionResponse, SessionListResponse,
    AgentConfigCreate, AgentConfigUpdate, AgentConfigResponse,
    SessionStatus, AgentType, LLMProvider,
    AttachmentInfo, AttachmentFile, FileUploadResponse,
    FetchRepoRequest, FetchRepoResponse,
    CreatePRRequest, CreatePRResponse,
    EnhanceRequest, EnhanceResponse, EnhancementSuggestionResponse,
    EnhancePreviewResponse, EnhancerPreviewItem,
    ApplyEnhancementsRequest, ApplyEnhancementsResponse,
    ImportCheckResponse, ImportResponse,
    ImportDuplicateInfo, ImportNewInfo,
    PaginatedResponse,
    BulkDeleteRequest, BulkDeleteResponse,
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


# ---------------------------------------------------------------------------
# Multi-tenancy helpers
# ---------------------------------------------------------------------------

def _apply_user_filter(stmt, model, current_user_id: str | None):
    """Filter a SQLAlchemy statement by user_id when JWT auth is in use.

    When current_user_id is None (API-key / dev-mode), no filter is applied
    — backwards-compatible with non-JWT callers.
    """
    if current_user_id is None:
        return stmt
    return stmt.where(model.user_id == current_user_id)

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
MAX_TOTAL_UNCOMPRESSED_BYTES = 100 * 1024 * 1024  # 100MB aggregate uncompressed (zip-bomb guard)
MAX_COMPRESSION_RATIO = 1000  # zip-bomb heuristic: per-entry uncompressed/compressed ratio


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
                total_bytes = 0
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
                    # Zip-bomb: aggregate uncompressed size cap (counts ALL entries, not just text files)
                    total_bytes += info.file_size
                    if total_bytes > MAX_TOTAL_UNCOMPRESSED_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail="Archive uncompressed size exceeds limit",
                        )
                    # Zip-bomb: per-entry compression ratio heuristic
                    if info.compress_size > 0:
                        ratio = info.file_size / info.compress_size
                        if ratio > MAX_COMPRESSION_RATIO:
                            logger.warning(
                                f"Suspicious compression ratio {ratio:.0f}x in {info.filename}"
                            )
                            raise HTTPException(
                                status_code=413,
                                detail="Archive compression ratio suspicious — refusing to extract",
                            )
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
                total_bytes = 0
                for member in tf.getmembers():
                    if not member.isfile():
                        continue
                    # Prevent path traversal (Zip Slip) attacks — #85
                    resolved = os.path.normpath(member.name)
                    if resolved.startswith('..') or os.path.isabs(resolved):
                        errors.append(f"Skipped {member.name}: unsafe path")
                        continue
                    # Zip-bomb: aggregate uncompressed size cap (tar doesn't expose compress_size)
                    total_bytes += member.size
                    if total_bytes > MAX_TOTAL_UNCOMPRESSED_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail="Archive uncompressed size exceeds limit",
                        )
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
    except HTTPException:
        # Re-raise zip-bomb / size-limit rejections so the request fails cleanly
        raise
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
    # SSRF validation: resolve hostname and reject private/reserved IPs
    parsed = urlparse(request.url)
    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(400, "Invalid URL: missing hostname")
    try:
        resolved_ips = await asyncio.to_thread(socket.getaddrinfo, hostname, None)
        for _family, _type, _proto, _canonname, sockaddr in resolved_ips:
            addr = ipaddress.ip_address(sockaddr[0])
            if addr.is_private or addr.is_reserved or addr.is_loopback or addr.is_link_local:
                raise HTTPException(400, "Internal/private URLs are not allowed")
    except socket.gaierror:
        raise HTTPException(400, "Cannot resolve hostname")

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
    auth: dict | None = Depends(require_auth),
):
    """Download the final result as a ZIP file with the complete project structure.

    For repo mode sessions, merges original repo files with modifications.
    For standard sessions, creates a ZIP with the final code file.
    """
    current_user_id = get_current_user_id(auth)
    # Get session with attachments
    stmt = select(Session).where(Session.id == session_id)
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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
    auth: dict | None = Depends(require_auth),
):
    """Create a GitHub Pull Request with the session's final result.

    Requires a GitHub personal access token with repo write permissions.
    """
    from app.services.repo_service import create_github_pr

    current_user_id = get_current_user_id(auth)
    # Get session
    stmt = select(Session).where(Session.id == request.session_id)
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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
# Git integration: branches, commit history, diff, PR status
# ============================================================================


def _validate_git_url(url: str) -> None:
    """SSRF guard for git URLs — reject non-public hosts."""
    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        raise HTTPException(400, "Invalid URL: missing hostname")
    try:
        resolved_ips = socket.getaddrinfo(hostname, None)
        for _family, _type, _proto, _canonname, sockaddr in resolved_ips:
            addr = ipaddress.ip_address(sockaddr[0])
            if addr.is_private or addr.is_reserved or addr.is_loopback or addr.is_link_local:
                raise HTTPException(400, "Internal/private URLs are not allowed")
    except socket.gaierror:
        raise HTTPException(400, "Cannot resolve hostname")


@router.post("/list-branches")
async def list_branches(body: dict = Body(...)):
    """List branches of a remote git repo without cloning.

    Body: {url: str, token?: str}
    """
    url = body.get("url")
    token = body.get("token")
    if not url or not isinstance(url, str):
        raise HTTPException(400, "url required")

    _validate_git_url(url)

    auth_url = url
    if token and "github.com" in url:
        # Inject token for private GitHub repos.
        auth_url = url.replace("https://", f"https://{token}@", 1)

    import subprocess

    def _run() -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", "ls-remote", "--heads", auth_url],
            capture_output=True, text=True, timeout=30,
        )

    try:
        result = await asyncio.to_thread(_run)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Branch listing timed out")
    except FileNotFoundError:
        raise HTTPException(500, "git executable not found on server")

    if result.returncode != 0:
        # Avoid leaking the token if it's echoed in stderr.
        stderr = (result.stderr or "")[:200]
        if token:
            stderr = stderr.replace(token, "***")
        raise HTTPException(400, f"git ls-remote failed: {stderr}")

    branches = []
    for line in result.stdout.strip().splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[1].startswith("refs/heads/"):
            branches.append({
                "name": parts[1].replace("refs/heads/", ""),
                "sha": parts[0],
            })
    return {"branches": branches}


def _find_repo_attachment(session: Session) -> Optional[dict]:
    """Return the first attachment of type 'repo' from a session, or None."""
    for att in (getattr(session, "attachments", None) or []):
        if isinstance(att, dict) and att.get("type") == "repo":
            return att
        att_type = getattr(att, "type", None)
        if att_type == "repo":
            # Convert pydantic-ish object to dict-like access by extracting common fields.
            return {
                "type": "repo",
                "url": getattr(att, "url", None),
                "branch": getattr(att, "branch", None),
                "commit": getattr(att, "commit", None),
                "files": getattr(att, "files", []) or [],
            }
    return None


@router.get("/{session_id}/git/commits")
async def get_repo_commits(
    session_id: UUID,
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Get the commit history of the session's attached repo (shallow clone)."""
    current_user_id = get_current_user_id(auth)
    own_stmt = _apply_user_filter(
        select(Session).where(Session.id == session_id),
        Session,
        current_user_id,
    )
    session = (await db.execute(own_stmt)).scalar_one_or_none()
    if not session:
        raise HTTPException(404, "Session not found")

    repo_attachment = _find_repo_attachment(session)
    if not repo_attachment:
        return {"commits": [], "message": "No repo attached"}

    url = repo_attachment.get("url")
    branch = repo_attachment.get("branch") or "main"
    if not url:
        return {"commits": [], "message": "Repo attachment has no URL"}

    _validate_git_url(url)

    import subprocess
    import tempfile

    def _clone_and_log() -> tuple[int, str, str, str]:
        with tempfile.TemporaryDirectory() as tmpdir:
            clone_result = subprocess.run(
                ["git", "clone", "--depth", str(limit), "--branch", branch, url, tmpdir],
                capture_output=True, text=True, timeout=60,
            )
            if clone_result.returncode != 0:
                return clone_result.returncode, "", clone_result.stderr or "", ""
            log_result = subprocess.run(
                ["git", "log", f"-{limit}", "--pretty=format:%H|%an|%ae|%at|%s"],
                cwd=tmpdir, capture_output=True, text=True, timeout=30,
            )
            return 0, log_result.stdout or "", log_result.stderr or "", ""

    try:
        rc, stdout, stderr, _ = await asyncio.to_thread(_clone_and_log)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "Git operation timed out")
    except FileNotFoundError:
        raise HTTPException(500, "git executable not found on server")

    if rc != 0:
        raise HTTPException(400, f"Clone failed: {stderr[:200]}")

    commits = []
    for line in stdout.strip().splitlines():
        parts = line.split("|", 4)
        if len(parts) == 5:
            try:
                ts = int(parts[3])
            except ValueError:
                ts = 0
            commits.append({
                "sha": parts[0],
                "author_name": parts[1],
                "author_email": parts[2],
                "timestamp": ts,
                "message": parts[4],
            })
    return {"commits": commits, "branch": branch, "url": url}


@router.get("/{session_id}/git/diff")
async def get_repo_diff(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Compute diff summary between the originally attached repo files and
    the session's final code (FinalResult.file_structure)."""
    current_user_id = get_current_user_id(auth)
    own_stmt = _apply_user_filter(
        select(Session).where(Session.id == session_id),
        Session,
        current_user_id,
    )
    session = (await db.execute(own_stmt)).scalar_one_or_none()
    if not session:
        raise HTTPException(404, "Session not found")

    repo_attachment = _find_repo_attachment(session)
    original_files: dict[str, str] = {}
    if repo_attachment:
        for f in (repo_attachment.get("files") or []):
            if isinstance(f, dict):
                fpath = f.get("path")
                fcontent = f.get("content")
            else:
                fpath = getattr(f, "path", None)
                fcontent = getattr(f, "content", None)
            if fpath:
                original_files[fpath] = fcontent or ""

    if not original_files:
        return {"diff": [], "message": "No repo files"}

    final_stmt = select(FinalResult).where(FinalResult.session_id == session_id)
    final_result = (await db.execute(final_stmt)).scalar_one_or_none()
    if not final_result or not final_result.file_structure:
        return {"diff": [], "message": "No final result yet"}

    final_files: dict[str, str] = {}
    for fpath, info in (final_result.file_structure or {}).items():
        if isinstance(info, dict):
            final_files[fpath] = info.get("content", "") or ""

    all_paths = sorted(set(original_files.keys()) | set(final_files.keys()))
    diff_summary: list[dict] = []
    for path in all_paths:
        orig = original_files.get(path)
        new = final_files.get(path)
        if orig is None:
            action = "added"
            old_lines, new_lines = 0, len((new or "").splitlines())
        elif new is None:
            # Path missing from final structure means it wasn't touched in repo mode,
            # so treat only as deleted when final_result explicitly recorded a deletion.
            info = (final_result.file_structure or {}).get(path)
            if isinstance(info, dict) and info.get("action") == "deleted":
                action = "deleted"
                old_lines, new_lines = len(orig.splitlines()), 0
            else:
                continue
        elif orig == new:
            continue
        else:
            action = "modified"
            old_lines, new_lines = len(orig.splitlines()), len(new.splitlines())

        diff_summary.append({
            "path": path,
            "action": action,
            "old_lines": old_lines,
            "new_lines": new_lines,
        })

    return {"diff": diff_summary, "file_count": len(diff_summary)}


@router.post("/pr-status")
async def get_pr_status(body: dict = Body(...)):
    """Check the status of a GitHub Pull Request.

    Body: {pr_url: str, token?: str}
    """
    pr_url = body.get("pr_url")
    token = body.get("token")
    if not pr_url or not isinstance(pr_url, str):
        raise HTTPException(400, "pr_url required")

    # Parse https://github.com/<owner>/<repo>/pull/<number>
    m = _re.match(r"^https?://github\.com/([^/]+)/([^/]+)/pull/(\d+)/?$", pr_url.strip())
    if not m:
        raise HTTPException(400, "pr_url must look like https://github.com/<owner>/<repo>/pull/<number>")
    owner, repo, number = m.group(1), m.group(2), m.group(3)

    api_url = f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}"
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        import httpx
    except ImportError:
        raise HTTPException(500, "httpx not installed on server")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(api_url, headers=headers)
    except Exception as e:
        raise HTTPException(502, f"GitHub API request failed: {str(e)[:200]}")

    if resp.status_code == 404:
        raise HTTPException(404, "Pull request not found (or token lacks access)")
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, f"GitHub API error: {resp.text[:200]}")

    data = resp.json()
    return {
        "pr_number": data.get("number"),
        "state": data.get("state"),  # open / closed
        "merged": data.get("merged", False),
        "mergeable": data.get("mergeable"),
        "mergeable_state": data.get("mergeable_state"),
        "draft": data.get("draft", False),
        "title": data.get("title"),
        "html_url": data.get("html_url"),
        "head_ref": (data.get("head") or {}).get("ref"),
        "base_ref": (data.get("base") or {}).get("ref"),
        "comments": data.get("comments"),
        "review_comments": data.get("review_comments"),
        "commits": data.get("commits"),
        "additions": data.get("additions"),
        "deletions": data.get("deletions"),
        "changed_files": data.get("changed_files"),
        "created_at": data.get("created_at"),
        "updated_at": data.get("updated_at"),
        "merged_at": data.get("merged_at"),
        "closed_at": data.get("closed_at"),
    }


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
    user_id: str | None = None,
) -> str:
    """Create a full session with all child records from export data dict.
    Returns the new session id.

    The new session is owned by ``user_id`` (or NULL when None — used for
    API-key / dev-mode imports that have no user context).
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
        agent_timeout=sd.get("agent_timeout", 600),
        request_timeout=sd.get("request_timeout", 300),
        status=SessionStatus.CREATED,
        settings=sd.get("settings", {}),
        parent_session_id=None,
        enhancement_round=0,
        user_id=user_id,
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
    auth: dict | None = Depends(require_auth),
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

    current_user_id = get_current_user_id(auth)
    stmt = (
        select(Session)
        .where(Session.id.in_(session_ids))
        .options(*_full_session_load_options())
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
    result = await db.execute(stmt)
    sessions = result.scalars().unique().all()

    found_ids = {s.id for s in sessions}
    missing = [sid for sid in session_ids if sid not in found_ids]
    if missing:
        # Don't leak whether sessions belong to other users — same 404 message
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
    auth: dict | None = Depends(require_auth),
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

    current_user_id = get_current_user_id(auth)

    # Check for duplicates (only within the current user's sessions)
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
        stmt = _apply_user_filter(stmt, Session, current_user_id)
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
        new_id = await _create_session_from_data(db, sd, rename=rename, user_id=current_user_id)
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
    search: Optional[str] = Query(
        default=None,
        description="Case-insensitive substring match on session name OR specification",
    ),
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """List all sessions with optional status filter and full-text search.

    The ``search`` query param performs a case-insensitive substring match
    against both ``name`` and ``specification`` columns. (Feature #6.)
    """
    current_user_id = get_current_user_id(auth)

    # Build the search clause once so count + fetch stay in sync.
    search_clause = None
    if search:
        like = f"%{search}%"
        search_clause = or_(
            Session.name.ilike(like),
            Session.specification.ilike(like),
        )

    # Count total matching sessions
    count_stmt = select(func.count(Session.id))
    count_stmt = _apply_user_filter(count_stmt, Session, current_user_id)
    if status_filter:
        count_stmt = count_stmt.where(Session.status == status_filter)
    if search_clause is not None:
        count_stmt = count_stmt.where(search_clause)
    total = (await db.execute(count_stmt)).scalar() or 0

    # Fetch paginated results
    stmt = select(Session).order_by(Session.created_at.desc())
    stmt = _apply_user_filter(stmt, Session, current_user_id)
    if status_filter:
        stmt = stmt.where(Session.status == status_filter)
    if search_clause is not None:
        stmt = stmt.where(search_clause)
    stmt = stmt.offset(skip).limit(limit)

    result = await db.execute(stmt)
    sessions = result.scalars().all()

    return PaginatedResponse(items=sessions, total=total, skip=skip, limit=limit)


@router.get("/{session_id}", response_model=SessionResponse)
async def get_session(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Get session by ID with agent configs."""
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)

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
    auth: dict | None = Depends(require_auth),
):
    """Create a new session with optional agent configs."""
    current_user_id = get_current_user_id(auth)
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
        request_timeout=session_data.request_timeout,
        # Sprint-10: cost guard + time budget + test-driven mode
        cost_limit_usd=session_data.cost_limit_usd,
        session_timeout_sec=session_data.session_timeout_sec,
        expected_output=session_data.expected_output,
        status=SessionStatus.CREATED,
        settings=session_data.settings.model_dump(exclude_none=True) if session_data.settings else {},
        user_id=current_user_id,
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
        # Expand defaults based on num_coders / num_testers (Pydantic already
        # validated each to be in [1, 4] -- out-of-range payloads 422 here).
        # Wisdom-of-crowds: if more than one provider has an API key, give each
        # coder a different (provider, model) pair so we sample diverse models.
        # Otherwise fall back to repeating the same default.
        coder_pool: list[tuple[LLMProvider, str]] = [
            (LLMProvider.ANTHROPIC, "claude-opus-4-7"),
            (LLMProvider.OPENAI, "gpt-5.1"),
            (LLMProvider.GOOGLE, "gemini-2.5-pro"),
            (LLMProvider.GROK, "grok-4"),
        ]
        tester_pool: list[tuple[LLMProvider, str]] = [
            (LLMProvider.OPENAI, "gpt-5.2"),
            (LLMProvider.ANTHROPIC, "claude-sonnet-4-6"),
            (LLMProvider.GOOGLE, "gemini-2.5-pro"),
            (LLMProvider.GROK, "grok-4"),
        ]

        # Filter to providers actually configured (have an API key registered
        # with the router). If router lookup fails (e.g. during unit tests),
        # fall back to the full pool so behaviour is unchanged.
        try:
            from app.llm.router import llm_router as _router
            available_providers = {
                p for p in (
                    LLMProvider.ANTHROPIC, LLMProvider.OPENAI,
                    LLMProvider.GOOGLE, LLMProvider.GROK,
                )
                if _router.is_provider_available(p.value)
            }
        except Exception:
            available_providers = set()

        def _pick_models(
            pool: list[tuple[LLMProvider, str]], n: int
        ) -> list[tuple[LLMProvider, str]]:
            """Pick ``n`` (provider, model) pairs preferring diverse providers.

            Cycles through configured providers (wisdom-of-crowds). Falls back
            to the full pool when none are detected as available.
            """
            if available_providers:
                filtered = [pm for pm in pool if pm[0] in available_providers]
            else:
                filtered = list(pool)
            if not filtered:
                filtered = list(pool)
            return [filtered[i % len(filtered)] for i in range(n)]

        coder_picks = _pick_models(coder_pool, session_data.num_coders)
        tester_picks = _pick_models(tester_pool, session_data.num_testers)

        default_configs: list[dict[str, Any]] = []
        for idx, (provider, model) in enumerate(coder_picks):
            default_configs.append(
                {"type": AgentType.CODER, "index": idx,
                 "provider": provider, "model": model}
            )
        for idx, (provider, model) in enumerate(tester_picks):
            default_configs.append(
                {"type": AgentType.TESTER, "index": idx,
                 "provider": provider, "model": model}
            )
        # Singletons: summarizer + finalizer.
        default_configs.append(
            {"type": AgentType.SUMMARIZER, "index": 0,
             "provider": LLMProvider.ANTHROPIC, "model": "claude-sonnet-4-6"}
        )
        default_configs.append(
            {"type": AgentType.FINALIZER, "index": 0,
             "provider": LLMProvider.ANTHROPIC, "model": "claude-sonnet-4-6"}
        )
        # Enhancers: design / func / security / summary.
        for et in (
            AgentType.ENHANCER_DESIGN,
            AgentType.ENHANCER_FUNC,
            AgentType.ENHANCER_SECURITY,
            AgentType.ENHANCER_SUMMARY,
        ):
            default_configs.append(
                {"type": et, "index": 0,
                 "provider": LLMProvider.ANTHROPIC, "model": "claude-sonnet-4-6"}
            )

        for cfg in default_configs:
            config = AgentConfig(
                session_id=session.id,
                agent_type=cfg["type"],
                agent_index=cfg["index"],
                llm_provider=cfg["provider"],
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
    auth: dict | None = Depends(require_auth),
):
    """Update session settings."""
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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
        "auto_continue", "agent_timeout", "request_timeout", "settings",
        # Sprint-10: cost guard + time budget + test-driven mode
        "cost_limit_usd", "session_timeout_sec", "expected_output",
        "attachments",
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
            # R12-BUG-02: SQLAlchemy's plain JSON column treats in-place dict
            # mutation as "unchanged" (compares by object identity), so the
            # UPDATE never gets emitted. Build a NEW dict object so the
            # attribute is detected as dirty.
            session.settings = {**(session.settings or {}), **value}
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
    auth: dict | None = Depends(require_auth),
):
    """Delete a session."""
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id)
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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


@router.post("/bulk-delete", response_model=BulkDeleteResponse)
async def bulk_delete_sessions(
    payload: BulkDeleteRequest,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Delete multiple sessions in one request.

    Per-session failures (invalid UUID, not found, running/enhancing, DB errors)
    do not abort the whole request — failed IDs are returned in `failed_ids`.
    """
    current_user_id = get_current_user_id(auth)
    deleted_count = 0
    deleted_ids: list[str] = []
    failed_ids: list[str] = []

    for raw_id in payload.session_ids:
        # Validate UUID
        try:
            session_uuid = UUID(str(raw_id))
        except (ValueError, AttributeError, TypeError):
            failed_ids.append(str(raw_id))
            continue

        try:
            stmt = select(Session).where(Session.id == session_uuid)
            stmt = _apply_user_filter(stmt, Session, current_user_id)
            result = await db.execute(stmt)
            session = result.scalar_one_or_none()

            if not session:
                failed_ids.append(str(raw_id))
                continue

            # Mirror single-delete guard: don't allow deletion of running/enhancing sessions
            if session.status in [SessionStatus.RUNNING, SessionStatus.ENHANCING]:
                failed_ids.append(str(raw_id))
                continue

            await db.delete(session)
            await db.flush()
            deleted_count += 1
            deleted_ids.append(str(session_uuid))
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"bulk_delete: failed to delete session {raw_id}: {exc}")
            failed_ids.append(str(raw_id))
            # Roll back this session's pending changes so the loop can continue
            try:
                await db.rollback()
            except Exception:
                pass

    await db.commit()

    return BulkDeleteResponse(
        deleted_count=deleted_count,
        deleted_ids=deleted_ids,
        failed_ids=failed_ids,
    )


# ============================================================================
# Copy session
# ============================================================================


@router.post("/{session_id}/copy", response_model=SessionResponse, status_code=status.HTTP_201_CREATED)
async def copy_session(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Create a full deep copy of a session with all related data."""
    current_user_id = get_current_user_id(auth)
    stmt = (
        select(Session)
        .where(Session.id == session_id)
        .options(*_full_session_load_options())
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Serialize and recreate (owned by the same user)
    serialized = _serialize_session(session)
    new_id = await _create_session_from_data(db, serialized, rename=True, user_id=current_user_id)
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
    auth: dict | None = Depends(require_auth),
):
    """Copy only the structure (agent configs + settings) of a session, without content or iteration data."""
    current_user_id = get_current_user_id(auth)
    stmt = (
        select(Session)
        .where(Session.id == session_id)
        .options(selectinload(Session.agent_configs))
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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
        request_timeout=session.request_timeout,
        status=SessionStatus.CREATED,
        settings=session.settings or {},
        parent_session_id=None,
        enhancement_round=0,
        user_id=current_user_id,
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
    auth: dict | None = Depends(require_auth),
):
    """Start the workflow for a session."""
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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
    auth: dict | None = Depends(require_auth),
):
    """Pause a running session.

    Signals the orchestrator to pause between phases.  The orchestrator
    will update the DB status to PAUSED when it actually stops.  We
    don't overwrite the status here to avoid a race where the
    orchestrator is mid-commit.
    """
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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
    auth: dict | None = Depends(require_auth),
):
    """Resume a paused session.

    Signals the orchestrator to un-pause.  The orchestrator (still
    running its ``run()`` loop) picks up the flag and continues.
    The DB status is set back to RUNNING by the orchestrator.
    """
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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
    auth: dict | None = Depends(require_auth),
):
    """Cancel a session.

    Signals the orchestrator to stop.  Uses CAS to atomically set
    CANCELLED status only from valid source states.
    """
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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


async def _reset_session_artifacts(
    session_id: UUID,
    session: Session,
    db: AsyncSession,
    final_status: SessionStatus,
) -> None:
    """Shared helper for /reset and /restart.

    Cancels any running orchestrator (RUNNING/ENHANCING) and any pending
    visual-review timers (AWAITING_VISUAL_REVIEW), drops all workflow
    artifacts, and rewinds the session row to iteration 0. Agent configs
    are preserved (coder/tester/enhancer selection stays intact).

    The caller is responsible for ``await db.commit()`` after this returns
    and for any post-reset side-effects (background workflow kickoff,
    WebSocket event broadcast, etc.).
    """
    from sqlalchemy import delete as sa_delete
    from app.db.models import (
        CodeVersionScreenshot,
        VisualReviewScore,
        WorkflowCheckpoint,
    )

    sid_str = str(session_id)

    # 1) Cancel any live orchestrator so background coders/testers stop
    #    burning tokens. This is the fix for VR-Reset-Cancel: without this,
    #    /reset would update the DB row to status=created but the
    #    orchestrator task would keep running in-process and the UI would
    #    show conflicting "Created" status + "Running" agent state.
    #    session_manager.cancel_session() returns False (no-op) when no
    #    orchestrator is registered, so it's safe regardless of status.
    await session_manager.cancel_session(sid_str)

    # 2) Cancel pending Visual Review timers (1h vision ranker + 24h
    #    auto-finalize) so they can't fire after the reset.
    if session.status == SessionStatus.AWAITING_VISUAL_REVIEW:
        try:
            from app.services.visual_review import cancel_timeout as cancel_vr_timeout
            await cancel_vr_timeout(sid_str)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"Failed to cancel VR timers for {session_id}: {e}")

    # 3) Delete all workflow artifacts. Order respects FK constraints:
    #    code_executions / audits / screenshots cascade from code_versions;
    #    visual_review_scores reference code_version_id, so wipe them
    #    before code_versions.
    cv_ids_stmt = select(CodeVersion.id).where(CodeVersion.session_id == session_id)
    await db.execute(
        sa_delete(CodeExecution).where(CodeExecution.code_version_id.in_(cv_ids_stmt))
    )
    await db.execute(
        sa_delete(CodeVersionScreenshot).where(
            CodeVersionScreenshot.code_version_id.in_(cv_ids_stmt)
        )
    )
    await db.execute(sa_delete(VisualReviewScore).where(VisualReviewScore.session_id == session_id))
    await db.execute(sa_delete(Audit).where(Audit.session_id == session_id))
    await db.execute(sa_delete(CodeVersion).where(CodeVersion.session_id == session_id))
    await db.execute(sa_delete(SummaryAudit).where(SummaryAudit.session_id == session_id))
    await db.execute(sa_delete(CoderResponse).where(CoderResponse.session_id == session_id))
    await db.execute(sa_delete(LLMRequestModel).where(LLMRequestModel.session_id == session_id))
    await db.execute(sa_delete(Intervention).where(Intervention.session_id == session_id))
    await db.execute(sa_delete(FinalResult).where(FinalResult.session_id == session_id))
    await db.execute(
        sa_delete(EnhancementSuggestion).where(EnhancementSuggestion.session_id == session_id)
    )
    await db.execute(
        sa_delete(WorkflowCheckpoint).where(WorkflowCheckpoint.session_id == session_id)
    )

    # 4) Rewind the session row. Agent configs (including enhancer configs)
    #    are intentionally preserved so the user's coder/tester selection
    #    survives the reset.
    if session.original_specification:
        session.specification = session.original_specification
    session.initial_code = None
    session.current_iteration = 0
    session.enhancement_round = 0
    session.parent_session_id = None
    session.status = final_status
    session.updated_at = datetime.now(timezone.utc)


@router.post("/{session_id}/reset", response_model=SessionResponse)
async def reset_session(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Reset a session back to 'created' status — soft restart.

    Cancels any running orchestrator, drops all workflow artifacts
    (code_versions, audits, screenshots, visual_review_scores,
    final_result, enhancement_suggestions, summary_audits,
    coder_responses, llm_requests, interventions,
    workflow_checkpoints), and rewinds the session to iteration 0.

    Agent configs are preserved. Unlike /restart, this endpoint does NOT
    auto-start the workflow — the user must explicitly click Start.

    Emits ``session_reset`` WebSocket event.
    """
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    await _reset_session_artifacts(
        session_id=session_id,
        session=session,
        db=db,
        final_status=SessionStatus.CREATED,
    )
    await db.commit()
    db.expire_all()  # Clear ORM cache so re-query picks up deleted rows

    reset_at = datetime.now(timezone.utc).isoformat()
    logger.info(
        f"Session {session_id} reset: all workflow artifacts cleared, status=created"
    )

    # Broadcast WS event so all open clients refresh their state and
    # close any open panels (DetailPanel, VisualReviewPanel, etc.).
    try:
        await session_manager.broadcast(
            "session_reset",
            {
                "session_id": str(session_id),
                "user_id": current_user_id,
                "reset_at": reset_at,
            },
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Failed to broadcast session_reset for {session_id}: {e}")

    # Re-query to get fresh data with relationships
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    result = await db.execute(stmt)
    fresh_session = result.scalar_one()

    return fresh_session


# КАО#VR-11 RestartFromScratch — wipe all artifacts and re-run from iteration 0
@router.post("/{session_id}/restart", response_model=SessionResponse)
async def restart_session(
    session_id: UUID,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Restart a session from scratch — wipe all artifacts, reset to iteration 0,
    and immediately re-run the workflow with the original specification.

    Only allowed when the session is in a state awaiting user reaction:
      paused, awaiting_enhancement, awaiting_enhancement_review,
      awaiting_visual_review, failed, cancelled, completed, created.

    Rejected with 409 when the session is currently running/enhancing — the
    caller must pause or cancel first.
    """
    # КАО#VR-11 RestartFromScratch
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
    result = await db.execute(stmt)
    session = result.scalar_one_or_none()

    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # КАО#VR-11 RestartFromScratch — must not restart a live workflow.
    if session.status in (SessionStatus.RUNNING, SessionStatus.ENHANCING):
        raise HTTPException(
            status_code=409,
            detail="Cancel or pause the session first, then restart.",
        )

    # КАО#VR-11 RestartFromScratch — validate coder/tester presence the same
    # way /start does, so we fail fast with a clear message instead of starting
    # a workflow that immediately errors.
    has_coder = any(c.agent_type == AgentType.CODER for c in session.agent_configs)
    has_tester = any(c.agent_type == AgentType.TESTER for c in session.agent_configs)
    if not has_coder:
        raise HTTPException(status_code=400, detail="Session must have at least one coder agent")
    if not has_tester:
        raise HTTPException(status_code=400, detail="Session must have at least one tester agent")

    # Shared helper: cancel orchestrator + VR timers, drop artifacts, rewind row.
    # /restart differs from /reset only in that it sets status=RUNNING and
    # auto-kicks the workflow below (vs. /reset which sets status=CREATED).
    await _reset_session_artifacts(
        session_id=session_id,
        session=session,
        db=db,
        final_status=SessionStatus.RUNNING,
    )
    await db.commit()
    db.expire_all()

    restarted_at = datetime.now(timezone.utc).isoformat()
    logger.info(
        f"Session {session_id} restarted from scratch by user={current_user_id}"
    )

    # КАО#VR-11 RestartFromScratch — broadcast WS event so all open clients
    # refresh their state and close any panels (DetailPanel, VisualReviewPanel,
    # EnhancementReview, etc.).
    try:
        await session_manager.broadcast(
            "session_restarted",
            {
                "session_id": str(session_id),
                "user_id": current_user_id,
                "restarted_at": restarted_at,
            },
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(f"Failed to broadcast session_restarted for {session_id}: {e}")

    # КАО#VR-11 RestartFromScratch — kick off the workflow in the background,
    # mirroring start_session's pattern.
    async def run_workflow() -> None:
        from app.db.database import AsyncSessionLocal
        async with AsyncSessionLocal() as db_session:
            stmt2 = select(Session).where(Session.id == session_id).options(
                selectinload(Session.agent_configs)
            )
            result2 = await db_session.execute(stmt2)
            session_obj = result2.scalar_one()

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

    # Re-query so the response carries fresh agent_configs.
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
    auth: dict | None = Depends(require_auth),
):
    """Re-run only the finalization phase on existing coder outputs.

    Requires the session to have completed at least one coding cycle
    (code versions must exist). Replaces the current final result.
    """
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id).options(
        selectinload(Session.agent_configs)
    )
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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
    auth: dict | None = Depends(require_auth),
):
    """List all agent configs for a session."""
    current_user_id = get_current_user_id(auth)
    # Verify session ownership before returning agent configs
    own_stmt = _apply_user_filter(
        select(Session.id).where(Session.id == session_id),
        Session,
        current_user_id,
    )
    if (await db.execute(own_stmt)).scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Session not found")

    stmt = select(AgentConfig).where(AgentConfig.session_id == session_id)
    result = await db.execute(stmt)
    configs = result.scalars().all()
    return configs


@router.post("/{session_id}/agents", response_model=AgentConfigResponse)
async def add_agent_config(
    session_id: UUID,
    config_data: AgentConfigCreate,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Add an agent config to a session."""
    current_user_id = get_current_user_id(auth)
    # Verify session exists and is configurable
    stmt = select(Session).where(Session.id == session_id)
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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
    auth: dict | None = Depends(require_auth),
):
    """Update an agent config."""
    current_user_id = get_current_user_id(auth)
    # Verify session ownership first (404 if not owned)
    own_stmt = _apply_user_filter(
        select(Session).where(Session.id == session_id),
        Session,
        current_user_id,
    )
    session = (await db.execute(own_stmt)).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    stmt = select(AgentConfig).where(
        AgentConfig.id == agent_id,
        AgentConfig.session_id == session_id,
    )
    result = await db.execute(stmt)
    config = result.scalar_one_or_none()

    if not config:
        raise HTTPException(status_code=404, detail="Agent config not found")

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
    auth: dict | None = Depends(require_auth),
):
    """Delete an agent config."""
    current_user_id = get_current_user_id(auth)
    # Verify session ownership first (404 if not owned)
    own_stmt = _apply_user_filter(
        select(Session).where(Session.id == session_id),
        Session,
        current_user_id,
    )
    session = (await db.execute(own_stmt)).scalar_one_or_none()
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    stmt = select(AgentConfig).where(
        AgentConfig.id == agent_id,
        AgentConfig.session_id == session_id,
    )
    result = await db.execute(stmt)
    config = result.scalar_one_or_none()

    if not config:
        raise HTTPException(status_code=404, detail="Agent config not found")

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

        agent_timeout = session.agent_timeout or 600
        llm_request_timeout = session.request_timeout or 300
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
                request_timeout=llm_request_timeout,
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
            request_timeout=llm_request_timeout,
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


async def _run_enhancement_preview(
    session: Session,
    final_result: FinalResult,
    enhance_request: EnhanceRequest,
) -> EnhancePreviewResponse:
    """Synchronous dry-run: instantiate enhancer agents, run them in parallel,
    and return their suggestions WITHOUT persisting to DB or changing session state.
    """
    from app.llm.router import get_llm_router
    from app.agents.enhancer import (
        DesignEnhancerAgent,
        FunctionalityEnhancerAgent,
        SecurityEnhancerAgent,
    )

    llm_router = await get_llm_router()

    # Build full specification with attachments (mirror _run_enhancement)
    full_specification = session.specification
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

    final_code = final_result.final_code
    language = session.language

    agent_map = {
        "enhancer_design": DesignEnhancerAgent,
        "enhancer_func": FunctionalityEnhancerAgent,
        "enhancer_security": SecurityEnhancerAgent,
    }

    llm_request_timeout = session.request_timeout or 300

    enabled_cfgs = []
    coros = []
    for cfg in enhance_request.enhancers:
        if not cfg.enabled:
            continue
        agent_cls = agent_map.get(cfg.type)
        if not agent_cls:
            logger.warning(f"Unknown enhancer type in preview: {cfg.type}")
            continue
        agent = agent_cls(
            llm_router=llm_router,
            provider=cfg.provider,
            model=cfg.model,
            request_timeout=llm_request_timeout,
        )
        coros.append(
            agent.execute(
                specification=full_specification,
                code=final_code,
                language=language,
                recommendations=cfg.recommendations,
            )
        )
        enabled_cfgs.append(cfg)

    # Overall 90s ceiling on the full preview run
    try:
        results = await asyncio.wait_for(
            asyncio.gather(*coros, return_exceptions=True),
            timeout=90,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Enhancement preview timed out")

    items: list[EnhancerPreviewItem] = []
    total_in = 0
    total_out = 0
    total_cost = 0.0
    total_latency = 0
    for cfg, agent_result in zip(enabled_cfgs, results):
        if isinstance(agent_result, Exception):
            items.append(EnhancerPreviewItem(
                agent_type=cfg.type,
                success=False,
                error=str(agent_result),
                llm_provider=cfg.provider,
                llm_model=cfg.model,
            ))
            continue
        items.append(EnhancerPreviewItem(
            agent_type=cfg.type,
            success=bool(getattr(agent_result, "success", False)),
            content=getattr(agent_result, "content", None),
            parsed_data=getattr(agent_result, "parsed_data", None),
            error=getattr(agent_result, "error", None),
            input_tokens=getattr(agent_result, "input_tokens", 0) or 0,
            output_tokens=getattr(agent_result, "output_tokens", 0) or 0,
            cost_usd=float(getattr(agent_result, "cost_usd", 0.0) or 0.0),
            latency_ms=getattr(agent_result, "latency_ms", 0) or 0,
            llm_provider=cfg.provider,
            llm_model=cfg.model,
        ))
        total_in += items[-1].input_tokens
        total_out += items[-1].output_tokens
        total_cost += items[-1].cost_usd
        total_latency += items[-1].latency_ms

    return EnhancePreviewResponse(
        preview=True,
        parent_session_id=str(session.id),
        enhancers=items,
        total_input_tokens=total_in,
        total_output_tokens=total_out,
        estimated_cost_usd=round(total_cost, 6),
        total_latency_ms=total_latency,
    )


@router.post("/{session_id}/enhance", response_model=None)
async def enhance_session(
    session_id: UUID,
    request: EnhanceRequest,
    background_tasks: BackgroundTasks,
    preview: bool = Query(default=False, description="Dry-run: return suggestions without applying or persisting"),
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
):
    """Start enhancement process on a completed session.

    Runs enhancer agents (design/functionality/security), summarizes suggestions,
    creates a new session with enhanced specification, and auto-starts it.

    When `preview=true`, runs enhancer agents synchronously and returns their
    suggestions WITHOUT flipping session status, persisting to DB, or scheduling
    a background task. Useful for the "Preview Enhancements" UI flow.
    """
    current_user_id = get_current_user_id(auth)
    # Validate session exists and is completed
    stmt = select(Session).where(Session.id == session_id)
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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

    # Preview branch: synchronous dry-run, no DB writes, no status flip, no
    # background task. Return suggestions directly.
    if preview:
        return await _run_enhancement_preview(session, final_result, request)

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
    auth: dict | None = Depends(require_auth),
):
    """Get enhancement suggestions for a session."""
    current_user_id = get_current_user_id(auth)
    own_stmt = _apply_user_filter(
        select(Session.id).where(Session.id == session_id),
        Session,
        current_user_id,
    )
    if (await db.execute(own_stmt)).scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Session not found")

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
    auth: dict | None = Depends(require_auth),
):
    """Apply curated enhancement suggestions -- creates a new session with
    original specification + final code + curated enhancement list, then starts it.
    """
    current_user_id = get_current_user_id(auth)
    # Ownership check FIRST — we don't want to mutate state on someone else's session
    own_stmt = _apply_user_filter(
        select(Session.id).where(Session.id == session_id),
        Session,
        current_user_id,
    )
    if (await db.execute(own_stmt)).scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Session not found")

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
    # VR-39 — also collect per-suggestion attachments so we can merge them
    # into the child session's attachments bag and cite filenames in the
    # enhancement text (so the coder LLM sees the link between the request
    # text and the referenced files).
    enhancement_lines = ["## ENHANCEMENTS"]
    enhancement_attachments: list[dict] = []
    for s in request.curated_suggestions:
        line = f"- [{s.priority.upper()}] {s.title}: {s.description}"
        if s.attachments:
            # Build short comma-separated list of attachment labels for the
            # LLM. Use filename for files, label/url for repo_url, repo_name
            # for cloned repos. Truncated to keep prompt compact.
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
            # Serialize attachments to plain dict for JSON column storage.
            for att in s.attachments:
                enhancement_attachments.append(att.model_dump(exclude_none=True))
        enhancement_lines.append(line)
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

    # Create new session (preserve original_specification from parent for reset).
    # Inherit ownership from the parent session so the enhancement chain stays
    # owned by the same user (works for both JWT and API-key contexts).
    # VR-39 — child session inherits the parent's attachments AND any
    # per-enhancement attachments authored by the user during review. The
    # orchestrator already injects `session.attachments` into the coder's
    # prompt context at runtime, so merging here is sufficient to give the
    # LLM access to the referenced files / repos.
    merged_attachments: list[dict] = list(session.attachments or []) + enhancement_attachments

    new_session = Session(
        name=f"{base_name} — Enh #{enhancement_round}",
        specification=enhanced_spec,
        original_specification=session.original_specification or session.specification,
        initial_code=final_result.final_code,
        initial_docs=session.initial_docs,
        attachments=merged_attachments,
        language=session.language,
        max_iterations=session.max_iterations,
        auto_continue=session.auto_continue,
        enable_code_execution=session.enable_code_execution,
        execution_timeout=session.execution_timeout,
        max_fix_attempts=session.max_fix_attempts,
        auto_install_deps=session.auto_install_deps,
        agent_timeout=session.agent_timeout,
        request_timeout=session.request_timeout,
        settings=session.settings or {},
        parent_session_id=session_id,
        enhancement_round=enhancement_round,
        user_id=session.user_id,
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
    auth: dict | None = Depends(require_auth),
):
    """Mark a session as completed, skipping enhancement.
    Works for sessions in awaiting_enhancement or awaiting_enhancement_review status.
    """
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id)
    stmt = _apply_user_filter(stmt, Session, current_user_id)
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


@router.get("/{session_id}/checkpoints")
async def list_checkpoints(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
) -> list[dict[str, Any]]:
    """List all crash-recovery checkpoints for a session, newest first."""
    from app.db.models import WorkflowCheckpoint

    current_user_id = get_current_user_id(auth)
    # Verify session exists AND is owned by current user (404 vs empty list)
    session_exists = await db.execute(
        _apply_user_filter(
            select(Session.id).where(Session.id == session_id),
            Session,
            current_user_id,
        )
    )
    if session_exists.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Session not found")

    result = await db.execute(
        select(WorkflowCheckpoint)
        .where(WorkflowCheckpoint.session_id == session_id)
        .order_by(
            WorkflowCheckpoint.iteration.desc(),
            WorkflowCheckpoint.created_at.desc(),
        )
    )
    checkpoints = result.scalars().all()
    return [
        {
            "id": str(c.id),
            "session_id": str(c.session_id),
            "iteration": c.iteration,
            "phase": c.phase,
            "total_tokens": c.total_tokens,
            "total_cost_usd": float(c.total_cost_usd),
            "created_at": c.created_at.isoformat() if c.created_at else None,
        }
        for c in checkpoints
    ]


# ---------------------------------------------------------------------------
# Feature #5: Public share link (mint endpoint).
# The corresponding GET /api/share/{token} (no auth) lives in routes/share.py.
# ---------------------------------------------------------------------------

@router.post("/{session_id}/share")
async def create_share_link(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
) -> dict[str, str]:
    """Mint (or return existing) a public read-only share token for a session.

    Owner-only. Idempotent: re-calling returns the same token. Returns the
    token string; the caller is expected to construct the public URL
    (e.g. https://gotcode.ai/share/<token>) on the client side.
    """
    import secrets

    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id)
    stmt = _apply_user_filter(stmt, Session, current_user_id)
    session = (await db.execute(stmt)).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    if not session.share_token:
        # 32-byte URL-safe token (~43 chars) — fits in our String(64).
        session.share_token = secrets.token_urlsafe(32)
        await db.commit()
        await db.refresh(session)

    return {
        "session_id": str(session.id),
        "share_token": session.share_token,
        "share_path": f"/api/share/{session.share_token}",
    }


@router.delete("/{session_id}/share", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_share_link(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
) -> None:
    """Revoke the share token for a session (owner-only)."""
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id)
    stmt = _apply_user_filter(stmt, Session, current_user_id)
    session = (await db.execute(stmt)).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session.share_token:
        session.share_token = None
        await db.commit()


# ---------------------------------------------------------------------------
# Feature #4: Auto-generate tests + docs (stubs).
# Real LLM integration is a follow-up; for now return scaffolding that the
# caller can drop into a file. These endpoints respect ownership.
# ---------------------------------------------------------------------------

def _ext_for_language(language: str) -> str:
    return {
        "python": "py",
        "javascript": "js",
        "javascript_browser": "js",
        "typescript": "ts",
        "typescript_browser": "ts",
        "go": "go",
        "rust": "rs",
        "java": "java",
        "c": "c",
        "cpp": "cpp",
    }.get((language or "").lower(), "txt")


def _test_framework_for_language(language: str) -> str:
    lang = (language or "").lower()
    if lang.startswith("python"):
        return "pytest"
    if "javascript" in lang or "typescript" in lang:
        return "jest"
    if lang == "go":
        return "go test"
    if lang == "rust":
        return "cargo test"
    if lang == "java":
        return "junit"
    return "generic"


@router.post("/{session_id}/generate-tests")
async def generate_tests(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
) -> dict[str, Any]:
    """Generate (stubbed) automated tests for a session's final code.

    Currently returns scaffold-only output. The real LLM-backed generation
    is tracked as a follow-up; the contract here is stable so the frontend
    can wire the button now.
    """
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id)
    stmt = _apply_user_filter(stmt, Session, current_user_id)
    session = (await db.execute(stmt)).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    fr_stmt = select(FinalResult).where(FinalResult.session_id == session_id)
    final = (await db.execute(fr_stmt)).scalar_one_or_none()
    if final is None or not final.final_code:
        raise HTTPException(
            status_code=400,
            detail="Session has no final code yet — finish a workflow first.",
        )

    framework = _test_framework_for_language(session.language)
    ext = _ext_for_language(session.language)

    if framework == "pytest":
        scaffold = (
            f"# Auto-generated test scaffold for session {session.id}\n"
            f"# Framework: pytest. Replace TODOs with real assertions.\n\n"
            f"import pytest\n\n"
            f"def test_smoke():\n"
            f"    # TODO: import the module under test and assert basic behavior\n"
            f"    assert True\n"
        )
    elif framework == "jest":
        scaffold = (
            f"// Auto-generated test scaffold for session {session.id}\n"
            f"// Framework: jest. Replace TODOs with real assertions.\n\n"
            f"describe('smoke', () => {{\n"
            f"  test('runs', () => {{\n"
            f"    // TODO: import module under test and assert basic behavior\n"
            f"    expect(true).toBe(true);\n"
            f"  }});\n"
            f"}});\n"
        )
    else:
        scaffold = (
            f"// Auto-generated test scaffold ({framework}) for session {session.id}\n"
            f"// TODO: tests for the final code\n"
        )

    return {
        "session_id": str(session.id),
        "tests_code": scaffold,
        "language": framework,
        "filename": f"test_session.{ext}",
        "stub": True,
    }


@router.post("/{session_id}/generate-docs")
async def generate_docs(
    session_id: UUID,
    db: AsyncSession = Depends(get_db),
    auth: dict | None = Depends(require_auth),
) -> dict[str, Any]:
    """Generate (stubbed) README + API docs for a session's final code."""
    current_user_id = get_current_user_id(auth)
    stmt = select(Session).where(Session.id == session_id)
    stmt = _apply_user_filter(stmt, Session, current_user_id)
    session = (await db.execute(stmt)).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    fr_stmt = select(FinalResult).where(FinalResult.session_id == session_id)
    final = (await db.execute(fr_stmt)).scalar_one_or_none()
    if final is None or not final.final_code:
        raise HTTPException(
            status_code=400,
            detail="Session has no final code yet — finish a workflow first.",
        )

    spec = (session.specification or "").strip()
    spec_excerpt = spec if len(spec) <= 500 else (spec[:500] + " ...")

    readme = (
        f"# {session.name}\n\n"
        f"_Auto-generated stub. Replace with real docs when LLM integration ships._\n\n"
        f"## Overview\n\n"
        f"{spec_excerpt}\n\n"
        f"## Language\n\n"
        f"- {session.language}\n\n"
        f"## Status\n\n"
        f"- Iterations: {session.current_iteration}/{session.max_iterations}\n"
    )
    api_docs = (
        f"# API Reference (stub)\n\n"
        f"This document will list public functions/classes/endpoints from the "
        f"final code of session {session.id}. The current implementation returns "
        f"a placeholder; real generation is a follow-up.\n"
    )

    return {
        "session_id": str(session.id),
        "readme": readme,
        "api_docs": api_docs,
        "stub": True,
    }
