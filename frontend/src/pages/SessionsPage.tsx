import { useState, useEffect, useCallback, useRef, Fragment } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Menu, Transition } from '@headlessui/react'
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
  Search,
  ArrowLeftRight,
  MoreHorizontal,
  ArrowUpDown,
} from 'lucide-react'
import notify from '../components/common/StyledToast'
import SpecHelperPanel from '../components/common/SpecHelperPanel'
import ConfirmDialog from '../components/common/ConfirmDialog'
import Button from '../components/common/Button'
import SessionCompareModal from '../components/SessionCompareModal'
// DemoGallery moved to dedicated /demos page (see DemosPage.tsx)
import { getSessions, deleteSession, copySession, copySessionStructure, exportSessions, importSessionsCheck, importSessionsConfirm, bulkDeleteSessions, listTemplates, applyTemplate, deleteTemplate } from '../services/api'
import type { TemplateResponse } from '../services/api'
import type { SessionListItem, ImportCheckResponse } from '../types'

// Status icons used inside individual session CARDS: animated variants make
// sense here because the session is actually doing work right now.
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

// HOTFIX: Filter PILL icons must NOT animate — the pill is a category
// indicator, not a live status. A spinning Loader2 on an "Enhancing (0)"
// pill looks broken (nothing is enhancing, the count is zero).
const statusFilterIcons: Record<string, JSX.Element> = {
  created: <Clock className="w-4 h-4 text-gray-400" />,
  running: <Play className="w-4 h-4 text-blue-400" />,
  paused: <Pause className="w-4 h-4 text-yellow-400" />,
  completed: <CheckCircle className="w-4 h-4 text-green-400" />,
  failed: <XCircle className="w-4 h-4 text-red-400" />,
  cancelled: <XCircle className="w-4 h-4 text-gray-400" />,
  awaiting_enhancement: <Sparkles className="w-4 h-4 text-purple-400" />,
  enhancing: <Sparkles className="w-4 h-4 text-purple-400" />,
  awaiting_enhancement_review: <Sparkles className="w-4 h-4 text-amber-400" />,
}

// КАО#Full-C-5-FIX-01 (A11Y-1) — status badge contrast.
// Previously: text-gray-500 / text-{color}-400 on bg-{color}-500/15-20 dark
// surface measured 2.6-3.5:1 (WCAG AA fail). Bumped all foreground tokens
// to *-300 which gives 4.5+:1 against the dark card background.
const statusColors: Record<string, string> = {
  created: 'bg-gray-500/15 text-gray-300 dark:text-gray-300',
  running: 'bg-blue-500/30 text-blue-300 font-semibold',
  paused: 'bg-yellow-500/20 text-yellow-300 dark:text-yellow-300',
  completed: 'bg-green-500/20 text-green-300 dark:text-green-300',
  failed: 'bg-red-500/30 text-red-300 font-semibold',
  cancelled: 'bg-gray-500/20 text-gray-300 dark:text-gray-300',
  awaiting_enhancement: 'bg-purple-500/20 text-purple-300 dark:text-purple-300',
  enhancing: 'bg-purple-500/20 text-purple-300 dark:text-purple-300',
  awaiting_enhancement_review: 'bg-amber-500/20 text-amber-300 dark:text-amber-300',
}

const statusLabels: Record<string, string> = {
  awaiting_enhancement: 'Awaiting Enhancement',
  enhancing: 'Enhancing...',
  awaiting_enhancement_review: 'Review Enhancements',
}

// КАО#W4-FIX-01 — known status filter enums (matches statusColors keys plus 'all').
// Used to validate ?status=<enum> from URL before applying it to local state.
const VALID_STATUS_FILTERS = new Set<string>([
  'all',
  'created',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
  'awaiting_enhancement',
  'enhancing',
  'awaiting_enhancement_review',
])

export default function SessionsPage() {
  const [sessions, setSessions] = useState<SessionListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [copying, setCopying] = useState<string | null>(null)
  // КАО#W4-FIX-01 — statusFilter is URL-synced via ?status=<enum>. The URL is
  // the source of truth so Dashboard pills like <Link to="/sessions?status=completed">
  // actually activate the matching filter on landing. Other state (search/sort)
  // remains local-only by design.
  const [searchParams, setSearchParams] = useSearchParams()
  const urlStatus = searchParams.get('status')
  const initialStatusFilter = urlStatus && VALID_STATUS_FILTERS.has(urlStatus) ? urlStatus : 'all'
  const [statusFilter, setStatusFilterState] = useState<string>(initialStatusFilter)

  // Keep local state in sync if the URL changes (e.g. back/forward navigation
  // from a Dashboard pill click).
  useEffect(() => {
    const next = urlStatus && VALID_STATUS_FILTERS.has(urlStatus) ? urlStatus : 'all'
    setStatusFilterState(prev => (prev === next ? prev : next))
    // urlStatus is derived from searchParams; rerunning when it changes is the goal.
  }, [urlStatus])

  // КАО#W4-FIX-01 — wrapper that mirrors statusFilter into the URL. 'all' clears
  // the param so the URL stays clean (/sessions instead of /sessions?status=all).
  // Preserves any other query params already on the URL.
  const setStatusFilter = useCallback((next: string) => {
    setStatusFilterState(next)
    const sp = new URLSearchParams(searchParams)
    if (next === 'all') {
      sp.delete('status')
    } else {
      sp.set('status', next)
    }
    setSearchParams(sp, { replace: true })
  }, [searchParams, setSearchParams])

  // Selection mode for export
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [exporting, setExporting] = useState(false)

  // Search filter
  const [searchQuery, setSearchQuery] = useState('')

  // Bulk delete state
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false)

  // Delete confirmation dialog
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null)

  // Compare sessions modal
  const [compareSessionId, setCompareSessionId] = useState<string | null>(null)

  // Улучшатели#2 P1·S — Sort control. Client-side ordering of the currently loaded list.
  type SortOption = 'newest' | 'oldest' | 'updated' | 'cost' | 'iterations'
  const [sortOption, setSortOption] = useState<SortOption>('newest')

  // Улучшатели#2 P1·S — Apply-template inline validation. Submit-attempt flag triggers
  // red borders on the required fields; before submit they look neutral.
  const [applySubmitAttempted, setApplySubmitAttempted] = useState(false)
  const APPLY_SPEC_MIN_LENGTH = 20

  // Import state
  const [importing, setImporting] = useState(false)
  const [importDialogOpen, setImportDialogOpen] = useState(false)
  const [importCheckResult, setImportCheckResult] = useState<ImportCheckResponse | null>(null)
  const [importFile, setImportFile] = useState<File | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const PAGE_SIZE = 50
  const [hasMore, setHasMore] = useState(true)
  // Улучшатели#7 P3·S — track total session count for "Showing N of M" indicator.
  const [totalSessions, setTotalSessions] = useState<number | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const navigate = useNavigate()

  // Templates panel state
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [templates, setTemplates] = useState<TemplateResponse[]>([])
  const [templatesLoading, setTemplatesLoading] = useState(false)
  const [applyingTemplateId, setApplyingTemplateId] = useState<string | null>(null)
  const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null)
  const [applyDialog, setApplyDialog] = useState<TemplateResponse | null>(null)
  const [applyName, setApplyName] = useState('')
  const [applySpec, setApplySpec] = useState('')
  // Улучшатели#5 P1·M — replace window.confirm() with ConfirmDialog for template delete.
  const [templateDeleteTarget, setTemplateDeleteTarget] = useState<TemplateResponse | null>(null)

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true)
    try {
      const data = await listTemplates()
      setTemplates(data)
    } catch (err: any) {
      notify.error(err?.message || 'Failed to load templates')
    } finally {
      setTemplatesLoading(false)
    }
  }, [])

  function openApplyDialog(t: TemplateResponse) {
    setApplyDialog(t)
    setApplyName(`From ${t.name}`)
    setApplySpec('')
    // Улучшатели#2 P1·S — reset submit-attempt flag so a fresh dialog starts clean.
    setApplySubmitAttempted(false)
  }

  // Улучшатели#2 P1·S — inline validation: derive validity flags from current state.
  // Keep the toast only for transport-level failures (the catch block below).
  const applyNameValid = applyName.trim().length > 0
  const applySpecValid = applySpec.trim().length >= APPLY_SPEC_MIN_LENGTH
  const applyFormValid = applyNameValid && applySpecValid

  async function handleApplyTemplate() {
    if (!applyDialog) return
    if (!applyFormValid) {
      // Surface field-level errors instead of a toast — Улучшатели#2 P1·S.
      setApplySubmitAttempted(true)
      return
    }
    const name = applyName.trim()
    const spec = applySpec.trim()
    setApplyingTemplateId(applyDialog.id)
    try {
      const newSession = await applyTemplate(applyDialog.id, spec, name)
      notify.success('Session created from template')
      setApplyDialog(null)
      navigate(`/sessions/${newSession.id}`)
    } catch (err: any) {
      // Transport-level failure — toast is appropriate here.
      notify.error(err?.message || 'Failed to apply template')
    } finally {
      setApplyingTemplateId(null)
    }
  }

  // Улучшатели#5 P1·M — opens ConfirmDialog instead of using window.confirm().
  function handleDeleteTemplate(t: TemplateResponse) {
    setTemplateDeleteTarget(t)
  }

  async function confirmDeleteTemplate() {
    const t = templateDeleteTarget
    if (!t) return
    setDeletingTemplateId(t.id)
    try {
      await deleteTemplate(t.id)
      setTemplates(prev => prev.filter(x => x.id !== t.id))
      notify.success('Template deleted')
      setTemplateDeleteTarget(null)
    } catch (err: any) {
      notify.error(err?.message || 'Failed to delete template')
    } finally {
      setDeletingTemplateId(null)
    }
  }

  const loadSessions = useCallback(async function loadSessions() {
    try {
      const resp = await getSessions(0, PAGE_SIZE)
      setSessions(resp.items)
      setHasMore(resp.skip + resp.items.length < resp.total)
      // Улучшатели#7 P3·S — capture total for "Showing N of M" footer label.
      setTotalSessions(resp.total)
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
      // Улучшатели#7 P3·S — refresh total in case server count changed mid-pagination.
      setTotalSessions(resp.total)
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

  useEffect(() => {
    if (templatesOpen) {
      loadTemplates()
    }
  }, [templatesOpen, loadTemplates])

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

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return
    setBulkDeleteConfirm(false)
    setBulkDeleting(true)
    const idsToDelete = Array.from(selectedIds)
    try {
      const result = await bulkDeleteSessions(idsToDelete)
      const deletedSet = new Set(idsToDelete.filter(id => !result.failed_ids.includes(id)))
      setSessions(prev => prev.filter(s => !deletedSet.has(s.id)))
      notify.success(`Deleted ${result.deleted_count} session(s)`)
      if (result.failed_ids.length > 0) {
        notify.error(`Failed to delete ${result.failed_ids.length} session(s)`)
      }
      setSelectedIds(new Set())
      setSelectionMode(false)
    } catch (err) {
      notify.error('Bulk delete failed')
    } finally {
      setBulkDeleting(false)
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

  // Улучшатели#2 P1·S — Clear filters: resets search + status filter and sort to defaults.
  // Used by the empty-state "Clear filters" Button when the narrowed list is empty.
  function clearFilters() {
    setSearchQuery('')
    setStatusFilter('all')
    setSortOption('newest')
  }

  // Улучшатели#6 P3·S — formatDate uses browser locale via Intl.DateTimeFormat(undefined,…)
  // instead of hard-coded 'en-US'.
  function formatDate(dateStr: string) {
    const date = new Date(dateStr)
    return new Intl.DateTimeFormat(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold text-cf-text mb-2">Sessions</h1>
            <p className="text-cf-text-muted">
              Manage your code generation sessions
            </p>
          </div>

          {/* Улучшатели#2 P1·S — Header action bar responsive layout.
              Secondary actions (Import / Select / Templates) collapse into a "More" menu below md.
              Primary action (New Session) and contextual selection-mode actions stay visible at all widths. */}
          <div className="flex items-center gap-2 flex-wrap justify-end">
            {/* Import — hidden input always rendered for both inline and menu triggers */}
            <input
              type="file"
              accept=".json"
              ref={fileInputRef}
              onChange={handleImportFileSelected}
              className="hidden"
            />

            {/* Secondary cluster: visible md+ inline; hidden below md (the More menu handles those widths). */}
            <div className="hidden md:flex md:items-center md:gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={importing}
                className="flex items-center gap-2 px-3 py-2 text-cf-text-muted hover:text-cf-text hover:bg-cf-border dark:hover:text-white dark:hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Import sessions from JSON"
                aria-label="Import sessions from JSON file"
              >
                {importing ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />}
                <span className="text-sm">Import</span>
              </button>

              <button
                onClick={() => {
                  setSelectionMode(!selectionMode)
                  if (selectionMode) setSelectedIds(new Set())
                }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm ${
                  selectionMode
                    ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-600/20 dark:text-indigo-400 dark:hover:bg-indigo-600/30'
                    : 'text-cf-text-muted hover:text-cf-text hover:bg-cf-border dark:hover:text-white dark:hover:bg-gray-700'
                }`}
                title="Select sessions for export"
              >
                <List className="w-5 h-5" />
                {selectionMode ? 'Cancel' : 'Select'}
              </button>

              <button
                onClick={() => setTemplatesOpen(o => !o)}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-colors text-sm ${
                  templatesOpen
                    ? 'bg-indigo-100 text-indigo-700 hover:bg-indigo-200 dark:bg-indigo-600/20 dark:text-indigo-400 dark:hover:bg-indigo-600/30'
                    : 'text-cf-text-muted hover:text-cf-text hover:bg-cf-border dark:hover:text-white dark:hover:bg-gray-700'
                }`}
                title="Show session templates"
                aria-label="Toggle templates panel"
                data-tour="templates" /* tour-anchor: templates button (Tour 1, step 4) */
              >
                <LayoutTemplate className="w-5 h-5" />
                Templates
              </button>
            </div>

            {/* Контекстные действия selection-mode остаются inline на всех ширинах —
                они появляются только когда пользователь явно вошёл в режим выбора. */}
            {selectionMode && selectedIds.size > 0 && (
              <button
                onClick={handleExport}
                disabled={exporting || bulkDeleting}
                className="flex items-center gap-2 px-3 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Export selected sessions"
                aria-label="Export selected sessions"
              >
                {exporting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Download className="w-5 h-5" />}
                <span className="text-sm">Export ({selectedIds.size})</span>
              </button>
            )}
            {selectionMode && selectedIds.size > 0 && (
              <button
                onClick={() => setBulkDeleteConfirm(true)}
                disabled={bulkDeleting || exporting}
                className="flex items-center gap-2 px-3 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                title="Delete selected sessions"
                aria-label="Delete selected sessions"
              >
                {bulkDeleting ? <Loader2 className="w-5 h-5 animate-spin" /> : <Trash2 className="w-5 h-5" />}
                <span className="text-sm">Delete Selected ({selectedIds.size})</span>
              </button>
            )}
            {selectionMode && sessions.length > 0 && (
              <button
                onClick={toggleSelectAll}
                className="flex items-center gap-2 px-3 py-2 text-cf-text-muted hover:text-cf-text hover:bg-cf-border dark:hover:text-white dark:hover:bg-gray-700 rounded-lg transition-colors text-sm"
              >
                {selectedIds.size === sessions.length ? (
                  <CheckSquare className="w-4 h-4 text-indigo-700 dark:text-indigo-400" />
                ) : (
                  <Square className="w-4 h-4" />
                )}
                All
              </button>
            )}

            {/* Mobile-only overflow menu — Улучшатели#2 P1·S */}
            <Menu as="div" className="relative md:hidden">
              <Menu.Button
                className="flex items-center gap-2 px-3 py-2 text-cf-text-muted hover:text-cf-text hover:bg-cf-border dark:hover:text-white dark:hover:bg-gray-700 rounded-lg transition-colors"
                title="More actions"
                aria-label="More actions"
              >
                <MoreHorizontal className="w-5 h-5" />
              </Menu.Button>
              <Transition
                as={Fragment}
                enter="transition ease-out duration-100"
                enterFrom="transform opacity-0 scale-95"
                enterTo="transform opacity-100 scale-100"
                leave="transition ease-in duration-75"
                leaveFrom="transform opacity-100 scale-100"
                leaveTo="transform opacity-0 scale-95"
              >
                <Menu.Items className="absolute right-0 mt-2 w-56 origin-top-right rounded-lg bg-gray-800 border border-gray-700 shadow-xl focus:outline-none z-30 py-1">
                  <Menu.Item disabled={importing}>
                    {({ active, disabled }) => (
                      <button
                        onClick={() => fileInputRef.current?.click()}
                        disabled={disabled}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left ${
                          active ? 'bg-gray-700 text-white' : 'text-gray-300'
                        } disabled:opacity-50 disabled:cursor-not-allowed`}
                      >
                        {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                        Import
                      </button>
                    )}
                  </Menu.Item>
                  <Menu.Item>
                    {({ active }) => (
                      <button
                        onClick={() => {
                          setSelectionMode(!selectionMode)
                          if (selectionMode) setSelectedIds(new Set())
                        }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left ${
                          active ? 'bg-gray-700 text-white' : 'text-gray-300'
                        }`}
                      >
                        <List className="w-4 h-4" />
                        {selectionMode ? 'Cancel selection' : 'Select'}
                      </button>
                    )}
                  </Menu.Item>
                  <Menu.Item>
                    {({ active }) => (
                      <button
                        onClick={() => setTemplatesOpen(o => !o)}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left ${
                          active ? 'bg-gray-700 text-white' : 'text-gray-300'
                        }`}
                      >
                        <LayoutTemplate className="w-4 h-4" />
                        {templatesOpen ? 'Hide templates' : 'Templates'}
                      </button>
                    )}
                  </Menu.Item>
                </Menu.Items>
              </Transition>
            </Menu>

            <Link
              to="/sessions/new"
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors"
              data-tour="new-session" /* tour-anchor: New Session button (Tour 1, step 3) */
            >
              <Plus className="w-5 h-5" />
              <span className="hidden sm:inline">New Session</span>
              <span className="sm:hidden">New</span>
            </Link>
          </div>
        </div>

        {/* Featured demos gallery moved to /demos — see DemosPage.tsx
            and the "Demos" sidebar nav item. */}

        {/* Templates panel */}
        {templatesOpen && (
          <div className="bg-gray-800 border border-gray-700 rounded-xl p-4 mb-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <LayoutTemplate className="w-5 h-5 text-indigo-400" />
                Session Templates
              </h2>
              <button
                onClick={loadTemplates}
                disabled={templatesLoading}
                className="text-sm text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-gray-700 disabled:opacity-50"
                title="Refresh templates"
              >
                {templatesLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Refresh'}
              </button>
            </div>
            {templatesLoading ? (
              <div className="text-gray-400 text-sm py-4">Loading…</div>
            ) : templates.length === 0 ? (
              <div className="text-gray-400 text-sm py-4">
                No templates yet. Open a session and click "Save as Template".
              </div>
            ) : (
              <div className="space-y-2">
                {templates.map(t => (
                  <div
                    key={t.id}
                    className="flex items-center justify-between bg-gray-900/40 border border-gray-700 rounded-lg px-3 py-2"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-white font-medium truncate">{t.name}</div>
                      {t.description && (
                        <div className="text-sm text-gray-400 truncate">{t.description}</div>
                      )}
                      <div className="text-xs text-gray-500 mt-0.5">
                        {t.language} · {t.agent_configs?.length || 0} agents · max {t.max_iterations} iters
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-3">
                      <button
                        onClick={() => openApplyDialog(t)}
                        disabled={applyingTemplateId === t.id}
                        className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white text-sm rounded-lg transition-colors"
                      >
                        Use
                      </button>
                      <button
                        onClick={() => handleDeleteTemplate(t)}
                        disabled={deletingTemplateId === t.id}
                        className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded transition-colors"
                        title="Delete template"
                        aria-label={`Delete template ${t.name}`}
                      >
                        {deletingTemplateId === t.id
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Trash2 className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Apply template dialog */}
        {applyDialog && (
          <div
            className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
            onClick={() => applyingTemplateId === null && setApplyDialog(null)}
            onKeyDown={(e) => { if (e.key === 'Escape' && applyingTemplateId === null) setApplyDialog(null) }}
          >
            {/* КАО#R1-10 — role=dialog/aria-modal + Escape (the autoFocused input
                bubbles the keydown up to this container). */}
            <div
              role="dialog"
              aria-modal="true"
              aria-label={`Use template ${applyDialog.name}`}
              className="bg-gray-800 rounded-xl p-6 w-full max-w-lg border border-gray-700"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold text-white mb-1">Use template "{applyDialog.name}"</h3>
              <p className="text-sm text-gray-400 mb-4">
                Creates a new session pre-configured with this template's agents and settings.
              </p>
              {/* Улучшатели#2 P1·S — Inline validation. Required asterisk + red border on submit if invalid. */}
              <label className="block text-sm text-gray-300 mb-1">
                Session name <span className="text-red-400" aria-hidden="true">*</span>
              </label>
              <input
                type="text"
                value={applyName}
                onChange={(e) => setApplyName(e.target.value)}
                maxLength={255}
                autoFocus
                aria-invalid={applySubmitAttempted && !applyNameValid}
                aria-required="true"
                className={`w-full px-3 py-2 bg-gray-900 border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 mb-1 ${
                  applySubmitAttempted && !applyNameValid ? 'border-red-500' : 'border-gray-700'
                }`}
              />
              {applySubmitAttempted && !applyNameValid && (
                <p className="text-xs text-red-400 mb-2">Session name is required.</p>
              )}
              {!(applySubmitAttempted && !applyNameValid) && <div className="mb-2" />}

              <label className="block text-sm text-gray-300 mb-1">
                Specification <span className="text-red-400" aria-hidden="true">*</span>
              </label>
              <textarea
                value={applySpec}
                onChange={(e) => setApplySpec(e.target.value)}
                rows={6}
                placeholder="Describe what the new session should build..."
                aria-invalid={applySubmitAttempted && !applySpecValid}
                aria-required="true"
                className={`w-full px-3 py-2 bg-gray-900 border rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-indigo-500 resize-none ${
                  applySubmitAttempted && !applySpecValid ? 'border-red-500' : 'border-gray-700'
                }`}
              />
              <div className="flex items-center justify-between mt-1 mb-3">
                {applySubmitAttempted && !applySpecValid ? (
                  <p className="text-xs text-red-400">
                    {applySpec.trim().length === 0
                      ? 'Specification is required.'
                      : `Specification must be at least ${APPLY_SPEC_MIN_LENGTH} characters.`}
                  </p>
                ) : (
                  <span />
                )}
                <p
                  className={`text-xs ml-auto ${
                    applySpec.trim().length < APPLY_SPEC_MIN_LENGTH ? 'text-gray-500' : 'text-gray-400'
                  }`}
                  aria-live="polite"
                >
                  {applySpec.trim().length}/{APPLY_SPEC_MIN_LENGTH}+ chars
                </p>
              </div>
              <div className="mb-4">
                <SpecHelperPanel
                  specification={applySpec}
                  language={applyDialog.language}
                  agentConfigs={applyDialog.agent_configs}
                  maxIterations={applyDialog.max_iterations}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setApplyDialog(null)}
                  disabled={applyingTemplateId !== null}
                  className="px-4 py-2 text-gray-300 hover:bg-gray-700 rounded-lg transition-colors disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleApplyTemplate}
                  disabled={applyingTemplateId !== null || !applyFormValid}
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-600 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
                >
                  {applyingTemplateId !== null && <Loader2 className="w-4 h-4 animate-spin" />}
                  Create Session
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Search bar + Sort control — Улучшатели#2 P1·S */}
        {!loading && sessions.length > 0 && (
          <div className="flex flex-col sm:flex-row gap-2 mb-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cf-text-muted dark:text-gray-400" />
              <input
                type="text"
                placeholder="Search sessions by name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search sessions by name"
                className="w-full pl-10 pr-4 py-2 bg-cf-panel dark:bg-gray-800 border border-cf-border dark:border-gray-700 rounded-lg text-cf-text dark:text-white placeholder-cf-text-muted dark:placeholder-gray-500 focus:outline-none focus:border-cf-primary"
              />
            </div>
            {/* Улучшатели#2 P1·S — Sort dropdown. Client-side ordering only. */}
            <div className="relative">
              <ArrowUpDown className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cf-text-muted dark:text-gray-400 pointer-events-none" />
              <select
                value={sortOption}
                onChange={(e) => setSortOption(e.target.value as SortOption)}
                aria-label="Sort sessions"
                title="Sort sessions"
                className="w-full sm:w-56 pl-10 pr-3 py-2 bg-cf-panel dark:bg-gray-800 border border-cf-border dark:border-gray-700 rounded-lg text-cf-text dark:text-white focus:outline-none focus:border-cf-primary appearance-none cursor-pointer"
              >
                <option value="newest">Newest first</option>
                <option value="oldest">Oldest first</option>
                <option value="updated">Recently updated</option>
                <option value="cost">Highest cost</option>
                <option value="iterations">Most iterations</option>
              </select>
            </div>
          </div>
        )}

        {/* Status Filter — Улучшатели#2 P1·M Status filter always visible.
            Every pill always renders regardless of count, so the user can always switch
            between statuses while a filter is active. Zero-count pills are muted. */}
        {!loading && sessions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mb-2">
            {['all', 'created', 'running', 'completed', 'failed', 'paused', 'cancelled', 'awaiting_enhancement', 'enhancing', 'awaiting_enhancement_review'].map(status => {
              const isActive = statusFilter === status
              const count = status === 'all' ? sessions.length : sessions.filter(s => s.status === status).length
              const isEmpty = status !== 'all' && count === 0
              // Улучшатели#2 P1·M — muted style for zero-count pills so they stay clickable
              // but don't compete visually with non-empty statuses.
              const colorClass = status === 'all'
                ? (isActive
                    ? 'bg-indigo-100 text-indigo-700 border-indigo-300 dark:bg-indigo-500/30 dark:text-indigo-200 dark:border-indigo-500/50'
                    : 'bg-cf-panel text-cf-text-muted border-cf-border hover:border-cf-text-muted dark:bg-gray-700/50 dark:text-gray-400 dark:border-gray-600 dark:hover:border-gray-500')
                : (isActive
                  ? (statusColors[status] || 'bg-gray-500/20 text-gray-400') + ' border-current'
                  : isEmpty
                    ? 'bg-cf-bg text-cf-text-muted border-cf-border hover:border-cf-text-muted dark:bg-gray-800/40 dark:text-gray-600 dark:border-gray-700/60 dark:hover:border-gray-600 dark:hover:text-gray-400'
                    : 'bg-cf-panel text-cf-text-muted border-cf-border hover:border-cf-text-muted dark:bg-gray-700/50 dark:text-gray-400 dark:border-gray-600 dark:hover:border-gray-500')
              const label = status === 'all' ? 'All' : (statusLabels[status] || status.charAt(0).toUpperCase() + status.slice(1))
              return (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  aria-pressed={isActive}
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium border transition-colors ${colorClass}`}
                >
                  {status !== 'all' && statusFilterIcons[status]}
                  {label}
                  {/* КАО#Full-C-4 — removed opacity-70: it blended cf-text-muted with bg
                      down to ~3.4:1, failing WCAG AA. Count inherits button text color which
                      is already AA-compliant (text-cf-text-muted #475569 on white = 8.6:1). */}
                  <span className="ml-0.5">({count})</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Улучшатели#2 P1·S — Honest disclosure: search/filter only operate on the loaded subset.
            Visible only when there's a narrowing filter active AND more pages remain on the server. */}
        {!loading && sessions.length > 0 && hasMore && (searchQuery.trim() !== '' || statusFilter !== 'all') && (
          <p className="text-xs text-cf-text-muted dark:text-gray-500 mb-4 italic">
            Showing matches from the first {sessions.length} sessions. Click Load More to search older ones.
          </p>
        )}

        {/* Sessions List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
          </div>
        ) : sessions.length === 0 ? (
          <div
            className="bg-gray-800 rounded-xl p-12 border border-gray-700 text-center"
            data-tour="sessions-list" /* tour-anchor: empty-state stand-in for sessions list (Tour 1, step 2) */
          >
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
          <div className="space-y-3" data-tour="sessions-list" /* tour-anchor: sessions list (Tour 1, step 2) */>
            {(() => {
              const query = searchQuery.trim().toLowerCase()
              const filteredSessions = sessions.filter(s => {
                const statusMatch = statusFilter === 'all' || s.status === statusFilter
                const searchMatch = query === '' || s.name.toLowerCase().includes(query)
                return statusMatch && searchMatch
              })
              // Улучшатели#2 P1·S — Apply sort AFTER search+filter narrowing (client-side).
              const sortedSessions = [...filteredSessions].sort((a, b) => {
                switch (sortOption) {
                  case 'oldest':
                    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
                  case 'updated':
                    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
                  case 'cost':
                    return (b.total_cost ?? 0) - (a.total_cost ?? 0)
                  case 'iterations':
                    return b.current_iteration - a.current_iteration
                  case 'newest':
                  default:
                    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
                }
              })
              if (sortedSessions.length === 0 && !loading) {
                // Улучшатели#2 P1·S — Empty state with Clear filters action.
                // Only show Clear when narrowing is the cause (search/filter active), not on a virgin zero-list.
                const isFiltered = searchQuery.trim() !== '' || statusFilter !== 'all'
                return (
                  <div className="text-center py-12 text-cf-text-muted dark:text-gray-400">
                    <p className="text-lg">No sessions match the current filter</p>
                    <p className="text-sm mt-2 mb-4">
                      {isFiltered
                        ? 'Try clearing the filter, broadening your search, or loading more sessions.'
                        : 'Try creating a new session.'}
                    </p>
                    {isFiltered && (
                      <div className="flex justify-center">
                        <Button variant="ghost" size="md" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      </div>
                    )}
                  </div>
                )
              }
              return sortedSessions.map(session => (
              <div
                key={session.id}
                className={`bg-gray-800 rounded-xl p-4 border-l-4 border-l-transparent border transition-all duration-200 hover:bg-gray-700/40 hover:shadow-lg hover:border-l-cf-primary ${
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
                        <h3 className="text-lg font-semibold text-white group-hover:text-indigo-400 transition-colors truncate">
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
                          Iteration {Math.min(session.current_iteration, session.max_iterations ?? session.current_iteration) /* КАО#R1-09: clamp transient over-cap, matching ITER-FIX in SessionDetailPage */}/{session.max_iterations}
                        </span>
                        <span>
                          Created {session.created_at ? formatDate(session.created_at) : 'Unknown'}
                        </span>
                        {session.total_tokens != null && session.total_tokens > 0 && (
                          <span className="text-xs text-gray-500">
                            {session.total_tokens.toLocaleString()} tokens
                          </span>
                        )}
                        {session.total_cost != null && session.total_cost > 0 && (
                          <span className="text-xs text-gray-500">
                            ${session.total_cost.toFixed(3)}
                          </span>
                        )}
                      </div>
                    </div>

                    <ChevronRight className="w-5 h-5 text-gray-500 group-hover:text-indigo-400 transition-colors" />
                  </Link>

                  {/* Action buttons — Улучшатели#2 P1·S overflow kebab menu.
                      Card body Link to /sessions/:id remains the primary click area (above).
                      All four row actions (Copy / Copy structure / Compare / Delete) live in the
                      kebab menu by default. Compare gets promoted to a top-level toggle ONLY when
                      the user is already in compare-pick mode (i.e., one session is picked and
                      the SessionCompareModal session-picker is open). */}
                  <div className="ml-4 flex items-center gap-1">
                    {compareSessionId !== null && compareSessionId !== session.id && (
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setCompareSessionId(session.id)
                        }}
                        className="p-2 text-gray-500 hover:text-blue-400 hover:bg-blue-500/10 rounded-lg transition-colors"
                        title="Compare with another session"
                        aria-label="Compare session"
                      >
                        <ArrowLeftRight className="w-5 h-5" />
                      </button>
                    )}

                    <Menu as="div" className="relative">
                      {/* HOTFIX: Menu.Button must NOT preventDefault — Headless UI v1's
                          handler-merge utility (R() in utils/render.js) short-circuits the
                          internal toggle when event.defaultPrevented is true, so the menu
                          never opens. The kebab is a sibling of the Link, not a child, so
                          there's no Link click to prevent — drop preventDefault entirely. */}
                      <Menu.Button
                        className="p-2 text-gray-500 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                        title="Session actions"
                        aria-label="Session actions"
                      >
                        {(copying === session.id || deleting === session.id) ? (
                          <Loader2 className="w-5 h-5 animate-spin" />
                        ) : (
                          <MoreHorizontal className="w-5 h-5" />
                        )}
                      </Menu.Button>
                      <Transition
                        as={Fragment}
                        enter="transition ease-out duration-100"
                        enterFrom="transform opacity-0 scale-95"
                        enterTo="transform opacity-100 scale-100"
                        leave="transition ease-in duration-75"
                        leaveFrom="transform opacity-100 scale-100"
                        leaveTo="transform opacity-0 scale-95"
                      >
                        <Menu.Items className="absolute right-0 mt-2 w-56 origin-top-right rounded-lg bg-gray-800 border border-gray-700 shadow-xl focus:outline-none z-20 py-1">
                          {/* HOTFIX: same Headless-UI-v1 quirk as Menu.Button above —
                              user-side preventDefault on these item buttons short-circuits
                              the merged handler chain (incl. close-on-select). Drop
                              preventDefault, keep stopPropagation as a defense against
                              any future parent click handler. */}
                          <Menu.Item disabled={copying === session.id}>
                            {({ active, disabled }) => (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleCopy(session.id)
                                }}
                                disabled={disabled}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left ${
                                  active ? 'bg-gray-700 text-white' : 'text-gray-300'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                              >
                                <Copy className="w-4 h-4" />
                                Copy session
                              </button>
                            )}
                          </Menu.Item>
                          <Menu.Item disabled={copying === session.id}>
                            {({ active, disabled }) => (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleCopyStructure(session.id)
                                }}
                                disabled={disabled}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left ${
                                  active ? 'bg-gray-700 text-white' : 'text-gray-300'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                              >
                                <LayoutTemplate className="w-4 h-4" />
                                Copy structure
                              </button>
                            )}
                          </Menu.Item>
                          <Menu.Item>
                            {({ active }) => (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setCompareSessionId(session.id)
                                }}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left ${
                                  active ? 'bg-gray-700 text-white' : 'text-gray-300'
                                }`}
                              >
                                <ArrowLeftRight className="w-4 h-4" />
                                Compare with another
                              </button>
                            )}
                          </Menu.Item>
                          <div className="my-1 border-t border-gray-700" />
                          <Menu.Item disabled={deleting === session.id}>
                            {({ active, disabled }) => (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleDeleteClick(session.id, session.name)
                                }}
                                disabled={disabled}
                                className={`w-full flex items-center gap-2 px-3 py-2 text-sm text-left ${
                                  active ? 'bg-red-500/15 text-red-300' : 'text-red-400'
                                } disabled:opacity-50 disabled:cursor-not-allowed`}
                              >
                                <Trash2 className="w-4 h-4" />
                                Delete session
                              </button>
                            )}
                          </Menu.Item>
                        </Menu.Items>
                      </Transition>
                    </Menu>
                  </div>
                </div>
              </div>
              ))
            })()}
            {/* Улучшатели#7 P3·S — "Showing N of M sessions" muted indicator above Load More. */}
            {(hasMore || sessions.length > 0) && (
              <div className="flex flex-col items-center pt-4 gap-2">
                <p className="text-xs text-cf-text-muted dark:text-gray-500">
                  {totalSessions !== null
                    ? `Showing ${sessions.length} of ${totalSessions} sessions`
                    : `Showing ${sessions.length} sessions`}
                </p>
                {hasMore && (
                  <button
                    onClick={loadMoreSessions}
                    disabled={loadingMore}
                    className="px-4 py-2 text-sm text-gray-300 bg-gray-800 border border-gray-700 rounded-lg hover:border-gray-500 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loadingMore ? 'Loading...' : 'Load More'}
                  </button>
                )}
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
          onClick={() => setDeleteConfirm(null)}
        >
          <div
            className="bg-gray-800 rounded-xl p-6 border border-gray-700 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
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

      {/* Bulk Delete Confirmation Dialog */}
      {bulkDeleteConfirm && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          role="dialog"
          aria-modal="true"
          aria-label="Delete selected sessions confirmation"
          onKeyDown={(e) => { if (e.key === 'Escape') setBulkDeleteConfirm(false) }}
          onClick={() => { if (!bulkDeleting) setBulkDeleteConfirm(false) }}
        >
          <div
            className="bg-gray-800 rounded-xl p-6 border border-gray-700 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="p-2 bg-red-500/20 rounded-lg">
                <AlertTriangle className="w-6 h-6 text-red-400" />
              </div>
              <h2 className="text-xl font-bold text-white">Delete Selected Sessions</h2>
            </div>

            <p className="text-gray-300 mb-6">
              Are you sure you want to delete <span className="font-semibold text-white">{selectedIds.size}</span> session(s)? This action cannot be undone.
            </p>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setBulkDeleteConfirm(false)}
                className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBulkDelete}
                disabled={bulkDeleting}
                className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {bulkDeleting ? 'Deleting...' : `Delete ${selectedIds.size}`}
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
          onClick={() => {
            if (importing) return
            setImportDialogOpen(false)
            setImportCheckResult(null)
            setImportFile(null)
          }}
        >
          <div
            className="bg-gray-800 rounded-xl p-6 border border-gray-700 max-w-lg w-full mx-4 max-h-[80vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
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

            <p className="text-xs text-cf-text-muted mt-2">
              Duplicate session names will be imported with "(Copy)" suffix appended.
            </p>

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
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {importing ? 'Importing...' : `Import ${importCheckResult.total} session(s)`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Compare Sessions Modal */}
      {compareSessionId && (
        <SessionCompareModal
          sessionAId={compareSessionId}
          availableSessions={sessions.map((s) => ({ id: s.id, name: s.name }))}
          onClose={() => setCompareSessionId(null)}
        />
      )}

      {/* Улучшатели#5 P1·M — ConfirmDialog replaces window.confirm() for template delete. */}
      <ConfirmDialog
        isOpen={templateDeleteTarget !== null}
        onClose={() => {
          if (deletingTemplateId === null) setTemplateDeleteTarget(null)
        }}
        onConfirm={confirmDeleteTemplate}
        title="Delete template?"
        message={`Are you sure you want to delete the template "${templateDeleteTarget?.name ?? ''}"? This cannot be undone.`}
        confirmText="Delete"
        type="danger"
        loading={deletingTemplateId !== null && deletingTemplateId === templateDeleteTarget?.id}
      />
    </div>
  )
}
