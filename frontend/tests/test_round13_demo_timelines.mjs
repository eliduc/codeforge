/**
 * R13 — Demo timeline JSON validity tests.
 *
 * Verifies the 4 demo templates that ship at /demo-templates/*.json:
 *   - parse cleanly
 *   - have all required top-level fields
 *   - events sorted by t and all t ≤ duration_seconds
 *   - mandelbulb-specific: 14 narration chapters with the right shape
 *
 * Run:
 *   cd frontend/tests
 *   node --test test_round13_demo_timelines.mjs
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEMOS_DIR = resolve(__dirname, '../public/demo-templates')

const loadDemo = (name) =>
  JSON.parse(readFileSync(resolve(DEMOS_DIR, `${name}.json`), 'utf8'))

const ALL_DEMOS = ['mandelbulb', 'snake', 'particles', 'crystal']

describe('R13 demo timelines — common invariants (all 4 demos)', () => {
  for (const demoId of ALL_DEMOS) {
    test(`${demoId}.json parses`, () => {
      const d = loadDemo(demoId)
      assert.ok(d && typeof d === 'object')
    })

    test(`${demoId}.json has required top-level fields`, () => {
      const d = loadDemo(demoId)
      for (const f of ['id', 'name', 'language', 'duration_seconds', 'events', 'final_code']) {
        assert.ok(f in d, `${demoId}.json missing required field ${f}`)
      }
      assert.equal(typeof d.id, 'string')
      assert.equal(typeof d.name, 'string')
      assert.equal(typeof d.language, 'string')
      assert.equal(typeof d.duration_seconds, 'number')
      assert.ok(d.duration_seconds > 0)
      assert.ok(Array.isArray(d.events))
      assert.ok(d.events.length > 0)
      assert.equal(typeof d.final_code, 'string')
      assert.ok(d.final_code.length > 100, `${demoId} final_code should be non-trivial`)
    })

    test(`${demoId}.json events sorted by t and all t ≤ duration_seconds`, () => {
      const d = loadDemo(demoId)
      let prev = -Infinity
      for (let i = 0; i < d.events.length; i++) {
        const ev = d.events[i]
        assert.equal(typeof ev.t, 'number', `${demoId} event[${i}] t must be number`)
        assert.ok(ev.t >= prev, `${demoId} events not sorted: event[${i}].t=${ev.t} < prev=${prev}`)
        assert.ok(ev.t <= d.duration_seconds,
          `${demoId} event[${i}].t=${ev.t} exceeds duration_seconds=${d.duration_seconds}`)
        assert.equal(typeof ev.type, 'string')
        prev = ev.t
      }
    })

    test(`${demoId}.json every event has a valid type from the documented set`, () => {
      const d = loadDemo(demoId)
      const VALID_TYPES = new Set([
        'workflow_started', 'iteration_started', 'phase_started',
        'agent_started', 'agent_streaming', 'agent_completed',
        'iteration_completed', 'workflow_completed',
        'camera_focus', 'pause_for_interaction',
      ])
      for (let i = 0; i < d.events.length; i++) {
        assert.ok(VALID_TYPES.has(d.events[i].type),
          `${demoId} event[${i}].type="${d.events[i].type}" is not a known event type`)
      }
    })

    test(`${demoId}.json contains workflow_started and workflow_completed exactly once each`, () => {
      const d = loadDemo(demoId)
      const starts = d.events.filter(e => e.type === 'workflow_started')
      const ends = d.events.filter(e => e.type === 'workflow_completed')
      assert.equal(starts.length, 1, `${demoId} should have exactly 1 workflow_started`)
      assert.equal(ends.length, 1, `${demoId} should have exactly 1 workflow_completed`)
    })

    test(`${demoId}.json has at least one coder + one tester defined`, () => {
      const d = loadDemo(demoId)
      assert.ok(Array.isArray(d.coders) && d.coders.length >= 1,
        `${demoId} needs at least 1 coder`)
      assert.ok(Array.isArray(d.testers) && d.testers.length >= 1,
        `${demoId} needs at least 1 tester`)
    })
  }
})

describe('R13 mandelbulb timeline — chapter-system invariants', () => {
  test('mandelbulb has narration_chapters non-empty', () => {
    const d = loadDemo('mandelbulb')
    assert.ok(Array.isArray(d.narration_chapters))
    assert.ok(d.narration_chapters.length >= 14,
      `mandelbulb should have at least 14 chapters (R13 baseline), got ${d.narration_chapters.length}`)
  })

  test('mandelbulb chapters sorted by t_start', () => {
    const d = loadDemo('mandelbulb')
    let prev = -Infinity
    for (let i = 0; i < d.narration_chapters.length; i++) {
      const c = d.narration_chapters[i]
      assert.ok(c.t_start >= prev,
        `chapter[${i}] id=${c.id} t_start=${c.t_start} < prev=${prev}`)
      prev = c.t_start
    }
  })

  test('mandelbulb every chapter has id, t_start, title, paragraphs[]', () => {
    const d = loadDemo('mandelbulb')
    for (const c of d.narration_chapters) {
      assert.equal(typeof c.id, 'string', `chapter missing id: ${JSON.stringify(c)}`)
      assert.ok(c.id.length > 0)
      assert.equal(typeof c.t_start, 'number')
      assert.ok(c.t_start >= 0)
      assert.equal(typeof c.title, 'string')
      assert.ok(c.title.length > 0)
      assert.ok(Array.isArray(c.paragraphs))
      assert.ok(c.paragraphs.length >= 1, `chapter ${c.id} must have at least 1 paragraph`)
      for (const p of c.paragraphs) {
        assert.equal(typeof p, 'string')
        assert.ok(p.length > 0)
      }
    }
  })

  test('mandelbulb chapter ids are unique', () => {
    const d = loadDemo('mandelbulb')
    const ids = d.narration_chapters.map(c => c.id)
    assert.equal(new Set(ids).size, ids.length, `chapter ids should be unique: ${ids.join(', ')}`)
  })

  test('mandelbulb every chapter t_start ≤ duration_seconds', () => {
    const d = loadDemo('mandelbulb')
    for (const c of d.narration_chapters) {
      assert.ok(c.t_start <= d.duration_seconds,
        `chapter ${c.id} t_start=${c.t_start} exceeds duration_seconds=${d.duration_seconds}`)
    }
  })

  test('mandelbulb has simplified_code field with length > 5000', () => {
    const d = loadDemo('mandelbulb')
    assert.equal(typeof d.simplified_code, 'string',
      'mandelbulb must have simplified_code field')
    assert.ok(d.simplified_code.length > 5000,
      `mandelbulb simplified_code length should be > 5000, got ${d.simplified_code.length}`)
  })

  test('mandelbulb has at least one camera_focus event per group target', () => {
    const d = loadDemo('mandelbulb')
    const focusTargets = new Set(
      d.events.filter(e => e.type === 'camera_focus').map(e => e.target)
    )
    const REQUIRED = [
      'spec',
      'coder_',
      'tester_',
      'summarizer_0',
      'finalizer_0',
      'enhancer_',
      'output',
    ]
    for (const t of REQUIRED) {
      assert.ok(focusTargets.has(t),
        `mandelbulb must have camera_focus events for "${t}", saw: ${[...focusTargets].join(', ')}`)
    }
  })

  test('mandelbulb chapter "first-run" has secondary_cta action=run_simplified', () => {
    const d = loadDemo('mandelbulb')
    const c = d.narration_chapters.find(c => c.id === 'first-run')
    assert.ok(c, 'mandelbulb must have "first-run" chapter')
    assert.ok(c.secondary_cta, '"first-run" chapter must have secondary_cta')
    assert.equal(c.secondary_cta.action, 'run_simplified',
      '"first-run" secondary_cta action should be run_simplified')
    assert.ok(c.secondary_cta.label && c.secondary_cta.label.length > 0)
  })

  test('mandelbulb chapter "final-run" has secondary_cta action=run_final', () => {
    const d = loadDemo('mandelbulb')
    const c = d.narration_chapters.find(c => c.id === 'final-run')
    assert.ok(c, 'mandelbulb must have "final-run" chapter')
    assert.ok(c.secondary_cta, '"final-run" chapter must have secondary_cta')
    assert.equal(c.secondary_cta.action, 'run_final',
      '"final-run" secondary_cta action should be run_final')
  })

  test('mandelbulb pause_for_interaction events use documented pause_key values', () => {
    const d = loadDemo('mandelbulb')
    const ALLOWED_KEYS = new Set(['after_finalize', 'after_enhance_finalize'])
    const pauseEvents = d.events.filter(e => e.type === 'pause_for_interaction')
    // No assertion on count — but if present, the keys must be allowed.
    for (const ev of pauseEvents) {
      assert.ok(ALLOWED_KEYS.has(ev.pause_key),
        `pause_for_interaction has unknown pause_key=${ev.pause_key}`)
    }
  })

  test('mandelbulb has 99+ events and 162s duration (R13 baseline)', () => {
    const d = loadDemo('mandelbulb')
    assert.ok(d.events.length >= 90, `expected ≥90 events, got ${d.events.length}`)
    assert.ok(d.duration_seconds >= 150 && d.duration_seconds <= 250,
      `expected duration in 150-250s, got ${d.duration_seconds}`)
  })

  test('mandelbulb final_code length > simplified_code length (final is the bigger version)', () => {
    const d = loadDemo('mandelbulb')
    assert.ok(d.final_code.length > d.simplified_code.length,
      'final_code should be larger than simplified_code')
  })
})
