# CodeForge — Frontend UI/UX Manual Test Checklist

Severity legend: **CRITICAL** = users can't use the app · **HIGH** = annoying core flow · **MEDIUM** = polish · **LOW** = cosmetic.
Default prerequisite: app served at `http://localhost:5173` (or configured host); backend reachable. Logged-out unless noted.

---

## 1. Authentication (LoginPage)

| ID | Description | Severity | Prereq |
|---|---|---|---|
| FE-LOGIN-001 | Load `/login`. Email field has autofocus; cursor blinks inside input. | LOW | logged out |
| FE-LOGIN-002 | "Send Code" button is disabled when email is empty/whitespace; enabling occurs after first non-space char. | HIGH | logged out |
| FE-LOGIN-003 | Submit invalid email (no `@`). Browser native validation blocks submit (input is `type="email"` + `required`). | MEDIUM | logged out |
| FE-LOGIN-004 | Submit valid whitelisted email → spinner replaces "Send Code" label, then transitions to OTP step with success message. | CRITICAL | whitelisted email |
| FE-LOGIN-005 | OTP step shows 6 separate input boxes; first box auto-focused after ~100ms. | HIGH | sent OTP |
| FE-LOGIN-006 | Type a digit → focus auto-advances to next box. Non-digit characters are rejected (filtered by `/^\d*$/`). | HIGH | OTP step |
| FE-LOGIN-007 | Backspace on empty box → focus moves to previous box. | MEDIUM | OTP step |
| FE-LOGIN-008 | Paste a 6-digit code into any box → all boxes fill and auto-submit fires after ~200ms. | HIGH | OTP step |
| FE-LOGIN-009 | Paste mixed `"abc123def456"` → only `"123456"` extracted, distributed left-to-right. | MEDIUM | OTP step |
| FE-LOGIN-010 | Paste 4-digit prefix → first 4 boxes filled, focus lands on box 5, no auto-submit. | MEDIUM | OTP step |
| FE-LOGIN-011 | "Verify" button disabled until all 6 boxes filled. | MEDIUM | OTP step |
| FE-LOGIN-012 | Submit wrong code → red error shows under boxes (`role="alert"`); all boxes clear; focus returns to first. | HIGH | OTP step |
| FE-LOGIN-013 | Submit expired code (>10 min old) → backend message surfaces verbatim. | HIGH | wait 10+ min |
| FE-LOGIN-014 | Trigger rate limit (>5 verify attempts/min) → 429 message displayed; UI not stuck. | HIGH | spam wrong codes |
| FE-LOGIN-015 | Click "Resend Code" → loading state, message updates, code boxes clear, focus to first box. | HIGH | OTP step |
| FE-LOGIN-016 | Submit non-whitelisted email → screen flips to `not_allowed` step with shield icon and email shown. | CRITICAL | unknown email |
| FE-LOGIN-017 | On `not_allowed`, click "Request access from administrator" → button replaced by green "Request sent". Email arrives at admin. | HIGH | not_allowed step |
| FE-LOGIN-018 | "Back" button on OTP and not_allowed steps returns to email step; previous error/message cleared. | MEDIUM | OTP/not_allowed |
| FE-LOGIN-019 | 500 from backend → error text appears in red `role="alert"` region; not stuck on spinner. | HIGH | backend down |
| FE-LOGIN-020 | Screen reader: `aria-live="polite"` region announces step transitions and errors. | MEDIUM | NVDA/VoiceOver |
| FE-LOGIN-021 | Already-authenticated user visiting `/login` → instant redirect to `/sessions` (or `from` state). | HIGH | logged in, then `/login` |
| FE-LOGIN-022 | Successful verify → redirect to original target page (deep-link preserved via `location.state.from`). | HIGH | hit protected URL |
| FE-LOGIN-023 | Loader spinner is visible during in-flight requests; inputs disabled. | MEDIUM | slow network |
| FE-LOGIN-024 | Tab order: Email → Send Code; on OTP: Box1 … Box6 → Verify → Resend → Back. | MEDIUM | keyboard only |
| FE-LOGIN-025 | Logo gradient + "CodeForge" / "Multi-Agent Code Generation" tagline render at top. | LOW | — |

## 2. Sessions list (SessionsPage)

| ID | Description | Severity | Prereq |
|---|---|---|---|
| FE-SESS-001 | First load shows skeleton/spinner, then list of sessions sorted newest-first. | HIGH | logged in |
| FE-SESS-002 | Pagination: scroll/click "Load more" appends next 50 sessions; count badge updates. | HIGH | >50 sessions |
| FE-SESS-003 | Search box filters by name (case-insensitive substring); typing debounces or filters live. | HIGH | several sessions |
| FE-SESS-004 | Status filter pills: clicking `running` shows only running sessions; `all` resets. | HIGH | mixed statuses |
| FE-SESS-005 | Filter combination (search + status) yields intersection. | MEDIUM | mixed sessions |
| FE-SESS-006 | Empty filter result → "no sessions found" empty state visible. | MEDIUM | impossible filter |
| FE-SESS-007 | Click a row → navigates to `/sessions/:id`. | CRITICAL | ≥1 session |
| FE-SESS-008 | Hover row → left accent border + subtle background change appears. | LOW | — |
| FE-SESS-009 | Long session name (200+ chars) truncates with ellipsis; no horizontal overflow. | MEDIUM | rename to long |
| FE-SESS-010 | Status badges colored correctly: failed = loud red, idle/created = muted gray, running = blue with pulse. | LOW | mixed statuses |
| FE-SESS-011 | Selection mode toggle reveals checkboxes and bulk action bar. | HIGH | logged in |
| FE-SESS-012 | "Select all" checks every visible row; clicking again clears. | MEDIUM | selection mode |
| FE-SESS-013 | Bulk delete: confirm dialog lists count; progress indicator while deleting; toast "N deleted". | HIGH | ≥2 selected |
| FE-SESS-014 | Cancel on bulk delete confirm → no rows deleted. | HIGH | confirm dialog |
| FE-SESS-015 | Single-row trash icon → ConfirmDialog showing session name. Confirm deletes, toast appears. | HIGH | ≥1 session |
| FE-SESS-016 | Copy session: creates duplicate with same agents/spec; user lands on/sees new row. | MEDIUM | ≥1 completed session |
| FE-SESS-017 | Copy structure (no spec): new session has agents but blank spec. | MEDIUM | ≥1 session |
| FE-SESS-018 | Export selected sessions → JSON file downloads with all session data. | MEDIUM | selection mode |
| FE-SESS-019 | Import JSON: file picker → check dialog shows summary of new/duplicate; confirm imports. | MEDIUM | exported file |
| FE-SESS-020 | Import malformed JSON → error toast, no partial state. | HIGH | bad file |
| FE-SESS-021 | Templates panel toggle expands list; loading spinner while fetching. | MEDIUM | logged in |
| FE-SESS-022 | "Use template" opens dialog requiring new name + spec; both required else error toast. | HIGH | ≥1 template |
| FE-SESS-023 | Apply template → navigates to new session detail. | HIGH | template + valid input |
| FE-SESS-024 | Delete template → native confirm() then row vanishes. | MEDIUM | ≥1 template |
| FE-SESS-025 | Compare button on row → opens SessionCompareModal; can pick second session. | MEDIUM | ≥2 completed |
| FE-SESS-026 | Awaiting-enhancement-review status uses amber sparkle icon; clicking opens detail with EnhancerPanel. | MEDIUM | enhancement-paused session |

## 3. Session detail (SessionDetailPage)

| ID | Description | Severity | Prereq |
|---|---|---|---|
| FE-DET-001 | Loading skeleton matches eventual layout (no jank). | MEDIUM | open session |
| FE-DET-002 | React-Flow graph renders all nodes (input, coder(s), tester, summarizer, finalizer, output) and connecting edges. | CRITICAL | ≥1 session |
| FE-DET-003 | Node icons match agent type (Code2 for coder, Search for tester, FileStack for summarizer, Trophy for finalizer, etc.). | LOW | — |
| FE-DET-004 | Active node has glow + pulse animation; status text updates ("Generating…", "Testing…"). | HIGH | running session |
| FE-DET-005 | Click any node → DetailPanel slides in from right with logs/output. | CRITICAL | ≥1 node |
| FE-DET-006 | DetailPanel tabs/sections (output, logs, metrics) switch without page reload. | HIGH | panel open |
| FE-DET-007 | WebSocket `agent_started` event flips node from idle to working in real time. | CRITICAL | start a run |
| FE-DET-008 | `code_execution_started` event shows sandbox spinner and execution status. | HIGH | running |
| FE-DET-009 | `iteration_completed` event updates iteration counter + progress bar. | HIGH | multi-iter run |
| FE-DET-010 | Iteration progress bar fills proportionally; not exceeding 100%. | MEDIUM | running |
| FE-DET-011 | Countdown timers R/S/A on active node tick down each second; clamp at 0. | HIGH | running |
| FE-DET-012 | Settings cog on a node opens popup with provider/model/effort/temp/max_tokens; changes persist after Save. | HIGH | idle session |
| FE-DET-013 | Provider dropdown only lists configured providers; switching provider repopulates model dropdown. | HIGH | settings popup |
| FE-DET-014 | "Run Code" on output → spinner, then preview iframe shows sandbox URL/HTML. | HIGH | completed session |
| FE-DET-015 | Browser preview iframe: scrollable, screenshot button works, no mixed-content warnings. | MEDIUM | preview open |
| FE-DET-016 | "Save as Template" → dialog asks name; success toast; template appears on Sessions page. | MEDIUM | completed session |
| FE-DET-017 | Reset button clears outputs and returns session to idle. Confirm dialog before destructive action. | HIGH | completed |
| FE-DET-018 | Re-finalize re-runs only the finalizer; other nodes untouched. | MEDIUM | completed |
| FE-DET-019 | Enhance button opens EnhancerPanel with 4 enhancer types (design/func/security/summary). | HIGH | completed |
| FE-DET-020 | Cancel during run → backend cancels; node turns "cancelled"; confirm before. | CRITICAL | running |
| FE-DET-021 | Pause → status "paused"; Resume continues from same iteration. | HIGH | running |
| FE-DET-022 | Compare → SessionCompareModal opens; can side-by-side another session's output. | MEDIUM | ≥2 sessions |
| FE-DET-023 | Git Info panel shows branch/commit/repo when session has repo attached; hidden otherwise. | MEDIUM | repo session |
| FE-DET-024 | Modal Escape key closes; clicking outside the modal also closes (not when in dropdown). | MEDIUM | any modal |
| FE-DET-025 | Auto-scroll: when new active node appears off-canvas, viewport pans to center it. | MEDIUM | long graph |
| FE-DET-026 | Disabled enhancer node (no config) renders muted with strikethrough/tooltip "no config". | LOW | unconfigured enhancer |
| FE-DET-027 | Header back arrow returns to `/sessions`; doesn't re-fetch list unnecessarily. | LOW | — |
| FE-DET-028 | WS disconnect → toast "reconnecting"; auto-reconnect on regain; no duplicate events. | HIGH | kill backend briefly |
| FE-DET-029 | Status change to `failed` shows red banner with last error message; logs accessible. | HIGH | failing run |
| FE-DET-030 | Error/Done node shows tokens used + cost; numbers formatted with locale separators. | MEDIUM | completed |

## 4. Settings page

| ID | Description | Severity | Prereq |
|---|---|---|---|
| FE-SET-001 | All providers (OpenAI/Anthropic/Google/Grok/Ollama) listed with config status badge. | HIGH | logged in |
| FE-SET-002 | Expand provider → shows API key field (password type by default), eye toggles visibility. | HIGH | — |
| FE-SET-003 | Enter key + Save → success toast; badge flips to "configured". | CRITICAL | valid key |
| FE-SET-004 | "Test" disabled until configured; click → toast `<provider> is working!` or descriptive failure. | HIGH | configured |
| FE-SET-005 | "Refresh models" updates models list; spinner during; toast on completion. | MEDIUM | configured |
| FE-SET-006 | Theme toggle: Sun/Moon icon flips; document body class flips; persists after reload. | MEDIUM | — |
| FE-SET-007 | Webhooks: empty state message when none configured. | LOW | fresh account |
| FE-SET-008 | Add webhook: dialog, URL validation, save → row appears. | HIGH | — |
| FE-SET-009 | Test webhook: green check or red error toast. | HIGH | added webhook |
| FE-SET-010 | Edit webhook: pre-filled fields; save updates row. | MEDIUM | webhook exists |
| FE-SET-011 | Delete webhook: confirm dialog; row removed; no orphan toast. | MEDIUM | webhook exists |

## 5. Dashboard

| ID | Description | Severity | Prereq |
|---|---|---|---|
| FE-DASH-001 | 4 stat cards render: Total Cost, Tokens, Requests, Avg Iterations with icons. | MEDIUM | data exists |
| FE-DASH-002 | Window selector: 7/30/90 days re-fetches; loading text appears briefly. | MEDIUM | — |
| FE-DASH-003 | Daily cost chart bars scaled to max; today's bar visually distinct. | LOW | data exists |
| FE-DASH-004 | Top providers/models tables display rows sorted by cost desc. | LOW | data exists |
| FE-DASH-005 | Empty data → "No data" placeholder, no broken chart. | MEDIUM | fresh account |
| FE-DASH-006 | Error response → red error text, doesn't cascade-crash via ErrorBoundary. | HIGH | backend down |

## 6. Layout & navigation

| ID | Description | Severity | Prereq |
|---|---|---|---|
| FE-NAV-001 | Sidebar width transitions smoothly between 64 and 12 (w-64 ↔ w-12). | LOW | — |
| FE-NAV-002 | Collapsed sidebar still shows logo gradient block + nav icons centered. | MEDIUM | collapsed |
| FE-NAV-003 | Collapse state persists across reload (localStorage `codeforge_sidebar_collapsed`). | MEDIUM | reload |
| FE-NAV-004 | Active route gets `bg-cf-primary/20 text-cf-primary` highlight; only one active at a time. | HIGH | — |
| FE-NAV-005 | Nav items have `aria-label` and `title` so collapsed mode shows tooltips. | MEDIUM | hover collapsed |
| FE-NAV-006 | Theme toggle visible in both collapsed/expanded footer. | LOW | — |
| FE-NAV-007 | First-time user with no API keys: `ApiKeySetupDialog` auto-opens once per session. | CRITICAL | fresh account |
| FE-NAV-008 | ErrorBoundary catches child render crash; shows "Something went wrong" + reload button. | HIGH | inject crash |
| FE-NAV-009 | Toast container fixed top-right at `top: 80, right: 16` so it doesn't overlap session header. | LOW | trigger toast |

## 7. Accessibility

| ID | Description | Severity | Prereq |
|---|---|---|---|
| FE-A11Y-001 | Tab through Login → Sessions → Settings: focus ring visible on every interactive element. | HIGH | keyboard |
| FE-A11Y-002 | Enter submits forms (LoginPage, settings, webhook dialog). | HIGH | keyboard |
| FE-A11Y-003 | Icon-only buttons (sidebar collapse, theme toggle, trash) have `aria-label`. | MEDIUM | screen reader |
| FE-A11Y-004 | Text contrast on `text-cf-text-muted` over `bg-cf-panel` meets WCAG AA (≥4.5:1). | MEDIUM | contrast checker |
| FE-A11Y-005 | OTP step error announced via `aria-live="polite"`. | MEDIUM | NVDA |
| FE-A11Y-006 | Modal opens → focus trapped inside; Tab cycles within; Escape closes. | HIGH | open modal |
| FE-A11Y-007 | After modal close, focus returns to triggering element. | MEDIUM | open modal |
| FE-A11Y-008 | Status badges convey state via icon + text (not color alone). | MEDIUM | colorblind sim |

## 8. Responsive layout

| ID | Description | Severity | Prereq |
|---|---|---|---|
| FE-RES-001 | At 375px width: sidebar auto-collapses; sessions list rows stack readably. | HIGH | DevTools |
| FE-RES-002 | At 768px: stat cards grid `grid-cols-2 md:grid-cols-4` adapts. | MEDIUM | DevTools |
| FE-RES-003 | At ≥1280px: SessionDetail shows graph + DetailPanel side-by-side. | MEDIUM | DevTools |
| FE-RES-004 | Login card max-w-sm centers vertically + horizontally on all sizes. | LOW | DevTools |
| FE-RES-005 | Toaster stays in viewport on small screens. | LOW | trigger toast at 375px |

## 9. Edge cases

| ID | Description | Severity | Prereq |
|---|---|---|---|
| FE-EDGE-001 | Session name 200+ chars: truncates in list, full text in detail header tooltip. | MEDIUM | rename via API |
| FE-EDGE-002 | New session with empty specification → submit blocked with inline error. | HIGH | NewSessionPage |
| FE-EDGE-003 | Network error during sessions fetch → red error in main area + retry button. | HIGH | offline |
| FE-EDGE-004 | Token expired mid-session → API returns 401 → redirect to `/login` preserving target via `from`. | CRITICAL | manually expire JWT |
| FE-EDGE-005 | WebSocket dies mid-run → status "reconnecting"; events resume after reconnect; no duplicate node states. | HIGH | kill ws |
| FE-EDGE-006 | Two tabs viewing same session → both receive WS updates without state corruption. | MEDIUM | two tabs |
| FE-EDGE-007 | Browser back button after deleting current session → returns to list, no ghost session. | MEDIUM | delete + back |
| FE-EDGE-008 | Spec containing emojis/unicode/RTL renders correctly in every panel. | LOW | unicode spec |
| FE-EDGE-009 | Special chars in session name (`<script>`) are HTML-escaped. | CRITICAL | XSS attempt |
| FE-EDGE-010 | Refresh during active run → reconnect WS, state restored from backend. | HIGH | mid-run reload |

## 10. Visual polish

| ID | Description | Severity | Prereq |
|---|---|---|---|
| FE-POL-001 | Dark mode: `bg-cf-bg`, panels, borders, gradients consistent; no white flash. | MEDIUM | dark theme |
| FE-POL-002 | Light mode (if implemented): all text remains readable; no dark-only colors leaked. | MEDIUM | light theme |
| FE-POL-003 | Animations (pulse, spin, fade) under 300ms; no nausea-level motion. | LOW | — |
| FE-POL-004 | Loading skeletons match final layout dimensions (no shift). | LOW | slow load |
| FE-POL-005 | Toast notifications appear top-right, persist 4s, dismissible via X. | LOW | trigger |
| FE-POL-006 | Toast action buttons (e.g. "Undo") visible & clickable before fade. | MEDIUM | bulk delete |
| FE-POL-007 | Lucide icons consistent in stroke width across the app. | LOW | visual scan |
| FE-POL-008 | Gradient logo (`from-cf-primary to-cf-secondary`) renders crisp on retina. | LOW | retina |
| FE-POL-009 | Focus rings use `ring-cf-primary`, not browser default blue. | LOW | tab |
| FE-POL-010 | Disabled buttons use `bg-gray-600 cursor-not-allowed`; not just opacity. | LOW | — |

---

## Notable automation gaps

The following items are **manual-only** and unlikely to be reliably caught by Playwright/Vitest:

1. **Visual aesthetics** — gradient quality, icon stroke consistency, animation tastefulness, dark/light mode harmony (FE-POL-001/003/007/008).
2. **Color contrast / colorblind simulation** — needs axe-core or human eyes (FE-A11Y-004/008).
3. **Screen-reader announcements** — `aria-live` regions need NVDA/JAWS/VoiceOver verification, not just DOM presence (FE-LOGIN-020, FE-A11Y-005).
4. **Animation perception** — pulse/glow on active node, smoothness of sidebar transition, no jank during graph re-layout (FE-DET-004, FE-NAV-001).
5. **Email delivery** — OTP arrival, request-access email, format of body (FE-LOGIN-004/017).
6. **Sandbox preview iframe** — actual rendered web app inside the iframe; cross-origin and runtime correctness (FE-DET-014/015).
7. **Real WebSocket timing** — countdown timer accuracy, reconnect dedup of events (FE-DET-011/028, FE-EDGE-005).
8. **Multi-tab consistency** — two browser tabs sharing a session (FE-EDGE-006).
9. **Responsive breakpoints** — tested with real device emulation, not just CSS media query mocks (FE-RES-001/002/003).
10. **Focus return after modal close** — Playwright can assert but humans confirm "feels right" (FE-A11Y-007).
