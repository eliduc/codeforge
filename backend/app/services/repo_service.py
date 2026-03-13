"""Repository fetching service for CodeForge. v1.1.0

Clones git repositories, extracts text/code files, and returns
them as attachment data for inclusion in LLM prompts.
"""

import asyncio
import logging
import os
import re
import shutil
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)

# Text/code file extensions to extract
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

# Directories to skip when walking repo tree
SKIP_DIRS = {
    '.git', 'node_modules', '__pycache__', '.venv', 'venv', 'env',
    '.tox', '.mypy_cache', '.pytest_cache', '.eggs', '*.egg-info',
    'dist', 'build', '.next', '.nuxt', 'coverage', '.coverage',
    'vendor', 'target', 'bin', 'obj',
}

MAX_REPO_CONTENT = 50 * 1024 * 1024  # 50MB total extracted text
MAX_FILE_SIZE = 1 * 1024 * 1024       # 1MB per file
MAX_FILES = 200                        # max files to extract
CLONE_TIMEOUT = 120                    # seconds


def _is_text_file(filename: str) -> bool:
    """Check if a file is a text/code file by extension."""
    name_lower = filename.lower()
    base_name = name_lower.rsplit('/', 1)[-1] if '/' in name_lower else name_lower
    if base_name in TEXT_EXTENSIONS:
        return True
    for ext in TEXT_EXTENSIONS:
        if ext.startswith('.') and name_lower.endswith(ext):
            return True
    return False


def _should_skip_dir(dirname: str) -> bool:
    """Check if directory should be skipped."""
    return dirname in SKIP_DIRS or dirname.startswith('.')


_SAFE_BRANCH_RE = re.compile(r'^[a-zA-Z0-9._/\-]+$')


def _validate_branch_name(branch: str) -> None:
    """Validate a git branch name to prevent option injection."""
    if not branch:
        return
    if branch.startswith('-'):
        raise ValueError(f"Invalid branch name (starts with dash): {branch}")
    if not _SAFE_BRANCH_RE.match(branch):
        raise ValueError(f"Invalid branch name (unsafe characters): {branch}")
    if '..' in branch:
        raise ValueError(f"Invalid branch name (contains '..'): {branch}")


def _parse_repo_url(url: str) -> dict:
    """Parse a git repo URL to extract owner, repo name, and normalize URL.

    Supports:
    - https://github.com/owner/repo
    - https://github.com/owner/repo.git
    - https://github.com/owner/repo/tree/branch
    - https://gitlab.com/owner/repo
    - git@github.com:owner/repo.git
    - Any https:// git URL
    """
    info = {"url": url, "branch": None, "owner": None, "repo": None, "host": None}

    # Handle GitHub/GitLab tree URLs with branch
    tree_match = re.match(
        r'https?://([^/]+)/([^/]+)/([^/]+)/tree/([^/]+)', url
    )
    if tree_match:
        info["host"] = tree_match.group(1)
        info["owner"] = tree_match.group(2)
        info["repo"] = tree_match.group(3).removesuffix('.git')
        info["branch"] = tree_match.group(4)
        info["url"] = f"https://{info['host']}/{info['owner']}/{info['repo']}.git"
        return info

    # Handle standard HTTPS URLs
    https_match = re.match(r'https?://([^/]+)/([^/]+)/([^/]+?)(?:\.git)?/?$', url)
    if https_match:
        info["host"] = https_match.group(1)
        info["owner"] = https_match.group(2)
        info["repo"] = https_match.group(3)
        info["url"] = f"https://{info['host']}/{info['owner']}/{info['repo']}.git"
        return info

    # Handle SSH URLs (git@host:owner/repo.git)
    ssh_match = re.match(r'git@([^:]+):([^/]+)/([^/]+?)(?:\.git)?$', url)
    if ssh_match:
        info["host"] = ssh_match.group(1)
        info["owner"] = ssh_match.group(2)
        info["repo"] = ssh_match.group(3)
        # Convert to HTTPS for cloning (SSH keys unlikely in container)
        info["url"] = f"https://{info['host']}/{info['owner']}/{info['repo']}.git"
        return info

    # Fallback: use URL as-is
    if not url.endswith('.git'):
        info["url"] = url + '.git' if '://' in url else url
    return info


def _validate_clone_url(url: str) -> None:
    """Validate that a clone URL is not targeting internal/private hosts (SSRF prevention)."""
    import ipaddress
    import socket
    from urllib.parse import urlparse

    parsed_url = urlparse(url)
    hostname = parsed_url.hostname

    if not hostname:
        raise ValueError("Invalid repository URL: no hostname")

    # Block common internal hostnames
    blocked_hosts = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "metadata.google.internal"}
    if hostname.lower() in blocked_hosts:
        raise ValueError(f"Repository URL targets a blocked host: {hostname}")

    # Resolve hostname and block private/reserved IPs
    try:
        for info in socket.getaddrinfo(hostname, None):
            addr = info[4][0]
            ip = ipaddress.ip_address(addr)
            if ip.is_private or ip.is_loopback or ip.is_reserved or ip.is_link_local:
                raise ValueError(f"Repository URL resolves to a private/internal address: {addr}")
            # Block IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1)
            if hasattr(ip, 'ipv4_mapped') and ip.ipv4_mapped:
                mapped = ip.ipv4_mapped
                if mapped.is_private or mapped.is_loopback or mapped.is_reserved or mapped.is_link_local:
                    raise ValueError(f"Repository URL resolves to a private/internal address: {addr}")
    except socket.gaierror:
        raise ValueError(f"Cannot resolve hostname: {hostname}")

    # Only allow https:// and git:// schemes
    if parsed_url.scheme not in ("https", "git"):
        raise ValueError(f"Unsupported URL scheme: {parsed_url.scheme}. Only https and git are allowed.")


async def clone_and_extract(
    url: str,
    branch: str | None = None,
    token: str | None = None,
) -> dict:
    """Clone a git repository and extract text/code files.

    Args:
        url: Git repository URL
        branch: Optional branch name (auto-detected if not provided)
        token: Optional auth token for private repos

    Returns:
        dict with keys: url, branch, commit, files, total_size, file_count, errors
    """
    parsed = _parse_repo_url(url)
    clone_url = parsed["url"]
    branch = branch or parsed["branch"]

    # Validate branch name to prevent git option injection
    if branch:
        _validate_branch_name(branch)

    # SSRF protection: validate the URL before cloning
    _validate_clone_url(clone_url)

    # Inject token into HTTPS URL if provided
    if token and clone_url.startswith("https://"):
        # https://token@github.com/owner/repo.git
        clone_url = clone_url.replace("https://", f"https://{token}@", 1)

    tmpdir = tempfile.mkdtemp(prefix="codeforge_repo_")
    repo_path = os.path.join(tmpdir, "repo")
    errors = []

    try:
        # Build clone command
        cmd = ["git", "clone", "--depth", "1"]
        if branch:
            cmd.extend(["--branch", branch])
        cmd.extend([clone_url, repo_path])

        logger.info(f"Cloning repo: {parsed['url']} (branch={branch})")

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=CLONE_TIMEOUT
            )
        except asyncio.TimeoutError:
            proc.kill()
            raise RuntimeError(f"Clone timed out after {CLONE_TIMEOUT}s")

        if proc.returncode != 0:
            err_msg = stderr.decode(errors='replace').strip()
            # Sanitize: strip any token from error message to prevent credential leakage
            if token:
                err_msg = err_msg.replace(token, "***")
            raise RuntimeError(f"git clone failed (exit {proc.returncode}): {err_msg}")

        # Get commit hash
        proc2 = await asyncio.create_subprocess_exec(
            "git", "-C", repo_path, "rev-parse", "HEAD",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout2, _ = await proc2.communicate()
        commit = stdout2.decode().strip()

        # Get branch name if not specified
        if not branch:
            proc3 = await asyncio.create_subprocess_exec(
                "git", "-C", repo_path, "branch", "--show-current",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout3, _ = await proc3.communicate()
            branch = stdout3.decode().strip() or "main"

        # Walk the repo and extract text files (run blocking I/O in a thread)
        def _walk_and_extract(repo_path: str):
            _files = []
            _total_size = 0
            _errors = []
            for root, dirs, filenames in os.walk(repo_path, followlinks=False):
                # Filter out directories to skip (including symlinked dirs)
                dirs[:] = [
                    d for d in dirs
                    if not _should_skip_dir(d) and not (Path(root) / d).is_symlink()
                ]
                dirs.sort()  # deterministic ordering

                for fname in sorted(filenames):
                    if len(_files) >= MAX_FILES:
                        _errors.append(f"Reached max file limit ({MAX_FILES}), some files skipped")
                        break

                    fpath = Path(root) / fname
                    rel_path = str(fpath.relative_to(repo_path))

                    # Skip symlinks to prevent path traversal
                    if fpath.is_symlink():
                        continue

                    if not _is_text_file(fname):
                        continue

                    try:
                        size = fpath.stat().st_size
                        if size > MAX_FILE_SIZE:
                            _errors.append(f"Skipped {rel_path}: exceeds 1MB")
                            continue
                        if _total_size + size > MAX_REPO_CONTENT:
                            _errors.append("Reached total content size limit, some files skipped")
                            break

                        content = fpath.read_text(encoding='utf-8', errors='replace')
                        _files.append({
                            "path": rel_path,
                            "content": content,
                            "size": size,
                        })
                        _total_size += size
                    except Exception as e:
                        _errors.append(f"Could not read {rel_path}: {e}")
            return _files, _total_size, _errors

        files, total_size, walk_errors = await asyncio.to_thread(_walk_and_extract, repo_path)
        errors.extend(walk_errors)

        logger.info(
            f"Repo cloned: {len(files)} files, "
            f"{total_size / 1024:.1f}KB total, branch={branch}, commit={commit[:8]}"
        )

        return {
            "url": parsed["url"].removesuffix('.git'),
            "branch": branch,
            "commit": commit,
            "owner": parsed.get("owner"),
            "repo_name": parsed.get("repo"),
            "files": files,
            "total_size": total_size,
            "file_count": len(files),
            "errors": errors,
        }

    except Exception as e:
        logger.error(f"Failed to clone repo {url}: {e}")
        raise

    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


async def build_result_zip(
    original_files: dict[str, str],
    file_structure: dict[str, dict],
) -> bytes:
    """Build a ZIP file with the merged result (original + modifications).

    Args:
        original_files: Original repo files {path: content}
        file_structure: Changes {path: {content, action}}

    Returns:
        ZIP file bytes
    """
    import io
    import zipfile

    merged = dict(original_files)

    for path, info in file_structure.items():
        action = info.get("action", "modified")
        if action == "deleted":
            merged.pop(path, None)
        elif "content" in info:
            merged[path] = info["content"]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(merged.keys()):
            # Prevent Zip Slip: reject paths with traversal components or absolute paths
            normalized = os.path.normpath(path)
            if normalized.startswith('..') or normalized.startswith(os.sep) or '..' in normalized.split(os.sep):
                logger.warning(f"Skipping unsafe path in ZIP: {path}")
                continue
            zf.writestr(path, merged[path])

    return buf.getvalue()


async def create_github_pr(
    repo_url: str,
    file_structure: dict[str, dict],
    original_files: dict[str, str],
    branch_name: str = "codeforge/improvements",
    pr_title: str = "CodeForge: Code Improvements",
    pr_body: str = "",
    token: str | None = None,
) -> dict:
    """Create a Pull Request on GitHub with the modified files.

    Args:
        repo_url: GitHub repository URL
        file_structure: Changes {path: {content, action}}
        original_files: Original repo files {path: content} (used for merge)
        branch_name: Branch name for the PR
        pr_title: PR title
        pr_body: PR description
        token: GitHub personal access token

    Returns:
        dict with pr_url, branch, status
    """
    import base64
    import aiohttp

    parsed = _parse_repo_url(repo_url)
    owner = parsed.get("owner")
    repo = parsed.get("repo")

    if not owner or not repo:
        raise ValueError(f"Could not parse owner/repo from URL: {repo_url}")

    if not token:
        raise ValueError("GitHub token is required to create a Pull Request")

    # Validate branch name to prevent URL path injection
    _validate_branch_name(branch_name)

    api_base = "https://api.github.com"
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "CodeForge/1.1.0",
    }

    async with aiohttp.ClientSession() as session:
        # 1. Get default branch and latest commit SHA
        async with session.get(
            f"{api_base}/repos/{owner}/{repo}",
            headers=headers,
        ) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise RuntimeError(f"Failed to get repo info: {resp.status} {text}")
            repo_info = await resp.json()
            default_branch = repo_info["default_branch"]

        # 2. Get the SHA of the default branch
        async with session.get(
            f"{api_base}/repos/{owner}/{repo}/git/ref/heads/{default_branch}",
            headers=headers,
        ) as resp:
            if resp.status != 200:
                text = await resp.text()
                raise RuntimeError(f"Failed to get branch ref: {resp.status} {text}")
            ref_data = await resp.json()
            base_sha = ref_data["object"]["sha"]

        # 3. Create new branch
        async with session.post(
            f"{api_base}/repos/{owner}/{repo}/git/refs",
            headers=headers,
            json={
                "ref": f"refs/heads/{branch_name}",
                "sha": base_sha,
            },
        ) as resp:
            if resp.status == 422:
                # Branch already exists - force-update to base SHA (previous commits on branch are lost)
                logger.warning(f"Branch '{branch_name}' already exists — force-resetting to {base_sha[:8]}")
                async with session.patch(
                    f"{api_base}/repos/{owner}/{repo}/git/refs/heads/{branch_name}",
                    headers=headers,
                    json={"sha": base_sha, "force": True},
                ) as patch_resp:
                    if patch_resp.status not in (200, 201):
                        text = await patch_resp.text()
                        raise RuntimeError(f"Failed to update branch: {patch_resp.status} {text}")
            elif resp.status not in (200, 201):
                text = await resp.text()
                raise RuntimeError(f"Failed to create branch: {resp.status} {text}")

        # 4. Apply file changes via Contents API
        for path, info in file_structure.items():
            action = info.get("action", "modified")

            if action == "deleted":
                # Get current file SHA first
                async with session.get(
                    f"{api_base}/repos/{owner}/{repo}/contents/{path}?ref={branch_name}",
                    headers=headers,
                ) as resp:
                    if resp.status == 200:
                        file_data = await resp.json()
                        async with session.delete(
                            f"{api_base}/repos/{owner}/{repo}/contents/{path}",
                            headers=headers,
                            json={
                                "message": f"Delete {path}",
                                "sha": file_data["sha"],
                                "branch": branch_name,
                            },
                        ) as del_resp:
                            if del_resp.status not in (200, 201):
                                logger.warning(f"Failed to delete {path}")
            else:
                content = info.get("content", "")
                encoded = base64.b64encode(content.encode("utf-8")).decode("ascii")

                # Check if file exists to get SHA for update
                payload: dict = {
                    "message": f"{'Create' if action == 'created' else 'Update'} {path}",
                    "content": encoded,
                    "branch": branch_name,
                }

                async with session.get(
                    f"{api_base}/repos/{owner}/{repo}/contents/{path}?ref={branch_name}",
                    headers=headers,
                ) as resp:
                    if resp.status == 200:
                        file_data = await resp.json()
                        payload["sha"] = file_data["sha"]

                async with session.put(
                    f"{api_base}/repos/{owner}/{repo}/contents/{path}",
                    headers=headers,
                    json=payload,
                ) as resp:
                    if resp.status not in (200, 201):
                        text = await resp.text()
                        logger.warning(f"Failed to update {path}: {resp.status} {text}")

        # 5. Create Pull Request
        async with session.post(
            f"{api_base}/repos/{owner}/{repo}/pulls",
            headers=headers,
            json={
                "title": pr_title,
                "body": pr_body,
                "head": branch_name,
                "base": default_branch,
            },
        ) as resp:
            if resp.status not in (200, 201):
                text = await resp.text()
                raise RuntimeError(f"Failed to create PR: {resp.status} {text}")
            pr_data = await resp.json()

    return {
        "pr_url": pr_data["html_url"],
        "pr_number": pr_data["number"],
        "branch": branch_name,
        "base_branch": default_branch,
        "status": "created",
    }
