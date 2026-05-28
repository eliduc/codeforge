# Wave 4 — LiveSession Tester report

**Suite:** `e2e/tests/wave4-live.spec.ts`
**Target:** `https://stage.gotcode.ai/sessions/8af46f53-00e8-4dad-9a82-817de2e3bbae`
**Session status at test time:** `created` (read-only — no Start/Run/Pause/Cancel/Reset issued)
**Run command:**
```
cd e2e && E2E_BASE_URL=https://stage.gotcode.ai \
  E2E_AUTH_TOKEN=… E2E_TEST_SESSION_ID=8af46f53-00e8-4dad-9a82-817de2e3bbae \
  npx playwright test tests/wave4-live.spec.ts --reporter=list --workers=1
```

## Summary

| Result | Count |
|--------|-------|
| Passed | 10 |
| Skipped (state-gated) | 8 |
| Failed | 0 |
| Total | 18 |

All non-gated assertions pass on a `created` session. The 8 skipped tests
are gated on session state (running / has-final-code / has-disabled-enhancer /
has-error-agent / has-active-agent / has-mini-map / has-artifact-edge / has-
code-version). Each skip path documents its rationale (see per-case rows below).

## Cases

### 1. Page renders graph + MetricsPanel without error
**Status:** PASS
- React Flow root (`.react-flow`) renders
- `.react-flow__viewport` is visible
- MetricsPanel (`[data-tour="metrics-panel"]`) shows the header "Session Metrics"

### 2. WS status pill — connecting → connected → hides within ~2s (Wave 1 P0·M)
**Status:** PASS
- After `connected`, the pill text (`Connecting…` / `Reconnecting…` / `Live feed disconnected` / `Connected`) is no longer present within ~5s (success-flash window allows for 1.5s `Connected` flash before hide).
- We assert with `expect.poll` so the brief flash is allowed to surface.

### 3. Lock viewport toggle exists + persists to localStorage (Wave 2 P1·M)
**Status:** PASS
- Header button with `title=/Lock viewport|Viewport locked/` is rendered.
- Click flips `aria-pressed: false → true`, title becomes `"Viewport locked …"`, and `localStorage["codeforge.session.lockViewport"] === "1"`.
- After `page.reload()` the toggle remains pressed (state persisted on mount via `useState(() => localStorage.getItem(...) === '1')`).
- Cleanup: toggles back OFF so other tests start with a known state.

**Note:** earlier flake reproduced when `context.addInitScript(removeItem)` ran on every navigation including reload, defeating the persistence check. Resolved by clearing the key once, then reloading once before the active assertions.

### 4. "?" opens the keyboard help modal listing shortcuts (Wave 2 P1·S)
**Status:** PASS
- `Shift+/` opens a modal titled "Keyboard shortcuts".
- All six labelled rows render: `Show / hide this help`, `Close the open panel or modal`, `Toggle browser preview`, `Pause when running, resume when paused`, `Focus the most-recent code viewer`, `Open the intervention panel`.
- Each documented key (`?`, `Esc`, `p`, `Space`, `c`, `i`) renders inside a `<kbd>` element.

### 5. Esc closes the keyboard help modal
**Status:** PASS
- Pressing `Escape` after opening the modal hides the title within 5s.

### 6. MetricsPanel humanized status badge (Wave 2 P1·S)
**Status:** PASS
- Badge text is `"Created"` (humanized) — never the raw `created` / `awaiting_enhancement_review` enum value.
- Asserted match against `/^(Created|Running|Paused|Completed|Failed|Cancelled|Enhancing…|Awaiting Enhancement|Enhancement Review)$/`.

### 7. Phase indicator humanized (Wave 2 P1·S)
**Status:** SKIP
- Rationale: the phase chip only renders while `session.status === 'running'` (with a `phase`) or `session.status === 'enhancing'`. Our fixture session is `created`, so the chip is intentionally absent — no element to assert against. The test would assert humanization (`Coding (iteration N)` / `Summarizing audits` / etc.) if/when the session were live.

### 8. Spec node click affordance — cursor-help, Info icon, opens dialog (Wave 3 P2·S)
**Status:** PASS
- Outer container has Tailwind `cursor-help`.
- Inner Info indicator (`<div ... aria-hidden="true">` with `title="Click to view full specification"`) renders the Lucide `<svg>`.
- Clicking the React-Flow node element (`.react-flow__node[data-id="input"]`) opens the SpecificationsDialog (headlessui-rendered `[role="dialog"][data-headlessui-state="open"]` with title `"Session Specifications"`).

**UX note (not a test failure but a real friction point):** The Specification node sits at the canvas origin (top-left) on the default React-Flow viewport, directly behind the MetricsPanel (`react-flow__panel top left`). Playwright's actionability check legitimately reports the click as intercepted by the panel — meaning a real user clicking the spec node where it's covered does NOT trigger the dialog either. The test mitigates by panning the canvas before clicking, plus a `{force: true}` fallback. Worth flagging for Team 3 to address (e.g. raise the spec node's z-index above panels, or auto-pan to fit the spec node on first mount, or render the panels with a `pointer-events: none` outer wrapper).

### 9. Spec node tooltip
**Status:** PASS
- The node container carries `title="Click to view full specification"` verbatim.

### 10. Edge artifact tooltips (Wave 3 P2·S)
**Status:** SKIP
- Rationale: `created`-state sessions have no artifact-bearing edges (`hasArtifact` only becomes true once a coder/tester emits output). Without an artifact badge anywhere in the DOM (no `div[title*="→"]`), the assertion `title contains "Code (iter N) from X → Y"` has nothing to bind to.

### 11. Countdown chips T/R/S/A on agent nodes (Wave 3 P2·S)
**Status:** SKIP
- Rationale: countdown chips render inside the `isActive` branch of `AgentNode` (status ∈ {`working`, `executing`, `fixing`}). No agent is active on a `created` session, so no `span[title^="T = "...]` exists.

### 12. Disabled enhancer node a11y (Wave 3 P2·S)
**Status:** SKIP
- Rationale: this session has no disabled enhancers (no `Disabled` badge in the DOM). When present, the assertion checks: opacity-60 on the ancestor node, an explicit `Disabled` badge, and an Enable button (`button[aria-label="Enable agent"]`).

### 13. Side-panel breadcrumb (Wave 3 P2·M)
**Status:** PASS
- Open DetailPanel by clicking a coder node (`.react-flow__node[data-id^="coder-"]`).
- Click the header `Intervene` button — this is the path that calls `pushPanel('intervention')`. The breadcrumb chip-row appears with chips titled `"Currently viewing …"` and `"Switch back to …"`.
- Clicking a `"Switch back to …"` chip restores the prior panel.

**Inconsistency flagged (real bug, not a test failure):** the `i` keyboard shortcut also opens the intervention panel but **does NOT** call `pushPanel('intervention')` (see `SessionDetailPage.tsx:2230-2234` vs `:4512-4518`). Result: the breadcrumb only tracks history when the user opens panels via header buttons, not via shortcuts. Documented for Team 3 — add the missing `pushPanel('intervention')` to the `case 'i':` branch (and any other shortcut that opens a panel).

### 14. Final Result code-view fullscreen modal (Wave 3 P2·S)
**Status:** SKIP
- Rationale: this session has never run, so `finalResult.final_code` is null and the "Fullscreen" button does not render. When present, the test asserts that clicking it opens a Modal with `[class*="max-h-[75vh]"]` and that `Escape` closes it.

### 15. Header overflow ⋯ menu on narrow viewport (Wave 3 P3·S)
**Status:** PASS
- At 600x800: `button[title="More actions"]` is visible, `button[data-tour="settings-btn"]` is hidden, the standalone `Save as Template` button is hidden.
- Opening the menu reveals `role="menu"` with items `Session Settings` and `Save as Template`.

### 16. Mini-map status palette (Wave 3 P3·S)
**Status:** SKIP
- Rationale: on the default layout the React-Flow mini-map is not visible (no `<MiniMap />` rendered, or collapsed). When visible the test asserts at least one `<rect>` has a fill matching the documented palette (`#3B82F6`, `#F59E0B`, `#10B981`, `#EF4444`, `#DC2626`, `#FB923C`, `#F87171`) — proof the palette wired up. Idle-only states all rendering grey would also skip (no meaningful signal).

### 17. Retry-agent button on error/timeout agent (Wave 2 P1·M)
**Status:** SKIP
- Rationale: no agent is in `error` or `timeout` state on this `created` session (no node renders the `"Error"` or `"Timed Out"` label). The Retry affordance in `DetailPanel` is gated on `nodeStatus === 'error' || 'timeout'` AND `onRetryAgent` is wired — nothing to bind the test to.

### 18. CodeBlock syntax highlight (Wave 2 P1·S)
**Status:** SKIP
- Rationale: no code-version exists for any coder on a `created` session, so the CoderPanel does not mount a `CodeBlock` and the `.hljs` selector matches nothing. When code is present the test asserts at least one `.hljs span` token is rendered (i.e. real highlight, not a bare `<pre>`).

## Real findings (not test failures, but worth Team 3's attention)

1. **Spec-node click is covered by MetricsPanel on default viewport.** The
   Specification node lives at the canvas top-left, where `react-flow__panel
   top left` (MetricsPanel) overlays it. A real user click on the visible
   portion of the spec node is intercepted by the panel and does NOT open
   `SpecificationsDialog`. Repro: open any new session, do not pan, click the
   visible top of the Specification node — nothing happens. Suggested fixes:
   - raise spec node's z-index above panels, OR
   - on first mount, auto-pan so the Specification node sits clear of the
     top-left panel, OR
   - wrap MetricsPanel in a `pointer-events-none` container with
     `pointer-events-auto` on its inner card so clicks on empty rim pass
     through to the canvas underneath.

2. **`i` shortcut opens intervention panel without recording breadcrumb.**
   `SessionDetailPage.tsx` line 2230 (`case 'i':`) calls
   `setShowIntervention(true)` but skips `pushPanel('intervention')`. The
   header Intervene **button** at line 4512 calls both. Result: the side-
   panel history breadcrumb (Wave 3 P2·M feature) silently misses any panel
   opened via keyboard. The fix is a one-liner — add the matching
   `pushPanel('intervention')` to the keyboard branch (and audit the other
   `'c'` branch which has similar shortcut-opens-panel behaviour).

## Test execution

Final pass: **10 passed, 8 skipped, 0 failed** (≈1m48s).

The test file lives at `e2e/tests/wave4-live.spec.ts` and uses the shared
`authedTest` fixture from `e2e/tests/_fixtures/auth.ts` (injects JWT into
`localStorage[codeforge_token]` via `context.addInitScript`).
