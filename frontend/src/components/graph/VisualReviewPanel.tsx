// КАО#VR-Wave1 Frontend — Visual Review
// Side-panel that appears when the orchestrator pauses at
// `awaiting_visual_review` and asks the user to score candidate code versions
// visually (screenshot strips + optional live iframe preview). Two render
// modes:
//   • N ≤ 4 — linear "score each candidate 0-10" (slider per candidate)
//   • N ≥ 5 — pairwise Tournament mode (stubbed; calls onComplete with ranked
//             ids that we convert back to 0-10 scores).
//
// Auto-open is wired in SessionDetailPage via pushPanel('visualReview') when
// session.status flips to 'awaiting_visual_review'.
import { useEffect, useMemo, useState } from 'react'
import {
  X,
  Loader2,
  Play,
  HelpCircle,
  ImageIcon,
  AlertTriangle,
  CheckCircle2,
  SkipForward,
} from 'lucide-react'
import notify from '../common/StyledToast'
import Modal from '../common/Modal'
import Button from '../common/Button'
import {
  getVisualReview,
  submitVisualReviewScores,
  skipVisualReview,
  type VisualReviewScore,
} from '../../services/api'
import type { VisualReviewCandidate, CodeVersionScreenshot } from '../../types'
// КАО#VR-Wave2 Tournament — Wave-1 had an inline stub; Wave-2 swaps in the
// real pairwise Elo tournament component.
import TournamentMode from './TournamentMode'

// ---------------------------------------------------------------------------
// Mock data — drives the panel when the URL contains ?mock_visual_review=1 so
// frontend devs can preview without the backend deployed (Task 4).
// ---------------------------------------------------------------------------
function buildMockCandidates(count = 2): VisualReviewCandidate[] {
  const models = ['claude-sonnet-4-5', 'gpt-4o', 'gemini-2.5-pro', 'grok-2', 'llama-3.3']
  return Array.from({ length: count }).map((_, i) => ({
    code_version_id: `mock-cv-${i}`,
    coder_index: i,
    llm_model: models[i % models.length],
    screenshots: Array.from({ length: 5 }).map((__, fi) => ({
      id: `mock-shot-${i}-${fi}`,
      code_version_id: `mock-cv-${i}`,
      frame_index: fi,
      t_seconds: fi * 0.5,
      image_url: `https://picsum.photos/seed/vr-${i}-${fi}/200/150`,
      width: 200,
      height: 150,
    })),
    user_score: null,
    vision_llm_score: 6 + ((i * 1.3) % 3),
    issues_count: i % 2,
  }))
}

// ---------------------------------------------------------------------------
// Screenshot strip — horizontal row of thumbnails with click-to-zoom.
// ---------------------------------------------------------------------------
function ScreenshotStrip({
  shots,
  onOpen,
}: {
  shots: CodeVersionScreenshot[]
  onOpen: (shot: CodeVersionScreenshot) => void
}) {
  if (shots.length === 0) {
    return (
      <div className="flex items-center justify-center h-24 rounded-md border border-dashed border-cf-border text-cf-text-muted text-xs">
        <ImageIcon className="w-4 h-4 mr-2" /> No screenshots
      </div>
    )
  }
  return (
    <div className="flex gap-2 overflow-x-auto py-1 -mx-1 px-1">
      {shots.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={() => onOpen(s)}
          className="shrink-0 group relative rounded-md overflow-hidden border border-cf-border hover:border-cf-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-cf-primary transition-colors"
          title={`Frame ${s.frame_index + 1} @ ${s.t_seconds.toFixed(1)}s`}
        >
          <img
            src={s.image_url}
            alt={`Frame ${s.frame_index + 1}`}
            width={s.width}
            height={s.height}
            className="block w-28 h-20 object-cover bg-black/30"
            loading="lazy"
          />
          <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[10px] text-white px-1 py-0.5 leading-none">
            {s.t_seconds.toFixed(1)}s
          </span>
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live preview slideshow (КАО#VR-25)
// ---------------------------------------------------------------------------
//
// Earlier versions tried to embed the candidate's HTML in a live `<iframe>`.
// That had three failure modes user feedback caught:
//   1. "Only one frame, no Live" — iframe is static; the candidate's own JS
//      runs but for gated demos (Coder 3's Press-Play flow) all the user
//      sees is the menu.
//   2. Iframe contents disagree with screenshot strip — screenshots use the
//      sandbox auto-click logic (КАО#VR-24) so they show the running demo;
//      iframe lacks it.
//   3. Iframe clips when the candidate's page is taller than the modal.
//
// New design: cycle through the 5 captured PNG screenshots at the same
// wall-clock cadence they were captured at (0.5s → 2s → 5s → 8s → 12s).
// Properties:
//   - Looks like an animated demo of the candidate (≈12 second loop).
//   - Image-only, so no X-Frame-Options / no iframe sandbox surface area.
//   - 1280×720 PNGs fit any modal via object-fit:contain — no clipping.
//   - Identical content to what the human reviewer sees in the score strip,
//     so "Live preview" is now a literal blow-up of that data.
function LivePreviewSlideshow({ candidate }: { candidate: VisualReviewCandidate }) {
  const shots = useMemo(
    () => [...candidate.screenshots].sort((a, b) => a.frame_index - b.frame_index),
    [candidate.screenshots],
  )
  const [idx, setIdx] = useState(0)
  const [playing, setPlaying] = useState(true)

  // КАО#VR-25 — schedule each frame to fire after (next.t - current.t)
  // seconds. The loop wraps back to frame 0 with a 1s pause that signals
  // the restart visually. Manual nav (prev/next/pause) immediately
  // overrides the scheduled timer.
  useEffect(() => {
    if (!playing || shots.length <= 1) return
    const cur = shots[idx]
    const next = shots[(idx + 1) % shots.length]
    // Wrap interval = 1s; otherwise the gap between this frame and the
    // next (or, for the wrap, frame 0). Clamp to [0.3s, 4s] so the demo
    // doesn't feel jerky for tight clusters or stall for outliers.
    let waitMs: number
    if (idx === shots.length - 1) {
      waitMs = 1000  // wrap pause
    } else {
      const gap = (next.t_seconds - cur.t_seconds) * 1000
      waitMs = Math.max(300, Math.min(4000, gap))
    }
    const t = setTimeout(() => setIdx((i) => (i + 1) % shots.length), waitMs)
    return () => clearTimeout(t)
  }, [idx, playing, shots])

  if (shots.length === 0) {
    return (
      <div className="flex items-center justify-center w-full h-full text-cf-text-muted">
        <ImageIcon className="w-5 h-5 mr-2" />
        <span className="text-sm">No screenshots captured</span>
      </div>
    )
  }

  const current = shots[idx]
  return (
    <div className="flex flex-col w-full h-full bg-black">
      <div className="flex-1 flex items-center justify-center overflow-hidden">
        <img
          src={current.image_url}
          alt={`Frame ${current.frame_index + 1}`}
          className="max-w-full max-h-full object-contain"
        />
      </div>
      <div className="flex items-center justify-between gap-3 px-3 py-2 bg-black/60 text-white text-xs">
        <span>
          Frame {current.frame_index + 1} / {shots.length}
          {' · '}
          t={current.t_seconds.toFixed(1)}s
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="px-2 py-0.5 rounded hover:bg-white/10"
            onClick={() => setIdx((i) => (i - 1 + shots.length) % shots.length)}
          >
            ◀ Prev
          </button>
          <button
            type="button"
            className="px-2 py-0.5 rounded hover:bg-white/10"
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button
            type="button"
            className="px-2 py-0.5 rounded hover:bg-white/10"
            onClick={() => setIdx((i) => (i + 1) % shots.length)}
          >
            Next ▶
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------
export interface VisualReviewPanelProps {
  sessionId: string
  /** Closes the panel without submitting; SessionDetailPage clears side-panel state. */
  onClose: () => void
  /** Called after a successful submit so the parent can refresh session status. */
  onSubmitted?: () => void
  /** Called after a successful skip; same parent refresh hook. */
  onSkipped?: () => void
  /** When true, ignore the API and render with mock data. */
  forceMock?: boolean
}

export default function VisualReviewPanel({
  sessionId,
  onClose,
  onSubmitted,
  onSkipped,
  forceMock,
}: VisualReviewPanelProps) {
  // КАО#VR-Wave1 Frontend — Visual Review: detect mock mode from URL or prop.
  const isMock = useMemo(() => {
    if (forceMock) return true
    try {
      const params = new URLSearchParams(window.location.search)
      return params.get('mock_visual_review') === '1'
    } catch {
      return false
    }
  }, [forceMock])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<VisualReviewCandidate[]>([])
  // VR-41 — surface "N of M coders failed" warning when some coder agents
  // didn't produce screenshots (LLM timeouts, parse errors, etc.).
  const [totalConfiguredCoders, setTotalConfiguredCoders] = useState<number>(0)
  const [missingCoderIndices, setMissingCoderIndices] = useState<number[]>([])
  // code_version_id → user score 0-10 (or null)
  const [scores, setScores] = useState<Record<string, number | null>>({})
  const [zoomShot, setZoomShot] = useState<CodeVersionScreenshot | null>(null)
  const [livePreview, setLivePreview] = useState<{ candidate: VisualReviewCandidate } | null>(null)
  const [showTournament, setShowTournament] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [showHelp, setShowHelp] = useState(false)

  // Initial load.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const load = async () => {
      try {
        const data = isMock
          ? { candidates: buildMockCandidates(2) }
          : await getVisualReview(sessionId)
        if (cancelled) return
        setCandidates(data.candidates)
        setTotalConfiguredCoders(data.total_configured_coders ?? data.candidates.length)
        setMissingCoderIndices(data.missing_coder_indices ?? [])
        // Seed scores with any backend-provided user_score (so re-opens preserve input).
        const seed: Record<string, number | null> = {}
        for (const c of data.candidates) {
          seed[c.code_version_id] = typeof c.user_score === 'number' ? c.user_score : null
        }
        setScores(seed)
      } catch (err) {
        if (cancelled) return
        const msg = err instanceof Error ? err.message : 'Failed to load visual review'
        setError(msg)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    return () => {
      cancelled = true
    }
  }, [sessionId, isMock])

  // КАО#VR-Wave1 Frontend — Visual Review: derive submit eligibility. We
  // require every candidate to have a non-null score (no half-completed
  // rankings reaching the backend).
  const allScored = useMemo(
    () => candidates.length > 0 && candidates.every(c => typeof scores[c.code_version_id] === 'number'),
    [candidates, scores],
  )

  const handleScoreChange = (codeVersionId: string, raw: number) => {
    const clamped = Math.max(0, Math.min(10, raw))
    setScores(prev => ({ ...prev, [codeVersionId]: clamped }))
  }

  const handleSubmit = async () => {
    // КАО#VR-34 — if the user didn't touch a slider, the visual default
    // ("5") is what they're submitting. Use 5.0 as the implicit score for
    // any unscored candidate instead of refusing to submit. No more
    // "please score Coder N" guard — slider position IS the answer.
    setSubmitting(true)
    try {
      const payload: VisualReviewScore[] = candidates.map(c => {
        const s = scores[c.code_version_id]
        return {
          code_version_id: c.code_version_id,
          score: typeof s === 'number' ? s : 5,
        }
      })
      if (isMock) {
        notify.success(`Mock: would submit ${payload.length} scores`)
      } else {
        await submitVisualReviewScores(sessionId, payload)
        notify.success('Scores submitted')
      }
      onSubmitted?.()
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to submit scores'
      notify.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  const handleSkip = async () => {
    setSubmitting(true)
    try {
      if (isMock) {
        notify.success('Mock: would skip visual review')
      } else {
        await skipVisualReview(sessionId)
        notify.success('Skipped — AI will decide')
      }
      onSkipped?.()
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to skip'
      notify.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  // Tournament mode → convert ranked IDs to 0-10 scores (winner = 10, loser ~ 1).
  const handleTournamentComplete = (rankedIds: string[]) => {
    if (rankedIds.length === 0) return
    const step = rankedIds.length > 1 ? 9 / (rankedIds.length - 1) : 0
    const next: Record<string, number | null> = { ...scores }
    rankedIds.forEach((id, idx) => {
      next[id] = Number((10 - idx * step).toFixed(1))
    })
    setScores(next)
    setShowTournament(false)
    notify.success('Rankings applied — review and submit')
  }

  // КАО#VR-Wave1 Frontend — Visual Review: choose linear vs tournament UI.
  const useTournament = candidates.length >= 5

  return (
    <div className="w-[560px] bg-cf-panel border-l border-cf-border flex flex-col h-full animate-slideIn">
      {/* Header */}
      <div className="p-4 border-b border-cf-border flex items-center justify-between bg-cf-panel/80 backdrop-blur-sm sticky top-0 z-10 flex-shrink-0">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-cf-text flex items-center gap-2">
            <span aria-hidden="true">🎨</span>
            Visual Review
            {isMock && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-cf-warning/20 text-cf-warning border border-cf-warning/40">
                Mock
              </span>
            )}
          </h3>
          <p className="text-xs text-cf-text-muted mt-0.5">Choose your favorite — score each 0–10</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-2 hover:bg-cf-hover rounded-lg transition-colors"
          aria-label="Close visual review"
        >
          <X className="w-5 h-5 text-cf-text-muted" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {loading && (
          <div className="flex items-center justify-center h-40">
            <Loader2 className="w-6 h-6 animate-spin text-cf-primary" />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-lg border border-cf-error/40 bg-cf-error/10 p-4 text-sm text-cf-error flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium">Failed to load candidates</div>
              <div className="text-xs text-cf-text-muted mt-1">{error}</div>
            </div>
          </div>
        )}

        {!loading && !error && candidates.length === 0 && (
          <div className="rounded-lg border border-cf-border bg-cf-panel/60 p-4 text-sm text-cf-text-muted text-center">
            No candidates available for visual review.
          </div>
        )}

        {/* VR-41 — warning banner when some configured coders are missing
            (their LLM timed out, parse failed, etc.). Helps the user
            understand why the preview has fewer variants than expected. */}
        {!loading && !error && candidates.length > 0 && missingCoderIndices.length > 0 && totalConfiguredCoders > 0 && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-400" />
            <div className="flex-1 min-w-0">
              <div className="font-medium text-amber-100">
                Showing {candidates.length} of {totalConfiguredCoders} coders
              </div>
              <div className="mt-1 text-amber-300/80">
                Coder{missingCoderIndices.length === 1 ? '' : 's'}{' '}
                {missingCoderIndices.map(i => i + 1).join(', ')}{' '}
                didn't produce a previewable result (LLM timeout or error). The remaining
                {candidates.length === 1 ? ' variant is' : ' variants are'} still scored normally —
                the missing one{missingCoderIndices.length === 1 ? '' : 's'} can be retried in the next iteration.
              </div>
            </div>
          </div>
        )}

        {!loading && !error && candidates.length > 0 && useTournament && !showTournament && (
          <div className="rounded-lg border border-cf-border bg-cf-panel/60 p-3 text-xs text-cf-text-muted flex items-center justify-between gap-2">
            <span>
              {candidates.length} candidates — too many for linear scoring. Use Tournament mode.
            </span>
            <Button size="sm" variant="primary" onClick={() => setShowTournament(true)}>
              Start tournament
            </Button>
          </div>
        )}

        {!loading && !error && showTournament && (
          // КАО#VR-Wave2 Tournament — pass mock + sessionId so live-preview
          // iframe URLs match the linear-mode behaviour.
          <TournamentMode
            candidates={candidates}
            onComplete={handleTournamentComplete}
            onCancel={() => setShowTournament(false)}
            isMock={isMock}
            sessionId={sessionId}
          />
        )}

        {!loading && !error && candidates.length > 0 && (
          <div className="space-y-4">
            {/* КАО#VR-34 — sort by coder_index ASC so cards render
                Coder 1 / 2 / 3 top-to-bottom, regardless of DB insert order. */}
            {[...candidates].sort((a, b) => a.coder_index - b.coder_index).map((c, idx) => {
              const score = scores[c.code_version_id]
              const issueLabel =
                typeof c.issues_count === 'number'
                  ? c.issues_count === 0
                    ? '0 issues'
                    : `${c.issues_count} issue${c.issues_count === 1 ? '' : 's'} found`
                  : null
              return (
                <div
                  key={c.code_version_id}
                  className="rounded-xl border border-cf-border bg-cf-panel/60 p-3 space-y-3"
                >
                  {/* Label row */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm font-medium text-cf-text">Coder {c.coder_index + 1}</span>
                      <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-cf-primary/15 text-indigo-700 dark:text-cf-primary border border-indigo-300 dark:border-cf-primary/30 truncate max-w-[180px]" title={c.llm_model}>
                        {c.llm_model}
                      </span>
                    </div>
                    {issueLabel && (
                      <span
                        className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${
                          (c.issues_count ?? 0) === 0
                            ? 'bg-cf-success/15 text-cf-success border-cf-success/30'
                            : 'bg-cf-warning/15 text-cf-warning border-cf-warning/30'
                        }`}
                      >
                        {issueLabel}
                      </span>
                    )}
                  </div>

                  {/* Screenshots */}
                  <ScreenshotStrip
                    shots={c.screenshots}
                    onOpen={setZoomShot}
                  />

                  {/* Live preview button */}
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      leadingIcon={<Play className="w-3.5 h-3.5" />}
                      onClick={() => setLivePreview({ candidate: c })}
                    >
                      Live preview
                    </Button>
                    {typeof c.vision_llm_score === 'number' && (
                      <span className="text-[11px] text-cf-text-muted">
                        Vision LLM: <span className="text-cf-text">{c.vision_llm_score.toFixed(1)}/10</span>
                      </span>
                    )}
                  </div>

                  {/* Score slider */}
                  <div>
                    <label
                      htmlFor={`vr-score-${idx}`}
                      className="flex items-center justify-between text-xs text-cf-text-muted mb-1"
                    >
                      <span>Your score</span>
                      <span className="tabular-nums text-cf-text font-medium">
                        {/* КАО#VR-34 — show slider position even when score
                            state is null. The slider already visually sits at
                            5 by default; matching the label with "5.0" avoids
                            the misleading "—" that suggested no score yet. */}
                        {typeof score === 'number' ? score.toFixed(1) : '5.0'} / 10
                      </span>
                    </label>
                    <input
                      id={`vr-score-${idx}`}
                      type="range"
                      min={0}
                      max={10}
                      step={0.5}
                      value={typeof score === 'number' ? score : 5}
                      onChange={e => handleScoreChange(c.code_version_id, parseFloat(e.target.value))}
                      className="w-full accent-cf-primary cursor-pointer"
                      aria-label={`Score candidate from Coder ${c.coder_index + 1}`}
                    />
                    <div className="flex justify-between text-[10px] text-cf-text-muted mt-0.5">
                      <span>0</span>
                      <span>5</span>
                      <span>10</span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-cf-border bg-cf-panel/80 backdrop-blur-sm p-3 flex items-center gap-2 flex-shrink-0">
        <Button
          variant="primary"
          size="md"
          disabled={loading || submitting || candidates.length === 0}
          loading={submitting && allScored}
          leadingIcon={<CheckCircle2 className="w-4 h-4" />}
          onClick={handleSubmit}
        >
          Submit ranking
        </Button>
        <Button
          variant="ghost"
          size="md"
          disabled={submitting}
          leadingIcon={<SkipForward className="w-4 h-4" />}
          onClick={handleSkip}
        >
          Skip — let AI decide
        </Button>
        <button
          type="button"
          onClick={() => setShowHelp(true)}
          className="ml-auto flex items-center gap-1 text-xs text-cf-text-muted hover:text-cf-text transition-colors"
        >
          <HelpCircle className="w-3.5 h-3.5" />
          How does this work?
        </button>
      </div>

      {/* Zoomed screenshot modal */}
      <Modal
        open={!!zoomShot}
        onClose={() => setZoomShot(null)}
        title={zoomShot ? `Frame ${zoomShot.frame_index + 1} · ${zoomShot.t_seconds.toFixed(1)}s` : ''}
        size="2xl"
      >
        {zoomShot && (
          <div className="flex items-center justify-center bg-black/40 rounded-lg overflow-hidden">
            <img
              src={zoomShot.image_url}
              alt={`Frame ${zoomShot.frame_index + 1}`}
              className="max-w-full max-h-[70vh] object-contain"
            />
          </div>
        )}
      </Modal>

      {/* Live preview modal (КАО#VR-25 — slideshow; #VR-26 — full-width) */}
      <Modal
        open={!!livePreview}
        onClose={() => setLivePreview(null)}
        title={
          livePreview
            ? `Live preview — Coder ${livePreview.candidate.coder_index + 1}`
            : 'Live preview'
        }
        size="screen-2xl"
      >
        {livePreview && (
          <div className="rounded-lg overflow-hidden border border-cf-border" style={{ height: '85vh' }}>
            <LivePreviewSlideshow candidate={livePreview.candidate} />
          </div>
        )}
      </Modal>

      {/* Help modal */}
      <Modal
        open={showHelp}
        onClose={() => setShowHelp(false)}
        title="How visual review works"
        size="lg"
      >
        <div className="space-y-3 text-sm text-cf-text-muted leading-relaxed">
          <p>
            Multiple Coder agents produced candidate implementations. The system rendered each
            one in a sandboxed browser and captured screenshot strips at different points in
            time.
          </p>
          <p>
            <strong className="text-cf-text">Score each candidate 0–10</strong> based on visual
            quality, layout, polish, and how well it matches what you wanted. Then click{' '}
            <em className="text-cf-text">Submit ranking</em> and the Finalizer agent will use
            your scores to pick the winner.
          </p>
          <p>
            Prefer to let the model decide? Hit <em className="text-cf-text">Skip — let AI
            decide</em> and the system will fall back to the vision-LLM auto-scorer.
          </p>
          <p className="text-xs">
            With 5+ candidates we switch to <em>Tournament mode</em> — quick pairwise comparisons
            that converge on a ranking faster than scoring each one individually.
          </p>
        </div>
      </Modal>
    </div>
  )
}
