#!/usr/bin/env bash
# R13 frontend test runner. Requires Node 22+ (for --experimental-strip-types).
#
# Usage: bash frontend/tests/run_all.sh
set -euo pipefail
cd "$(dirname "$0")"

echo "=== R13 onboarding tests ==="
node --experimental-strip-types --test test_round13_onboarding.mjs

echo
echo "=== R13 demo-timelines tests ==="
node --test test_round13_demo_timelines.mjs

echo
echo "=== R13 timeline-player tests ==="
node --test test_round13_timeline_player.mjs

echo
echo "All R13 frontend tests passed."
