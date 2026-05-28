import { Fragment, useState, useRef, useCallback, useEffect } from 'react'
import { Dialog, Transition } from '@headlessui/react'
import { XMarkIcon } from '@heroicons/react/24/outline'
import {
  FileText,
  Paperclip,
  Code,
  Link2,
  Upload,
  Loader2,
  X,
  Archive,
  GitBranch,
  Save,
} from 'lucide-react'
import notify from './StyledToast'
import SpecHelperPanel from './SpecHelperPanel'
import { uploadFiles, fetchRepo, updateSession } from '../../services/api'
import type { AttachmentInfo } from '../../types'

interface SpecificationsDialogProps {
  isOpen: boolean
  onClose: () => void
  /** If provided, saves to backend via PATCH. Otherwise just calls onSaved with local state. */
  sessionId?: string
  specification: string
  initialCode: string
  attachments: AttachmentInfo[]
  /** Optional context for cost estimation. */
  language?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agentConfigs?: any[]
  maxIterations?: number
  onSaved: (data: {
    specification: string
    initial_code: string
    attachments: AttachmentInfo[]
  }) => void
}

export default function SpecificationsDialog({
  isOpen,
  onClose,
  sessionId,
  specification: initialSpecification,
  initialCode: initialInitialCode,
  attachments: initialAttachments,
  language,
  agentConfigs,
  maxIterations,
  onSaved,
}: SpecificationsDialogProps) {
  const [specification, setSpecification] = useState(initialSpecification || '')
  const [initialCode, setInitialCode] = useState(initialInitialCode || '')
  const [attachments, setAttachments] = useState<AttachmentInfo[]>(initialAttachments || [])
  const [repoUrl, setRepoUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [fetchingRepo, setFetchingRepo] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Sync state when dialog opens with fresh props
  useEffect(() => {
    if (isOpen) {
      setSpecification(initialSpecification === '(not set)' ? '' : (initialSpecification || ''))
      setInitialCode(initialInitialCode || '')
      setAttachments(initialAttachments || [])
      setRepoUrl('')
    }
  }, [isOpen, initialSpecification, initialInitialCode, initialAttachments])

  // File upload handlers
  const handleFileUpload = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    try {
      const result = await uploadFiles(files)
      if (result.attachments.length > 0) {
        setAttachments(prev => [...prev, ...result.attachments])
        notify.success(`Attached ${result.attachments.length} item(s)`)
      }
      if (result.errors.length > 0) {
        result.errors.forEach(err => notify.error(err))
      }
    } catch (err) {
      notify.error('Failed to upload files')
      console.error(err)
    } finally {
      setUploading(false)
    }
  }, [])

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    handleFileUpload(files)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [handleFileUpload])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    handleFileUpload(files)
  }, [handleFileUpload])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }, [])

  const addRepoUrl = useCallback(async () => {
    const url = repoUrl.trim()
    if (!url) return
    if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('git@')) {
      notify.error('Please enter a valid git URL')
      return
    }

    setFetchingRepo(true)
    try {
      const result = await fetchRepo({ url })
      if (result.attachment) {
        setAttachments(prev => [...prev, result.attachment])
        const fileCount = result.attachment.file_count || result.attachment.files?.length || 0
        notify.success(`Repository cloned: ${fileCount} files fetched`)
      }
      if (result.errors?.length > 0) {
        result.errors.forEach((err: string) => notify.warning(err))
      }
      setRepoUrl('')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch repository'
      notify.error(msg)
      console.error(err)
    } finally {
      setFetchingRepo(false)
    }
  }, [repoUrl])

  const removeAttachment = useCallback((index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }, [])

  const getAttachmentDisplaySize = (size?: number): string => {
    if (!size) return ''
    if (size < 1024) return `${size} B`
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
    return `${(size / (1024 * 1024)).toFixed(1)} MB`
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // Update session on server (only if sessionId is provided)
      if (sessionId) {
        await updateSession(sessionId, {
          specification: specification || '(not set)',
          initial_code: initialCode,
        })
      }
      // Pass data back to parent to update local state
      onSaved({
        specification: specification || '(not set)',
        initial_code: initialCode,
        attachments,
      })
      notify.success('Specifications saved!')
      onClose()
    } catch (err) {
      notify.error('Failed to save specifications')
      console.error(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Transition appear show={isOpen} as={Fragment}>
      <Dialog as="div" className="relative z-50" onClose={onClose}>
        <Transition.Child
          as={Fragment}
          enter="ease-out duration-300"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-200"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div className="fixed inset-0 bg-black/70 backdrop-blur-md" aria-hidden="true" />
        </Transition.Child>

        <div className="fixed inset-0 overflow-y-auto">
          <div className="flex min-h-full items-center justify-center p-4">
            <Transition.Child
              as={Fragment}
              enter="ease-out duration-300"
              enterFrom="opacity-0 scale-90 translate-y-4"
              enterTo="opacity-100 scale-100 translate-y-0"
              leave="ease-in duration-200"
              leaveFrom="opacity-100 scale-100 translate-y-0"
              leaveTo="opacity-0 scale-90 translate-y-4"
            >
              {/* Улучшатели#5 P1·M — cf-* tokens replace gray-800/gray-900 gradient. */}
              <Dialog.Panel className="relative w-full max-w-2xl transform overflow-hidden rounded-2xl bg-cf-panel text-cf-text border border-cf-border p-6 shadow-2xl transition-all">
                {/* Close button */}
                <button
                  onClick={onClose}
                  aria-label="Close dialog"
                  className="absolute top-4 right-4 text-cf-text-muted hover:text-cf-text transition-colors p-1 rounded-lg hover:bg-cf-hover"
                >
                  <XMarkIcon className="w-5 h-5" />
                </button>

                {/* Header */}
                <div className="flex items-center gap-3 mb-6">
                  <div className="p-3 rounded-xl bg-indigo-100 text-indigo-700 dark:bg-cf-primary/15 dark:text-cf-primary">
                    <FileText className="w-6 h-6" />
                  </div>
                  <div>
                    <Dialog.Title className="text-xl font-bold text-cf-text">
                      Session Specifications
                    </Dialog.Title>
                    <Dialog.Description className="text-sm text-cf-text-muted mt-0.5">
                      Define what you want the agents to build
                    </Dialog.Description>
                  </div>
                </div>

                <div className="space-y-5">
                  {/* Specification */}
                  <div>
                    <label className="block text-sm font-medium text-cf-text mb-1.5">
                      Specification
                    </label>
                    <textarea
                      value={specification}
                      onChange={(e) => setSpecification(e.target.value)}
                      placeholder="Describe what you want the code to do..."
                      rows={6}
                      className="w-full px-4 py-2.5 bg-cf-input border border-cf-border rounded-lg text-cf-text placeholder-cf-text-muted focus:outline-none focus:ring-2 focus:ring-cf-primary resize-none text-sm leading-relaxed"
                    />
                    <div className="mt-2">
                      <SpecHelperPanel
                        specification={specification}
                        language={language}
                        agentConfigs={agentConfigs}
                        maxIterations={maxIterations}
                      />
                    </div>
                  </div>

                  {/* Initial Code */}
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1.5">
                      <Code className="w-4 h-4 inline mr-1.5" />
                      Initial Code
                      <span className="text-gray-500 font-normal ml-2">(optional)</span>
                    </label>
                    <textarea
                      value={initialCode}
                      onChange={(e) => setInitialCode(e.target.value)}
                      placeholder="Paste existing code to improve..."
                      rows={4}
                      className="w-full px-4 py-2.5 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none font-mono text-sm"
                    />
                  </div>

                  {/* Attachments */}
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-1.5">
                      <Paperclip className="w-4 h-4 inline mr-1.5" />
                      Attachments
                      <span className="text-gray-500 font-normal ml-2">
                        Files and repo URLs as context for agents
                      </span>
                    </label>

                    {/* File Drop Zone */}
                    <div
                      onDrop={handleDrop}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onClick={() => fileInputRef.current?.click()}
                      className={`relative border-2 border-dashed rounded-lg p-3 text-center cursor-pointer transition-colors ${
                        dragOver
                          ? 'border-indigo-400 bg-indigo-500/10'
                          : 'border-gray-600 hover:border-gray-500 hover:bg-gray-700/50'
                      }`}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        onChange={handleFileInputChange}
                        className="hidden"
                        accept=".py,.js,.ts,.jsx,.tsx,.java,.go,.rs,.c,.cpp,.h,.hpp,.cs,.rb,.php,.html,.css,.json,.yaml,.yml,.toml,.md,.txt,.csv,.sql,.sh,.bat,.xml,.svg,.ini,.cfg,.env,.dockerfile,.gitignore,.zip,.tar,.tar.gz,.tgz"
                      />
                      {uploading ? (
                        <div className="flex items-center justify-center gap-2 text-indigo-400">
                          <Loader2 className="w-5 h-5 animate-spin" />
                          <span className="text-sm">Uploading...</span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-2 text-gray-400">
                          <Upload className="w-4 h-4" />
                          <span className="text-sm">Drop files here or click to browse</span>
                          <span className="text-gray-500 text-xs">(code, text, .zip, .tar.gz)</span>
                        </div>
                      )}
                    </div>

                    {/* Repo URL Input */}
                    <div className="mt-2 flex gap-2">
                      <div className="flex-1">
                        <input
                          type="text"
                          value={repoUrl}
                          onChange={(e) => setRepoUrl(e.target.value)}
                          placeholder="https://github.com/user/repo"
                          disabled={fetchingRepo}
                          className="w-full px-3 py-2 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRepoUrl() } }}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={addRepoUrl}
                        disabled={!repoUrl.trim() || fetchingRepo}
                        className="px-3 py-2 bg-gray-600 hover:bg-gray-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-white text-sm flex items-center gap-1 transition-colors min-w-[100px] justify-center"
                      >
                        {fetchingRepo ? (
                          <>
                            <Loader2 className="w-4 h-4 animate-spin" />
                            Cloning...
                          </>
                        ) : (
                          <>
                            <Link2 className="w-4 h-4" />
                            Clone Repo
                          </>
                        )}
                      </button>
                    </div>

                    {/* Attached Items List */}
                    {attachments.length > 0 && (
                      <div className="mt-2 space-y-1">
                        {attachments.map((att, idx) => (
                          <div
                            key={idx}
                            className="flex items-center gap-2 px-3 py-1.5 bg-gray-700/60 rounded-lg text-sm"
                          >
                            {att.type === 'file' && <FileText className="w-4 h-4 text-blue-400 shrink-0" />}
                            {att.type === 'archive' && <Archive className="w-4 h-4 text-amber-400 shrink-0" />}
                            {att.type === 'repo_url' && <Link2 className="w-4 h-4 text-green-400 shrink-0" />}
                            {att.type === 'repo' && <GitBranch className="w-4 h-4 text-purple-400 shrink-0" />}

                            <span className="text-gray-200 truncate flex-1">
                              {att.type === 'repo_url' ? (
                                <>
                                  {att.label && <span className="text-gray-400 mr-1">{att.label}:</span>}
                                  {att.url}
                                </>
                              ) : att.type === 'repo' ? (
                                <>
                                  <span className="text-purple-300">{att.repo_name || att.url}</span>
                                  {att.branch && <span className="text-gray-500 ml-1">({att.branch})</span>}
                                  {att.commit && <span className="text-gray-600 ml-1">@{att.commit.slice(0, 7)}</span>}
                                </>
                              ) : (
                                att.filename
                              )}
                            </span>

                            {(att.type === 'archive' || att.type === 'repo') && (att.files?.length || att.file_count) ? (
                              <span className="text-gray-500 text-xs shrink-0">
                                {att.file_count || att.files?.length} files
                              </span>
                            ) : null}

                            {att.size != null && att.size > 0 && (
                              <span className="text-gray-500 text-xs shrink-0">
                                {getAttachmentDisplaySize(att.size)}
                              </span>
                            )}

                            <button
                              type="button"
                              onClick={() => removeAttachment(idx)}
                              className="text-gray-500 hover:text-red-400 transition-colors shrink-0"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-6 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={onClose}
                    disabled={saving}
                    className="text-sm text-gray-500 hover:text-gray-300 transition-colors disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className="flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-gradient-to-r from-indigo-600 to-indigo-700 hover:from-indigo-500 hover:to-indigo-600 rounded-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:opacity-50 shadow-lg shadow-indigo-500/25"
                  >
                    {saving ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Saving...
                      </>
                    ) : (
                      <>
                        <Save className="w-4 h-4" />
                        Save Specifications
                      </>
                    )}
                  </button>
                </div>
              </Dialog.Panel>
            </Transition.Child>
          </div>
        </div>
      </Dialog>
    </Transition>
  )
}
