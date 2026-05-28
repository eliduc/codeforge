/**
 * R13 — Onboarding tour & tours.ts regression tests.
 *
 * Stand-alone Node test (node:test). The frontend has no jest/vitest configured,
 * so we run with Node 22's --experimental-strip-types directly on the TS source.
 *
 * Run:
 *   cd frontend/tests
 *   node --experimental-strip-types --test test_round13_onboarding.mjs
 */
import { test, describe, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Polyfill localStorage *before* importing useOnboarding.ts (which only reads it
// inside fn bodies, but better safe than sorry).
globalThis.localStorage = (() => {
  const store = new Map()
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
    _dump: () => Object.fromEntries(store),
  }
})()

const useOnboarding = await import('../src/components/onboarding/useOnboarding.ts')
const tours = await import('../src/components/onboarding/tours.ts')

describe('R13 useOnboarding — persistence', () => {
  beforeEach(() => { localStorage.clear() })

  test('markSeen("welcome") flips isTourSeen("welcome") to true', () => {
    assert.equal(useOnboarding.isTourSeen('welcome'), false)
    useOnboarding.markSeen('welcome')
    assert.equal(useOnboarding.isTourSeen('welcome'), true)
  })

  test('markSeen on one tour does NOT mark other tours seen', () => {
    useOnboarding.markSeen('welcome')
    assert.equal(useOnboarding.isTourSeen('welcome'), true)
    assert.equal(useOnboarding.isTourSeen('session_anatomy'), false)
    assert.equal(useOnboarding.isTourSeen('session_live'), false)
    assert.equal(useOnboarding.isTourSeen('session_done'), false)
  })

  test('TOUR_KEYS includes all 4 tour ids with v2 prefix', () => {
    assert.deepEqual(Object.keys(useOnboarding.TOUR_KEYS).sort(), [
      'session_anatomy', 'session_done', 'session_live', 'welcome',
    ])
    for (const [id, key] of Object.entries(useOnboarding.TOUR_KEYS)) {
      assert.match(key, /^cf_tour_v2_/, `key for ${id} should start with cf_tour_v2_, got ${key}`)
      assert.ok(key.endsWith(id), `key for ${id} should end with ${id}, got ${key}`)
    }
  })

  test('resetAll() clears BOTH v1 (legacy) and v2 keys', () => {
    // Seed v2 + v1 keys manually
    useOnboarding.markSeen('welcome')
    useOnboarding.markSeen('session_anatomy')
    localStorage.setItem('cf_tour_v1_welcome', 'true')
    localStorage.setItem('cf_tour_v1_session_anatomy', 'true')
    localStorage.setItem('cf_tour_v1_session_live', 'true')
    localStorage.setItem('cf_tour_v1_session_done', 'true')
    // Plus an unrelated key — must NOT be cleared.
    localStorage.setItem('unrelated_key', 'preserved')

    useOnboarding.resetAll()

    // All v2 keys gone
    for (const key of Object.values(useOnboarding.TOUR_KEYS)) {
      assert.equal(localStorage.getItem(key), null, `v2 key ${key} should be cleared`)
    }
    // All v1 keys gone
    for (const k of ['welcome','session_anatomy','session_live','session_done']) {
      assert.equal(localStorage.getItem(`cf_tour_v1_${k}`), null, `v1 key cf_tour_v1_${k} should be cleared`)
    }
    // Unrelated key preserved
    assert.equal(localStorage.getItem('unrelated_key'), 'preserved')
  })

  test('anyTourSeen() returns false on fresh state, true after marking any', () => {
    assert.equal(useOnboarding.anyTourSeen(), false)
    useOnboarding.markSeen('session_done')
    assert.equal(useOnboarding.anyTourSeen(), true)
  })

  test('isTourSeen survives JSON-like values (strict "true" string)', () => {
    // Manually set to something other than 'true' — must NOT count as seen.
    localStorage.setItem(useOnboarding.TOUR_KEYS.welcome, '1')
    assert.equal(useOnboarding.isTourSeen('welcome'), false)
    localStorage.setItem(useOnboarding.TOUR_KEYS.welcome, 'yes')
    assert.equal(useOnboarding.isTourSeen('welcome'), false)
    localStorage.setItem(useOnboarding.TOUR_KEYS.welcome, 'true')
    assert.equal(useOnboarding.isTourSeen('welcome'), true)
  })

  test('markSeen swallows localStorage exceptions silently', () => {
    const original = globalThis.localStorage
    globalThis.localStorage = {
      getItem: () => { throw new Error('quota') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => { throw new Error('quota') },
    }
    // Must NOT throw.
    assert.doesNotThrow(() => useOnboarding.markSeen('welcome'))
    assert.doesNotThrow(() => useOnboarding.resetAll())
    // isTourSeen swallows and returns false.
    assert.equal(useOnboarding.isTourSeen('welcome'), false)
    globalThis.localStorage = original
  })
})

describe('R13 tours.ts — step definitions', () => {
  test('all 4 tour arrays exist and are non-empty', () => {
    assert.ok(Array.isArray(tours.welcomeTour), 'welcomeTour must be array')
    assert.ok(tours.welcomeTour.length > 0)
    assert.ok(Array.isArray(tours.sessionAnatomyTour))
    assert.ok(tours.sessionAnatomyTour.length > 0)
    assert.ok(Array.isArray(tours.sessionLiveTour))
    assert.ok(tours.sessionLiveTour.length > 0)
    assert.ok(Array.isArray(tours.sessionDoneTour))
    assert.ok(tours.sessionDoneTour.length > 0)
  })

  test('every step has either an element selector OR a popover (no invalid step)', () => {
    const checkTour = (tourName, tour) => {
      for (let i = 0; i < tour.length; i++) {
        const step = tour[i]
        const hasElement = typeof step.element === 'string' && step.element.length > 0
        const hasPopover = step.popover != null && typeof step.popover === 'object'
        assert.ok(
          hasElement || hasPopover,
          `${tourName}[${i}] must have either .element or .popover`
        )
        if (hasPopover) {
          assert.ok(step.popover.title, `${tourName}[${i}] popover must have title`)
          assert.ok(step.popover.description, `${tourName}[${i}] popover must have description`)
        }
      }
    }
    checkTour('welcomeTour', tours.welcomeTour)
    checkTour('sessionAnatomyTour', tours.sessionAnatomyTour)
    checkTour('sessionLiveTour', tours.sessionLiveTour)
    checkTour('sessionDoneTour', tours.sessionDoneTour)
  })

  test('welcomeTour ends with a modal-only step (no element) — the "off to demo" outro', () => {
    const last = tours.welcomeTour[tours.welcomeTour.length - 1]
    assert.equal(last.element, undefined, 'last welcome step should be popover-only modal')
    assert.ok(last.popover.title)
  })

  test('welcomeTour contains a [data-tour="demos-nav"] step (key R13 addition)', () => {
    const demoStep = tours.welcomeTour.find(s => s.element === '[data-tour="demos-nav"]')
    assert.ok(demoStep, 'welcomeTour must include a demos-nav targeting step')
    assert.match(demoStep.popover.description, /[Dd]emo/)
  })

  test('welcomeTour second-to-last step (before outro modal) targets demos-nav', () => {
    // The flow: ...templates → demos-nav → modal outro
    const len = tours.welcomeTour.length
    const beforeOutro = tours.welcomeTour[len - 2]
    assert.equal(beforeOutro.element, '[data-tour="demos-nav"]',
      `welcome step ${len - 2} should target demos-nav (the last targeted step before outro)`)
  })

  test('no duplicated element selectors back-to-back in any tour (placement bug guard)', () => {
    // Note: sessionDoneTour intentionally re-uses [data-tour="enhance-btn"] 3x
    // for staged narration — accept that, but each consecutive duplicate must
    // have a DIFFERENT popover title (otherwise it'd be a copy/paste bug).
    const checkTour = (name, tour) => {
      for (let i = 1; i < tour.length; i++) {
        const a = tour[i - 1]
        const b = tour[i]
        if (a.element && b.element && a.element === b.element) {
          assert.notEqual(a.popover.title, b.popover.title,
            `${name}: consecutive steps ${i-1}/${i} share selector ${a.element} AND title — likely a duplicate`)
        }
      }
    }
    checkTour('welcomeTour', tours.welcomeTour)
    checkTour('sessionAnatomyTour', tours.sessionAnatomyTour)
    checkTour('sessionLiveTour', tours.sessionLiveTour)
    checkTour('sessionDoneTour', tours.sessionDoneTour)
  })
})
