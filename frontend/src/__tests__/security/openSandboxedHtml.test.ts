// КАО#SG1-selfxss — openSandboxedHtmlInNewTab opens LLM-generated HTML in a
// SANDBOXED first-party tab (/sandbox-tab.html), NOT a same-origin blob: URL,
// and hands the HTML over through a postMessage handshake scoped to the app
// origin (never "*"). This is the frontend half of removing the same-origin
// execution of generated code.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { openSandboxedHtmlInNewTab } from '../../utils/openSandboxedHtml'

describe('openSandboxedHtmlInNewTab (КАО#SG1-selfxss)', () => {
  let openSpy: ReturnType<typeof vi.fn>
  let fakeWin: { postMessage: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.useFakeTimers()
    fakeWin = { postMessage: vi.fn() }
    openSpy = vi.fn(() => fakeWin as unknown as Window)
    vi.stubGlobal('open', openSpy)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('opens the sandboxed tab page, not a blob: URL', () => {
    const ok = openSandboxedHtmlInNewTab('<h1>hi</h1>')
    expect(ok).toBe(true)
    expect(openSpy).toHaveBeenCalledTimes(1)
    const [url, target] = openSpy.mock.calls[0]
    expect(url).toBe('/sandbox-tab.html')
    expect(String(url)).not.toMatch(/^blob:/)
    expect(target).toBe('_blank')
  })

  it('returns false when the popup is blocked', () => {
    openSpy.mockReturnValueOnce(null)
    expect(openSandboxedHtmlInNewTab('<h1>x</h1>')).toBe(false)
  })

  it('posts the HTML to the tab scoped to the app origin (never "*") on ready', () => {
    openSandboxedHtmlInNewTab('<h1>payload</h1>')

    const ev = new MessageEvent('message', {
      data: { type: 'codeforge-sandbox-ready' },
      origin: window.location.origin,
    })
    // event.source must be the opened window for the helper to react.
    Object.defineProperty(ev, 'source', { value: fakeWin, configurable: true })
    window.dispatchEvent(ev)

    expect(fakeWin.postMessage).toHaveBeenCalledTimes(1)
    const [msg, targetOrigin] = fakeWin.postMessage.mock.calls[0]
    expect(msg).toEqual({ type: 'codeforge-preview', html: '<h1>payload</h1>' })
    // Critically: scoped to the app origin, NOT a wildcard.
    expect(targetOrigin).toBe(window.location.origin)
    expect(targetOrigin).not.toBe('*')
  })

  it('ignores ready messages from a different window/source', () => {
    openSandboxedHtmlInNewTab('<h1>payload</h1>')

    const ev = new MessageEvent('message', {
      data: { type: 'codeforge-sandbox-ready' },
      origin: window.location.origin,
    })
    Object.defineProperty(ev, 'source', { value: { other: true }, configurable: true })
    window.dispatchEvent(ev)

    expect(fakeWin.postMessage).not.toHaveBeenCalled()
  })

  it('falls back to posting after the timeout if no ready signal arrives', () => {
    openSandboxedHtmlInNewTab('<h1>fallback</h1>')
    expect(fakeWin.postMessage).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1500)

    expect(fakeWin.postMessage).toHaveBeenCalledTimes(1)
    const [msg, targetOrigin] = fakeWin.postMessage.mock.calls[0]
    expect(msg).toEqual({ type: 'codeforge-preview', html: '<h1>fallback</h1>' })
    expect(targetOrigin).toBe(window.location.origin)
  })
})
