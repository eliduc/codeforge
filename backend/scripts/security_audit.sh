#!/usr/bin/env bash
# КАО#Full-A3 — Manual security audit script for CodeForge.
#
# Runs the same dependency-vulnerability checks that the
# ``test_kao_full_deps.py`` pytest module wraps, in a form ops can invoke
# directly outside the test runner. Useful before a release.
#
# Usage:
#   ./backend/scripts/security_audit.sh                  # run both audits
#   ./backend/scripts/security_audit.sh --npm-only       # frontend only
#   ./backend/scripts/security_audit.sh --pip-only       # backend only
#
# Exit codes:
#   0 — no high/critical advisories found
#   1 — vulnerabilities found
#   2 — required tooling missing
#
set -euo pipefail

# Resolve repo root (script lives in backend/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

NPM_ONLY=0
PIP_ONLY=0
for arg in "$@"; do
    case "$arg" in
        --npm-only) NPM_ONLY=1 ;;
        --pip-only) PIP_ONLY=1 ;;
        -h|--help)
            grep '^#' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
    esac
done

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
YELLOW=$'\033[0;33m'
RESET=$'\033[0m'

fail=0

# ---------------------------------------------------------------------------
# npm audit (frontend)
# ---------------------------------------------------------------------------
run_npm_audit() {
    local frontend="${REPO_ROOT}/frontend"
    if [[ ! -f "${frontend}/package.json" ]]; then
        echo "${YELLOW}[skip]${RESET} ${frontend}/package.json missing"
        return 0
    fi
    if ! command -v npm >/dev/null 2>&1; then
        echo "${YELLOW}[skip]${RESET} npm not installed"
        return 2
    fi

    echo "==> Running npm audit in ${frontend}"
    local out
    if ! out="$(cd "${frontend}" && npm audit --json --omit=dev 2>&1)"; then
        : # non-zero exit is normal when vulns exist; we parse json next
    fi

    if ! command -v jq >/dev/null 2>&1; then
        # No jq — at least print the summary
        echo "${YELLOW}(install jq for parsed output)${RESET}"
        echo "${out}" | grep -E '"(high|critical)"' || true
    else
        local crit high
        crit="$(echo "${out}" | jq -r '.metadata.vulnerabilities.critical // 0')"
        high="$(echo "${out}" | jq -r '.metadata.vulnerabilities.high // 0')"
        echo "  critical=${crit} high=${high}"
        if [[ "${crit}" -gt 0 || "${high}" -gt 0 ]]; then
            echo "${RED}[FAIL]${RESET} npm: ${crit} critical + ${high} high"
            echo "${out}" | jq -r '.vulnerabilities | to_entries[] | "  - \(.key) (\(.value.severity))"' | head -20
            return 1
        else
            echo "${GREEN}[OK]${RESET} npm: no high/critical"
        fi
    fi
    return 0
}

# ---------------------------------------------------------------------------
# pip-audit (backend)
# ---------------------------------------------------------------------------
run_pip_audit() {
    local req="${REPO_ROOT}/backend/requirements.txt"
    if [[ ! -f "${req}" ]]; then
        echo "${YELLOW}[skip]${RESET} ${req} missing"
        return 0
    fi
    if ! command -v pip-audit >/dev/null 2>&1; then
        echo "${YELLOW}[skip]${RESET} pip-audit not installed (run: pip install pip-audit)"
        return 2
    fi

    echo "==> Running pip-audit on ${req}"
    local out
    if ! out="$(pip-audit -r "${req}" --format json --progress-spinner off 2>/dev/null)"; then
        : # non-zero on findings; still parses
    fi

    if ! command -v jq >/dev/null 2>&1; then
        echo "${YELLOW}(install jq for parsed output)${RESET}"
        echo "${out}" | grep -E '"(high|critical|vulnerability|id)"' || true
    else
        local n_findings
        n_findings="$(echo "${out}" | jq '[.dependencies[]?.vulns[]?] | length')"
        echo "  total findings=${n_findings}"
        if [[ "${n_findings}" -gt 0 ]]; then
            echo "${RED}[FAIL]${RESET} pip-audit: ${n_findings} vulnerable package(s)"
            echo "${out}" | jq -r '.dependencies[]? | select(.vulns | length > 0) | .vulns[] as $v | "  - \(.name)==\(.version) \($v.id) (\($v.severity // "unknown"))"' | head -20
            return 1
        else
            echo "${GREEN}[OK]${RESET} pip-audit: no vulnerabilities"
        fi
    fi
    return 0
}

# ---------------------------------------------------------------------------
# Drive
# ---------------------------------------------------------------------------
if [[ "${PIP_ONLY}" -eq 0 ]]; then
    run_npm_audit || fail=$?
fi
if [[ "${NPM_ONLY}" -eq 0 ]]; then
    run_pip_audit || { rc=$?; [[ "${rc}" -gt "${fail}" ]] && fail=${rc}; }
fi

echo
if [[ "${fail}" -eq 0 ]]; then
    echo "${GREEN}Security audit passed.${RESET}"
elif [[ "${fail}" -eq 2 ]]; then
    echo "${YELLOW}Audit incomplete — required tooling missing.${RESET}"
else
    echo "${RED}Security audit FAILED — see findings above.${RESET}"
fi
exit "${fail}"
