#!/usr/bin/env python3
"""R13 — Stage smoke test: mandelbulb.json deploy verification.

Fetches `https://stage.gotcode.ai/demo-templates/mandelbulb.json` and verifies:
  - HTTP 200
  - Body parses as JSON
  - Has the expected 14 narration_chapters
  - Top-level fields (id, name, language, events, final_code, simplified_code)

Usage:
  python tests/reports/round13_stage_mandelbulb_smoke.py
  # exits 0 on green, non-zero on regression.
"""
from __future__ import annotations
import json
import sys
import urllib.request

URL = "https://stage.gotcode.ai/demo-templates/mandelbulb.json"
EXPECTED_CHAPTERS = 14

def main() -> int:
    print(f"GET {URL}")
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": "codeforge-r13-smoke"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status != 200:
                print(f"FAIL: HTTP {resp.status}")
                return 2
            body = resp.read().decode("utf-8")
    except Exception as e:
        print(f"FAIL: fetch error: {e}")
        return 3

    try:
        d = json.loads(body)
    except json.JSONDecodeError as e:
        print(f"FAIL: invalid JSON: {e}")
        return 4

    errs: list[str] = []
    for f in ("id", "name", "language", "duration_seconds", "events", "final_code",
              "simplified_code", "narration_chapters"):
        if f not in d:
            errs.append(f"missing field: {f}")

    chapters = d.get("narration_chapters", [])
    if not isinstance(chapters, list):
        errs.append("narration_chapters not a list")
    elif len(chapters) != EXPECTED_CHAPTERS:
        errs.append(f"expected {EXPECTED_CHAPTERS} chapters, got {len(chapters)}")

    expected_ids = {
        "specification", "coding-1", "testing-1", "summarizer-1",
        "coding-2", "testing-2", "summarizer-2", "finalizer",
        "first-run", "enh-intro", "dfs", "enh-summarizer",
        "rerun", "final-run",
    }
    actual_ids = {c.get("id") for c in chapters if isinstance(c, dict)}
    missing_ids = expected_ids - actual_ids
    if missing_ids:
        errs.append(f"missing chapter ids: {missing_ids}")

    if errs:
        print("FAIL:")
        for e in errs:
            print(f"  - {e}")
        return 1

    print(f"PASS: mandelbulb.json deployed correctly.")
    print(f"  duration_seconds: {d['duration_seconds']}")
    print(f"  events: {len(d['events'])}")
    print(f"  narration_chapters: {len(chapters)}")
    print(f"  simplified_code len: {len(d['simplified_code'])}")
    print(f"  final_code len: {len(d['final_code'])}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
