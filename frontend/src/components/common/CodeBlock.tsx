// Улучшатели#3 P1·S — Syntax-highlighted code viewer.
// Wraps the existing <pre> blocks in DetailPanel / SessionDetailPage so users
// see proper colouring + optional line numbers + a Copy button.
//
// Implementation: uses `highlight.js` which is already a dependency
// (see package.json). No new bundle weight. We import only the languages
// we actually use to keep the bundle small.
//
// Falls back gracefully to plain text if the language is unknown.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Copy, Check } from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import xml from 'highlight.js/lib/languages/xml'  // for HTML
import css from 'highlight.js/lib/languages/css'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import 'highlight.js/styles/atom-one-dark.css'
import notify from './StyledToast'
import clsx from 'clsx'

// Register only the langs we use. This is a one-shot side-effect — safe
// to do at module load even if multiple CodeBlocks mount.
let _registered = false
function registerLanguages() {
  if (_registered) return
  hljs.registerLanguage('javascript', javascript)
  hljs.registerLanguage('typescript', typescript)
  hljs.registerLanguage('python', python)
  hljs.registerLanguage('java', java)
  hljs.registerLanguage('cpp', cpp)
  hljs.registerLanguage('go', go)
  hljs.registerLanguage('rust', rust)
  hljs.registerLanguage('html', xml)
  hljs.registerLanguage('xml', xml)
  hljs.registerLanguage('css', css)
  hljs.registerLanguage('json', json)
  hljs.registerLanguage('bash', bash)
  _registered = true
}

/**
 * Normalise the various `session.language` values we see across the codebase
 * (python, javascript_browser, typescript_browser, etc.) to a hljs language
 * key. Returns 'plaintext' when no match — hljs accepts that fine.
 */
export function normalizeLanguage(lang?: string): string {
  if (!lang) return 'plaintext'
  const l = lang.toLowerCase()
  if (l.startsWith('javascript')) return 'javascript'
  if (l.startsWith('typescript')) return 'typescript'
  if (l === 'py' || l === 'python') return 'python'
  if (l === 'cpp' || l === 'c++' || l === 'c') return 'cpp'
  if (l === 'sh' || l === 'shell' || l === 'bash') return 'bash'
  return l
}

export interface CodeBlockProps {
  code: string
  /** Raw session.language or hljs identifier — normalised internally. */
  language?: string
  /** Show line numbers in a left gutter (default true). */
  showLineNumbers?: boolean
  /** Show the Copy button in the header strip (default true). */
  showCopy?: boolean
  /** Tailwind max-h utility (e.g. 'max-h-96'). Default 'max-h-[60vh]'. */
  maxHeightClass?: string
  /** Optional extra classes for the outer wrapper. */
  className?: string
  /** Optional decorative tint — used in DetailPanel diff view (red/green). */
  variant?: 'default' | 'previous' | 'current'
}

export default function CodeBlock({
  code,
  language,
  showLineNumbers = true,
  showCopy = true,
  maxHeightClass = 'max-h-[60vh]',
  className,
  variant = 'default',
}: CodeBlockProps) {
  registerLanguages()
  const codeRef = useRef<HTMLElement>(null)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>()

  const normLang = useMemo(() => normalizeLanguage(language), [language])

  useEffect(() => {
    if (!codeRef.current) return
    // Reset highlight state so re-renders re-highlight cleanly
    codeRef.current.removeAttribute('data-highlighted')
    try {
      if (normLang !== 'plaintext' && hljs.getLanguage(normLang)) {
        const result = hljs.highlight(code, { language: normLang, ignoreIllegals: true })
        codeRef.current.innerHTML = result.value
      } else {
        // No language registered → just escape and render as plain text
        codeRef.current.textContent = code
      }
    } catch {
      // Highlighting failed — fall back to plain text
      codeRef.current.textContent = code
    }
  }, [code, normLang])

  useEffect(() => () => { clearTimeout(copyTimerRef.current) }, [])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      notify.success('Copied to clipboard')
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      notify.error('Copy failed')
    }
  }

  const lineCount = useMemo(() => {
    if (!code) return 0
    // Count newlines (+1 if file does not end with newline)
    const n = (code.match(/\n/g) || []).length
    return code.length > 0 ? n + (code.endsWith('\n') ? 0 : 1) : 0
  }, [code])

  // Background tint for diff-view variants — solid darks (KAO#S1) so WCAG
  // contrast holds even when component is rendered on a light page background.
  const bgClass =
    variant === 'previous'
      ? 'bg-red-950 border border-red-900/40'
      : variant === 'current'
        ? 'bg-green-950 border border-green-900/40'
        : 'bg-gray-900 border border-gray-800'

  return (
    <div className={clsx('relative rounded-lg overflow-hidden', bgClass, className)}>
      {showCopy && (
        <div className="flex items-center justify-between px-3 py-1.5 bg-gray-950 border-b border-white/5">
          <span className="text-[10px] uppercase tracking-wider text-gray-200 font-mono">
            {normLang === 'plaintext' ? 'text' : normLang}
            {lineCount > 0 ? ` · ${lineCount} lines` : ''}
          </span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-gray-200 hover:text-white hover:bg-white/10 rounded transition-colors"
            title="Copy to clipboard"
            type="button"
          >
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      <div className={clsx('overflow-auto', maxHeightClass)}>
        {showLineNumbers && lineCount > 0 ? (
          <div className="flex">
            <pre
              aria-hidden="true"
              className="select-none text-right text-[11px] leading-snug font-mono text-gray-500 py-3 pl-3 pr-2 bg-black/20 border-r border-white/5"
            >
              {Array.from({ length: lineCount }, (_, i) => (i + 1).toString()).join('\n')}
            </pre>
            <pre className="flex-1 text-sm leading-snug font-mono whitespace-pre py-3 px-3 overflow-x-auto">
              <code ref={codeRef} className={`hljs language-${normLang}`} />
            </pre>
          </div>
        ) : (
          <pre className="text-sm leading-snug font-mono whitespace-pre-wrap p-3 overflow-x-auto">
            <code ref={codeRef} className={`hljs language-${normLang}`} />
          </pre>
        )}
      </div>
    </div>
  )
}
