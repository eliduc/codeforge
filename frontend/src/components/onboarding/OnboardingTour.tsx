/**
 * OnboardingTour — root orchestrator for the new-user tour.
 *
 * Mounted once inside the authenticated Layout. Listens to the current route
 * (and a hint about session status), decides which mini-tour applies, and
 * displays a small bottom-right prompt. Only auto-spotlights when the user
 * clicks "Show me" — clicking "Skip" or completing the tour sets the seen
 * flag. Auto-dismissing the toast leaves the tour available via the user
 * menu's "Restart tour" entry (so a user who walks away doesn't lose it).
 *
 * Tour state is persisted in localStorage via useOnboarding.ts. See
 * `OnboardingHints` for the published API session pages use to tell us
 * "I'm in 'created' state now" without coupling to a global store.
 */

import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { driver, type Driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'
import './onboarding.css'

import { useAuthStore } from '../../stores/authStore'
import { isTourSeen, markSeen, type TourId } from './useOnboarding'
import {
  welcomeTour,
  sessionAnatomyTour,
  sessionLiveTour,
  sessionDoneTour,
} from './tours'
// Улучшатели#1 P2·M — Modal-only fallback when DOM targets are missing.
import Modal from '../common/Modal'
import Button from '../common/Button'

// ─────────────────────────────────────────────────────────────────────────────
// External hint API — pages publish their state here so the orchestrator can
// decide what to show without subscribing to every page's store.
// ─────────────────────────────────────────────────────────────────────────────

type SessionStatusHint =
  | 'created'
  | 'running'
  | 'completed'
  | 'paused'
  | 'failed'
  | 'cancelled'
  | 'awaiting_enhancement'
  | 'awaiting_enhancement_review'
  | 'enhancing'
  | null

interface OnboardingState {
  sessionStatus: SessionStatusHint
  /** Set true when the first agent_started event arrives — Tour 3 waits for this. */
  agentStartedSeen: boolean
}

const listeners = new Set<() => void>()
const state: OnboardingState = {
  sessionStatus: null,
  agentStartedSeen: false,
}

function notify() {
  for (const l of listeners) l()
}

/** Called by SessionDetailPage when session data loads or status changes. */
export function setOnboardingSessionStatus(status: SessionStatusHint) {
  if (state.sessionStatus === status) return
  state.sessionStatus = status
  // Reset agent-started flag when session changes status away from running.
  if (status !== 'running') {
    state.agentStartedSeen = false
  }
  notify()
}

/** Called by SessionDetailPage on the first agent_started WS event. */
export function setOnboardingAgentStarted() {
  if (state.agentStartedSeen) return
  state.agentStartedSeen = true
  notify()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast prompt — small bottom-right confirmation before the spotlight.
// ─────────────────────────────────────────────────────────────────────────────

interface TourPrompt {
  tourId: TourId
  steps: DriveStep[]
}

interface PromptToastProps {
  prompt: TourPrompt
  onShow: () => void
  onSkip: () => void
  /** Called when the toast auto-dismisses (12s). Does NOT mark the tour seen — the tour
   *  remains available via the user menu so users who step away don't lose it. */
  onTimeout: () => void
}

function PromptToast({ prompt, onShow, onSkip, onTimeout }: PromptToastProps) {
  // Улучшатели#1 P2·M — Tour auto-dismiss + markSeen behavior:
  // On 12s timeout, hide the toast WITHOUT marking the tour as seen.
  // markSeen only fires on explicit Skip click or tour completion.
  useEffect(() => {
    const t = setTimeout(() => {
      onTimeout()
    }, 12000)
    return () => clearTimeout(t)
  }, [onTimeout])

  return (
    // Улучшатели#1 P2·S — Tour toast a11y:
    // Switched role from "dialog" (which falsely promises focus-trap + Esc +
    // aria-labelledby semantics) to "status" — this is a non-modal notification
    // bubble, not a real dialog. Aligns with how AT users actually experience it.
    <div
      className="cf-tour-toast"
      role="status"
      aria-live="polite"
      aria-label="Onboarding tour prompt"
    >
      <div className="cf-tour-toast-text">
        {promptLabel(prompt.tourId)}
      </div>
      <div className="cf-tour-toast-actions">
        <button
          type="button"
          className="cf-tour-toast-btn cf-tour-toast-btn-secondary"
          onClick={onSkip}
        >
          Skip
        </button>
        <button
          type="button"
          className="cf-tour-toast-btn cf-tour-toast-btn-primary"
          onClick={onShow}
        >
          Show me
        </button>
      </div>
    </div>
  )
}

function promptLabel(tourId: TourId): string {
  switch (tourId) {
    case 'welcome':
      return '👋 Want a quick tour? (60 sec)'
    case 'session_anatomy':
      return '🧭 Quick tour of this session view? (45 sec)'
    case 'session_live':
      return '⚡ Watch the live multi-agent view? (30 sec)'
    case 'session_done':
      return '🎉 Tour of what to do next? (30 sec)'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/** Common driver.js options for every tour. */
function makeDriver(steps: DriveStep[], onDone: () => void): Driver {
  return driver({
    showProgress: true,
    progressText: 'Step {{current}} of {{total}}',
    allowClose: true,
    overlayOpacity: 0.6,
    popoverClass: 'cf-tour-popover',
    // Advance on outside-click rather than blocking the user.
    overlayClickBehavior: 'nextStep',
    nextBtnText: 'Next →',
    prevBtnText: '← Back',
    doneBtnText: 'Done',
    showButtons: ['next', 'previous', 'close'],
    steps,
    onDestroyed: () => {
      onDone()
    },
  })
}

// Улучшатели#1 P2·M — Tour starts before DOM targets exist.
// Returns the list of step-element selectors that are missing from the DOM.
// Modal-only steps (no `element`) are always considered present.
function missingTargets(steps: DriveStep[]): string[] {
  const missing: string[] = []
  for (const s of steps) {
    const el = (s as { element?: string | Element }).element
    if (!el) continue
    if (typeof el !== 'string') continue
    try {
      if (!document.querySelector(el)) missing.push(el)
    } catch {
      // Invalid selector — treat as missing.
      missing.push(el)
    }
  }
  return missing
}

// Build a Modal-only fallback view of a tour: title from first step + a list
// of (title, description) for each remaining step. Used when the DOM target
// selectors haven't appeared (e.g. brand-new user with zero sessions, so the
// `data-tour="sessions-list"` node doesn't exist yet).
interface FallbackContent {
  title: string
  paragraphs: Array<{ heading?: string; body: string }>
}
function buildFallbackContent(steps: DriveStep[]): FallbackContent {
  const paragraphs: Array<{ heading?: string; body: string }> = []
  let title = 'Welcome to CodeForge'
  for (let i = 0; i < steps.length; i++) {
    const p = steps[i].popover
    if (!p) continue
    if (i === 0 && p.title) title = p.title
    paragraphs.push({
      heading: i === 0 ? undefined : (p.title || undefined),
      body: p.description || '',
    })
  }
  return { title, paragraphs }
}

export default function OnboardingTour() {
  const location = useLocation()
  const navigate = useNavigate()
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)
  const authDisabled = useAuthStore(s => s.authDisabled)
  const authLoading = useAuthStore(s => s.loading)

  // Улучшатели#1 P3·S — dev-mode ?tour=1 override.
  // When the URL carries ?tour=1 we force-enable tours even in dev-mode
  // auto-login, so frontend engineers can validate the onboarding flow without
  // having to disable AUTH_DISABLED on the backend.
  const tourForced = (() => {
    try {
      const params = new URLSearchParams(location.search)
      return params.get('tour') === '1'
    } catch {
      return false
    }
  })()

  // Force re-render when external hints change.
  const [, force] = useState(0)
  useEffect(() => {
    const unsubscribe = subscribe(() => force(x => x + 1))
    return () => {
      unsubscribe()
    }
  }, [])

  const [prompt, setPrompt] = useState<TourPrompt | null>(null)
  // Улучшатели#1 P2·M — Modal-only fallback when DOM targets are missing.
  const [fallback, setFallback] = useState<{ tourId: TourId; content: FallbackContent } | null>(null)
  const activeDriverRef = useRef<Driver | null>(null)
  // Guard against firing the same tour twice in a single mount cycle (e.g. on
  // rapid re-renders before localStorage settles).
  const firedThisMountRef = useRef<Set<TourId>>(new Set())

  // Decide which tour applies based on route + hint state.
  useEffect(() => {
    // Inert unless authenticated and auth check has completed.
    if (authLoading) return
    if (!isAuthenticated) return
    // Skip dev-mode auto-login unless ?tour=1 forces tours on.
    // Улучшатели#1 P3·S — dev-mode ?tour=1 override
    if (authDisabled && !tourForced) return
    // Don't fire while another driver is active.
    if (activeDriverRef.current) return
    // Don't show a new prompt while one is already on screen, and don't fire
    // a new prompt while the Modal-only fallback is showing.
    if (prompt) return
    if (fallback) return

    const path = location.pathname

    // Tour 1 — Welcome on /sessions.
    if (path === '/sessions' || path === '/sessions/') {
      if (!isTourSeen('welcome') && !firedThisMountRef.current.has('welcome')) {
        // Wait a beat so the sessions list has rendered.
        const t = setTimeout(() => {
          if (!isTourSeen('welcome')) {
            firedThisMountRef.current.add('welcome')
            setPrompt({ tourId: 'welcome', steps: welcomeTour })
          }
        }, 600)
        return () => clearTimeout(t)
      }
    }

    // Tours 2-4 — session detail pages.
    const detailMatch = path.match(/^\/sessions\/([^/]+)$/)
    if (detailMatch && detailMatch[1] !== 'new') {
      const status = state.sessionStatus

      if (
        status === 'created' &&
        !isTourSeen('session_anatomy') &&
        !firedThisMountRef.current.has('session_anatomy')
      ) {
        const t = setTimeout(() => {
          if (!isTourSeen('session_anatomy')) {
            firedThisMountRef.current.add('session_anatomy')
            setPrompt({ tourId: 'session_anatomy', steps: sessionAnatomyTour })
          }
        }, 800)
        return () => clearTimeout(t)
      }

      if (
        status === 'running' &&
        state.agentStartedSeen &&
        !isTourSeen('session_live') &&
        !firedThisMountRef.current.has('session_live')
      ) {
        const t = setTimeout(() => {
          if (!isTourSeen('session_live')) {
            firedThisMountRef.current.add('session_live')
            setPrompt({ tourId: 'session_live', steps: sessionLiveTour })
          }
        }, 1000)
        return () => clearTimeout(t)
      }

      if (
        status === 'completed' &&
        !isTourSeen('session_done') &&
        !firedThisMountRef.current.has('session_done')
      ) {
        const t = setTimeout(() => {
          if (!isTourSeen('session_done')) {
            firedThisMountRef.current.add('session_done')
            setPrompt({ tourId: 'session_done', steps: sessionDoneTour })
          }
        }, 600)
        return () => clearTimeout(t)
      }
    }
  }, [
    location.pathname,
    // КАО#R4-S3 — location.key changes on EVERY navigation, including same-path
    // (e.g. "Restart tour" from /sessions while already on /sessions). Without
    // it the decide-effect never re-ran, so restarting the tour from the
    // default landing page silently did nothing.
    location.key,
    isAuthenticated,
    authDisabled,
    authLoading,
    tourForced,
    prompt,
    fallback,
    // We deliberately depend on state hint values for re-evaluation.
    state.sessionStatus,
    state.agentStartedSeen,
  ])

  // Reset the per-mount guard set when route changes so the user can re-trigger
  // tours after resetting them via the user menu. КАО#R4-S3 — keyed on
  // location.key so a same-path navigation also clears the guard.
  useEffect(() => {
    firedThisMountRef.current = new Set()
  }, [location.pathname, location.key])

  // Улучшатели#1 P2·M — Tour starts before DOM targets exist.
  // Wraps steps with custom onPopoverRender for the Welcome tour's final step
  // so we can offer two CTAs ("Done" closes, "Open demos →" navigates) without
  // forcing every Done click to navigate (P2·S — Welcome tour redirect).
  function decorateSteps(tourId: TourId, steps: DriveStep[]): DriveStep[] {
    if (tourId !== 'welcome') return steps
    if (steps.length === 0) return steps
    const lastIdx = steps.length - 1
    return steps.map((s, i) => {
      if (i !== lastIdx) return s
      // Inject an extra "Open demos →" button next to the standard Done btn.
      // Улучшатели#1 P2·S — Welcome tour two-CTA Done.
      const popover = { ...(s.popover ?? {}) } as NonNullable<DriveStep['popover']>
      popover.onPopoverRender = (popoverDom) => {
        // Avoid double-injecting if driver.js re-renders the same step.
        if (popoverDom.footer?.querySelector('[data-cf-tour-cta="open-demos"]')) return
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = 'Open demos →'
        btn.setAttribute('data-cf-tour-cta', 'open-demos')
        btn.className = 'driver-popover-next-btn'
        btn.style.marginRight = '0.375rem'
        btn.addEventListener('click', () => {
          markSeen('welcome')
          // Destroying the driver will trigger onDestroyed → cleanup; we set a
          // flag via the closure so onDestroyed knows we *want* to navigate.
          shouldNavigateAfterWelcomeRef.current = true
          activeDriverRef.current?.destroy()
        })
        // Insert before the navigation buttons block (where Back/Done live).
        const navBtns = popoverDom.footer?.querySelector('.driver-popover-navigation-btns')
        if (navBtns) {
          navBtns.insertBefore(btn, navBtns.firstChild)
        } else if (popoverDom.footer) {
          popoverDom.footer.appendChild(btn)
        }
      }
      return { ...s, popover }
    })
  }

  // Tracks whether the user clicked the welcome tour's "Open demos →" CTA so
  // the onDestroyed callback knows whether to navigate.
  const shouldNavigateAfterWelcomeRef = useRef(false)

  function startDriver(tourId: TourId, steps: DriveStep[]) {
    const decorated = decorateSteps(tourId, steps)
    const d = makeDriver(decorated, () => {
      markSeen(tourId)
      activeDriverRef.current = null
      // Улучшатели#1 P2·S — Welcome tour redirect /demos on Done without warning.
      // Plain "Done" now closes WITHOUT navigating. Navigation only happens
      // when the user clicked the dedicated "Open demos →" CTA.
      if (tourId === 'welcome' && shouldNavigateAfterWelcomeRef.current) {
        shouldNavigateAfterWelcomeRef.current = false
        try { navigate('/demos') } catch { /* ignore */ }
      }
      shouldNavigateAfterWelcomeRef.current = false
    })
    activeDriverRef.current = d
    setTimeout(() => {
      try {
        d.drive()
      } catch (err) {
        // Defensive: a missing element should not crash the app.
        // eslint-disable-next-line no-console
        console.warn('[onboarding] failed to start tour', tourId, err)
        // Улучшатели#1 P2·M — do NOT markSeen on DOM-failure path; fall back to Modal.
        activeDriverRef.current = null
        const content = buildFallbackContent(steps)
        setFallback({ tourId, content })
      }
    }, 50)
  }

  function handleShow() {
    if (!prompt) return
    const { tourId, steps } = prompt
    setPrompt(null)

    // Улучшатели#1 P2·M — Tour starts before DOM targets exist.
    // Before driving, verify all targets resolve. If anything is missing, wait
    // 500ms and retry once. If still missing, render the steps as a Modal so
    // the user still gets the content. Crucially, DO NOT markSeen on the
    // DOM-failure path — the tour remains available via the user menu.
    const missing = missingTargets(steps)
    if (missing.length === 0) {
      startDriver(tourId, steps)
      return
    }
    // Defer + retry once.
    setTimeout(() => {
      const stillMissing = missingTargets(steps)
      if (stillMissing.length === 0) {
        startDriver(tourId, steps)
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          '[onboarding] DOM targets missing — falling back to modal flow',
          tourId,
          stillMissing,
        )
        const content = buildFallbackContent(steps)
        setFallback({ tourId, content })
      }
    }, 500)
  }

  function handleSkip() {
    if (!prompt) return
    // Улучшатели#1 P2·M — markSeen only on explicit Skip click.
    markSeen(prompt.tourId)
    setPrompt(null)
  }

  function handleTimeout() {
    if (!prompt) return
    // Улучшатели#1 P2·M — Do NOT markSeen on auto-dismiss; user may have
    // stepped away. The tour stays available via the user menu's "Restart
    // tour" entry.
    setPrompt(null)
  }

  // Улучшатели#1 P2·M — Modal-only fallback handlers.
  function handleFallbackClose() {
    // Plain "Close" does NOT mark the tour seen — user might want to retry
    // after creating their first session.
    setFallback(null)
  }
  function handleFallbackDone() {
    if (!fallback) return
    const tourId = fallback.tourId
    markSeen(tourId)
    setFallback(null)
    if (tourId === 'welcome') {
      // Same two-CTA convention — only navigate when user opts in. The modal
      // wires this up via a dedicated "Open demos →" button below.
    }
  }
  function handleFallbackOpenDemos() {
    if (!fallback) return
    markSeen(fallback.tourId)
    setFallback(null)
    try { navigate('/demos') } catch { /* ignore */ }
  }

  return (
    <>
      {prompt && (
        <PromptToast
          prompt={prompt}
          onShow={handleShow}
          onSkip={handleSkip}
          onTimeout={handleTimeout}
        />
      )}
      {fallback && (
        <Modal
          open={true}
          onClose={handleFallbackClose}
          title={fallback.content.title}
          size="lg"
        >
          <div className="space-y-3 text-sm text-cf-text-muted">
            {fallback.content.paragraphs.map((p, i) => (
              <div key={i}>
                {p.heading && (
                  <div className="text-cf-text font-medium mb-1">{p.heading}</div>
                )}
                <div className="leading-relaxed">{p.body}</div>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={handleFallbackClose}>
              Close
            </Button>
            {fallback.tourId === 'welcome' && (
              <Button variant="secondary" onClick={handleFallbackOpenDemos}>
                Open demos →
              </Button>
            )}
            <Button variant="primary" onClick={handleFallbackDone}>
              Done
            </Button>
          </div>
        </Modal>
      )}
    </>
  )
}
