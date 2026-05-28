# Onboarding tour — implementation report

## Files changed

### New
- `frontend/src/components/onboarding/OnboardingTour.tsx` — orchestrator, mounted in `Layout.tsx`. Listens to route + session-status hints, renders the bottom-right prompt, runs driver.js.
- `frontend/src/components/onboarding/tours.ts` — the 4 tour definitions (welcome / anatomy / live / done) as `DriveStep[]`.
- `frontend/src/components/onboarding/useOnboarding.ts` — localStorage helpers (`isTourSeen` / `markSeen` / `resetAll`) plus the key map `TOUR_KEYS`.
- `frontend/src/components/onboarding/onboarding.css` — dark popover theme + bottom-right toast styles.

### Modified
- `frontend/package.json` / `package-lock.json` — added `driver.js@^1.4.0` (npm resolved the `^1.3.0` range to 1.4.0).
- `frontend/src/components/layout/Layout.tsx` — mounted `<OnboardingTour />` once inside the authenticated layout; added a user menu (User icon → dropdown) with `Restart onboarding tour` and `Log out` items in both expanded and collapsed sidebar variants.
- `frontend/src/pages/SessionsPage.tsx` — `data-tour="sessions-list"` (also on empty-state), `data-tour="new-session"`, `data-tour="templates"`.
- `frontend/src/pages/SessionDetailPage.tsx` — `data-tour="settings-btn"`, `"start-btn"`, `"enhance-btn"`, `"agent-graph"`, `"coders-group"` / `"testers-group"` (on the group frames inside `GroupFramesLayer`). Added `useEffect` publishing `session.status` to the orchestrator and a call to `setOnboardingAgentStarted()` inside the `agent_started` WS handler.
- `frontend/src/components/graph/AgentNode.tsx` — `data-tour="spec-field"` on the input node, `data-tour="final-code"` on the output node, `data-tour-candidate="active-coder"` on the first working coder, `data-tour-candidate="streaming-preview"` on the streaming panel, `data-tour-candidate="timer-chips"` on the countdown row. (Tours 3 use `data-tour-candidate` so `document.querySelector` automatically picks the first match instead of requiring tour code to enumerate clones.)
- `frontend/src/components/graph/MetricsPanel.tsx` — `data-tour="metrics-panel"`.
- `frontend/src/components/common/ResultActionsExtras.tsx` — `data-tour="share-btn"` on the Share button.

All `data-tour*` additions are additive — no className/event/aria attributes were removed.

## Tours and triggers

| Tour | Route | Trigger | Steps | Persistence key |
|------|-------|---------|-------|-----------------|
| 1. Welcome | `/sessions` | First visit ever (after sessions list renders, 600 ms delay) | 5 (incl. 2 modal-only) | `cf_tour_v1_welcome` |
| 2. Session anatomy | `/sessions/:id` | `session.status === 'created'` and tour not yet seen (800 ms after page mount) | 7 (incl. 1 modal-only) | `cf_tour_v1_session_anatomy` |
| 3. Live multi-agent view | `/sessions/:id` | `session.status === 'running'` AND first `agent_started` WS event seen, tour not yet seen (1 s delay so the highlights have a real glowing node) | 5 (incl. 1 modal-only) | `cf_tour_v1_session_live` |
| 4. Final code & enhancement | `/sessions/:id` | `session.status === 'completed'` and tour not yet seen (600 ms delay) | 4 (incl. 1 modal-only) | `cf_tour_v1_session_done` |

Each tour is gated by a small toast in the bottom-right: "👋 Want a quick tour?" with **Show me** / **Skip** buttons. Auto-dismiss after 12 s sets the seen flag silently (no nagging).

The orchestrator is inert when:
- `isAuthenticated === false` (login page),
- `loading === true` (initial auth check in progress),
- `authDisabled === true` (dev-mode bypass — no real account).

## How to restart

- **From the UI:** click the user icon at the bottom of the sidebar → **Restart onboarding tour**. This clears all `cf_tour_v1_*` keys and navigates to `/sessions`, where Tour 1 auto-fires on the next render.
- **From DevTools (full reset):** run `Object.keys(localStorage).filter(k => k.startsWith('cf_tour_v1_')).forEach(k => localStorage.removeItem(k))` and reload — all four tours become eligible again.

## Implementation notes

- **driver.js version:** specified `^1.3.0` in spec; npm resolved to `1.4.0`. API surface is compatible (`Driver`, `DriveStep`, `Config` types all present). Tooltip arrow positioning, dark popover override, and `overlayClickBehavior: 'nextStep'` are working with this version.
- **Active-coder selector:** because there are multiple coders, I used `data-tour-candidate="active-coder"` on every active coder; `document.querySelector` (which driver.js uses internally for string selectors) returns the first match, so Tour 3 spotlight lands on the first working coder. Same trick is used for `streaming-preview` and `timer-chips`.
- **Modal-only steps:** Tour 1 step 1 / step 5, Tour 2 step 7, Tour 3 step 5, Tour 4 step 4 omit the `element` field. driver.js centers the popover automatically — verified by inspecting the rendered DOM during local dev (`.driver-popover` is positioned with `top/left: 50%; transform: translate(-50%, -50%)`).
- **Non-blocking advance:** `overlayClickBehavior: 'nextStep'` means clicking outside the popover advances rather than dismissing — matches the "don't block the user" requirement.
- **TypeScript:** `npx tsc --noEmit` is clean.
- **Production build:** `npx vite build` succeeds; bundle size went from ~755 kB to ~768 kB (driver.js adds ~13 kB compiled, ~5 kB gzipped — well within budget).

## Deploy

| Environment | Timestamp (local) | Build result | Health check |
|-------------|-------------------|--------------|--------------|
| Stage (`~/codeforge-stage` on miniblack → `stage.gotcode.ai`) | 2026-05-12 16:08 JDT | `codeforge-stage-frontend:latest` built and recreated; `codeforge-claude-frontend Started` | `https://stage.gotcode.ai/health` → **HTTP 200** |
| Prod (`~/codeforge` on miniblack → `gotcode.ai`)              | 2026-05-12 16:08 JDT | `codeforge-frontend:latest` built and recreated; `codeforge-frontend Started`               | `https://gotcode.ai/health` → **HTTP 200**            |

Both builds were issued in parallel via `ssh miniblack "cd ~/<env> && docker compose build frontend && docker compose up -d frontend"`. The TypeScript step inside the build (`tsc && vite build`) succeeded — meaning the production image was rebuilt with `driver.js` baked in and the new onboarding components compiled cleanly.

To verify in-browser:
1. Clear all `cf_tour_v1_*` keys (or just visit on a fresh browser profile).
2. Log in and land on `/sessions` — the welcome toast should appear in the bottom-right after ~0.6 s.
3. Click **Show me** and run all 5 steps; click the user-icon at the bottom of the sidebar → **Restart onboarding tour** to re-enable all 4 tours.
