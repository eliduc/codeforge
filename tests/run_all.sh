#!/usr/bin/env bash
# CodeForge full test runner.
# Runs all backend pytest, Playwright E2E, k6 smoke, plus reports cumulative status.
#
# Usage:
#   ./tests/run_all.sh                  # local stage (port 3300/8300)
#   STAGE=remote ./tests/run_all.sh     # via ssh miniblack ~/codeforge-stage
#   ./tests/run_all.sh --quick          # skip slow (workflow_lifecycle, k6 stress)
#   ./tests/run_all.sh --backend-only   # skip Playwright + k6
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
STAGE="${STAGE:-local}"
QUICK="${QUICK:-0}"
BACKEND_ONLY="${BACKEND_ONLY:-0}"

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) QUICK=1 ;;
    --backend-only) BACKEND_ONLY=1 ;;
    --help|-h)
      sed -n '2,8p' "$0"
      exit 0
      ;;
  esac
  shift
done

PASS=0
FAIL=0
SKIP=0

color() {
  local c="$1"; shift
  case "$c" in
    red)    echo -e "\033[31m$*\033[0m" ;;
    green)  echo -e "\033[32m$*\033[0m" ;;
    yellow) echo -e "\033[33m$*\033[0m" ;;
    blue)   echo -e "\033[34m$*\033[0m" ;;
    *)      echo "$*" ;;
  esac
}

section() {
  echo
  color blue "=========================================="
  color blue "  $*"
  color blue "=========================================="
}

run() {
  local name="$1"; shift
  echo
  color yellow ">>> $name"
  if "$@"; then
    color green "  ✓ PASS: $name"
    PASS=$((PASS + 1))
  else
    color red "  ✗ FAIL: $name (exit $?)"
    FAIL=$((FAIL + 1))
  fi
}

skip() {
  color yellow "  - SKIP: $1"
  SKIP=$((SKIP + 1))
}

# ─── Backend pytest ─────────────────────────────────────
section "Backend pytest"

if [ "$STAGE" = "remote" ]; then
  PYTEST_CMD="ssh miniblack 'cd ~/codeforge-stage && docker compose exec -T backend python -m pytest"
  PYTEST_END="--tb=short 2>&1'"
else
  PYTEST_CMD="cd '$ROOT_DIR' && docker compose exec -T backend python -m pytest"
  PYTEST_END="--tb=short 2>&1"
fi

run "Smoke + health" bash -c "$PYTEST_CMD tests/test_health.py tests/test_auth_smoke.py -v $PYTEST_END | tail -10"

run "Authenticated flow" bash -c "$PYTEST_CMD tests/test_authenticated_flow.py -v -m e2e $PYTEST_END | tail -15"

run "Sessions CRUD" bash -c "$PYTEST_CMD tests/test_sessions_crud.py -v -m e2e $PYTEST_END | tail -25"

run "Multi-tenancy" bash -c "$PYTEST_CMD tests/test_multitenancy.py -v -m e2e $PYTEST_END | tail -20"

run "Security" bash -c "$PYTEST_CMD tests/test_security.py -v -m e2e $PYTEST_END | tail -25"

run "Features" bash -c "$PYTEST_CMD tests/test_features.py -v -m e2e $PYTEST_END | tail -20"

if [ "$QUICK" = "1" ]; then
  skip "Workflow lifecycle (slow tests skipped per --quick)"
else
  run "Workflow lifecycle" bash -c "$PYTEST_CMD tests/test_workflow_lifecycle.py -v -m 'e2e and slow' $PYTEST_END | tail -25"
fi

# ─── Playwright E2E ──────────────────────────────────────
if [ "$BACKEND_ONLY" = "1" ]; then
  section "Playwright E2E (skipped per --backend-only)"
else
  section "Playwright E2E"
  if command -v npx >/dev/null 2>&1; then
    if [ -d "$ROOT_DIR/e2e/node_modules" ]; then
      run "Playwright tests" bash -c "cd '$ROOT_DIR/e2e' && npx playwright test --reporter=list 2>&1 | tail -30"
    else
      skip "Playwright (run 'cd e2e && npm install && npm run install-browsers' first)"
    fi
  else
    skip "Playwright (npx not found)"
  fi
fi

# ─── k6 smoke ────────────────────────────────────────────
if [ "$BACKEND_ONLY" = "1" ]; then
  section "k6 load (skipped per --backend-only)"
elif [ "$QUICK" = "1" ]; then
  section "k6 load (skipped per --quick)"
else
  section "k6 load smoke"
  if command -v k6 >/dev/null 2>&1; then
    BASE_URL_K6="${BASE_URL:-http://localhost:8300}"
    run "k6 smoke" bash -c "BASE_URL='$BASE_URL_K6' k6 run --quiet '$ROOT_DIR/load-tests/smoke.js' 2>&1 | tail -25"
  else
    skip "k6 (install: brew install k6)"
  fi
fi

# ─── Final report ────────────────────────────────────────
section "FINAL REPORT"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  color green "  ✓ $PASS passed, $SKIP skipped (of $TOTAL run)"
  exit 0
else
  color red   "  ✗ $FAIL FAILED, $PASS passed, $SKIP skipped (of $TOTAL run)"
  exit 1
fi
