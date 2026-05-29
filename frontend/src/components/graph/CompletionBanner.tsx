import { CheckCircle2, Sparkles, Trophy, Code, ListChecks } from 'lucide-react'

// VR-46 — "generation finished" status strip, shown under the session header
// (symmetric to the running-only Progress bar in SessionDetailPage). It gives a
// clear, positive signal for the post-finalization states where the pipeline
// has stopped and the user must decide what to do next. Previously these states
// were only hinted at by the small "Awaiting Enhancement" badge in the
// MetricsPanel, and the Final Code node misleadingly showed "Waiting…".
//
// Renders for awaiting_enhancement / awaiting_enhancement_review / completed and
// nothing otherwise (active phases pulse their nodes; errors are out of scope).

interface CompletionBannerProps {
  status: string
  /** Open the Final Result side panel (same action as the header "View Result"). */
  onViewResult: () => void
  /** Open the enhancement review panel (same action as header "View Enhancements"). */
  onReview: () => void
  /** Disable the CTA while an action is in flight. */
  busy?: boolean
}

type Tone = 'emerald' | 'amber'

interface BannerSpec {
  tone: Tone
  Icon: typeof CheckCircle2
  headline: string
  sub: string
  ctaLabel: string
  CtaIcon: typeof CheckCircle2
  ctaAction: 'view' | 'review'
}

function specFor(status: string): BannerSpec | null {
  switch (status) {
    case 'awaiting_enhancement':
      return {
        tone: 'emerald',
        Icon: CheckCircle2,
        headline: 'Code generation complete',
        sub: 'The final code is ready — view or run it, launch Enhancement, or Skip & Complete.',
        ctaLabel: 'View Result',
        CtaIcon: Code,
        ctaAction: 'view',
      }
    case 'awaiting_enhancement_review':
      return {
        tone: 'amber',
        Icon: Sparkles,
        headline: 'Enhancement analysis ready',
        sub: 'Review the suggested improvements, then apply or skip them.',
        ctaLabel: 'Review Suggestions',
        CtaIcon: ListChecks,
        ctaAction: 'review',
      }
    case 'completed':
      return {
        tone: 'emerald',
        Icon: Trophy,
        headline: 'Workflow complete',
        sub: 'The final code is ready — view, run, or download it.',
        ctaLabel: 'View Result',
        CtaIcon: Code,
        ctaAction: 'view',
      }
    default:
      return null
  }
}

const TONES: Record<Tone, { bar: string; icon: string; head: string; btn: string }> = {
  emerald: {
    bar: 'bg-emerald-500/10 border-emerald-500/30',
    icon: 'text-emerald-400',
    head: 'text-emerald-300',
    btn: 'bg-emerald-600 hover:bg-emerald-700',
  },
  amber: {
    bar: 'bg-amber-500/10 border-amber-500/30',
    icon: 'text-amber-400',
    head: 'text-amber-300',
    btn: 'bg-amber-600 hover:bg-amber-700',
  },
}

export default function CompletionBanner({ status, onViewResult, onReview, busy }: CompletionBannerProps) {
  const spec = specFor(status)
  if (!spec) return null

  const tone = TONES[spec.tone]
  const { Icon, CtaIcon } = spec

  return (
    <div
      className={`flex items-center gap-3 px-4 py-2.5 border-b ${tone.bar} flex-shrink-0`}
      role="status"
      aria-live="polite"
      data-testid="completion-banner"
      data-status={status}
    >
      <Icon className={`w-5 h-5 flex-shrink-0 ${tone.icon}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold ${tone.head}`}>{spec.headline}</div>
        <div className="text-xs text-gray-300 truncate">{spec.sub}</div>
      </div>
      <button
        type="button"
        onClick={spec.ctaAction === 'view' ? onViewResult : onReview}
        disabled={busy}
        className={`flex items-center gap-2 px-3 py-1.5 text-white text-sm rounded-lg transition-colors disabled:opacity-50 flex-shrink-0 ${tone.btn}`}
      >
        <CtaIcon className="w-4 h-4" aria-hidden="true" />
        {spec.ctaLabel}
      </button>
    </div>
  )
}
