import { useEffect, useState } from 'react'
import {
  GitBranch,
  GitCommit as GitCommitIcon,
  FilePlus,
  FileMinus,
  FileText,
  Loader2,
  X,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react'
import {
  getRepoCommits,
  getRepoDiff,
  getPullRequestStatus,
  type GitCommit,
  type GitDiffEntry,
  type PRStatus,
} from '../../services/api'

interface GitPanelProps {
  sessionId: string
  hasRepoAttached: boolean
  prUrl?: string
  onClose?: () => void
}

function formatRelativeTime(unixSec: number): string {
  if (!unixSec) return ''
  const diffSec = Math.floor(Date.now() / 1000) - unixSec
  if (diffSec < 60) return `${diffSec}s ago`
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  if (diffSec < 86400 * 30) return `${Math.floor(diffSec / 86400)}d ago`
  return new Date(unixSec * 1000).toLocaleDateString()
}

function actionBadge(action: GitDiffEntry['action']): { color: string; icon: JSX.Element; label: string } {
  switch (action) {
    case 'added':
      return {
        color: 'bg-green-900/40 text-green-300 border-green-700',
        icon: <FilePlus className="w-3.5 h-3.5" />,
        label: 'added',
      }
    case 'deleted':
      return {
        color: 'bg-red-900/40 text-red-300 border-red-700',
        icon: <FileMinus className="w-3.5 h-3.5" />,
        label: 'deleted',
      }
    case 'modified':
    default:
      return {
        color: 'bg-amber-900/40 text-amber-300 border-amber-700',
        icon: <FileText className="w-3.5 h-3.5" />,
        label: 'modified',
      }
  }
}

export default function GitPanel({ sessionId, hasRepoAttached, prUrl, onClose }: GitPanelProps) {
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [branchName, setBranchName] = useState<string | undefined>()
  const [repoUrl, setRepoUrl] = useState<string | undefined>()
  const [diff, setDiff] = useState<GitDiffEntry[]>([])
  const [loadingCommits, setLoadingCommits] = useState(false)
  const [loadingDiff, setLoadingDiff] = useState(false)
  const [commitsError, setCommitsError] = useState<string | null>(null)
  const [diffError, setDiffError] = useState<string | null>(null)
  const [diffMessage, setDiffMessage] = useState<string | null>(null)

  // PR status
  const [prStatus, setPrStatus] = useState<PRStatus | null>(null)
  const [prToken, setPrToken] = useState('')
  const [prLoading, setPrLoading] = useState(false)
  const [prError, setPrError] = useState<string | null>(null)

  const loadCommits = async () => {
    if (!hasRepoAttached) return
    setLoadingCommits(true)
    setCommitsError(null)
    try {
      const res = await getRepoCommits(sessionId, 20)
      setCommits(res.commits || [])
      setBranchName(res.branch)
      setRepoUrl(res.url)
    } catch (err) {
      setCommitsError(err instanceof Error ? err.message : 'Failed to load commits')
    } finally {
      setLoadingCommits(false)
    }
  }

  const loadDiff = async () => {
    if (!hasRepoAttached) return
    setLoadingDiff(true)
    setDiffError(null)
    setDiffMessage(null)
    try {
      const res = await getRepoDiff(sessionId)
      setDiff(res.diff || [])
      setDiffMessage(res.message || null)
    } catch (err) {
      setDiffError(err instanceof Error ? err.message : 'Failed to load diff')
    } finally {
      setLoadingDiff(false)
    }
  }

  const checkPRStatus = async () => {
    if (!prUrl) return
    setPrLoading(true)
    setPrError(null)
    try {
      const res = await getPullRequestStatus(prUrl, prToken || undefined)
      setPrStatus(res)
    } catch (err) {
      setPrError(err instanceof Error ? err.message : 'Failed to fetch PR status')
    } finally {
      setPrLoading(false)
    }
  }

  useEffect(() => {
    if (hasRepoAttached) {
      loadCommits()
      loadDiff()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, hasRepoAttached])

  if (!hasRepoAttached) {
    return (
      <div className="absolute top-4 right-4 z-30 w-[420px] bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-xl p-4 shadow-xl">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2">
            <GitBranch className="w-4 h-4 text-purple-400" />
            Git Info
          </h3>
          {onClose && (
            <button onClick={onClose} className="p-1 hover:bg-gray-700 rounded">
              <X className="w-4 h-4 text-gray-400" />
            </button>
          )}
        </div>
        <p className="text-xs text-gray-400">No repo attached to this session.</p>
      </div>
    )
  }

  return (
    <div className="absolute top-4 right-4 z-30 w-[460px] max-h-[calc(100vh-2rem)] overflow-y-auto bg-gray-800/95 backdrop-blur-sm border border-gray-700 rounded-xl p-4 shadow-xl space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-purple-400" />
          Git Info
          {branchName && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-900/40 text-purple-300 border border-purple-700">
              {branchName}
            </span>
          )}
        </h3>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              loadCommits()
              loadDiff()
            }}
            className="p-1 hover:bg-gray-700 rounded"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4 text-gray-400" />
          </button>
          {onClose && (
            <button onClick={onClose} className="p-1 hover:bg-gray-700 rounded">
              <X className="w-4 h-4 text-gray-400" />
            </button>
          )}
        </div>
      </div>

      {repoUrl && (
        <a
          href={repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1 break-all"
        >
          {repoUrl} <ExternalLink className="w-3 h-3 shrink-0" />
        </a>
      )}

      {/* Recent Commits */}
      <section>
        <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-2">
          <GitCommitIcon className="w-3.5 h-3.5" />
          Recent Commits
        </h4>
        {loadingCommits ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading commits...
          </div>
        ) : commitsError ? (
          <p className="text-xs text-red-400">{commitsError}</p>
        ) : commits.length === 0 ? (
          <p className="text-xs text-gray-500">No commits found.</p>
        ) : (
          <ul className="space-y-1.5">
            {commits.map((c) => (
              <li key={c.sha} className="bg-gray-700/40 rounded px-2.5 py-1.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm text-gray-200 truncate" title={c.message}>
                    {c.message}
                  </span>
                  <span className="text-xs font-mono text-gray-500 shrink-0">
                    {c.sha.slice(0, 7)}
                  </span>
                </div>
                <div className="text-[11px] text-gray-500 flex items-center gap-2 mt-0.5">
                  <span className="truncate" title={c.author_email}>{c.author_name}</span>
                  <span>·</span>
                  <span>{formatRelativeTime(c.timestamp)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Diff */}
      <section>
        <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-2">
          <FileText className="w-3.5 h-3.5" />
          Changes vs Original
        </h4>
        {loadingDiff ? (
          <div className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin" /> Computing diff...
          </div>
        ) : diffError ? (
          <p className="text-xs text-red-400">{diffError}</p>
        ) : diff.length === 0 ? (
          <p className="text-xs text-gray-500">{diffMessage || 'No changes detected.'}</p>
        ) : (
          <ul className="space-y-1">
            {diff.map((d) => {
              const badge = actionBadge(d.action)
              return (
                <li
                  key={d.path}
                  className="flex items-center gap-2 px-2 py-1 bg-gray-700/40 rounded text-xs"
                >
                  <span
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${badge.color}`}
                  >
                    {badge.icon}
                    {badge.label}
                  </span>
                  <span className="font-mono text-gray-200 truncate flex-1" title={d.path}>
                    {d.path}
                  </span>
                  <span className="text-[11px] text-gray-500 shrink-0">
                    {d.action !== 'added' && <span className="text-red-400">-{d.old_lines}</span>}
                    {d.action !== 'added' && d.action !== 'deleted' && ' '}
                    {d.action !== 'deleted' && <span className="text-green-400">+{d.new_lines}</span>}
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* PR Status */}
      {prUrl && (
        <section>
          <h4 className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-2">
            <GitBranch className="w-3.5 h-3.5" />
            Pull Request Status
          </h4>
          <div className="space-y-2">
            <a
              href={prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-purple-400 hover:text-purple-300 flex items-center gap-1 break-all"
            >
              {prUrl} <ExternalLink className="w-3 h-3 shrink-0" />
            </a>
            <div className="flex gap-2">
              <input
                type="password"
                value={prToken}
                onChange={(e) => setPrToken(e.target.value)}
                placeholder="GitHub token (optional, for private repos)"
                className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
              <button
                onClick={checkPRStatus}
                disabled={prLoading}
                className="flex items-center gap-1 px-2 py-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 rounded text-xs"
              >
                {prLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Check
              </button>
            </div>
            {prError && <p className="text-xs text-red-400">{prError}</p>}
            {prStatus && (
              <div className="bg-gray-700/40 rounded p-2 space-y-1 text-xs">
                <div className="flex items-center gap-2">
                  {prStatus.merged ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-purple-900/40 text-purple-300 border border-purple-700">
                      <CheckCircle2 className="w-3 h-3" /> merged
                    </span>
                  ) : prStatus.state === 'open' ? (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-green-900/40 text-green-300 border border-green-700">
                      <GitBranch className="w-3 h-3" /> open
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-900/40 text-red-300 border border-red-700">
                      <AlertCircle className="w-3 h-3" /> {prStatus.state || 'closed'}
                    </span>
                  )}
                  {prStatus.draft && (
                    <span className="px-2 py-0.5 rounded-full bg-gray-600/40 text-gray-300 border border-gray-500 text-[10px]">
                      draft
                    </span>
                  )}
                  {prStatus.pr_number != null && (
                    <span className="text-gray-400">#{prStatus.pr_number}</span>
                  )}
                </div>
                {prStatus.title && <p className="text-gray-200">{prStatus.title}</p>}
                <div className="grid grid-cols-2 gap-1 text-[11px] text-gray-400">
                  {prStatus.head_ref && (
                    <div>
                      <span className="text-gray-500">head:</span>{' '}
                      <span className="font-mono">{prStatus.head_ref}</span>
                    </div>
                  )}
                  {prStatus.base_ref && (
                    <div>
                      <span className="text-gray-500">base:</span>{' '}
                      <span className="font-mono">{prStatus.base_ref}</span>
                    </div>
                  )}
                  {prStatus.commits != null && (
                    <div>
                      <span className="text-gray-500">commits:</span> {prStatus.commits}
                    </div>
                  )}
                  {prStatus.changed_files != null && (
                    <div>
                      <span className="text-gray-500">files:</span> {prStatus.changed_files}
                    </div>
                  )}
                  {prStatus.additions != null && (
                    <div className="text-green-400">+{prStatus.additions}</div>
                  )}
                  {prStatus.deletions != null && (
                    <div className="text-red-400">-{prStatus.deletions}</div>
                  )}
                  {prStatus.mergeable_state && (
                    <div className="col-span-2">
                      <span className="text-gray-500">mergeable:</span> {prStatus.mergeable_state}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
