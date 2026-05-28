// КАО#VR-Wave6 SpecAnalyzer
// Pure helper to detect when a user's specification contains visual/graphical
// keywords but the selected language can't render in the headless-browser
// sandbox. Used by NewSessionPage to surface a non-blocking warning + a
// one-click switch to javascript_browser.
//
// Keywords list mirrors backend/app/core/visual_review.py:VISUAL_KEYWORDS,
// extended with Russian-language hints so the heuristic works for the
// Russian-speaking userbase too (the backend matches only on lower-cased
// substrings; we use a simple substring scan here for the same reason).

// КАО#VR-Wave6 SpecAnalyzer — languages that the sandbox can actually render
// visually via a headless browser. Must stay in sync with the backend's
// VISUAL_LANGUAGES frozenset in app/core/visual_review.py.
export const BROWSER_RENDERABLE_LANGUAGES: readonly string[] = [
  'html',
  'javascript_browser',
  'typescript_browser',
  'canvas',
  'p5js',
]

// КАО#VR-Wave6 SpecAnalyzer — visual keyword vocabulary. English terms mirror
// backend's VISUAL_KEYWORDS; Russian terms are added here (frontend-only) to
// catch typical RU specs like "максимально визуально", "графика", etc.
//
// English terms use word-boundary matching; Russian terms use case-insensitive
// substring matching because Russian morphology means we want to catch all
// inflections of "визуализация / визуально / визуализируй / визуальный" with a
// single root "визуализ" / "визуально".
export const VISUAL_KEYWORDS: readonly string[] = [
  // English (mirror backend)
  'visualize',
  'visualise',
  'render',
  'ui',
  'animation',
  'design',
  'color',
  'colour',
  'shader',
  'plot',
  'game',
  'animate',
  'draw',
  'paint',
  'fractal',
  'simulation',
  'particle',
  'glow',
  // Russian (frontend-only hint vocabulary)
  // КАО#Full-C-1 S2 — 'визуал' substring catches визуальный/визуальная/визуально/визуализация
  // morphology in one prefix; kept alongside 'визуально' and 'визуализ' so tests asserting
  // matchedKeywords contain those exact tokens stay green.
  'визуал',
  'визуально',
  'визуализ',
  'анимаци',
  'графика',
  'рисов',
  'игра',
  'рендер',
  'канвас',
  'canvas',
]

// КАО#VR-Wave6 SpecAnalyzer — split keywords into two groups so we can use the
// right matcher for each. ASCII word-boundary regex works for Latin keywords
// but \b doesn't fire correctly at Cyrillic letter boundaries, so we use a
// substring (indexOf) check for Cyrillic keywords.
const _CYRILLIC_RE = /[Ѐ-ӿ]/
const _LATIN_KEYWORDS: readonly string[] = VISUAL_KEYWORDS.filter(
  (k) => !_CYRILLIC_RE.test(k),
)
const _CYRILLIC_KEYWORDS: readonly string[] = VISUAL_KEYWORDS.filter((k) =>
  _CYRILLIC_RE.test(k),
)

// Build one big alternation regex for the Latin keywords (case-insensitive,
// word-boundary). Built once at module load.
const _LATIN_RE = new RegExp(
  '\\b(' +
    _LATIN_KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') +
    ')\\b',
  'gi',
)

export interface SpecAnalysisResult {
  /** True when the spec contains at least one visual keyword. */
  hasVisualKeywords: boolean
  /** True when the selected language is one the sandbox can render. */
  isBrowserRenderable: boolean
  /** True when we should nudge the user to switch language (visual spec + non-browser lang). */
  suggestSwitch: boolean
  /** Distinct list of keywords that matched (preserved in lower-case). */
  matchedKeywords: string[]
}

// КАО#VR-Wave6 SpecAnalyzer — main analyzer entry point. Pure function: same
// inputs => same outputs, no I/O, no side effects. Safe to call on every
// keystroke (the page debounces anyway).
export function analyzeSpec(
  spec: string | null | undefined,
  language: string | null | undefined,
): SpecAnalysisResult {
  const langNorm = (language ?? '').trim().toLowerCase()
  const isBrowserRenderable = BROWSER_RENDERABLE_LANGUAGES.includes(langNorm)

  const text = (spec ?? '').toString()
  if (text.length === 0) {
    return {
      hasVisualKeywords: false,
      isBrowserRenderable,
      suggestSwitch: false,
      matchedKeywords: [],
    }
  }

  const matched = new Set<string>()

  // Latin keywords via word-boundary regex.
  const latinMatches = text.match(_LATIN_RE)
  if (latinMatches) {
    for (const m of latinMatches) matched.add(m.toLowerCase())
  }

  // Cyrillic keywords via case-insensitive substring scan.
  const lower = text.toLowerCase()
  for (const k of _CYRILLIC_KEYWORDS) {
    if (lower.includes(k.toLowerCase())) matched.add(k.toLowerCase())
  }

  const hasVisualKeywords = matched.size > 0
  return {
    hasVisualKeywords,
    isBrowserRenderable,
    suggestSwitch: hasVisualKeywords && !isBrowserRenderable,
    matchedKeywords: Array.from(matched),
  }
}
