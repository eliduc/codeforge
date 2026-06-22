// Улучшатели#2 P0·S — NewSession proper form
// Replaces the previous auto-create behaviour that silently spent default tokens
// on a session with hardcoded specification "(not set)", python, 5 iters.
// Original finding: NewSessionPage.tsx:90-100 (pre-refactor).

import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { AlertTriangle, Info, Loader2, LayoutTemplate, Save, ChevronRight, Gauge } from 'lucide-react'
import notify from '../components/common/StyledToast'
import Button from '../components/common/Button'
import { createSession } from '../services/api'
import type { AgentConfig, CreateSessionRequest, LLMProvider } from '../types'
import { useProvidersStore } from '../stores/providersStore'
// КАО#VR-Wave6 SpecAnalyzer — pure helper that detects visual specs paired
// with non-renderable languages and recommends an auto-switch.
import { analyzeSpec } from '../lib/visualReviewHints'

/** Supported languages — keep in sync with backend `SessionCreate._KNOWN_LANGUAGES`.
 *  Trimmed to the six most common per the implementer spec; the backend accepts
 *  many more (java, c, cpp, ruby, ...). */
const LANGUAGE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'python', label: 'Python' },
  { value: 'javascript', label: 'JavaScript' },
  { value: 'typescript', label: 'TypeScript' },
  { value: 'html', label: 'HTML' },
  // КАО#VR-Wave6 SpecAnalyzer — JavaScript (Browser) is the auto-switch target
  // for visual specs; expose it as a selectable option so users can pick it
  // explicitly and so the "Switch" button maps to a visible option.
  { value: 'javascript_browser', label: 'JavaScript (Browser)' },
  // VR-45 — TypeScript (Browser) is the typed sibling of javascript_browser:
  // identical headless-Chromium render path, already accepted by the backend
  // (_KNOWN_LANGUAGES) and validated by the sandbox. Surfaced here for parity
  // with JS (Browser); was missing from the curated list since the start.
  { value: 'typescript_browser', label: 'TypeScript (Browser)' },
  { value: 'rust', label: 'Rust' },
  { value: 'go', label: 'Go' },
]

const SPEC_MIN_CHARS = 20
const SPEC_MAX_CHARS = 100_000

const ENHANCEMENT_PREF_KEY = 'codeforge.newSession.useEnhancementPipeline'
// КАО#VR-Wave1 Frontend — Visual Review: persist user's review preferences so
// repeat users don't have to re-toggle each time they create a session.
const SKIP_VISUAL_REVIEW_PREF_KEY = 'codeforge.newSession.skipVisualReview'
const FORCE_VISUAL_REVIEW_PREF_KEY = 'codeforge.newSession.forceVisualReview'

/** Autogen a name from the first 6 words of the spec, capped at 80 chars. */
function autogenName(spec: string): string {
  const words = spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join(' ')
  if (!words) {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `Session-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}`
  }
  const base = `Session — ${words}`
  return base.length > 80 ? base.slice(0, 80) : base
}

interface FieldErrors {
  specification?: string
  iterations?: string
  coders?: string
  testers?: string
}

export default function NewSessionPage() {
  const navigate = useNavigate()
  const { providers, fetchProviders, hasAnyConfigured, loaded } = useProvidersStore()

  // Form state
  const [specification, setSpecification] = useState('')
  const [name, setName] = useState('')
  const [language, setLanguage] = useState<string>('python')
  const [iterations, setIterations] = useState<number>(3)
  const [coders, setCoders] = useState<number>(2)
  const [testers, setTesters] = useState<number>(2)
  const [useEnhancement, setUseEnhancement] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(ENHANCEMENT_PREF_KEY)
      return stored === null ? true : stored === 'true'
    } catch {
      return true
    }
  })
  // КАО#VR-Wave1 Frontend — Visual Review settings toggles.
  const [skipVisualReview, setSkipVisualReview] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SKIP_VISUAL_REVIEW_PREF_KEY) === 'true'
    } catch {
      return false
    }
  })
  const [forceVisualReview, setForceVisualReview] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FORCE_VISUAL_REVIEW_PREF_KEY) === 'true'
    } catch {
      return false
    }
  })

  const [submitting, setSubmitting] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [submitError, setSubmitError] = useState<string | null>(null)

  // КАО#VR-Wave6 SpecAnalyzer — debounced copy of the specification so the
  // keyword scan runs at most ~3x/s while the user is typing. Snapshot is
  // re-evaluated when language changes too (synchronously, no debounce needed
  // for a single click on the Language select). `acknowledgedVisualWarning`
  // collapses the card to a small "i" hint after the user clicks "Keep
  // anyway" — kept in component state only (does NOT persist across sessions
  // by design, per Wave 6 spec).
  const [debouncedSpec, setDebouncedSpec] = useState<string>('')
  const [acknowledgedVisualWarning, setAcknowledgedVisualWarning] = useState<boolean>(false)

  useEffect(() => {
    fetchProviders()
  }, [fetchProviders])

  useEffect(() => {
    try {
      localStorage.setItem(ENHANCEMENT_PREF_KEY, String(useEnhancement))
    } catch {
      // ignore quota / privacy-mode errors
    }
  }, [useEnhancement])

  // КАО#VR-Wave1 Frontend — Visual Review: persist VR toggles.
  useEffect(() => {
    try {
      localStorage.setItem(SKIP_VISUAL_REVIEW_PREF_KEY, String(skipVisualReview))
    } catch {
      /* ignore */
    }
  }, [skipVisualReview])
  useEffect(() => {
    try {
      localStorage.setItem(FORCE_VISUAL_REVIEW_PREF_KEY, String(forceVisualReview))
    } catch {
      /* ignore */
    }
  }, [forceVisualReview])

  // КАО#VR-Wave6 SpecAnalyzer — 300ms debounce window so transient spec edits
  // don't thrash the warning card visibility (and so we don't scan the regex
  // on every single keystroke). The acknowledgment is reset whenever the spec
  // content materially changes — a new spec means the previous "Keep anyway"
  // decision was made under different conditions and shouldn't sticky-suppress
  // the warning.
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedSpec(specification), 300)
    return () => window.clearTimeout(id)
  }, [specification])

  // КАО#VR-Wave6 SpecAnalyzer — analyzeSpec is pure and cheap, but memoising
  // keeps re-renders stable and avoids recomputing the regex on unrelated
  // state changes (counter ticks, focus, etc.).
  const specAnalysis = useMemo(
    () => analyzeSpec(debouncedSpec, language),
    [debouncedSpec, language],
  )

  // КАО#VR-Wave6 SpecAnalyzer — reset the user's "Keep anyway" acknowledgment
  // whenever the underlying signal disappears (spec edited to remove keywords,
  // or language changed to a renderable one). This way the dismissed state
  // never leaks into a future situation where the warning genuinely no longer
  // applies — if the user re-introduces a visual spec on a non-browser
  // language later, they get a fresh warning instead of a silent "i" icon.
  useEffect(() => {
    if (!specAnalysis.suggestSwitch && acknowledgedVisualWarning) {
      setAcknowledgedVisualWarning(false)
    }
  }, [specAnalysis.suggestSwitch, acknowledgedVisualWarning])

  const specCharCount = specification.length
  const specRemaining = SPEC_MAX_CHARS - specCharCount

  const effectiveName = useMemo(() => {
    const trimmed = name.trim()
    return trimmed || autogenName(specification)
  }, [name, specification])

  // КАО#R14-FIX-02 (MEDIUM) — Disable Submit when form is invalid.
  // Previously `disabled={submitting}` only — users could click on an
  // invalid form and rely on the inline errors after the fact. Now the
  // button is visibly disabled until all required fields pass. Inline
  // field-level error messages (`fieldErrors`) continue to drive the
  // red-bordered states on individual inputs.
  const isFormValid = useMemo(() => {
    const trimmedSpec = specification.trim()
    if (trimmedSpec.length < SPEC_MIN_CHARS) return false
    if (trimmedSpec.length > SPEC_MAX_CHARS) return false
    if (!Number.isFinite(iterations) || iterations < 1 || iterations > 10) return false
    if (!Number.isFinite(coders) || coders < 1 || coders > 4) return false
    if (!Number.isFinite(testers) || testers < 1 || testers > 4) return false
    return true
  }, [specification, iterations, coders, testers])

  function validate(): FieldErrors {
    const errs: FieldErrors = {}
    const trimmedSpec = specification.trim()
    if (trimmedSpec.length === 0) {
      errs.specification = 'Specification is required.'
    } else if (trimmedSpec.length < SPEC_MIN_CHARS) {
      errs.specification = `Specification must be at least ${SPEC_MIN_CHARS} characters (currently ${trimmedSpec.length}).`
    } else if (trimmedSpec.length > SPEC_MAX_CHARS) {
      errs.specification = `Specification must be at most ${SPEC_MAX_CHARS} characters.`
    }
    if (!Number.isFinite(iterations) || iterations < 1 || iterations > 10) {
      errs.iterations = 'Iterations must be between 1 and 10.'
    }
    if (!Number.isFinite(coders) || coders < 1 || coders > 4) {
      errs.coders = 'Coders must be between 1 and 4.'
    }
    if (!Number.isFinite(testers) || testers < 1 || testers > 4) {
      errs.testers = 'Testers must be between 1 and 4.'
    }
    return errs
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (submitting) return

    const errs = validate()
    setFieldErrors(errs)
    if (Object.keys(errs).length > 0) return

    if (providers.length === 0) {
      setSubmitError(
        'No LLM providers are configured. Please add an API key in Settings before creating a session.',
      )
      return
    }

    const defaultProvider = providers.find((p) => p.configured) || providers[0]
    if (!defaultProvider) {
      setSubmitError('No LLM providers available. Please configure an API key in Settings.')
      return
    }

    const pickModel = (providerName: string): { provider: string; model: string } | null => {
      const provider = providers.find((p) => p.name === providerName && p.configured)
        || providers.find((p) => p.configured)
        || defaultProvider
      const model = provider?.models[0]
      if (!provider || !model) return null
      return { provider: provider.name, model }
    }

    const coderPick = pickModel('anthropic')
    const testerPick = pickModel('openai')
    const summarizerPick = coderPick
    const finalizerPick = coderPick
    if (!coderPick || !testerPick || !summarizerPick || !finalizerPick) {
      setSubmitError(
        'No models available from configured providers. Please refresh or add an API key in Settings.',
      )
      return
    }

    const agentConfigs: Partial<AgentConfig>[] = []
    for (let i = 0; i < coders; i++) {
      agentConfigs.push({
        agent_type: 'coder',
        agent_index: i,
        llm_provider: coderPick.provider as LLMProvider,
        llm_model: coderPick.model,
        max_tokens: 64000,
      })
    }
    for (let i = 0; i < testers; i++) {
      agentConfigs.push({
        agent_type: 'tester',
        agent_index: i,
        llm_provider: testerPick.provider as LLMProvider,
        llm_model: testerPick.model,
        max_tokens: 64000,
      })
    }
    agentConfigs.push({
      agent_type: 'summarizer',
      agent_index: 0,
      llm_provider: summarizerPick.provider as LLMProvider,
      llm_model: summarizerPick.model,
      max_tokens: 64000,
    })
    agentConfigs.push({
      agent_type: 'finalizer',
      agent_index: 0,
      llm_provider: finalizerPick.provider as LLMProvider,
      llm_model: finalizerPick.model,
      max_tokens: 64000,
    })

    const request: CreateSessionRequest = {
      name: effectiveName,
      specification: specification.trim(),
      language,
      max_iterations: iterations,
      enable_code_execution: true,
      execution_timeout: 60,
      max_fix_attempts: 3,
      auto_install_deps: true,
      agent_configs: agentConfigs,
      // num_coders/num_testers retained for parity with templates/demos consumers;
      // backend currently ignores them (agent_configs is authoritative).
      num_coders: coders,
      num_testers: testers,
      // КАО#VR-Wave1 Frontend — Visual Review: thread the per-session
      // visual-review preferences through the free-form `settings` blob.
      // Backend (VR-Backend agent) consumes these from session.settings.
      settings: {
        skip_visual_review: skipVisualReview,
        force_visual_review: forceVisualReview,
      },
    }

    setSubmitError(null)
    setSubmitting(true)
    try {
      const session = await createSession(request)
      notify.success('Session created')
      navigate(`/sessions/${session.id}`, { replace: true })
    } catch (err) {
      console.error(err)
      const msg = err instanceof Error ? err.message : 'Failed to create session.'
      setSubmitError(msg)
      notify.error('Failed to create session')
    } finally {
      setSubmitting(false)
    }
  }

  const inputBase =
    'w-full px-3 py-2 bg-cf-input border rounded-lg text-cf-text placeholder-cf-text-muted focus:outline-none focus:ring-2 focus:ring-cf-primary'
  const inputOk = `${inputBase} border-cf-border`
  const inputErr = `${inputBase} border-cf-error focus:ring-cf-error`

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-3xl mx-auto">
        <header className="mb-6">
          <h1 className="text-3xl font-bold text-cf-text mb-2">New Session</h1>
          <p className="text-cf-text-muted">
            Describe what you want the multi-agent pipeline to build. Fields marked with{' '}
            <span className="text-cf-error">*</span> are required.
          </p>
        </header>

        {!loaded && (
          <div className="flex items-center gap-2 text-cf-text-muted mb-4">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading provider info...</span>
          </div>
        )}

        {loaded && !hasAnyConfigured && (
          <div className="mb-4 rounded-lg border border-cf-warning/40 bg-cf-warning/10 px-4 py-3 text-sm text-cf-warning">
            No LLM providers are configured.{' '}
            <Link to="/settings" className="underline hover:text-cf-text dark:hover:text-white">
              Open Settings
            </Link>{' '}
            to add an API key before creating a session.
          </div>
        )}

        {submitError && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-cf-error/50 bg-cf-error/10 px-4 py-3"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-cf-error flex-shrink-0 mt-0.5" />
              <div className="flex-1">
                <div className="text-cf-error font-medium mb-1">Could not create session</div>
                <div className="text-sm text-cf-text-muted whitespace-pre-wrap">{submitError}</div>
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setSubmitError(null)}
                    className="px-3 py-1.5 bg-cf-primary hover:bg-cf-secondary text-white text-sm font-medium rounded-lg transition-colors"
                  >
                    Try again
                  </button>
                  <Link
                    to="/settings"
                    className="text-sm text-cf-text-muted hover:text-cf-text underline"
                  >
                    Go to Settings
                  </Link>
                </div>
              </div>
            </div>
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className="bg-cf-panel border border-cf-border rounded-xl p-6 space-y-5"
          noValidate
        >
          {/* Specification */}
          <div>
            {/* КАО#UX-9 — put a template entry point right next to the spec
                field (was only a link at the very bottom of the page). */}
            <div className="flex items-center justify-between mb-1">
              <label
                htmlFor="spec-input"
                className="block text-sm font-medium text-cf-text"
              >
                Specification <span className="text-cf-error">*</span>
              </label>
              <Link
                to="/sessions"
                className="inline-flex items-center gap-1 text-xs text-indigo-700 dark:text-cf-primary hover:text-cf-secondary transition-colors"
              >
                <LayoutTemplate className="w-3.5 h-3.5" />
                Start from a template
              </Link>
            </div>
            <textarea
              id="spec-input"
              autoFocus
              rows={10}
              value={specification}
              onChange={(e) => {
                setSpecification(e.target.value)
                if (fieldErrors.specification) {
                  setFieldErrors((prev) => ({ ...prev, specification: undefined }))
                }
              }}
              placeholder="Describe what you want the agents to build. The more concrete the spec (inputs, outputs, edge cases, examples), the better the result."
              maxLength={SPEC_MAX_CHARS}
              className={`${fieldErrors.specification ? inputErr : inputOk} font-mono text-sm resize-y`}
              aria-invalid={Boolean(fieldErrors.specification)}
              aria-describedby="spec-help spec-error"
            />
            <div className="flex items-center justify-between mt-1">
              <div className="text-xs">
                {fieldErrors.specification ? (
                  <span id="spec-error" className="text-cf-error">
                    {fieldErrors.specification}
                  </span>
                ) : (
                  <span id="spec-help" className="text-cf-text-muted">
                    Minimum {SPEC_MIN_CHARS} characters.
                  </span>
                )}
              </div>
              <div
                className={`text-xs tabular-nums ${specRemaining < 0 ? 'text-cf-error' : 'text-cf-text-muted'}`}
                aria-live="polite"
              >
                {specCharCount.toLocaleString()} / {SPEC_MAX_CHARS.toLocaleString()}
              </div>
            </div>
          </div>

          {/* Language — part of the specification (what to build, in what language).
              Moved up next to Specification per user request: language is a
              requirement, not a setting. */}
          <div>
            <label
              htmlFor="lang-select"
              className="block text-sm font-medium text-cf-text mb-1"
            >
              Language
            </label>
            <select
              id="lang-select"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className={inputOk}
              aria-describedby="lang-help"
            >
              {LANGUAGE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            {/* КАО#UX-5 — explain what the "(Browser)" / HTML variants actually do.
                Cold users can't tell why they'd pick one; the Browser variants run
                in a headless Chromium so agents can screenshot + visually review. */}
            <p id="lang-help" className="mt-1 text-xs text-cf-text-muted">
              Browser / HTML variants run in a headless browser so agents can capture
              screenshots and run visual review. Pick one for anything with a UI,
              canvas, animation, or graphics.
            </p>

            {/* КАО#VR-Wave6 SpecAnalyzer — Visual-spec / non-browser-language warning.
                Shown when the debounced spec contains visual keywords but the
                selected language can't render in the headless browser sandbox.
                Collapses to a small "i" hint after the user clicks "Keep anyway"
                so we don't keep nagging — but the small hint stays visible so
                the user remembers why their session has no screenshots. */}
            {specAnalysis.suggestSwitch && !acknowledgedVisualWarning && (
              <div
                data-testid="visual-warning-card"
                role="status"
                className="mt-3 rounded-lg border border-cf-warning/50 bg-cf-warning/10 px-4 py-3 text-sm text-cf-warning"
              >
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="flex-1 space-y-2">
                    <div className="font-medium">
                      Visual spec detected
                      {specAnalysis.matchedKeywords.length > 0 && (
                        <span className="font-normal">
                          {' '}
                          (keywords:{' '}
                          {specAnalysis.matchedKeywords
                            .slice(0, 4)
                            .map((k) => `"${k}"`)
                            .join(', ')}
                          {specAnalysis.matchedKeywords.length > 4 ? ', ...' : ''}
                          )
                        </span>
                      )}
                      , but selected language{' '}
                      <span className="font-mono">"{language}"</span> can't render
                      visually.
                    </div>
                    <div className="text-cf-warning/90">
                      Visual Review won't trigger; you'll get text-only output.
                      Consider switching to JavaScript (Browser) so the sandbox
                      can capture screenshots.
                    </div>
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        data-testid="visual-warning-switch-btn"
                        onClick={() => {
                          setLanguage('javascript_browser')
                          setAcknowledgedVisualWarning(false)
                        }}
                      >
                        Switch to JavaScript (Browser)
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setAcknowledgedVisualWarning(true)}
                      >
                        Keep {language} anyway
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* КАО#VR-Wave6 SpecAnalyzer — collapsed "i" hint after dismissal.
                Lives in component state only — a fresh page load (or any spec
                change that re-introduces the situation) brings the full card
                back. */}
            {specAnalysis.suggestSwitch && acknowledgedVisualWarning && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-cf-warning/80">
                <Info className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                <span>
                  Visual spec on non-browser language — no screenshots will be
                  captured.
                </span>
                <button
                  type="button"
                  onClick={() => setAcknowledgedVisualWarning(false)}
                  className="underline hover:text-cf-warning"
                >
                  Show details
                </button>
              </div>
            )}
          </div>

          {/* Name */}
          <div>
            <label
              htmlFor="name-input"
              className="block text-sm font-medium text-cf-text mb-1"
            >
              Name <span className="text-cf-text-muted text-xs">(optional)</span>
            </label>
            <input
              id="name-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={255}
              placeholder={autogenName(specification)}
              className={inputOk}
            />
            <p className="mt-1 text-xs text-cf-text-muted">
              Leave blank to auto-generate from the first words of the specification.
            </p>
          </div>

          {/* КАО#UX-9 — group the power-user controls (agent counts, enhancement
              & visual-review toggles) under a labelled disclosure so first-timers
              see a calmer form. Open by default: nothing is hidden on load (no
              degradation, all fields remain reachable) — users may collapse it. */}
          <details open className="group/adv border border-cf-border rounded-lg">
            <summary className="cursor-pointer select-none px-3 py-2.5 text-sm font-medium text-cf-text flex items-center gap-2 list-none [&::-webkit-details-marker]:hidden">
              <ChevronRight className="w-4 h-4 text-cf-text-muted transition-transform group-open/adv:rotate-90" />
              Advanced settings
              <span className="text-xs text-cf-text-muted font-normal">agent counts, enhancement &amp; visual review</span>
            </summary>
            <div className="px-3 pb-4 pt-1 space-y-5">
          {/* Numeric row: iterations / coders / testers */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label
                htmlFor="iter-input"
                className="block text-sm font-medium text-cf-text mb-1"
              >
                Iterations
              </label>
              <input
                id="iter-input"
                type="number"
                min={1}
                max={10}
                value={iterations}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  setIterations(Number.isFinite(v) ? v : 0)
                  if (fieldErrors.iterations) {
                    setFieldErrors((prev) => ({ ...prev, iterations: undefined }))
                  }
                }}
                className={fieldErrors.iterations ? inputErr : inputOk}
                aria-invalid={Boolean(fieldErrors.iterations)}
                aria-describedby={fieldErrors.iterations ? 'iter-error' : 'iter-help'}
              />
              {fieldErrors.iterations ? (
                <p id="iter-error" className="mt-1 text-xs text-cf-error">{fieldErrors.iterations}</p>
              ) : (
                <p id="iter-help" className="mt-1 text-xs text-cf-text-muted">1–10 (default 3)</p>
              )}
            </div>
            <div>
              <label
                htmlFor="coders-input"
                className="block text-sm font-medium text-cf-text mb-1"
              >
                Coders
              </label>
              <input
                id="coders-input"
                type="number"
                min={1}
                max={4}
                value={coders}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  setCoders(Number.isFinite(v) ? v : 0)
                  if (fieldErrors.coders) {
                    setFieldErrors((prev) => ({ ...prev, coders: undefined }))
                  }
                }}
                className={fieldErrors.coders ? inputErr : inputOk}
                aria-invalid={Boolean(fieldErrors.coders)}
                aria-describedby={fieldErrors.coders ? 'coders-error' : 'coders-help'}
              />
              {fieldErrors.coders ? (
                <p id="coders-error" className="mt-1 text-xs text-cf-error">{fieldErrors.coders}</p>
              ) : (
                <p id="coders-help" className="mt-1 text-xs text-cf-text-muted">1–4 (default 2)</p>
              )}
            </div>
            <div>
              <label
                htmlFor="testers-input"
                className="block text-sm font-medium text-cf-text mb-1"
              >
                Testers
              </label>
              <input
                id="testers-input"
                type="number"
                min={1}
                max={4}
                value={testers}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  setTesters(Number.isFinite(v) ? v : 0)
                  if (fieldErrors.testers) {
                    setFieldErrors((prev) => ({ ...prev, testers: undefined }))
                  }
                }}
                className={fieldErrors.testers ? inputErr : inputOk}
                aria-invalid={Boolean(fieldErrors.testers)}
                aria-describedby={fieldErrors.testers ? 'testers-error' : 'testers-help'}
              />
              {fieldErrors.testers ? (
                <p id="testers-error" className="mt-1 text-xs text-cf-error">{fieldErrors.testers}</p>
              ) : (
                <p id="testers-help" className="mt-1 text-xs text-cf-text-muted">1–4 (default 2)</p>
              )}
            </div>
          </div>

          {/* Enhancement pipeline */}
          <div className="flex items-start gap-3">
            <input
              id="enhancement-checkbox"
              type="checkbox"
              checked={useEnhancement}
              onChange={(e) => setUseEnhancement(e.target.checked)}
              className="mt-1 h-4 w-4 rounded border-cf-border bg-cf-input text-cf-primary focus:ring-cf-primary"
            />
            <label htmlFor="enhancement-checkbox" className="text-sm text-cf-text">
              Use enhancement pipeline
              <span className="block text-xs text-cf-text-muted mt-0.5">
                After the initial run completes, offer suggestions to enhance the result.
              </span>
            </label>
          </div>

          {/* КАО#VR-Wave1 Frontend — Visual Review preferences. */}
          <div className="flex items-start gap-3">
            <input
              id="skip-visual-review-checkbox"
              type="checkbox"
              checked={skipVisualReview}
              onChange={(e) => {
                setSkipVisualReview(e.target.checked)
                // Mutually exclusive with force — flipping one clears the other.
                if (e.target.checked) setForceVisualReview(false)
              }}
              className="mt-1 h-4 w-4 rounded border-cf-border bg-cf-input text-cf-primary focus:ring-cf-primary"
            />
            <label htmlFor="skip-visual-review-checkbox" className="text-sm text-cf-text">
              Skip visual review (auto-finalize without user input)
              <span className="block text-xs text-cf-text-muted mt-0.5">
                Don't pause to ask you to score candidate code versions; let the AI pick.
              </span>
            </label>
          </div>

          <div className="flex items-start gap-3">
            <input
              id="force-visual-review-checkbox"
              type="checkbox"
              checked={forceVisualReview}
              onChange={(e) => {
                setForceVisualReview(e.target.checked)
                if (e.target.checked) setSkipVisualReview(false)
              }}
              className="mt-1 h-4 w-4 rounded border-cf-border bg-cf-input text-cf-primary focus:ring-cf-primary"
            />
            <label htmlFor="force-visual-review-checkbox" className="text-sm text-cf-text">
              Force visual review (even for non-visual specs)
              <span className="block text-xs text-cf-text-muted mt-0.5">
                Always pause for review before finalizing, even when no UI is detected.
              </span>
            </label>
          </div>

            </div>
          </details>

          {/* КАО#UX-10 — run-scale / cost preview before launch. The exact spend
              depends on spec size and the models each agent uses, so this is a
              deliberately ROUGH band over the number of agent passes the run will
              execute — enough to set expectations, not a billing promise. */}
          {iterations >= 1 && coders >= 1 && testers >= 1 && (() => {
            const passes = iterations * (coders + testers + 1) + 1 // +1/iter summarizer, +1 finalizer
            const low = (passes * 0.04).toFixed(2)
            const high = (passes * 0.18).toFixed(2)
            return (
              <div className="rounded-lg border border-cf-border bg-cf-bg/60 px-3 py-2.5 flex items-start gap-2.5">
                <Gauge className="w-4 h-4 text-cf-primary mt-0.5 shrink-0" />
                <div className="text-xs text-cf-text-muted leading-relaxed">
                  <span className="text-cf-text font-medium">Run preview:</span>{' '}
                  ~{passes} agent passes ({iterations} iteration{iterations === 1 ? '' : 's'} ×{' '}
                  {coders} coder{coders === 1 ? '' : 's'} + {testers} tester{testers === 1 ? '' : 's'} + a
                  summarizer, then 1 finalizer). Rough cost{' '}
                  <span className="text-cf-text font-medium">${low}–${high}</span> — actuals depend on
                  spec size and the models your agents use.
                </div>
              </div>
            )
          })()}

          {/* Submit */}
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              // КАО#R14-FIX-02 (MEDIUM) — gate on isFormValid in addition to submitting.
              disabled={submitting || !isFormValid}
              className="flex items-center gap-2 px-4 py-2 bg-cf-primary hover:bg-cf-secondary disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg transition-colors"
            >
              {submitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Save className="w-4 h-4" />
              )}
              {submitting ? 'Creating session...' : 'Create session'}
            </button>
            <button
              type="button"
              onClick={() => navigate('/sessions')}
              disabled={submitting}
              className="px-4 py-2 text-cf-text-muted hover:text-cf-text text-sm rounded-lg transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </form>

        {/* Secondary actions — templates flow lives on the Sessions list page
            (Templates panel + Apply dialog in SessionsPage.tsx). */}
        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Link
            to="/sessions"
            className="inline-flex items-center gap-1.5 text-indigo-700 dark:text-cf-primary hover:text-cf-secondary transition-colors"
          >
            <LayoutTemplate className="w-4 h-4" />
            Try a template
          </Link>
        </div>
      </div>
    </div>
  )
}
