"""Flip horizontal drag direction in mandelbulb final_code + simplified_code.

User feedback: dragging the mouse left rotates the figure counter-clockwise;
expected behaviour is clockwise (drag-left "pushes" the front of the object
to the left).

The fix is a sign flip on the yaw delta. Pitch (vertical) is left untouched.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JSON_PATH = ROOT / "frontend" / "public" / "demo-templates" / "mandelbulb.json"


def main() -> int:
    data = json.loads(JSON_PATH.read_text(encoding="utf-8"))

    # final_code (enhanced):
    fc = data["final_code"]
    old_fc = "yaw+=(e.clientX-px)*0.005"
    new_fc = "yaw-=(e.clientX-px)*0.005"
    if fc.count(old_fc) != 1:
        print(f"FAIL final_code: expected 1 occurrence of {old_fc!r}, found {fc.count(old_fc)}")
        return 1
    data["final_code"] = fc.replace(old_fc, new_fc, 1)
    print(f"OK final_code: flipped {old_fc!r}")

    # simplified_code:
    sc = data["simplified_code"]
    old_sc = "_userYaw += (e.clientX - _px) * 0.006"
    new_sc = "_userYaw -= (e.clientX - _px) * 0.006"
    if sc.count(old_sc) != 1:
        print(f"FAIL simplified_code: expected 1 occurrence of {old_sc!r}, found {sc.count(old_sc)}")
        return 1
    data["simplified_code"] = sc.replace(old_sc, new_sc, 1)
    print(f"OK simplified_code: flipped {old_sc!r}")

    JSON_PATH.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\nWrote {JSON_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
