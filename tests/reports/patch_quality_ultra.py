"""Patch frontend/public/demo-templates/mandelbulb.json final_code:
- Adds an "Ultra" quality option (value=3) and makes it the default
- Bumps Maximum to native screen resolution
- Lifts the adaptive-resScale gate so Maximum and Ultra also auto-downgrade
  on weak GPUs (graceful degradation)
- Increases pixelCap, rmSteps, deIters, shadowSteps, aoSteps, dprMax for
  the new Maximum and Ultra modes

Run from repo root:
    python tests/reports/patch_quality_ultra.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
JSON_PATH = ROOT / "frontend" / "public" / "demo-templates" / "mandelbulb.json"


REPLACEMENTS: list[tuple[str, str]] = [
    # 1) <select> options — add Ultra, move "selected" to Ultra
    (
        '<select id="quality">\n'
        '      <option value="0" selected>Performance</option>\n'
        '      <option value="1">Balanced</option>\n'
        '      <option value="2">Maximum</option>\n'
        '    </select>',
        '<select id="quality">\n'
        '      <option value="0">Performance</option>\n'
        '      <option value="1">Balanced</option>\n'
        '      <option value="2">Maximum</option>\n'
        '      <option value="3" selected>Ultra</option>\n'
        '    </select>',
    ),
    # 2) initial qualityMode 0 -> 3 (Ultra)
    (
        'let resScale=0.04, RW=2,RH=2, qualityMode=0;',
        'let resScale=0.04, RW=2,RH=2, qualityMode=3;',
    ),
    # 3) pixelCap: 420^2 / 900^2 / 1600^2 -> + Ultra 2880^2, Max bumped to 1920^2
    (
        'return qualityMode===0?420*420:qualityMode===1?900*900:1600*1600;',
        'return qualityMode===0?420*420:qualityMode===1?900*900:qualityMode===2?1920*1920:2880*2880;',
    ),
    # 4) rmSteps: 55 / 95 / 140 -> + Ultra 200
    (
        'return qualityMode===0?55:qualityMode===1?95:140;',
        'return qualityMode===0?55:qualityMode===1?95:qualityMode===2?140:200;',
    ),
    # 5) deIters: 8 / 10 / 12 -> + Ultra 16
    (
        'return qualityMode===2?12:qualityMode===1?10:8;',
        'return qualityMode===3?16:qualityMode===2?12:qualityMode===1?10:8;',
    ),
    # 6) shadowSteps: 6 / 8 / 10 -> + Ultra 12
    (
        'return qualityMode===0?6:qualityMode===1?8:10;',
        'return qualityMode===0?6:qualityMode===1?8:qualityMode===2?10:12;',
    ),
    # 7) aoSteps: 3 / 4 / 4 -> + Ultra 5
    (
        'return qualityMode===0?3:4;',
        'return qualityMode===0?3:qualityMode===3?5:4;',
    ),
    # 8) dprMax: 1.0 / 1.0 / 1.5 -> + Ultra 2.0
    (
        'const dprMax=qualityMode===2?1.5:1.0;',
        'const dprMax=qualityMode===3?2.0:qualityMode===2?1.5:1.0;',
    ),
    # 9) Adaptive resScale gate — drop qualityMode<2 lock, add per-mode caps
    (
        'if(qualityMode<2 && resizeCD===0 && framesRendered>30){\n'
        '    const maxScale=isSoftware?0.12:0.55;\n'
        '    if(fpsAvg<18 && resScale>0.04){resScale=Math.max(0.04,resScale-0.04); resize(); resizeCD=90;}\n'
        '    else if(fpsAvg>45 && resScale<maxScale){resScale=Math.min(maxScale,resScale+0.03); resize(); resizeCD=120;}\n'
        '  }',
        'if(resizeCD===0 && framesRendered>30){\n'
        '    const maxScale=isSoftware?0.12:(qualityMode===0?0.55:qualityMode===1?0.75:qualityMode===2?1.15:1.5);\n'
        '    const minScale=qualityMode>=2?0.5:0.04;\n'
        '    if(fpsAvg<18 && resScale>minScale){resScale=Math.max(minScale,resScale-0.04); resize(); resizeCD=90;}\n'
        '    else if(fpsAvg>45 && resScale<maxScale){resScale=Math.min(maxScale,resScale+0.03); resize(); resizeCD=120;}\n'
        '  }',
    ),
    # 10) Initial resScale right after applyUI() — was a single fallback,
    #     now per-mode so Max/Ultra start at screen res instead of 8% of it
    (
        "applyUI();\nresScale=isSoftware?0.03:0.08;\nresize();",
        "applyUI();\nresScale=isSoftware?0.03:(qualityMode===0?0.08:qualityMode===1?0.15:1.0);\nresize();",
    ),
]


def main() -> int:
    raw = JSON_PATH.read_text(encoding="utf-8")
    data = json.loads(raw)
    fc = data["final_code"]

    failures: list[str] = []
    for old, new in REPLACEMENTS:
        count = fc.count(old)
        if count != 1:
            failures.append(f"  FAIL expected exactly 1 occurrence, found {count}: {old[:80]!r}...")
            continue
        fc = fc.replace(old, new, 1)
        print(f"  OK replaced: {old.splitlines()[0][:90]}")

    if failures:
        print("\nFAILED:")
        for f in failures:
            print(f)
        return 1

    data["final_code"] = fc
    JSON_PATH.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\nWrote {JSON_PATH} ({len(fc)} bytes in final_code)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
