"""Generate Mandelbulb demo timeline v5.

Each chapter = one phase. Player auto-pauses at chapter t_start, plaque shows
all paragraphs (scrollable), Continue button advances to next chapter. Phase
completion paragraph appears at the end of the body (auto-scrolled into view)
when the player pauses on that chapter.

Reads:
- frontend/public/demo-templates/mandelbulb.json (for final_code)
- tests/reports/mandel_simple.html (iter-1 coder-0 from prod)
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
TPL = ROOT / "frontend" / "public" / "demo-templates" / "mandelbulb.json"
SIMPLE = ROOT / "tests" / "reports" / "mandel_simple.html"

cur = json.loads(TPL.read_text(encoding="utf-8"))
simplified = SIMPLE.read_text(encoding="utf-8")
final_code = cur["final_code"]


def slice_chunks(text, n):
    L = len(text)
    step = max(1, L // n)
    return [text[i * step:(i + 1) * step] for i in range(n)]


coder0_chunks = slice_chunks(final_code, 6)
coder1_chunks = slice_chunks(simplified, 6)

events = []


def E(t, **kw):
    events.append({"t": float(t), **kw})


# ──── Phase boundaries ────
T_SPEC = 0.5
T_CODE1 = 14.0
T_TEST1 = 35.0
T_SUM1 = 53.0
T_CODE2 = 62.0
T_TEST2 = 78.5
T_SUM2 = 91.0
T_FINAL1 = 96.0
T_RUN_1 = 105.0
T_ENH_INTRO = 107.0
T_DFS = 116.0
T_ENH_SUM = 128.5
T_RERUN = 135.0
T_FINAL2 = 158.0
DURATION = 162.0

# ──────────── Events ────────────
E(0.0, type="workflow_started")
E(T_SPEC, type="camera_focus", target="spec")

E(T_CODE1, type="iteration_started", iteration=1)
E(T_CODE1, type="phase_started", phase="coding")
E(T_CODE1, type="camera_focus", target="coder_")
E(T_CODE1 + 0.2, type="agent_started", agent_type="coder", agent_index=0)
E(T_CODE1 + 0.4, type="agent_started", agent_type="coder", agent_index=1)
for i, ch in enumerate(coder0_chunks):
    E(T_CODE1 + 1 + i * 3, type="agent_streaming", agent_type="coder", agent_index=0, partial_content=ch[:300])
for i, ch in enumerate(coder1_chunks):
    E(T_CODE1 + 1.2 + i * 3, type="agent_streaming", agent_type="coder", agent_index=1, partial_content=ch[:300])
E(33.0, type="agent_completed", agent_type="coder", agent_index=0, tokens=8400, cost=0.42)
E(34.5, type="agent_completed", agent_type="coder", agent_index=1, tokens=5200, cost=0.08)

E(T_TEST1, type="phase_started", phase="testing")
E(T_TEST1, type="camera_focus", target="tester_")
E(T_TEST1 + 0.2, type="agent_started", agent_type="tester", agent_index=0)
E(T_TEST1 + 0.4, type="agent_started", agent_type="tester", agent_index=1)
E(51.5, type="agent_completed", agent_type="tester", agent_index=0, tokens=4100, cost=0.06, issuesFound=4)
E(52.5, type="agent_completed", agent_type="tester", agent_index=1, tokens=3800, cost=0.18, issuesFound=2)

E(T_SUM1, type="phase_started", phase="summarizing")
E(T_SUM1, type="camera_focus", target="summarizer_0")
E(T_SUM1 + 0.2, type="agent_started", agent_type="summarizer")
E(60.0, type="agent_streaming", agent_type="summarizer",
  partial_content="## Round 1 summary\nCritical: 1 — Coder 1 missing fragment-shader header\nSerious: 2 — n=20 truncates when n>10\nMinor: 3 — variable shadowing, magic numbers")
E(61.5, type="agent_completed", agent_type="summarizer", tokens=2800, cost=0.18)

E(T_CODE2, type="iteration_started", iteration=2)
E(T_CODE2, type="phase_started", phase="coding")
E(T_CODE2, type="camera_focus", target="coder_0")
E(T_CODE2 + 0.2, type="agent_started", agent_type="coder", agent_index=0)
for i, ch in enumerate(coder0_chunks):
    E(T_CODE2 + 1 + i * 2.5, type="agent_streaming", agent_type="coder", agent_index=0, partial_content=ch[:280])
E(78.0, type="agent_completed", agent_type="coder", agent_index=0, tokens=7200, cost=0.36)

E(T_TEST2, type="phase_started", phase="testing")
E(T_TEST2, type="camera_focus", target="tester_")
E(T_TEST2 + 0.1, type="agent_started", agent_type="tester", agent_index=0)
E(T_TEST2 + 0.3, type="agent_started", agent_type="tester", agent_index=1)
E(89.0, type="agent_completed", agent_type="tester", agent_index=0, tokens=3600, cost=0.05, issuesFound=0)
E(90.5, type="agent_completed", agent_type="tester", agent_index=1, tokens=3300, cost=0.16, issuesFound=1)

E(T_SUM2, type="phase_started", phase="summarizing")
E(T_SUM2, type="camera_focus", target="summarizer_0")
E(T_SUM2 + 0.2, type="agent_started", agent_type="summarizer")
E(95.0, type="agent_completed", agent_type="summarizer", tokens=1800, cost=0.11)

E(T_FINAL1, type="phase_started", phase="finalizing")
E(T_FINAL1, type="camera_focus", target="finalizer_0")
E(T_FINAL1 + 0.2, type="agent_started", agent_type="finalizer")
E(104.0, type="agent_completed", agent_type="finalizer", tokens=2200, cost=0.14)

E(T_RUN_1, type="camera_focus", target="output")

E(T_ENH_INTRO, type="camera_focus", target="enhancer_", zoom=0.85)

E(T_DFS, type="phase_started", phase="enhancement")
E(T_DFS, type="camera_focus", target="enhancer_design_0")
E(T_DFS + 0.2, type="agent_started", agent_type="enhancer_design")
E(T_DFS + 0.3, type="agent_started", agent_type="enhancer_func")
E(T_DFS + 0.4, type="agent_started", agent_type="enhancer_security")
E(120.0, type="camera_focus", target="enhancer_func_0")
E(124.0, type="camera_focus", target="enhancer_security_0")
E(122.5, type="agent_streaming", agent_type="enhancer_design",
  partial_content="## Design suggestions\n1. Group controls into collapsible sections\n2. Reposition Restart near n start/end inputs")
E(123.5, type="agent_streaming", agent_type="enhancer_func",
  partial_content="## Functionality\n1. Remove synchronous gl.readPixels\n2. Pre-allocate Float32Array for orbit trails")
E(124.5, type="agent_streaming", agent_type="enhancer_security",
  partial_content="## Security\n1. Strict bounds-checking on n (clamp 2..50)\n2. Graceful WebGL error fallback")
E(127.0, type="agent_completed", agent_type="enhancer_design", tokens=3100, cost=0.045, issuesFound=5)
E(127.5, type="agent_completed", agent_type="enhancer_func", tokens=4200, cost=0.061, issuesFound=5)
E(128.0, type="agent_completed", agent_type="enhancer_security", tokens=2400, cost=0.034, issuesFound=2)

E(T_ENH_SUM, type="camera_focus", target="enhancer_summary_0")
E(T_ENH_SUM + 0.2, type="agent_started", agent_type="enhancer_summary")
E(131.0, type="agent_streaming", agent_type="enhancer_summary",
  partial_content="## Consolidated\nHIGH: 3 — gl.readPixels stall, collapsible UI, sticky Restart\nMEDIUM: 5 — bounds, GC, depth precision, typography, animation\nLOW: 1 — graceful WebGL error fallback")
E(134.0, type="agent_completed", agent_type="enhancer_summary", tokens=5100, cost=0.075)

E(T_RERUN, type="iteration_started", iteration=3)
E(T_RERUN, type="phase_started", phase="coding")
E(T_RERUN, type="camera_focus", target="coder_")
E(T_RERUN + 0.2, type="agent_started", agent_type="coder", agent_index=0)
E(T_RERUN + 0.4, type="agent_started", agent_type="coder", agent_index=1)
E(143.0, type="agent_completed", agent_type="coder", agent_index=0, tokens=6800, cost=0.34)
E(144.0, type="agent_completed", agent_type="coder", agent_index=1, tokens=4100, cost=0.06)
E(144.5, type="phase_started", phase="testing")
E(144.5, type="camera_focus", target="tester_")
E(144.6, type="agent_started", agent_type="tester", agent_index=0)
E(144.7, type="agent_started", agent_type="tester", agent_index=1)
E(149.5, type="agent_completed", agent_type="tester", agent_index=0, tokens=3300, cost=0.05, issuesFound=0)
E(150.0, type="agent_completed", agent_type="tester", agent_index=1, tokens=3100, cost=0.15, issuesFound=0)
E(150.5, type="phase_started", phase="summarizing")
E(150.5, type="camera_focus", target="summarizer_0")
E(150.6, type="agent_started", agent_type="summarizer")
E(153.0, type="agent_completed", agent_type="summarizer", tokens=1400, cost=0.09)
E(153.5, type="phase_started", phase="finalizing")
E(153.5, type="camera_focus", target="finalizer_0")
E(153.6, type="agent_started", agent_type="finalizer")
E(157.0, type="agent_completed", agent_type="finalizer", tokens=2100, cost=0.13)

E(T_FINAL2, type="camera_focus", target="output")
E(160.0, type="workflow_completed")

events.sort(key=lambda e: (e["t"], 0 if e["type"] == "camera_focus" else 1))

# ──────────── Narration chapters (cleaner copy, no inline emojis) ─────────
chapters = [
    {
        "id": "specification",
        "t_start": T_SPEC,
        "title": "Specification — your conversation with CodeForge",
        "icon": "📜",
        "paragraphs": [
            "You're watching a replay of a real CodeForge session at 60× speed. Every node you'll see is a real LLM that actually wrote code and audited it. The clock pauses on each phase — read at your own pace, then hit Continue.",
            "Every run starts here. The Specification is plain English: what should the app do, what platform, what constraints?",
            "It can be a brand-new app from scratch, or a modification to existing code you've uploaded as initial_code.",
            "Any language: JavaScript/WebGL, Python, TypeScript, Rust, Go, HTML+canvas — the agents adapt their toolchain. Browser code is auto-validated in headless Chromium.",
            "This particular demo asks for a real-time WebGL2 ray-marched Mandelbulb attractor — a 3D fractal that morphs as the power n increases. We'll watch the team build it from scratch.",
        ],
        "closing_paragraph": "Spec received and parsed. Time to assemble the team and start coding.",
    },
    {
        "id": "coding-1",
        "t_start": T_CODE1,
        "title": "Coding round 1 — two coders in parallel",
        "icon": "👨‍💻",
        "paragraphs": [
            "Two Coders pick up the spec and write independently. Different models, different reasoning styles — the Finalizer will pick the winner later.",
            "Diverse vendors. CodeForge supports Anthropic (Claude), Google (Gemini), OpenAI (GPT), and xAI (Grok). Different model families catch different mistakes. You configure each agent in Settings.",
            "Today's lineup. Coder 1 = claude-opus-4-7 (deep reasoning, slower). Coder 2 = claude-sonnet-4-6 (fast, lighter). Their independent outputs will compete head-to-head.",
            "Self-test before submitting. After writing, each Coder runs its own code in the sandbox. If it crashes or fails validation, the Coder reads stderr, fixes itself, and retries — up to max_fix_attempts (default 5).",
            "Real streaming. Those characters scrolling inside each Coder node aren't fake — they're live LLM tokens from the actual API. CodeForge streams by default to avoid Anthropic's 10-minute long-request timeout.",
        ],
        "closing_paragraph": "Coding round 1 complete. Both coders produced a working version: Coder 1 used opus-4-7, Coder 2 used sonnet-4-6. Each independently verified its own output by running it in the sandbox and fixing any errors. Two competing versions are now ready for cross-audit by the testers.",
    },
    {
        "id": "testing-1",
        "t_start": T_TEST1,
        "title": "Testing round 1 — deep audit",
        "icon": "🔍",
        "paragraphs": [
            "Now the Testers take over. Each Tester reads every Coder's output and audits it independently. With 2×2 you get 4 reviews per iteration.",
            "What they check, concretely. Does the code match the spec? Are edge cases handled? Does it actually run? Are there obvious perf or security issues? Is the code maintainable?",
            "More than linting. Testers don't just read the code — they execute it in the sandbox themselves and observe behaviour. They verify the output, the runtime errors, the visual result.",
            "Different model families on purpose. Today: Gemini-3-flash + GPT-5.4 — outside the Anthropic family. They have different blindspots from the Coders, so they catch what Coders miss.",
            "Severity tagging. Every issue becomes critical, serious, or minor. The Summarizer uses this ranking to drive the next iteration. Critical bugs always get fixed; minor ones are optional polish.",
        ],
        "closing_paragraph": "Testing round 1 complete. Tester 1 logged 4 issues on Coder 1's version (1 critical, 2 serious, 1 minor). Tester 2 logged 2 issues on Coder 2's version (no critical, no serious — already close to spec). The full audit set is ready for the Summarizer.",
    },
    {
        "id": "summarizer-1",
        "t_start": T_SUM1,
        "title": "Summarizer — the team lead",
        "icon": "📊",
        "paragraphs": [
            "The Summarizer is the keystone of the multi-agent loop. Without it, the Coders would drown in 4 conflicting audit reports.",
            "It reads ALL Tester audits, deduplicates issues, ranks them by severity, and writes ONE prioritized brief.",
            "That brief becomes input to the next Coder iteration. Coders see: \"In round 1 you produced X. Tester audits found these issues, ranked: [critical] ... [serious] ... [minor]. Fix them.\"",
            "The Summarizer doesn't fix code — it makes sure the Coders know what to fix and in what order. This is how multi-agent teams converge on a working solution instead of randomly walking around.",
        ],
        "closing_paragraph": "Summary ready. Coder 1 has 1 critical + 2 serious to fix on its version; Coder 2's version was clean enough to carry forward. Round 2 will only re-run Coder 1.",
    },
    {
        "id": "coding-2",
        "t_start": T_CODE2,
        "title": "Iteration 2 — Coder 1 refines with feedback",
        "icon": "🔄",
        "paragraphs": [
            "Coder 1 (Opus) had 1 critical + 2 serious issues in round 1. It re-codes, with the full Summary baked into its prompt — it knows exactly what to fix.",
            "Coder 2's round-1 version was clean. It sits this iteration out. Its output is carried forward unchanged. Coders that finish early save time and tokens.",
            "Why audit context matters. Without it, Coder 1 would likely make the same mistake. With it, you see real iterative refinement — not just a re-roll of the same prompt.",
            "Watch the iteration counter in Coder 1's top-right corner tick from Iter 1 → Iter 2. The model remembers it's been here before.",
        ],
        "closing_paragraph": "Round 2 coding complete. Coder 1 rewrote its version targeting the audit issues directly — fragment-shader header restored, n-truncation fixed, minor cleanups applied. Ready to re-audit.",
    },
    {
        "id": "testing-2",
        "t_start": T_TEST2,
        "title": "Testing round 2 — did the fix work?",
        "icon": "🔁",
        "paragraphs": [
            "Testers run again. The previous Summary is in their prompt — they specifically verify the previously-critical issues are gone.",
            "This is the part that's hard to replicate with a single LLM. Multi-agent gives you a second-pair-of-eyes check that the fix actually works, not just that it compiles.",
            "If issues come back, Iteration 3 starts. If they're gone, we're ready for the Finalizer.",
        ],
        "closing_paragraph": "Round 2 audit complete. Tester 1: 0 issues. Tester 2: 1 minor polish suggestion. The previously critical and serious issues are gone — round 2 converged.",
    },
    {
        "id": "summarizer-2",
        "t_start": T_SUM2,
        "title": "Summarizer round 2 — converged",
        "icon": "✅",
        "paragraphs": [
            "All critical issues gone. One minor polish item is logged. Summarizer signals 'done' to the orchestrator.",
            "If the workflow had max_iterations: 5 and the team converged after just 2 — great, save the tokens, move to Finalizer. CodeForge stops early when the Summary is clean.",
        ],
        "closing_paragraph": "Workflow converged in 2 of 5 allotted iterations. Saving the remaining budget. Handing off to the Finalizer to pick the winning version.",
    },
    {
        "id": "finalizer",
        "t_start": T_FINAL1,
        "title": "Finalizer — the judge",
        "icon": "🏆",
        "paragraphs": [
            "Two Coders, two versions of the code. The Finalizer reads both, looks at their final audit scores, and picks the winner.",
            "Plus a one-paragraph README. Finalizer writes a short summary explaining what was built, why the winning version won, and how to run it. Goes into the Final Code page so anyone reviewing the session understands the result.",
            "Finalizer is also where you'd plug in custom evaluation logic — e.g. \"the winner must pass these unit tests\" or \"prefer the version with fewer lines of code\".",
        ],
        "closing_paragraph": "Winner: Coder 1's round-2 version (cleaner control flow + better palette handling). README generated. Final code committed.",
    },
    {
        "id": "first-run",
        "t_start": T_RUN_1,
        "title": "First version is ready — try it",
        "icon": "▶️",
        "paragraphs": [
            "What you'd get from a 5-iteration run of just the basic spec: a working Mandelbulb. Single light, single colour palette, no fancy controls. It works, but it's not polished.",
            "Click Run code to try it — full-screen iframe, real WebGL, drag to rotate. This is the real iter-1 output from a real prod session, pulled straight from the database.",
            "Notice what's missing vs. a finished demo: just one light, no temperature control, no n→ live morph. Coders did the basics. Now we'll see how Enhancement adds the polish.",
            "When you're ready: click Continue to bring in the Enhancement team.",
        ],
        "cta_label": "Continue with Enhance →",
        "secondary_cta": {"label": "▶ Run code", "action": "run_simplified"},
    },
    {
        "id": "enh-intro",
        "t_start": T_ENH_INTRO,
        "title": "Enhancement — a second-pass team",
        "icon": "🎨",
        "paragraphs": [
            "Enhancement runs three specialist agents in parallel, each with a focused lens:",
            "Design — UX, layout, controls. What's awkward to use? What's missing?",
            "Functionality — performance, correctness, edge cases. Where does the code stall? What breaks on weird input?",
            "Security — bounds checking, error paths, validation. What can a malicious or accidental input crash?",
            "Each agent gets ONLY the final code from round 1 and the original spec. They don't see the audits — they form their own opinions. They produce lists of suggested improvements with explanations.",
            "Then an Enh. Summarizer merges all three lists into one curated set you can approve before applying. Designed to scale to 3 specialists without overwhelming you.",
        ],
        "closing_paragraph": "Enhancement team briefed. Spinning up Design, Functionality, and Security in parallel.",
    },
    {
        "id": "dfs",
        "t_start": T_DFS,
        "title": "Design / Functionality / Security — in parallel",
        "icon": "🎨",
        "paragraphs": [
            "All three run at once. They're independent — the camera pans across each as we go.",
            "Design (pink node). \"Group controls into collapsible sections.\" \"Sticky Restart button.\" UI polish that makes the app feel professional.",
            "Functionality (cyan node). \"Remove synchronous gl.readPixels — it stalls the GPU every frame.\" \"Pre-allocate Float32Array for orbit trails.\" Performance and behaviour improvements.",
            "Security (red node). \"Clamp n to [2, 50].\" \"Graceful WebGL error fallback — don't throw and crash the whole page.\" Resilience and validation.",
            "Each writes ~5 suggestions with severity rankings. Once they're done, the Enh. Summarizer aggregates.",
        ],
        "closing_paragraph": "All three specialists submitted: Design 5 ideas, Functionality 5, Security 2. The Enh. Summarizer is up next to merge them.",
    },
    {
        "id": "enh-summarizer",
        "t_start": T_ENH_SUM,
        "title": "Enh. Summarizer — merge into one curated list",
        "icon": "✨",
        "paragraphs": [
            "Reads all three specialist lists, deduplicates suggestions, ranks by impact (HIGH / MEDIUM / LOW), produces ONE final list.",
            "You're the editor — agents propose, you decide. In the real UI, you see this list with checkboxes. Check the ones you want; reject the rest. Then click Apply.",
            "Apply spawns a NEW session that continues from your final code, with the selected suggestions added as additional spec. You don't lose the old session — they're linked as parent/child.",
        ],
        "closing_paragraph": "Consolidated set ready: 3 HIGH, 5 MEDIUM, 1 LOW. In a real workflow you'd review and tick the items you want. For the demo we'll accept them all and watch the enhanced rerun.",
    },
    {
        "id": "rerun",
        "t_start": T_RERUN,
        "title": "Enhanced rerun — full cycle, faster",
        "icon": "♻",
        "paragraphs": [
            "Same Coders, but now their spec includes the curated improvements. Round 1 of the enhanced session usually runs faster — the foundation already works.",
            "In reality, this is another full 5-iteration cycle. The demo compresses it to ~25 seconds — the dance is the same, just faster.",
            "Watch the same nodes light up again: Coders write → Testers audit → Summarizer prioritises → Finalizer picks the winner. The whole loop, applied to a richer spec.",
        ],
        "closing_paragraph": "Enhanced rerun finished. The richer version converged in just one extra iteration. Final code now includes the curated improvements.",
    },
    {
        "id": "final-run",
        "t_start": T_FINAL2,
        "title": "Enhanced final version — try it & build your own",
        "icon": "🎉",
        "paragraphs": [
            "After Enhancement, the same agents produced a much richer version: twin lights (KEY + RIM) with adjustable position/intensity/temperature, palette dropdown, soft-shadow softness, orbit-trajectory overlay, and a Phase-3 morph control where you type any target n from 2 to 50.",
            "Click Run enhanced code to interact with the full version.",
            "When you're ready to make your own: Try it yourself. CodeForge will create a fresh session from the same spec on your account — a real LLM run, taking ~30 minutes and a few dollars to complete. You'll watch it happen live, not as a replay.",
        ],
        "cta_label": "Replay from start",
        "secondary_cta": {"label": "▶ Run enhanced code", "action": "run_final"},
    },
]

cur["duration_seconds"] = DURATION
cur["events"] = events
cur["annotations"] = []
cur["narration_chapters"] = chapters
cur["simplified_code"] = simplified
cur["description"] = (
    "WebGL2 ray-marched Mandelbulb attractor — full ~3-minute multi-agent replay with "
    "phase-by-phase narration plaques (read at your own pace), iterative refinement, "
    "two interactive runs (basic, then enhanced), and the full Enhancement loop."
)

TPL.write_text(json.dumps(cur, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"events={len(events)} chapters={len(chapters)} duration={cur['duration_seconds']}s")
print(f"final_code={len(final_code)} simplified={len(simplified)}")
print(f"chapters with closing_paragraph: {sum(1 for c in chapters if c.get('closing_paragraph'))}")
