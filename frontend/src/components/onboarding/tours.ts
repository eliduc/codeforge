/**
 * Tour step definitions for the 4 onboarding flows. Steps are plain objects
 * compatible with driver.js's `Step` shape — element is a CSS selector (or
 * omitted for popover-only modal steps).
 */

import type { DriveStep } from 'driver.js'

/** Tour 1 — Welcome (route: /sessions). Fires on first visit ever. */
export const welcomeTour: DriveStep[] = [
  {
    // Modal-only step — driver.js centers the popover when element is omitted.
    popover: {
      title: 'Welcome to CodeForge',
      description:
        "👋 In about a minute I'll show you how a small team of AI agents " +
        'builds, tests, and refines code together — sometimes in surprising ways.',
    },
  },
  {
    element: '[data-tour="sessions-list"]',
    popover: {
      title: 'Your workspace',
      description:
        'This is your workspace. Each row is a session — a self-contained ' +
        'project with its own agents, history, and final output.',
      side: 'top',
      align: 'start',
    },
  },
  {
    element: '[data-tour="new-session"]',
    popover: {
      title: 'Start a new session',
      description:
        'Start a session from a description, an existing file, or a template. ' +
        'The Mandelbulb and Pong templates are great first runs.',
      side: 'bottom',
      align: 'end',
    },
  },
  {
    element: '[data-tour="templates"]',
    popover: {
      title: 'Templates & examples',
      description:
        'Templates are pre-written specs from interesting projects. Click ' +
        'one to see CodeForge handle a real generation task.',
      side: 'bottom',
      align: 'end',
    },
  },
  {
    element: '[data-tour="demos-nav"]',
    popover: {
      title: 'Watch a demo first',
      description:
        'See CodeForge in action without spending a cent. The Demos section ' +
        "plays back a real multi-agent run at 60× speed — full graph live, " +
        "streaming text, audits, and the final result in ~90 seconds. " +
        "Try-it-yourself spins up the same spec for a real run.",
      side: 'right',
      align: 'start',
    },
  },
  {
    // Улучшатели#1 P2·S — Welcome tour final step: two CTAs instead of one.
    // "Done" closes the tour without navigating; "Open demos →" navigates.
    // The "Open demos" button is injected by OnboardingTour.tsx via
    // onPopoverRender so we can wire it through react-router-dom.
    popover: {
      title: 'You\'re all set',
      description:
        "Hit Done to close this tour, or jump straight to a live demo " +
        "playback. You can replay this tour any time from the user menu.",
    },
  },
]

/** Tour 2 — Session anatomy (route: /sessions/<id>, status='created'). */
export const sessionAnatomyTour: DriveStep[] = [
  {
    element: '[data-tour="spec-field"]',
    popover: {
      title: 'Specification',
      description:
        "Describe what you want built. Be specific — 'A WebGL2 Mandelbulb " +
        "with adjustable n and live morphing' beats 'a 3D thing'. The " +
        'clearer the spec, the sharper the output.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="settings-btn"]',
    popover: {
      title: 'Tune your agent team',
      description:
        'Tune your agent team here: number of Coders/Testers, models ' +
        '(Opus vs Sonnet etc.), timeouts, cost cap, and streaming.',
      side: 'bottom',
      align: 'end',
    },
  },
  {
    element: '[data-tour="coders-group"]',
    popover: {
      title: 'Coders',
      description:
        'Two Coders by default — different models, working in parallel. ' +
        'Each produces its own version of the code, then a judge picks the winner.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="testers-group"]',
    popover: {
      title: 'Testers',
      description:
        "Every Tester reads every Coder's output and audits it: spec " +
        'compliance, correctness, code quality. Audits drive the next iteration.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '.react-flow__node[data-id="summarizer"]',
    popover: {
      title: 'Summarizer — the team lead',
      description:
        "Reads every Tester's audit, ranks issues by severity (critical → " +
        'serious → minor) and writes a single prioritised brief that the ' +
        'Coders consume at the start of the next iteration. Without it, the ' +
        'Coders would drown in conflicting opinions.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '.react-flow__node[data-id="finalizer"]',
    popover: {
      title: 'Finalizer — the judge',
      description:
        "When all iterations finish, the Finalizer compares the Coders' " +
        'final versions side by side, picks the winner, and writes a short ' +
        'README explaining what was built and why this version won.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="coders-group"]',
    popover: {
      title: 'The iterative loop',
      description:
        'Up to 5 iterations: Coders write → Testers audit → Summarizer ' +
        'prioritises → Coders REFINE the same code with full context of ' +
        "what was wrong. Bugs that survived round 1 get attacked again in " +
        'round 2. This is where multi-agent really shines.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="agent-graph"]',
    popover: {
      title: 'Pipeline flow',
      description:
        'The graph flows left to right: Specification → Coders → Testers → ' +
        "Summarizer → Final Code. Drag a group's frame to rearrange — drag " +
        'a single node to move just it.',
      side: 'top',
      align: 'center',
    },
  },
  {
    element: '[data-tour="start-btn"]',
    popover: {
      title: 'Hit Start',
      description:
        'Hit Start when ready. Up to 5 iterations refine the code ' +
        'automatically. You can Pause, Cancel, or Intervene mid-flight ' +
        'without losing progress.',
      side: 'bottom',
      align: 'end',
    },
  },
  {
    popover: {
      title: 'That’s the anatomy',
      description:
        "When you Start, I'll come back with a quick tour of the live view.",
    },
  },
]

/** Tour 3 — Live multi-agent view (route: /sessions/<id>, status='running').
 *  Uses `data-tour-candidate` selectors because there are multiple matching
 *  elements (several coders, several timer rows); document.querySelector
 *  picks the first one — exactly what we want. */
export const sessionLiveTour: DriveStep[] = [
  {
    element: '[data-tour-candidate="active-coder"]',
    popover: {
      title: 'Live agent state',
      description:
        'Each glowing node shows live state: elapsed time (T:M:SS), tokens, ' +
        'and streaming text as the LLM writes. The dashed frame holds the ' +
        'whole group together.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour-candidate="streaming-preview"]',
    popover: {
      title: 'Streaming preview',
      description:
        "When streaming's on (default), you see the last 200 characters " +
        'being generated. The node grows to fit.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour-candidate="timer-chips"]',
    popover: {
      title: 'Countdown timers',
      description:
        'T = elapsed since start, R = request timeout countdown, A = total-agent ' +
        'timeout, S = sandbox timeout. They turn amber under 2 min, red under 1 min.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour="metrics-panel"]',
    popover: {
      title: 'Live metrics',
      description:
        'Live totals: iteration, tokens, cost, agents done. Update in real ' +
        'time over WebSocket.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour-candidate="active-coder"]',
    popover: {
      title: 'Watch the iteration tick',
      description:
        "When a Tester finishes auditing, the Summarizer aggregates its " +
        "findings and the Coders re-enter Coding… with the audit baked into " +
        "their prompt. Watch the iteration counter (top-right of each Coder " +
        'node) tick up — round 2 is where they fix what round 1 got wrong.',
      side: 'right',
      align: 'start',
    },
  },
  {
    popover: {
      title: 'Watch them collaborate',
      description:
        "Watch the agents collaborate. When the workflow finishes, I'll " +
        'come back one more time.',
    },
  },
]

/** Tour 4 — Final code & enhancement (status='completed'). */
export const sessionDoneTour: DriveStep[] = [
  {
    element: '[data-tour="final-code"]',
    popover: {
      title: 'Final code',
      description:
        'Your finished code. View, copy, download, or open in a sandbox ' +
        'preview from here.',
      side: 'left',
      align: 'start',
    },
  },
  {
    element: '[data-tour="enhance-btn"]',
    popover: {
      title: 'Enhance — the second pass',
      description:
        "Click Enhance to start a second pass. Three specialist agents " +
        'propose improvements in parallel: **Design** (UX & layout), ' +
        '**Functionality** (perf & correctness), and **Security** (safety ' +
        '& edge cases). They run side-by-side, then the Enh. Summarizer ' +
        'merges their lists into one curated set.',
      side: 'bottom',
      align: 'end',
    },
  },
  {
    element: '[data-tour="enhance-btn"]',
    popover: {
      title: 'Curate the suggestions',
      description:
        'Each suggestion has a severity (high/medium/low) and an explanation. ' +
        "Check the ones you want; uncheck the rest. You're the editor — the " +
        "agents propose, you decide. This is where multi-agent shines without " +
        "becoming overwhelming.",
      side: 'bottom',
      align: 'end',
    },
  },
  {
    element: '[data-tour="enhance-btn"]',
    popover: {
      title: 'Apply → a fresh session',
      description:
        "Apply spawns a new session — same agents, but starting from your " +
        "current final code with the selected improvements bolted onto the " +
        'spec. Run another 5 iterations, hit Enhance again, iterate to ' +
        'perfection.',
      side: 'bottom',
      align: 'end',
    },
  },
  {
    element: '[data-tour="share-btn"]',
    popover: {
      title: 'Share link',
      description:
        'Generate a read-only link to share the session. Recipients can ' +
        'view the spec, watch the timeline, and play with the final code — ' +
        'without seeing your account.',
      side: 'top',
      align: 'center',
    },
  },
  {
    popover: {
      title: 'Welcome aboard 🎉',
      description:
        "You've seen the loop end-to-end. Try a fresh idea, or enhance this " +
        'one. Welcome to CodeForge!',
    },
  },
]
