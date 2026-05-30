// КАО#VR-58 — Thinking-effort option list + family fallback heuristic.
// Extracted verbatim from SessionDetailPage.tsx (AgentConfigPopup) so the
// pure logic can be unit-tested in isolation. Behavior is IDENTICAL to the
// previous inline definitions; SessionDetailPage now imports from here.

// Ordered list of every thinking-effort level the UI can offer. The empty
// value ('') is the "Auto" sentinel; the named levels are rendered (in this
// order) by the level <select> after filtering to the model's supported set.
export const THINKING_EFFORT_OPTIONS = [
  { value: '', label: 'Auto' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

// VR-58 — Thinking-effort fallback heuristic.
// The backend reports per-model thinking levels via model_capabilities, and
// that is the source of truth. But if the capabilities map has NO entry for a
// model at all (e.g. a freshly-released model name the registry hasn't been
// taught yet, or a custom/typed model), we must not silently lock the user
// out of the thinking controls. In that gap-only case we infer the supported
// levels from the model family. Note: this fires ONLY when caps are *absent*
// (modelCaps === undefined); an explicit empty list from the backend ("this
// model has no thinking mode") is always respected. The provider itself also
// gates thinking on the server, so an over-permissive guess here is harmless.
export function inferThinkingEfforts(provider: string, model: string): string[] {
  const m = (model || '').toLowerCase()
  const p = (provider || '').toLowerCase()
  if (p === 'anthropic') {
    // Claude 4+ Opus/Sonnet support extended/adaptive thinking; Opus adds "max".
    if (/opus/.test(m)) return ['low', 'medium', 'high', 'max']
    if (/sonnet/.test(m)) return ['low', 'medium', 'high']
    return []
  }
  if (p === 'google') {
    // Gemini 2.5+/3.x Pro & Flash expose a thinking budget.
    if (/gemini/.test(m) && /(pro|flash|2\.5|2\.6|3\.|thinking)/.test(m)) {
      return ['low', 'medium', 'high', 'max']
    }
    return []
  }
  if (p === 'openai') {
    // o-series pure-reasoning models: low/medium/high.
    if (/^o\d/.test(m)) return ['low', 'medium', 'high']
    // GPT-5+ chat models add "minimal" below "low".
    if (/gpt-[5-9]/.test(m)) return ['minimal', 'low', 'medium', 'high']
    return []
  }
  if (p === 'grok') {
    if (/(reason|grok-?[34])/.test(m)) return ['low', 'medium', 'high']
    return []
  }
  return []
}
