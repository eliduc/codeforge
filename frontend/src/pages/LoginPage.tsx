import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Code2, Loader2, ArrowLeft, Mail, ShieldAlert, CheckCircle2 } from 'lucide-react'
import { requestOTP, verifyOTP, requestAccess } from '../services/api'
import { useAuthStore } from '../stores/authStore'

type Step = 'email' | 'code' | 'not_allowed'

// Улучшатели#1 P2·S — sanitize location.state.from to prevent open-redirect
// via protocol-relative URLs ("//evil.com") or absolute URLs handed to
// react-router's navigate(). Only same-origin paths starting with a single "/"
// are accepted; anything else falls back silently to "/sessions".
function safeFromPath(from?: unknown): string {
  if (typeof from !== 'string') return '/sessions'
  if (from.length === 0) return '/sessions'
  // Must start with "/" but NOT "//" (protocol-relative).
  if (!from.startsWith('/')) return '/sessions'
  if (from.startsWith('//')) return '/sessions'
  // Also reject backslash variants which some browsers normalise to "//".
  if (from.startsWith('/\\') || from.startsWith('\\')) return '/sessions'
  return from
}

// Улучшатели#1 P2·S — OTP error class-distinguish.
// Classifies an error from verifyOTP() so we can decide whether to wipe the
// 6-digit code (genuine 4xx "invalid/expired") or keep it (transient: network,
// timeout, 5xx). The shared apiFetch helper only surfaces error.message, so we
// match on well-known message fragments produced upstream.
type OtpErrorClass = 'invalid_code' | 'transient'
function classifyOtpError(err: unknown): OtpErrorClass {
  if (!(err instanceof Error)) return 'invalid_code'
  const msg = err.message || ''
  // apiFetch timeout: "Request timeout after Xms: /api/..."
  if (msg.startsWith('Request timeout')) return 'transient'
  // fetch network failures: "Failed to fetch", "NetworkError when attempting...", "Load failed".
  if (/failed to fetch/i.test(msg)) return 'transient'
  if (/network\s*error/i.test(msg)) return 'transient'
  if (/^load failed$/i.test(msg)) return 'transient'
  // Fallback path in apiFetch when response.json() of an error body fails:
  // "API error: 500", "API error: 502", "API error: 503", "API error: 504"
  if (/^API error:\s*5\d{2}\b/.test(msg)) return 'transient'
  // Everything else (including the backend's "Invalid or expired code...") is
  // a real 4xx-style code rejection.
  return 'invalid_code'
}

export default function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const login = useAuthStore(s => s.login)
  const isAuthenticated = useAuthStore(s => s.isAuthenticated)

  const [step, setStep] = useState<Step>('email')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState<string[]>(Array(6).fill(''))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [accessRequested, setAccessRequested] = useState(false)
  // Улучшатели#1 P1·S — Resend Code cooldown
  const [resendCooldown, setResendCooldown] = useState(0)

  const emailInputRef = useRef<HTMLInputElement>(null)
  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([])

  // Redirect from state or default — Улучшатели#1 P2·S — sanitize against open-redirect
  const from = safeFromPath((location.state as { from?: unknown })?.from)

  // If already authenticated, redirect immediately
  useEffect(() => {
    if (isAuthenticated) {
      navigate(from, { replace: true })
    }
  }, [isAuthenticated, navigate, from])

  // Focus first code input when switching to code step
  useEffect(() => {
    if (step === 'code') {
      setTimeout(() => codeInputRefs.current[0]?.focus(), 100)
    }
  }, [step])

  // Focus email input on mount
  useEffect(() => {
    emailInputRef.current?.focus()
  }, [])

  // Улучшатели#1 P1·S — Resend Code cooldown countdown
  useEffect(() => {
    if (resendCooldown <= 0) return
    const interval = setInterval(() => {
      setResendCooldown(prev => (prev <= 1 ? 0 : prev - 1))
    }, 1000)
    return () => clearInterval(interval)
  }, [resendCooldown])

  async function handleRequestOTP(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return

    setLoading(true)
    setError(null)
    setAccessRequested(false)
    try {
      const result = await requestOTP(email.trim())
      if (result.not_allowed) {
        setStep('not_allowed')
      } else {
        setMessage(result.message)
        setStep('code')
        // Улучшатели#1 P1·S — Resend Code cooldown
        setResendCooldown(60)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send code')
    } finally {
      setLoading(false)
    }
  }

  async function handleRequestAccess() {
    setLoading(true)
    setError(null)
    try {
      await requestAccess(email.trim())
      setAccessRequested(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send request')
    } finally {
      setLoading(false)
    }
  }

  // Улучшатели#1 P1·S — OTP duplicate verify logic — single source of truth
  async function submitCode(codeStr: string) {
    if (codeStr.length !== 6) return

    setLoading(true)
    setError(null)
    try {
      // КАО#SG1-selfxss — verify-otp set the JWT as an httpOnly cookie; we no
      // longer stash the token client-side. Just record the user from the body.
      const result = await verifyOTP(email.trim(), codeStr)
      login(result.user)
      navigate(from, { replace: true })
    } catch (err) {
      // Улучшатели#1 P2·S — OTP error class-distinguish: only wipe digits on a
      // genuine code-rejection (invalid/expired/4xx). Transient errors leave
      // the typed digits in place so the user can hit Resend or simply retry.
      const cls = classifyOtpError(err)
      if (cls === 'transient') {
        setError(
          err instanceof Error && err.message
            ? `Couldn't reach the server — ${err.message}. Click Resend or try again.`
            : "Couldn't reach the server. Click Resend or try again."
        )
        // Keep `code` state intact; do not refocus.
      } else {
        setError(err instanceof Error ? err.message : 'Verification failed')
        // Clear code inputs on invalid/expired
        setCode(Array(6).fill(''))
        setTimeout(() => codeInputRefs.current[0]?.focus(), 100)
      }
    } finally {
      setLoading(false)
    }
  }

  async function handleVerifyOTP(e?: React.FormEvent) {
    e?.preventDefault()
    await submitCode(code.join(''))
  }

  function handleCodeInput(index: number, value: string) {
    if (!/^\d*$/.test(value)) return

    const newCode = [...code]
    newCode[index] = value.slice(-1) // Take only last digit
    setCode(newCode)

    // Auto-focus next input
    if (value && index < 5) {
      codeInputRefs.current[index + 1]?.focus()
    }

    // Auto-submit when all 6 digits entered
    if (value && index === 5 && newCode.every(d => d !== '')) {
      // Use newCode directly (not stale `code` state) to avoid closure issue
      const codeStr = newCode.join('')
      if (codeStr.length === 6) {
        // Улучшатели#1 P1·S — OTP duplicate verify logic — share submitCode helper
        setTimeout(() => { void submitCode(codeStr) }, 100)
      }
    }
  }

  function handleCodeKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === 'Backspace' && !code[index] && index > 0) {
      codeInputRefs.current[index - 1]?.focus()
    }
  }

  function handleCodePaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
    if (pasted.length > 0) {
      e.preventDefault()
      const newCode = Array(6).fill('')
      for (let i = 0; i < pasted.length; i++) {
        newCode[i] = pasted[i]
      }
      setCode(newCode)
      // Focus the next empty or last input
      const nextEmpty = newCode.findIndex(d => d === '')
      const focusIdx = nextEmpty === -1 ? 5 : nextEmpty
      setTimeout(() => codeInputRefs.current[focusIdx]?.focus(), 50)

      // Auto-submit if all 6 digits pasted
      if (pasted.length === 6) {
        setTimeout(() => handleVerifyOTP(), 200)
      }
    }
  }

  async function handleResend() {
    // Улучшатели#1 P1·S — Resend Code cooldown — guard
    if (resendCooldown > 0) return
    setLoading(true)
    setError(null)
    setMessage(null)
    try {
      const result = await requestOTP(email.trim())
      setMessage(result.message)
      setCode(Array(6).fill(''))
      setTimeout(() => codeInputRefs.current[0]?.focus(), 100)
      // Улучшатели#1 P1·S — Resend Code cooldown — start 60s timer
      setResendCooldown(60)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend code')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-cf-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        {/* Улучшатели#1 P3·S — Logo aria-hidden — decorative icon */}
        <div className="flex flex-col items-center mb-8">
          {/* КАО#R4-M4 — aria-hidden only on the decorative icon, not the h1 */}
          <div className="w-14 h-14 bg-gradient-to-br from-cf-primary to-cf-secondary rounded-2xl flex items-center justify-center mb-4 shadow-lg shadow-indigo-500/20" aria-hidden="true">
            <Code2 className="w-8 h-8 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-cf-text">CodeForge</h1>
          <p className="text-cf-text-muted text-sm mt-1">Multi-Agent Code Generation</p>
        </div>

        {/* Card */}
        <div className="bg-cf-panel border border-cf-border rounded-xl p-6 shadow-xl">
          {/* Улучшатели#1 P3·S — tighten live-region scope: keep region label but drop aria-live from whole form; inline alerts use role="alert" */}
          <div role="region" aria-label="Login form">
          {step === 'email' && (
            <>
              <h2 className="text-lg font-semibold text-cf-text mb-1">Sign in</h2>
              <p className="text-cf-text-muted text-sm mb-6">
                Enter your email to receive a one-time login code.
              </p>

              <form onSubmit={handleRequestOTP}>
                <div className="mb-4">
                  <label htmlFor="email" className="block text-sm font-medium text-cf-text-muted mb-1.5">
                    Email address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-cf-text-muted" />
                    {/* Улучшатели#1 P1·S — Email autocomplete */}
                    <input
                      ref={emailInputRef}
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      inputMode="email"
                      required
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="you@example.com"
                      className="w-full pl-10 pr-3 py-2.5 bg-cf-bg border border-cf-border rounded-lg text-cf-text placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cf-primary focus:border-transparent transition-all"
                      disabled={loading}
                    />
                  </div>
                </div>

                {error && (
                  <p role="alert" className="text-red-400 text-sm mb-4">{error}</p>
                )}

                <button
                  type="submit"
                  disabled={loading || !email.trim()}
                  className="w-full py-2.5 bg-cf-primary hover:bg-cf-primary/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    'Send Code'
                  )}
                </button>
              </form>
            </>
          )}

          {step === 'not_allowed' && (
            <>
              <button
                onClick={() => { setStep('email'); setError(null); setAccessRequested(false) }}
                className="flex items-center gap-1 text-cf-text-muted hover:text-cf-text text-sm mb-4 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>

              <div className="flex flex-col items-center text-center">
                <ShieldAlert className="w-10 h-10 text-amber-400 mb-3" />
                <h2 className="text-lg font-semibold text-cf-text mb-2">Access restricted</h2>
                <p className="text-cf-text-muted text-sm mb-1">
                  The email <span className="text-cf-text font-medium">{email}</span>
                </p>
                <p className="text-cf-text-muted text-sm mb-2">
                  is not in the allowed list.
                </p>
                {/* Улучшатели#1 P3·S — Not-allowed: set expectations + docs link */}
                <p className="text-cf-text-muted text-xs mb-1">
                  An admin will review your request within 1 business day.
                </p>
                <a
                  href="https://docs.gotcode.ai"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-cf-text-muted hover:text-cf-text text-xs underline underline-offset-2 mb-5 transition-colors"
                >
                  Learn more →
                </a>

                {accessRequested ? (
                  <>
                    <div className="flex items-center gap-2 text-green-400 text-sm py-2.5">
                      <CheckCircle2 className="w-4 h-4" />
                      Request sent to administrator
                    </div>
                    {/* Улучшатели#1 P1·S — Request access — use different email */}
                    <button
                      type="button"
                      onClick={() => {
                        setStep('email')
                        setAccessRequested(false)
                        setError(null)
                        setEmail('')
                        setTimeout(() => emailInputRef.current?.focus(), 50)
                      }}
                      className="text-indigo-700 dark:text-cf-primary hover:text-indigo-800 dark:hover:text-cf-primary/80 text-sm font-medium transition-colors mt-1"
                    >
                      ← Use a different email
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleRequestAccess}
                    disabled={loading}
                    className="w-full py-2.5 bg-amber-600 hover:bg-amber-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                  >
                    {loading ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      'Request access from administrator'
                    )}
                  </button>
                )}

                {error && (
                  <p role="alert" className="text-red-400 text-sm mt-3">{error}</p>
                )}
              </div>
            </>
          )}

          {step === 'code' && (
            <>
              <button
                onClick={() => { setStep('email'); setError(null); setMessage(null); setCode(Array(6).fill('')) }}
                className="flex items-center gap-1 text-cf-text-muted hover:text-cf-text text-sm mb-4 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                Back
              </button>

              <h2 className="text-lg font-semibold text-cf-text mb-1">Enter code</h2>
              <p className="text-cf-text-muted text-sm mb-6">
                We sent a 6-digit code to <span className="text-cf-text font-medium">{email}</span>
              </p>

              {message && (
                <p className="text-green-400 text-sm mb-4">{message}</p>
              )}

              <form onSubmit={handleVerifyOTP}>
                <div className="flex gap-2 justify-center mb-4" onPaste={handleCodePaste}>
                  {/* Улучшатели#1 P1·S — OTP a11y + autofill; P3·S — h-13 bug fix (h-12) */}
                  {code.map((digit, i) => (
                    <input
                      key={i}
                      ref={el => { codeInputRefs.current[i] = el }}
                      type="text"
                      name={`otp-${i + 1}`}
                      aria-label={`Digit ${i + 1} of 6`}
                      autoComplete={i === 0 ? 'one-time-code' : 'off'}
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={1}
                      value={digit}
                      onChange={e => handleCodeInput(i, e.target.value)}
                      onKeyDown={e => handleCodeKeyDown(i, e)}
                      className="w-11 h-12 text-center text-xl font-bold bg-cf-bg border border-cf-border rounded-lg text-cf-text focus:outline-none focus:ring-2 focus:ring-cf-primary focus:border-transparent transition-all"
                      disabled={loading}
                    />
                  ))}
                </div>

                {error && (
                  <p role="alert" className="text-red-400 text-sm mb-4 text-center">{error}</p>
                )}

                <button
                  type="submit"
                  disabled={loading || code.some(d => d === '')}
                  className="w-full py-2.5 bg-cf-primary hover:bg-cf-primary/90 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    'Verify'
                  )}
                </button>
              </form>

              <div className="mt-4 text-center">
                {/* Улучшатели#1 P1·S — Resend Code cooldown */}
                <button
                  onClick={handleResend}
                  disabled={loading || resendCooldown > 0}
                  className="text-indigo-700 dark:text-cf-primary hover:text-indigo-800 dark:hover:text-cf-primary/80 text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {resendCooldown > 0 ? `Resend in ${resendCooldown}s` : 'Resend Code'}
                </button>
              </div>
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  )
}
