// Polyfills for the jsdom test environment.
// КАО — некоторые UI-либы (Headless UI, Radix) предполагают browser-only API
// that jsdom doesn't implement out of the box.
//
// M3/S3 (КАО Round 2): a single typed ObserverStub class replaces the prior
// blanket `(globalThis as any)` casts AND the misnamed `ResizeObserverStub`
// (which was being assigned to IntersectionObserver too). Each shim is now
// narrowly typed against the real DOM-lib constructor signature via a
// targeted cast — no file-wide `any`s.

class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  // IntersectionObserver exposes takeRecords() — kept as a no-op for any
  // code that calls it during cleanup.
  takeRecords(): unknown[] {
    return []
  }
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  // The DOM lib's ResizeObserver constructor signature
  // (callback: ResizeObserverCallback) isn't exercised by the suite — Headless
  // UI only invokes observe/unobserve/disconnect. Cast is justified because
  // ObserverStub satisfies the runtime shape we care about.
  globalThis.ResizeObserver = ObserverStub as unknown as typeof ResizeObserver
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  // Same justification as ResizeObserver — Headless UI's Dialog uses
  // IntersectionObserver to compute visibility for focus trap edge cases;
  // the no-op stub keeps it from throwing in jsdom.
  globalThis.IntersectionObserver = ObserverStub as unknown as typeof IntersectionObserver
}

if (typeof globalThis.matchMedia === 'undefined') {
  // Minimal MediaQueryList shape — only the fields Headless UI's reduced-
  // motion check touches are populated. Same cast rationale.
  globalThis.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia
}

export {}
