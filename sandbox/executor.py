"""
CodeForge Sandbox Executor Service

Provides secure, isolated code execution for multiple programming languages.
"""

import asyncio
import logging
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional

import hmac

import psutil
from fastapi import FastAPI, HTTPException, Depends, Header
from pydantic import BaseModel, Field

SANDBOX_API_KEY = os.environ.get("SANDBOX_API_KEY", "")

if not SANDBOX_API_KEY:
    logging.getLogger(__name__).warning(
        "SANDBOX_API_KEY is not set — sandbox API is unauthenticated. "
        "Set SANDBOX_API_KEY in your environment for production deployments."
    )


async def verify_sandbox_key(x_sandbox_key: str = Header(default="")) -> None:
    """Verify internal sandbox API key. If SANDBOX_API_KEY is not set, auth is disabled."""
    if not SANDBOX_API_KEY:
        return  # No key configured — allow (dev mode)
    if not hmac.compare_digest(x_sandbox_key, SANDBOX_API_KEY):
        raise HTTPException(status_code=403, detail="Invalid sandbox API key")


# КАО#R5-sandbox-env — user code executes in this process's environment, so the
# sandbox's OWN secrets (at minimum SANDBOX_API_KEY, plus anything that looks
# like a credential) must never be inherited by the child process — otherwise a
# user submitting `print(os.environ['SANDBOX_API_KEY'])` reads the internal auth
# secret straight out of the execution output. We strip credential-shaped keys
# and always drop SANDBOX_API_KEY explicitly. Runtime essentials (PATH, HOME,
# LANG, PYTHONPATH, PUPPETEER_EXECUTABLE_PATH, …) do not match these patterns and
# are preserved; per-language vars are re-applied afterwards via `extra`.
_SECRET_ENV_MARKERS = ("SECRET", "TOKEN", "PASSWORD", "PASSWD", "APIKEY", "API_KEY", "_KEY")


def _sanitized_child_env(extra: Optional[dict] = None) -> dict:
    """Return a copy of os.environ with credential-shaped variables removed."""
    env = {
        k: v
        for k, v in os.environ.items()
        if not any(marker in k.upper() for marker in _SECRET_ENV_MARKERS)
    }
    env.pop("SANDBOX_API_KEY", None)  # explicit belt-and-suspenders
    if extra:
        env.update(extra)
    return env

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="CodeForge Sandbox",
    description="Secure code execution service",
    version="1.0.0"
)

# Limit concurrent executions to prevent resource exhaustion
MAX_CONCURRENT_EXECUTIONS = int(os.environ.get("MAX_CONCURRENT_EXECUTIONS", "5"))
_execution_semaphore = asyncio.Semaphore(MAX_CONCURRENT_EXECUTIONS)


class Language(str, Enum):
    PYTHON = "python"
    JAVASCRIPT = "javascript"
    TYPESCRIPT = "typescript"
    JAVA = "java"
    CPP = "cpp"
    C = "c"
    GO = "go"
    RUST = "rust"
    BASH = "bash"


class ExecutionRequest(BaseModel):
    """Request to execute code."""
    code: str = Field(..., max_length=1_000_000, description="Source code to execute (max 1MB)")
    language: Language = Field(..., description="Programming language")
    stdin: str = Field(default="", description="Standard input for the program")
    timeout: int = Field(default=60, ge=1, le=300, description="Timeout in seconds")
    memory_limit_mb: int = Field(default=512, ge=64, le=2048, description="Memory limit in MB")
    auto_install_deps: bool = Field(default=True, description="Auto-install dependencies")


class ExecutionResult(BaseModel):
    """Result of code execution."""
    success: bool = Field(..., description="Whether execution completed without errors")
    exit_code: int = Field(..., description="Process exit code")
    stdout: str = Field(default="", description="Standard output")
    stderr: str = Field(default="", description="Standard error")
    execution_time_ms: int = Field(..., description="Execution time in milliseconds")
    memory_used_mb: float = Field(default=0, description="Peak memory usage in MB")
    timeout_exceeded: bool = Field(default=False, description="Whether timeout was exceeded")
    error: Optional[str] = Field(default=None, description="Error message if any")
    installed_deps: list[str] = Field(default_factory=list, description="Dependencies that were installed")


@dataclass
class LanguageConfig:
    """Configuration for a programming language."""
    extension: str
    compile_cmd: Optional[list[str]] = None
    run_cmd: list[str] = field(default_factory=list)
    env: dict = field(default_factory=dict)


LANGUAGE_CONFIGS: dict[Language, LanguageConfig] = {
    Language.PYTHON: LanguageConfig(
        extension=".py",
        run_cmd=["python", "-u", "{file}"],
        env={"PYTHONUNBUFFERED": "1", "MPLBACKEND": "Agg"}
    ),
    Language.JAVASCRIPT: LanguageConfig(
        extension=".js",
        run_cmd=["node", "--max-old-space-size=256", "{file}"]
    ),
    Language.TYPESCRIPT: LanguageConfig(
        extension=".ts",
        run_cmd=["ts-node", "--max-old-space-size=256", "{file}"]
    ),
    Language.JAVA: LanguageConfig(
        extension=".java",
        compile_cmd=["javac", "{file}"],
        run_cmd=["java", "-cp", "{dir}", "{classname}"]
    ),
    Language.CPP: LanguageConfig(
        extension=".cpp",
        compile_cmd=["g++", "-o", "{output}", "{file}", "-std=c++17"],
        run_cmd=["{output}"]
    ),
    Language.C: LanguageConfig(
        extension=".c",
        compile_cmd=["gcc", "-o", "{output}", "{file}"],
        run_cmd=["{output}"]
    ),
    Language.GO: LanguageConfig(
        extension=".go",
        run_cmd=["go", "run", "{file}"]
    ),
    Language.RUST: LanguageConfig(
        extension=".rs",
        compile_cmd=["rustc", "-o", "{output}", "{file}"],
        run_cmd=["{output}"]
    ),
    Language.BASH: LanguageConfig(
        extension=".sh",
        run_cmd=["bash", "{file}"]
    ),
}


def extract_python_imports(code: str) -> list[str]:
    """Extract Python package names from import statements."""
    packages = set()

    # Match: import package, import package.submodule
    import_pattern = r'^import\s+([a-zA-Z_][a-zA-Z0-9_]*)'
    # Match: from package import ...
    from_pattern = r'^from\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+import'

    for line in code.split('\n'):
        line = line.strip()

        match = re.match(import_pattern, line)
        if match:
            packages.add(match.group(1))
            continue

        match = re.match(from_pattern, line)
        if match:
            packages.add(match.group(1))

    # Filter out standard library modules
    stdlib = {
        'abc', 'aifc', 'argparse', 'array', 'ast', 'asynchat', 'asyncio',
        'asyncore', 'atexit', 'audioop', 'base64', 'bdb', 'binascii',
        'binhex', 'bisect', 'builtins', 'bz2', 'calendar', 'cgi', 'cgitb',
        'chunk', 'cmath', 'cmd', 'code', 'codecs', 'codeop', 'collections',
        'colorsys', 'compileall', 'concurrent', 'configparser', 'contextlib',
        'contextvars', 'copy', 'copyreg', 'cProfile', 'cprofile', 'crypt', 'csv', 'ctypes',
        'curses', 'dataclasses', 'datetime', 'dbm', 'decimal', 'difflib',
        'dis', 'distutils', 'doctest', 'email', 'encodings', 'enum', 'errno',
        'faulthandler', 'fcntl', 'filecmp', 'fileinput', 'fnmatch', 'fractions',
        'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob',
        'graphlib', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http',
        'imaplib', 'imghdr', 'imp', 'importlib', 'inspect', 'io', 'ipaddress',
        'itertools', 'json', 'keyword', 'lib2to3', 'linecache', 'locale',
        'logging', 'lzma', 'mailbox', 'mailcap', 'marshal', 'math', 'mimetypes',
        'mmap', 'modulefinder', 'multiprocessing', 'netrc', 'nis', 'nntplib',
        'numbers', 'operator', 'optparse', 'os', 'ossaudiodev', 'pathlib',
        'pdb', 'pickle', 'pickletools', 'pipes', 'pkgutil', 'platform', 'plistlib',
        'poplib', 'posix', 'posixpath', 'pprint', 'profile', 'pstats', 'pty',
        'pwd', 'py_compile', 'pyclbr', 'pydoc', 'queue', 'quopri', 'random',
        're', 'readline', 'reprlib', 'resource', 'rlcompleter', 'runpy', 'sched',
        'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal',
        'site', 'smtpd', 'smtplib', 'sndhdr', 'socket', 'socketserver', 'spwd',
        'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct',
        'subprocess', 'sunau', 'symtable', 'sys', 'sysconfig', 'syslog', 'tabnanny',
        'tarfile', 'telnetlib', 'tempfile', 'termios', 'test', 'textwrap', 'threading',
        'time', 'timeit', 'tkinter', 'token', 'tokenize', 'trace', 'traceback',
        'tracemalloc', 'tty', 'turtle', 'turtledemo', 'types', 'typing', 'unicodedata',
        'unittest', 'urllib', 'uu', 'uuid', 'venv', 'warnings', 'wave', 'weakref',
        'webbrowser', 'winreg', 'winsound', 'wsgiref', 'xdrlib', 'xml', 'xmlrpc',
        'zipapp', 'zipfile', 'zipimport', 'zlib', '_thread'
    }

    # Package name mappings (import name -> pip package name)
    package_mappings = {
        'cv2': 'opencv-python',
        'PIL': 'pillow',
        'sklearn': 'scikit-learn',
        'yaml': 'pyyaml',
        'bs4': 'beautifulsoup4',
    }

    external = []
    for pkg in packages:
        if pkg.lower() not in stdlib:
            pip_name = package_mappings.get(pkg, pkg)
            external.append(pip_name)

    return external


def extract_node_imports(code: str) -> list[str]:
    """Extract Node.js package names from require/import statements."""
    packages = set()

    # Match: require('package') or require("package")
    require_pattern = r"require\(['\"]([^'\"./][^'\"]*)['\"]"
    # Match: import ... from 'package' or import 'package'
    import_pattern = r"(?:import\s+.*\s+from\s+|import\s+)['\"]([^'\"./][^'\"]*)['\"]"

    def _extract_pkg_name(raw: str) -> str:
        """Extract the package name, handling scoped packages like @babel/core."""
        if raw.startswith('@'):
            # Scoped package: @scope/name — the full name is @scope/name
            parts = raw.split('/')
            if len(parts) >= 2:
                return f"{parts[0]}/{parts[1]}"
            return raw
        return raw.split('/')[0]

    for match in re.finditer(require_pattern, code):
        pkg = _extract_pkg_name(match.group(1))
        packages.add(pkg)

    for match in re.finditer(import_pattern, code):
        pkg = _extract_pkg_name(match.group(1))
        packages.add(pkg)

    # Filter out Node.js built-in modules
    builtins = {
        'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
        'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'https',
        'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
        'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
        'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads', 'zlib'
    }

    return [pkg for pkg in packages if pkg not in builtins]


# Allowlisted packages that are safe to auto-install in the sandbox
ALLOWED_PYTHON_PACKAGES = {
    'requests', 'httpx', 'aiohttp', 'flask', 'fastapi', 'uvicorn', 'django',
    'sqlalchemy', 'numpy', 'pandas', 'scipy', 'scikit-learn', 'matplotlib',
    'seaborn', 'plotly', 'pillow', 'beautifulsoup4', 'lxml', 'pyyaml', 'toml',
    'pydantic', 'python-dotenv', 'aiofiles', 'cryptography', 'pyjwt',
    'pytest', 'pytest-asyncio', 'click', 'rich', 'typer', 'tqdm', 'arrow',
    'python-dateutil', 'pytz', 'regex', 'chardet', 'certifi', 'urllib3',
    'jinja2', 'markupsafe', 'pygments', 'colorama', 'tabulate', 'attrs',
    'opencv-python', 'torch', 'tensorflow', 'transformers', 'openai',
    'sympy', 'networkx', 'igraph', 'redis', 'celery', 'boto3',
}

ALLOWED_NODE_PACKAGES = {
    'express', 'axios', 'lodash', 'moment', 'dayjs', 'uuid', 'chalk', 'commander',
    'yargs', 'dotenv', 'cors', 'body-parser', 'morgan', 'winston', 'pino',
    'jest', 'mocha', 'chai', 'supertest', 'three', 'p5', 'd3', 'pixi.js',
    'react', 'react-dom', 'vue', 'svelte', 'socket.io', 'ws', 'sharp',
    'zod', 'ajv', 'joi', 'date-fns', 'luxon', 'cheerio', 'puppeteer',
    'jsonwebtoken', 'bcrypt', 'helmet', 'compression', 'multer', 'formidable',
}


def _validate_package_name(name: str) -> bool:
    """Validate that a package name looks safe (no shell metacharacters)."""
    import re as _re
    return bool(_re.match(r'^[a-zA-Z0-9@][a-zA-Z0-9._\-/]*$', name))


async def install_python_deps(packages: list[str], work_dir: Path) -> tuple[list[str], str]:
    """Install Python dependencies. Returns (installed, errors)."""
    if not packages:
        return [], ""

    installed = []
    errors = []

    # Filter to only allowlisted packages
    safe_packages = []
    for pkg in packages[:10]:
        if not _validate_package_name(pkg):
            errors.append(f"Rejected {pkg}: invalid package name")
            continue
        if pkg.lower() in ALLOWED_PYTHON_PACKAGES:
            safe_packages.append(pkg)
        else:
            errors.append(f"Skipped {pkg}: not in allowlist")

    for pkg in safe_packages:  # Limit to 10 packages
        try:
            proc = await asyncio.create_subprocess_exec(
                "pip", "install", "--quiet", "--target", str(work_dir / "deps"), pkg,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)

            if proc.returncode == 0:
                installed.append(pkg)
            else:
                errors.append(f"Failed to install {pkg}: {stderr.decode()[:200]}")
        except asyncio.TimeoutError:
            errors.append(f"Timeout installing {pkg}")
        except Exception as e:
            errors.append(f"Error installing {pkg}: {str(e)[:200]}")

    return installed, "\n".join(errors)


async def install_node_deps(packages: list[str], work_dir: Path) -> tuple[list[str], str]:
    """Install Node.js dependencies. Returns (installed, errors)."""
    if not packages:
        return [], ""

    installed = []
    errors = []

    # Filter to only allowlisted packages
    safe_packages = []
    for pkg in packages[:10]:
        if not _validate_package_name(pkg):
            errors.append(f"Rejected {pkg}: invalid package name")
            continue
        if pkg.lower() in ALLOWED_NODE_PACKAGES:
            safe_packages.append(pkg)
        else:
            errors.append(f"Skipped {pkg}: not in allowlist")

    # Initialize package.json
    pkg_json = work_dir / "package.json"
    pkg_json.write_text('{"name": "sandbox", "version": "1.0.0"}')

    for pkg in safe_packages:
        try:
            proc = await asyncio.create_subprocess_exec(
                "npm", "install", "--silent", pkg,
                cwd=str(work_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE
            )
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout=60)

            if proc.returncode == 0:
                installed.append(pkg)
            else:
                errors.append(f"Failed to install {pkg}: {stderr.decode()[:200]}")
        except asyncio.TimeoutError:
            errors.append(f"Timeout installing {pkg}")
        except Exception as e:
            errors.append(f"Error installing {pkg}: {str(e)[:200]}")

    return installed, "\n".join(errors)


def extract_java_classname(code: str) -> str:
    """Extract the class name from Java code.

    Looks for a public class first, then falls back to any non-public class
    declaration so that the generated filename matches the actual class name.
    """
    match = re.search(r'public\s+class\s+(\w+)', code)
    if match:
        return match.group(1)
    # Fallback: find any top-level class declaration (non-public)
    match = re.search(r'^class\s+(\w+)', code, re.MULTILINE)
    if match:
        return match.group(1)
    return "Main"


async def execute_code(request: ExecutionRequest, work_dir: Path) -> ExecutionResult:
    """Execute code in the sandbox."""
    config = LANGUAGE_CONFIGS[request.language]

    # Write code to file
    if request.language == Language.JAVA:
        classname = extract_java_classname(request.code)
        code_file = work_dir / f"{classname}{config.extension}"
    else:
        code_file = work_dir / f"main{config.extension}"

    code_file.write_text(request.code)

    # Prepare execution environment (КАО#R5-sandbox-env: strip sandbox secrets)
    env = _sanitized_child_env(config.env)

    # Add deps to Python path if needed
    deps_dir = work_dir / "deps"
    if deps_dir.exists() and request.language == Language.PYTHON:
        env["PYTHONPATH"] = str(deps_dir)

    # Compile if needed
    output_file = work_dir / "program"
    if config.compile_cmd:
        compile_cmd = [
            c.format(
                file=str(code_file),
                output=str(output_file),
                dir=str(work_dir),
                classname=extract_java_classname(request.code) if request.language == Language.JAVA else ""
            )
            for c in config.compile_cmd
        ]

        try:
            proc = await asyncio.create_subprocess_exec(
                *compile_cmd,
                cwd=str(work_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env
            )
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(),
                timeout=30
            )

            if proc.returncode != 0:
                return ExecutionResult(
                    success=False,
                    exit_code=proc.returncode,
                    stdout=stdout.decode()[:10000],
                    stderr=stderr.decode()[:10000],
                    execution_time_ms=0,
                    error="Compilation failed"
                )
        except asyncio.TimeoutError:
            return ExecutionResult(
                success=False,
                exit_code=-1,
                execution_time_ms=30000,
                timeout_exceeded=True,
                error="Compilation timeout"
            )

    # Prepare run command
    run_cmd = [
        c.format(
            file=str(code_file),
            output=str(output_file),
            dir=str(work_dir),
            classname=extract_java_classname(request.code) if request.language == Language.JAVA else ""
        )
        for c in config.run_cmd
    ]

    # Execute
    start_time = time.time()
    peak_memory = 0

    # Build resource limits for the child process (Linux only)
    import platform
    preexec = None
    if platform.system() != "Windows":
        import resource

        def _set_limits():
            # Start a new process group so we can kill all children on timeout
            os.setpgrp()
            # Virtual memory limit — V8 (Node.js), JVM, Go runtime all reserve
            # large virtual address spaces via mmap but only use a fraction as
            # resident memory.  RLIMIT_AS must be generous to avoid SIGABRT from
            # VM runtimes while the actual heap is capped per-runtime (e.g.
            # Node's --max-old-space-size).
            virt_bytes = max(request.memory_limit_mb, 2048) * 1024 * 1024  # at least 2 GB virtual
            resource.setrlimit(resource.RLIMIT_AS, (virt_bytes, virt_bytes))
            # Prevent fork bombs — limit process/thread count.
            # Note: on Linux RLIMIT_NPROC counts BOTH processes and threads
            # (threads are lightweight processes).  Node.js V8 alone spawns
            # ~10–15 internal threads (GC, compiler, platform workers).
            # 256 allows runtimes to function while still preventing fork bombs.
            resource.setrlimit(resource.RLIMIT_NPROC, (256, 256))

        preexec = _set_limits
    else:
        logger.warning("Resource limits (RLIMIT_AS, RLIMIT_NPROC) are not available on Windows")

    try:
        proc = await asyncio.create_subprocess_exec(
            *run_cmd,
            cwd=str(work_dir),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            preexec_fn=preexec,
        )

        # Monitor memory in background — on Windows this also enforces
        # the memory limit by killing the process tree when exceeded (BUG #3).
        memory_limit_mb = request.memory_limit_mb
        async def monitor_memory():
            nonlocal peak_memory
            try:
                ps_proc = psutil.Process(proc.pid)
                while proc.returncode is None:
                    try:
                        mem = ps_proc.memory_info().rss / 1024 / 1024  # MB
                        peak_memory = max(peak_memory, mem)
                        # On Windows, enforce memory limit by killing process tree
                        if platform.system() == "Windows" and mem > memory_limit_mb:
                            logger.warning(
                                f"Process {proc.pid} exceeded memory limit "
                                f"({mem:.0f}MB > {memory_limit_mb}MB), killing"
                            )
                            try:
                                parent = psutil.Process(proc.pid)
                                for child in parent.children(recursive=True):
                                    child.kill()
                                parent.kill()
                            except (psutil.NoSuchProcess, psutil.AccessDenied):
                                pass
                            break
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        break
                    await asyncio.sleep(0.1)
            except Exception:
                pass

        monitor_task = asyncio.create_task(monitor_memory())

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=request.stdin.encode() if request.stdin else None),
                timeout=request.timeout
            )
            execution_time_ms = int((time.time() - start_time) * 1000)

            monitor_task.cancel()

            return ExecutionResult(
                success=proc.returncode == 0,
                exit_code=proc.returncode,
                stdout=stdout.decode(errors='replace')[:50000],
                stderr=stderr.decode(errors='replace')[:50000],
                execution_time_ms=execution_time_ms,
                memory_used_mb=round(peak_memory, 2)
            )

        except asyncio.TimeoutError:
            monitor_task.cancel()

            # Kill the process and its children (process group)
            try:
                if platform.system() != "Windows" and proc.pid:
                    import signal
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        proc.kill()
                else:
                    # Windows: kill entire process tree via psutil
                    try:
                        parent = psutil.Process(proc.pid)
                        for child in parent.children(recursive=True):
                            child.kill()
                        parent.kill()
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        proc.kill()
                await proc.wait()
            except Exception:
                pass

            execution_time_ms = int((time.time() - start_time) * 1000)

            return ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="",
                execution_time_ms=execution_time_ms,
                memory_used_mb=round(peak_memory, 2),
                timeout_exceeded=True,
                error=f"Execution timeout ({request.timeout}s exceeded)"
            )

    except Exception as e:
        execution_time_ms = int((time.time() - start_time) * 1000)
        return ExecutionResult(
            success=False,
            exit_code=-1,
            execution_time_ms=execution_time_ms,
            error=str(e)[:1000]
        )


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {"status": "healthy", "service": "sandbox"}


@app.post("/execute", response_model=ExecutionResult, dependencies=[Depends(verify_sandbox_key)])
async def execute(request: ExecutionRequest) -> ExecutionResult:
    """Execute code in sandbox."""
    # Near-instant non-blocking acquire: either we get the semaphore or return 429.
    # NOTE: timeout must be >0 (Python 3.11.14+ raises TimeoutError immediately
    # with timeout=0 without giving the coroutine a chance to run).
    try:
        await asyncio.wait_for(_execution_semaphore.acquire(), timeout=0.1)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=429,
            detail=f"Too many concurrent executions (max {MAX_CONCURRENT_EXECUTIONS}). Try again later.",
        )

    try:
        return await _execute_impl(request)
    finally:
        _execution_semaphore.release()


async def _execute_impl(request: ExecutionRequest) -> ExecutionResult:
    """Internal execute implementation (called under semaphore)."""
    # BUG #2 fix: Bash allows arbitrary shell commands. Refuse bash when
    # the sandbox is unauthenticated (no SANDBOX_API_KEY) to prevent RCE.
    if request.language == Language.BASH and not SANDBOX_API_KEY:
        return ExecutionResult(
            success=False,
            exit_code=-1,
            execution_time_ms=0,
            error="Bash execution is disabled when SANDBOX_API_KEY is not set (security risk).",
        )

    logger.info(f"Executing {request.language} code, timeout={request.timeout}s")

    # Create temporary working directory
    work_dir = Path(tempfile.mkdtemp(prefix="sandbox_"))

    try:
        installed_deps = []

        # Auto-install dependencies if enabled
        if request.auto_install_deps:
            if request.language == Language.PYTHON:
                packages = extract_python_imports(request.code)
                if packages:
                    logger.info(f"Auto-installing Python packages: {packages}")
                    installed, errors = await install_python_deps(packages, work_dir)
                    installed_deps = installed
                    if errors:
                        logger.warning(f"Dependency install errors: {errors}")

            elif request.language in (Language.JAVASCRIPT, Language.TYPESCRIPT):
                packages = extract_node_imports(request.code)
                if packages:
                    logger.info(f"Auto-installing Node packages: {packages}")
                    installed, errors = await install_node_deps(packages, work_dir)
                    installed_deps = installed
                    if errors:
                        logger.warning(f"Dependency install errors: {errors}")

        # Execute code
        result = await execute_code(request, work_dir)
        result.installed_deps = installed_deps

        logger.info(
            f"Execution complete: success={result.success}, "
            f"exit_code={result.exit_code}, time={result.execution_time_ms}ms"
        )

        return result

    finally:
        # Cleanup with retry
        for attempt in range(3):
            try:
                shutil.rmtree(work_dir)
                break
            except Exception as e:
                if attempt < 2:
                    await asyncio.sleep(0.5)
                else:
                    logger.warning(f"Failed to cleanup {work_dir} after 3 attempts: {e}")


@app.get("/languages")
async def list_languages():
    """List supported languages."""
    return {
        "languages": [lang.value for lang in Language],
        "configs": {
            lang.value: {
                "extension": config.extension,
                "has_compilation": config.compile_cmd is not None
            }
            for lang, config in LANGUAGE_CONFIGS.items()
        }
    }


# ============================================================================
# Browser validation endpoint — validates HTML/browser code in headless Chromium
# ============================================================================

class BrowserValidationRequest(BaseModel):
    """Request to validate browser code (HTML page) in headless Chromium."""
    html: str = Field(..., max_length=1_000_000, description="HTML page content to validate (max 1MB)")
    timeout: int = Field(default=15, ge=5, le=60, description="Validation timeout in seconds")


@app.post("/validate-browser", response_model=ExecutionResult, dependencies=[Depends(verify_sandbox_key)])
async def validate_browser(request: BrowserValidationRequest) -> ExecutionResult:
    """Validate browser code by loading it in headless Chromium and capturing errors."""
    try:
        await asyncio.wait_for(_execution_semaphore.acquire(), timeout=0.1)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=429,
            detail=f"Too many concurrent executions (max {MAX_CONCURRENT_EXECUTIONS}). Try again later.",
        )

    try:
        return await _validate_browser_impl(request)
    finally:
        _execution_semaphore.release()


async def _validate_browser_impl(request: BrowserValidationRequest) -> ExecutionResult:
    """Internal browser validation implementation."""
    logger.info(f"Validating browser code in headless Chromium, timeout={request.timeout}s")

    work_dir = Path(tempfile.mkdtemp(prefix="browser_validate_"))
    start_time = time.time()

    try:
        # Write HTML to temp file
        html_file = work_dir / "index.html"
        html_file.write_text(request.html, encoding="utf-8")

        # Path to the validator script (copied into the image at build time)
        validator_script = Path("/app/browser_validator.js")
        if not validator_script.exists():
            return ExecutionResult(
                success=False,
                exit_code=-1,
                execution_time_ms=0,
                error="Browser validator script not found. Chromium may not be installed.",
            )

        # Run the browser validator
        try:
            process = await asyncio.create_subprocess_exec(
                "node", str(validator_script), str(html_file), str(request.timeout),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(work_dir),
                env=_sanitized_child_env(  # КАО#R5-sandbox-env
                    {
                        "PUPPETEER_EXECUTABLE_PATH": os.environ.get(
                            "PUPPETEER_EXECUTABLE_PATH", "/usr/bin/chromium"
                        ),
                    }
                ),
            )

            # Wait with overall timeout (validator timeout + startup buffer)
            overall_timeout = request.timeout + 20
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=overall_timeout
            )

            stdout_text = stdout_bytes.decode("utf-8", errors="replace")[:50000]
            stderr_text = stderr_bytes.decode("utf-8", errors="replace")[:50000]
            exit_code = process.returncode or 0
            elapsed_ms = int((time.time() - start_time) * 1000)

            return ExecutionResult(
                success=exit_code == 0,
                exit_code=exit_code,
                stdout=stdout_text,
                stderr=stderr_text,
                execution_time_ms=elapsed_ms,
                timeout_exceeded=False,
            )

        except asyncio.TimeoutError:
            elapsed_ms = int((time.time() - start_time) * 1000)
            # Kill the process
            try:
                process.kill()
                await process.wait()
            except Exception:
                pass

            return ExecutionResult(
                success=False,
                exit_code=-1,
                stdout="",
                stderr="Browser validation timed out — page may have an infinite loop or heavy computation",
                execution_time_ms=elapsed_ms,
                timeout_exceeded=True,
                error=f"Browser validation timed out after {request.timeout}s",
            )

    except Exception as e:
        elapsed_ms = int((time.time() - start_time) * 1000)
        logger.exception(f"Browser validation error: {e}")
        return ExecutionResult(
            success=False,
            exit_code=-1,
            stdout="",
            stderr=str(e)[:500],
            execution_time_ms=elapsed_ms,
            error=f"Browser validation error: {str(e)[:500]}",
        )

    finally:
        for attempt in range(3):
            try:
                shutil.rmtree(work_dir)
                break
            except Exception as e:
                if attempt < 2:
                    await asyncio.sleep(0.5)
                else:
                    logger.warning(f"Failed to cleanup {work_dir}: {e}")


# ============================================================================
# Screenshot endpoint — capture N stills from an HTML page for Visual Review
# ============================================================================


class ScreenshotRequest(BaseModel):
    """Request to capture screenshots of an HTML page in headless Chromium."""
    html: str = Field(..., max_length=1_000_000, description="HTML page content (max 1MB)")
    timestamps: list[float] = Field(
        default_factory=lambda: [0.5, 2.0, 5.0, 8.0, 12.0],
        description="Seconds after page-load at which to capture each frame",
    )
    timeout: int = Field(
        default=20, ge=5, le=30,
        description="Overall capture timeout in seconds (max 30 — keeps total slot bounded)",
    )


class ScreenshotFrame(BaseModel):
    """Metadata for a single captured frame."""
    frame_index: int
    t_seconds: float
    width: int
    height: int
    image_b64: str = Field(..., description="Base64-encoded PNG bytes")


class ScreenshotResult(BaseModel):
    """Result of screenshot capture."""
    success: bool
    frames: list[ScreenshotFrame] = Field(default_factory=list)
    error: Optional[str] = None
    capture_time_ms: int = 0


@app.post("/capture-screenshots", response_model=ScreenshotResult, dependencies=[Depends(verify_sandbox_key)])
async def capture_screenshots(request: ScreenshotRequest) -> ScreenshotResult:
    """Capture N stills from an HTML page in headless Chromium.

    The PNGs are returned base64-encoded; the backend persists them under
    STORAGE_ROOT/screenshots/<session_id>/<code_version_id>/. We don't write
    directly to a shared volume because the sandbox runs in its own
    filesystem namespace.
    """
    try:
        await asyncio.wait_for(_execution_semaphore.acquire(), timeout=0.1)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=429,
            detail=f"Too many concurrent executions (max {MAX_CONCURRENT_EXECUTIONS}). Try again later.",
        )

    try:
        return await _capture_screenshots_impl(request)
    finally:
        _execution_semaphore.release()


async def _capture_screenshots_impl(request: ScreenshotRequest) -> ScreenshotResult:
    """Internal implementation — runs browser_screenshot.js and reads back the PNGs."""
    import base64
    import json as _json

    logger.info(f"Capturing screenshots: {len(request.timestamps)} frames, timeout={request.timeout}s")

    work_dir = Path(tempfile.mkdtemp(prefix="screenshot_"))
    out_dir = work_dir / "frames"
    start_time = time.time()

    try:
        html_file = work_dir / "index.html"
        html_file.write_text(request.html, encoding="utf-8")

        capture_script = Path("/app/browser_screenshot.js")
        if not capture_script.exists():
            return ScreenshotResult(
                success=False,
                error="Browser screenshot script not found. Chromium may not be installed.",
                capture_time_ms=int((time.time() - start_time) * 1000),
            )

        timestamps_arg = ",".join(str(t) for t in request.timestamps)

        process = await asyncio.create_subprocess_exec(
            "node",
            str(capture_script),
            str(html_file),
            str(out_dir),
            timestamps_arg,
            str(request.timeout),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=str(work_dir),
            env=_sanitized_child_env(  # КАО#R5-sandbox-env
                {
                    "PUPPETEER_EXECUTABLE_PATH": os.environ.get(
                        "PUPPETEER_EXECUTABLE_PATH", "/usr/bin/chromium"
                    ),
                }
            ),
        )

        overall_timeout = request.timeout + 15
        try:
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                process.communicate(), timeout=overall_timeout
            )
        except asyncio.TimeoutError:
            try:
                process.kill()
                await process.wait()
            except Exception:
                pass
            return ScreenshotResult(
                success=False,
                error=f"Screenshot capture timed out after {overall_timeout}s",
                capture_time_ms=int((time.time() - start_time) * 1000),
            )

        stdout_text = stdout_bytes.decode("utf-8", errors="replace")
        stderr_text = stderr_bytes.decode("utf-8", errors="replace")[:5000]

        # Parse the LAST JSON line on stdout — the capture script may emit
        # other diagnostics before it.
        meta: dict = {"frames": []}
        for line in reversed(stdout_text.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    meta = _json.loads(line)
                    break
                except _json.JSONDecodeError:
                    continue

        frames: list[ScreenshotFrame] = []
        for frame_meta in meta.get("frames", []):
            frame_path = Path(frame_meta.get("path", ""))
            if not frame_path.exists():
                continue
            try:
                png_bytes = frame_path.read_bytes()
            except OSError:
                continue
            frames.append(ScreenshotFrame(
                frame_index=int(frame_meta.get("frame_index", 0)),
                t_seconds=float(frame_meta.get("t_seconds", 0.0)),
                width=int(frame_meta.get("width", 0)),
                height=int(frame_meta.get("height", 0)),
                image_b64=base64.b64encode(png_bytes).decode("ascii"),
            ))

        elapsed_ms = int((time.time() - start_time) * 1000)
        if not frames:
            return ScreenshotResult(
                success=False,
                error=f"No frames captured. stderr: {stderr_text[:500]}",
                capture_time_ms=elapsed_ms,
            )
        return ScreenshotResult(success=True, frames=frames, capture_time_ms=elapsed_ms)

    except Exception as e:
        elapsed_ms = int((time.time() - start_time) * 1000)
        logger.exception(f"Screenshot capture error: {e}")
        return ScreenshotResult(
            success=False,
            error=f"Screenshot capture error: {str(e)[:500]}",
            capture_time_ms=elapsed_ms,
        )

    finally:
        for attempt in range(3):
            try:
                shutil.rmtree(work_dir)
                break
            except Exception as e:
                if attempt < 2:
                    await asyncio.sleep(0.5)
                else:
                    logger.warning(f"Failed to cleanup {work_dir}: {e}")


# ============================================================================
# Bundle endpoint — builds JS/TS code into a browser-ready HTML page
# ============================================================================

class BundleRequest(BaseModel):
    """Request to bundle JS/TS code for browser execution."""
    code: str = Field(..., max_length=1_000_000, description="Source code (may contain multi-file markers, max 1MB)")
    language: Language = Field(default=Language.JAVASCRIPT, description="Programming language")
    timeout: int = Field(default=60, ge=5, le=120, description="Build timeout in seconds")
    auto_install_deps: bool = Field(default=True, description="Auto-install npm dependencies")
    html_template: Optional[str] = Field(default=None, description="Custom HTML template (use {{SCRIPT}} placeholder)")


class BundleResult(BaseModel):
    """Result of code bundling."""
    success: bool
    html: str = Field(default="", description="Complete HTML page ready for browser rendering")
    error: Optional[str] = Field(default=None, description="Error message if bundling failed")
    build_time_ms: int = Field(default=0, description="Build time in milliseconds")
    bundled_size_bytes: int = Field(default=0, description="Size of the bundled JS")
    installed_deps: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


def split_multi_file_code(code: str) -> dict[str, str]:
    """
    Split code containing multiple file markers into a dict of filename -> content.

    Supports markers:
    - // FILE: filename.js
    - // --- filename.js ---
    - /* === filename.js === */
    - // ===== filename.js =====
    """
    import re as _re

    # Try various multi-file marker patterns
    patterns = [
        r'^//\s*FILE:\s*(.+?)\s*$',                     # // FILE: filename.js
        r'^//\s*---+\s*(.+?)\s*---+\s*$',               # // --- filename.js ---
        r'^/\*\s*===+\s*(.+?)\s*===+\s*\*/$',           # /* === filename.js === */
        r'^//\s*===+\s*(.+?)\s*===+\s*$',               # // ===== filename.js =====
        r'^#\s*FILE:\s*(.+?)\s*$',                       # # FILE: filename (for package.json comments)
    ]

    files = {}
    current_file = None
    current_lines = []

    for line in code.split('\n'):
        matched = False
        for pattern in patterns:
            m = _re.match(pattern, line.strip())
            if m:
                # Save previous file
                if current_file:
                    files[current_file] = '\n'.join(current_lines).strip()
                current_file = m.group(1).strip()
                current_lines = []
                matched = True
                break

        if not matched:
            current_lines.append(line)

    # Save last file
    if current_file:
        files[current_file] = '\n'.join(current_lines).strip()

    return files


def detect_entry_point(files: dict[str, str], language: str) -> str:
    """Detect the main entry point file."""
    # Check package.json for "main" field
    if 'package.json' in files:
        try:
            import json
            pkg = json.loads(files['package.json'])
            main = pkg.get('main')
            if main and main in files:
                return main
        except Exception:
            pass

    # Common entry point names
    ext = '.ts' if language == 'typescript' else '.js'
    candidates = [
        f'main{ext}', f'index{ext}', f'app{ext}', f'src/main{ext}',
        f'src/index{ext}', f'src/app{ext}',
        'main.js', 'index.js', 'app.js',  # Fallback to .js even for TS
    ]

    for candidate in candidates:
        if candidate in files:
            return candidate

    # Return first JS/TS file found
    for name in files:
        if name.endswith('.js') or name.endswith('.ts') or name.endswith('.tsx') or name.endswith('.jsx'):
            return name

    return f'main{ext}'


def detect_is_browser_code(code: str) -> bool:
    """Heuristic to detect if JS/TS code is meant for browser (vs pure Node.js CLI)."""
    browser_patterns = [
        r'\bdocument\b', r'\bwindow\b', r'\bcanvas\b', r'\bCanvas\b',
        r'\bgetElementById\b', r'\bquerySelector\b', r'\bcreateElement\b',
        r'\baddEventListener\b', r'\brequestAnimationFrame\b',
        r'\binnerHTML\b', r'\btextContent\b', r'\bclassList\b',
        r'\bgetContext\b', r'\bWebGL\b', r'\bwebgl\b', r'\bDOM\b',
        r'\balert\b', r'\bfetch\b', r'\bXMLHttpRequest\b',
        r'\b<canvas\b', r'\b<div\b', r'\b<html\b',
        r'\bstyle\.\b', r'\boffsetWidth\b', r'\bclientHeight\b',
        r'\bonclick\b', r'\bonload\b', r'\bonmouse\b', r'\bonkey\b',
        r'\bthree\.js\b', r'\bTHREE\b', r'\bp5\b', r'\bd3\b',
        r'\bpixi\b', r'\bPhaser\b',
    ]
    import re as _re
    count = sum(1 for p in browser_patterns if _re.search(p, code))
    return count >= 2  # At least 2 browser-related patterns


DEFAULT_HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CodeForge Preview</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: #0a0a0a; color: #e2e8f0; font-family: system-ui, -apple-system, sans-serif; }
  canvas { display: block; }
  #root, #app { width: 100%; height: 100%; }
  #__cf_console {
    display: none;
    position: fixed; bottom: 0; left: 0; right: 0;
    max-height: 200px; overflow: auto;
    font-family: 'SF Mono', Consolas, monospace; font-size: 12px;
    padding: 8px 12px; background: rgba(30,30,46,0.95); color: #cdd6f4;
    white-space: pre-wrap; word-break: break-word; line-height: 1.5;
    border-top: 1px solid #45475a; z-index: 99999;
  }
  #__cf_error {
    display: none;
    position: fixed; top: 20px; left: 20px; right: 20px;
    padding: 16px 20px; background: rgba(220,38,38,0.95); color: white;
    border-radius: 8px; font-size: 14px; z-index: 99999;
    font-family: 'SF Mono', Consolas, monospace; white-space: pre-wrap;
  }
</style>
</head>
<body>
<canvas id="canvas"></canvas>
<div id="root"></div>
<div id="app"></div>
<div id="__cf_console"></div>
<div id="__cf_error"></div>
<script>
(function(){
  var con = document.getElementById('__cf_console');
  var errEl = document.getElementById('__cf_error');
  var lines = [];
  function esc(s){var d=document.createElement('div');d.textContent=s;return d.innerHTML}
  function fmt(args){return Array.from(args).map(function(a){
    if(a===null)return'null';if(a===undefined)return'undefined';
    if(typeof a==='object'){try{return JSON.stringify(a,null,2)}catch(e){return String(a)}}
    return String(a)
  }).join(' ')}
  function addLine(text,color){
    lines.push('<span style="color:'+color+'">'+esc(text)+'</span>');
    con.style.display='block';
    con.innerHTML=lines.join('\\n');
    con.scrollTop=con.scrollHeight;
  }
  var orig={log:console.log,warn:console.warn,error:console.error,info:console.info};
  console.log=function(){orig.log.apply(console,arguments);addLine(fmt(arguments),'#cdd6f4')};
  console.warn=function(){orig.warn.apply(console,arguments);addLine(fmt(arguments),'#f9e2af')};
  console.error=function(){orig.error.apply(console,arguments);addLine(fmt(arguments),'#f38ba8')};
  console.info=function(){orig.info.apply(console,arguments);addLine(fmt(arguments),'#89b4fa')};
  window.onerror=function(msg,src,line,col,err){
    errEl.style.display='block';
    errEl.textContent='Error: '+msg+(line?' (line '+line+')':'');
    addLine('Error: '+msg+(line?' (line '+line+')':''),'#f38ba8');
  };
  window.addEventListener('unhandledrejection',function(e){
    addLine('Unhandled Promise: '+(e.reason||e),'#f38ba8');
  });
  // Auto-size canvas to viewport
  var c=document.getElementById('canvas');
  if(c){c.width=window.innerWidth;c.height=window.innerHeight;
    window.addEventListener('resize',function(){c.width=window.innerWidth;c.height=window.innerHeight})}
  // Hide console if DOM content appears
  setTimeout(function(){
    var body=document.body;
    for(var i=0;i<body.children.length;i++){
      var ch=body.children[i];
      if(ch.id==='__cf_console'||ch.id==='__cf_error'||ch.id==='canvas')continue;
      if((ch.id==='root'||ch.id==='app')&&!ch.innerHTML.trim())continue;
      if(ch.offsetHeight>0){
        con.style.maxHeight='150px';
        con.style.position='fixed';
        break;
      }
    }
  },800);
})();
</script>
<script>
{{SCRIPT}}
</script>
</body>
</html>"""


@app.post("/bundle", response_model=BundleResult, dependencies=[Depends(verify_sandbox_key)])
async def bundle_code(request: BundleRequest) -> BundleResult:
    """Bundle JS/TS code into a browser-ready HTML page using esbuild."""
    logger.info(f"Bundling {request.language} code, timeout={request.timeout}s")

    if request.language not in (Language.JAVASCRIPT, Language.TYPESCRIPT):
        return BundleResult(
            success=False,
            error=f"Bundling not supported for {request.language}. Only JavaScript/TypeScript."
        )

    start_time = time.time()
    work_dir = Path(tempfile.mkdtemp(prefix="bundle_"))

    try:
        installed_deps = []
        warnings = []

        # 1. Split multi-file code or use as single file
        files = split_multi_file_code(request.code)

        if not files:
            # Single-file code — no markers found
            ext = '.ts' if request.language == Language.TYPESCRIPT else '.js'
            files = {f'main{ext}': request.code}

        # 2. Write all files to work_dir (with path traversal protection)
        for filename, content in files.items():
            # Sanitize: resolve and ensure the path stays within work_dir
            file_path = (work_dir / filename).resolve()
            work_dir_prefix = str(work_dir.resolve()) + os.sep
            if not (str(file_path) + os.sep).startswith(work_dir_prefix) and file_path != work_dir.resolve():
                logger.warning(f"Path traversal attempt blocked: {filename}")
                warnings.append(f"Path traversal attempt blocked: {filename}")
                continue
            file_path.parent.mkdir(parents=True, exist_ok=True)
            file_path.write_text(content)

        # 3. Detect entry point
        entry = detect_entry_point(files, request.language.value)
        entry_path = work_dir / entry

        if not entry_path.exists():
            # If entry doesn't exist, create it from the code
            ext = '.ts' if request.language == Language.TYPESCRIPT else '.js'
            entry = f'main{ext}'
            entry_path = work_dir / entry
            entry_path.write_text(request.code)

        # 4. Install npm dependencies if needed
        if request.auto_install_deps:
            # If no package.json exists, create a minimal one
            pkg_json_path = work_dir / 'package.json'
            if not pkg_json_path.exists():
                packages = extract_node_imports(request.code)
                if packages:
                    import json
                    pkg_json_path.write_text(json.dumps({
                        "name": "codeforge-bundle",
                        "version": "1.0.0",
                        "type": "module" if 'import ' in request.code and 'require(' not in request.code else "commonjs",
                    }))
                    inst, errs = await install_node_deps(packages, work_dir)
                    installed_deps = inst
                    if errs:
                        warnings.append(f"Dep install issues: {errs}")
            else:
                # package.json exists — run npm install
                try:
                    proc = await asyncio.create_subprocess_exec(
                        "npm", "install", "--silent", "--no-audit", "--no-fund",
                        cwd=str(work_dir),
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    stdout_data, stderr_data = await asyncio.wait_for(proc.communicate(), timeout=60)
                    if proc.returncode != 0:
                        warnings.append(f"npm install warning: {stderr_data.decode()[:300]}")
                    else:
                        installed_deps.append("(from package.json)")
                except asyncio.TimeoutError:
                    warnings.append("npm install timed out")
                except Exception as e:
                    warnings.append(f"npm install error: {str(e)[:200]}")

        # 5. Bundle with esbuild
        bundle_out = work_dir / '_bundle.js'

        esbuild_cmd = [
            "esbuild",
            str(entry_path),
            "--bundle",
            "--format=iife",
            "--platform=browser",
            f"--outfile={bundle_out}",
            "--target=es2020",
            "--sourcemap=inline",
            "--define:process.env.NODE_ENV=\"production\"",
            "--define:global=globalThis",
        ]

        # Add loader for .ts/.tsx/.jsx
        if request.language == Language.TYPESCRIPT:
            esbuild_cmd.extend([
                "--loader:.ts=ts",
                "--loader:.tsx=tsx",
            ])

        try:
            proc = await asyncio.create_subprocess_exec(
                *esbuild_cmd,
                cwd=str(work_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "NODE_PATH": str(work_dir / "node_modules")},
            )
            stdout_data, stderr_data = await asyncio.wait_for(
                proc.communicate(), timeout=request.timeout
            )

            esbuild_stderr = stderr_data.decode(errors='replace')

            if proc.returncode != 0:
                # esbuild failed
                logger.warning(f"esbuild failed: {esbuild_stderr[:500]}")

                # Check if failure is due to Node.js built-in modules
                node_builtins = [
                    'path', 'fs', 'os', 'child_process', 'crypto', 'http', 'https',
                    'net', 'stream', 'util', 'events', 'buffer', 'url', 'querystring',
                    'zlib', 'readline', 'cluster', 'dgram', 'dns', 'tls', 'vm',
                    'worker_threads', 'assert', 'module', 'process', 'perf_hooks',
                ]
                has_node_builtin_error = any(
                    f'Could not resolve "{mod}"' in esbuild_stderr
                    for mod in node_builtins
                )

                if has_node_builtin_error:
                    # Pure Node.js code — cannot run in browser, let frontend fall back to sandbox exec
                    build_time_ms = int((time.time() - start_time) * 1000)
                    return BundleResult(
                        success=False,
                        error=f"Node.js code detected (uses built-in modules). Cannot bundle for browser. {esbuild_stderr[:300]}",
                        build_time_ms=build_time_ms,
                    )

                # Non-Node.js failure — only use raw fallback if code looks browser-oriented
                all_code = '\n'.join(files.get(f, '') for f in files if f.endswith(('.js', '.ts', '.jsx', '.tsx')))
                if not all_code.strip():
                    all_code = request.code

                if detect_is_browser_code(all_code):
                    # Looks like browser code — try raw fallback
                    import re as _re
                    fallback_code = _re.sub(
                        r"^(?:const|let|var)\s+\w+\s*=\s*require\(.+?\);?\s*$", "// [bundler: removed require]",
                        all_code, flags=_re.MULTILINE
                    )
                    fallback_code = _re.sub(
                        r"^module\.exports\s*=.*$", "// [bundler: removed module.exports]",
                        fallback_code, flags=_re.MULTILINE
                    )

                    template = request.html_template or DEFAULT_HTML_TEMPLATE
                    html = template.replace('{{SCRIPT}}', fallback_code)

                    build_time_ms = int((time.time() - start_time) * 1000)
                    return BundleResult(
                        success=True,
                        html=html,
                        build_time_ms=build_time_ms,
                        bundled_size_bytes=len(fallback_code.encode()),
                        installed_deps=installed_deps,
                        warnings=[f"esbuild failed, using raw code fallback: {esbuild_stderr[:200]}"] + warnings,
                    )
                else:
                    # Not browser code either — fail, let frontend decide
                    build_time_ms = int((time.time() - start_time) * 1000)
                    return BundleResult(
                        success=False,
                        error=f"esbuild failed and code doesn't appear to be browser code: {esbuild_stderr[:300]}",
                        build_time_ms=build_time_ms,
                    )

            if esbuild_stderr.strip():
                warnings.append(f"esbuild: {esbuild_stderr[:300]}")

        except asyncio.TimeoutError:
            return BundleResult(
                success=False,
                error=f"esbuild timed out ({request.timeout}s)",
                build_time_ms=int((time.time() - start_time) * 1000),
            )

        # 6. Read bundled code
        if not bundle_out.exists():
            return BundleResult(
                success=False,
                error="esbuild produced no output",
                build_time_ms=int((time.time() - start_time) * 1000),
            )

        bundled_js = bundle_out.read_text(errors='replace')
        bundled_size = len(bundled_js.encode())

        # 7. Wrap in HTML template
        template = request.html_template or DEFAULT_HTML_TEMPLATE
        html = template.replace('{{SCRIPT}}', bundled_js)

        build_time_ms = int((time.time() - start_time) * 1000)

        logger.info(f"Bundle complete: {bundled_size} bytes, {build_time_ms}ms")

        return BundleResult(
            success=True,
            html=html,
            build_time_ms=build_time_ms,
            bundled_size_bytes=bundled_size,
            installed_deps=installed_deps,
            warnings=warnings,
        )

    except Exception as e:
        logger.exception(f"Bundle error: {e}")
        return BundleResult(
            success=False,
            error=str(e)[:500],
            build_time_ms=int((time.time() - start_time) * 1000),
        )
    finally:
        for attempt in range(3):
            try:
                shutil.rmtree(work_dir)
                break
            except Exception as e:
                if attempt < 2:
                    await asyncio.sleep(0.5)
                else:
                    logger.warning(f"Failed to cleanup {work_dir} after 3 attempts: {e}")
