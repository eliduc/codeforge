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
              : item.id === 'murmuration'
              ? 'radial-gradient(circle at 50% 32%, #7c2d52 0%, #3b1d4e 55%, #0a0612 100%)'
              : item.id === 'life'
              ? 'radial-gradient(circle at center, #0c4a6e 0%, #082f49 55%, #04060c 100%)'
              : item.id === 'particles'
              ? 'radial-gradient(circle at 60% 40%, #831843 0%, #1e1b4b 60%, #05030a 100%)'
              : 'radial-gradient(circle at center, #0c4a6e 0%, #1e1b4b 60%, #000 100%)',
        }}
      >
        <div className="absolute inset-0 opacity-30" style={{
          backgroundImage:
            'repeating-linear-gradient(45deg, rgba(255,255,255,0.04) 0 2px, transparent 2px 8px)',
        }} />
        <DemoThumbnail id={item.id} fallback={item.thumbnail} />
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

/**
 * VR-51 — illustrated demo thumbnails. The emoji thumbnails (🌐 / 🦠 / ✨) read
 * as generic, so each known demo gets an inline-SVG illustration that conveys
 * what the app actually is. Inline SVG keeps it crisp at any size, themeable,
 * and asset-pipeline-free. Unknown ids fall back to the emoji from index.json.
 */
function DemoThumbnail({ id, fallback }: { id: string; fallback?: string }) {
  const cls = 'h-28 w-auto group-hover:scale-110 transition-transform duration-300'

  if (id === 'mandelbulb') {
    // Ray-marched Mandelbulb → a glowing self-similar cluster of 3D bulbs.
    const sats: [number, number][] = [[100, 28], [138, 50], [138, 94], [100, 116], [62, 94], [62, 50]]
    const buds: [number, number][] = [[164, 72], [132, 17], [68, 17], [36, 72], [68, 127], [132, 127]]
    return (
      <svg viewBox="0 0 200 150" className={cls} style={{ filter: 'drop-shadow(0 0 10px rgba(192,38,211,0.45))' }} aria-hidden="true">
        <defs>
          <radialGradient id="mb-bulb" cx="36%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#fbcfe8" />
            <stop offset="35%" stopColor="#e879f9" />
            <stop offset="72%" stopColor="#a21caf" />
            <stop offset="100%" stopColor="#3b0764" />
          </radialGradient>
          <radialGradient id="mb-halo" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#c026d3" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#c026d3" stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="100" cy="72" r="74" fill="url(#mb-halo)" />
        {buds.map(([cx, cy], i) => <circle key={`b${i}`} cx={cx} cy={cy} r="7" fill="url(#mb-bulb)" />)}
        {sats.map(([cx, cy], i) => <circle key={`s${i}`} cx={cx} cy={cy} r="17" fill="url(#mb-bulb)" />)}
        <circle cx="100" cy="72" r="36" fill="url(#mb-bulb)" />
        <ellipse cx="88" cy="60" rx="9" ry="6" fill="#fdf4ff" opacity="0.7" />
      </svg>
    )
  }

  if (id === 'murmuration') {
    // 3D starling murmuration → a swirling flock of tiny birds (deterministic
    // swirl, sunset palette) that reads as a shape-shifting cloud.
    const birds: [number, number, number, number][] = []
    const N = 46
    for (let i = 0; i < N; i++) {
      const t = i / N
      const ang = t * Math.PI * 3.2
      const rad = 16 + 46 * Math.sin(t * Math.PI) // 0 → peak → 0 (teardrop)
      const x = 104 + Math.cos(ang) * rad * 0.95 + (t - 0.5) * 34
      const y = 74 + Math.sin(ang) * rad * 0.6 - (t - 0.5) * 12
      const s = 0.7 + 0.6 * Math.sin(t * Math.PI)
      birds.push([x, y, ((ang + Math.PI / 2) * 180) / Math.PI, s])
    }
    return (
      <svg viewBox="0 0 200 150" className={cls} style={{ filter: 'drop-shadow(0 0 8px rgba(232,121,185,0.45))' }} aria-hidden="true">
        <defs>
          <linearGradient id="mm-bird" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#fbcfe8" />
            <stop offset="55%" stopColor="#e879b9" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
          <radialGradient id="mm-halo" cx="52%" cy="46%" r="58%">
            <stop offset="0%" stopColor="#e879b9" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#e879b9" stopOpacity="0" />
          </radialGradient>
        </defs>
        <ellipse cx="104" cy="72" rx="88" ry="60" fill="url(#mm-halo)" />
        {birds.map(([x, y, a, s], i) => (
          <path
            key={i}
            d="M5 0 L-3 2.4 L-3 -2.4 Z"
            fill="url(#mm-bird)"
            opacity={(0.45 + 0.5 * s).toFixed(2)}
            transform={`translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${a.toFixed(0)}) scale(${s.toFixed(2)})`}
          />
        ))}
      </svg>
    )
  }

  if (id === 'life') {
    // Conway's Game of Life → the iconic glider + a still-life block on a
    // glowing grid, in the neon-cyan style of the generated app.
    const cells: [number, number][] = [
      [78, 26], [98, 46], [58, 66], [78, 66], [98, 66], // glider
      [130, 90], [150, 90], [130, 110], [150, 110],     // block (still life)
      [40, 40], [162, 40],                              // accents
    ]
    return (
      <svg viewBox="0 0 200 150" className={cls} aria-hidden="true">
        <defs>
          <linearGradient id="gol-cell" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a5f3fc" />
            <stop offset="55%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#0891b2" />
          </linearGradient>
          <filter id="gol-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3.2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g stroke="#22d3ee" strokeOpacity="0.13" strokeWidth="1">
          {[20, 40, 60, 80, 100, 120, 140, 160, 180].map(x => <line key={`v${x}`} x1={x} y1="14" x2={x} y2="136" />)}
          {[22, 42, 62, 82, 102, 122].map(y => <line key={`h${y}`} x1="20" y1={y} x2="180" y2={y} />)}
        </g>
        <g filter="url(#gol-glow)">
          {cells.map(([x, y], i) => <rect key={i} x={x} y={y} width="16" height="16" rx="3" fill="url(#gol-cell)" />)}
        </g>
      </svg>
    )
  }

  if (id === 'particles') {
    // Flow-field particle system → glowing curl-noise streamlines + particles.
    const dots: [number, number][] = [[188, 38], [188, 96], [150, 79], [100, 84], [60, 57], [120, 66]]
    return (
      <svg viewBox="0 0 200 150" className={cls} aria-hidden="true">
        <defs>
          <linearGradient id="pf-stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="50%" stopColor="#f472b6" />
            <stop offset="100%" stopColor="#fb923c" />
          </linearGradient>
          <filter id="pf-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.2" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>
        <g fill="none" stroke="url(#pf-stroke)" strokeWidth="2.5" strokeLinecap="round" filter="url(#pf-glow)" opacity="0.92">
          <path d="M14 40 C 60 18, 120 72, 188 36" />
          <path d="M14 70 C 70 54, 110 102, 188 66" />
          <path d="M14 100 C 60 96, 120 58, 188 96" />
          <path d="M14 124 C 80 122, 120 92, 188 120" />
        </g>
        <g fill="#fde68a" filter="url(#pf-glow)">
          {dots.map(([x, y], i) => <circle key={i} cx={x} cy={y} r="3.2" />)}
        </g>
      </svg>
    )
  }

  return (
    <div className="text-6xl drop-shadow-[0_0_20px_rgba(255,255,255,0.4)] group-hover:scale-110 transition-transform">
      {fallback || '✨'}
    </div>
  )
}
