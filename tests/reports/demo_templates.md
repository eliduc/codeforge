# Demo Templates — Implementation Report

Date: 2026-05-12

## Summary

Added a **"Featured Demos"** gallery to the Sessions page with 4 pre-recorded
session playbacks. Each demo replays a real CodeForge multi-agent flow
(workflow started → coders streaming → testers auditing → summarizer →
finalizer → final code) at ~60× speed using a static JSON timeline. No LLM
calls, no DB writes — pure client-side animation. A "Try it yourself"
button on every card spins up a real session from the underlying spec via
the existing `createSession` API.

## Templates shipped

| ID            | Final artefact                                  | Source of final_code                                   |
|---------------|--------------------------------------------------|--------------------------------------------------------|
| `mandelbulb`  | WebGL2 Mandelbulb strange attractor              | Pulled from prod DB (session `14e894a0-…-742f46aea4b4`) |
| `snake`       | Neon Snake game (canvas)                         | Hand-authored, 95 lines (`_snake_final.html`)          |
| `particles`   | Curl-noise particle flow-field generative art    | Hand-authored, 110 lines (`_particles_final.html`)     |
| `crystal`     | Real-time ray-marched glass crystal (WebGL)      | Hand-authored, 130 lines (`_crystal_final.html`)       |

All four final artefacts run standalone in an iframe (no external deps).

## File map

### Frontend (new files)

- `frontend/src/hooks/useTimelinePlayer.ts` — playback engine (rAF clock,
  pending-event dispatcher, play/pause/restart/seek/speed).
- `frontend/src/pages/DemoPlayerPage.tsx` — `/demo/:templateId` route. Reuses
  `AgentNode`, `ArtifactEdge`, `MetricsPanel`. Tabs: "Live graph" + "Final
  result" iframe. Confetti on completion.
- `frontend/src/components/demo/DemoGallery.tsx` — 4-card row mounted on
  SessionsPage with **▶ Watch demo** + **🚀 Try it yourself** buttons.
- `frontend/scripts/gen-demo-timelines.mjs` — timeline-generator helper. Run
  with `node frontend/scripts/gen-demo-timelines.mjs` to regenerate all four
  `*.json` files from the `_*_final.html` sources.

### Frontend (touched files)

- `frontend/src/App.tsx` — wired `/demo/:templateId` route.
- `frontend/src/pages/SessionsPage.tsx` — mounted `<DemoGallery />` above the
  templates panel.
- `frontend/src/components/onboarding/tours.ts` — added one step targeting
  `[data-tour="demo-gallery"]` in the Welcome tour.
- `frontend/src/components/onboarding/useOnboarding.ts` — bumped tour version
  prefix from `cf_tour_v1_` → `cf_tour_v2_` (so returning users see the new
  step), and added legacy-key cleanup in `resetAll()`.

### Static assets

- `frontend/public/demo-templates/`
  - `index.json` — gallery metadata (id, name, description, language, thumbnail, duration)
  - `mandelbulb.json` (268 KB), `snake.json` (82 KB), `particles.json` (80 KB), `crystal.json` (95 KB) — full timelines (events + final_code)
  - `_mandelbulb_final.html`, `_snake_final.html`, `_particles_final.html`, `_crystal_final.html` — final-code source files used by the generator

## Timeline schema

```ts
interface DemoTimeline {
  id, name, description, language, spec, thumbnail
  duration_seconds: 90
  coders: { model }[]; testers: { model }[]; summarizer, finalizer
  events: TimelineEvent[]   // ~75 per timeline
  final_code: string         // self-contained HTML
}
interface TimelineEvent {
  t: number                                 // seconds from start
  type: 'workflow_started' | 'iteration_started' | 'phase_started'
      | 'agent_started' | 'agent_streaming' | 'agent_completed'
      | 'iteration_completed' | 'workflow_completed'
  agent_type?, agent_index?, iteration?, phase?
  partial_content?    // for agent_streaming
  tokens?, cost?, issuesFound?
}
```

Each timeline has 1 iteration, 2 coders + 2 testers + 1 summarizer + 1
finalizer, and ~75 events. Coder streaming events distribute the actual
final_code across two coders with light interleaving (deterministic jitter
of ±0.9s so streaming chunks arrive at irregular intervals).

## How to play each demo from prod

1. Open <https://miniblack:3000> (or stage <https://miniblack:3100>).
2. Sign in.
3. The "Featured Demos" row sits at the top of the Sessions page.
4. Click **▶ Watch demo** on any card.
5. Use the bottom bar to Play/Pause/Restart, drag the progress bar to seek,
   choose 1×/2×/4× speed.
6. When the timeline finishes the tab auto-switches to "Final result" (live
   iframe of the final HTML) with a brief confetti banner.
7. Click **🚀 Try it yourself** at any time to spin up a real session from
   the same spec — routes to `/sessions/<new-id>`.

Direct URLs:

- `<host>/demo/mandelbulb`
- `<host>/demo/snake`
- `<host>/demo/particles`
- `<host>/demo/crystal`

## Verification

- `npx tsc --noEmit` — clean.
- `npx vite build` — clean (788 KB main bundle, +0 KB vs pre-change baseline
  since timelines load from `/public/` on demand).
- Existing functionality preserved: SessionsPage templates panel, status
  filters, search, import/export, compare, bulk-delete all untouched. The
  Welcome tour now has one extra step but no existing step was removed or
  renamed.

## Onboarding behaviour change

Returning users will see the Welcome tour **once** again on next visit, due
to the `cf_tour_v1_` → `cf_tour_v2_` key-prefix bump. Their `cf_tour_v1_*`
flags are retained until they click "Restart onboarding tour", which now
also clears the legacy keys via the new `LEGACY_KEYS` list in
`resetAll()`.

## Deploy

Patch tarball `cf-demo-patch.tgz` (~80 KB) extracted into both
`/home/lev/codeforge-stage` (stage @ port 3100) and `/home/lev/codeforge`
(prod @ port 3000). Both rebuilt with `docker compose up -d --build frontend`.

Deploy timestamps + health-check results — see end of session log.
