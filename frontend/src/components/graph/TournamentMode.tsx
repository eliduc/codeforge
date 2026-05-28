// КАО#VR-Wave2 Tournament
// Pairwise Elo-style tournament for 5+ visual-review candidates.
//
// Why a separate file: VisualReviewPanel was already ~570 lines and the
// tournament adds non-trivial state (Elo ratings, match queue, undo stack).
// Pulling it out keeps both files focused. The contract is identical to the
// Wave-1 stub — props are { candidates, onComplete, onCancel } and we hand
// back ranked code_version_ids once the user submits.
//
// Algorithm summary:
//   • Shuffle candidates once.
//   • Generate ceil(log2(N)) Swiss-style rounds. Each round re-sorts by Elo,
//     pairs adjacent candidates, and (for odd N) gives the lowest-rated a bye.
//   • Each match: user picks a winner OR "no preference" (treated as a draw).
//     Ratings update with the classic Elo formula, K=32 (draws → both sides
//     move K/2 worth of expected-score difference).
//   • Undo pops the most recent match and rewinds the two players' ratings.
//   • Final ranking = sort by Elo desc. We then linearly map the Elo range
//     onto a 0-10 score for display in the summary screen, and hand the
//     ordered code_version_ids to the parent (which does its own 0-10 mapping
//     for the eventual submit payload — that logic already exists in the
//     panel and we don't want to duplicate or override it).

import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  Trophy,
  Undo2,
  ChevronLeft,
  Play,
  Sparkles,
  CheckCircle2,
  ImageIcon,
  Scale,
} from 'lucide-react'
import Button from '../common/Button'
import Modal from '../common/Modal'
import type { VisualReviewCandidate, CodeVersionScreenshot } from '../../types'

// КАО#VR-Wave2 Tournament — public props mirror the Wave-1 stub so the
// panel call-site keeps working unchanged.
export interface TournamentModeProps {
  candidates: VisualReviewCandidate[]
  onComplete: (rankedCodeVersionIds: string[]) => void
  onCancel: () => void
  /** When true, the live preview button uses picsum instead of the real iframe. */
  isMock?: boolean
  /** Needed to build the real sandbox iframe URL when isMock is false. */
  sessionId?: string
}

// КАО#VR-Wave2 Tournament — Elo configuration.
const INITIAL_ELO = 1500
const K_FACTOR = 32

// КАО#VR-Wave2 Tournament — a pair (or bye) generated for a given round.
interface Matchup {
  round: number
  a: string // code_version_id
  b: string | null // null when this is a bye
}

// КАО#VR-Wave2 Tournament — record of a settled match, kept for undo.
interface MatchResult {
  matchup: Matchup
  /** 1 = a won, 0 = b won, 0.5 = draw, null = bye (no rating change). */
  score: number | null
  prevEloA: number
  prevEloB: number | null
}

// КАО#VR-Wave2 Tournament — seeded-ish shuffle (Fisher-Yates with Math.random).
function shuffle<T>(arr: T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// КАО#VR-Wave2 Tournament — number of rounds = ceil(log2(N)). Each round
// produces ~N/2 matches, so total matches ~= N * log2(N) / 2 which matches
// the brief.
function computeRoundCount(n: number): number {
  if (n <= 1) return 0
  return Math.max(1, Math.ceil(Math.log2(n)))
}

// КАО#VR-Wave2 Tournament — Swiss-style pairing. Sort by Elo desc, pair
// adjacent (0-1, 2-3, ...). For odd N the lowest-rated gets a bye.
function buildRound(round: number, order: string[]): Matchup[] {
  const pairs: Matchup[] = []
  const n = order.length
  const usable = n % 2 === 0 ? n : n - 1
  for (let i = 0; i < usable; i += 2) {
    pairs.push({ round, a: order[i], b: order[i + 1] })
  }
  if (n % 2 === 1) {
    pairs.push({ round, a: order[n - 1], b: null })
  }
  return pairs
}

// КАО#VR-Wave2 Tournament — expected-score formula (classic Elo).
function expected(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400))
}

// КАО#VR-Wave2 Tournament — convert raw Elo ratings to display scores in [0,10]
// using a linear scale across the actual range seen. With identical ratings
// (degenerate) we fall back to a flat 5.
function eloToScores(elos: Record<string, number>): Record<string, number> {
  const ids = Object.keys(elos)
  if (ids.length === 0) return {}
  const values = ids.map(id => elos[id])
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const out: Record<string, number> = {}
  for (const id of ids) {
    if (span === 0) {
      out[id] = 5
    } else {
      out[id] = Number((((elos[id] - min) / span) * 10).toFixed(1))
    }
  }
  return out
}

// КАО#VR-Wave2 Tournament — small screenshot strip (4-6 thumbs).
function MiniStrip({
  shots,
  onOpen,
}: {
  shots: CodeVersionScreenshot[]
  onOpen: (shot: CodeVersionScreenshot) => void
}) {
  const limited = shots.slice(0, 6)
  if (limited.length === 0) {
    return (
      <div className="flex items-center justify-center h-20 rounded-md border border-dashed border-cf-border text-cf-text-muted text-xs">
        <ImageIcon className="w-4 h-4 mr-1.5" /> No screenshots
      </div>
    )
  }
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {limited.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={() => onOpen(s)}
          className="group relative rounded overflow-hidden border border-cf-border hover:border-cf-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-cf-primary transition-colors"
          title={`Frame ${s.frame_index + 1} @ ${s.t_seconds.toFixed(1)}s`}
        >
          <img
            src={s.image_url}
            alt={`Frame ${s.frame_index + 1}`}
            className="block w-full h-14 object-cover bg-black/30"
            loading="lazy"
          />
          <span className="absolute bottom-0 left-0 right-0 bg-black/60 text-[9px] text-white px-1 py-0.5 leading-none">
            {s.t_seconds.toFixed(1)}s
          </span>
        </button>
      ))}
    </div>
  )
}

// КАО#VR-Wave2 Tournament — main component.
export default function TournamentMode({
  candidates,
  onComplete,
  onCancel,
  isMock,
  sessionId,
}: TournamentModeProps) {
  // КАО#VR-Wave2 Tournament — quick lookup by id.
  const byId = useMemo(() => {
    const map: Record<string, VisualReviewCandidate> = {}
    for (const c of candidates) map[c.code_version_id] = c
    return map
  }, [candidates])

  // КАО#VR-Wave2 Tournament — shuffled order is fixed for the run. We
  // recompute pairings per round from current Elo, but the initial shuffle
  // guarantees first-round randomness when everyone is tied at 1500.
  const initialOrder = useMemo(
    () => shuffle(candidates.map(c => c.code_version_id)),
    [candidates],
  )

  const totalRounds = useMemo(() => computeRoundCount(candidates.length), [candidates.length])

  // КАО#VR-Wave2 Tournament — state: Elo ratings, match queue, completed
  // matches (for undo), current round number (1-based), and "done" flag.
  const [elos, setElos] = useState<Record<string, number>>(() => {
    const seed: Record<string, number> = {}
    for (const id of initialOrder) seed[id] = INITIAL_ELO
    return seed
  })
  const [queue, setQueue] = useState<Matchup[]>(() => buildRound(1, initialOrder))
  const [completed, setCompleted] = useState<MatchResult[]>([])
  const [round, setRound] = useState(1)
  const [done, setDone] = useState(totalRounds === 0)

  // КАО#VR-Wave2 Tournament — modal state for thumbnail zoom / live preview.
  const [zoomShot, setZoomShot] = useState<CodeVersionScreenshot | null>(null)
  const [livePreview, setLivePreview] = useState<VisualReviewCandidate | null>(null)

  // КАО#VR-Wave2 Tournament — total matches across all rounds (display).
  const totalMatches = useMemo(() => {
    // Replicate buildRound math without mutating Elo: each round of N
    // candidates yields floor(N/2) real matches (the bye is "free").
    let total = 0
    const perRound = Math.floor(candidates.length / 2)
    total = perRound * totalRounds
    return total
  }, [candidates.length, totalRounds])

  const matchesDone = completed.filter(r => r.matchup.b !== null).length
  const progressPct = totalMatches === 0 ? 100 : Math.round((matchesDone / totalMatches) * 100)

  // КАО#VR-Wave2 Tournament — advance to next match. If queue empty, build
  // next round; if rounds exhausted, mark done.
  const advance = useCallback(
    (nextElos: Record<string, number>, remaining: Matchup[]) => {
      if (remaining.length > 0) {
        setQueue(remaining)
        return
      }
      if (round >= totalRounds) {
        setQueue([])
        setDone(true)
        return
      }
      const nextRound = round + 1
      const order = Object.keys(nextElos).sort((a, b) => nextElos[b] - nextElos[a])
      setRound(nextRound)
      setQueue(buildRound(nextRound, order))
    },
    [round, totalRounds],
  )

  // КАО#VR-Wave2 Tournament — settle current match with a given numeric
  // score (1 = a won, 0 = b won, 0.5 = draw). Bye matchups call this with
  // score=null to skip rating updates.
  const settle = useCallback(
    (score: number | null) => {
      if (queue.length === 0) return
      const [current, ...rest] = queue
      const prevA = elos[current.a]
      const prevB = current.b !== null ? elos[current.b] : null

      let nextElos = elos
      if (score !== null && current.b !== null && prevB !== null) {
        const expA = expected(prevA, prevB)
        const expB = 1 - expA
        const deltaA = K_FACTOR * (score - expA)
        const deltaB = K_FACTOR * ((1 - score) - expB)
        nextElos = {
          ...elos,
          [current.a]: prevA + deltaA,
          [current.b]: prevB + deltaB,
        }
        setElos(nextElos)
      }

      setCompleted(prev => [
        ...prev,
        {
          matchup: current,
          score,
          prevEloA: prevA,
          prevEloB: prevB,
        },
      ])
      advance(nextElos, rest)
    },
    [queue, elos, advance],
  )

  // КАО#VR-Wave2 Tournament — handler for the "no preference" button. Draws
  // pull both players' ratings toward the midpoint; per the brief this is
  // effectively K/2 worth of delta (Elo with score=0.5 yields exactly that
  // when ratings are equal).
  const handleDraw = () => settle(0.5)
  const handlePickA = () => settle(1)
  const handlePickB = () => settle(0)

  // Auto-resolve bye matchups so the user never sees them: as soon as the
  // queue head is a bye, settle it silently. Implemented as an effect-style
  // guard inside render to stay declarative without useEffect noise.
  if (!done && queue.length > 0 && queue[0].b === null) {
    // Defer to a microtask so we don't setState during render.
    queueMicrotask(() => settle(null))
  }

  // КАО#VR-Wave2 Tournament — undo last user-visible match. We skip bye
  // entries because they don't affect ratings and weren't user-driven.
  const handleUndo = () => {
    if (completed.length === 0) return
    // Walk back to the last non-bye result.
    const next = completed.slice()
    let last: MatchResult | undefined
    while (next.length > 0) {
      const candidate = next.pop()
      if (!candidate) break
      if (candidate.matchup.b !== null) {
        last = candidate
        break
      }
    }
    if (!last) return

    // Restore ratings.
    setElos(prev => {
      const out = { ...prev }
      out[last!.matchup.a] = last!.prevEloA
      if (last!.matchup.b !== null && last!.prevEloB !== null) {
        out[last!.matchup.b] = last!.prevEloB
      }
      return out
    })

    // Restore queue: prepend the undone matchup. If we were already on the
    // summary screen, drop back into the queue.
    setQueue(prev => [last!.matchup, ...prev])
    setCompleted(next)
    setRound(last!.matchup.round)
    setDone(false)
  }

  // КАО#VR-Wave2 Tournament — final ranking from Elo (desc).
  const ranking = useMemo(() => {
    const ids = candidates.map(c => c.code_version_id)
    return ids.slice().sort((a, b) => elos[b] - elos[a])
  }, [candidates, elos])
  const previewScores = useMemo(() => eloToScores(elos), [elos])

  // КАО#VR-Wave2 Tournament — submit hands the ranked ids to the panel,
  // which already converts to 0-10 for the backend payload.
  const handleSubmit = () => {
    onComplete(ranking)
  }

  // КАО#VR-25 — live preview is now a slideshow of captured frames, not a
  // live iframe. See LivePreviewSlideshow in VisualReviewPanel for rationale.
  const [livePreviewIdx, setLivePreviewIdx] = useState(0)
  const [livePreviewPlaying, setLivePreviewPlaying] = useState(true)

  const livePreviewShots = useMemo(() => {
    if (!livePreview) return []
    return [...livePreview.screenshots].sort((a, b) => a.frame_index - b.frame_index)
  }, [livePreview])

  useEffect(() => {
    // reset to frame 0 every time the preview opens / candidate changes
    setLivePreviewIdx(0)
    setLivePreviewPlaying(true)
  }, [livePreview])

  useEffect(() => {
    if (!livePreviewPlaying || livePreviewShots.length <= 1) return
    const cur = livePreviewShots[livePreviewIdx]
    const next = livePreviewShots[(livePreviewIdx + 1) % livePreviewShots.length]
    const waitMs = livePreviewIdx === livePreviewShots.length - 1
      ? 1000
      : Math.max(300, Math.min(4000, (next.t_seconds - cur.t_seconds) * 1000))
    const t = setTimeout(
      () => setLivePreviewIdx((i) => (i + 1) % livePreviewShots.length),
      waitMs,
    )
    return () => clearTimeout(t)
  }, [livePreviewIdx, livePreviewPlaying, livePreviewShots])

  // ---------------------------------------------------------------------
  // Final-ranking summary screen.
  // ---------------------------------------------------------------------
  if (done) {
    return (
      <div className="rounded-xl border border-cf-border bg-cf-panel/60 p-4 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-base font-semibold text-cf-text flex items-center gap-2">
            <Trophy className="w-4 h-4 text-cf-primary" />
            Final ranking
          </h4>
          <span className="text-[10px] uppercase tracking-wider text-cf-text-muted">
            {completed.length} match{completed.length === 1 ? '' : 'es'} played
          </span>
        </div>

        <ol className="space-y-2">
          {ranking.map((id, idx) => {
            const c = byId[id]
            if (!c) return null
            const elo = elos[id]
            const score = previewScores[id]
            const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`
            return (
              <li
                key={id}
                className="flex items-center gap-3 rounded-lg border border-cf-border bg-cf-panel/80 p-2.5"
              >
                <span className="text-lg w-8 text-center tabular-nums">{medal}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-cf-text truncate">
                    Coder {c.coder_index + 1}
                  </div>
                  <div className="text-[11px] text-cf-text-muted truncate">{c.llm_model}</div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-semibold text-cf-text tabular-nums">
                    {score.toFixed(1)} / 10
                  </div>
                  <div className="text-[10px] text-cf-text-muted tabular-nums" title="Elo rating">
                    Elo {Math.round(elo)}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>

        <div className="flex items-center gap-2 pt-2">
          <Button
            size="sm"
            variant="primary"
            leadingIcon={<CheckCircle2 className="w-3.5 h-3.5" />}
            onClick={handleSubmit}
          >
            Apply ranking
          </Button>
          <Button
            size="sm"
            variant="ghost"
            leadingIcon={<ChevronLeft className="w-3.5 h-3.5" />}
            onClick={handleUndo}
            disabled={completed.filter(r => r.matchup.b !== null).length === 0}
          >
            Back to tournament
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel} className="ml-auto">
            Cancel
          </Button>
        </div>
      </div>
    )
  }

  // ---------------------------------------------------------------------
  // Match view.
  // ---------------------------------------------------------------------
  const current = queue[0]
  const candA = current ? byId[current.a] : undefined
  const candB = current && current.b ? byId[current.b] : undefined

  // Edge case: queue temporarily empty between rounds while microtask
  // schedules the next round. Render a placeholder so we never crash.
  if (!current || !candA) {
    return (
      <div className="rounded-xl border border-cf-border bg-cf-panel/60 p-4 text-sm text-cf-text-muted">
        Preparing next round…
      </div>
    )
  }

  // If we somehow land on a bye in render (microtask hasn't fired yet),
  // show the same placeholder.
  if (!candB) {
    return (
      <div className="rounded-xl border border-cf-border bg-cf-panel/60 p-4 text-sm text-cf-text-muted">
        Resolving bye…
      </div>
    )
  }

  const eloTooltip = candidates
    .map(c => `Coder ${c.coder_index + 1} (${c.llm_model}): ${Math.round(elos[c.code_version_id])}`)
    .join('\n')

  return (
    <div className="rounded-xl border border-cf-border bg-cf-panel/60 p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-base font-semibold text-cf-text flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-cf-primary" />
          Visual Review · Tournament
        </h4>
        <span className="text-[11px] text-cf-text-muted tabular-nums">
          Round {round} of {totalRounds}
        </span>
      </div>

      {/* Progress bar */}
      <div>
        <div
          className="h-1.5 w-full rounded-full bg-cf-border overflow-hidden"
          aria-label={`Tournament progress: ${matchesDone} of ${totalMatches} matches`}
        >
          <div
            className="h-full bg-cf-primary transition-all duration-200"
            style={{ width: `${progressPct}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-[10px] text-cf-text-muted mt-1">
          <span>
            Match {Math.min(matchesDone + 1, totalMatches)} of {totalMatches}
          </span>
          <span title={eloTooltip} className="cursor-help">
            Elo so far ⓘ
          </span>
        </div>
      </div>

      {/* Pair view */}
      <div className="grid grid-cols-2 gap-3">
        {[candA, candB].map((c, side) => (
          <div
            key={c.code_version_id}
            className="rounded-lg border border-cf-border bg-cf-panel/80 p-2.5 space-y-2.5 flex flex-col"
          >
            <div className="flex items-center justify-between gap-2 min-w-0">
              <span className="text-xs font-medium text-cf-text truncate">
                Coder {c.coder_index + 1}
              </span>
              <span
                className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-100 dark:bg-cf-primary/15 text-indigo-700 dark:text-cf-primary border border-indigo-300 dark:border-cf-primary/30 truncate max-w-[120px]"
                title={c.llm_model}
              >
                {c.llm_model}
              </span>
            </div>

            <MiniStrip shots={c.screenshots} onOpen={setZoomShot} />

            <Button
              size="sm"
              variant="secondary"
              leadingIcon={<Play className="w-3.5 h-3.5" />}
              onClick={() => setLivePreview(c)}
              fullWidth
            >
              Live preview
            </Button>

            <Button
              size="sm"
              variant={side === 0 ? 'primary' : 'primary'}
              fullWidth
              onClick={side === 0 ? handlePickA : handlePickB}
              className={
                side === 0
                  ? '!bg-cf-primary hover:!bg-cf-secondary'
                  : '!bg-cf-success hover:!bg-cf-success/80'
              }
            >
              {side === 0 ? '← Prefer this one' : 'Prefer this one →'}
            </Button>
          </div>
        ))}
      </div>

      {/* No-preference center button */}
      <div className="flex items-center justify-center">
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<Scale className="w-3.5 h-3.5" />}
          onClick={handleDraw}
        >
          No preference (draw)
        </Button>
      </div>

      {/* Bottom row: undo + cancel */}
      <div className="flex items-center gap-2 pt-1 border-t border-cf-border">
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={<Undo2 className="w-3.5 h-3.5" />}
          onClick={handleUndo}
          disabled={completed.filter(r => r.matchup.b !== null).length === 0}
        >
          Undo last match
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} className="ml-auto">
          Back
        </Button>
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

      {/* Live preview modal — slideshow at full width (КАО#VR-25 + #VR-26) */}
      <Modal
        open={!!livePreview}
        onClose={() => setLivePreview(null)}
        title={
          livePreview
            ? `Live preview — Coder ${livePreview.coder_index + 1}`
            : 'Live preview'
        }
        size="screen-2xl"
      >
        {livePreview && livePreviewShots.length > 0 && (
          <div
            className="rounded-lg overflow-hidden border border-cf-border flex flex-col bg-black"
            style={{ height: '85vh' }}
          >
            <div className="flex-1 flex items-center justify-center overflow-hidden">
              <img
                src={livePreviewShots[livePreviewIdx].image_url}
                alt={`Frame ${livePreviewShots[livePreviewIdx].frame_index + 1}`}
                className="max-w-full max-h-full object-contain"
              />
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-black/60 text-white text-xs">
              <span>
                Frame {livePreviewShots[livePreviewIdx].frame_index + 1} / {livePreviewShots.length}
                {' · '}
                t={livePreviewShots[livePreviewIdx].t_seconds.toFixed(1)}s
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="px-2 py-0.5 rounded hover:bg-white/10"
                  onClick={() => setLivePreviewIdx((i) => (i - 1 + livePreviewShots.length) % livePreviewShots.length)}
                >◀ Prev</button>
                <button
                  type="button"
                  className="px-2 py-0.5 rounded hover:bg-white/10"
                  onClick={() => setLivePreviewPlaying((p) => !p)}
                >{livePreviewPlaying ? '❚❚ Pause' : '▶ Play'}</button>
                <button
                  type="button"
                  className="px-2 py-0.5 rounded hover:bg-white/10"
                  onClick={() => setLivePreviewIdx((i) => (i + 1) % livePreviewShots.length)}
                >Next ▶</button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
