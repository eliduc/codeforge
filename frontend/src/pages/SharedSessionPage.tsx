import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  Code2,
  Loader2,
  AlertCircle,
  Copy,
  Check,
  CheckCircle2,
  Clock,
  Play,
  XCircle,
  Pause,
  Sparkles,
  Palette,
} from 'lucide-react'
import { getSharedSession, type SharedSessionResponse } from '../services/api'
import notify from '../components/common/StyledToast'
// Улучшатели#4 P2·S — SharedSessionPage raw status humanize.
import { humanizeStatus } from '../lib/sessionLabels'

const STATUS_ICONS: Record<string, JSX.Element> = {
  created: <Clock className="w-4 h-4 text-gray-400" />,
  running: <Play className="w-4 h-4 text-blue-400" />,
  paused: <Pause className="w-4 h-4 text-yellow-400" />,
  completed: <CheckCircle2 className="w-4 h-4 text-green-400" />,
  failed: <XCircle className="w-4 h-4 text-red-400" />,
  cancelled: <XCircle className="w-4 h-4 text-gray-400" />,
  awaiting_enhancement: <Sparkles className="w-4 h-4 text-purple-400" />,
  enhancing: <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />,
  awaiting_enhancement_review: <Sparkles className="w-4 h-4 text-amber-400" />,
  awaiting_visual_review: <Palette className="w-4 h-4 text-amber-400" />,  // КАО#R3-01
}

const STATUS_COLORS: Record<string, string> = {
  created: 'bg-gray-500/15 text-gray-300 border-gray-500/30',
  running: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  paused: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30',
  completed: 'bg-green-500/20 text-green-300 border-green-500/30',
  failed: 'bg-red-500/20 text-red-300 border-red-500/30',
  cancelled: 'bg-gray-500/20 text-gray-300 border-gray-500/30',
  awaiting_enhancement: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  enhancing: 'bg-purple-500/20 text-purple-300 border-purple-500/30',
  awaiting_enhancement_review: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
  awaiting_visual_review: 'bg-amber-500/20 text-amber-300 border-amber-500/30',  // КАО#R3-01
}

export default function SharedSessionPage() {
  const { token } = useParams<{ token: string }>()
  const [session, setSession] = useState<SharedSessionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [codeCopied, setCodeCopied] = useState(false)
  const [specCopied, setSpecCopied] = useState(false)

  useEffect(() => {
    if (!token) {
      setError('Missing share token')
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    getSharedSession(token)
      .then((data) => {
        if (!cancelled) setSession(data)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : 'Failed to load shared session'
          setError(msg)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  async function handleCopy(text: string, kind: 'code' | 'spec') {
    try {
      await navigator.clipboard.writeText(text)
      if (kind === 'code') {
        setCodeCopied(true)
        setTimeout(() => setCodeCopied(false), 2000)
      } else {
        setSpecCopied(true)
        setTimeout(() => setSpecCopied(false), 2000)
      }
      notify.success('Copied to clipboard')
    } catch {
      notify.error('Failed to copy')
    }
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-900 via-gray-900 to-gray-950 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 group">
            <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400 group-hover:bg-indigo-500/30 transition-colors">
              <Code2 className="w-5 h-5" />
            </div>
            <div>
              <div className="text-sm font-bold text-white tracking-tight">CodeForge</div>
              <div className="text-[10px] text-gray-400 -mt-0.5">shared session</div>
            </div>
          </Link>
          <div className="text-xs text-gray-400">Read-only public view</div>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-8">
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-indigo-400" />
          </div>
        )}

        {error && !loading && (
          <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-6 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div>
              <div className="text-red-300 font-medium">Could not load shared session</div>
              <div className="text-sm text-red-300/70 mt-1">{error}</div>
              <p className="text-xs text-gray-400 mt-3">
                The share link may have been revoked, expired, or never existed.
              </p>
            </div>
          </div>
        )}

        {session && !loading && (
          <div className="space-y-6">
            {/* Title block */}
            <div>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h1 className="text-2xl sm:text-3xl font-bold text-white">{session.name}</h1>
                  <div className="text-xs text-gray-400 mt-1">
                    Created {formatDate(session.created_at)}
                    {session.language ? <> • {session.language}</> : null}
                  </div>
                </div>
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
                    STATUS_COLORS[session.status] || 'bg-gray-500/15 text-gray-300 border-gray-500/30'
                  }`}
                >
                  {STATUS_ICONS[session.status] || null}
                  {/* Улучшатели#4 P2·S — humanize raw status enum. */}
                  {humanizeStatus(session.status)}
                </span>
              </div>
            </div>

            {/* Specification */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                  Specification
                </h2>
                {session.specification && session.specification !== '(not set)' && (
                  <button
                    type="button"
                    onClick={() => handleCopy(session.specification, 'spec')}
                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
                  >
                    {specCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-green-400" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" /> Copy
                      </>
                    )}
                  </button>
                )}
              </div>
              <div className="bg-gray-800/60 border border-gray-700 rounded-lg p-4">
                {session.specification && session.specification !== '(not set)' ? (
                  <pre className="whitespace-pre-wrap font-sans text-sm text-gray-200 leading-relaxed">
                    {session.specification}
                  </pre>
                ) : (
                  <span className="text-sm text-gray-400 italic">No specification provided.</span>
                )}
              </div>
            </section>

            {/* Final code */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider">
                  Final code
                </h2>
                {session.final_code && (
                  <button
                    type="button"
                    onClick={() => handleCopy(session.final_code!, 'code')}
                    className="flex items-center gap-1 text-xs text-gray-400 hover:text-white transition-colors"
                  >
                    {codeCopied ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-green-400" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="w-3.5 h-3.5" /> Copy
                      </>
                    )}
                  </button>
                )}
              </div>
              <div className="bg-gray-950 border border-gray-700 rounded-lg overflow-hidden">
                {session.final_code ? (
                  <pre className="p-4 overflow-x-auto text-xs sm:text-sm leading-relaxed text-gray-200 font-mono max-h-[600px]">
                    {session.final_code}
                  </pre>
                ) : (
                  <div className="p-4 text-sm text-gray-400 italic">
                    No final code yet — this session has not produced a final result.
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-gray-800 bg-gray-900/60 mt-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-gray-400">
          <div>
            Powered by <span className="text-gray-300 font-medium">CodeForge</span>
          </div>
          <a
            href="https://gotcode.ai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-400 hover:text-indigo-400 transition-colors"
          >
            gotcode.ai
          </a>
        </div>
      </footer>
    </div>
  )
}
