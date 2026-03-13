import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import {
  Plus,
  Play,
  Pause,
  CheckCircle,
  XCircle,
  Clock,
  Loader2,
  Trash2,
  ChevronRight,
  Copy,
  Download,
  Upload,
  CheckSquare,
  Square,
  X,
  List,
  AlertTriangle,
  Sparkles,
  LayoutTemplate,
} from 'lucide-react'
import notify from '../components/common/StyledToast'
import { getSessions, deleteSession, copySession, copySessionStructure, exportSessions, importSessionsCheck, importSessionsConfirm } from '../services/api'
import type { SessionListItem, ImportCheckResponse } from '../types'

const statusIcons: Record<string, JSX.Element> = {
  created: <Clock className="w-4 h-4 text-gray-400" />,
  running: <Play className="w-4 h-4 text-blue-400 animate-pulse" />,
  paused: <Pause className="w-4 h-4 text-yellow-400" />,
  completed: <CheckCircle className="w-4 h-4 text-green-400" />,
  failed: <XCircle className="w-4 h-4 text-red-400" />,
  cancelled: <XCircle className="w-4 h-4 text-gray-400" />,
  awaiting_enhancement: <Sparkles className="w-4 h-4 text-purple-400" />,
  enhancing: <Loader2 className="w-4 h-4 text-purple-400 animate-spin" />,
  awaiting_enhancement_review: <Sparkles className="w-4 h-4 text-amber-400" />,
}

const statusColors: Record<string, string> = {
  created: 'bg-gray-500/20 text-gray-400',
  running: 'bg-blue-500/20 text-blue-400',
  paused: 'bg-yellow-500/20 text-yellow-400',
  completed: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
  cancelled: 'bg-gray-500/20 text-gray-400',
  awaiting_enhancement: 'bg-purple-500/20 text-purple-400',
  enhancing: 'bg-purple-500/20 text-purple-400',
  awaiting_enhancement_review: 'bg-amber-500/20 text-amber-400',
}

const statusLabels: Record<string, string> = {
  awaiting_enhancement: 'Awaiting Enhancement',
  enhancing: 'Enhancing...',
  awaiting_enhancement_review: 'Review Enhancements',
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [copying, setCopying] = useState<string | null>(null)

  // Selection mode for export
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)

  // Delete confirmation dialog
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)

  // Import state
  const [importing, setImporting] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importCheckResult, setImportCheckResult] = useState<ImportCheckResponse | null>(null)
  const [importFile, setImportFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const PAGE_SIZE = 50
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  const loadSessions = useCallback(async function loadSessions() {
    try {
      const resp = await getSessions(0, PAGE_SIZE)
      setSessions(resp.items)
      setHasMore(resp.skip + resp.items.length < resp.total)
    } catch (err) {
      notify.error('Failed to load sessions')
      console.error(err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMoreSessions = useCallback(async function loadMoreSessions() {
    if (loadingMore) return
    setLoadingMore(true)
    try {
      const resp = await getSessions(sessions.length, PAGE_SIZE)
      setSessions(prev => {
        // Deduplicate: only append items not already present
        const existingIds = new Set(prev.map(s => s.id))
        const newItems = resp.items.filter(item => !existingIds.has(item.id))
        return [...prev, ...newItems]
      })
      setHasMore(resp.skip + resp.items.length < resp.total)
    } catch (err) {
      notify.error('Failed to load more sessions')
      console.error(err)
    } finally {
      setLoadingMore(false)
    }
  }, [sessions.length, loadingMore])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  function handleDeleteClick(id: string, name: string) {
    setDeleteConfirm({ id, name })
  }

  async function handleDeleteConfirm() {
    if (!deleteConfirm) return
    const { id } = deleteConfirm
    setDeleteConfirm(null)

    setDeleting(id)
    try {
      await deleteSession(id)
      setSessions(prev => prev.filter(s => s.id !== id))
      setSelectedIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      notify.success('Session deleted')
    } catch (err) {
      notify.error('Failed to delete session')
    } finally {
      setDeleting(null)
    }
  }

  async function handleCopy(id: string) {
    setCopying(id)
    try {
      const newSession = await copySession(id)
      setSessions(prev => [
        {
          id: newSession.id,
          name: newSession.name,
          status: newSession.status as SessionListItem['status'],
          current_iteration: newSession.current_iteration,
          max_iterations: newSession.max_iterations,
          language: newSession.language,
          parent_session_id: newSession.parent_session_id || undefined,
          enhancement_round: newSession.enhancement_round,
          created_at: newSession.created_at,
          updated_at: newSession.updated_at,
        },
        ...prev,
      ])
      notify.success('Session copied')
    } catch (err) {
      notify.error('Failed to copy session')
    } finally {
      setCopying(null)
    }
  }

  async function handleCopyStructure(id: string) {
    setCopying(id)
    try {
      const newSession = await copySessionStructure(id)
      setSessions(prev => [
        {
          id: newSession.id,
          name: newSession.name,
          status: newSession.status as SessionListItem['status'],
          current_iteration: newSession.current_iteration,
          max_iterations: newSession.max_iterations,
          language: newSession.language,
          parent_session_id: newSession.parent_session_id || undefined,
          enhancement_round: newSession.enhancement_round,
          created_at: newSession.created_at,
          updated_at: newSession.updated_at,
        },
        ...prev,
      ])
      notify.success('Structure copied')
    } catch (err) {
      notify.error('Failed to copy structure')
    } finally {
      setCopying(null)
    }
  }

  function toggleSelection(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  function toggleSelectAll() {
    if (selectedIds.size === sessions.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(sessions.map(s => s.id)))
    }
  }

  async function handleExport() {
    if (selectedIds.size === 0) return
    setExporting(true)
    try {
      const blob = await exportSessions(Array.from(selectedIds))
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `codeforge-export-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      notify.success(`Exported ${selectedIds.size} session(s)`)
      setSelectionMode(false)
      setSelectedIds(new Set())
    } catch (err) {
      notify.error('Failed to export sessions')
    } finally {
      setExporting(false)
    }
  }

  async function handleImportFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportFile(file)
    setImporting(true)
    try {
      const checkResult = await importSessionsCheck(file)
      if (checkResult.has_duplicates) {
        setImportCheckResult(checkResult)
        setImportDialogOpen(true)
      } else {
        // No duplicates — import directly
        const result = await importSessionsConfirm(file)
        notify.success(result.message)
        await loadSessions()
      }
    } catch (err) {
      notify.error(`Failed to import: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setImporting(false)
      e.target.value = ''
    }
  }

  async function handleImportConfirm() {
    if (!importFile) return
    setImporting(true)
    try {
      const result = await importSessionsConfirm(importFile)
      notify.success(result.message)
      setImportDialogOpen(false)
      setImportCheckResult(null)
      setImportFile(null)
      await loadSessions()
    } catch (err) {
      notify.error(`Failed to import: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setImporting(false)
    }
  }

  function formatDate(dateStr: string) {
    const date = new Date(dateStr)
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-white mb-2">Sessions</h1>
            <p className="text-gray-400">
              Manage your code generation sessions
            </p>
          </div>

          <div className="flex items-center gap-2">
            {/* Import */}
            <input
              type="file"
              accept=".json"
              ref={fileInputRef}
              onChange={handleImportFileSelected}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={importing}
              className="flex items-center gap-2 px-3 py-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
              title="Import sessions from JSON"
            >
              {importing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
              <span className="text-sm">Import</span>
            </button>

            {/* Selection mode toggle */}
            <button
              onClick={() => {
                setSelectionMode(!selectionMode)
                if (selectionMode) setSelectedIds(new Set())
              }}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm ${
                selectionMode
                  ? 'bg-indigo-600/20 text-indigo-400 hover:bg-indigo-600/30'
                  : 'text-gray-400 hover:text-white hover:bg-gray-700'
              }`}
              title="Select sessions for export"
            >
              <List className="w-5 h-5" />
              {selectionMode ? 'Cancel' : 'Select'}
            </button>

            {/* Export button (visible in selection mode with selections) */}
            {selectionMode && selectedIds.size > 0 && (
              <button
                onClick={handleExport}
                disabled={exporting}
                className="flex items-center gap-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {exporting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
                <span className="text-sm">Export ({selectedIds.size})</span>
              </button>
            )}

            {/* Select All (in selection mode) */}
            {selectionMode && sessions.length > 0 && (
              <button
                onClick={toggleSelectAll}
                className="flex items-center gap-2 px-3 py-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors text-sm"
              >
                {selectedIds.size === sessions.length ? (
                  <CheckSquare className="w-4 h-4 text-indigo-400" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
                All
              </button>
            )}

            <Link
              to="/sessions/new"
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors"
            >
              <Plus className="w-5 h-5" />
              New Session
            </Link>
          </div>
        </div>

        {/* Sessions List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="bg-gray-800 rounded-xl p-12 border border-gray-700 text-center">
            <div className="text-gray-400 mb-4">No sessions yet</div>
            <Link
              to="/sessions/new"
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors"
            >
              <Plus className="w-5 h-5" />
              Create your first session
            </Link>
          </div>
        ) : (
          <div className="space-y-3">
            {sessions.map(session => (
              <div
                key={session.id}
                className={`bg-gray-800 rounded-xl p-4 border transition-colors ${
                  selectionMode && selectedIds.has(session.id)
                    ? 'border-indigo-500/50 bg-indigo-600/5'
                    : 'border-gray-700 hover:border-gray-600'
                }`}
              >
                <div className="flex items-center justify-between">
                  {/* Checkbox (selection mode) */}
                  {selectionMode && (
                    <button
                      onClick={() => toggleSelection(session.id)}
                      className="mr-3 p-1 rounded hover:bg-gray-700 transition-colors"
                    >
                      {selectedIds.has(session.id) ? (
                        <CheckSquare className="w-5 h-5 text-indigo-400" />
                      ) : (
                        <Square className="w-5 h-5 text-gray-500" />
                      )}
                    </button>
                  )}

                  <Link
                    to={`/sessions/${session.id}`}
                    className="flex-1 flex items-center gap-4 group"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-1">
                        <h3 className="text-lg font-semibold text-white group-hover:text-indigo-400 transition-colors">
                          {session.name}
                        </h3>
                        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[session.status] || 'bg-gray-500/20 text-gray-400'}`}>
                          {statusIcons[session.status]}
                          {statusLabels[session.status] || session.status}
                        </span>
                        {session.enhancement_round > 0 && (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/20 text-purple-300">
                            Enhancement #{session.enhancement_round}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-4 text-sm text-gray-400">
                        <span className="font-mono bg-gray-700/50 px-2 py-0.5 rounded">
                          {({
                            javascript_browser: 'JS (Browser)',
                            javascript: 'JS (Node.js)',
                            typescript_browser: 'TS (Browser)',
                            typescript: 'TypeScript',
                            python: 'Python',
                          } as Record<string, string>)[session.language] || session.language}
                        </span>
                        <span>
                          Iteration {session.current_iteration}/{session.max_iterations}
                        </span>
                        <span>
                          Created {session.created_at ? formatDate(session.created_at) : 'Unknown'}
                        </span>
                      </div>
                    </div>

                    <ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-indigo-400 transition-colors" />
                  </Link>

                  {/* Action buttons */}
                  <div className="ml-4 flex items-center gap-1">
                    {/* Copy */}
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        handleCopy(session.id)
                      }}
                      disabled={copying === session.id}
                      className="p-2 text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors disabled:opacity-50"
                      title="Copy session"
                    >
                      {copying === session.id ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <Copy className="w-5 h-5" />
                      )}
                    </button>

                    {/* Copy Structure */}
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        handleCopyStructure(session.id)
                      }}
                      disabled={copying === session.id}
                      className="p-2 text-gray-500 hover:text-purple-400 hover:bg-purple-500/10 rounded-lg transition-colors disabled:opacity-50"
                      title="Copy structure (without content)"
                    >
                      {copying === session.id ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <LayoutTemplate className="w-5 h-5" />
                      )}
                    </button>

                    {/* Delete */}
                    <button
                      onClick={(e) => {
                        e.preventDefault()
                        handleDeleteClick(session.id, session.name)
                      }}
                      disabled={deleting === session.id}
                      className="p-2 text-gray-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                      title="Delete session"
                    >
                      {deleting === session.id ? (
                        <Loader2 className="w-5 h-5 animate-spin" />
                      ) : (
                        <Trash2 className="w-5 h-5" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {hasMore && (
              <div className="flex justify-center pt-4">
                <button
                  onClick={loadMoreSessions}
                  disabled={loadingMore}
                  className="px-4 py-2 text-sm text-gray-300 bg-gray-800 border border-gray-700 rounded-lg hover:border-gray-500 hover:text-white transition-colors disabled:opacity-50"
                >
                  {loadingMore ? 'Loading...' : 'Load More'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      {deleteConfirm && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          role="dialog"
          aria-modal="true"
          aria-label="Delete session confirmation"
          onKeyDown={(e) => { if (e.key === 'Escape') setDeleteConfirm(null) }}
        >
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 max-w-md w-full mx-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-500/20 rounded-lg">
                <AlertTriangle className="w-6 h-6 text-red-400" />
              </div>
              <h2 className="text-xl font-bold text-white">Delete Session</h2>
            </div>

            <p className="text-gray-300 mb-6">
              Are you sure you want to delete <span className="font-semibold text-white">&quot;{deleteConfirm.name}&quot;</span>? This action cannot be undone.
            </p>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteConfirm}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import Confirmation Dialog */}
      {importDialogOpen && importCheckResult && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          role="dialog"
          aria-modal="true"
          aria-label="Import sessions confirmation"
          onKeyDown={(e) => { if (e.key === 'Escape') { setImportDialogOpen(false); setImportCheckResult(null); setImportFile(null) } }}
        >
          <div className="bg-gray-800 rounded-xl p-6 border border-gray-700 max-w-lg w-full mx-4 max-h-[80vh] overflow-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-white">Import Sessions</h2>
              <button
                onClick={() => {
                  setImportDialogOpen(false)
                  setImportCheckResult(null)
                  setImportFile(null)
                }}
                className="p-1 rounded hover:bg-gray-700 transition-colors"
              >
                <X className="w-5 h-5 text-gray-400 hover:text-white" />
              </button>
            </div>

            {importCheckResult.duplicates.length > 0 && (
              <div className="mb-4">
                <h3 className="text-yellow-400 font-medium mb-2">
                  Duplicate sessions found ({importCheckResult.duplicates.length})
                </h3>
                <p className="text-gray-400 text-sm mb-2">
                  These sessions already exist. They will be imported with &quot;(Copy)&quot; appended to their names.
                </p>
                <ul className="space-y-1">
                  {importCheckResult.duplicates.map((d, i) => (
                    <li key={i} className="text-gray-300 text-sm bg-gray-700/50 px-3 py-2 rounded">
                      <div className="font-medium">{d.name}</div>
                      <div className="text-gray-500 text-xs mt-0.5 truncate">{d.specification_preview}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {importCheckResult.new_sessions.length > 0 && (
              <div className="mb-4">
                <h3 className="text-green-400 font-medium mb-2">
                  New sessions ({importCheckResult.new_sessions.length})
                </h3>
                <ul className="space-y-1">
                  {importCheckResult.new_sessions.map((s, i) => (
                    <li key={i} className="text-gray-300 text-sm bg-gray-700/50 px-3 py-2 rounded">
                      <div className="font-medium">{s.name}</div>
                      <div className="text-gray-500 text-xs mt-0.5 truncate">{s.specification_preview}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setImportDialogOpen(false)
                  setImportCheckResult(null)
                  setImportFile(null)
                }}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImportConfirm}
                disabled={importing}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {importing ? 'Importing...' : `Import ${importCheckResult.total} session(s)`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
