"""Patch mandelbulb.json final_code: change default n1 (nEnd) to 15.

User feedback: UI input shows value="25" but the JS initial state was nEnd=20,
so the animation actually stops at 20 even when the field reads 25. User wants
n1 = 15 by default, with HTML and JS in sync.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]

ROOT = Path(__file__).resolve().parents[2]
JSON_PATH = ROOT / "frontend" / "public" / "demo-templates" / "mandelbulb.json"

REPLACEMENTS = [
    # 1) HTML input default: 25 -> 15
    (
        '<label>n₁ <input type="number" id="nEnd" value="25" min="2" max="50"></label>',
        '<label>n₁ <input type="number" id="nEnd" value="15" min="2" max="50"></label>',
    ),
    # 2) JS initial state: nEnd=20 -> nEnd=15
    (
        'let nStart=4,nEnd=20;',
        'let nStart=4,nEnd=15;',
    ),
    # 3) Restart fallback: ||20 -> ||15 (so empty input also resolves to 15)
    (
        "let a=+$('nStart').value||4, b=+$('nEnd').value||20;",
        "let a=+$('nStart').value||4, b=+$('nEnd').value||15;",
    ),
]


def main() -> int:
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))
    fc = data["final_code"]
    for old, new in REPLACEMENTS:
        c = fc.count(old)
        if c != 1:
            print(f"FAIL: expected 1 occurrence of {old[:80]!r}, found {c}")
            return 1
        fc = fc.replace(old, new, 1)
        print(f"OK: {old[:90]}")
    data["final_code"] = fc
    JSON_PATH.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\nWrote {JSON_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
