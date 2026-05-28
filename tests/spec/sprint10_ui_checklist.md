# Sprint-10 Frontend UI Test Checklist

Manual test checklist covering sprint-10 frontend touchpoints: AgentNode streaming, SpecHelperPanel, streaming settings toggle, ResultActionsExtras, SharedSessionPage, REPLPreview, and EnhancerPanel preview/apply flow.

Severity legend: CRITICAL (blocks release), HIGH (broken core path), MEDIUM (degraded UX), LOW (cosmetic).
Verifiable: `runtime-only` requires a live browser session; `code-review` can be confirmed by reading source/snapshot.

---

## SP10-FE-01: SpecHelperPanel appears when spec exceeds 50 chars

**Page/Component:** SessionsPage / SpecHelperPanel (mounted under spec textarea)
**Steps to reproduce:**
1. Open the new-session flow and focus the spec textarea.
2. Type fewer than 50 characters; observe the panel area.
3. Continue typing past 50 characters.
**Expected:** Panel is hidden under the 50-char threshold and renders (score + cost) once length > 50.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-02: Spec analysis is debounced 500 ms

**Page/Component:** SpecHelperPanel
**Steps to reproduce:**
1. Open DevTools Network panel, filter on `/api/spec/analyze` (or equivalent helper endpoint).
2. Type rapidly into the spec textarea for 5 seconds straight.
3. Pause typing and observe network activity.
**Expected:** No request fires while keystrokes are <500 ms apart; exactly one request fires ~500 ms after last keystroke.
**Severity if fails:** MEDIUM
**Verifiable:** runtime-only

## SP10-FE-03: Score badge color thresholds

**Page/Component:** SpecHelperPanel score badge
**Steps to reproduce:**
1. Paste specs that yield scores in three buckets (>=80, 50-79, <50). Use canned fixtures from `tests/spec/fixtures/specs/`.
2. Inspect the badge color for each.
**Expected:** green for >=80, amber/yellow for 50-79, red for <50. Tailwind classes `bg-green-*`, `bg-amber-*`, `bg-red-*` (or equivalent).
**Severity if fails:** MEDIUM
**Verifiable:** runtime-only

## SP10-FE-04: Word count and complexity displayed

**Page/Component:** SpecHelperPanel
**Steps to reproduce:**
1. Type a spec with a known number of words.
2. Inspect the panel for "Words: N" and a complexity indicator (low/medium/high or numeric).
**Expected:** Word count matches and complexity label is rendered.
**Severity if fails:** LOW
**Verifiable:** runtime-only

## SP10-FE-05: Detected keywords rendered as chips

**Page/Component:** SpecHelperPanel keyword section
**Steps to reproduce:**
1. Enter spec containing recognizable keywords (e.g. "FastAPI", "Postgres", "WebSocket").
2. Wait for analysis result.
**Expected:** Each detected keyword appears as a discrete chip/pill (rounded background, small text), not a comma-separated string.
**Severity if fails:** LOW
**Verifiable:** runtime-only

## SP10-FE-06: Cost estimate displays both dollars and tokens

**Page/Component:** SpecHelperPanel cost section
**Steps to reproduce:**
1. Enter a non-trivial spec.
2. Inspect cost estimate region.
**Expected:** Both an estimated dollar value (e.g. `~$0.04`) and token count (e.g. `~3.2k tokens`) are visible. Values update as spec changes.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-07: Streaming toggle PATCHes session settings

**Page/Component:** Settings -> Workflow section -> "Enable streaming" checkbox
**Steps to reproduce:**
1. Open an existing session's settings panel.
2. Open DevTools Network panel.
3. Toggle "Enable streaming" on then off.
**Expected:** Each toggle issues `PATCH /api/sessions/:id` with body containing `{settings: {streaming: true|false}}`. UI state remains in sync after refresh.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-08: AgentNode shows live streaming text

**Page/Component:** Graph -> AgentNode
**Steps to reproduce:**
1. Enable streaming in session settings.
2. Run the session and watch the active agent node.
**Expected:** `streamingContent` text accumulates token-by-token inside the node body while `isStreaming` is true.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-09: Animated cursor visible while streaming

**Page/Component:** AgentNode streaming text
**Steps to reproduce:**
1. With streaming on, observe the trailing character of the streaming text.
**Expected:** A blinking caret/cursor (CSS animation) appears at the end of the streaming text and only while `isStreaming === true`.
**Severity if fails:** LOW
**Verifiable:** runtime-only

## SP10-FE-10: Streaming text panel disappears on agent_completed

**Page/Component:** AgentNode
**Steps to reproduce:**
1. Run a streaming-enabled session to completion of one agent.
2. Watch the node when the `agent_completed` event arrives via WebSocket.
**Expected:** Streaming text region is hidden/replaced with the final summary; `isStreaming` flips to false; cursor disappears.
**Severity if fails:** MEDIUM
**Verifiable:** runtime-only

## SP10-FE-11: ResultActionsExtras renders 4 buttons

**Page/Component:** SessionDetailPage -> ResultActionsExtras
**Steps to reproduce:**
1. Open a completed session.
2. Locate the result actions row.
**Expected:** Exactly four buttons: Share, Generate Tests, Generate Docs, Deploy. All visible and labeled.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-12: Share button creates link with Copy and Revoke

**Page/Component:** ResultActionsExtras -> Share modal
**Steps to reproduce:**
1. Click Share.
2. Inspect modal contents and click Copy.
3. Confirm the URL is in the clipboard (paste into address bar).
**Expected:** Modal opens, displays a `/share/<token>` URL, Copy populates clipboard, Revoke button is present and enabled.
**Severity if fails:** CRITICAL
**Verifiable:** runtime-only

## SP10-FE-13: Revoke disables the share link

**Page/Component:** Share modal
**Steps to reproduce:**
1. Create a share link (SP10-FE-12).
2. Open the link in a private window and confirm it loads.
3. Return and click Revoke.
4. Reload the share URL.
**Expected:** After revoke, the public page returns 404 (or equivalent error state). Revoke confirms via toast/inline message.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-14: Generate Tests modal renders with stub banner

**Page/Component:** ResultActionsExtras -> Generate Tests modal
**Steps to reproduce:**
1. Click Generate Tests on a completed session.
**Expected:** Modal opens showing generated test code in a code block plus a clearly-marked "stub" / "preview" banner indicating the feature is not production-grade.
**Severity if fails:** MEDIUM
**Verifiable:** runtime-only

## SP10-FE-15: Generate Docs modal shows README + API sections

**Page/Component:** ResultActionsExtras -> Generate Docs modal
**Steps to reproduce:**
1. Click Generate Docs on a completed session.
**Expected:** Modal renders two distinct sections: a README section and an API docs section, each with markdown-rendered content.
**Severity if fails:** MEDIUM
**Verifiable:** runtime-only

## SP10-FE-16: Deploy disabled with tooltip for Python sessions

**Page/Component:** ResultActionsExtras -> Deploy button
**Steps to reproduce:**
1. Open a session whose primary language is Python.
2. Hover the Deploy button.
**Expected:** Button is disabled (grayed, `aria-disabled` or `disabled`); hover tooltip explains "Deploy currently supports JS/TS only" or similar.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-17: Deploy modal happy path

**Page/Component:** ResultActionsExtras -> Deploy modal
**Steps to reproduce:**
1. Open a JS/TS session, click Deploy.
2. Paste a valid Vercel/Netlify token in the token input.
3. Click the Deploy submit button.
**Expected:** Modal contains: token input (password type), Deploy button, status area. On success, the modal shows the deployed URL as a clickable link.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-18: Deploy with invalid token surfaces error

**Page/Component:** Deploy modal
**Steps to reproduce:**
1. Enter an obviously-invalid token (e.g. "garbage").
2. Submit.
**Expected:** Inline error message appears (e.g. "Authentication failed"), Deploy button re-enabled to allow retry, no URL shown.
**Severity if fails:** MEDIUM
**Verifiable:** runtime-only

## SP10-FE-19: Shared session page accessible without auth

**Page/Component:** SharedSessionPage at `/share/:token`
**Steps to reproduce:**
1. Generate a share link.
2. Open it in a fresh private/incognito window with no cookies.
**Expected:** Page loads and renders content without redirecting to login.
**Severity if fails:** CRITICAL
**Verifiable:** runtime-only

## SP10-FE-20: Shared page shows session name, status, spec, final code

**Page/Component:** SharedSessionPage
**Steps to reproduce:**
1. Open a valid share link.
**Expected:** Visible: session name, status badge, spec text, final code block. No edit controls or sensitive settings exposed.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-21: Invalid share token shows error state

**Page/Component:** SharedSessionPage
**Steps to reproduce:**
1. Navigate to `/share/not-a-real-token`.
**Expected:** Friendly "Link not found or revoked" page (not a stack trace, not a blank page). HTTP 404 in network tab.
**Severity if fails:** MEDIUM
**Verifiable:** runtime-only

## SP10-FE-22: Copy buttons on spec and code blocks

**Page/Component:** SharedSessionPage
**Steps to reproduce:**
1. Open a valid share link.
2. Click Copy on the spec block, then on the code block.
3. Paste both into a text editor.
**Expected:** Each Copy populates clipboard with the corresponding content; visual feedback (e.g. "Copied!") flashes briefly.
**Severity if fails:** LOW
**Verifiable:** runtime-only

## SP10-FE-23: REPLPreview Run Code calls execution endpoint

**Page/Component:** OutputPanel -> REPLPreview
**Steps to reproduce:**
1. Open a completed session with executable code.
2. Open Network panel.
3. Click Run Code.
**Expected:** A `POST /api/execution/:session_id/run` (or matching path) request fires; response populates the console area below.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-24: stdout vs stderr coloring

**Page/Component:** REPLPreview console output
**Steps to reproduce:**
1. Run code that prints to both stdout and stderr (e.g. `print(...)` and `sys.stderr.write(...)`).
**Expected:** stdout lines render in green (or theme equivalent), stderr lines render in red. Distinct CSS classes applied.
**Severity if fails:** MEDIUM
**Verifiable:** runtime-only

## SP10-FE-25: Exit code and execution time displayed

**Page/Component:** REPLPreview footer
**Steps to reproduce:**
1. Run code via Run Code.
2. Inspect footer/status row of the console panel.
**Expected:** Both `exit_code` (e.g. "exit 0") and `execution_time_ms` (e.g. "142 ms") are shown after run completes.
**Severity if fails:** LOW
**Verifiable:** runtime-only

## SP10-FE-26: Preview Enhancements shows dry-run summary

**Page/Component:** EnhancerPanel
**Steps to reproduce:**
1. Open a session and the Enhancer panel.
2. Select one or more enhancements.
3. Click Preview Enhancements.
**Expected:** A dry-run summary renders (diff/preview content) without mutating the session. Network shows a dry-run request (e.g. `?dry_run=true`).
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-27: Preview button morphs to Apply on second click

**Page/Component:** EnhancerPanel button
**Steps to reproduce:**
1. After SP10-FE-26 preview renders, observe the action button label.
2. Click it.
**Expected:** Button label changes from "Preview Enhancements" to "Apply" (or "Apply Enhancements") after preview. Clicking Apply executes the real enhancement run.
**Severity if fails:** HIGH
**Verifiable:** runtime-only

## SP10-FE-28: Preview does not create a new session or run

**Page/Component:** EnhancerPanel
**Steps to reproduce:**
1. Note the session list / orchestrator state before clicking Preview.
2. Click Preview Enhancements.
3. Re-check session list, agent timeline, and backend logs.
**Expected:** No new session row appears; no agent invocations are billed; no orchestrator run started. Only the dry-run request is observed.
**Severity if fails:** CRITICAL
**Verifiable:** runtime-only

---

## Notes on verifiability

All 28 tests are marked `runtime-only` because they exercise live UI behavior (animations, debounce timing, network requests, modals, public pages). None can be fully confirmed by static code review alone, though the following pairs benefit from a code-review companion check before runtime testing:

- SP10-FE-02 (debounce constant should be `500` in `SpecHelperPanel.tsx`)
- SP10-FE-03 (color thresholds should be hard-coded `>=80` / `>=50` in the badge component)
- SP10-FE-13 / SP10-FE-19 / SP10-FE-21 (route + auth handling in `SharedSessionPage` route definition and backend)
- SP10-FE-16 (language gating logic on Deploy button)
- SP10-FE-26 / SP10-FE-28 (dry-run flag plumbed end-to-end; no orchestrator side-effects on preview)

When Playwright e2e coverage is added, SP10-FE-01, -02, -03, -07, -11, -23, -24, -27 are the highest-leverage candidates to automate first.
