import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Activity, DollarSign, Zap, RefreshCw, BarChart3, Sparkles, ChevronRight, Plus } from 'lucide-react'
import { getDashboardStats, getSessions, type DashboardStats } from '../services/api'
import type { SessionListItem } from '../types'
// Улучшатели#3 P2·S — DashboardPage humanize status pills + link to /sessions?status=…
import { humanizeStatus } from '../lib/sessionLabels'

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [days, setDays] = useState(30)
  // КАО W4-CFIX: Recent sessions list — 5 newest, populated independently
  // of stats. If list is empty, Dashboard renders the Welcome card instead.
  const [recentSessions, setRecentSessions] = useState<SessionListItem[]>([])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([
      getDashboardStats(days),
      getSessions(0, 5).catch(() => ({ items: [] as SessionListItem[], total: 0 })),
    ])
      .then(([s, list]) => {
        if (cancelled) return
        setStats(s)
        setRecentSessions(list.items ?? [])
      })
      .catch(err => {
        if (!cancelled) setError(err?.message || 'Failed to load dashboard stats')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [days])

  if (loading) return <div className="p-8 text-cf-text-muted">Loading...</div>
  if (error) return <div className="p-8 text-cf-error">{error}</div>
  if (!stats) return <div className="p-8 text-cf-text-muted">No data</div>

  const maxDaily = Math.max(...stats.daily_cost.map(d => d.cost_usd), 0.01)

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-cf-text flex items-center gap-2">
          <BarChart3 className="w-6 h-6" /> Dashboard
        </h1>
        <select
          value={days}
          onChange={e => setDays(Number(e.target.value))}
          aria-label="Dashboard time range"
          title="Dashboard time range"
          className="px-3 py-1.5 bg-cf-panel border border-cf-border rounded-lg text-cf-text"
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {/* КАО W4-CFIX-01: Welcome / onboarding card — shows ONLY for empty
          accounts (no sessions ever created). Auto-hides as soon as the user
          has at least one session in the system. */}
      {recentSessions.length === 0 && (
        <div
          data-testid="dashboard-welcome-card"
          className="bg-gradient-to-br from-cf-primary/10 to-cf-secondary/10 border border-cf-primary/30 rounded-lg p-6"
        >
          <div className="flex items-start gap-4">
            <div className="bg-cf-primary/20 rounded-lg p-3">
              <Sparkles className="w-6 h-6 text-cf-primary" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-bold text-cf-text mb-1">Welcome to CodeForge</h2>
              <p className="text-sm text-cf-text-muted mb-4">
                You haven't created any sessions yet. Spin up your first multi-agent
                coding run from a plain-English specification — coders write the code,
                testers audit it, the workflow iterates until it converges.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  to="/sessions/new"
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-cf-primary hover:bg-cf-secondary text-white text-sm font-medium rounded-lg transition-colors"
                >
                  <Plus className="w-4 h-4" /> Create your first session
                </Link>
                <Link
                  to="/demos"
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-cf-bg hover:bg-cf-panel text-cf-text text-sm font-medium rounded-lg border border-cf-border transition-colors"
                >
                  Try a demo first
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={DollarSign} label="Total Cost" value={`$${stats.total_cost_usd.toFixed(2)}`} />
        <StatCard icon={Zap} label="Total Tokens" value={stats.total_tokens.toLocaleString()} />
        <StatCard icon={Activity} label="Requests" value={stats.total_requests.toString()} />
        <StatCard icon={RefreshCw} label="Avg Iterations" value={stats.avg_iterations.toFixed(1)} />
      </div>

      {/* Sessions by status */}
      <div className="bg-cf-panel rounded-lg p-4 border border-cf-border">
        <h2 className="text-sm font-semibold text-cf-text mb-3">Sessions by Status</h2>
        {Object.keys(stats.sessions_by_status).length === 0 ? (
          <p className="text-cf-text-muted text-sm">No sessions in window</p>
        ) : (
          // Улучшатели#3 P2·S — Dashboard "Sessions by Status" raw enum.
          // Pills now use humanizeStatus() and link to /sessions?status=<enum>
          // so clicking filters the Sessions list.
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.sessions_by_status).map(([status, count]) => (
              <Link
                key={status}
                to={`/sessions?status=${encodeURIComponent(status)}`}
                className="px-3 py-1 bg-cf-bg rounded-lg border border-cf-border hover:border-cf-primary transition-colors"
                title={`Filter sessions by ${humanizeStatus(status)}`}
              >
                <span className="text-cf-text-muted text-xs">{humanizeStatus(status)}: </span>
                <span className="text-cf-text font-semibold">{count}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* КАО W4-CFIX-02: Recent sessions list — last 5, with link to detail.
          Hidden on empty accounts (Welcome card covers that state). */}
      {recentSessions.length > 0 && (
        <div
          data-testid="dashboard-recent-sessions"
          className="bg-cf-panel rounded-lg p-4 border border-cf-border"
        >
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-cf-text">Recent sessions</h2>
            <Link
              to="/sessions"
              className="text-xs text-cf-text-muted hover:text-cf-primary transition-colors inline-flex items-center gap-1"
            >
              View all <ChevronRight className="w-3 h-3" />
            </Link>
          </div>
          <ul className="divide-y divide-cf-border">
            {recentSessions.map(s => (
              <li key={s.id}>
                <Link
                  to={`/sessions/${s.id}`}
                  className="flex items-center justify-between gap-3 py-2 hover:bg-cf-bg/60 -mx-2 px-2 rounded transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-cf-text truncate">{s.name}</div>
                    <div className="text-xs text-cf-text-muted flex items-center gap-2">
                      <span>{humanizeStatus(s.status)}</span>
                      <span>·</span>
                      <span>iter {s.current_iteration}/{s.max_iterations}</span>
                      <span>·</span>
                      <span>{s.language}</span>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-cf-text-muted shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Daily cost bars */}
      {stats.daily_cost.length > 0 && (
        <div className="bg-cf-panel rounded-lg p-4 border border-cf-border">
          <h2 className="text-sm font-semibold text-cf-text mb-3">Daily Cost (last 14 days)</h2>
          <div className="space-y-1">
            {stats.daily_cost.map(d => (
              <div key={d.date} className="flex items-center gap-3 text-xs">
                <span className="text-cf-text-muted w-20">{d.date.slice(5, 10)}</span>
                <div className="flex-1 bg-cf-bg rounded-sm h-5 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cf-primary to-cf-secondary"
                    style={{ width: `${(d.cost_usd / maxDaily) * 100}%` }}
                  />
                </div>
                <span className="text-cf-text w-20 text-right">${d.cost_usd.toFixed(3)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Top providers + models */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TopList
          title="Top Providers"
          items={stats.top_providers.map(p => ({ name: p.provider, cost: p.cost_usd, count: p.requests }))}
        />
        <TopList
          title="Top Models"
          items={stats.top_models.map(m => ({ name: m.model, cost: m.cost_usd, count: m.requests }))}
        />
      </div>
    </div>
  )
}

interface StatCardProps {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
}

function StatCard({ icon: Icon, label, value }: StatCardProps) {
  return (
    <div className="bg-cf-panel rounded-lg p-4 border border-cf-border">
      <div className="flex items-center gap-2 text-cf-text-muted text-xs mb-1">
        <Icon className="w-4 h-4" />
        {label}
      </div>
      <div className="text-2xl font-bold text-cf-text">{value}</div>
    </div>
  )
}

function TopList({
  title,
  items,
}: {
  title: string
  items: { name: string; cost: number; count: number }[]
}) {
  return (
    <div className="bg-cf-panel rounded-lg p-4 border border-cf-border">
      <h2 className="text-sm font-semibold text-cf-text mb-3">{title}</h2>
      {items.length === 0 ? (
        <p className="text-cf-text-muted text-sm">No data</p>
      ) : (
        <div className="space-y-2">
          {items.map(it => (
            <div key={it.name} className="flex items-center justify-between text-sm">
              <span className="text-cf-text truncate">{it.name}</span>
              <span className="text-cf-text-muted text-xs ml-2">
                ${it.cost.toFixed(2)} &middot; {it.count} req
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
