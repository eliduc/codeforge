import { useEffect, useState } from 'react'
import {
  Webhook as WebhookIcon,
  Plus,
  Trash2,
  TestTube,
  Edit3,
  Loader2,
  CheckCircle,
  XCircle,
  X,
} from 'lucide-react'
import notify from './common/StyledToast'
import Button from './common/Button'
import ConfirmDialog from './common/ConfirmDialog'
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  type WebhookResponseT,
  type WebhookType,
  type WebhookCreateRequest,
} from '../services/api'

const ALL_EVENTS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'workflow_completed', label: 'Session completed' },
  { key: 'workflow_error', label: 'Session failed' },
  { key: 'workflow_cancelled', label: 'Session cancelled' },
  { key: 'awaiting_enhancement', label: 'Awaiting enhancement' },
]

interface FormState {
  name: string
  url: string
  webhook_type: WebhookType
  selectedEvents: Set<string>
  allEvents: boolean
  secret: string
  enabled: boolean
}

const emptyForm = (): FormState => ({
  name: '',
  url: '',
  webhook_type: 'generic',
  selectedEvents: new Set(),
  allEvents: true,
  secret: '',
  enabled: true,
})

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

export default function WebhooksSection() {
  const [webhooks, setWebhooks] = useState<WebhookResponseT[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm())
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  // Улучшатели#5 P1·M — replace window.confirm() with ConfirmDialog.
  const [deleteTarget, setDeleteTarget] = useState<WebhookResponseT | null>(null)
  const [deleting, setDeleting] = useState(false)

  async function refresh() {
    try {
      const list = await listWebhooks()
      setWebhooks(list)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load webhooks'
      notify.error(msg)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function startCreate() {
    setEditingId(null)
    setForm(emptyForm())
    setShowForm(true)
  }

  function startEdit(wh: WebhookResponseT) {
    const filterStr = wh.event_filter
    const selected = new Set<string>(
      filterStr ? filterStr.split(',').map(s => s.trim()).filter(Boolean) : []
    )
    setEditingId(wh.id)
    setForm({
      name: wh.name,
      url: wh.url,
      webhook_type: wh.webhook_type,
      selectedEvents: selected,
      allEvents: !filterStr,
      secret: '',
      enabled: wh.enabled,
    })
    setShowForm(true)
  }

  function cancelForm() {
    setShowForm(false)
    setEditingId(null)
    setForm(emptyForm())
  }

  function toggleEvent(key: string) {
    setForm(f => {
      const next = new Set(f.selectedEvents)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { ...f, selectedEvents: next }
    })
  }

  async function handleSubmit() {
    if (!form.name.trim()) {
      notify.error('Name is required')
      return
    }
    if (!form.url.trim() || !/^https?:\/\//.test(form.url.trim())) {
      notify.error('URL must start with http:// or https://')
      return
    }

    const event_filter = form.allEvents
      ? null
      : Array.from(form.selectedEvents).join(',') || null

    if (!form.allEvents && !event_filter) {
      notify.error('Select at least one event, or choose "All events"')
      return
    }

    setSaving(true)
    try {
      if (editingId) {
        // PATCH — only send fields that may have changed.
        const patch: Partial<WebhookCreateRequest> = {
          name: form.name.trim(),
          url: form.url.trim(),
          webhook_type: form.webhook_type,
          event_filter,
          enabled: form.enabled,
        }
        // Only update secret if user typed something. Empty string clears it.
        if (form.secret !== '') patch.secret = form.secret
        await updateWebhook(editingId, patch)
        notify.success('Webhook updated')
      } else {
        const payload: WebhookCreateRequest = {
          name: form.name.trim(),
          url: form.url.trim(),
          webhook_type: form.webhook_type,
          event_filter,
          enabled: form.enabled,
          secret: form.secret || null,
        }
        await createWebhook(payload)
        notify.success('Webhook created')
      }
      cancelForm()
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Save failed'
      notify.error(msg)
    } finally {
      setSaving(false)
    }
  }

  // Улучшатели#5 P1·M — open ConfirmDialog instead of using window.confirm().
  function handleDelete(wh: WebhookResponseT) {
    setDeleteTarget(wh)
  }

  async function confirmDelete() {
    const wh = deleteTarget
    if (!wh) return
    setDeleting(true)
    setBusyId(wh.id)
    try {
      await deleteWebhook(wh.id)
      notify.success('Webhook deleted')
      setDeleteTarget(null)
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed'
      notify.error(msg)
    } finally {
      setDeleting(false)
      setBusyId(null)
    }
  }

  async function handleTest(wh: WebhookResponseT) {
    setBusyId(wh.id)
    try {
      const result = await testWebhook(wh.id)
      if (result.success) {
        notify.success(`Test sent (HTTP ${result.status_code})`)
      } else {
        notify.error(`Test failed: ${result.error || 'unknown error'}`)
      }
      await refresh()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Test failed'
      notify.error(msg)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
    <div className="bg-cf-panel rounded-xl p-6 border border-cf-border mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-cf-text flex items-center gap-2">
          <WebhookIcon className="w-5 h-5 text-cf-primary" />
          Webhooks
        </h2>
        {/* Улучшатели#5 P1·M — Button primitive. */}
        <Button
          variant="primary"
          size="sm"
          onClick={startCreate}
          leadingIcon={<Plus className="w-4 h-4" />}
        >
          {/* Улучшатели#5 P2·S — sentence-case action label. */}
          Add webhook
        </Button>
      </div>

      <p className="text-sm text-cf-text-muted mb-4">
        Receive notifications when significant events happen (session
        completed, failed, awaiting enhancement). Slack, Discord, and generic
        JSON formats are supported.
      </p>

      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 text-cf-primary animate-spin" />
        </div>
      ) : webhooks.length === 0 && !showForm ? (
        <div className="text-sm text-cf-text-muted bg-cf-bg rounded-lg p-4 text-center">
          No webhooks configured yet.
        </div>
      ) : (
        <div className="space-y-2">
          {webhooks.map(wh => {
            const lastOk =
              wh.last_status !== null && wh.last_status >= 200 && wh.last_status < 300
            return (
              <div
                key={wh.id}
                className="bg-cf-bg rounded-lg p-4 flex items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                      wh.enabled ? 'bg-green-500/20' : 'bg-cf-border'
                    }`}
                  >
                    {wh.enabled ? (
                      <CheckCircle className="w-5 h-5 text-green-400" />
                    ) : (
                      <XCircle className="w-5 h-5 text-cf-text-muted" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-cf-text truncate">
                        {wh.name}
                      </span>
                      <span className="px-2 py-0.5 text-xs rounded bg-cf-border text-cf-text-muted uppercase">
                        {wh.webhook_type}
                      </span>
                    </div>
                    <div className="text-xs text-cf-text-muted font-mono truncate">
                      {truncate(wh.url, 80)}
                    </div>
                    <div className="text-xs text-cf-text-muted mt-1">
                      Sent: {wh.total_sent} · Failed: {wh.total_failed}
                      {wh.last_status !== null && (
                        <>
                          {' · Last: '}
                          <span className={lastOk ? 'text-green-400' : 'text-red-400'}>
                            HTTP {wh.last_status}
                          </span>
                        </>
                      )}
                      {wh.last_error && !lastOk && (
                        <> — <span className="text-red-400">{truncate(wh.last_error, 50)}</span></>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => handleTest(wh)}
                    disabled={busyId === wh.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-cf-border hover:bg-cf-hover disabled:opacity-40 text-cf-text text-xs font-medium rounded-lg transition-colors"
                    title="Send a test event"
                  >
                    {busyId === wh.id ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <TestTube className="w-3.5 h-3.5" />
                    )}
                    Test
                  </button>
                  <button
                    onClick={() => startEdit(wh)}
                    disabled={busyId === wh.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-cf-border hover:bg-cf-hover disabled:opacity-40 text-cf-text text-xs font-medium rounded-lg transition-colors"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Edit
                  </button>
                  <button
                    onClick={() => handleDelete(wh)}
                    disabled={busyId === wh.id}
                    className="flex items-center gap-1 px-2.5 py-1.5 bg-red-500/20 hover:bg-red-500/30 disabled:opacity-40 text-red-400 text-xs font-medium rounded-lg transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showForm && (
        <div className="mt-4 bg-cf-bg rounded-lg p-4 border border-cf-border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-cf-text">
              {editingId ? 'Edit Webhook' : 'New Webhook'}
            </h3>
            <button
              onClick={cancelForm}
              className="text-cf-text-muted hover:text-cf-text"
              aria-label="Close form"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-cf-text-muted mb-1" htmlFor="webhook-name-input">Name</label>
              <input
                id="webhook-name-input"
                type="text"
                value={form.name}
                onChange={e => setForm({ ...form, name: e.target.value })}
                placeholder="My Slack alert"
                className="w-full px-3 py-2 bg-cf-input border border-cf-border rounded-lg text-cf-text placeholder-cf-text-muted text-sm focus:outline-none focus:ring-2 focus:ring-cf-primary"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-cf-text-muted mb-1" htmlFor="webhook-type-select">Type</label>
              <select
                id="webhook-type-select"
                value={form.webhook_type}
                onChange={e => setForm({ ...form, webhook_type: e.target.value as WebhookType })}
                aria-label="Webhook type"
                className="w-full px-3 py-2 bg-cf-input border border-cf-border rounded-lg text-cf-text text-sm focus:outline-none focus:ring-2 focus:ring-cf-primary"
              >
                <option value="slack">Slack</option>
                <option value="discord">Discord</option>
                <option value="generic">Generic JSON</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-cf-text-muted mb-1" htmlFor="webhook-url-input">URL</label>
              <input
                id="webhook-url-input"
                type="text"
                value={form.url}
                onChange={e => setForm({ ...form, url: e.target.value })}
                placeholder="https://hooks.slack.com/services/..."
                className="w-full px-3 py-2 bg-cf-input border border-cf-border rounded-lg text-cf-text placeholder-cf-text-muted text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cf-primary"
              />
            </div>

            <div className="md:col-span-2">
              {/* КАО#R4-S5 — name the checkbox group for AT (was an orphan label) */}
              <div className="block text-xs font-medium text-cf-text-muted mb-1" id="webhook-events-label">
                Events
              </div>
              <div className="flex flex-wrap gap-2" role="group" aria-labelledby="webhook-events-label">
                <label className="flex items-center gap-1.5 text-sm text-cf-text cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.allEvents}
                    onChange={e => setForm({ ...form, allEvents: e.target.checked })}
                  />
                  All events
                </label>
                {!form.allEvents && ALL_EVENTS.map(ev => (
                  <label
                    key={ev.key}
                    className="flex items-center gap-1.5 text-sm text-cf-text cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={form.selectedEvents.has(ev.key)}
                      onChange={() => toggleEvent(ev.key)}
                    />
                    {ev.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-cf-text-muted mb-1" htmlFor="webhook-secret-input">
                HMAC secret (optional)
              </label>
              <input
                id="webhook-secret-input"
                type="password"
                value={form.secret}
                onChange={e => setForm({ ...form, secret: e.target.value })}
                placeholder={editingId ? '(leave blank to keep, type to change)' : 'Optional shared secret'}
                className="w-full px-3 py-2 bg-cf-input border border-cf-border rounded-lg text-cf-text placeholder-cf-text-muted text-sm font-mono focus:outline-none focus:ring-2 focus:ring-cf-primary"
              />
              <p className="text-xs text-cf-text-muted mt-1">
                If set, the X-CodeForge-Signature header will contain the HMAC-SHA256 of the payload.
              </p>
            </div>

            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="webhook-enabled"
                type="checkbox"
                checked={form.enabled}
                onChange={e => setForm({ ...form, enabled: e.target.checked })}
              />
              <label htmlFor="webhook-enabled" className="text-sm text-cf-text cursor-pointer">
                Enabled
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2 mt-4">
            <button
              onClick={cancelForm}
              disabled={saving}
              className="px-4 py-2 bg-cf-border hover:bg-cf-hover text-cf-text text-sm font-medium rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 bg-cf-primary hover:bg-cf-secondary disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              {editingId ? 'Save changes' : 'Create webhook'}
            </button>
          </div>
        </div>
      )}
    </div>
    {/* Улучшатели#5 P1·M — ConfirmDialog replaces window.confirm() for delete. */}
    <ConfirmDialog
      isOpen={deleteTarget !== null}
      onClose={() => { if (!deleting) setDeleteTarget(null) }}
      onConfirm={confirmDelete}
      title="Delete webhook?"
      message={`Are you sure you want to delete "${deleteTarget?.name ?? ''}"? This cannot be undone.`}
      confirmText="Delete"
      type="danger"
      loading={deleting}
    />
    </>
  )
}
