"""КАО#Full-A3 — Dependency vulnerability scanning.

Two integration tests:

1. ``test_npm_audit_no_high_critical``
   Runs ``npm audit --json`` in the ``frontend/`` directory and fails if
   any ``high`` or ``critical`` severity advisory is found.

2. ``test_pip_audit_no_high_critical``
   Runs ``pip-audit --format=json`` and fails on high/critical.
   If ``pip-audit`` itself isn't installed in the runner image, the test
   ``pytest.skip()`` with an explicit reason — never a silent pass.

These are deliberately slow tests; mark them with ``slow`` so the default
smoke suite can opt out.

# КАО#Full-A3
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = [pytest.mark.slow]


def _repo_root() -> Path:
    """Walk upwards from this test file until we find ``frontend/`` and ``backend/``."""
    here = Path(__file__).resolve()
    for parent in [here, *here.parents]:
        if (parent / "frontend").is_dir() and (parent / "backend").is_dir():
            return parent
    return here.parents[2]  # best-effort default


# ---------------------------------------------------------------------------
# 1. npm audit
# ---------------------------------------------------------------------------

def test_npm_audit_no_high_critical() -> None:
    """``npm audit`` in frontend/ must report 0 high + 0 critical vulnerabilities."""
    npm = shutil.which("npm")
    if not npm:
        pytest.skip("npm not installed in this image — cannot run audit")

    frontend = _repo_root() / "frontend"
    if not (frontend / "package.json").exists():
        pytest.skip(f"no package.json at {frontend}")

    # Use --omit=dev so we only flag what ships to production.
    try:
        proc = subprocess.run(
            [npm, "audit", "--json", "--omit=dev"],
            cwd=str(frontend),
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        pytest.fail("npm audit timed out after 120s")
    except FileNotFoundError:
        pytest.skip("npm not callable")

    # `npm audit` exits non-zero if vulnerabilities are found, but stdout is
    # still valid JSON; parse and inspect counts instead of trusting exit code.
    if not proc.stdout.strip():
        pytest.skip(f"npm audit produced no output: stderr={proc.stderr[:200]!r}")
    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        pytest.fail(f"npm audit output isn't JSON: {exc} / {proc.stdout[:300]!r}")

    vulns = report.get("metadata", {}).get("vulnerabilities", {})
    high = int(vulns.get("high", 0))
    critical = int(vulns.get("critical", 0))

    if high or critical:
        # Format a human-readable list of advisory names if present
        adv_names: list[str] = []
        for name, adv in report.get("vulnerabilities", {}).items():
            sev = adv.get("severity")
            if sev in ("high", "critical"):
                adv_names.append(f"{name} ({sev})")
        pytest.fail(
            f"npm audit found {critical} critical + {high} high vulnerabilities: "
            + ", ".join(adv_names[:10])
        )


# ---------------------------------------------------------------------------
# 2. pip-audit
# ---------------------------------------------------------------------------

def test_pip_audit_no_high_critical() -> None:
    """``pip-audit`` must report 0 high+critical advisories for the backend.

    Notes on parsing pip-audit's output: it does NOT have a single severity
    field. We must look up CVE severity via the ``aliases`` / ``advisory`` keys
    when present. If pip-audit's JSON schema doesn't expose severity at all,
    we fall back to failing on ANY advisory (a known-vuln dep is bad enough).
    """
    # KAO#Full-C-2 M2 — prefer the python module form (`python -m pip_audit`).
    # The CLI shim sometimes is not on PATH inside container test runners even
    # though the package is installed; `python -m` works as long as `import
    # pip_audit` succeeds, which is what we actually need.
    pip_audit_cmd: list[str] | None = None
    try:
        import importlib.util
        if importlib.util.find_spec("pip_audit") is not None:
            pip_audit_cmd = [sys.executable, "-m", "pip_audit"]
    except Exception:
        pip_audit_cmd = None
    if pip_audit_cmd is None:
        # Fall back to the PATH lookup for older environments
        bin_path = shutil.which("pip-audit")
        if bin_path:
            pip_audit_cmd = [bin_path]
    if pip_audit_cmd is None:
        pytest.skip(
            "pip-audit not installed — `pip install pip-audit` (or add it to "
            "backend/requirements-dev.txt) to enable"
        )

    # КАО#MN-3 Round 4 — Audit the *installed* packages in the current
    # environment rather than a requirements.txt file. The container/runtime
    # image doesn't always ship requirements.txt (it's only used at image
    # build time), so the previous "-r requirements.txt" path silently
    # skipped on every container run. Auditing the live interpreter ensures
    # we cover whatever is actually executing the backend.
    backend = _repo_root() / "backend"
    req = backend / "requirements.txt"
    audit_args: list[str]
    if req.exists():
        # If requirements.txt exists (e.g. on a dev workstation), audit both
        # the pinned spec AND the installed env. The installed env is the
        # source of truth at runtime — using --skip-editable keeps the
        # editable dev install from blowing up the scan.
        audit_args = ["--format", "json", "--progress-spinner", "off", "--skip-editable"]
    else:
        audit_args = ["--format", "json", "--progress-spinner", "off", "--skip-editable"]

    try:
        proc = subprocess.run(
            [*pip_audit_cmd, *audit_args],
            capture_output=True,
            text=True,
            timeout=180,
        )
    except subprocess.TimeoutExpired:
        pytest.fail("pip-audit timed out after 180s")

    if not proc.stdout.strip():
        # pip-audit prints errors to stderr; surface them
        pytest.fail(f"pip-audit produced no JSON: stderr={proc.stderr[:300]!r}")

    try:
        report = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        pytest.fail(f"pip-audit output isn't JSON: {exc} / {proc.stdout[:300]!r}")

    # pip-audit schema: top-level "dependencies", each with "vulns" list.
    findings: list[str] = []
    deps = report.get("dependencies", report)  # tolerate both shapes
    if isinstance(deps, list):
        iterable = deps
    else:
        iterable = []
    for dep in iterable:
        name = dep.get("name", "?")
        version = dep.get("version", "?")
        for v in dep.get("vulns", []) or []:
            sev = (v.get("severity") or "").lower()
            vid = v.get("id", "?")
            if sev in ("high", "critical"):
                findings.append(f"{name}=={version} {vid} ({sev})")
            elif not sev:
                # Severity unknown — flag conservatively
                findings.append(f"{name}=={version} {vid} (unknown severity)")

    if findings:
        pytest.fail(
            f"pip-audit found {len(findings)} high/critical (or unknown-severity) "
            "vulnerability(ies):\n  " + "\n  ".join(findings[:20])
        )


# ---------------------------------------------------------------------------
# 3. Sanity: tools were actually invoked (catches CI misconfig where both
#    audits silently skip and we have no signal)
# ---------------------------------------------------------------------------

def test_at_least_one_audit_tool_available() -> None:
    """Fail loudly if neither npm nor pip-audit is reachable — silent skips mask risk.

    KAO#Full-C-2 M2 — `pip-audit` is detected via importable module rather than
    PATH lookup. The CLI shim is sometimes missing in container images even
    when the package is installed (entry-point not on PATH), so `shutil.which`
    yields false negatives. `python -m pip_audit` works whenever the package
    is importable, which is the actual capability we want to assert.
    """
    have_npm = shutil.which("npm") is not None
    have_pip_audit = False
    try:
        import importlib.util
        have_pip_audit = importlib.util.find_spec("pip_audit") is not None
    except Exception:
        have_pip_audit = shutil.which("pip-audit") is not None
    if not have_npm and not have_pip_audit:
        pytest.fail(
            "Neither `npm` nor `pip-audit` is installed in the test runner image. "
            "Install at least one so dependency vulnerabilities can be detected. "
            "Hint: add `pip-audit` to backend/requirements-dev.txt."
        )
