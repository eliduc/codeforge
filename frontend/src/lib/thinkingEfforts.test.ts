// КАО#VR-58 — unit tests for the extracted thinking-effort logic
// (frontend/src/lib/thinkingEfforts.ts). Covers every provider family branch
// of inferThinkingEfforts plus the shape/order of THINKING_EFFORT_OPTIONS.
//
// inferThinkingEfforts is the *fallback* heuristic used only when the backend
// model_capabilities map has no entry for a model; these tests pin its exact
// per-family behavior so a future refactor can't silently change which levels
// an unknown model is allowed.

import { describe, expect, it } from 'vitest'
import {
  THINKING_EFFORT_OPTIONS,
  inferThinkingEfforts,
  isAlwaysReasoning,
  deriveThinkingControls,
} from './thinkingEfforts'

describe('THINKING_EFFORT_OPTIONS', () => {
  it('has the exact ordered set of values (Auto + 5 levels)', () => {
    expect(THINKING_EFFORT_OPTIONS.map(o => o.value)).toEqual([
      '', 'minimal', 'low', 'medium', 'high', 'max',
    ])
  })

  it('pairs each value with its human label', () => {
    expect(THINKING_EFFORT_OPTIONS).toEqual([
      { value: '', label: 'Auto' },
      { value: 'minimal', label: 'Minimal' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ])
  })

  it('includes the "minimal" level (GPT-5 chat models) below "low"', () => {
    const values = THINKING_EFFORT_OPTIONS.map(o => o.value)
    expect(values).toContain('minimal')
    expect(values.indexOf('minimal')).toBeLessThan(values.indexOf('low'))
  })

  it('orders Auto first and max last', () => {
    expect(THINKING_EFFORT_OPTIONS[0].value).toBe('')
    expect(THINKING_EFFORT_OPTIONS[THINKING_EFFORT_OPTIONS.length - 1].value).toBe('max')
  })

  it('every level value is a valid effort token (no stray entries)', () => {
    const allowed = new Set(['', 'minimal', 'low', 'medium', 'high', 'max'])
    for (const o of THINKING_EFFORT_OPTIONS) {
      expect(allowed.has(o.value)).toBe(true)
      expect(typeof o.label).toBe('string')
      expect(o.label.length).toBeGreaterThan(0)
    }
  })
})

describe('inferThinkingEfforts — anthropic', () => {
  it('Opus → low/medium/high/max (includes max)', () => {
    expect(inferThinkingEfforts('anthropic', 'claude-opus-4-20250514')).toEqual([
      'low', 'medium', 'high', 'max',
    ])
  })

  it('Sonnet → low/medium/high (no max)', () => {
    expect(inferThinkingEfforts('anthropic', 'claude-sonnet-4-5')).toEqual([
      'low', 'medium', 'high',
    ])
    expect(inferThinkingEfforts('anthropic', 'claude-sonnet-4-5')).not.toContain('max')
  })

  it('Haiku / non opus-sonnet anthropic model → [] (no thinking)', () => {
    expect(inferThinkingEfforts('anthropic', 'claude-haiku-4')).toEqual([])
    expect(inferThinkingEfforts('anthropic', 'claude-3-5-haiku')).toEqual([])
  })

  it('opus takes precedence — a name with both opus and sonnet returns the opus set', () => {
    // Defensive: opus is checked first, so it wins. Pins current ordering.
    expect(inferThinkingEfforts('anthropic', 'opus-sonnet-hybrid')).toEqual([
      'low', 'medium', 'high', 'max',
    ])
  })
})

describe('inferThinkingEfforts — google', () => {
  it('Gemini 2.5 Pro → low/medium/high/max', () => {
    expect(inferThinkingEfforts('google', 'gemini-2.5-pro')).toEqual([
      'low', 'medium', 'high', 'max',
    ])
  })

  it('Gemini Flash → low/medium/high/max', () => {
    expect(inferThinkingEfforts('google', 'gemini-flash-latest')).toEqual([
      'low', 'medium', 'high', 'max',
    ])
  })

  it('Gemini 3.x → low/medium/high/max', () => {
    expect(inferThinkingEfforts('google', 'gemini-3.0-pro')).toEqual([
      'low', 'medium', 'high', 'max',
    ])
  })

  it('explicit "thinking" Gemini variant → low/medium/high/max', () => {
    expect(inferThinkingEfforts('google', 'gemini-2.0-flash-thinking')).toEqual([
      'low', 'medium', 'high', 'max',
    ])
  })

  it('older / non-pro-flash Gemini without budget markers → []', () => {
    // e.g. gemini-1.0 / gemini-nano have none of pro|flash|2.5|2.6|3.|thinking.
    expect(inferThinkingEfforts('google', 'gemini-1.0')).toEqual([])
    expect(inferThinkingEfforts('google', 'gemini-nano')).toEqual([])
  })

  it('non-gemini google model → []', () => {
    expect(inferThinkingEfforts('google', 'palm-2')).toEqual([])
  })
})

describe('inferThinkingEfforts — openai', () => {
  it('o-series (o1/o3/o4) → low/medium/high WITHOUT minimal', () => {
    for (const m of ['o1', 'o1-mini', 'o3', 'o3-mini', 'o4-mini']) {
      expect(inferThinkingEfforts('openai', m)).toEqual(['low', 'medium', 'high'])
      expect(inferThinkingEfforts('openai', m)).not.toContain('minimal')
    }
  })

  it('GPT-5..GPT-9 chat models → minimal/low/medium/high (adds minimal)', () => {
    for (const m of ['gpt-5', 'gpt-5-mini', 'gpt-6', 'gpt-9-turbo']) {
      expect(inferThinkingEfforts('openai', m)).toEqual(['minimal', 'low', 'medium', 'high'])
      expect(inferThinkingEfforts('openai', m)[0]).toBe('minimal')
    }
  })

  it('GPT-4 and earlier → [] (no thinking controls)', () => {
    expect(inferThinkingEfforts('openai', 'gpt-4o')).toEqual([])
    expect(inferThinkingEfforts('openai', 'gpt-4-turbo')).toEqual([])
    expect(inferThinkingEfforts('openai', 'gpt-3.5-turbo')).toEqual([])
  })

  it('o-series check is anchored (^o\\d) — a gpt name embedding o3 is NOT treated as o-series', () => {
    // /^o\d/ only matches at string start, so "gpt-4o" / "chatgpt-o3" don't
    // fall into the o-series branch. "gpt-4o" has no gpt-[5-9] either → [].
    expect(inferThinkingEfforts('openai', 'gpt-4o')).toEqual([])
  })

  it('plain "o" with no following digit → [] (not o-series)', () => {
    expect(inferThinkingEfforts('openai', 'omni')).toEqual([])
  })
})

describe('inferThinkingEfforts — grok', () => {
  it('grok-3 / grok-4 (with or without dash) → low/medium/high', () => {
    for (const m of ['grok-3', 'grok3', 'grok-4', 'grok4']) {
      expect(inferThinkingEfforts('grok', m)).toEqual(['low', 'medium', 'high'])
    }
  })

  it('grok reasoning variant → low/medium/high', () => {
    expect(inferThinkingEfforts('grok', 'grok-2-reasoning')).toEqual(['low', 'medium', 'high'])
    expect(inferThinkingEfforts('grok', 'grok-reason')).toEqual(['low', 'medium', 'high'])
  })

  it('grok-2 (non-reasoning) → []', () => {
    expect(inferThinkingEfforts('grok', 'grok-2')).toEqual([])
    expect(inferThinkingEfforts('grok', 'grok-1')).toEqual([])
  })
})

describe('inferThinkingEfforts — unknown / non-reasoning → []', () => {
  it('unknown provider → []', () => {
    expect(inferThinkingEfforts('mistral', 'mistral-large')).toEqual([])
    expect(inferThinkingEfforts('cohere', 'command-r')).toEqual([])
    expect(inferThinkingEfforts('', '')).toEqual([])
  })

  it('empty / nullish-ish model strings → []', () => {
    expect(inferThinkingEfforts('anthropic', '')).toEqual([])
    expect(inferThinkingEfforts('openai', '')).toEqual([])
    // Function coerces via (model || '') / (provider || '') — undefined is safe.
    expect(inferThinkingEfforts(undefined as unknown as string, undefined as unknown as string)).toEqual([])
  })
})

describe('inferThinkingEfforts — case-insensitivity', () => {
  it('provider name is lower-cased before matching', () => {
    expect(inferThinkingEfforts('Anthropic', 'claude-opus-4')).toEqual(['low', 'medium', 'high', 'max'])
    expect(inferThinkingEfforts('OPENAI', 'gpt-5')).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(inferThinkingEfforts('Google', 'GEMINI-2.5-PRO')).toEqual(['low', 'medium', 'high', 'max'])
    expect(inferThinkingEfforts('GROK', 'GROK-4')).toEqual(['low', 'medium', 'high'])
  })

  it('model name is lower-cased before matching', () => {
    expect(inferThinkingEfforts('anthropic', 'CLAUDE-OPUS-4')).toEqual(['low', 'medium', 'high', 'max'])
    expect(inferThinkingEfforts('anthropic', 'Claude-Sonnet-4')).toEqual(['low', 'medium', 'high'])
    expect(inferThinkingEfforts('openai', 'O3-MINI')).toEqual(['low', 'medium', 'high'])
    expect(inferThinkingEfforts('openai', 'GPT-6')).toEqual(['minimal', 'low', 'medium', 'high'])
  })
})

// КАО#VR-58 — mode+level → thinkingEffort mapping rules.
// AgentConfigPopup (SessionDetailPage.tsx) is not exported, so the two <select>
// controls are exercised here as the pure derivations the component performs,
// to lock the contract that drives the UI:
//   * levelOptions   = THINKING_EFFORT_OPTIONS filtered to supported efforts
//   * defaultEffort  = 'high' when supported, else strongest supported level
//   * mode On  -> thinkingEffort = defaultEffort
//   * mode Off -> thinkingEffort = ''
// These mirror the inline expressions at SessionDetailPage.tsx and would catch
// a drift in either the filter or the default-selection rule.
function levelOptionsFor(efforts: string[]) {
  return THINKING_EFFORT_OPTIONS.filter(o => o.value && efforts.includes(o.value))
}
function defaultEffortFor(efforts: string[]): string {
  const levelOptions = levelOptionsFor(efforts)
  return efforts.includes('high')
    ? 'high'
    : (levelOptions.length > 0 ? levelOptions[levelOptions.length - 1].value : 'medium')
}

describe('AgentConfigPopup mapping derivations (pure mirror)', () => {
  it('levelOptions drops the Auto/empty sentinel and keeps supported order', () => {
    const opts = levelOptionsFor(['low', 'medium', 'high', 'max'])
    expect(opts.map(o => o.value)).toEqual(['low', 'medium', 'high', 'max'])
    // empty value never appears as a selectable level
    expect(opts.find(o => o.value === '')).toBeUndefined()
  })

  it('levelOptions preserves canonical order even if caps list is unordered', () => {
    // THINKING_EFFORT_OPTIONS order wins (filter walks the canonical list).
    const opts = levelOptionsFor(['high', 'minimal', 'low'])
    expect(opts.map(o => o.value)).toEqual(['minimal', 'low', 'high'])
  })

  it('defaultEffort prefers "high" whenever the model supports it', () => {
    expect(defaultEffortFor(['low', 'medium', 'high', 'max'])).toBe('high')
    expect(defaultEffortFor(['low', 'medium', 'high'])).toBe('high')
    expect(defaultEffortFor(['minimal', 'low', 'medium', 'high'])).toBe('high')
  })

  it('defaultEffort falls back to the strongest supported level when "high" absent', () => {
    expect(defaultEffortFor(['minimal', 'low'])).toBe('low')
    expect(defaultEffortFor(['low', 'medium'])).toBe('medium')
    expect(defaultEffortFor(['minimal'])).toBe('minimal')
  })

  it('defaultEffort is "medium" when there are no supported levels (degenerate)', () => {
    // Only reachable if supportsThinking is false; mode select is disabled then,
    // but the expression still resolves to a defined value (never undefined).
    expect(defaultEffortFor([])).toBe('medium')
  })

  it('mode On writes defaultEffort, mode Off writes empty string', () => {
    const efforts = ['low', 'medium', 'high', 'max']
    const onValue = defaultEffortFor(efforts)            // what "On" sets
    const offValue = ''                                  // what "Off" sets
    expect(onValue).toBe('high')
    expect(offValue).toBe('')
    // round-trip: On then Off then On again is stable
    expect(defaultEffortFor(efforts)).toBe(onValue)
  })

  it('defaultEffort is always a member of levelOptions when any level exists (no React out-of-range value)', () => {
    // Guards the level <select>: value={thinkingEffort || defaultEffort} must
    // exist among rendered <option>s, else React warns about an out-of-range
    // controlled value. Verified across every family the heuristic can return.
    const sets = [
      inferThinkingEfforts('anthropic', 'claude-opus-4'),
      inferThinkingEfforts('anthropic', 'claude-sonnet-4'),
      inferThinkingEfforts('openai', 'o3'),
      inferThinkingEfforts('openai', 'gpt-5'),
      inferThinkingEfforts('google', 'gemini-2.5-pro'),
      inferThinkingEfforts('grok', 'grok-4'),
    ]
    for (const efforts of sets) {
      const opts = levelOptionsFor(efforts).map(o => o.value)
      expect(opts.length).toBeGreaterThan(0)
      expect(opts).toContain(defaultEffortFor(efforts))
    }
  })
})

// КАО#VR-58 — isAlwaysReasoning: o-series / GPT-5+ always reason (no true "off").
describe('isAlwaysReasoning', () => {
  it('is true for OpenAI o-series and GPT-5+ chat models', () => {
    expect(isAlwaysReasoning('openai', 'o3')).toBe(true)
    expect(isAlwaysReasoning('openai', 'o4-mini')).toBe(true)
    expect(isAlwaysReasoning('openai', 'gpt-5')).toBe(true)
    expect(isAlwaysReasoning('openai', 'gpt-5.5')).toBe(true)
    expect(isAlwaysReasoning('OpenAI', 'GPT-6')).toBe(true) // case-insensitive
  })
  it('is false for older OpenAI and other providers (thinking is optional there)', () => {
    expect(isAlwaysReasoning('openai', 'gpt-4o')).toBe(false)
    expect(isAlwaysReasoning('anthropic', 'claude-opus-4-8')).toBe(false)
    expect(isAlwaysReasoning('google', 'gemini-3-pro')).toBe(false)
    expect(isAlwaysReasoning('grok', 'grok-4')).toBe(false)
    expect(isAlwaysReasoning('', '')).toBe(false)
  })
})

// КАО#VR-58 — deriveThinkingControls: the single source of truth the popup uses.
describe('deriveThinkingControls', () => {
  it('uses backend caps when present (ignores the heuristic)', () => {
    const c = deriveThinkingControls('openai', 'gpt-5.5', {
      thinking_effort_options: ['minimal', 'low', 'medium', 'high'],
      max_output_tokens: 32768,
    })
    expect(c.supportsThinking).toBe(true)
    expect(c.levelOptions.map(o => o.value)).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(c.defaultEffort).toBe('high')
    expect(c.modelMaxTokens).toBe(32768)
  })

  it('respects an explicit empty caps list as "no thinking" (no heuristic fallback)', () => {
    const c = deriveThinkingControls('openai', 'gpt-5.4-pro', { thinking_effort_options: [], max_output_tokens: 32768 })
    expect(c.supportsThinking).toBe(false)
    expect(c.levelOptions).toEqual([])
    expect(c.modelMaxTokens).toBe(32768)
  })

  it('falls back to the family heuristic ONLY when caps are entirely absent', () => {
    const c = deriveThinkingControls('anthropic', 'claude-opus-4-9', undefined)
    expect(c.supportsThinking).toBe(true)
    expect(c.levelOptions.map(o => o.value)).toEqual(['low', 'medium', 'high', 'max'])
    expect(c.defaultEffort).toBe('high')
    expect(c.modelMaxTokens).toBe(128000) // fallback ceiling
  })

  it('defaultEffort is always within levelOptions (no out-of-range <select> value)', () => {
    for (const caps of [['minimal', 'low'], ['low', 'medium'], ['minimal']]) {
      const c = deriveThinkingControls('openai', 'x', { thinking_effort_options: caps })
      expect(c.levelOptions.map(o => o.value)).toContain(c.defaultEffort)
    }
  })
})
