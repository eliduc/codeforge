// VR-48/VR-49 — demo registry integrity.
//
// Guards the static demo-template registry served from public/demo-templates:
//   * every index.json entry has a matching <id>.json that parses and conforms
//     to the DemoTimeline contract the player (useTimelinePlayer) expects;
//   * the removed "Neon Snake" (snake) demo is gone (VR-48);
//   * the new "Conway's Game of Life" (life) demo is present and well-formed
//     (VR-49): 3 coders, 2 testers, narration chapters, embedded final code.

import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES = resolve(__dirname, '..', '..', 'public', 'demo-templates')
const readJson = (rel: string) => JSON.parse(readFileSync(resolve(TEMPLATES, rel), 'utf8'))

const ALLOWED_EVENT_TYPES = new Set([
  'workflow_started', 'iteration_started', 'phase_started', 'agent_started',
  'agent_streaming', 'agent_completed', 'iteration_completed', 'workflow_completed',
  'camera_focus', 'pause_for_interaction',
])

const index = readJson('index.json') as Array<{ id: string; name: string; language: string; duration_seconds: number }>

describe('VR-48 — Neon Snake demo removed', () => {
  it('snake is not in the registry', () => {
    expect(index.find(e => e.id === 'snake')).toBeUndefined()
  })
  it('snake.json template file is gone', () => {
    expect(existsSync(resolve(TEMPLATES, 'snake.json'))).toBe(false)
  })
})

describe('VR-49 — Conway\'s Game of Life demo present', () => {
  it('life is registered', () => {
    const entry = index.find(e => e.id === 'life')
    expect(entry).toBeTruthy()
    expect(entry!.language).toBe('javascript_browser')
  })
  it('life.json is a well-formed full-fidelity timeline', () => {
    const tl = readJson('life.json')
    expect(tl.id).toBe('life')
    expect(tl.coders).toHaveLength(3)
    expect(tl.testers).toHaveLength(2)
    expect(tl.summarizer?.model).toBeTruthy()
    expect(tl.finalizer?.model).toBeTruthy()
    expect((tl.narration_chapters ?? []).length).toBeGreaterThanOrEqual(8)
    expect(tl.final_code).toContain('<!DOCTYPE')
    expect(tl.simplified_code).toContain('<!DOCTYPE')
    // run-first-cut and run-final CTAs are wired
    const actions = (tl.narration_chapters ?? []).flatMap((c: any) => c.secondary_cta ? [c.secondary_cta.action] : [])
    expect(actions).toContain('run_simplified')
    expect(actions).toContain('run_final')
  })
})

describe('demo registry — every entry is a valid DemoTimeline', () => {
  it.each(index.map(e => e.id))('template "%s".json conforms to the contract', (id) => {
    const tl = readJson(`${id}.json`)
    for (const key of ['id', 'name', 'description', 'language', 'spec', 'duration_seconds', 'coders', 'testers', 'events', 'final_code']) {
      expect(tl[key], `missing ${key}`).toBeDefined()
    }
    expect(tl.id).toBe(id)
    expect(Array.isArray(tl.events) && tl.events.length).toBeTruthy()
    // event types are all known, and t is monotonic non-decreasing
    let prevT = -1
    for (const e of tl.events) {
      expect(ALLOWED_EVENT_TYPES.has(e.type), `bad event type ${e.type} in ${id}`).toBe(true)
      expect(e.t).toBeGreaterThanOrEqual(prevT)
      prevT = e.t
    }
    // narration chapters (if any) sorted and within duration
    const chapters = tl.narration_chapters ?? []
    let prevC = -1
    for (const c of chapters) {
      expect(c.t_start).toBeGreaterThanOrEqual(prevC)
      expect(c.t_start).toBeLessThanOrEqual(tl.duration_seconds)
      expect(Array.isArray(c.paragraphs) && c.paragraphs.length).toBeTruthy()
      prevC = c.t_start
    }
    expect(typeof tl.final_code).toBe('string')
    expect(tl.final_code.length).toBeGreaterThan(100)
  })
})
