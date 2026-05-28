/**
 * "Featured demos" gallery — a row of pre-recorded session-playback cards
 * shown on SessionsPage. Each card has:
 *   ▶ Watch demo       → /demo/:id (replays the timeline JSON, no LLM calls)
 *   🚀 Try it yourself → creates a real session from the underlying spec
 *
 * The gallery's metadata comes from a small `index.json` shipped in
 * `public/demo-templates/`. Timeline JSONs themselves are fetched on demand
 * by the DemoPlayer route — they don't bloat the main bundle.
 */

import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Play, Rocket, Loader2, Sparkles } from 'lucide-react'
import notify from '../common/StyledToast'
import { createSession } from '../../services/api'

interface DemoIndexEntry {
  id: string
  name: string
  description: string
  language: string
  thumbnail?: string
  duration_seconds: number
}

interface DemoTimelinePartial {
  spec: string
  language: string
  name: string
  coders: { model: string }[]
  testers: { model: string }[]
}

export default function DemoGallery() {
  const [items, setItems] = useState<DemoIndexEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [tryingId, setTryingId] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false
    fetch('/demo-templates/index.json')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: DemoIndexEntry[]) => {
        if (!cancelled) setItems(data)
      })
      .catch(err => {
        // Gallery is optional eye-candy — silent failure is fine.
        // eslint-disable-next-line no-console
        console.warn('[DemoGallery] failed to load demo index:', err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleTryYourself(id: string) {
    setTryingId(id)
    try {
      // Fetch the full timeline JSON only when we need the spec.
      const resp = await fetch(`/demo-templates/${id}.json`)
      if (!resp.ok) throw new Error(`Failed to load template (${resp.status})`)
      const tl: DemoTimelinePartial = await resp.json()
      const session = await createSession({
        name: tl.name,
        specification: tl.spec,
        language: tl.language,
        max_iterations: 3,
        num_coders: Math.max(1, tl.coders.length),
        num_testers: Math.max(1, tl.testers.length),
      })
      notify.success('Session created — give it a moment to start')
      navigate(`/sessions/${session.id}`)
    } catch (err: any) {
      notify.error(err?.message || 'Failed to create session from demo')
    } finally {
      setTryingId(null)
    }
  }

  if (loading) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-4">
        <div className="flex items-center gap-2 text-gray-400 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading featured demos…
        </div>
      </div>
    )
  }
  if (items.length === 0) return null

  return (
    <div
      className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-4"
      data-tour="demo-gallery"
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-amber-400" />
          Featured Demos
          {/* Улучшатели#7 P1·S — copy aligned with reality (mandelbulb is 162s). */}
          <span className="text-xs text-gray-400 font-normal ml-1">
            · Real multi-agent runs, replayed
          </span>
        </h2>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {items.map(item => (
          <DemoCard
            key={item.id}
            item={item}
            trying={tryingId === item.id}
            onTry={() => handleTryYourself(item.id)}
          />
        ))}
      </div>
    </div>
  )
}

function DemoCard({
  item,
  trying,
  onTry,
}: {
  item: DemoIndexEntry
  trying: boolean
  onTry: () => void
}) {
  return (
    <div className="bg-gray-900/60 border border-gray-700 rounded-lg overflow-hidden flex flex-col group hover:border-indigo-500/60 hover:shadow-lg hover:shadow-indigo-500/10 transition-all">
      {/* Animated thumbnail */}
      <div
        className="relative h-32 flex items-center justify-center text-5xl overflow-hidden"
        style={{
          background:
            item.id === 'mandelbulb'
              ? 'radial-gradient(circle at 30% 40%, #5b21b6 0%, #1e1b4b 60%, #0a0918 100%)'
              : item.id === 'snake'
              ? 'radial-gradient(circle at center, #064e3b 0%, #052e2b 60%, #04060c 100%)'
              : item.id === 'particles'
              ? 'radial-gradient(circle at 60% 40%, #831843 0%, #1e1b4b 60%, #05030a 100%)'
              : 'radial-gradient(circle at center, #0c4a6e 0%, #1e1b4b 60%, #000 100%)',
        }}
      >
        <div className="absolute inset-0 opacity-30" style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, rgba(255,255,255,0.04) 0 2px, transparent 2px 8px)',
        }} />
        <div className="text-6xl drop-shadow-[0_0_20px_rgba(255,255,255,0.4)] group-hover:scale-110 transition-transform">
          {item.thumbnail || '✨'}
        </div>
      </div>
      <div className="p-3 flex flex-col flex-1">
        <div className="font-semibold text-white text-sm leading-tight mb-1">{item.name}</div>
        <div className="text-xs text-gray-400 leading-snug mb-3 flex-1">{item.description}</div>
        <div className="flex gap-2 mt-auto">
          <Link
            to={`/demo/${item.id}`}
            className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-md transition-colors"
            title="Watch a pre-recorded playback (no LLM calls)"
          >
            <Play className="w-3.5 h-3.5" /> Watch demo
          </Link>
          <button
            onClick={onTry}
            disabled={trying}
            className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-600 text-white text-xs font-medium rounded-md transition-colors"
            title="Create a real session from this spec"
          >
            {trying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Rocket className="w-3.5 h-3.5" />}
            Try it
          </button>
        </div>
      </div>
    </div>
  )
}
