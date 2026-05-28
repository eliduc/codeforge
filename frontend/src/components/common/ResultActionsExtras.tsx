import { useState } from 'react'
import {
  Share2,
  TestTube,
  BookOpen,
  Loader2,
  Copy,
  Check,
  Download,
  AlertCircle,
  Trash2,
  ExternalLink,
  Rocket,
} from 'lucide-react'
import notify from './StyledToast'
import Modal from './Modal'
import {
  createShareLink,
  revokeShareLink,
  generateTests,
  generateDocs,
  deployToVercel,
  type GenerateTestsResponse,
  type GenerateDocsResponse,
  type VercelDeployResponse,
} from '../../services/api'

interface ResultActionsExtrasProps {
  sessionId: string
  /** Hint for filename of generated tests. */
  language?: string
}

type Modal = null | 'share' | 'tests' | 'docs' | 'deploy'

const DEPLOY_SUPPORTED_LANGUAGES = ['html', 'javascript', 'typescript']

interface SharedState {
  shareUrl: string
  shareToken: string
}

// Улучшатели#5 P1·M — rescued from hand-rolled <div> modal (no role="dialog",
// no focus trap, no Esc). Now delegates to the Modal primitive which wraps
// Headless UI Dialog (focus trap + Esc + aria-modal + theme-aware surface).
function ModalShell({
  title,
  onClose,
  children,
  icon,
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <Modal
      open={true}
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          {icon}
          {title}
        </span>
      }
      size="2xl"
    >
      <div className="max-h-[70vh] overflow-y-auto -mx-2 px-2">{children}</div>
    </Modal>
  )
}

function CodeBlock({
  text,
  filename,
  language,
}: {
  text: string
  filename: string
  language?: string
}) {
  const [copied, setCopied] = useState(false)
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
      notify.success('Copied')
    } catch {
      notify.error('Failed to copy')
    }
  }
  function handleDownload() {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    notify.success('Downloaded')
  }
  return (
    <div className="bg-gray-950 border border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-gray-900 border-b border-gray-700">
        <span className="text-xs text-gray-200 font-mono">
          {/* KAO#S1 — was text-gray-400, lifted to gray-200 for WCAG on dark panel */}
          {filename}
          {language && <span className="ml-2 text-gray-300">({language})</span>}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-200 hover:text-white hover:bg-gray-800 rounded transition-colors"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-400" /> Copied
              </>
            ) : (
              <>
                <Copy className="w-3.5 h-3.5" /> Copy
              </>
            )}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-200 hover:text-white hover:bg-gray-800 rounded transition-colors"
          >
            <Download className="w-3.5 h-3.5" /> Download
          </button>
        </div>
      </div>
      <pre className="p-3 text-xs text-gray-200 font-mono overflow-x-auto max-h-[55vh] whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  )
}

function StubBanner() {
  return (
    <div className="mb-3 p-2.5 bg-amber-500/10 border border-amber-500/40 rounded text-xs text-amber-300 flex items-start gap-2">
      <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
      <span>This is a stub — full LLM integration coming soon.</span>
    </div>
  )
}

function testsExtensionFor(language?: string): string {
  switch ((language || '').toLowerCase()) {
    case 'python':
      return 'py'
    case 'javascript':
      return 'js'
    case 'typescript':
      return 'ts'
    case 'go':
      return 'go'
    case 'rust':
      return 'rs'
    case 'java':
      return 'java'
    default:
      return 'txt'
  }
}

export default function ResultActionsExtras({ sessionId, language }: ResultActionsExtrasProps) {
  const [modal, setModal] = useState<Modal>(null)

  // Share state
  const [shareLoading, setShareLoading] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [shared, setShared] = useState<SharedState | null>(null)
  const [shareCopied, setShareCopied] = useState(false)

  // Tests state
  const [testsLoading, setTestsLoading] = useState(false)
  const [tests, setTests] = useState<GenerateTestsResponse | null>(null)

  // Docs state
  const [docsLoading, setDocsLoading] = useState(false)
  const [docs, setDocs] = useState<GenerateDocsResponse | null>(null)

  // Deploy state (Feature #10 — Vercel)
  const [vercelToken, setVercelToken] = useState('')
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<VercelDeployResponse | null>(null)
  const [deployUrlCopied, setDeployUrlCopied] = useState(false)
  const deployLanguage = (language || '').toLowerCase()
  const deploySupported = DEPLOY_SUPPORTED_LANGUAGES.includes(deployLanguage)

  async function openShare() {
    setModal('share')
    if (shared) return  // already have a link
    setShareLoading(true)
    try {
      const res = await createShareLink(sessionId)
      // Build absolute URL if backend returned relative one
      let url = res.share_url
      if (url && !/^https?:\/\//i.test(url)) {
        url = `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`
      }
      if (!url) {
        url = `${window.location.origin}/share/${res.share_token}`
      }
      setShared({ shareUrl: url, shareToken: res.share_token })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create share link'
      notify.error(msg)
      setModal(null)
    } finally {
      setShareLoading(false)
    }
  }

  async function handleCopyShare() {
    if (!shared) return
    try {
      await navigator.clipboard.writeText(shared.shareUrl)
      setShareCopied(true)
      setTimeout(() => setShareCopied(false), 2000)
      notify.success('Link copied')
    } catch {
      notify.error('Failed to copy')
    }
  }

  async function handleRevoke() {
    setRevoking(true)
    try {
      await revokeShareLink(sessionId)
      setShared(null)
      notify.success('Share link revoked')
      setModal(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to revoke link'
      notify.error(msg)
    } finally {
      setRevoking(false)
    }
  }

  async function openTests() {
    setModal('tests')
    if (tests) return
    setTestsLoading(true)
    try {
      const res = await generateTests(sessionId)
      setTests(res)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate tests'
      notify.error(msg)
      setModal(null)
    } finally {
      setTestsLoading(false)
    }
  }

  function openDeploy() {
    setModal('deploy')
  }

  async function handleDeploy() {
    const token = vercelToken.trim()
    if (!token) {
      notify.error('Please enter a Vercel API token')
      return
    }
    setDeploying(true)
    try {
      const result = await deployToVercel(sessionId, token)
      setDeployResult(result)
      notify.success('Deployed to Vercel!')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Deploy failed'
      notify.error(msg)
    } finally {
      setDeploying(false)
    }
  }

  async function handleCopyDeployUrl() {
    if (!deployResult?.deploy_url) return
    try {
      await navigator.clipboard.writeText(deployResult.deploy_url)
      setDeployUrlCopied(true)
      setTimeout(() => setDeployUrlCopied(false), 2000)
      notify.success('URL copied')
    } catch {
      notify.error('Failed to copy')
    }
  }

  async function openDocs() {
    setModal('docs')
    if (docs) return
    setDocsLoading(true)
    try {
      const res = await generateDocs(sessionId)
      setDocs(res)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to generate docs'
      notify.error(msg)
      setModal(null)
    } finally {
      setDocsLoading(false)
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button
          type="button"
          onClick={openShare}
          className="flex items-center justify-center gap-2 px-3 py-2 bg-sky-600 hover:bg-sky-700 rounded-lg text-sm text-white transition-colors"
          title={shared ? 'Sharing enabled — view link' : 'Create public read-only link'}
          data-tour="share-btn" /* tour-anchor: share button (Tour 4, step 3) */
        >
          <Share2 className="w-4 h-4" />
          {shared ? 'Sharing enabled' : 'Share'}
        </button>
        <button
          type="button"
          onClick={openTests}
          className="flex items-center justify-center gap-2 px-3 py-2 bg-teal-600 hover:bg-teal-700 rounded-lg text-sm text-white transition-colors"
        >
          <TestTube className="w-4 h-4" />
          Generate Tests
        </button>
        <button
          type="button"
          onClick={openDocs}
          className="flex items-center justify-center gap-2 px-3 py-2 bg-amber-600 hover:bg-amber-700 rounded-lg text-sm text-white transition-colors"
        >
          <BookOpen className="w-4 h-4" />
          Generate Docs
        </button>
        <button
          type="button"
          onClick={openDeploy}
          disabled={!deploySupported}
          title={
            deploySupported
              ? 'Deploy to Vercel'
              : `Deploy currently supports HTML/JS only (session language: ${language || 'unknown'})`
          }
          className="flex items-center justify-center gap-2 px-3 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm text-white transition-colors"
        >
          <Rocket className="w-4 h-4" />
          Deploy
        </button>
      </div>

      {/* Share Modal */}
      {modal === 'share' && (
        <ModalShell
          title="Public read-only link"
          onClose={() => setModal(null)}
          icon={<Share2 className="w-5 h-5 text-sky-400" />}
        >
          {shareLoading && (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-6 h-6 animate-spin text-sky-400" />
            </div>
          )}
          {!shareLoading && shared && (
            <div className="space-y-3">
              <p className="text-sm text-gray-300">
                Anyone with this link can view a read-only snapshot of this session
                (specification, status, and final code if available).
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  readOnly
                  value={shared.shareUrl}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                  className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-200 font-mono"
                />
                <button
                  type="button"
                  onClick={handleCopyShare}
                  className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-white transition-colors"
                >
                  {shareCopied ? (
                    <>
                      <Check className="w-4 h-4 text-green-400" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" /> Copy
                    </>
                  )}
                </button>
                <a
                  href={shared.shareUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-white transition-colors"
                  title="Open in new tab"
                >
                  <ExternalLink className="w-4 h-4" />
                </a>
              </div>
              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={handleRevoke}
                  disabled={revoking}
                  className="flex items-center gap-2 px-3 py-2 bg-red-600/80 hover:bg-red-600 disabled:opacity-50 rounded-lg text-sm text-white transition-colors"
                >
                  {revoking ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                  Revoke link
                </button>
              </div>
            </div>
          )}
        </ModalShell>
      )}

      {/* Tests Modal */}
      {modal === 'tests' && (
        <ModalShell
          title="Generated tests"
          onClose={() => setModal(null)}
          icon={<TestTube className="w-5 h-5 text-teal-400" />}
        >
          {testsLoading && (
            <div className="flex items-center gap-2 text-sm text-gray-300 py-6 justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-teal-400" />
              Generating tests...
            </div>
          )}
          {!testsLoading && tests && (
            <div>
              {tests.stub && <StubBanner />}
              <CodeBlock
                text={tests.tests_code}
                filename={`tests.${testsExtensionFor(tests.language || language)}`}
                language={tests.language || language}
              />
            </div>
          )}
        </ModalShell>
      )}

      {/* Docs Modal */}
      {modal === 'docs' && (
        <ModalShell
          title="Generated documentation"
          onClose={() => setModal(null)}
          icon={<BookOpen className="w-5 h-5 text-amber-400" />}
        >
          {docsLoading && (
            <div className="flex items-center gap-2 text-sm text-gray-300 py-6 justify-center">
              <Loader2 className="w-5 h-5 animate-spin text-amber-400" />
              Generating documentation...
            </div>
          )}
          {!docsLoading && docs && (
            <div className="space-y-4">
              {docs.stub && <StubBanner />}
              <div>
                <div className="text-xs uppercase tracking-wider text-gray-400 mb-1.5">README</div>
                <CodeBlock text={docs.readme} filename="README.md" language="markdown" />
              </div>
              {docs.api_docs && (
                <div>
                  <div className="text-xs uppercase tracking-wider text-gray-400 mb-1.5">
                    API documentation
                  </div>
                  <CodeBlock text={docs.api_docs} filename="API.md" language="markdown" />
                </div>
              )}
            </div>
          )}
        </ModalShell>
      )}

      {/* Deploy Modal (Feature #10 — Vercel) */}
      {modal === 'deploy' && (
        <ModalShell
          title="Deploy to Vercel"
          onClose={() => setModal(null)}
          icon={<Rocket className="w-5 h-5 text-violet-400" />}
        >
          <div className="space-y-3">
            {deployResult ? (
              <>
                <div className="p-3 bg-green-500/10 border border-green-500/40 rounded text-sm text-green-300">
                  Deployment created successfully.
                </div>
                <div>
                  <label className="block text-xs uppercase tracking-wider text-gray-400 mb-1.5">
                    Deployed URL
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      readOnly
                      value={deployResult.deploy_url}
                      onClick={(e) => (e.target as HTMLInputElement).select()}
                      className="flex-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-200 font-mono"
                    />
                    <button
                      type="button"
                      onClick={handleCopyDeployUrl}
                      className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-white transition-colors"
                    >
                      {deployUrlCopied ? (
                        <>
                          <Check className="w-4 h-4 text-green-400" /> Copied
                        </>
                      ) : (
                        <>
                          <Copy className="w-4 h-4" /> Copy
                        </>
                      )}
                    </button>
                    <a
                      href={deployResult.deploy_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1.5 px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded-lg text-sm text-white transition-colors"
                      title="Open in new tab"
                    >
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </div>
                </div>
                {deployResult.inspect_url && (
                  <div className="text-xs text-gray-400">
                    Inspect:{' '}
                    <a
                      href={deployResult.inspect_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-violet-300 hover:text-violet-200 underline"
                    >
                      {deployResult.inspect_url}
                    </a>
                  </div>
                )}
                <div className="text-xs text-gray-500">
                  Note: Vercel may take a few seconds before the URL becomes reachable
                  (first build).
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-gray-300">
                  Deploy this session's final code to Vercel as a static site.
                  Your token is sent only with this request and is{' '}
                  <strong>not stored</strong> by CodeForge.
                </p>
                <div>
                  <label
                    htmlFor="vercel-token"
                    className="block text-xs uppercase tracking-wider text-gray-400 mb-1.5"
                  >
                    Vercel API token
                  </label>
                  <input
                    id="vercel-token"
                    type="password"
                    value={vercelToken}
                    onChange={(e) => setVercelToken(e.target.value)}
                    placeholder="vercel_xxx..."
                    autoComplete="off"
                    className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-200 font-mono focus:outline-none focus:border-violet-500"
                  />
                  <p className="mt-1.5 text-xs text-gray-500">
                    Create a token at{' '}
                    <a
                      href="https://vercel.com/account/tokens"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-violet-300 hover:text-violet-200 underline"
                    >
                      vercel.com/account/tokens
                    </a>
                    .
                  </p>
                </div>
                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setModal(null)}
                    disabled={deploying}
                    className="px-3 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 rounded-lg text-sm text-white transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleDeploy}
                    disabled={deploying || !vercelToken.trim()}
                    className="flex items-center gap-2 px-3 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg text-sm text-white transition-colors"
                  >
                    {deploying ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Deploying...
                      </>
                    ) : (
                      <>
                        <Rocket className="w-4 h-4" />
                        Deploy
                      </>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </ModalShell>
      )}
    </>
  )
}
