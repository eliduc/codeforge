"""
Docker-based code executor for sandboxed execution.
"""
import tempfile
import os
import time
from typing import Dict, Any
import logging

from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


class DockerExecutor:
    """Execute code safely in Docker containers."""

    # Language to Docker image mapping
    IMAGES = {
        "python": settings.sandbox_image,
        "javascript": "node:20-slim",
        "typescript": "node:20-slim",
    }

    # Language to file extension mapping
    EXTENSIONS = {
        "python": ".py",
        "javascript": ".js",
        "typescript": ".ts",
    }

    # Language to run command mapping
    RUN_COMMANDS = {
        "python": "python",
        "javascript": "node",
        "typescript": "npx ts-node",
    }

    def __init__(self):
        self.docker_available = self._check_docker()

    def _check_docker(self) -> bool:
        """Check if Docker is available."""
        try:
            import docker
            client = docker.from_env()
            client.ping()
            return True
        except Exception as e:
            logger.warning(f"Docker not available: {e}")
            return False

    async def execute(
        self,
        code: str,
        language: str = "python",
        timeout: int = None,
        memory_limit: str = None,
        stdin: str = None,
    ) -> Dict[str, Any]:
        """
        Execute code in a Docker container.

        Args:
            code: Source code to execute
            language: Programming language
            timeout: Execution timeout in seconds
            memory_limit: Memory limit (e.g., "512m")
            stdin: Optional stdin input

        Returns:
            Dict with exit_code, stdout, stderr, execution_time_ms
        """
        timeout = timeout or settings.execution_timeout
        memory_limit = memory_limit or f"{settings.max_memory_mb}m"

        if not self.docker_available:
            return {
                "exit_code": -1,
                "stdout": "",
                "stderr": "Docker is not available. Code execution requires the sandbox service.",
                "execution_time_ms": 0,
            }

        try:
            import docker
            client = docker.from_env()
        except Exception as e:
            logger.warning(f"Docker client error: {e}")
            return {
                "exit_code": -1,
                "stdout": "",
                "stderr": f"Docker client error: {e}. Code execution requires the sandbox service.",
                "execution_time_ms": 0,
            }

        # Get image for language
        image = self.IMAGES.get(language, self.IMAGES["python"])
        extension = self.EXTENSIONS.get(language, ".py")
        run_cmd = self.RUN_COMMANDS.get(language, "python")

        # Create temporary file with code
        with tempfile.TemporaryDirectory() as tmpdir:
            code_file = os.path.join(tmpdir, f"code{extension}")
            with open(code_file, "w") as f:
                f.write(code)

            # Write stdin to a file if provided, so it can be piped into the program
            if stdin:
                stdin_file = os.path.join(tmpdir, "stdin.txt")
                with open(stdin_file, "w") as sf:
                    sf.write(stdin)

            # Build command
            if stdin:
                command = f"/bin/sh -c 'cat /code/stdin.txt | {run_cmd} /code/code{extension}'"
            else:
                command = f"{run_cmd} /code/code{extension}"

            start_time = time.time()

            try:
                # Run container (remove=False so we can read logs after wait)
                container = client.containers.run(
                    image=image,
                    command=command,
                    volumes={tmpdir: {"bind": "/code", "mode": "ro"}},
                    mem_limit=memory_limit,
                    network_mode="none",  # No network access
                    remove=False,
                    detach=True,
                )

                # Wait for completion with timeout
                try:
                    result = container.wait(timeout=timeout)
                    exit_code = result["StatusCode"]
                    stdout = container.logs(stdout=True, stderr=False).decode("utf-8", errors="replace")
                    stderr = container.logs(stdout=False, stderr=True).decode("utf-8", errors="replace")
                except Exception:
                    # Timeout or other error
                    try:
                        container.kill()
                    except Exception:
                        pass
                    try:
                        container.remove(force=True)
                    except Exception:
                        pass

                    return {
                        "exit_code": -1,
                        "stdout": "",
                        "stderr": f"Execution timeout ({timeout}s exceeded)",
                        "execution_time_ms": int((time.time() - start_time) * 1000),
                    }

                execution_time = int((time.time() - start_time) * 1000)

                # Clean up container after reading logs
                try:
                    container.remove(force=True)
                except Exception:
                    pass

                return {
                    "exit_code": exit_code,
                    "stdout": stdout[:50000],  # Limit output size
                    "stderr": stderr[:50000],
                    "execution_time_ms": execution_time,
                }

            except docker.errors.ImageNotFound:
                # Try to pull image once (no recursion)
                try:
                    client.images.pull(image)
                except Exception as pull_error:
                    return {
                        "exit_code": -1,
                        "stdout": "",
                        "stderr": f"Image not found and pull failed: {pull_error}",
                        "execution_time_ms": 0,
                    }
                # Retry the container run once after pulling
                try:
                    container = client.containers.run(
                        image=image,
                        command=command,
                        volumes={tmpdir: {"bind": "/code", "mode": "ro"}},
                        mem_limit=memory_limit,
                        network_mode="none",
                        remove=False,
                        detach=True,
                    )
                    result = container.wait(timeout=timeout)
                    exit_code = result["StatusCode"]
                    stdout = container.logs(stdout=True, stderr=False).decode("utf-8", errors="replace")
                    stderr = container.logs(stdout=False, stderr=True).decode("utf-8", errors="replace")
                    try:
                        container.remove(force=True)
                    except Exception:
                        pass
                    return {
                        "exit_code": exit_code,
                        "stdout": stdout[:50000],
                        "stderr": stderr[:50000],
                        "execution_time_ms": int((time.time() - start_time) * 1000),
                    }
                except Exception as retry_error:
                    return {
                        "exit_code": -1,
                        "stdout": "",
                        "stderr": f"Container error after image pull: {retry_error}",
                        "execution_time_ms": int((time.time() - start_time) * 1000),
                    }
            except Exception as e:
                return {
                    "exit_code": -1,
                    "stdout": "",
                    "stderr": f"Container error: {str(e)}",
                    "execution_time_ms": int((time.time() - start_time) * 1000),
                }

    async def check_syntax(
        self,
        code: str,
        language: str = "python",
    ) -> Dict[str, Any]:
        """Check code syntax without executing."""
        if language == "python":
            try:
                compile(code, "<string>", "exec")
                return {"valid": True, "error": None}
            except SyntaxError as e:
                return {
                    "valid": False,
                    "error": f"Line {e.lineno}: {e.msg}",
                }

        return {"valid": True, "error": None}  # Can't check other languages

    def extract_dependencies(self, code: str, language: str = "python") -> list:
        """Extract dependencies from code."""
        dependencies = []

        if language == "python":
            import re
            # Match import statements
            import_pattern = r"^(?:from\s+(\S+)|import\s+(\S+))"

            for line in code.split("\n"):
                line = line.strip()
                match = re.match(import_pattern, line)
                if match:
                    module = match.group(1) or match.group(2)
                    # Get root module
                    root_module = module.split(".")[0]
                    # Skip standard library (approximation)
                    if root_module not in [
                        "os", "sys", "re", "json", "math", "random", "datetime",
                        "collections", "itertools", "functools", "typing", "abc",
                        "pathlib", "io", "time", "logging", "copy", "enum",
                        "dataclasses", "asyncio", "concurrent", "threading",
                        "multiprocessing", "subprocess", "socket", "http",
                        "urllib", "email", "html", "xml", "sqlite3", "csv",
                        "pickle", "hashlib", "base64", "uuid", "tempfile",
                        "shutil", "glob", "fnmatch", "stat", "contextlib",
                        "warnings", "traceback", "gc", "inspect", "dis",
                        "unittest", "doctest", "pdb", "profile", "timeit",
                        "string", "textwrap", "struct", "codecs", "locale",
                        "gettext", "argparse", "configparser", "secrets",
                    ]:
                        if root_module not in dependencies:
                            dependencies.append(root_module)

        return dependencies
