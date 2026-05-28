"""Regression test for КАО#VR-24 — Coder prompt must include the visual
first-impression rule for browser-renderable languages.

Background: in session f49ce972 the third Coder produced a Game-of-Life
implementation gated behind a "Play" button. The screenshot capturer takes
all 5 stills at fixed offsets with no user interaction, so all 5 frames
were of the splash menu — the candidate was effectively un-scoreable in
the Visual Review panel.

The fix has two layers:
  - Sandbox-side (browser_screenshot.js): auto-click best-matching start
    button, fall back to Space key. Best-effort.
  - Coder-side (this file): the prompt must instruct the agent to render
    something demo-worthy in the first ~500ms WITHOUT requiring a click.

Without the second layer, agents that produce well-designed sandbox-style
tools still degrade visual review even when their code is the best of the
batch. This test pins the prompt language so a future template edit can't
silently drop it.
"""
from __future__ import annotations

from pathlib import Path

from app.agents.coder import DEFAULT_CODER_PROMPT


# ---------------------------------------------------------------------------
# Side-A — sandbox auto-click logic (browser_screenshot.js)
# ---------------------------------------------------------------------------


def test_browser_screenshot_has_auto_start_logic() -> None:
    """sandbox/browser_screenshot.js must contain the auto-click logic and
    invoke it before the screenshot loop. We check the source text directly
    because the script runs in a separate container — wiring a JS unit test
    here would be heavyweight for a one-shot regression."""
    # The script lives outside the backend package root. Resolve via project
    # layout: backend/tests/ → ../../sandbox/browser_screenshot.js
    repo_root = Path(__file__).resolve().parents[2]
    js_path = repo_root / "sandbox" / "browser_screenshot.js"
    if not js_path.exists():
        # In some test environments the sandbox sources aren't checked out
        # alongside backend (e.g. minimal container test). Skip rather than
        # fail loudly — the prompt-side checks still run.
        #
        # КАО Round 2 (S4): pass an explicit `reason=` so pytest -v surfaces
        # *why* the test was skipped instead of just the path. Runtime
        # coverage of this same invariant lives in
        # sandbox/test_browser_screenshot.js (node test suite).
        import pytest
        pytest.skip(
            reason=(
                f"Sandbox JS file not available in backend container "
                f"(expected at {js_path}); runtime coverage is in "
                f"sandbox/test_browser_screenshot.js"
            )
        )
    js = js_path.read_text(encoding="utf-8")
    assert "tryAutoStart" in js, (
        "browser_screenshot.js is missing tryAutoStart() — auto-click logic "
        "for Coders that gate the demo behind a Play button. See КАО#VR-24."
    )
    # The function MUST actually be called before the screenshot loop. If
    # someone leaves the function defined but doesn't wire it in, the bug
    # silently returns. We don't enforce exact placement — just presence of
    # the call somewhere after page.setContent and somewhere before t0.
    call_pos = js.find("await tryAutoStart(")
    set_content_pos = js.find("page.setContent")
    t0_pos = js.find("const t0 ")
    assert call_pos > 0, "tryAutoStart() defined but never called"
    assert set_content_pos > 0, "setContent call missing — script is degenerate"
    assert t0_pos > 0, "screenshot-loop t0 anchor missing"
    assert set_content_pos < call_pos < t0_pos, (
        "tryAutoStart() must be called AFTER setContent() and BEFORE the "
        "screenshot loop anchor t0. See КАО#VR-24."
    )


def test_coder_prompt_carries_visual_first_impression_rule() -> None:
    """The browser-language section MUST mention the visual first-impression
    rule by some recognisable name. Test on text, not exact wording — we
    want to allow phrasing edits without breaking the test, but we want to
    catch outright removal."""
    prompt = DEFAULT_CODER_PROMPT
    # Section anchor so we know we're checking the right block.
    assert "Browser Environment" in prompt, (
        "Browser environment section disappeared from coder prompt. "
        "The first-impression rule lives inside it."
    )
    # Hard-required phrases. If you rephrase, update this test too.
    required_keywords = [
        "first-impression",       # name of the rule
        "0.5s",                   # references the screenshot schedule
        "screenshot",             # explicit framing of WHY it matters
        "without",                # ... user input / human click
        "auto-start",             # the suggested fix
    ]
    missing = [kw for kw in required_keywords if kw.lower() not in prompt.lower()]
    assert not missing, (
        f"Coder prompt is missing first-impression keywords: {missing}. "
        "The full rule is in app/agents/coder.py; see КАО#VR-24."
    )


def test_coder_prompt_warns_against_play_gate_pattern() -> None:
    """We specifically call out the 'choose a pattern then press Play' anti-
    pattern because that's what tripped up Coder 3 in session f49ce972. If
    the prompt drops that example, agents lose the explicit warning."""
    prompt = DEFAULT_CODER_PROMPT
    assert "press play" in prompt.lower() or "press start" in prompt.lower(), (
        "Coder prompt should explicitly warn against gating visual on a "
        "'Press Play' / 'Press Start' flow — see КАО#VR-24."
    )


def test_visual_first_impression_only_for_browser_languages() -> None:
    """The rule is jinja-gated to browser languages — it shouldn't appear
    in the Python/Go/Rust prompt rendering. We can't render the template
    here without bringing the full jinja stack, so we instead assert that
    the rule lives inside the browser-language jinja block by checking the
    raw template structure."""
    prompt = DEFAULT_CODER_PROMPT
    # Find the browser jinja-if open and its matching endif.
    browser_open = prompt.find("{% if language in ['javascript_browser', 'typescript_browser', 'html'] %}")
    assert browser_open >= 0, "browser-language jinja block not found in prompt"
    # First endif after the open.
    browser_close = prompt.find("{% endif %}", browser_open)
    assert browser_close >= 0
    browser_block = prompt[browser_open:browser_close]
    assert "first-impression" in browser_block.lower(), (
        "First-impression rule should be INSIDE the browser-language jinja "
        "block — it's irrelevant for Python/Go/Rust. See КАО#VR-24."
    )
