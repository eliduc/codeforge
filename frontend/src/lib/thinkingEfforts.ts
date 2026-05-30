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

// КАО#VR-58 — Some models always reason: there is no true "off", only a
// "don't pin an effort" default (the API then picks one). For these the mode
// control's off position reads better as "Auto" than "Off". Today this is
// OpenAI's o-series and GPT-5+ chat models. (Anthropic/Google thinking is
// genuinely optional, so they keep "Off".)
export function isAlwaysReasoning(provider: string, model: string): boolean {
  const p = (provider || '').toLowerCase()
  const m = (model || '').toLowerCase()
  if (p === 'openai') return /^o\d/.test(m) || /gpt-[5-9]/.test(m)
  return false
}

export interface ThinkingControls {
  effectiveEfforts: string[]
  supportsThinking: boolean
  levelOptions: { value: string; label: string }[]
  defaultEffort: string
  modelMaxTokens: number
}

// КАО#VR-58 — Single source of truth for the node-settings "Thinking" control
// state, so the AgentConfigPopup component and its unit tests share one
// implementation (previously the test had to re-encode this logic).
//   - effectiveEfforts: backend caps first; the family heuristic fires ONLY
//     when caps are entirely absent (modelCaps === undefined); an explicit []
//     is respected as "no thinking".
//   - levelOptions: ordered options the level <select> renders.
//   - defaultEffort: level chosen when thinking is switched ON (prefer "high",
//     else the strongest supported level).
//   - modelMaxTokens: per-model output ceiling (fallback 128000).
export function deriveThinkingControls(
  provider: string,
  model: string,
  modelCaps?: { thinking_effort_options?: string[]; max_output_tokens?: number },
): ThinkingControls {
  const capsEfforts: string[] = modelCaps?.thinking_effort_options || []
  const effectiveEfforts = capsEfforts.length > 0
    ? capsEfforts
    : (modelCaps === undefined ? inferThinkingEfforts(provider, model) : [])
  const supportsThinking = effectiveEfforts.length > 0
  const levelOptions = THINKING_EFFORT_OPTIONS.filter(o => o.value && effectiveEfforts.includes(o.value))
  const defaultEffort = effectiveEfforts.includes('high')
    ? 'high'
    : (levelOptions.length > 0 ? levelOptions[levelOptions.length - 1].value : 'medium')
  const modelMaxTokens = typeof modelCaps?.max_output_tokens === 'number'
    ? modelCaps.max_output_tokens
    : 128000
  return { effectiveEfforts, supportsThinking, levelOptions, defaultEffort, modelMaxTokens }
}
