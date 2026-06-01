// КАО#SG1-selfxss — open LLM-generated HTML in a SANDBOXED browser tab.
//
// Replaces the old "same-origin blob: tab" (window.open of a blob URL, which
// inherited the app origin and let the generated HTML read localStorage /
// cookies and call the app's API). Instead we open a thin first-party page
// (/sandbox-tab.html) that renders the HTML inside a child
// <iframe sandbox="allow-scripts"> WITHOUT allow-same-origin — an opaque
// origin that cannot touch the app's storage, cookies, or same-origin API.
//
// The "open in full window / new tab" UX is preserved: it's still a real
// top-level tab that fills the viewport and loads CDN scripts.
//
// Returns false if the popup was blocked (caller should surface a toast).

const SANDBOX_TAB_URL = '/sandbox-tab.html'

export function openSandboxedHtmlInNewTab(html: string): boolean {
  // No 'noopener' here — we need window.opener for the postMessage handshake.
  const win = window.open(SANDBOX_TAB_URL, '_blank')
  if (!win) {
    return false // popup blocked
  }

  const targetOrigin = window.location.origin
  let sent = false

  const send = () => {
    if (sent) return
    sent = true
    try {
      win.postMessage({ type: 'codeforge-preview', html }, targetOrigin)
    } catch {
      /* tab closed before we could post — nothing to do */
    }
    window.removeEventListener('message', onMessage)
  }

  function onMessage(event: MessageEvent) {
    // Only react to the ready-signal from the tab we just opened, same-origin.
    if (event.origin !== targetOrigin) return
    if (event.source !== win) return
    if ((event.data as { type?: string } | null)?.type === 'codeforge-sandbox-ready') {
      send()
    }
  }

  window.addEventListener('message', onMessage)
  // Fallback: if we never hear "ready" (e.g. it fired a hair before the
  // listener attached), the tab is certainly listening by now — post anyway.
  // The tab dedupes via its own `rendered` guard.
  window.setTimeout(send, 1500)

  return true
}
